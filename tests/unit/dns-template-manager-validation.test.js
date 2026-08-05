import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import DnsTemplateManager from '../../src/components/settings/sections/ServiceSettings/DnsTemplateManager.vue';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { createI18n } from '../../src/i18n/index.js';

describe('DNS 模板实时校验', () => {
  let pinia;
  let dataStore;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    dataStore = useDataStore();
    dataStore.dnsTemplates = [{
      id: 'dns-test',
      name: '校验测试',
      enabled: true,
      clash: 'dns:\n  enable: true',
      singbox: '{"servers":[]}',
      surge: '',
      loon: '',
      quanx: ''
    }];
  });

  it('显示各客户端状态并随输入实时更新', async () => {
    const wrapper = mount(DnsTemplateManager, {
      global: { plugins: [pinia, createI18n({ initialLocale: 'zh-CN' })] }
    });

    expect(wrapper.get('[data-dns-status="clash"]').text()).toContain('格式无效');
    expect(wrapper.get('[data-dns-status="singbox"]').text()).toContain('格式有效');
    expect(wrapper.get('[data-dns-status="surge"]').text()).toContain('未配置');

    await wrapper.get('textarea[data-dns-field="clash"]').setValue('enable: true');

    expect(wrapper.get('[data-dns-status="clash"]').text()).toContain('格式有效');
  });

  it('存在无效字段时仍允许保存草稿', async () => {
    dataStore.saveDnsTemplates = vi.fn(async templates => templates);
    const wrapper = mount(DnsTemplateManager, {
      global: { plugins: [pinia, createI18n({ initialLocale: 'zh-CN' })] }
    });

    await wrapper.get('[data-dns-save]').trigger('click');

    expect(dataStore.saveDnsTemplates).toHaveBeenCalledOnce();
    expect(dataStore.saveDnsTemplates.mock.calls[0][0][0].clash).toBe('dns:\n  enable: true');
  });
});
