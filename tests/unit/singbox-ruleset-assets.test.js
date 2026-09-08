import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../../functions/[[path]].js';
import { SettingsCache } from '../../functions/storage-adapter.js';

// These handlers require storage and subscriptions; none owns public rule-set files.
vi.mock('../../functions/modules/subscription-handler.js', () => ({
    handleMisubRequest: () => new Response('Subscription route', { status: 404 })
}));
vi.mock('../../functions/modules/api-router.js', () => ({
    handleApiRequest: () => new Response('API route', { status: 404 })
}));

const ASSET = '/rulesets/singbox/433381ebc4b1de59350fa8bed2a04a888228f801/Ruleset/Claude.json';
const RULE_SET = { version: 1, rules: [{ domain_suffix: ['claude.ai'] }] };

afterEach(() => vi.restoreAllMocks());

function assets(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === ASSET) return Response.json(RULE_SET);
    if (pathname === '/rulesets/singbox/README.md') return new Response('CC BY-SA 4.0');
    return new Response('Asset not found', { status: 404 });
}

describe('public hosted sing-box rules', () => {
    it.each(['mytoken', 'profileToken', 'customLoginPath'])('remains anonymous when legacy %s is rulesets', async key => {
        vi.spyOn(SettingsCache, 'get').mockResolvedValue({ [key]: 'rulesets' });
        const response = await onRequest({
            request: new Request(`https://misub.example${ASSET}`),
            env: { ASSETS: { fetch: assets } }
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toContain('application/json');
        expect(await response.json()).toEqual(RULE_SET);
    });

    it('supports Pages next() and serves the public attribution alongside the data', async () => {
        vi.spyOn(SettingsCache, 'get').mockResolvedValue({ customLoginPath: 'rulesets' });
        const request = new Request('https://misub.example/rulesets/singbox/README.md');
        const response = await onRequest({ request, env: {}, next: () => assets(request) });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('CC BY-SA 4.0');
    });

    it('does not turn a missing rule file into HTML', async () => {
        vi.spyOn(SettingsCache, 'get').mockResolvedValue({ customLoginPath: 'rulesets' });
        const response = await onRequest({
            request: new Request(`https://misub.example${ASSET.replace('Claude.json', 'Missing.json')}`),
            env: { ASSETS: { fetch: assets } }
        });
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('Asset not found');
    });

    it('keeps other rulesets token paths on the subscription handler', async () => {
        vi.spyOn(SettingsCache, 'get').mockResolvedValue({ mytoken: 'rulesets' });
        const response = await onRequest({
            request: new Request('https://misub.example/rulesets/profile'), env: { ASSETS: { fetch: assets } }
        });
        expect(await response.text()).toBe('Subscription route');
    });
});
