/**
 * 可视化规则生成器 —— 生成前校验（PROJECT_PLAN_2.0 §6 / A5）
 *
 * 纯函数，返回结构化 `{ level, field, message }` 列表。
 *   error → 拦截生成
 *   warn  → 仅提示，不拦截
 *
 * 宿主已经解决了 0 命中降级与悬空引用（§2.2 / template-processor.js:43-76,
 * 178-190），因此这里只覆盖宿主**不会**替我们兜住的那些失败模式 ——
 * 尤其是会被静默处理、用户完全无感的几类。
 */

import {
    GROUP_NAMES,
    RESERVED_POLICY_NAMES,
    OTHER_REGION_ID,
    BUILTIN_CARDS,
    effectiveSources,
    isTopLevelIn
} from './catalog.js';
import { findSourceConflicts, sourceKey } from './dedupe.js';

/**
 * 分隔符注入（§6.1，旧 R1 —— 17 条问题里唯一仍成立的高危项）。
 *
 * MiSub 的解析器按分隔符切分，与 subconverter 风险等价。每个字符对应
 * 一个具体破坏点，不做静默转义，一律 UI 内联报错。
 */
const FORBIDDEN_CHARS = Object.freeze([
    { char: ',', label: '逗号', reason: '会被当成 ruleset= 的组名/规则边界（ini-template-parser.js:64）' },
    { char: '`', label: '反引号', reason: '会被当成 custom_proxy_group= 的字段边界（ini-template-parser.js:97）' },
    { char: '=', label: '等号', reason: '该成员会被整条丢弃（ini-template-parser.js:133）' },
    { char: '\n', label: '换行', reason: '会被当成 ini 行边界（ini-template-parser.js:4）' },
    { char: '\r', label: '回车', reason: '会被当成 ini 行边界（ini-template-parser.js:4）' }
]);

function finding(level, field, message) {
    return { level, field, message };
}

/** 逐字符扫描一个用户可编辑字符串。 */
function checkInjection(value, field, label) {
    const text = String(value ?? '');
    const hits = FORBIDDEN_CHARS.filter(entry => text.includes(entry.char));

    const out = hits.map(entry =>
        finding('error', field, `${label}不能包含${entry.label}：${entry.reason}`));

    // §6.1：MiSub 无 applyMatcher 实现，不构成风险，仅为跨转换器可移植性提示
    if (text.trim().startsWith('!!')) {
        out.push(finding('warn', field, `${label}以 !! 开头，在其它转换器下会被当作指令语法`));
    }

    return out;
}

/**
 * 地区配置校验（§3.1）。
 *
 * 这里的失败模式最隐蔽：非法 pattern 会让 template-processor.js:30-32
 * 捕获异常并只打一条 console.warn，该组拿到 0 成员，随后被
 * pruneEmptyGroups 静默删除 —— 用户只会看到地区组凭空消失。因此
 * 全部按 error 拦截。
 */
function checkRegions(state) {
    const out = [];
    const regions = state?.base?.regions || [];
    const enabled = regions.filter(region => region?.enabled);

    enabled.forEach((region, index) => {
        const field = `base.regions[${index}]`;
        out.push(...checkInjection(region.name, `${field}.name`, '地区组名'));

        // 派生组的 pattern 由已启用地区合成，不校验用户输入
        if (region.id === OTHER_REGION_ID) return;

        const pattern = String(region.pattern ?? '').trim();
        if (!pattern) {
            out.push(finding('error', `${field}.pattern`, `地区「${region.name}」的匹配规则为空`));
            return;
        }

        if (/\(\?i\)/.test(pattern)) {
            out.push(finding('error', `${field}.pattern`,
                `地区「${region.name}」不能使用 (?i)：剥壳后正则非法，该组会被静默删除。匹配本就不区分大小写`));
        }

        if (/[()]/.test(pattern)) {
            out.push(finding('error', `${field}.pattern`,
                `地区「${region.name}」的匹配规则不能包含括号：序列化时会统一包一层，多层括号剥壳后不配对`));
        }

        try {
            new RegExp(pattern, 'i');   // 口径与 template-processor.js:24 完全一致
        } catch (error) {
            out.push(finding('error', `${field}.pattern`,
                `地区「${region.name}」的匹配规则不是合法正则：${error.message}`));
        }
    });

    // §4.1 M9：其他地区依赖至少一个具名地区，否则合成出空捕获组
    const other = regions.find(region => region?.id === OTHER_REGION_ID);
    const namedEnabled = enabled.filter(region => region.id !== OTHER_REGION_ID);
    if (other?.enabled && namedEnabled.length === 0) {
        out.push(finding('warn', 'base.regions',
            '未勾选任何具体地区，「🌐 其他地区」不会输出'));
    }

    return out;
}

const INLINE_RULE_TYPES = Object.freeze([
    'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD',
    'IP-CIDR', 'IP-CIDR6', 'GEOIP', 'GEOSITE',
    'PROCESS-NAME', 'DST-PORT'
]);

/** 卡片内每条来源的校验。 */
function checkCardSources(card, cardIndex) {
    const out = [];
    const sources = Array.isArray(card.sources) ? card.sources : [];
    const field = `cards[${cardIndex}]`;

    if (sources.length === 0) {
        // §5.2：空来源卡片整卡跳过，否则会输出一个无任何规则指向的孤立组
        out.push(finding('warn', field, `卡片「${card.name}」没有任何来源，不会产出内容`));
        return out;
    }

    sources.forEach((source, index) => {
        const sourceField = `${field}.sources[${index}]`;
        const value = String(source?.value ?? '').trim();

        if (!value) {
            out.push(finding('error', sourceField, `卡片「${card.name}」有一条来源为空`));
            return;
        }

        if (source.kind === 'inline') {
            const type = String(source.ruleType || '').trim().toUpperCase();
            if (!INLINE_RULE_TYPES.includes(type)) {
                out.push(finding('error', sourceField,
                    `卡片「${card.name}」的内联规则类型「${source.ruleType || '未选择'}」不受支持`));
            }
            // 值里的逗号可无条件拒绝：类型由 ruleType 单独承载，
            // `DOMAIN-SUFFIX,x` 的逗号是序列化时拼出来的（§6.1）
            out.push(...checkInjection(value, sourceField, '内联规则值'));
            return;
        }

        if (!/^https?:\/\//i.test(value)) {
            out.push(finding('error', sourceField,
                `卡片「${card.name}」的规则集地址必须以 http:// 或 https:// 开头`));
            return;
        }

        out.push(...checkInjection(value, sourceField, '规则集地址'));
    });

    return out;
}

/**
 * 灵活桶卡片名唯一性（§6.2）。
 *
 * 撞名的后果是 dedupeGroupsByName（template-processor.js:102-137）
 * **静默合并**两个组、并合其成员与 options，语义被改变而用户无感 ——
 * 因此必须在生成前拦下。
 */
function checkFlexibleNames(state) {
    const out = [];
    const cards = state?.cards || [];

    // 固定组名。🛑 广告拦截 一并计入：桶非空时它会被输出
    const taken = new Map();
    Object.values(GROUP_NAMES).forEach(name => taken.set(name, '内置策略组'));
    RESERVED_POLICY_NAMES.forEach(name => taken.set(name, '保留策略名'));
    (state?.base?.regions || [])
        .filter(region => region?.enabled)
        .forEach(region => taken.set(String(region.name || '').trim(), '地区组'));

    cards.forEach((card, index) => {
        // 只看顶层卡片：由父卡片代表的小卡片不单独成组，其名字不是组名。
        // 标了 standalone 的小卡片是顶层，因此它的名字也要查重
        if (!isTopLevelIn(cards, card, 'flexible')) return;
        // 大卡片自身 sources 恒空，必须按 effectiveSources 判断是否真的产出
        if (effectiveSources(cards, card).length === 0) return;

        const field = `cards[${index}].name`;
        const name = String(card.name ?? '').trim();

        if (!name) {
            out.push(finding('error', field, '进入灵活桶的卡片必须有名称，它就是策略组名'));
            return;
        }

        out.push(...checkInjection(name, field, '卡片名'));

        const clash = taken.get(name);
        if (clash) {
            out.push(finding('error', field,
                `卡片名「${name}」与${clash}重名，会被静默合并成一个组`));
            return;
        }

        taken.set(name, '另一张灵活桶卡片');
    });

    return out;
}

/**
 * 大卡片内小卡片归零 —— 它不产出任何内容。
 *
 * 出口不再绑在卡片上（由策略组决定），因此原先的「目标有效性」校验全部作废，
 * 换成这一条：只有真正空掉的大卡片才提示，有小卡片的大卡片不该被误报。
 * 判定走 effectiveSources()，因此小卡片被拖走、或被标成 standalone 单独成组，
 * 都算这张大卡片空了。
 */
function checkEmptyParents(state) {
    const out = [];
    const cards = state?.cards || [];

    cards.forEach((card, index) => {
        if (!card || card.parentId !== null) return;
        if (card.bucket === 'off') return;
        if (effectiveSources(cards, card).length > 0) return;

        out.push(finding('warn', `cards[${index}]`,
            `集合「${card.name}」里没有任何规则卡片，不会产出内容`));
    });

    return out;
}

/**
 * 按输出顺序展平生效的**顶层**卡片，供顺序敏感的检查复用。
 * 口径由 catalog.js 的 isTopLevelIn() 统一，与 serialize.js 一致。
 */
function orderedActiveCards(state) {
    const order = ['prepend', 'flexible', 'adblock', 'proxy', 'direct'];
    const all = state?.cards || [];

    return order.flatMap(bucket => all
        .filter(card => isTopLevelIn(all, card, bucket) && effectiveSources(all, card).length > 0)
        .sort((a, b) => {
            const rank = card => (card.origin === 'user' ? 0 : 1);
            if (rank(a) !== rank(b)) return rank(a) - rank(b);
            return (Number(a.order) || 0) - (Number(b.order) || 0);
        })
        .map(card => ({ ...card, sources: effectiveSources(all, card) })));
}

/**
 * URL 字面重复与跨桶来源遮蔽（§6.2 两条，底层是同一件事）。
 *
 * 按 §5.1 顺序先出现者生效、后者完全失效。只查字面相同 —— 内容级重叠是
 * §十明确接受的缺口。
 */
function checkConflicts(state) {
    const conflicts = findSourceConflicts(orderedActiveCards(state));

    return conflicts.filter(conflict => conflict.active).map(conflict => {
        const [winner, ...losers] = conflict.entries;
        const loserNames = losers.map(entry => `「${entry.cardName}」`).join('、');
        return finding('error', 'cards',
            `${conflict.kind === 'inline' ? '内联规则' : '规则集'} ${conflict.value} 同时出现在「${winner.cardName}」与${loserNames}；按输出顺序只有前者生效，请处理重复`);
    });
}

/** 内置卡片的原始来源集合，供「用户输入是否撞上内置目录」判定使用。 */
const BUILTIN_SOURCE_KEYS = new Set(
    BUILTIN_CARDS.flatMap(card => card.sources.map(sourceKey)).filter(Boolean)
);

/**
 * 用户自填来源撞上内置目录（§4.4）。
 *
 * 与 checkConflicts 的区别：那条查的是「同一集合内两张卡片撞车」，
 * 这条查的是「用户卡片撞上内置目录里已被移除或改桶的条目」，在两张卡片
 * 不同时生效时也应提示。降为 warn，避免与 error 重复报同一件事。
 */
function checkBuiltinOverlap(state) {
    const out = [];

    (state?.cards || []).forEach((card, index) => {
        if (!card || card.origin !== 'user' || card.bucket === 'off') return;

        (card.sources || []).forEach((source, sourceIndex) => {
            const key = sourceKey(source);
            if (key && BUILTIN_SOURCE_KEYS.has(key)) {
                out.push(finding('warn', `cards[${index}].sources[${sourceIndex}]`,
                    `卡片「${card.name}」的这条来源与内置目录中的条目相同，确认是否重复配置`));
            }
        });
    });

    return out;
}

/**
 * GEOIP / IP 类卡片的位置约定（§4.3 / §6.2）。
 *
 * `GEOIP,CN` 覆盖面极大。落进 `🎯 全球直连` 以外的段时它会排在该组全部
 * 域名规则之前，把 ChinaDomain 之类清单整体遮蔽。这是 warn 而非拦截 ——
 * 用户可能确有此意图（如刻意让国内 IP 走代理）。
 */
function checkGeoipPlacement(state) {
    const out = [];
    const IP_TYPES = new Set(['GEOIP', 'IP-CIDR', 'IP-CIDR6']);

    (state?.cards || []).forEach((card, index) => {
        if (!card || card.bucket === 'off') return;
        if (!Array.isArray(card.sources) || card.sources.length === 0) return;

        const isIpOnly = card.sources.every(source =>
            source?.kind === 'inline' && IP_TYPES.has(String(source.ruleType || '').toUpperCase()));
        if (!isIpOnly) return;

        if (card.bucket !== 'direct') {
            out.push(finding('warn', `cards[${index}].bucket`,
                `卡片「${card.name}」只含 IP 段规则，粒度粗。放在这里会遮蔽其后所有域名规则`));
        }
    });

    return out;
}

/**
 * 策略组数量软提示（§6.3）。
 *
 * 只提示不拦截：MiSub 侧不存在任何策略组数量上限，按自定数字硬拦截会重复
 * 旧文档 R6 的错误。
 */
export function countPolicyGroups(state) {
    const base = state?.base || {};
    // 只数顶层且有实际来源的卡片，口径与 serialize.js 一致
    const active = orderedActiveCards(state);

    let count = 1;                                            // 🚀 节点选择恒定
    if (base.manualSelect) count += 1;
    if (base.autoSelect) count += 1;
    if (base.fallback) count += 1;

    const regions = (base.regions || []).filter(region => region?.enabled);
    const named = regions.filter(region => region.id !== OTHER_REGION_ID);
    count += named.length;
    if (regions.some(region => region.id === OTHER_REGION_ID) && named.length > 0) count += 1;

    // 灵活桶每张顶层卡片一组；三个承接组各自最多一个
    count += active.filter(card => card.bucket === 'flexible').length;
    if (active.some(card => card.bucket === 'adblock')) count += 1;
    if (active.some(card => card.bucket === 'proxy')) count += 1;
    if (active.some(card => card.bucket === 'direct')) count += 1;
    count += 1;                                               // 🐟 漏网之鱼恒定

    return count;
}

/** §6.3 的三档配色阈值。 */
export function groupCountLevel(count) {
    if (count <= 12) return 'green';
    if (count <= 20) return 'yellow';
    return 'red';
}

/**
 * 主入口：跑完 §6.1–6.3 全部校验项。
 *
 * @param {object} state GeneratorState
 * @returns {{findings: Array, errors: Array, warnings: Array, canGenerate: boolean,
 *            groupCount: number, groupCountLevel: string}}
 */
export function validateState(state) {
    const findings = [
        ...checkRegions(state),
        ...checkFlexibleNames(state),
        ...checkEmptyParents(state),
        ...checkConflicts(state),
        ...checkBuiltinOverlap(state),
        ...checkGeoipPlacement(state)
    ];

    // 只校验带来源的卡片。大卡片自身 sources 恒空，空掉的情况由
    // checkEmptyParents 单独提示，此处跳过以免重复报「没有任何来源」
    (state?.cards || []).forEach((card, index) => {
        if (!card || card.bucket === 'off') return;
        if (card.parentId === null && (card.sources || []).length === 0) return;
        findings.push(...checkCardSources(card, index));
    });

    // 至少要有一条实质规则。[]FINAL 与 🚀 节点选择 / 🐟 漏网之鱼 恒定输出
    const hasContent = orderedActiveCards(state).length > 0
        || Boolean(state?.headModifiers?.localAreaNetwork);
    if (!hasContent) {
        findings.push(finding('warn', 'cards',
            '没有任何生效的规则，生成的模板只有兜底规则'));
    }

    const count = countPolicyGroups(state);
    if (count > 20) {
        findings.push(finding('warn', 'groupCount',
            `预计生成 ${count} 个策略组，客户端列表会很长。可把同类清单合并进一张卡片`));
    }

    const errors = findings.filter(item => item.level === 'error');
    return {
        findings,
        errors,
        warnings: findings.filter(item => item.level === 'warn'),
        canGenerate: errors.length === 0,
        groupCount: count,
        groupCountLevel: groupCountLevel(count)
    };
}
