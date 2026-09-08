import { SINGBOX_RULESET_MANIFEST } from './singbox-ruleset-manifest.js';

const AD_SOURCES = new Map([
    ['/privacy-protection-tools/anti-AD/master/anti-ad-surge.txt',
        'https://raw.githubusercontent.com/privacy-protection-tools/anti-ad.github.io/master/docs/anti-ad-sing-box.srs'],
    ['/TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-Surge-RULE-SET.list',
        'https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-Singbox.json']
]);

function parseHttpUrl(value) {
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) ? url : null;
    } catch {
        return null;
    }
}

function knownSource(url) {
    if (!url || url.hostname !== 'raw.githubusercontent.com' || url.port || url.username || url.password) return {};
    const officialUrl = AD_SOURCES.get(url.pathname);
    if (officialUrl) return { officialUrl };
    const [owner, repo, , ...parts] = url.pathname.slice(1).split('/');
    if (`${owner}/${repo}`.toLowerCase() !== 'acl4ssr/acl4ssr') return {};
    const sourcePath = parts.join('/');
    return { artifact: Object.hasOwn(SINGBOX_RULESET_MANIFEST.files, sourcePath)
        ? SINGBOX_RULESET_MANIFEST.files[sourcePath] : null };
}

export function toSingboxRuleSetUrl(sourceUrl, { origin } = {}) {
    const { officialUrl, artifact } = knownSource(parseHttpUrl(sourceUrl));
    if (officialUrl) return officialUrl;
    const site = parseHttpUrl(origin);
    return artifact && site ? new URL(`/${artifact.path}`, site.origin).toString() : null;
}

export function getSingboxRuleSetFormat(sourceUrl) {
    return parseHttpUrl(sourceUrl)?.pathname.toLowerCase().endsWith('.srs') ? 'binary' : 'source';
}

export function getSingboxRuleSetCompatibility(sourceUrl) {
    const url = parseHttpUrl(sourceUrl);
    const { officialUrl, artifact } = knownSource(url);
    if (officialUrl) return 'native';
    if (artifact) return Object.values(artifact.skipped).some(count => count > 0) ? 'partial' : 'converted';
    const pathname = url?.pathname || '';
    if (/\.(json|srs)$/i.test(pathname)) return 'native';
    return /\.(list|txt)$/i.test(pathname) ? 'text' : 'unknown';
}
