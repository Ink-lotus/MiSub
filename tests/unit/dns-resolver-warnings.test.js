import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import DnsTemplateManager from '../../src/components/settings/sections/ServiceSettings/DnsTemplateManager.vue';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { createI18n } from '../../src/i18n/index.js';
import {
  collectResolverWarnings,
  validateDnsTemplateResolvers,
  isLoopbackResolver,
  validateDnsTemplateField,
  collectMissingSafetyKeys,
  validateDnsTemplateSafetyKeys,
  DNS_SAFETY_KEYS
} from '../../shared/dns-template-validation.js';

describe('手写模板解析器地址提示：isLoopbackResolver', () => {
  it.each([
    '127.0.0.1',
    '127.0.0.53',
    '0.0.0.0',
    'localhost',
    '::1',
    '[::1]:53',
    'udp://127.0.0.1:53'
  ])('标出回环或全零地址 %s', value => {
    expect(isLoopbackResolver(value)).toBe(true);
  });

  it.each([
    '223.5.5.5',
    '192.168.1.1',
    'https://8.8.8.8/dns-query',
    'system',
    ''
  ])('放行可用地址 %s', value => {
    expect(isLoopbackResolver(value)).toBe(false);
  });

  it('不因非 udp/tcp/tls/https 的 scheme 误报——mihomo 还支持 quic 等写法', () => {
    expect(isLoopbackResolver('quic://8.8.8.8')).toBe(false);
    expect(isLoopbackResolver('h3://1.1.1.1')).toBe(false);
  });

  it('忽略 clash 的 #策略组 后缀', () => {
    expect(isLoopbackResolver('udp://8.8.8.8:53#🌐 DNS 出口')).toBe(false);
  });
});

describe('手写模板解析器地址提示：逐格式扫描', () => {
  it('clash 扫 nameserver 与 nameserver-policy', () => {
    const text = [
      'nameserver:',
      '  - 127.0.0.1',
      '  - 223.5.5.5',
      'nameserver-policy:',
      '  "geosite:cn":',
      '    - 0.0.0.0'
    ].join('\n');
    expect(collectResolverWarnings('clash', text)).toEqual(['127.0.0.1', '0.0.0.0']);
  });

  it('clash 带策略组后缀的正常地址不告警', () => {
    expect(collectResolverWarnings('clash', 'nameserver:\n  - udp://8.8.8.8:53#DNS')).toEqual([]);
  });

  it('singbox 同时扫新版 server 与旧版 address 字段', () => {
    const text = JSON.stringify({
      servers: [
        { tag: 'a', server: '127.0.0.1' },
        { tag: 'b', address: '0.0.0.0' },
        { tag: 'c', server: '223.5.5.5' }
      ]
    });
    expect(collectResolverWarnings('singbox', text)).toEqual(['127.0.0.1', '0.0.0.0']);
  });

  it('surge / loon 按逗号拆分逐项扫', () => {
    expect(collectResolverWarnings('surge', '223.5.5.5, 127.0.0.1, system')).toEqual(['127.0.0.1']);
    expect(collectResolverWarnings('loon', 'system, 0.0.0.0')).toEqual(['0.0.0.0']);
  });

  it('quanx 扫 server 行，含域名定向写法', () => {
    const text = 'no-ipv6\nserver = 127.0.0.1\nserver = 223.5.5.5\nserver=/example.com/0.0.0.0';
    expect(collectResolverWarnings('quanx', text)).toEqual(['127.0.0.1', '0.0.0.0']);
  });

  it('格式本身解析失败时返回空——格式问题由 status 负责报', () => {
    expect(collectResolverWarnings('clash', 'nameserver: [unclosed')).toEqual([]);
    expect(collectResolverWarnings('singbox', '{broken')).toEqual([]);
  });

  it('空内容不告警', () => {
    expect(collectResolverWarnings('clash', '')).toEqual([]);
  });

  it('validateDnsTemplateResolvers 返回五个格式的键', () => {
    const result = validateDnsTemplateResolvers({ surge: '127.0.0.1' });
    expect(Object.keys(result).sort()).toEqual(['clash', 'loon', 'quanx', 'singbox', 'surge']);
    expect(result.surge).toEqual(['127.0.0.1']);
    expect(result.clash).toEqual([]);
  });

  it('地址提示不改变字段的 valid 判定（纯 warn）', () => {
    const text = 'nameserver:\n  - 127.0.0.1';
    expect(collectResolverWarnings('clash', text)).toEqual(['127.0.0.1']);
    expect(validateDnsTemplateField('clash', text).status).toBe('valid');
  });
});

describe('手写模板解析器地址提示：UI 呈现', () => {
  let pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    const dataStore = useDataStore();
    dataStore.dnsTemplates = [{
      id: 'dns-warn',
      name: '回环测试',
      enabled: true,
      clash: 'nameserver:\n  - 127.0.0.1\n  - 0.0.0.0',
      singbox: '',
      surge: '223.5.5.5, system',
      loon: '',
      quanx: ''
    }];
  });

  const mountManager = () => mount(DnsTemplateManager, {
    global: { plugins: [pinia, createI18n({ initialLocale: 'zh-CN' })] }
  });

  it('折叠状态下用角标提示条数，避免提示被藏起来', () => {
    const wrapper = mountManager();

    expect(wrapper.get('[data-dns-resolver-badge="clash"]').text()).toBe('2');
    expect(wrapper.find('[data-dns-resolver-badge="surge"]').exists()).toBe(false);
  });

  it('展开后列出具体地址，且 status 仍是格式有效', async () => {
    const wrapper = mountManager();
    await wrapper.get('[data-dns-toggle="clash"]').trigger('click');

    const warning = wrapper.get('[data-dns-resolver-warning="clash"]').text();
    expect(warning).toContain('127.0.0.1');
    expect(warning).toContain('0.0.0.0');
    expect(wrapper.get('[data-dns-status="clash"]').text()).toContain('格式有效');
  });

  it('改成可用地址后提示消失', async () => {
    const wrapper = mountManager();
    await wrapper.get('[data-dns-toggle="clash"]').trigger('click');
    await wrapper.get('textarea[data-dns-field="clash"]').setValue('nameserver:\n  - 223.5.5.5');

    expect(wrapper.find('[data-dns-resolver-warning="clash"]').exists()).toBe(false);
    expect(wrapper.find('[data-dns-resolver-badge="clash"]').exists()).toBe(false);
  });
});

describe('高级模式结构性字段提示：collectMissingSafetyKeys', () => {
  it('只写 nameserver 的 clash 模板报出全部四个关键字段', () => {
    expect(collectMissingSafetyKeys('clash', 'enable: true\nnameserver:\n  - 1.1.1.1'))
      .toEqual(DNS_SAFETY_KEYS.clash);
  });

  it('写全关键字段后不再提示', () => {
    const full = [
      'enable: true',
      'enhanced-mode: fake-ip',
      'nameserver:',
      '  - 1.1.1.1',
      'nameserver-policy:',
      '  geosite:cn:',
      '    - 223.5.5.5',
      'proxy-server-nameserver:',
      '  - 223.5.5.5',
      'fallback-filter:',
      '  geoip: true'
    ].join('\n');
    expect(collectMissingSafetyKeys('clash', full)).toEqual([]);
  });

  it('部分缺失只报缺的那几个', () => {
    const partial = 'enhanced-mode: fake-ip\nnameserver:\n  - 1.1.1.1';
    expect(collectMissingSafetyKeys('clash', partial))
      .toEqual(['nameserver-policy', 'proxy-server-nameserver', 'fallback-filter']);
  });

  it('singbox 检查 rules 与 final', () => {
    expect(collectMissingSafetyKeys('singbox', JSON.stringify({ servers: [] })))
      .toEqual(['rules', 'final']);
    expect(collectMissingSafetyKeys('singbox', JSON.stringify({ servers: [], rules: [], final: 'x' })))
      .toEqual([]);
  });

  it('surge / loon / quanx 不参与本项检查', () => {
    for (const field of ['surge', 'loon', 'quanx']) {
      expect(collectMissingSafetyKeys(field, '9.9.9.9')).toEqual([]);
    }
  });

  it('空值与解析失败都不提示，避免与格式错误重复报', () => {
    expect(collectMissingSafetyKeys('clash', '')).toEqual([]);
    expect(collectMissingSafetyKeys('clash', '   ')).toEqual([]);
    expect(collectMissingSafetyKeys('clash', '::not yaml: [')).toEqual([]);
    expect(collectMissingSafetyKeys('singbox', '{bad json')).toEqual([]);
    // 数组不是映射体，交给 status 报 objectRequired
    expect(collectMissingSafetyKeys('clash', '- 1.1.1.1')).toEqual([]);
  });

  it('validateDnsTemplateSafetyKeys 只覆盖 clash 与 singbox 两个字段', () => {
    const result = validateDnsTemplateSafetyKeys({ clash: 'nameserver:\n  - 1.1.1.1', singbox: '' });
    expect(Object.keys(result).sort()).toEqual(['clash', 'singbox']);
    expect(result.clash).toEqual(DNS_SAFETY_KEYS.clash);
    expect(result.singbox).toEqual([]);
  });

  it('提示为纯 warn，不影响 status 判定', () => {
    const partial = 'enable: true\nnameserver:\n  - 1.1.1.1';
    expect(collectMissingSafetyKeys('clash', partial).length).toBeGreaterThan(0);
    expect(validateDnsTemplateField('clash', partial).status).toBe('valid');
  });
});

describe('高级模式结构性字段提示：UI 呈现', () => {
  let pinia;

  const seed = templates => {
    pinia = createPinia();
    setActivePinia(pinia);
    useDataStore().dnsTemplates = templates;
  };

  const mountManager = () => mount(DnsTemplateManager, {
    global: { plugins: [pinia, createI18n({ initialLocale: 'zh-CN' })] }
  });

  const rawTemplate = clash => ({
    id: 'dns-safety',
    name: '结构测试',
    enabled: true,
    kind: 'raw',
    clash,
    singbox: '',
    surge: '',
    loon: '',
    quanx: ''
  });

  it('折叠状态下用角标提示缺失字段数', () => {
    seed([rawTemplate('enable: true\nnameserver:\n  - 1.1.1.1')]);
    const wrapper = mountManager();

    expect(wrapper.get('[data-dns-safety-badge="clash"]').text()).toBe('!4');
  });

  it('展开后列出缺失的字段名，且 status 仍是格式有效', async () => {
    seed([rawTemplate('enable: true\nnameserver:\n  - 1.1.1.1')]);
    const wrapper = mountManager();
    await wrapper.get('[data-dns-toggle="clash"]').trigger('click');

    const warning = wrapper.get('[data-dns-safety-warning="clash"]').text();
    expect(warning).toContain('enhanced-mode');
    expect(warning).toContain('nameserver-policy');
    expect(wrapper.get('[data-dns-status="clash"]').text()).toContain('格式有效');
  });

  it('策略模式不显示该提示：块由引擎合成，本就完整', () => {
    seed([{
      id: 'dns-policy',
      name: '策略模板',
      enabled: true,
      kind: 'policy',
      policy: { mode: 'clean', domestic: ['223.5.5.5'], foreign: ['8.8.8.8'], polluted: [] },
      clash: 'enable: true\nnameserver:\n  - 1.1.1.1',
      singbox: '',
      surge: '',
      loon: '',
      quanx: ''
    }]);
    const wrapper = mountManager();

    expect(wrapper.find('[data-dns-safety-badge="clash"]').exists()).toBe(false);
    expect(wrapper.find('[data-dns-safety-warning="clash"]').exists()).toBe(false);
  });
});
