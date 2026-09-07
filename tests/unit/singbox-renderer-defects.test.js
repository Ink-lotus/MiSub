import { describe, expect, it, vi } from 'vitest';
import { renderSingboxFromIniTemplate } from '../../functions/modules/subscription/template-pipeline.js';
import { renderSingboxFromTemplateModel } from '../../functions/modules/subscription/template-renderers/render-singbox.js';

function renderRules(lines, groups = []) {
    return JSON.parse(renderSingboxFromIniTemplate([
        '[Proxy Group]', ...groups, '[Rule]', ...lines
    ].join('\n'), { ruleLevel: 'none', dnsThroughProxy: false }));
}

describe('sing-box reject policies', () => {
    it.each([
        ['REJECT', { action: 'reject' }],
        ['REJECT-DROP', { action: 'reject', method: 'drop' }]
    ])('preserves the %s action on a matching rule', (policy, action) => {
        const config = renderRules([`DOMAIN-SUFFIX,blocked.example,${policy}`, 'MATCH,DIRECT']);
        expect(config.route.rules).toEqual([{ domain_suffix: ['blocked.example'], ...action }]);
    });

    it('resolves nested reject-first groups before pruning their members', () => {
        const config = renderRules([
            'DOMAIN-SUFFIX,blocked.example,Outer',
            'DOMAIN-SUFFIX,allowed.example,Allow',
            'MATCH,DIRECT'
        ], ['Outer = select, Inner, DIRECT', 'Inner = select, REJECT', 'Allow = select, DIRECT, REJECT']);

        expect(config.route.rules).toEqual([
            { domain_suffix: ['blocked.example'], action: 'reject' },
            { domain_suffix: ['allowed.example'], outbound: 'Allow' }
        ]);
        const groups = config.outbounds.filter(outbound => outbound.outbounds);
        expect(groups.map(group => group.tag)).not.toContain('Inner');
        expect(groups.find(group => group.tag === 'Outer')).toMatchObject({ outbounds: ['DIRECT'], default: 'DIRECT' });
        const tags = new Set(config.outbounds.map(outbound => outbound.tag));
        groups.forEach(group => group.outbounds.forEach(member => expect(tags.has(member)).toBe(true)));
    });

    it('keeps a nested REJECT-DROP policy when rendering a model directly', () => {
        const config = JSON.parse(renderSingboxFromTemplateModel({
            groups: [
                { name: 'Outer', type: 'select', members: ['Drop', 'DIRECT'] },
                { name: 'Drop', type: 'select', members: ['REJECT-DROP'] }
            ],
            rules: [
                { type: 'domain-suffix', value: 'blocked.example', policy: 'Outer' },
                { type: 'final', policy: 'DIRECT' }
            ],
            settings: { dnsThroughProxy: false }
        }));
        expect(config.route.rules).toEqual([
            { domain_suffix: ['blocked.example'], action: 'reject', method: 'drop' }
        ]);
        expect(config.outbounds.find(outbound => outbound.tag === 'Outer').outbounds).toEqual(['DIRECT']);
    });

    it('preserves REJECT-DROP group members through the INI processor', () => {
        const config = renderRules(['DOMAIN-SUFFIX,blocked.example,Drop', 'FINAL,DIRECT'], [
            'Drop = select, REJECT-DROP, DIRECT'
        ]);
        expect(config.route.rules).toEqual([
            { domain_suffix: ['blocked.example'], action: 'reject', method: 'drop' }
        ]);
    });

    it('fails explicitly if pruning removes the required DNS proxy group', () => {
        expect(() => renderSingboxFromIniTemplate('[Rule]\nFINAL,DIRECT', {
            ruleLevel: 'none', dnsThroughProxy: true
        })).toThrow(/DNS.*outbound/i);
    });

    it('does not emit empty urltest groups or a selector-only default on urltest', () => {
        const config = JSON.parse(renderSingboxFromTemplateModel({
            proxies: [{ name: 'Node', type: 'trojan', server: '1.2.3.4', port: 443, password: 'p' }],
            groups: [
                { name: 'Auto', type: 'url-test', members: ['Node'] },
                { name: 'Empty', type: 'url-test', members: ['REJECT'] },
                { name: 'Select', type: 'select', members: ['Auto', 'Empty'] }
            ],
            rules: [{ type: 'domain-suffix', value: 'blocked.example', policy: 'Empty' }],
            settings: { dnsThroughProxy: false }
        }));
        expect(config.outbounds.find(outbound => outbound.tag === 'Auto')).not.toHaveProperty('default');
        expect(config.outbounds.find(outbound => outbound.tag === 'Empty')).toBeUndefined();
        expect(config.outbounds.find(outbound => outbound.tag === 'Select').outbounds).toEqual(['Auto']);
        expect(config.route.rules).toEqual([{ domain_suffix: ['blocked.example'], action: 'reject' }]);
    });

    it('excludes reject-first selectors from automatic routing candidates', () => {
        const config = JSON.parse(renderSingboxFromTemplateModel({
            proxies: [{ name: 'Node', type: 'trojan', server: '1.2.3.4', port: 443, password: 'p' }],
            groups: [
                { name: 'Auto', type: 'url-test', members: ['Outer', 'Node'] },
                { name: 'Outer', type: 'select', members: ['Block', 'DIRECT'] },
                { name: 'Block', type: 'select', members: ['REJECT', 'DIRECT'] }
            ],
            rules: [{ type: 'final', policy: 'Auto' }],
            settings: { dnsThroughProxy: false }
        }));
        expect(config.outbounds.find(outbound => outbound.tag === 'Auto').outbounds).toEqual(['Node']);
        expect(config.route.final).toBe('Auto');
    });

    it('preserves rejection when all automatic candidates default to reject', () => {
        const config = renderRules(['FINAL,Auto'], [
            'Auto = url-test, Block',
            'Block = select, REJECT-DROP, DIRECT'
        ]);
        expect(config.outbounds.find(outbound => outbound.tag === 'Auto')).toBeUndefined();
        expect(config.route.rules).toEqual([{ action: 'reject', method: 'drop' }]);
    });
});

describe('sing-box final rules', () => {
    it('uses the first FINAL target and does not activate previously unreachable rules', () => {
        const config = renderRules([
            'DOMAIN-SUFFIX,first.example,DIRECT',
            'FINAL,DIRECT',
            'DOMAIN-SUFFIX,unreachable.example,REJECT',
            'MATCH,Other'
        ], ['Other = select, DIRECT']);
        expect(config.route.final).toBe('DIRECT');
        expect(config.route.rules).toEqual([{ domain_suffix: ['first.example'], outbound: 'DIRECT' }]);
    });

    it('represents a rejecting FINAL as a terminal action, not a missing outbound', () => {
        const config = renderRules(['DOMAIN-SUFFIX,allowed.example,DIRECT', 'FINAL,Block'], ['Block = select, REJECT']);
        expect(config.route.rules).toEqual([
            { domain_suffix: ['allowed.example'], outbound: 'DIRECT' },
            { action: 'reject' }
        ]);
        expect(config.outbounds.some(outbound => outbound.tag === config.route.final)).toBe(true);
    });

    it('retains first-group fallback when there is no explicit final rule', () => {
        expect(renderRules([], ['Primary = select, DIRECT']).route.final).toBe('Primary');
        expect(renderRules([]).route.final).toBe('DIRECT');
    });

    it.each([
        ['explicit final', ['FINAL,Auto'], 'Auto'],
        ['ordinary rule', ['DOMAIN,example.com,Parent', 'FINAL,DIRECT'], 'Parent'],
        ['implicit final', [], 'Auto']
    ])('fails explicitly for a pruned non-reject group used by an %s', (_name, rules, policy) => {
        expect(() => renderRules(rules, [
            'Auto = url-test, DIRECT',
            'Parent = select, Auto',
            'Other = select, DIRECT'
        ])).toThrow(new RegExp(`${policy}.*no usable outbound`, 'i'));
    });

    it('fails explicitly when a direct model references an initially empty group', () => {
        expect(() => renderSingboxFromTemplateModel({
            groups: [{ name: 'Empty', type: 'select', members: [] }],
            rules: [{ type: 'final', policy: 'Empty' }],
            settings: { dnsThroughProxy: false }
        })).toThrow(/Empty.*no usable outbound/i);
    });
});

describe('sing-box remote declarations', () => {
    it('pins URLs identically for Rule and ruleset= declarations', () => {
        const config = JSON.parse(renderSingboxFromIniTemplate([
            '[Rule]',
            'RULE-SET,https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-apple.srs,DIRECT',
            '[custom]',
            'ruleset=REJECT,https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-apple.srs',
            'ruleset=DIRECT,[]FINAL'
        ].join('\n'), { ruleLevel: 'none', dnsThroughProxy: false }));
        const apple = config.route.rule_set.filter(ruleSet => ruleSet.url.endsWith('/geosite-apple.srs'));
        expect(apple).toHaveLength(1);
        expect(config.route.rules.map(rule => rule.rule_set)).toEqual([[apple[0].tag], [apple[0].tag]]);
        expect(apple[0].url).not.toContain('/rule-set/');
    });

    it('deduplicates repeated ruleset= URLs even across different policies', () => {
        const config = JSON.parse(renderSingboxFromIniTemplate([
            '[custom]',
            'ruleset=DIRECT,https://example.com/shared.json',
            'ruleset=REJECT,https://example.com/shared.json',
            'ruleset=DIRECT,https://example.com/shared.json',
            'ruleset=DIRECT,[]FINAL'
        ].join('\n'), { ruleLevel: 'none', dnsThroughProxy: false }));
        const definitions = config.route.rule_set.filter(ruleSet => ruleSet.url === 'https://example.com/shared.json');
        expect(definitions).toHaveLength(1);
        expect(config.route.rules.map(rule => rule.rule_set)).toEqual(Array(3).fill([definitions[0].tag]));
        expect(config.route.rules[1]).toEqual({ rule_set: [definitions[0].tag], action: 'reject' });
    });

    it.each(['local-name', 'ftp://example.com/rules.json', 'https://'])('fails explicitly on an undeclarable rule set: %s', value => {
        expect(() => renderRules([`RULE-SET,${value},DIRECT`])).toThrow(/rule.set/i);
    });
});

describe('sing-box inline validation', () => {
    it.each(['', '   ', null])('rejects empty DST-PORT %s in a direct model', value => {
        expect(() => renderSingboxFromTemplateModel({
            rules: [{ type: 'dst-port', value, policy: 'DIRECT' }],
            settings: { dnsThroughProxy: false }
        })).toThrow(/DST-PORT/i);
    });

    it.each([0, 1, 65535])('preserves numeric DST-PORT boundary %s', port => {
        expect(renderRules([`DST-PORT,${port},DIRECT`]).route.rules).toEqual([{ port: [port], outbound: 'DIRECT' }]);
    });

    it.each(['abc', '-1', '65536', '1.5', '80:90'])('rejects invalid DST-PORT %s instead of emitting null or dropping the rule', value => {
        expect(() => renderRules([`DST-PORT,${value},DIRECT`])).toThrow(/DST-PORT/i);
    });

    it('warns when an unsupported rule type is skipped', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const config = renderRules(['URL-REGEX,unsupported,DIRECT']);
            expect(config.route.rules).toEqual([]);
            expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unsupported.*url-regex/i));
        } finally {
            warn.mockRestore();
        }
    });
});
