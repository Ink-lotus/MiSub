/**
 * 可视化规则生成器 —— GeneratorState → INI 序列化
 *
 * 纯函数，无副作用、无 IO。输出的 INI 是 MiSub 现有渲染链路的入口
 * （processor-service.js:231-284），后续转换全部继承宿主能力。
 *
 * 策略组只有这些，顺序即客户端列表顺序：
 *   🚀 节点选择（固定） → ☑️ 手动切换 → ♻️ 自动选择 → 🔯 故障转移
 *   → 地区组 + 🌐 其他地区 → 灵活桶各组 → 🛑 广告拦截
 *   → 🌍 国外代理 → 🎯 全球直连 → 🐟 漏网之鱼（固定）
 *
 * 规则段顺序即匹配优先级：
 *   前置修正 → 灵活桶 → 广告拦截 → 国外代理 → 全球直连 → []FINAL
 */

import {
    GROUP_NAMES,
    RULE_BUCKET_ORDER,
    BUCKET_POLICY,
    AD_BLOCK_MEMBERS,
    BUILTIN_CARDS,
    LOCAL_AREA_NETWORK_SOURCE,
    OTHER_REGION_ID,
    STATE_HEADER_PREFIX,
    DEFAULT_TEST_URL,
    DEFAULT_INTERVAL,
    DEFAULT_TOLERANCE,
    effectiveSources
} from './catalog.js';

/**
 * UTF-8 安全的 base64 编码。状态 JSON 含中文与 emoji，直接 btoa 会抛
 * InvalidCharacterError，必须先过 TextEncoder。分块避免 apply 爆栈。
 */
function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

const BUILTIN_BY_ID = new Map(BUILTIN_CARDS.map(card => [card.id, card]));

/** 参与「与目录比对」的字段，顺序固定，保证同一状态每次编码逐字节相同。 */
const CARD_FIELDS = Object.freeze(['name', 'parentId', 'origin', 'bucket', 'order', 'sources', 'note']);

/**
 * 卡片瘦身：内置卡片只写「与目录不同的字段」，一字不差的整张压成一个 id 字符串。
 *
 * 目录有 78 张卡片，全量写进注释头约 31 KB —— 单模板 128 KB 上限的四分之一，
 * 且在高级模式的 textarea 里是一行看不懂的巨串。瘦身后默认状态约 1.5 KB。
 * 反向展开在 parse.js 的 expandCards()，两边必须对称。
 *
 * 数组长度与下标顺序原样保留 —— compareCards 的最后一级排序依赖数组下标。
 */
function compactCards(cards) {
    return (Array.isArray(cards) ? cards : []).map(card => {
        const builtin = card && card.origin === 'builtin' ? BUILTIN_BY_ID.get(card.id) : null;
        if (!builtin) return card;

        const diff = {};
        CARD_FIELDS.forEach(field => {
            if (card[field] === undefined) return;
            if (JSON.stringify(card[field]) === JSON.stringify(builtin[field])) return;
            diff[field] = card[field];
        });

        return Object.keys(diff).length > 0 ? { id: card.id, ...diff } : card.id;
    });
}

/**
 * 生成往返注释头。
 *
 * ini-template-parser.js:10 跳过 `;` 开头的行，因此该头对渲染器完全惰性；
 * `[custom]` 仍在，rule-template-handler.js:28 的 hasIniShape() 通过。
 */
export function encodeStateHeader(state) {
    const payload = { ...state, cards: compactCards(state?.cards) };
    return `${STATE_HEADER_PREFIX} ${toBase64(JSON.stringify(payload))}`;
}

/**
 * 一条来源渲染成一行 `ruleset=`。
 *
 * remote → `ruleset=<组名>,<URL>`，由 render-clash.js:130-159 转成 rule-provider
 * inline → `ruleset=<组名>,[]<TYPE>,<值>`，走 ini-template-parser.js:73-83
 */
function formatRuleLine(policy, source) {
    if (source.kind === 'inline') {
        const type = String(source.ruleType || '').trim().toUpperCase();
        const parts = [`[]${type}`, String(source.value ?? '').trim()];
        // no-resolve 作为第三段透传，解析后进 rule.extras。
        // 已核实：六个渲染器的 mapRule 都只输出 type/value/policy
        // （render-clash.js:110-119），因此该修饰符在 MiSub 侧被静默丢弃。
        // 仍照写 —— 它保留在往返状态里，也让模板在支持该语法的转换器下正确。
        if (source.noResolve) parts.push('no-resolve');
        return `ruleset=${policy},${parts.join(',')}`;
    }
    return `ruleset=${policy},${String(source.value ?? '').trim()}`;
}

/** 桶内排序：用户卡片恒排在内置卡片之前，其次按 order，最后按下标保持稳定。 */
function compareCards(a, b) {
    const rank = entry => (entry.card.origin === 'user' ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const orderA = Number(a.card.order) || 0;
    const orderB = Number(b.card.order) || 0;
    if (orderA !== orderB) return orderA - orderB;
    return a.index - b.index;
}

/**
 * 取某个桶内的**顶层**卡片，已排序，且只保留实际有来源的。
 *
 * 顶层 = 大卡片，或被单独拖出父卡片的小卡片（其父卡片不在同一个桶里）。
 * 跟着父卡片留在同桶的小卡片不算顶层 —— 它们的来源已由父卡片的
 * effectiveSources 收进去，单独再算一次会重复输出。
 */
function topLevelCardsIn(cards, bucket) {
    const list = Array.isArray(cards) ? cards : [];
    const byId = new Map(list.map(card => [card.id, card]));

    return list
        .map((card, index) => ({ card, index }))
        .filter(({ card }) => {
            if (!card || card.bucket !== bucket) return false;
            if (card.parentId !== null) {
                const parent = byId.get(card.parentId);
                // 父卡片同桶 → 由父卡片统一产出，此处跳过
                if (parent && parent.bucket === bucket) return false;
            }
            return effectiveSources(list, card).length > 0;
        })
        .sort(compareCards)
        .map(({ card }) => card);
}

/** 已勾选的具名地区（排除派生的 `🌐 其他地区`）。 */
function enabledRegions(state) {
    return (state?.base?.regions || []).filter(region =>
        region && region.enabled && region.id !== OTHER_REGION_ID && String(region.pattern || '').trim());
}

/** `🌐 其他地区` 是否输出。未勾选任何具名地区时不输出，避免空捕获组。 */
function shouldEmitOtherRegion(state) {
    const other = (state?.base?.regions || []).find(region => region?.id === OTHER_REGION_ID);
    return Boolean(other?.enabled) && enabledRegions(state).length > 0;
}

/**
 * `🌐 其他地区` 的反向前瞻。以 `^` 开头，因此不触发
 * ini-template-parser.js:125 的 slice 分支，走 :133 兜底进 filters。
 */
function buildOtherRegionPattern(state) {
    const joined = enabledRegions(state).map(region => String(region.pattern).trim()).join('|');
    return `^(?!.*(${joined})).*$`;
}

/**
 * 拼一行 `custom_proxy_group=`。字段以反引号分隔（ini-template-parser.js:97）。
 *
 * 成员加 `[]` 前缀走 :107 的成员分支；过滤器裸写，由 :125-139 识别。
 * 测速组把 url 与 `interval,,tolerance` 附在末尾，对应 :111 与 :116。
 */
function formatGroupLine({ name, type, filters = [], members = [], options = null }) {
    const parts = [name, type];
    filters.forEach(filter => parts.push(filter));
    members.forEach(member => parts.push(`[]${member}`));

    if (options) {
        parts.push(options.testUrl || DEFAULT_TEST_URL);
        const interval = Number(options.interval) || DEFAULT_INTERVAL;
        const tolerance = Number(options.tolerance) || DEFAULT_TOLERANCE;
        parts.push(`${interval},,${tolerance}`);
    }

    return `custom_proxy_group=${parts.join('`')}`;
}

/** 测速组的参数三元组。 */
function testOptions(source) {
    return {
        testUrl: source?.testUrl || DEFAULT_TEST_URL,
        interval: source?.interval ?? DEFAULT_INTERVAL,
        tolerance: source?.tolerance ?? DEFAULT_TOLERANCE
    };
}

/** 已勾选的可选基础组，按固定顺序。 */
function enabledOptionalBaseGroups(state) {
    const base = state?.base || {};
    const groups = [];
    if (base.manualSelect) groups.push(GROUP_NAMES.manualSelect);
    if (base.autoSelect) groups.push(GROUP_NAMES.autoSelect);
    if (base.fallback) groups.push(GROUP_NAMES.fallback);
    return groups;
}

/**
 * 「桶标准成员」= `🚀 节点选择` + 已勾选可选基础组 + `DIRECT`。
 *
 * 出口由策略组决定、不在卡片上写死，因此所有承接组共用这一套成员，
 * 用户在客户端里自行选择走哪个。地区组刻意不进桶成员 —— 地区通常 6-7 个，
 * 逐桶枚举会让每个组的选项列表膨胀到十几项。
 */
function standardBucketMembers(state) {
    return [GROUP_NAMES.nodeSelect, ...enabledOptionalBaseGroups(state), 'DIRECT'];
}

/** 组装规则段，六段固定顺序。`ruleset=` 行序即最终匹配优先级。 */
function buildRuleLines(state) {
    const lines = [];
    const cards = state?.cards || [];

    // 1. 局域网直连开关，恒在最前
    if (state?.headModifiers?.localAreaNetwork) {
        lines.push(`ruleset=${BUCKET_POLICY.prepend},${LOCAL_AREA_NETWORK_SOURCE}`);
    }

    // 2-6. 各桶。灵活桶每张顶层卡片一个同名组，其余桶全部并入该桶的承接组
    RULE_BUCKET_ORDER.forEach(bucket => {
        topLevelCardsIn(cards, bucket).forEach(card => {
            const policy = bucket === 'flexible' ? card.name : BUCKET_POLICY[bucket];
            effectiveSources(cards, card).forEach(source => lines.push(formatRuleLine(policy, source)));
        });
    });

    // 恒定末位
    lines.push(`ruleset=${GROUP_NAMES.final},[]FINAL`);
    return lines;
}

/** 组装策略组段。组顺序只决定客户端列表排列，与规则优先级无关。 */
function buildGroupLines(state) {
    const lines = [];
    const cards = state?.cards || [];
    const optionalBase = enabledOptionalBaseGroups(state);
    const regions = enabledRegions(state);
    const emitOther = shouldEmitOtherRegion(state);

    const regionNames = regions.map(region => region.name);
    if (emitOther) regionNames.push(GROUP_NAMES.otherRegion);

    // 1. 🚀 节点选择。无任何下级组时降级为直接容纳全部节点
    if (optionalBase.length === 0 && regionNames.length === 0) {
        lines.push(formatGroupLine({
            name: GROUP_NAMES.nodeSelect, type: 'select',
            filters: ['.*'], members: ['DIRECT']
        }));
    } else {
        lines.push(formatGroupLine({
            name: GROUP_NAMES.nodeSelect, type: 'select',
            members: [...optionalBase, ...regionNames, 'DIRECT']
        }));
    }

    // 2-4. 可选基础组
    const base = state?.base || {};
    if (base.manualSelect) {
        lines.push(formatGroupLine({ name: GROUP_NAMES.manualSelect, type: 'select', filters: ['.*'] }));
    }
    if (base.autoSelect) {
        lines.push(formatGroupLine({
            name: GROUP_NAMES.autoSelect, type: 'url-test',
            filters: ['.*'], options: testOptions(base)
        }));
    }
    if (base.fallback) {
        lines.push(formatGroupLine({
            name: GROUP_NAMES.fallback, type: 'fallback',
            filters: ['.*'], options: testOptions(base)
        }));
    }

    // 5. 地区组。pattern 统一包一层外括号，由 ini-template-parser.js:126 剥掉
    regions.forEach(region => {
        const isTest = region.type !== 'select';
        lines.push(formatGroupLine({
            name: region.name,
            type: isTest ? 'url-test' : 'select',
            filters: [`(${String(region.pattern).trim()})`],
            options: isTest ? testOptions(region) : null
        }));
    });
    if (emitOther) {
        const other = (state?.base?.regions || []).find(region => region?.id === OTHER_REGION_ID);
        lines.push(formatGroupLine({
            name: GROUP_NAMES.otherRegion, type: 'url-test',
            filters: [buildOtherRegionPattern(state)],
            options: testOptions(other)
        }));
    }

    // 6. 灵活桶：每张顶层卡片一个同名组
    const standard = standardBucketMembers(state);
    topLevelCardsIn(cards, 'flexible').forEach(card => {
        lines.push(formatGroupLine({ name: card.name, type: 'select', members: standard }));
    });

    // 7. 🛑 广告拦截。REJECT 置首默认拦截，另两项是放行入口
    if (topLevelCardsIn(cards, 'adblock').length > 0) {
        lines.push(formatGroupLine({
            name: GROUP_NAMES.adBlock, type: 'select', members: [...AD_BLOCK_MEMBERS]
        }));
    }

    // 8-9. 承接组，由桶是否有内容派生
    if (topLevelCardsIn(cards, 'proxy').length > 0) {
        lines.push(formatGroupLine({ name: GROUP_NAMES.proxy, type: 'select', members: standard }));
    }
    if (topLevelCardsIn(cards, 'direct').length > 0) {
        // DIRECT 提到首位：select 组默认选中首个成员，否则「全球直连」语义反转
        lines.push(formatGroupLine({
            name: GROUP_NAMES.direct, type: 'select',
            members: ['DIRECT', GROUP_NAMES.nodeSelect, ...optionalBase]
        }));
    }

    // 10. 🐟 漏网之鱼恒定输出 —— 它承接 []FINAL
    lines.push(formatGroupLine({ name: GROUP_NAMES.final, type: 'select', members: standard }));

    return lines;
}

/**
 * 主入口：GeneratorState → INI 文本。
 *
 * @param {object} state GeneratorState
 * @param {object} [options]
 * @param {boolean} [options.includeHeader=true] 是否写入往返注释头
 * @returns {{ini: string, groupCount: number, ruleCount: number}}
 */
export function serializeState(state, options = {}) {
    const includeHeader = options.includeHeader !== false;
    const ruleLines = buildRuleLines(state);
    const groupLines = buildGroupLines(state);

    const out = [];
    if (includeHeader) out.push(encodeStateHeader(state));
    out.push('[custom]');
    out.push(...ruleLines);
    out.push('');
    out.push(...groupLines);
    out.push('');
    out.push('enable_rule_generator=true');
    out.push('overwrite_original_rules=true');

    return {
        ini: `${out.join('\n')}\n`,
        groupCount: groupLines.length,
        ruleCount: ruleLines.length
    };
}
