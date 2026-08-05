import { describe, it, expect } from 'vitest';
import { resolveEffectiveDnsConfig } from '../../functions/modules/dns-template-handler.js';

describe('DNS 解析优先级（回归）', () => {
  const tpl = (id, clash = '') => ({ id, enabled: true, clash, singbox: '', surge: '', loon: '', quanx: '' });
  it('普通订阅：全局 template 生效', () => {
    const r = resolveEffectiveDnsConfig({ profileDns: { mode: 'global' }, globalDns: { mode: 'template', templateId: 'g' }, templates: [tpl('g', 'enable: true')] });
    expect(r.clash).toBe('enable: true');
  });
  it('Profile 默认内置覆盖全局', () => {
    const r = resolveEffectiveDnsConfig({ profileDns: { mode: 'builtin' }, globalDns: { mode: 'template', templateId: 'g' }, templates: [tpl('g', 'enable: true')] });
    expect(r).toBeNull();
  });
  it('Profile 指定模板优先于全局', () => {
    const r = resolveEffectiveDnsConfig({ profileDns: { mode: 'template', templateId: 'p' }, globalDns: { mode: 'template', templateId: 'g' }, templates: [tpl('g', 'enable: false'), tpl('p', 'enable: true')] });
    expect(r.clash).toBe('enable: true');
  });
});
