import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDataStore } from '../../src/stores/useDataStore.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function createStore() {
  setActivePinia(createPinia());
  return useDataStore();
}

describe('Data store DNS 模板缓存', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('保存 DNS 模板后刷新应从缓存恢复最新模板', async () => {
    const initialData = {
      misubs: [],
      profiles: [],
      ruleTemplates: [],
      dnsTemplates: [{ id: 'old', name: '旧模板', clash: 'old' }],
      config: {}
    };
    const savedTemplates = [{ id: 'new', name: '新模板', clash: 'new' }];

    vi.stubGlobal('fetch', vi.fn(async url => {
      if (url === '/api/dns_templates') {
        return jsonResponse({ success: true, data: savedTemplates });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const dataStore = createStore();
    expect(dataStore.hydrateFromData(initialData)).toBe(true);
    await dataStore.saveDnsTemplates(savedTemplates);

    const cachedData = JSON.parse(sessionStorage.getItem('misub_data_cache'));
    expect(cachedData.dnsTemplates).toEqual(savedTemplates);

    const reloadedStore = createStore();
    await reloadedStore.fetchData(false);
    expect(reloadedStore.dnsTemplates).toEqual(savedTemplates);
  });

  it('刷新 DNS 模板后应同步缓存中的模板列表', async () => {
    const initialData = {
      misubs: [],
      profiles: [],
      ruleTemplates: [],
      dnsTemplates: [{ id: 'old', name: '旧模板', clash: 'old' }],
      config: {}
    };
    const fetchedTemplates = [{ id: 'fresh', name: '最新模板', clash: 'fresh' }];

    vi.stubGlobal('fetch', vi.fn(async url => {
      if (url === '/api/dns_templates') {
        return jsonResponse({ success: true, data: fetchedTemplates });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const dataStore = createStore();
    expect(dataStore.hydrateFromData(initialData)).toBe(true);
    await dataStore.fetchDnsTemplates();

    const cachedData = JSON.parse(sessionStorage.getItem('misub_data_cache'));
    expect(cachedData.dnsTemplates).toEqual(fetchedTemplates);
  });
});
