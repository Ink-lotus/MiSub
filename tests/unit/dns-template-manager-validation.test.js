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

    await wrapper.get('[data-dns-toggle="clash"]').trigger('click');
    await wrapper.get('textarea[data-dns-field="clash"]').setValue('enable: true');

    expect(wrapper.get('[data-dns-status="clash"]').text()).toContain('格式有效');
  });

  it('各客户端输入框默认折叠并可独立展开', async () => {
    const wrapper = mount(DnsTemplateManager, {
      global: { plugins: [pinia, createI18n({ initialLocale: 'zh-CN' })] }
    });

    expect(wrapper.findAll('textarea[data-dns-field]')).toHaveLength(0);
    expect(wrapper.get('[data-dns-toggle="clash"]').attributes('aria-expanded')).toBe('false');

    await wrapper.get('[data-dns-toggle="clash"]').trigger('click');

    expect(wrapper.get('textarea[data-dns-field="clash"]').exists()).toBe(true);
    expect(wrapper.find('textarea[data-dns-field="singbox"]').exists()).toBe(false);
    expect(wrapper.get('[data-dns-toggle="clash"]').attributes('aria-expanded')).toBe('true');
  });

  it('输入框高度按内容行数在 4 到 12 行之间变化', async () => {
    const wrapper = mount(DnsTemplateManager, {
      global: { plugins: [pinia, createI18n({ initialLocale: 'zh-CN' })] }
    });

    await wrapper.get('[data-dns-toggle="clash"]').trigger('click');
    const textarea = wrapper.get('textarea[data-dns-field="clash"]');

    expect(textarea.attributes('rows')).toBe('4');

    await textarea.setValue(Array.from({ length: 6 }, (_, index) => `line-${index}`).join('\n'));
    expect(textarea.attributes('rows')).toBe('6');

    await textarea.setValue(Array.from({ length: 13 }, (_, index) => `line-${index}`).join('\n'));
    expect(textarea.attributes('rows')).toBe('12');
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
