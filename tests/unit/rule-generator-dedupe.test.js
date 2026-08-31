import { describe, expect, it } from 'vitest';
import {
    normalizeSourceUrl,
    sourceKey,
    findSourceConflicts,
    removeSourceFromCard,
    resolveConflictKeepMine,
    resolveConflictDropSource,
    dedupeSourcesWithinCard,
    dedupeSourcesInCards
} from '../../src/utils/rule-generator/dedupe.js';

const ACL_TELEGRAM = 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/Telegram.list';

function builtinCard(id, name, urls) {
    return {
        id, name, origin: 'builtin', bucket: 'proxy', order: 0,
        sources: urls.map((value, index) => ({ id: `${id}-s${index + 1}`, kind: 'remote', value }))
    };
}

function userCard(id, name, urls) {
    return { ...builtinCard(id, name, urls), origin: 'user' };
}

describe('rule-generator dedupe', () => {
    it('URL 归一化：去尾斜杠、统一 host 大小写、剥离 query 与 fragment（§4.4）', () => {
        expect(normalizeSourceUrl('https://Example.COM/a.list/')).toBe('https://example.com/a.list');
        expect(normalizeSourceUrl('https://example.com/a.list?ref=1#frag')).toBe('https://example.com/a.list');
        expect(normalizeSourceUrl('HTTPS://EXAMPLE.com///')).toBe('https://example.com');
        expect(normalizeSourceUrl('  https://example.com/a.list  ')).toBe('https://example.com/a.list');
        expect(normalizeSourceUrl('')).toBe('');
        expect(normalizeSourceUrl(null)).toBe('');
    });

    it('path 大小写保留：raw.githubusercontent.com 区分大小写', () => {
        expect(normalizeSourceUrl('https://example.com/YouTube.list'))
            .not.toBe(normalizeSourceUrl('https://example.com/youtube.list'));
    });

    it('http 与 https 不视为等价 —— 超出「字面比对」的承诺', () => {
        expect(normalizeSourceUrl('http://example.com/a.list'))
            .not.toBe(normalizeSourceUrl('https://example.com/a.list'));
    });

    it('解析失败的串退化为去 query 与尾斜杠的原文', () => {
        expect(normalizeSourceUrl('not a url/x.list/')).toBe('not a url/x.list');
        expect(normalizeSourceUrl('foo?bar=1')).toBe('foo');
    });

    it('inline 来源按类型 + 值 + no-resolve 组合出键', () => {
        expect(sourceKey({ kind: 'inline', ruleType: 'domain-suffix', value: 'a.com' }))
            .toBe('inline:DOMAIN-SUFFIX:a.com:');
        expect(sourceKey({ kind: 'inline', ruleType: 'GEOIP', value: 'CN', noResolve: true }))
            .toBe('inline:GEOIP:CN:nr');
        // 类型不同即不同来源
        expect(sourceKey({ kind: 'inline', ruleType: 'DOMAIN', value: 'a.com' }))
            .not.toBe(sourceKey({ kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'a.com' }));
        // 残缺来源算不出键
        expect(sourceKey({ kind: 'inline', value: 'a.com' })).toBe('');
        expect(sourceKey({ kind: 'remote', value: '' })).toBe('');
        expect(sourceKey(null)).toBe('');
    });

    it('单条撞车：归一化后字面相同即报冲突，按输出顺序标出生效方', () => {
        const cards = [
            userCard('u1', '我的电报', [`${ACL_TELEGRAM}/`]),
            builtinCard('telegram', '📲 电报消息', [ACL_TELEGRAM])
        ];

        const conflicts = findSourceConflicts(cards);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].kind).toBe('remote');
        expect(conflicts[0].active).toBe(true);
        expect(conflicts[0].entries.map(entry => entry.cardId)).toEqual(['u1', 'telegram']);
        expect(conflicts[0].entries[0].cardName).toBe('我的电报');
    });

    it('去重在来源粒度生效：三 URL 的卡片只有一条撞车时其余保留（§4.4）', () => {
        const cards = [
            userCard('u1', '我的合集', [
                'https://example.com/a.list',
                ACL_TELEGRAM,
                'https://example.com/c.list'
            ]),
            builtinCard('telegram', '📲 电报消息', [ACL_TELEGRAM])
        ];

        const conflicts = findSourceConflicts(cards);
        expect(conflicts).toHaveLength(1);

        const kept = resolveConflictKeepMine(cards, conflicts[0], 'u1');
        expect(kept.find(item => item.id === 'u1').sources).toHaveLength(3);
        // 内置卡片仅此一条来源，清空后整卡移除
        expect(kept.find(item => item.id === 'telegram')).toBeUndefined();
        expect(findSourceConflicts(kept)).toHaveLength(0);
    });

    it('「保留我的」只从对方移除该来源，多来源内置卡片保留其余（§4.4）', () => {
        const cards = [
            userCard('u1', '我的广告', ['https://example.com/ad.list']),
            builtinCard('ad', '🚫 广告基础', ['https://example.com/ad.list', 'https://example.com/ad2.list'])
        ];

        const kept = resolveConflictKeepMine(cards, findSourceConflicts(cards)[0], 'u1');
        const builtin = kept.find(item => item.id === 'ad');
        expect(builtin.sources.map(source => source.value)).toEqual(['https://example.com/ad2.list']);
        expect(kept.find(item => item.id === 'u1').sources).toHaveLength(1);
    });

    it('「删除」只移除新卡片中的该来源，内置卡片不动（§4.4）', () => {
        const cards = [
            userCard('u1', '我的合集', ['https://example.com/a.list', ACL_TELEGRAM]),
            builtinCard('telegram', '📲 电报消息', [ACL_TELEGRAM])
        ];

        const dropped = resolveConflictDropSource(cards, findSourceConflicts(cards)[0], 'u1');
        expect(dropped.find(item => item.id === 'u1').sources.map(source => source.value))
            .toEqual(['https://example.com/a.list']);
        expect(dropped.find(item => item.id === 'telegram').sources).toHaveLength(1);
    });

    it('「删除」清空新卡片时整卡移除', () => {
        const cards = [
            userCard('u1', '只有一条', [ACL_TELEGRAM]),
            builtinCard('telegram', '📲 电报消息', [ACL_TELEGRAM])
        ];

        const dropped = resolveConflictDropSource(cards, findSourceConflicts(cards)[0], 'u1');
        expect(dropped.find(item => item.id === 'u1')).toBeUndefined();
        expect(dropped).toHaveLength(1);
    });

    it('多条撞车：同一张卡片的多条来源各自独立成冲突', () => {
        const cards = [
            userCard('u1', '我的合集', ['https://example.com/a.list', 'https://example.com/b.list']),
            builtinCard('b1', '内置A', ['https://example.com/a.list']),
            builtinCard('b2', '内置B', ['https://example.com/b.list'])
        ];

        const conflicts = findSourceConflicts(cards);
        expect(conflicts).toHaveLength(2);

        const resolved = conflicts.reduce((acc, conflict) => resolveConflictKeepMine(acc, conflict, 'u1'), cards);
        expect(resolved.map(item => item.id)).toEqual(['u1']);
        expect(findSourceConflicts(resolved)).toHaveLength(0);
    });

    it('留在待选栏（bucket off）的一方不构成生效冲突', () => {
        const cards = [
            userCard('u1', '我的电报', [ACL_TELEGRAM]),
            { ...builtinCard('telegram', '📲 电报消息', [ACL_TELEGRAM]), bucket: 'off' }
        ];

        const conflicts = findSourceConflicts(cards);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].active).toBe(false);
    });

    it('inline 来源同样参与冲突检测', () => {
        const inline = (id, value) => ({
            id, name: id, origin: 'user', bucket: 'proxy', order: 0,
            sources: [{ id: `${id}-s1`, kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value }]
        });

        const conflicts = findSourceConflicts([inline('a', 'x.com'), inline('b', 'x.com')]);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].kind).toBe('inline');
        expect(conflicts[0].value).toBe('DOMAIN-SUFFIX:x.com:');
    });

    it('同卡内重复来源不算冲突，由 dedupeSourcesWithinCard 静默去重（§6.2）', () => {
        const card = {
            id: 'u1', name: '我的', origin: 'user', bucket: 'proxy', order: 0,
            sources: [
                { id: 's1', kind: 'remote', value: 'https://example.com/a.list' },
                { id: 's2', kind: 'remote', value: 'https://example.com/a.list/' },
                { id: 's3', kind: 'remote', value: 'https://example.com/b.list' }
            ]
        };

        expect(findSourceConflicts([card])).toHaveLength(0);

        const deduped = dedupeSourcesWithinCard(card);
        expect(deduped.sources.map(source => source.id)).toEqual(['s1', 's3']);
        expect(card.sources).toHaveLength(3);          // 入参不被改动
    });

    it('同卡去重顺带剔除算不出键的残缺来源，但不自动删空卡', () => {
        const card = {
            id: 'u1', name: '我的', origin: 'user', bucket: 'proxy', order: 0,
            sources: [
                { id: 's1', kind: 'inline', value: 'a.com' },        // 缺 ruleType
                { id: 's2', kind: 'remote', value: '   ' }
            ]
        };

        const deduped = dedupeSourcesWithinCard(card);
        expect(deduped.sources).toEqual([]);
        expect(deduped.id).toBe('u1');                 // 卡片本身保留，交给 validate 提示
    });

    it('无重复时 dedupeSourcesWithinCard 返回原对象引用，不制造无谓的新对象', () => {
        const card = {
            id: 'u1', name: '我的', origin: 'user', bucket: 'proxy', order: 0,
            sources: [{ id: 's1', kind: 'remote', value: 'https://example.com/a.list' }]
        };
        expect(dedupeSourcesWithinCard(card)).toBe(card);
        expect(dedupeSourcesInCards([card])[0]).toBe(card);
    });

    it('removeSourceFromCard 不改动入参数组与其它卡片', () => {
        const cards = [
            userCard('u1', '我的', ['https://example.com/a.list', 'https://example.com/b.list']),
            builtinCard('b1', '内置', ['https://example.com/c.list'])
        ];
        const snapshot = JSON.stringify(cards);

        const next = removeSourceFromCard(cards, 'u1', 'u1-s1');
        expect(JSON.stringify(cards)).toBe(snapshot);
        expect(next.find(item => item.id === 'u1').sources.map(source => source.id)).toEqual(['u1-s2']);
        expect(next.find(item => item.id === 'b1')).toBe(cards[1]);
    });

    it('冲突参数缺失时各动作原样返回，不抛错', () => {
        const cards = [userCard('u1', '我的', ['https://example.com/a.list'])];
        expect(resolveConflictKeepMine(cards, null, 'u1')).toBe(cards);
        expect(resolveConflictDropSource(cards, null, 'u1')).toBe(cards);
        expect(resolveConflictDropSource(cards, { entries: [] }, 'nope')).toBe(cards);
        expect(findSourceConflicts()).toEqual([]);
        expect(findSourceConflicts([null, { id: 'x' }])).toEqual([]);
    });
});
