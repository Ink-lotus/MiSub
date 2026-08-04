import { describe, it, expect } from 'vitest';
import { handleDnsTemplatesRequest } from '../../functions/modules/dns-template-handler.js';

function fakeAdapter(seed = []) {
  let store = seed;
  return {
    async get() { return store; },
    async put(_k, v) { store = v; return true; }
  };
}
const fakeEnv = { __TEST_STORAGE_ADAPTER: fakeAdapter() };

describe('DNS 模板 API', () => {
  it('GET 返回列表', async () => {
    const res = await handleDnsTemplatesRequest(new Request('http://x/api/dns_templates', { method: 'GET' }), fakeEnv);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });
  it('POST 保存并回读', async () => {
    const req = new Request('http://x/api/dns_templates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templates: [{ name: 't', surge: '1.1.1.1' }] })
    });
    const res = await handleDnsTemplatesRequest(req, fakeEnv);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data[0].surge).toBe('1.1.1.1');
  });
});
