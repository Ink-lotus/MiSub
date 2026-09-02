import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import DnsTemplateManager from '../../src/components/settings/sections/ServiceSettings/DnsTemplateManager.vue';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { createI18n } from '../../src/i18n/index.js';

const mountManager = pinia => mount(DnsTemplateManager, {
  global: { plugins: [pinia, createI18n({ initialLocale: 'zh-CN' })] }
});

describe('DNS 模板策略模式 UI', () => {
  let pinia;
  let dataStore;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    dataStore = useDataStore();
    // 刻意不带 kind / policy，模拟升级前存量模板
    dataStore.dnsTemplates = [{
      id: 'dns-legacy',
      name: '存量模板',
      enabled: true,
      clash: 'enable: true',
      singbox: '',
      surge: '',
      loon: '',
      quanx: ''
    }];
  });

  it('存量模板默认落在手写模式，五个格式全部列出', () => {
    const wrapper = mountManager(pinia);

    expect(wrapper.get('[data-dns-kind="raw"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-dns-kind="policy"]').attributes('aria-pressed')).toBe('false');
    expect(wrapper.findAll('[data-dns-toggle]')).toHaveLength(5);
    expect(wrapper.find('[data-dns-policy-panel]').exists()).toBe(false);
  });

  it('切到策略模式后只保留 surge / loon / quanx 手写项并显示策略面板', async () => {
    const wrapper = mountManager(pinia);

    await wrapper.get('[data-dns-kind="policy"]').trigger('click');

    expect(wrapper.get('[data-dns-kind="policy"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-dns-policy-panel]').exists()).toBe(true);

    const toggles = wrapper.findAll('[data-dns-toggle]').map(node => node.attributes('data-dns-toggle'));
    expect(toggles).toEqual(['surge', 'loon', 'quanx']);
  });

  it('策略面板提供 clean / polluted 与三组解析器输入', async () => {
    const wrapper = mountManager(pinia);
    await wrapper.get('[data-dns-kind="policy"]').trigger('click');

    const modes = wrapper.get('[data-dns-policy-mode]').findAll('option').map(o => o.attributes('value'));
    expect(modes).toEqual(['clean', 'polluted']);

    const fields = wrapper.findAll('[data-dns-policy-field]').map(node => node.attributes('data-dns-policy-field'));
    expect(fields).toEqual(['domestic', 'foreign', 'polluted']);
  });

  it('解析器输入按行拆成数组写回 policy', async () => {
    const wrapper = mountManager(pinia);
    await wrapper.get('[data-dns-kind="policy"]').trigger('click');

    await wrapper.get('[data-dns-policy-field="domestic"]')
      .setValue('223.5.5.5\n  119.29.29.29  \n\n');

    const tpl = wrapper.vm.localTemplates.find(item => item.id === 'dns-legacy');
    expect(tpl.policy.domestic).toEqual(['223.5.5.5', '119.29.29.29']);
  });

  it('回环地址给出 warn 提示但不阻断编辑', async () => {
    const wrapper = mountManager(pinia);
    await wrapper.get('[data-dns-kind="policy"]').trigger('click');

    expect(wrapper.get('[data-dns-policy-warnings]').text()).toContain('地址均可用');

    await wrapper.get('[data-dns-policy-field="domestic"]').setValue('127.0.0.1');

    const warnings = wrapper.get('[data-dns-policy-warnings]').text();
    expect(warnings).toContain('127.0.0.1');
    expect(warnings).not.toContain('地址均可用');
  });

  it('局域网地址不产生告警', async () => {
    const wrapper = mountManager(pinia);
    await wrapper.get('[data-dns-kind="policy"]').trigger('click');

    await wrapper.get('[data-dns-policy-field="domestic"]').setValue('192.168.1.1');

    expect(wrapper.get('[data-dns-policy-warnings]').text()).toContain('地址均可用');
  });

  it('保存时把 kind 与 policy 一起提交', async () => {
    dataStore.saveDnsTemplates = vi.fn(async templates => templates);
    const wrapper = mountManager(pinia);

    await wrapper.get('[data-dns-kind="policy"]').trigger('click');
    await wrapper.get('[data-dns-policy-mode]').setValue('polluted');
    await wrapper.get('[data-dns-policy-field="polluted"]').setValue('https://1.1.1.1/dns-query');
    await wrapper.get('[data-dns-save]').trigger('click');

    const submitted = dataStore.saveDnsTemplates.mock.calls[0][0][0];
    expect(submitted.kind).toBe('policy');
    expect(submitted.policy.mode).toBe('polluted');
    expect(submitted.policy.polluted).toEqual(['https://1.1.1.1/dns-query']);
    // 手写内容不因切模式而丢失
    expect(submitted.clash).toBe('enable: true');
  });

  it('切回手写模式保留 policy 草稿，五个格式重新出现', async () => {
    const wrapper = mountManager(pinia);

    await wrapper.get('[data-dns-kind="policy"]').trigger('click');
    await wrapper.get('[data-dns-policy-field="foreign"]').setValue('udp://8.8.8.8:53');
    await wrapper.get('[data-dns-kind="raw"]').trigger('click');

    expect(wrapper.findAll('[data-dns-toggle]')).toHaveLength(5);
    expect(wrapper.find('[data-dns-policy-panel]').exists()).toBe(false);

    const tpl = wrapper.vm.localTemplates.find(item => item.id === 'dns-legacy');
    expect(tpl.policy.foreign).toEqual(['udp://8.8.8.8:53']);
  });
});
