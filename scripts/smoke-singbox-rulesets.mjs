import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { renderSingboxFromTemplateModel } from '../functions/modules/subscription/template-renderers/render-singbox.js';
import { SINGBOX_RULESET_MANIFEST } from '../shared/singbox-ruleset-manifest.js';

const { values } = parseArgs({ options: {
    client: { type: 'string', multiple: true },
    'public-dir': { type: 'string', default: 'public' }
} });
assert(values.client?.length, 'Usage: node scripts/smoke-singbox-rulesets.mjs --client <sing-box> [--client <sing-box>] [--public-dir dist]');

const workdir = await mkdtemp(join(tmpdir(), 'misub-singbox-smoke-'));
const cancellation = new AbortController();
const entries = Object.entries(SINGBOX_RULESET_MANIFEST.files);
const assets = new Map();
for (const [, file] of entries) {
    const bytes = await readFile(resolve(values['public-dir'], file.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.outputSha256, file.path);
    assets.set(`/${file.path}`, bytes);
}
const downloads = new Set();
const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const bytes = assets.get(pathname);
    if (bytes) {
        downloads.add(pathname);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(bytes);
    } else if (pathname === '/dns-fixture.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: 1, rules: [{ domain_suffix: ['unused.invalid'] }] }));
    } else if (pathname === '/invalid.list') {
        res.end('DOMAIN-SUFFIX,claude.ai\n');
    } else if (pathname === '/control') {
        res.end('direct-control-ok');
    } else {
        res.writeHead(404);
        res.end();
    }
});

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}

async function freePort() {
    const probe = createTcpServer();
    const port = await listen(probe);
    await new Promise(resolve => probe.close(resolve));
    return port;
}

function startClient(binary, args, logPath) {
    const fd = openSync(logPath, 'w');
    let child;
    try {
        // File descriptors also work where Windows sandbox policy blocks child pipes.
        child = spawn(resolve(binary), args, { cwd: workdir, stdio: ['ignore', fd, fd], windowsHide: true });
    } finally {
        closeSync(fd);
    }
    const state = { child, result: null, error: null, log: () => readFileSync(logPath, 'utf8') };
    state.exited = new Promise(resolve => {
        child.on('error', error => {
            state.error = error;
            if (!child.pid) { state.result = { error: error.message }; resolve(); }
        });
        child.once('exit', (code, signal) => { state.result = { code, signal }; resolve(); });
    });
    return state;
}

async function stopClient(state) {
    if (!state || state.result) return;
    for (const signal of ['SIGTERM', 'SIGKILL']) {
        state.child.kill(signal);
        await Promise.race([state.exited, delay(3000, undefined, { ref: false })]);
        if (state.result) return;
    }
    state.child.unref();
    throw new Error(`Client ${state.child.pid} did not exit after SIGKILL${state.error ? `: ${state.error.message}` : ''}`);
}

async function waitUntil(predicate, message, state) {
    const deadline = Date.now() + 20_000;
    while (!predicate()) {
        cancellation.signal.throwIfAborted();
        assert(!state.result, `${message}: ${JSON.stringify(state.result)}\n${state.log()}`);
        assert(Date.now() < deadline, `${message}: timed out\n${state.log()}`);
        await delay(100);
    }
}

function proxyRequest(port, target) {
    return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: target, headers: { Host: new URL(target).host } }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
            res.on('error', reject);
        });
        req.setTimeout(5000, () => req.destroy(new Error('Proxy request timed out')));
        req.on('error', reject);
        req.end();
    });
}

const active = new Set();
const cancel = () => cancellation.abort(new Error('Smoke test interrupted'));
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
try {
    const origin = `http://127.0.0.1:${await listen(server)}`;
    const claudePath = 'Clash/Ruleset/Claude.list';
    const sourceUrl = path => `https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/${SINGBOX_RULESET_MANIFEST.revision}/${path}`;
    const orderedSources = [claudePath, ...entries.map(([path]) => path).filter(path => path !== claudePath)];

    for (const [index, binary] of values.client.entries()) {
        cancellation.signal.throwIfAborted();
        const port = await freePort();
        const config = JSON.parse(renderSingboxFromTemplateModel({
            settings: { dnsThroughProxy: false, managedConfigUrl: `${origin}/sub/smoke` },
            rules: [
                { type: 'ip-cidr', value: '127.0.0.0/8', policy: 'DIRECT' },
                ...orderedSources.map(path => ({ type: 'rule-set', value: sourceUrl(path), policy: 'REJECT' })),
                { type: 'match', policy: 'DIRECT' }
            ]
        }));
        // Confine the rendered configuration to loopback and remove unrelated DNS downloads.
        config.inbounds = [{ type: 'mixed', tag: 'smoke-in', listen: '127.0.0.1', listen_port: port }];
        config.dns = { servers: [{ type: 'local', tag: 'smoke-dns' }] };
        config.route.default_domain_resolver = 'smoke-dns';
        config.route.auto_detect_interface = false;
        config.log = { level: 'debug', timestamp: false };
        for (const ruleSet of config.route.rule_set) {
            if (!assets.has(new URL(ruleSet.url).pathname)) {
                ruleSet.url = `${origin}/dns-fixture.json`;
                ruleSet.format = 'source';
            } else {
                assert.equal(new URL(ruleSet.url).origin, origin);
            }
        }
        const configPath = join(workdir, `client-${index}.json`);
        await writeFile(configPath, JSON.stringify(config));
        const checked = startClient(binary, ['check', '-c', configPath], join(workdir, `check-${index}.log`));
        active.add(checked);
        await waitUntil(() => checked.result, 'Configuration check did not exit', checked);
        assert.equal(checked.result.code, 0, checked.log());

        downloads.clear();
        const running = startClient(binary, ['run', '-c', configPath], join(workdir, `run-${index}.log`));
        active.add(running);
        await waitUntil(() => running.log().includes('sing-box started'), 'Client did not start', running);
        assert.equal(downloads.size, assets.size, 'Client did not download every generated rule set');
        assert.deepEqual(await proxyRequest(port, `${origin}/control`), { status: 200, body: 'direct-control-ok' });
        const rejected = await proxyRequest(port, 'http://claude.ai/').catch(error => ({ error: error.message }));
        assert(rejected.error || rejected.status >= 400, `Expected rejection: ${JSON.stringify(rejected)}`);
        await waitUntil(() => running.log().includes(`match[1] rule_set=${sourceUrl(claudePath)} => reject`),
            'Missing Claude rule-set rejection in client log', running);
        await stopClient(running);

        const invalid = structuredClone(config);
        invalid.route.rule_set.find(ruleSet => ruleSet.tag === sourceUrl(claudePath)).url = `${origin}/invalid.list`;
        const invalidPath = join(workdir, `invalid-${index}.json`);
        await writeFile(invalidPath, JSON.stringify(invalid));
        const failed = startClient(binary, ['run', '-c', invalidPath], join(workdir, `invalid-${index}.log`));
        active.add(failed);
        await waitUntil(() => failed.result, 'Invalid remote list did not fail startup', failed);
        assert.notEqual(failed.result.code, 0, failed.log());
        assert.match(failed.log(), /FATAL/i);
        assert(failed.log().includes(sourceUrl(claudePath)), failed.log());
        assert.match(failed.log(), /invalid character 'D'/);
        console.log(JSON.stringify({ binary: resolve(binary), ruleSetsDownloaded: assets.size, configCheck: 'passed',
            directControl: 'passed', domainRejection: 'passed', invalidList: 'fatal', logs: workdir }));
    }
} finally {
    try {
        const cleanup = await Promise.allSettled([...active].map(stopClient));
        for (const result of cleanup) {
            if (result.status === 'rejected') {
                console.error(result.reason);
                process.exitCode = 1;
            }
        }
    } finally {
        server.closeAllConnections();
        if (server.listening) await new Promise(resolve => server.close(resolve));
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
    }
}
