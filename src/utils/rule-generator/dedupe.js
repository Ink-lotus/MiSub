/**
 * 可视化规则生成器 —— 来源归一化与字面去重（PROJECT_PLAN_2.0 §4.4 / §6.2 / A4）
 *
 * 纯函数模块，无副作用、无 IO。所有导出函数都不改动入参，
 * 需要变更卡片集合的动作一律返回新数组。
 *
 * 能力边界：只做 URL **字面**比对。查不出内容级重叠（两个不同 URL 指向大量
 * 相同域名），那是 §十「未结缺口」明确接受的缺口，留给阶段 C3。
 * 同理，`Clash/Ruleset/X.list` 与其在 render-clash.js:82-92 下的重写目标
 * `Clash/Providers/Ruleset/X.yaml` 在此视为两个不同来源 —— 二者确实渲染成
 * 同一个 rule-provider，但识别这层等价属于内容级分析。
 */

/**
 * 归一化远程来源 URL（§4.4）。
 *
 * 三项归一化：统一 scheme/host 大小写、去尾斜杠、剥离 query。附带丢弃
 * fragment 与 userinfo。**path 大小写保留** —— raw.githubusercontent.com
 * 区分大小写，`YouTube.list` 与 `youtube.list` 不是同一个文件。
 *
 * 刻意不把 http 与 https 视为等价：那超出「字面比对」的承诺。
 *
 * @param {string} value 原始 URL
 * @returns {string} 归一化结果；解析失败时退化为去 query/尾斜杠的原串
 */
export function normalizeSourceUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';

    try {
        const url = new URL(raw);
        const scheme = url.protocol.toLowerCase();
        const host = url.host.toLowerCase();
        const path = url.pathname.replace(/\/+$/, '');
        return `${scheme}//${host}${path}`;
    } catch {
        return raw.replace(/[?#].*$/, '').replace(/\/+$/, '');
    }
}

/**
 * 计算来源的比对键。remote 走 URL 归一化，inline 按「类型 + 值 + no-resolve」
 * 组合，供同卡内静默去重与 validate.js 的跨桶遮蔽检查复用。
 *
 * @param {object} source CardSource
 * @returns {string} 比对键；无法计算时返回空串
 */
export function sourceKey(source) {
    if (!source || typeof source !== 'object') return '';

    if (source.kind === 'inline') {
        const type = String(source.ruleType || '').trim().toUpperCase();
        const value = String(source.value ?? '').trim();
        if (!type || !value) return '';
        return `inline:${type}:${value}:${source.noResolve ? 'nr' : ''}`;
    }

    const normalized = normalizeSourceUrl(source.value);
    return normalized ? `remote:${normalized}` : '';
}

function toConflictEntry(card, source) {
    return {
        cardId: card.id,
        cardName: card.name,
        origin: card.origin,
        bucket: card.bucket,
        sourceId: source.id
    };
}

/**
 * 按归一化键分组，找出落在多张卡片上的同一来源。
 *
 * 同时服务 §6.2 的两条校验：「URL 字面重复」（新卡片 vs 内置卡片）与
 * 「跨桶来源遮蔽」（用户把同一 URL 拖到两处）——底层是同一件事，
 * 差别只在 UI 何时提示，由 validate.js 判定 error 还是 warn。
 *
 * 同卡内的重复不计入冲突，那由 dedupeSourcesWithinCard 静默处理。
 *
 * @param {object[]} cards RuleCard 数组，顺序需与 §5.1 输出顺序一致
 * @returns {object[]} 冲突列表；`entries[0]` 是实际生效的那一条
 */
export function findSourceConflicts(cards = []) {
    const grouped = new Map();

    (Array.isArray(cards) ? cards : []).forEach(card => {
        if (!card || !Array.isArray(card.sources)) return;
        const seenInCard = new Set();

        card.sources.forEach(source => {
            const key = sourceKey(source);
            if (!key || seenInCard.has(key)) return;
            seenInCard.add(key);

            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(toConflictEntry(card, source));
        });
    });

    const conflicts = [];
    grouped.forEach((entries, key) => {
        if (entries.length < 2) return;
        conflicts.push({
            key,
            kind: key.startsWith('inline:') ? 'inline' : 'remote',
            value: key.replace(/^(?:remote|inline):/, ''),
            entries,
            // 双方都会产出规则时才是真冲突；有一侧留在待选栏只作提示
            active: entries.filter(entry => entry.bucket !== 'off').length >= 2
        });
    });

    return conflicts;
}

/**
 * 从指定卡片移除一条来源；`sources` 因此清空的卡片整卡移除（§4.4）。
 * 这是两个处理动作共用的唯一原语。
 *
 * @returns {object[]} 新的卡片数组
 */
export function removeSourceFromCard(cards = [], cardId, sourceId) {
    const next = [];

    (Array.isArray(cards) ? cards : []).forEach(card => {
        if (!card) return;
        if (card.id !== cardId) {
            next.push(card);
            return;
        }

        const sources = (Array.isArray(card.sources) ? card.sources : [])
            .filter(source => source && source.id !== sourceId);
        if (sources.length === 0) return;  // 整卡移除
        next.push({ ...card, sources });
    });

    return next;
}

/**
 * 「保留我的」（§4.4）：保留 winnerCardId 上的那条来源，从冲突涉及的其余
 * 每张卡片移除它。内置卡片被移空后整卡消失。
 */
export function resolveConflictKeepMine(cards = [], conflict, winnerCardId) {
    if (!conflict || !Array.isArray(conflict.entries)) return cards;

    return conflict.entries
        .filter(entry => entry.cardId !== winnerCardId)
        .reduce((acc, entry) => removeSourceFromCard(acc, entry.cardId, entry.sourceId), cards);
}

/**
 * 「删除」（§4.4）：只从 loserCardId 移除该来源，其余卡片不动。
 */
export function resolveConflictDropSource(cards = [], conflict, loserCardId) {
    if (!conflict || !Array.isArray(conflict.entries)) return cards;

    const entry = conflict.entries.find(item => item.cardId === loserCardId);
    return entry ? removeSourceFromCard(cards, entry.cardId, entry.sourceId) : cards;
}

/**
 * 同卡内重复来源静默去重（§6.2），保留首次出现的那一条。
 * 顺带剔除算不出比对键的残缺来源（空值、inline 缺 ruleType）。
 *
 * **不自动移除因此变空的卡片** —— 那是 validate.js 的「空来源卡片」提示项，
 * 静默删卡会让用户丢失刚建的卡片而无感。
 */
export function dedupeSourcesWithinCard(card) {
    if (!card || !Array.isArray(card.sources)) return card;

    const seen = new Set();
    const sources = card.sources.filter(source => {
        const key = sourceKey(source);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return sources.length === card.sources.length ? card : { ...card, sources };
}

/**
 * 对整个卡片集合逐卡做同卡内去重。
 */
export function dedupeSourcesInCards(cards = []) {
    return (Array.isArray(cards) ? cards : []).map(dedupeSourcesWithinCard);
}
