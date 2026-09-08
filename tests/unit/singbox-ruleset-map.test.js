import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toSingboxRuleSetUrl, getSingboxRuleSetFormat, getSingboxRuleSetCompatibility } from '../../shared/singbox-ruleset-map.js';
import { PINNED_RULE_REVISIONS, pinRemoteRuleUrl } from '../../functions/modules/subscription/builtin-rules-provider.js';
import { BUILTIN_CARDS, LOCAL_AREA_NETWORK_SOURCE } from '../../src/utils/rule-generator/catalog.js';
import { renderSingboxFromIniTemplate } from '../../functions/modules/subscription/template-pipeline.js';
import { renderSingboxFromTemplateModel } from '../../functions/modules/subscription/template-renderers/render-singbox.js';

const ACL = 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/';
const ORIGIN = 'https://misub.example';
const REVISION = PINNED_RULE_REVISIONS.ACL4SSR;
const ANTI = 'https://raw.githubusercontent.com/privacy-protection-tools/anti-AD/master/anti-ad-surge.txt';
const ANTI_TARGET = 'https://raw.githubusercontent.com/privacy-protection-tools/anti-ad.github.io/master/docs/anti-ad-sing-box.srs';
const AWA = 'https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-Surge-RULE-SET.list';
const AWA_TARGET = 'https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-Singbox.json';

function render(urls, managedConfigUrl = `${ORIGIN}/sub/example?token=secret`) {
    return JSON.parse(renderSingboxFromIniTemplate([
        '[Rule]', ...urls.map(url => `RULE-SET,${url},DIRECT`), 'FINAL,DIRECT'
    ].join('\n'), { managedConfigUrl, ruleLevel: 'none', dnsThroughProxy: false }));
}

describe('sing-box source mapping', () => {
    it.each([
        [`${ACL}LocalAreaNetwork.list`, `LocalAreaNetwork.json`],
        [`${ACL}Ruleset/Claude.list?download=1#v1`, 'Ruleset/Claude.json'],
        [`${ACL.replace('master', REVISION)}Ruleset/Claude.list`, 'Ruleset/Claude.json']
    ])('maps known source %s to its versioned hosted asset', (url, file) => {
        expect(toSingboxRuleSetUrl(url, { origin: `${ORIGIN}/sub/path?token=private` }))
            .toBe(`${ORIGIN}/rulesets/singbox/${REVISION}/${file}`);
    });

    it.each([
        `${ACL}Ruleset/NotInCatalog.list`,
        'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/toString',
        `${ACL.replace('raw.githubusercontent.com', 'evilraw.githubusercontent.com')}Ruleset/Claude.list`,
        `${ACL.replace('raw.githubusercontent.com', 'raw.githubusercontent.com.evil.test')}Ruleset/Claude.list`,
        `${ACL.replace('https:', 'ftp:')}Ruleset/Claude.list`,
        `${ACL.replace('raw.githubusercontent.com', 'raw.githubusercontent.com:8443')}Ruleset/Claude.list`,
        `${ACL.replace('ACL4SSR/ACL4SSR', 'someone/ACL4SSR')}Ruleset/Claude.list`,
        `${ACL}Ruleset/%2e%2e/NotInCatalog.list`,
        'https://user.example/custom.list',
        'not a URL'
    ])('does not invent hosted assets for %s', url => {
        expect(toSingboxRuleSetUrl(url, { origin: ORIGIN })).toBeNull();
    });

    it.each([undefined, '', 'invalid', 'file:///tmp/test', 'javascript:alert(1)'])('requires a usable HTTP origin: %s', origin => {
        expect(toSingboxRuleSetUrl(`${ACL}Ruleset/Claude.list`, { origin })).toBeNull();
    });

    it.each([[ANTI, ANTI_TARGET, 'binary'], [AWA, AWA_TARGET, 'source']])('uses the official ad artifact for %s', (source, target, format) => {
        expect(toSingboxRuleSetUrl(source)).toBe(target);
        expect(pinRemoteRuleUrl(target)).toBe(target);
        const config = render([source]);
        expect(config.route.rule_set.find(rule => rule.tag === source)).toMatchObject({ url: target, format });
    });

    it('preserves a user-selected historical ad source instead of replacing it with master', () => {
        expect(toSingboxRuleSetUrl(ANTI.replace('/master/', '/custom-revision/'))).toBeNull();
    });

    it.each([
        ['https://example.com/file.srs?download=1#latest', 'binary'],
        ['https://example.com/FILE.SRS', 'binary'],
        ['https://example.com/rules.json?name=other.srs', 'source'],
        ['https://example.com/list', 'source']
    ])('detects the pathname format of %s', (url, format) => {
        expect(getSingboxRuleSetFormat(url)).toBe(format);
        expect(render([url]).route.rule_set.find(rule => rule.tag === url).format).toBe(format);
    });

    it('keeps canonical URL tags and cross-policy references after remapping downloads', () => {
        const source = `${ACL}Ruleset/Claude.list`;
        const tag = `${ACL.replace('master', REVISION)}Ruleset/Claude.list`;
        const config = JSON.parse(renderSingboxFromIniTemplate(`[Rule]\nRULE-SET,${source},DIRECT\nRULE-SET,${tag},REJECT\nFINAL,DIRECT`, {
            managedConfigUrl: `${ORIGIN}/sub/token`, ruleLevel: 'none', dnsThroughProxy: false
        }));
        expect(config.route.rule_set.filter(rule => rule.tag === tag)).toHaveLength(1);
        expect(config.route.rule_set.find(rule => rule.tag === tag).url).toBe(`${ORIGIN}/rulesets/singbox/${REVISION}/Ruleset/Claude.json`);
        expect(config.route.rules).toEqual([
            { rule_set: [tag], outbound: 'DIRECT' }, { rule_set: [tag], action: 'reject' }
        ]);
    });

    it.each(['', 'invalid', 'file:///tmp/config'])('preserves the existing fallback without a managed origin: %s', managed => {
        const tag = `${ACL.replace('master', REVISION)}Ruleset/Claude.list`;
        expect(render([`${ACL}Ruleset/Claude.list`], managed).route.rule_set.find(rule => rule.tag === tag).url).toBe(tag);
    });

    it('accepts a managed URL stored in model settings', () => {
        const config = JSON.parse(renderSingboxFromTemplateModel({
            settings: { managedConfigUrl: `${ORIGIN}/sub/demo`, dnsThroughProxy: false },
            rules: [{ type: 'rule-set', value: `${ACL}Ruleset/Claude.list`, policy: 'DIRECT' }]
        }));
        expect(config.route.rule_set.some(rule => rule.url === `${ORIGIN}/rulesets/singbox/${REVISION}/Ruleset/Claude.json`)).toBe(true);
    });

    it('preserves unknown URLs without leaking the managed token into them', () => {
        const url = 'https://custom.example/rules.list?key=original';
        expect(render([url]).route.rule_set.find(rule => rule.tag === url).url).toBe(url);
    });

    it.each([
        [`${ACL}Ruleset/Claude.list`, 'converted'],
        [`${ACL}Download.list`, 'partial'],
        [ANTI, 'native'], [AWA, 'native'],
        ['https://user.example/rules.json?download=1', 'native'],
        ['https://user.example/rules.srs#latest', 'native'],
        ['https://user.example/rules.txt', 'text'],
        [`${ACL}Ruleset/NotInCatalog.list`, 'text'],
        ['https://user.example/rules', 'unknown']
    ])('classifies compatibility from the actual source %s', (url, status) => {
        expect(getSingboxRuleSetCompatibility(url)).toBe(status);
    });

    it('ships a valid, hash-verified asset for every catalog ACL source at the current revision', async () => {
        const manifestPath = '../../shared/singbox-ruleset-manifest.js';
        const { SINGBOX_RULESET_MANIFEST: manifest } = await import(manifestPath);
        const sources = [...new Set([LOCAL_AREA_NETWORK_SOURCE, ...BUILTIN_CARDS.flatMap(card =>
            card.sources.filter(source => source.kind === 'remote' && source.value.startsWith(ACL)).map(source => source.value))])];
        expect(manifest.revision).toBe(REVISION);
        expect(Object.keys(manifest.files)).toHaveLength(sources.length);
        for (const source of sources) {
            const file = source.slice(ACL.length).replace(/\.list$/, '.json');
            const url = `${ORIGIN}/rulesets/singbox/${REVISION}/${file}`;
            const config = render([source]);
            expect(config.route.rule_set.find(rule => rule.tag === pinRemoteRuleUrl(source))).toMatchObject({ url, format: 'source' });
            const bytes = readFileSync(resolve('public/rulesets/singbox', REVISION, file));
            const content = JSON.parse(bytes);
            expect(content.version).toBe(1);
            expect(content.rules.length).toBeGreaterThan(0);
            const entry = manifest.files[`Clash/${source.slice(ACL.length)}`];
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.outputSha256);
            expect(content.rules.every(rule => Object.keys(rule).length === 1 && Object.values(rule)[0].length > 0)).toBe(true);
            expect(content.rules.reduce((sum, rule) => sum + Object.values(rule)[0].length, 0)).toBe(entry.converted);
        }
    });
});
