/**
 * 可视化规则生成器 —— INI → GeneratorState 反解
 *
 * 纯函数，无副作用、无 IO。
 *
 * 两条路径：
 *   1. 读 `; misub-visual-state-v1:` 注释头 —— 无损
 *   2. 头缺失时从 `ruleset=` / `custom_proxy_group=` 尽力反推 —— 有损，
 *      返回 `partial: true` 供 UI 提示
 *
 * 另外检测「注释头与正文漂移」：用户在高级模式手改过正文时，**以正文为准**，
 * 返回 `drifted: true`，由 UI 让用户显式选择，不静默覆盖。
 */

import {
    GROUP_NAMES,
    STATE_VERSION,
    STATE_HEADER_PREFIX,
    OTHER_REGION_ID,
    REGION_PRESETS,
    BUILTIN_CARDS,
    BUCKET_POLICY,
    LOCAL_AREA_NETWORK_SOURCE,
    DEFAULT_TEST_URL,
    DEFAULT_INTERVAL,
    DEFAULT_TOLERANCE,
    createRegionConfigs,
    createDefaultState,
    cloneBuiltinCards
} from './catalog.js';
import { serializeState } from './serialize.js';
import { normalizeSourceUrl } from './dedupe.js';

/** UTF-8 安全的 base64 解码，与 serialize.js 的 toBase64 对称。 */
function fromBase64(encoded) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

/** 取出注释头里的 state；缺失或损坏时返回 null。 */
function readStateHeader(iniText) {
    const lines = String(iniText || '').split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!trimmed.startsWith(';') && !trimmed.startsWith('#')) break;  // 已进入正文
        if (!trimmed.startsWith(STATE_HEADER_PREFIX)) continue;

        const payload = trimmed.slice(STATE_HEADER_PREFIX.length).trim();
        if (!payload) return null;

        try {
            const parsed = JSON.parse(fromBase64(payload));
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;   // 头损坏，退回正文反推
        }
    }

    return null;
}

/** 提取 `[custom]` 段的有效行，跳过注释与其它段。 */
function customSectionLines(iniText) {
    const lines = String(iniText || '').split(/\r?\n/);
    const out = [];
    let inCustom = true;   // 与 ini-template-parser.js:6 一致：无段头时默认 custom

    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) continue;

        const section = line.match(/^\[(.+)]$/);
        if (section) {
            inCustom = section[1].trim().toLowerCase() === 'custom';
            continue;
        }

        if (inCustom) out.push(line);
    }

    return out;
}

/** 拆一行 `ruleset=` 成 `{policy, source}`。口径对齐 ini-template-parser.js:62-93。 */
function parseRulesetLine(line) {
    const raw = line.replace(/^ruleset=/i, '');
    const commaAt = raw.indexOf(',');
    if (commaAt < 0) return null;

    const policy = raw.slice(0, commaAt).trim();
    const body = raw.slice(commaAt + 1).trim();
    if (!policy || !body) return null;

    if (body.startsWith('[]')) {
        const parts = body.slice(2).split(',').map(part => part.trim()).filter(Boolean);
        const ruleType = (parts[0] || '').toUpperCase();
        if (ruleType === 'FINAL' || ruleType === 'MATCH') return { policy, final: true };
        return {
            policy,
            source: {
                kind: 'inline',
                ruleType,
                value: parts[1] || '',
                ...(parts.slice(2).some(part => /^no-resolve$/i.test(part)) ? { noResolve: true } : {})
            }
        };
    }

    return { policy, source: { kind: 'remote', value: body } };
}

/**
 * 拆一行 `custom_proxy_group=`。口径对齐 ini-template-parser.js:95-144，
 * 但**不**做 slice 剥壳 —— 这里要拿到用户书写的原始 pattern。
 */
function parseGroupLine(line) {
    const parts = line.replace(/^custom_proxy_group=/i, '')
        .split('`').map(part => part.trim()).filter(Boolean);
    if (parts.length < 2) return null;

    const group = {
        name: parts[0], type: parts[1],
        members: [], filters: [],
        testUrl: '', interval: 0, tolerance: 0
    };

    parts.slice(2).forEach(part => {
        if (part.startsWith('[]')) { group.members.push(part.slice(2)); return; }
        if (/^https?:\/\//i.test(part)) { group.testUrl = part; return; }
        if (/^\d+(?:,\s*\d*)*$/.test(part)) {
            const nums = part.split(',').map(item => item.trim()).filter(Boolean).map(Number);
            if (nums.length > 0) group.interval = nums[0];
            if (nums.length > 1) group.tolerance = nums[1];
            return;
        }
        group.filters.push(part);
    });

    return group;
}

function sourceLookupKey(source) {
    return source.kind === 'remote'
        ? `remote:${normalizeSourceUrl(source.value)}`
        : `inline:${String(source.ruleType || '').toUpperCase()}:${source.value}`;
}

/** 内置小卡片按来源反查表，供反推时识别哪些行属于内置目录。 */
const BUILTIN_BY_SOURCE = new Map();
BUILTIN_CARDS.forEach(card => {
    card.sources.forEach(source => {
        BUILTIN_BY_SOURCE.set(sourceLookupKey(source), card.id);
    });
});

/** 反推地区组：按 pattern 或组名匹配预置；都对不上则作为自定义地区收下。 */
function recoverRegions(groups) {
    const byPattern = new Map();
    const byName = new Map();
    REGION_PRESETS.forEach(preset => {
        byPattern.set(preset.pattern, preset);
        byName.set(preset.name, preset);
    });

    const regions = createRegionConfigs([]);   // 全部 enabled: false 起步
    const extra = [];

    groups.forEach(group => {
        if (group.filters.length !== 1) return;
        const filter = group.filters[0];
        if (filter === '.*') return;           // 基础组

        // 反向前瞻即派生的「其他地区」
        if (filter.startsWith('^(?!')) {
            const other = regions.find(region => region.id === OTHER_REGION_ID);
            if (other) {
                other.enabled = true;
                other.name = group.name;
                if (group.testUrl) other.testUrl = group.testUrl;
                if (group.interval) other.interval = group.interval;
                if (group.tolerance) other.tolerance = group.tolerance;
            }
            return;
        }

        const inner = filter.startsWith('(') && filter.endsWith(')') ? filter.slice(1, -1) : filter;
        const preset = byPattern.get(inner) || byName.get(group.name);
        const config = preset ? regions.find(region => region.id === preset.id) : null;

        const applied = config || {
            id: `custom-${extra.length + 1}`,
            name: group.name,
            pattern: inner,
            type: group.type === 'select' ? 'select' : 'url-test',
            testUrl: DEFAULT_TEST_URL,
            interval: DEFAULT_INTERVAL,
            tolerance: DEFAULT_TOLERANCE,
            enabled: true
        };

        applied.enabled = true;
        applied.name = group.name;
        applied.pattern = inner;
        applied.type = group.type === 'select' ? 'select' : 'url-test';
        if (group.testUrl) applied.testUrl = group.testUrl;
        if (group.interval) applied.interval = group.interval;
        if (group.tolerance) applied.tolerance = group.tolerance;

        if (!config) extra.push(applied);
    });

    // 保持预置顺序，自定义地区插在派生的「其他地区」之前
    const otherIndex = regions.findIndex(region => region.id === OTHER_REGION_ID);
    regions.splice(otherIndex, 0, ...extra);
    return regions;
}

/** 承接组名 → 桶。认不出的组名说明是灵活桶里的自定义组。 */
function bucketForPolicy(policy) {
    if (policy === 'DIRECT') return 'prepend';
    switch (policy) {
        case GROUP_NAMES.adBlock: return 'adblock';
        case GROUP_NAMES.proxy: return 'proxy';
        case GROUP_NAMES.direct: return 'direct';
        default: return null;
    }
}

/**
 * 从 INI 正文尽力反推 state。有损，调用方须置 `partial: true`。
 *
 * 关键修复：正文里没提到的内置卡片**保留目录里的原始 sources**，只是留在
 * `bucket: 'off'`。早先版本会把它们的 sources 清空，导致这些卡片在左栏看着正常、
 * 一拖进桶就报「没有任何来源」。
 */
function recoverFromBody(iniText) {
    const lines = customSectionLines(iniText);
    const groups = lines.filter(line => /^custom_proxy_group=/i.test(line))
        .map(parseGroupLine).filter(Boolean);
    const groupByName = new Map(groups.map(group => [group.name, group]));

    const state = createDefaultState();
    state.base.regions = recoverRegions(groups);
    state.base.manualSelect = groupByName.has(GROUP_NAMES.manualSelect);
    state.base.autoSelect = groupByName.has(GROUP_NAMES.autoSelect);
    state.base.fallback = groupByName.has(GROUP_NAMES.fallback);
    state.headModifiers = { localAreaNetwork: false };

    // 全部内置卡片先归到待选栏，sources 保持目录原样
    const cards = cloneBuiltinCards().map(card => ({ ...card, bucket: 'off' }));
    const byId = new Map(cards.map(card => [card.id, card]));
    const touchedParents = new Set();

    const userCards = new Map();
    let sequence = 0;

    lines.filter(line => /^ruleset=/i.test(line)).forEach(line => {
        const parsed = parseRulesetLine(line);
        if (!parsed || parsed.final) return;

        const { policy, source } = parsed;

        // 局域网直连还原为开关
        if (source.kind === 'remote'
            && normalizeSourceUrl(source.value) === normalizeSourceUrl(LOCAL_AREA_NETWORK_SOURCE)) {
            state.headModifiers.localAreaNetwork = true;
            return;
        }

        const known = bucketForPolicy(policy);
        const builtinId = BUILTIN_BY_SOURCE.get(sourceLookupKey(source));

        if (builtinId && byId.has(builtinId)) {
            const card = byId.get(builtinId);
            // 灵活桶：组名认不出时按组名建组，卡片跟随
            card.bucket = known || 'flexible';

            // 小卡片被点亮时，其父卡片也跟到同一个桶，保持嵌套关系
            if (card.parentId && byId.has(card.parentId)) {
                const parent = byId.get(card.parentId);
                if (!touchedParents.has(parent.id)) {
                    parent.bucket = card.bucket;
                    touchedParents.add(parent.id);
                    // 灵活桶下组名即卡片名，用正文里的组名覆盖，保证再序列化一致
                    if (!known) parent.name = policy;
                }
            }
            return;
        }

        // 未知来源：按承接组归桶，或按组名聚成一张用户卡片
        const key = known ? `bucket:${known}` : `group:${policy}`;
        if (!userCards.has(key)) {
            sequence += 1;
            userCards.set(key, {
                id: `user-${sequence}`,
                name: known ? `${policy} 自定义` : policy,
                parentId: null,
                origin: 'user',
                bucket: known || 'flexible',
                order: sequence,
                sources: []
            });
        }
        sequence += 1;
        userCards.get(key).sources.push({ id: `r${sequence}`, ...source });
    });

    state.cards = [...userCards.values(), ...cards];
    return state;
}

/** 比较正文，用于漂移检测。忽略注释头、空行与行尾空白。 */
function bodyFingerprint(iniText) {
    return String(iniText || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith(';') && !line.startsWith('#'))
        .join('\n');
}

/** state 是否形状完整，用于挡住损坏或跨版本的注释头。 */
function looksLikeState(candidate) {
    return Boolean(candidate)
        && candidate.version === STATE_VERSION
        && candidate.base && typeof candidate.base === 'object'
        && Array.isArray(candidate.base.regions)
        && Array.isArray(candidate.cards);
}

/**
 * 主入口：INI → GeneratorState。
 *
 * @param {string} iniText 模板正文
 * @returns {{state: object, partial: boolean, drifted: boolean, source: string, warnings: string[]}}
 *   - `partial: true`  → 反推结果有损
 *   - `drifted: true`  → 注释头与正文不一致，**已以正文为准**
 */
export function parseIniToState(iniText) {
    const text = String(iniText || '');
    const warnings = [];

    if (!text.trim()) {
        return {
            state: createDefaultState(), partial: false, drifted: false,
            source: 'default', warnings: []
        };
    }

    const header = readStateHeader(text);

    if (looksLikeState(header)) {
        // 注释头与正文不同步时以正文为准，不静默覆盖用户的手改
        const expected = serializeState(header, { includeHeader: false }).ini;
        if (bodyFingerprint(expected) !== bodyFingerprint(text)) {
            warnings.push('模板正文与可视化状态不一致，可能在高级模式下手动改过。已按正文重新反推，手改的内容可能有损。');
            return { state: recoverFromBody(text), partial: true, drifted: true, source: 'body', warnings };
        }
        return { state: header, partial: false, drifted: false, source: 'header', warnings };
    }

    if (header) {
        warnings.push('可视化状态注释头无法识别（可能来自更高版本），已按正文反推。');
    } else {
        warnings.push('该模板没有可视化状态注释头，已按正文尽力反推，结果可能有损。');
    }

    return { state: recoverFromBody(text), partial: true, drifted: false, source: 'body', warnings };
}
