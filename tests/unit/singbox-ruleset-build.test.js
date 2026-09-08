import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { convertRuleList, getAclSources, buildRuleSetArtifacts } from '../../scripts/build-singbox-rulesets.mjs';
import { PINNED_RULE_REVISIONS } from '../../functions/modules/subscription/builtin-rules-provider.js';

function snapshot() {
    const bytes = Buffer.from('DOMAIN,fixture.example\n');
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    return {
        revision: PINNED_RULE_REVISIONS.ACL4SSR,
        files: getAclSources().map(source => ({
            path: source.sourcePath, sha, size: bytes.length,
            encoding: 'base64', content: bytes.toString('base64')
        }))
    };
}

describe('sing-box list conversion', () => {
    it('keeps independent matches as OR alternatives, including different dimensions', () => {
        const result = convertRuleList([
            'DOMAIN,exact.example',
            'DOMAIN-SUFFIX,example.org',
            'DOMAIN-KEYWORD,advert',
            'IP-CIDR,192.0.2.0/24,no-resolve',
            'IP-CIDR6,2001:db8::/32,no-resolve',
            'PROCESS-NAME,Example Client.exe',
            'DST-PORT,443'
        ].join('\n'));
        expect(result.ruleSet).toEqual({ version: 1, rules: [
            { domain: ['exact.example'] },
            { domain_suffix: ['example.org'] },
            { domain_keyword: ['advert'] },
            { ip_cidr: ['192.0.2.0/24', '2001:db8::/32'] },
            { process_name: ['Example Client.exe'] },
            { port: [443] }
        ] });
        expect(result.converted).toBe(7);
        expect(result.skipped).toEqual({});
    });

    it('accepts BOM, CRLF, whitespace, comments and repeated no-resolve', () => {
        const result = convertRuleList('\uFEFF# header\r\n; comment\r\n// comment\r\n\r\n DOMAIN , test.example \r\nIP-CIDR,192.0.2.0/24,no-resolve,no-resolve\r\n');
        expect(result.ruleSet.rules).toEqual([
            { domain: ['test.example'] }, { ip_cidr: ['192.0.2.0/24'] }
        ]);
    });

    it('reports unsupported match types without creating an empty match-all rule', () => {
        const result = convertRuleList('DOMAIN,keep.example\nURL-REGEX,^https://ads\\.example/,test\nUSER-AGENT,Example*\nUSER-AGENT,Other*');
        expect(result.ruleSet.rules).toEqual([{ domain: ['keep.example'] }]);
        expect(result.skipped).toEqual({ 'URL-REGEX': 1, 'USER-AGENT': 2 });
    });

    it('groups only the same match dimension to keep large lists efficient without introducing AND', () => {
        const result = convertRuleList('DOMAIN,one.example\nPROCESS-NAME,client.exe\nDOMAIN,two.example\nDST-PORT,443\nPROCESS-NAME,other.exe');
        expect(result.ruleSet.rules).toEqual([
            { domain: ['one.example', 'two.example'] },
            { process_name: ['client.exe', 'other.exe'] },
            { port: [443] }
        ]);
        expect(result.converted).toBe(5);
    });

    it.each([
        ['NEW-RULE,example.com', /line 2.*NEW-RULE/i],
        ['CONSTRUCTOR,example.com', /line 2.*CONSTRUCTOR/i],
        ['__proto__,example.com', /line 2.*__proto__/i],
        ['DOMAIN,', /line 2.*empty/i],
        ['DOMAIN,example.org,REJECT', /line 2.*modifier/i],
        ['DOMAIN,one.example DOMAIN,two.example', /line 2/i],
        ['IP-CIDR,999.0.0.1/24', /line 2.*IP-CIDR/i],
        ['IP-CIDR,192.0.2.0/33', /line 2.*IP-CIDR/i],
        ['IP-CIDR,192.0.2.0/024', /line 2.*IP-CIDR/i],
        ['IP-CIDR6,::/00', /line 2.*IP-CIDR6/i],
        ['IP-CIDR6,2001:db8::/129', /line 2.*IP-CIDR6/i],
        ['IP-CIDR6,fe80::1%25eth0/64', /line 2.*IP-CIDR6/i],
        ['DST-PORT,65536', /line 2.*DST-PORT/i],
        ['DST-PORT,1.5', /line 2.*DST-PORT/i],
        ['DST-PORT,443oops', /line 2.*DST-PORT/i]
    ])('fails the entire source on malformed or unknown input: %s', (line, error) => {
        expect(() => convertRuleList(`DOMAIN,valid.example\n${line}`)).toThrow(error);
    });

    it.each(['', '# nothing', 'URL-REGEX,^https://ads.example'])('rejects an empty converted ruleset: %s', text => {
        expect(() => convertRuleList(text)).toThrow(/no supported rules/i);
    });
});

describe('offline rule-set artifacts', () => {
    it('discovers unique pinned catalog sources including the standalone LAN list', () => {
        const sources = getAclSources();
        expect(sources.map(source => source.sourcePath)).toContain('Clash/LocalAreaNetwork.list');
        expect(sources.map(source => source.sourcePath)).toContain('Clash/Ruleset/Claude.list');
        expect(new Set(sources.map(source => source.sourcePath)).size).toBe(sources.length);
        expect(sources.every(source => source.sourceUrl.includes(PINNED_RULE_REVISIONS.ACL4SSR))).toBe(true);
    });

    it('builds deterministic versioned artifacts with source and output hashes', () => {
        const input = snapshot();
        const result = buildRuleSetArtifacts(input);
        const entry = result.manifest.files['Clash/Ruleset/Claude.list'];
        expect(entry.path).toBe(`rulesets/singbox/${PINNED_RULE_REVISIONS.ACL4SSR}/Ruleset/Claude.json`);
        const artifact = result.artifacts.find(file => file.path === entry.path);
        expect(JSON.parse(artifact.content)).toEqual({ version: 1, rules: [{ domain: ['fixture.example'] }] });
        expect(entry.sourceSha256).toBe(createHash('sha256').update('DOMAIN,fixture.example\n').digest('hex'));
        expect(entry.outputSha256).toBe(createHash('sha256').update(artifact.content).digest('hex'));
        expect(result.manifest.revision).toBe(PINNED_RULE_REVISIONS.ACL4SSR);
        expect(result.artifacts).toHaveLength(input.files.length);
        expect(buildRuleSetArtifacts({ ...input, files: [...input.files].reverse() })).toEqual(result);
    });

    it.each([
        ['revision', input => { input.revision = 'different'; }, /revision/i],
        ['missing file', input => { input.files.pop(); }, /missing/i],
        ['corrupt bytes', input => { input.files[0].content = Buffer.from('DOMAIN,tampered.example').toString('base64'); }, /hash|size/i],
        ['corrupt hash', input => { input.files[0].sha = '0'.repeat(40); }, /hash/i],
        ['duplicate file', input => { input.files.push(input.files[0]); }, /duplicate/i],
        ['unknown path', input => { input.files.push({ ...input.files[0], path: '../escape.list' }); }, /unexpected/i]
    ])('rejects %s before returning any publishable artifacts', (_, mutate, error) => {
        const input = snapshot();
        mutate(input);
        expect(() => buildRuleSetArtifacts(input)).toThrow(error);
    });
});
