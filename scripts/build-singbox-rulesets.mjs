import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BUILTIN_CARDS, LOCAL_AREA_NETWORK_SOURCE } from '../src/utils/rule-generator/catalog.js';
import { PINNED_RULE_REVISIONS, pinRemoteRuleUrl } from '../functions/modules/subscription/builtin-rules-provider.js';
import { toSingboxHeadlessRule } from '../shared/singbox-rule.js';

const UNSUPPORTED_TYPES = new Set(['USER-AGENT', 'URL-REGEX']);

export function getAclSources() {
    const urls = [LOCAL_AREA_NETWORK_SOURCE, ...BUILTIN_CARDS.flatMap(card =>
        card.sources.filter(source => source.kind === 'remote').map(source => source.value))];
    const sources = new Map();
    for (const value of urls) {
        const url = new URL(pinRemoteRuleUrl(value));
        if (url.hostname !== 'raw.githubusercontent.com') continue;
        const [owner, repo, , ...parts] = url.pathname.slice(1).split('/');
        if (`${owner}/${repo}`.toLowerCase() !== 'acl4ssr/acl4ssr') continue;
        const sourcePath = parts.join('/');
        if (!/^Clash\/(?:Ruleset\/)?[\w.-]+\.list$/.test(sourcePath)) {
            throw new Error(`Unexpected catalog ACL4SSR path: ${sourcePath}`);
        }
        sources.set(sourcePath, { sourceUrl: url.toString(), sourcePath });
    }
    return [...sources.values()].sort((a, b) => a.sourcePath < b.sourcePath ? -1 : 1);
}

export function buildRuleSetArtifacts(snapshot) {
    const revision = PINNED_RULE_REVISIONS.ACL4SSR;
    if (snapshot?.revision !== revision) throw new Error('Source revision does not match pinned ACL4SSR revision');
    const sources = getAclSources();
    const expected = new Set(sources.map(source => source.sourcePath));
    const files = new Map();
    for (const file of snapshot.files || []) {
        if (!expected.has(file.path)) throw new Error(`Unexpected source path: ${file.path}`);
        if (files.has(file.path)) throw new Error(`Duplicate source: ${file.path}`);
        files.set(file.path, file);
    }
    const manifest = { revision, files: {} };
    const artifacts = [];
    for (const source of sources) {
        const file = files.get(source.sourcePath);
        if (!file) throw new Error(`Missing source: ${source.sourcePath}`);
        if (file.encoding !== 'base64') throw new Error(`Unsupported source encoding: ${source.sourcePath}`);
        const bytes = Buffer.from(file.content, 'base64');
        const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (bytes.length !== file.size || blobSha !== file.sha) {
            throw new Error(`Source size/hash mismatch: ${source.sourcePath}`);
        }
        let result;
        try {
            result = convertRuleList(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch (error) {
            throw new Error(`${source.sourcePath}: ${error.message}`);
        }
        const outputPath = `rulesets/singbox/${revision}/${source.sourcePath.slice('Clash/'.length).replace(/\.list$/, '.json')}`;
        const content = `${JSON.stringify(result.ruleSet, null, 2)}\n`;
        manifest.files[source.sourcePath] = {
            path: outputPath,
            sourceSha256: createHash('sha256').update(bytes).digest('hex'),
            outputSha256: createHash('sha256').update(content).digest('hex'),
            converted: result.converted,
            skipped: result.skipped
        };
        artifacts.push({ path: outputPath, content });
    }
    return { manifest, artifacts };
}

export function convertRuleList(text) {
    const fields = new Map();
    let converted = 0;
    const skipped = {};
    const lines = String(text).split(/\r\n?|\n/);
    for (const [index, rawLine] of lines.entries()) {
        const line = rawLine.trim();
        if (!line || /^(#|;|\/\/)/.test(line)) continue;
        const [rawType, value = '', ...modifiers] = line.split(',').map(part => part.trim());
        const type = rawType.toUpperCase();
        const fail = message => { throw new Error(`line ${index + 1}: ${message}`); };
        if (UNSUPPORTED_TYPES.has(type)) {
            skipped[type] = (skipped[type] || 0) + 1;
            continue;
        }
        if (!value) fail(`${type} has an empty value`);
        if (modifiers.some(modifier => modifier.toLowerCase() !== 'no-resolve')) {
            fail(`${type} has an unsupported modifier`);
        }
        if (type === 'IP-CIDR' || type === 'IP-CIDR6') {
            const [address, prefix, ...extra] = value.split('/');
            const version = type === 'IP-CIDR' ? 4 : 6;
            if (extra.length || address.includes('%') || isIP(address) !== version || !/^(0|[1-9]\d*)$/.test(prefix || '')
                || Number(prefix) > (version === 4 ? 32 : 128)) {
                fail(`Invalid ${type}: ${value}`);
            }
        } else if (type.startsWith('DOMAIN') && /\s/.test(value)) {
            fail(`Invalid ${type}: whitespace in domain`);
        }
        let rule;
        try {
            rule = toSingboxHeadlessRule(type, value);
        } catch (error) {
            fail(error.message);
        }
        if (!rule) fail(`Unsupported rule type: ${type}`);
        // Group only identical dimensions: combining process/port with domains would introduce AND.
        const [field, values] = Object.entries(rule)[0];
        if (!fields.has(field)) fields.set(field, []);
        fields.get(field).push(...values);
        converted += 1;
    }
    if (converted === 0) throw new Error('No supported rules remain in source');
    const rules = [...fields].map(([field, values]) => ({ [field]: values }));
    return { ruleSet: { version: 1, rules }, converted, skipped };
}

async function main() {
    const { values } = parseArgs({ options: {
        'source-file': { type: 'string' },
        'list-sources': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        check: { type: 'boolean' }
    } });
    if (values['list-sources']) {
        console.log(JSON.stringify({ revision: PINNED_RULE_REVISIONS.ACL4SSR, sources: getAclSources() }));
        return;
    }
    if (!values['source-file']) throw new Error('Required: --source-file <GitHub API snapshot.json>');
    const snapshot = JSON.parse(await readFile(values['source-file'], 'utf8'));
    const { manifest, artifacts } = buildRuleSetArtifacts(snapshot);
    const root = fileURLToPath(new URL('../', import.meta.url));
    const outputs = artifacts.map(artifact => ({ ...artifact, path: path.join(root, 'public', artifact.path) }));
    outputs.push({
        path: path.join(root, 'shared/singbox-ruleset-manifest.js'),
        content: `// Generated by scripts/build-singbox-rulesets.mjs.\nexport const SINGBOX_RULESET_MANIFEST = ${JSON.stringify(manifest, null, 2)};\n`
    });
    for (const [source, file] of Object.entries(manifest.files)) {
        console.log(`${source}: ${file.converted} converted, skipped ${JSON.stringify(file.skipped)}`);
    }
    if (values['dry-run']) return;
    for (const output of outputs) {
        if (values.check) {
            if (await readFile(output.path, 'utf8') !== output.content) throw new Error(`Stale artifact: ${output.path}`);
        } else {
            await mkdir(path.dirname(output.path), { recursive: true });
            await writeFile(output.path, output.content);
        }
    }
    console.log(`${values.check ? 'Verified' : 'Wrote'} ${outputs.length} files for ${manifest.revision}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
