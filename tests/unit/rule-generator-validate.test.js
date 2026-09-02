import { describe, expect, it } from 'vitest';
import {
    createDefaultState,
    createRegionConfigs,
    applyRecommendedBuckets,
    GROUP_NAMES,
    OTHER_REGION_ID
} from '../../src/utils/rule-generator/catalog.js';
import {
    validateState,
    countPolicyGroups,
    groupCountLevel
} from '../../src/utils/rule-generator/validate.js';

/** 找出针对某字段的某级别提示。 */
function pick(result, level, fieldPrefix) {
    return result.findings.filter(item =>
        item.level === level && item.field.startsWith(fieldPrefix));
}

function messages(result) {
    return result.findings.map(item => item.message).join('\n');
}

/**
 * 默认造一张**小卡片**（parentId 非 null）—— 它自带来源，
 * 是校验里最常用的形态。需要大卡片时显式传 `parentId: null`。
 */
function card(props) {
    return {
        id: 'c1', name: '我的卡片', parentId: 'p0', origin: 'user', order: 0, bucket: 'proxy',
        sources: [{ id: 's1', kind: 'remote', value: 'https://example.com/a.list' }],
        ...props
    };
}

/** 干净底座：无内置卡片、无局域网直连，便于隔离单点。 */
function bare(cards = []) {
    const state = createDefaultState();
    state.cards = cards;
    state.headModifiers = { localAreaNetwork: false };
    return state;
}

describe('rule-generator validate', () => {
    it('默认状态可以生成，无 error', () => {
        const result = validateState(createDefaultState());
        expect(result.canGenerate).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('分隔符注入逐字符拦截：卡片名（§6.1）', () => {
        [',', '`', '=', '\n', '\r'].forEach(char => {
            const result = validateState(bare([card({ name: `我的${char}卡片`, bucket: 'flexible' })]));
            expect(result.canGenerate).toBe(false);
            expect(pick(result, 'error', 'cards[0].name').length).toBeGreaterThan(0);
        });
    });

    it('分隔符注入逐字符拦截：内联规则值（§6.1）', () => {
        [',', '`', '=', '\n'].forEach(char => {
            const result = validateState(bare([card({
                sources: [{ id: 's1', kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: `a${char}b.com` }]
            })]));
            expect(result.canGenerate).toBe(false);
            expect(pick(result, 'error', 'cards[0].sources[0]').length).toBeGreaterThan(0);
        });
    });

    it('!! 前缀只给 warn —— MiSub 无 applyMatcher，仅影响跨转换器可移植性（§6.1）', () => {
        const result = validateState(bare([card({
            sources: [{ id: 's1', kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: '!!a.com' }]
        })]));
        expect(result.canGenerate).toBe(true);
        expect(pick(result, 'warn', 'cards[0].sources[0]').length).toBe(1);
    });

    it('地区 (?i) 前缀被拦截：剥壳后正则非法，该组会被静默删除（§3.1）', () => {
        const state = createDefaultState();
        state.base.regions[0].pattern = '(?i)港|HK';

        const result = validateState(state);
        expect(result.canGenerate).toBe(false);
        expect(messages(result)).toContain('(?i)');
    });

    it('地区 pattern 含括号被拦截：多层括号剥壳后不配对（§3.1）', () => {
        const state = createDefaultState();
        state.base.regions[0].pattern = '(港|HK)|(台|TW)';

        const result = validateState(state);
        expect(result.canGenerate).toBe(false);
        expect(messages(result)).toContain('不能包含括号');
    });

    it('地区 pattern 非法正则与空值被拦截', () => {
        const broken = createDefaultState();
        broken.base.regions[0].pattern = '港|HK[';
        expect(validateState(broken).canGenerate).toBe(false);
        expect(messages(validateState(broken))).toContain('不是合法正则');

        const empty = createDefaultState();
        empty.base.regions[0].pattern = '   ';
        expect(validateState(empty).canGenerate).toBe(false);
        expect(messages(validateState(empty))).toContain('为空');
    });

    it('未勾选的地区不参与 pattern 校验', () => {
        const state = createDefaultState();
        const disabled = state.base.regions.find(region => !region.enabled && region.id !== OTHER_REGION_ID);
        disabled.pattern = '(?i)(bad)';

        expect(validateState(state).canGenerate).toBe(true);
    });

    it('卡片名与保留字、内置组、地区组、其它灵活卡重名时被拦截（§6.2）', () => {
        const collisions = [
            GROUP_NAMES.direct, GROUP_NAMES.proxy, GROUP_NAMES.nodeSelect,
            GROUP_NAMES.adBlock, GROUP_NAMES.final,
            'DIRECT', 'REJECT', 'MATCH', '🇭🇰 香港节点'
        ];

        collisions.forEach(name => {
            const result = validateState(bare([card({ name, bucket: 'flexible' })]));
            expect(result.canGenerate, name).toBe(false);
            expect(messages(result)).toContain('重名');
        });

        // 两张灵活桶卡片互相撞名
        const twins = validateState(bare([
            card({ id: 'a', name: '同名', bucket: 'flexible' }),
            card({ id: 'b', name: '同名', bucket: 'flexible',
                sources: [{ id: 'bs', kind: 'remote', value: 'https://example.com/b.list' }] })
        ]));
        expect(twins.canGenerate).toBe(false);
        expect(messages(twins)).toContain('另一张灵活桶卡片');
    });

    it('只有进灵活桶的卡片受重名约束 —— 其它桶的卡片名只是标题', () => {
        ['proxy', 'direct', 'adblock', 'off'].forEach(bucket => {
            const result = validateState(bare([card({ name: GROUP_NAMES.proxy, bucket })]));
            expect(result.canGenerate, bucket).toBe(true);
        });
    });

    it('灵活桶卡片名为空时被拦截 —— 它就是策略组名', () => {
        const result = validateState(bare([card({ name: '   ', bucket: 'flexible' })]));
        expect(result.canGenerate).toBe(false);
        expect(messages(result)).toContain('必须有名称');
    });

    it('卡片上不再有出口目标，任何 target 残留都不影响校验', () => {
        // 出口由策略组决定。反解旧模板可能带进 target 字段，它应当被忽略而非报错
        ['🇰🇷 韩国节点', GROUP_NAMES.proxy, '不存在的组', ''].forEach(target => {
            const result = validateState(bare([
                card({ id: 'p1', name: '集合', parentId: null, bucket: 'flexible', sources: [], target }),
                card({ id: 'c1', parentId: 'p1', bucket: 'flexible' })
            ]));
            expect(result.canGenerate, String(target || '(空)')).toBe(true);
        });
    });

    it('大卡片内小卡片归零时给 warn，有小卡片则不报', () => {
        // 空集合
        const empty = validateState(bare([
            card({ id: 'p1', name: '空集合', parentId: null, bucket: 'flexible', sources: [] })
        ]));
        expect(empty.canGenerate).toBe(true);            // warn 不拦截
        expect(messages(empty)).toContain('没有任何规则卡片');

        // 小卡片被拖到别的桶 → 父卡片同样算空
        const moved = validateState(bare([
            card({ id: 'p1', name: '集合', parentId: null, bucket: 'flexible', sources: [] }),
            card({ id: 'c1', parentId: 'p1', bucket: 'proxy' })
        ]));
        expect(messages(moved)).toContain('没有任何规则卡片');

        // 有同桶小卡片 → 不报
        const filled = validateState(bare([
            card({ id: 'p1', name: '集合', parentId: null, bucket: 'flexible', sources: [] }),
            card({ id: 'c1', parentId: 'p1', bucket: 'flexible' })
        ]));
        expect(messages(filled)).not.toContain('没有任何规则卡片');
    });

    it('留在待选栏的空大卡片不报 warn', () => {
        const result = validateState(bare([
            card({ id: 'p1', name: '空集合', parentId: null, bucket: 'off', sources: [] })
        ]));
        expect(messages(result)).not.toContain('没有任何规则卡片');
    });

    it('跨桶来源遮蔽被拦截：按输出顺序只有先出现者生效（§6.2）', () => {
        const shared = 'https://example.com/shared.list';
        const result = validateState(bare([
            card({ id: 'a', name: 'A 卡', bucket: 'proxy', sources: [{ id: 'as', kind: 'remote', value: shared }] }),
            card({ id: 'b', name: 'B 卡', bucket: 'direct', sources: [{ id: 'bs', kind: 'remote', value: `${shared}/` }] })
        ]));

        expect(result.canGenerate).toBe(false);
        expect(messages(result)).toContain('只有前者生效');
        // 优先匹配区在前，因此它是生效方
        expect(messages(result)).toContain('A 卡');
    });

    it('一方留在待选栏时不拦截生成', () => {
        const shared = 'https://example.com/shared.list';
        const result = validateState(bare([
            card({ id: 'a', name: 'A 卡', bucket: 'proxy', sources: [{ id: 'as', kind: 'remote', value: shared }] }),
            card({ id: 'b', name: 'B 卡', bucket: 'off', sources: [{ id: 'bs', kind: 'remote', value: shared }] })
        ]));
        expect(result.canGenerate).toBe(true);
    });

    it('自填来源撞上内置目录只给 warn（§4.4）', () => {
        const result = validateState(bare([card({
            sources: [{
                id: 's1', kind: 'remote',
                value: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/Telegram.list'
            }]
        })]));

        expect(result.canGenerate).toBe(true);
        expect(pick(result, 'warn', 'cards[0].sources[0]')).toHaveLength(1);
        expect(messages(result)).toContain('内置目录');
    });

    it('来源本身的合法性：空值、非 http、未知内联类型', () => {
        const emptyValue = validateState(bare([card({
            sources: [{ id: 's1', kind: 'remote', value: '  ' }]
        })]));
        expect(emptyValue.canGenerate).toBe(false);
        expect(messages(emptyValue)).toContain('来源为空');

        const notHttp = validateState(bare([card({
            sources: [{ id: 's1', kind: 'remote', value: 'ftp://example.com/a.list' }]
        })]));
        expect(notHttp.canGenerate).toBe(false);
        expect(messages(notHttp)).toContain('http://');

        const badType = validateState(bare([card({
            sources: [{ id: 's1', kind: 'inline', ruleType: 'URL-REGEX', value: 'x' }]
        })]));
        expect(badType.canGenerate).toBe(false);
        expect(messages(badType)).toContain('不受支持');
    });

    it('九种内联规则类型全部受支持', () => {
        ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6',
            'GEOIP', 'GEOSITE', 'PROCESS-NAME', 'DST-PORT'].forEach(ruleType => {
            const result = validateState(bare([card({
                sources: [{ id: 's1', kind: 'inline', ruleType, value: 'x' }]
            })]));
            expect(result.canGenerate, ruleType).toBe(true);
        });
    });

    it('空来源卡片只给 warn 并说明不产出内容（§5.2）', () => {
        const result = validateState(bare([card({ sources: [] })]));
        expect(result.canGenerate).toBe(true);
        expect(pick(result, 'warn', 'cards[0])'.slice(0, 8))).toHaveLength(1);
        expect(messages(result)).toContain('没有任何来源');
    });

    it('留在待选栏的卡片完全不参与来源校验', () => {
        const result = validateState(bare([card({
            bucket: 'off',
            sources: [{ id: 's1', kind: 'remote', value: 'ftp://bad' }]
        })]));
        expect(result.canGenerate).toBe(true);
        expect(pick(result, 'error', 'cards')).toEqual([]);
        expect(pick(result, 'warn', 'cards[0]')).toEqual([]);
    });

    it('IP 段卡片落在全球直连以外时给 warn 而非拦截（§4.3 / §6.2）', () => {
        const geoip = ruleBucket => bare([card({
            name: '🇨🇳 国内 IP', origin: 'builtin', bucket: ruleBucket,
            ...(ruleBucket === 'head' ? { target: GROUP_NAMES.direct } : {}),
            sources: [{ id: 's1', kind: 'inline', ruleType: 'GEOIP', value: 'CN', noResolve: true }]
        })]);

        expect(messages(validateState(geoip('direct')))).not.toContain('遮蔽');

        ['proxy', 'flexible', 'head'].forEach(bucket => {
            const result = validateState(geoip(bucket));
            expect(result.canGenerate, bucket).toBe(true);          // warn 不拦截
            expect(messages(result)).toContain('遮蔽其后所有域名规则');
        });
    });

    it('域名与 IP 混合的卡片不触发位置提示', () => {
        const result = validateState(bare([card({
            bucket: 'proxy',
            sources: [
                { id: 's1', kind: 'inline', ruleType: 'GEOIP', value: 'CN' },
                { id: 's2', kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'a.com' }
            ]
        })]));
        expect(messages(result)).not.toContain('遮蔽');
    });

    it('策略组计数与序列化的实际输出一致，阈值分三档（§6.3）', () => {
        const minimal = bare([]);
        minimal.base = { autoSelect: false, manualSelect: false, fallback: false, regions: createRegionConfigs([]) };
        // 🚀 节点选择 + 🐟 漏网之鱼
        expect(countPolicyGroups(minimal)).toBe(2);

        // 默认状态卡片全在待选栏：基础组 3 + 地区 4 + 其他地区 + 漏网之鱼
        expect(countPolicyGroups(createDefaultState())).toBe(9);

        // 按推荐落点铺开后多出灵活桶 3 组与广告 / 代理 / 直连三个承接组
        const recommended = createDefaultState();
        recommended.cards = applyRecommendedBuckets(recommended.cards);
        expect(countPolicyGroups(recommended)).toBe(15);

        expect(groupCountLevel(12)).toBe('green');
        expect(groupCountLevel(13)).toBe('yellow');
        expect(groupCountLevel(20)).toBe('yellow');
        expect(groupCountLevel(21)).toBe('red');
    });

    it('策略组过多只给 warn，不拦截生成（§6.3，旧 R6 的教训）', () => {
        const state = createDefaultState();
        state.base.fallback = true;
        state.base.regions = createRegionConfigs(['hk', 'tw', 'jp', 'kr', 'sg', 'us', OTHER_REGION_ID]);
        for (let index = 0; index < 12; index += 1) {
            state.cards.push(card({
                id: `f${index}`, name: `灵活卡 ${index}`, bucket: 'flexible',
                sources: [{ id: `f${index}s`, kind: 'remote', value: `https://example.com/f${index}.list` }]
            }));
        }

        const result = validateState(state);
        expect(result.groupCount).toBeGreaterThan(20);
        expect(result.groupCountLevel).toBe('red');
        expect(result.canGenerate).toBe(true);
        expect(messages(result)).toContain('客户端列表会很长');
    });

    it('空桶不计入策略组数：广告 / 代理 / 直连由卡片归属派生', () => {
        const base = bare([]);
        const withAd = bare([card({ bucket: 'adblock' })]);
        expect(countPolicyGroups(withAd)).toBe(countPolicyGroups(base) + 1);

        // sources 为空的卡片不计入
        const emptyOnly = bare([card({ bucket: 'adblock', sources: [] })]);
        expect(countPolicyGroups(emptyOnly)).toBe(countPolicyGroups(base));
    });

    it('完全没有生效规则时给 warn', () => {
        const result = validateState(bare([]));
        expect(result.canGenerate).toBe(true);
        expect(messages(result)).toContain('只有兜底规则');
    });

    it('只开前置修正也算有内容', () => {
        const state = bare([]);
        state.headModifiers = { localAreaNetwork: true, unban: false };
        expect(messages(validateState(state))).not.toContain('只有兜底规则');
    });

    it('未勾选具名地区时其他地区给 warn 说明不会输出（§4.1 M9）', () => {
        const state = bare([]);
        state.base.regions = createRegionConfigs([OTHER_REGION_ID]);

        const result = validateState(state);
        expect(result.canGenerate).toBe(true);
        expect(messages(result)).toContain('不会输出');
    });

    it('返回值结构：findings / errors / warnings 三者一致', () => {
        const result = validateState(bare([card({ name: '坏,名字', bucket: 'flexible' })]));
        expect(result.findings).toHaveLength(result.errors.length + result.warnings.length);
        expect(result.canGenerate).toBe(result.errors.length === 0);
        result.findings.forEach(item => {
            expect(item).toHaveProperty('level');
            expect(item).toHaveProperty('field');
            expect(item).toHaveProperty('message');
            expect(['error', 'warn']).toContain(item.level);
        });
    });
});
