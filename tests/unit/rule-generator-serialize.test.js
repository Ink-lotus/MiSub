import { describe, expect, it } from 'vitest';
import {
    createDefaultState,
    createRegionConfigs,
    applyRecommendedBuckets,
    GROUP_NAMES,
    AD_BLOCK_MEMBERS,
    OTHER_REGION_ID,
    STATE_HEADER_PREFIX
} from '../../src/utils/rule-generator/catalog.js';
import { serializeState } from '../../src/utils/rule-generator/serialize.js';

function ruleLines(ini) {
    return ini.split('\n').filter(line => line.startsWith('ruleset='));
}

function groupLines(ini) {
    return ini.split('\n').filter(line => line.startsWith('custom_proxy_group='));
}

function groupName(line) {
    return line.replace(/^custom_proxy_group=/, '').split('`')[0];
}

function groupMembers(line) {
    return line.replace(/^custom_proxy_group=/, '').split('`')
        .filter(part => part.startsWith('[]'))
        .map(part => part.slice(2));
}

function rulePolicy(line) {
    return line.replace(/^ruleset=/, '').split(',')[0];
}

/** 只留下给定卡片，其它全关，便于隔离单点行为。 */
function stateWithCards(cards) {
    const state = createDefaultState();
    state.cards = cards;
    state.headModifiers = { localAreaNetwork: false };
    return state;
}

/** 默认状态里卡片全在待选栏，按推荐落点铺开后才有各段内容。 */
function recommendedState() {
    const state = createDefaultState();
    state.cards = applyRecommendedBuckets(state.cards);
    return state;
}

/** 大卡片：sources 恒空，靠小卡片供给。 */
function parent(props) {
    return {
        id: 'p1', name: '集合', parentId: null, origin: 'user',
        bucket: 'proxy', order: 0, sources: [], ...props
    };
}

/** 小卡片：规则来源在此。 */
function child(props) {
    return {
        id: 'c1', name: '规则', parentId: 'p1', origin: 'user',
        bucket: 'proxy', order: 0,
        sources: [{ id: 's1', kind: 'remote', value: 'https://example.com/a.list' }],
        ...props
    };
}

describe('rule-generator serialize', () => {
    it('默认状态：卡片全在待选栏，只输出局域网直连与兜底', () => {
        const { ini } = serializeState(createDefaultState());

        // 生成器不替用户决定分流：一张规则卡片都没放进右栏
        expect(ruleLines(ini)).toEqual([
            'ruleset=DIRECT,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/LocalAreaNetwork.list',
            `ruleset=${GROUP_NAMES.final},[]FINAL`
        ]);

        // 承接组由卡片归属派生，因此一个都不输出
        const names = groupLines(ini).map(groupName);
        [GROUP_NAMES.adBlock, GROUP_NAMES.proxy, GROUP_NAMES.direct].forEach(name =>
            expect(names).not.toContain(name));
        expect(names[0]).toBe(GROUP_NAMES.nodeSelect);
        expect(names.at(-1)).toBe(GROUP_NAMES.final);
    });

    it('按推荐落点铺开后：六段规则顺序与十段组顺序', () => {
        const { ini, groupCount, ruleCount } = serializeState(recommendedState());
        const lines = ini.trimEnd().split('\n');

        // 注释头在最后一行 —— 首行放 base64 会让高级模式的文本框一眼全是乱码
        expect(lines[0]).toBe('[custom]');
        expect(lines.at(-1).startsWith(STATE_HEADER_PREFIX)).toBe(true);
        expect(lines).toContain('overwrite_original_rules=true');
        expect(ruleCount).toBe(ruleLines(ini).length);
        expect(groupCount).toBe(groupLines(ini).length);

        // 规则顺序：前置修正 → 灵活桶 → 广告 → 国际代理 → 全球直连 → FINAL
        const policies = ruleLines(ini).map(rulePolicy);
        const first = policy => policies.indexOf(policy);
        expect(first('DIRECT')).toBe(0);
        expect(first('DIRECT')).toBeLessThan(first('🤖 AI 服务'));
        expect(first('🤖 AI 服务')).toBeLessThan(first(GROUP_NAMES.adBlock));
        expect(first(GROUP_NAMES.adBlock)).toBeLessThan(first(GROUP_NAMES.proxy));
        expect(first(GROUP_NAMES.proxy)).toBeLessThan(first(GROUP_NAMES.direct));
        expect(ruleLines(ini).at(-1)).toBe(`ruleset=${GROUP_NAMES.final},[]FINAL`);

        // 组顺序：基础组 → 地区组 → 灵活桶 → 承接组 → 兜底
        const names = groupLines(ini).map(groupName);
        expect(names[0]).toBe(GROUP_NAMES.nodeSelect);
        expect(names.at(-1)).toBe(GROUP_NAMES.final);
        expect(names.indexOf('🇭🇰 香港节点')).toBeLessThan(names.indexOf('🤖 AI 服务'));
        expect(names.indexOf(GROUP_NAMES.otherRegion)).toBeLessThan(names.indexOf('🤖 AI 服务'));
        expect(names.indexOf('🤖 AI 服务')).toBeLessThan(names.indexOf(GROUP_NAMES.adBlock));
    });

    it('大卡片在灵活桶只产出 1 个组，规则数 = 全部小卡片来源之和', () => {
        const { ini } = serializeState(stateWithCards([
            parent({ id: 'p1', name: '🤖 我的 AI', bucket: 'flexible' }),
            child({ id: 'c1', name: 'OpenAI', bucket: 'flexible', order: 0,
                sources: [{ id: 's1', kind: 'remote', value: 'https://example.com/a.list' }] }),
            child({ id: 'c2', name: 'Claude', bucket: 'flexible', order: 1,
                sources: [{ id: 's2', kind: 'remote', value: 'https://example.com/b.list' }] }),
            child({ id: 'c3', name: '其它', bucket: 'flexible', order: 2,
                sources: [{ id: 's3', kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'grok.com' }] })
        ]));

        expect(groupLines(ini).filter(line => groupName(line) === '🤖 我的 AI')).toHaveLength(1);
        expect(ruleLines(ini).filter(line => rulePolicy(line) === '🤖 我的 AI')).toHaveLength(3);
        // 小卡片不各自成组
        expect(groupLines(ini).map(groupName)).not.toContain('OpenAI');
        expect(ini).toContain('ruleset=🤖 我的 AI,[]DOMAIN-SUFFIX,grok.com');
    });

    it('小卡片被单独拖到灵活桶时自己成为一个组', () => {
        const { ini } = serializeState(stateWithCards([
            parent({ id: 'p1', name: '集合', bucket: 'proxy' }),
            child({ id: 'c1', name: '留在集合里', bucket: 'proxy', order: 0,
                sources: [{ id: 's1', kind: 'remote', value: 'https://example.com/a.list' }] }),
            child({ id: 'c2', name: '📹 单独拖出', bucket: 'flexible', order: 1,
                sources: [{ id: 's2', kind: 'remote', value: 'https://example.com/b.list' }] })
        ]));

        const names = groupLines(ini).map(groupName);
        expect(names).toContain('📹 单独拖出');
        expect(names).toContain(GROUP_NAMES.proxy);
        // 拖出的那条只算一次，不重复计入父卡片
        expect(ruleLines(ini).filter(line => rulePolicy(line) === '📹 单独拖出')).toHaveLength(1);
        expect(ruleLines(ini).filter(line => rulePolicy(line) === GROUP_NAMES.proxy)).toHaveLength(1);
    });

    it('大卡片内小卡片归零时不产出任何内容', () => {
        const { ini } = serializeState(stateWithCards([
            parent({ id: 'p1', name: '空集合', bucket: 'flexible' }),
            // 小卡片被拖回待选栏
            child({ id: 'c1', name: '已拖走', bucket: 'off' })
        ]));

        expect(ini).not.toContain('空集合');
        expect(groupLines(ini).map(groupName)).not.toContain(GROUP_NAMES.proxy);
    });

    it('承接组无论多少卡片都只生成一个组', () => {
        const { ini } = serializeState(stateWithCards([
            parent({ id: 'p1', name: '集合A', bucket: 'proxy' }),
            child({ id: 'c1', name: 'r1', parentId: 'p1', bucket: 'proxy', order: 0,
                sources: [{ id: 's1', kind: 'remote', value: 'https://example.com/a.list' }] }),
            parent({ id: 'p2', name: '集合B', bucket: 'proxy' }),
            child({ id: 'c2', name: 'r2', parentId: 'p2', bucket: 'proxy', order: 1,
                sources: [{ id: 's2', kind: 'remote', value: 'https://example.com/b.list' }] })
        ]));

        expect(groupLines(ini).filter(line => groupName(line) === GROUP_NAMES.proxy)).toHaveLength(1);
        expect(ruleLines(ini).filter(line => rulePolicy(line) === GROUP_NAMES.proxy)).toHaveLength(2);
        expect(groupLines(ini).map(groupName)).not.toContain('集合A');
    });

    it('所有承接组共用桶标准成员，卡片上没有出口目标', () => {
        const state = stateWithCards([
            parent({ id: 'p1', name: '灵活卡', bucket: 'flexible' }),
            child({ id: 'c1', parentId: 'p1', bucket: 'flexible' }),
            parent({ id: 'p2', name: '代理卡', bucket: 'proxy' }),
            child({ id: 'c2', parentId: 'p2', bucket: 'proxy',
                sources: [{ id: 's2', kind: 'remote', value: 'https://example.com/b.list' }] }),
            parent({ id: 'p3', name: '直连卡', bucket: 'direct' }),
            child({ id: 'c3', parentId: 'p3', bucket: 'direct',
                sources: [{ id: 's3', kind: 'remote', value: 'https://example.com/c.list' }] })
        ]);
        state.base.fallback = true;

        const { ini } = serializeState(state);
        const byName = new Map(groupLines(ini).map(line => [groupName(line), groupMembers(line)]));
        const standard = [
            GROUP_NAMES.nodeSelect, GROUP_NAMES.manualSelect,
            GROUP_NAMES.autoSelect, GROUP_NAMES.fallback, 'DIRECT'
        ];

        expect(byName.get('灵活卡')).toEqual(standard);
        expect(byName.get(GROUP_NAMES.proxy)).toEqual(standard);
        expect(byName.get(GROUP_NAMES.final)).toEqual(standard);

        // 🎯 全球直连唯一的排列例外：DIRECT 置首，默认直连
        expect(byName.get(GROUP_NAMES.direct)[0]).toBe('DIRECT');
        expect(byName.get(GROUP_NAMES.direct)).toEqual([
            'DIRECT', GROUP_NAMES.nodeSelect, GROUP_NAMES.manualSelect,
            GROUP_NAMES.autoSelect, GROUP_NAMES.fallback
        ]);

        // 地区组不进任何承接组
        const regionNames = state.base.regions.filter(r => r.enabled).map(r => r.name);
        [GROUP_NAMES.proxy, GROUP_NAMES.direct, GROUP_NAMES.final, '灵活卡'].forEach(name => {
            regionNames.forEach(region => expect(byName.get(name)).not.toContain(region));
        });
    });

    it('🛑 广告拦截 成员为 REJECT / DIRECT / 🚀 节点选择，空桶时整组消失', () => {
        const withAd = serializeState(stateWithCards([
            parent({ id: 'p1', name: '广告集合', bucket: 'adblock' }),
            child({ id: 'c1', parentId: 'p1', bucket: 'adblock' })
        ])).ini;

        const adLine = groupLines(withAd).find(line => groupName(line) === GROUP_NAMES.adBlock);
        expect(groupMembers(adLine)).toEqual([...AD_BLOCK_MEMBERS]);
        expect(groupMembers(adLine)[0]).toBe('REJECT');    // 默认拦截

        const withoutAd = serializeState(stateWithCards([
            parent({ id: 'p1', name: '广告集合', bucket: 'off' }),
            child({ id: 'c1', parentId: 'p1', bucket: 'off' })
        ])).ini;
        expect(groupLines(withoutAd).map(groupName)).not.toContain(GROUP_NAMES.adBlock);
    });

    it('前置修正段的规则指向字面量 DIRECT，不生成额外策略组', () => {
        const state = stateWithCards([
            parent({ id: 'p1', name: '直连例外', bucket: 'prepend' }),
            child({ id: 'c1', parentId: 'p1', bucket: 'prepend' })
        ]);
        state.headModifiers.localAreaNetwork = true;

        const { ini } = serializeState(state);
        expect(ruleLines(ini).filter(line => rulePolicy(line) === 'DIRECT')).toHaveLength(2);
        // 前置修正非空不会连带生成 🎯 全球直连
        expect(groupLines(ini).map(groupName)).not.toContain(GROUP_NAMES.direct);
        expect(groupLines(ini).map(groupName)).not.toContain('直连例外');
    });

    it('用户卡片恒排在同桶内置卡片之前，其次按 order', () => {
        const { ini } = serializeState(stateWithCards([
            parent({ id: 'p1', name: '内置集合', origin: 'builtin', bucket: 'direct', order: 0 }),
            child({ id: 'c1', parentId: 'p1', origin: 'builtin', bucket: 'direct', order: 0,
                sources: [{ id: 's1', kind: 'remote', value: 'https://example.com/builtin.list' }] }),
            parent({ id: 'p2', name: '用户集合', origin: 'user', bucket: 'direct', order: 500 }),
            child({ id: 'c2', parentId: 'p2', origin: 'user', bucket: 'direct', order: 0,
                sources: [{ id: 's2', kind: 'remote', value: 'https://example.com/user.list' }] })
        ]));

        const bodies = ruleLines(ini).map(line => line.split(',').slice(1).join(','));
        expect(bodies[0]).toContain('user.list');      // 用户卡片在前，尽管 order 更大
        expect(bodies[1]).toContain('builtin.list');
    });

    it('灵活桶里的小卡片可以标 standalone 单独成组，其余小卡片照旧合并', () => {
        const { ini } = serializeState(stateWithCards([
            parent({ id: 'p1', name: '🤖 AI 服务', bucket: 'flexible' }),
            child({ id: 'c1', name: '🧠 OpenAI', bucket: 'flexible', order: 0,
                sources: [{ id: 's1', kind: 'remote', value: 'https://example.com/openai.list' }] }),
            child({ id: 'c2', name: '💠 Gemini', bucket: 'flexible', order: 1, standalone: true,
                sources: [{ id: 's2', kind: 'remote', value: 'https://example.com/gemini.list' }] }),
            child({ id: 'c3', name: '📎 Claude', bucket: 'flexible', order: 2,
                sources: [{ id: 's3', kind: 'remote', value: 'https://example.com/claude.list' }] })
        ]));

        const names = groupLines(ini).map(groupName);
        expect(names).toContain('🤖 AI 服务');
        expect(names).toContain('💠 Gemini');          // 自己一组
        expect(names).not.toContain('🧠 OpenAI');      // 仍由父卡片代表
        expect(names).not.toContain('📎 Claude');

        // 规则不重复：Gemini 只挂在自己那组下，父组只剩另外两条
        expect(ruleLines(ini).filter(line => rulePolicy(line) === '💠 Gemini')).toHaveLength(1);
        expect(ruleLines(ini).filter(line => rulePolicy(line) === '🤖 AI 服务')).toHaveLength(2);
        expect(ini).toContain('ruleset=💠 Gemini,https://example.com/gemini.list');
    });

    it('大卡片的小卡片全部 standalone 后它不再产出，也不留空组', () => {
        const { ini } = serializeState(stateWithCards([
            parent({ id: 'p1', name: '🤖 AI 服务', bucket: 'flexible' }),
            child({ id: 'c1', name: '🧠 OpenAI', bucket: 'flexible', standalone: true,
                sources: [{ id: 's1', kind: 'remote', value: 'https://example.com/openai.list' }] })
        ]));

        expect(groupLines(ini).map(groupName)).not.toContain('🤖 AI 服务');
        expect(groupLines(ini).map(groupName)).toContain('🧠 OpenAI');
        expect(ruleLines(ini).filter(line => rulePolicy(line) === '🧠 OpenAI')).toHaveLength(1);
    });

    it('承接桶里 standalone 不改变输出 —— 整桶仍汇进同一个组', () => {
        const { ini } = serializeState(stateWithCards([
            parent({ id: 'p1', name: '集合', bucket: 'proxy' }),
            child({ id: 'c1', name: 'r1', bucket: 'proxy', order: 0,
                sources: [{ id: 's1', kind: 'remote', value: 'https://example.com/a.list' }] }),
            child({ id: 'c2', name: 'r2', bucket: 'proxy', order: 1, standalone: true,
                sources: [{ id: 's2', kind: 'remote', value: 'https://example.com/b.list' }] })
        ]));

        expect(groupLines(ini).filter(line => groupName(line) === GROUP_NAMES.proxy)).toHaveLength(1);
        expect(ruleLines(ini).filter(line => rulePolicy(line) === GROUP_NAMES.proxy)).toHaveLength(2);
        expect(groupLines(ini).map(groupName)).not.toContain('r2');
    });

    it('地区 pattern 统一包一层外括号，其他地区用反向前瞻', () => {
        const { ini } = serializeState(createDefaultState());
        const hk = groupLines(ini).find(line => groupName(line) === '🇭🇰 香港节点');
        const other = groupLines(ini).find(line => groupName(line) === GROUP_NAMES.otherRegion);

        expect(hk).toContain('`(港|HK|Hong ?Kong|HKG)`');
        expect(hk).toContain('`url-test`');
        expect(hk).toContain('`http://www.gstatic.com/generate_204`300,,50');

        expect(other).toContain('`^(?!.*(');
        expect(other).toMatch(/\)\)\.\*\$`/);
        expect(ini).not.toContain('(?i)');
    });

    it('未勾选任何具名地区时不输出 🌐 其他地区', () => {
        const state = createDefaultState();
        state.base.regions = createRegionConfigs([OTHER_REGION_ID]);
        expect(groupLines(serializeState(state).ini).map(groupName))
            .not.toContain(GROUP_NAMES.otherRegion);
    });

    it('无可选基础组与地区时 🚀 节点选择 降级为 .* + DIRECT', () => {
        const state = createDefaultState();
        state.base = { autoSelect: false, manualSelect: false, fallback: false, regions: createRegionConfigs([]) };

        const lines = groupLines(serializeState(state).ini);
        expect(lines[0]).toBe(`custom_proxy_group=${GROUP_NAMES.nodeSelect}\`select\`.*\`[]DIRECT`);
        expect(groupMembers(lines.at(-1))).toEqual([GROUP_NAMES.nodeSelect, 'DIRECT']);
    });

    it('内联来源的 no-resolve 作为第三段透传', () => {
        const { ini } = serializeState(stateWithCards([
            parent({ id: 'p1', name: 'IP 集合', bucket: 'direct' }),
            child({ id: 'c1', parentId: 'p1', bucket: 'direct',
                sources: [{ id: 's1', kind: 'inline', ruleType: 'IP-CIDR', value: '10.0.0.0/8', noResolve: true }] })
        ]));
        expect(ini).toContain(`ruleset=${GROUP_NAMES.direct},[]IP-CIDR,10.0.0.0/8,no-resolve`);
    });

    it('注释头对渲染器惰性，且不影响 hasIniShape', () => {
        const { ini } = serializeState(createDefaultState());
        const lines = ini.trimEnd().split('\n');

        expect(lines.at(-1).startsWith(';')).toBe(true);
        expect(/\[(custom|proxy\s*group|rule|ruleset|proxy)\]/i.test(ini)).toBe(true);
        expect(serializeState(createDefaultState(), { includeHeader: false }).ini.startsWith('[custom]')).toBe(true);
        expect(serializeState(createDefaultState(), { includeHeader: false }).ini)
            .not.toContain(STATE_HEADER_PREFIX);
    });
});
