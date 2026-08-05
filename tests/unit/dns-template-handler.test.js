import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeDnsTemplates, resolveEffectiveDnsConfig } from '../../functions/modules/dns-template-handler.js';
import { DEFAULT_SETTINGS } from '../../functions/modules/config.js';

const execFileAsync = promisify(execFile);

describe('DNS 模板归一化', () => {
  it('应清洗字段、生成 id、默认 enabled', () => {
    const normalized = normalizeDnsTemplates([{ name: '带空格的模板!', clash: 'enable: true', surge: '1.1.1.1' }]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].name).toBe('带空格的模板!');
    expect(normalized[0].id).toMatch(/^dns-template-/);
    expect(normalized[0].enabled).toBe(true);
    expect(normalized[0].clash).toBe('enable: true');
    expect(normalized[0].quanx).toBe('');
  });
  it('应过滤无任何 DNS 内容的空模板', () => {
    const normalized = normalizeDnsTemplates([{ name: '空', content: 'x' }, { name: '无字段' }]);
    expect(normalized).toHaveLength(0);
  });

  it('应在有限时间内为重复的 80 字符 id 生成唯一 id', async () => {
    const script = `
      import { normalizeDnsTemplates } from './functions/modules/dns-template-handler.js';
      const id = 'a'.repeat(80);
      const result = normalizeDnsTemplates([
        { id, clash: 'enable: true' },
        { id, clash: 'enable: true' }
      ]);
      console.log(JSON.stringify(result.map(item => item.id)));
    `;

    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      timeout: 3000
    });
    const ids = JSON.parse(stdout.trim());

    expect(new Set(ids).size).toBe(2);
    expect(ids.every(id => id.length <= 80)).toBe(true);
  });
});

describe('DNS 生效优先级', () => {
  const templates = [
    { id: 't1', enabled: true, clash: 'enable: true', singbox: '', surge: '', loon: '', quanx: '' },
    { id: 't2', enabled: false, clash: 'b' },
  ];
  it('Profile 指定模板优先', () => {
    const r = resolveEffectiveDnsConfig({ profileDns: { mode: 'template', templateId: 't1' }, globalDns: { mode: 'template', templateId: 't2' }, templates });
    expect(r.clash).toBe('enable: true');
  });
  it('Profile 默认内置 → 忽略全局', () => {
    const r = resolveEffectiveDnsConfig({ profileDns: { mode: 'builtin' }, globalDns: { mode: 'template', templateId: 't1' }, templates });
    expect(r).toBeNull();
  });
  it('Profile 继承全局(global) → 用全局模板', () => {
    const r = resolveEffectiveDnsConfig({ profileDns: { mode: 'global' }, globalDns: { mode: 'template', templateId: 't1' }, templates });
    expect(r.clash).toBe('enable: true');
  });
  it('全局内置默认 → null', () => {
    const r = resolveEffectiveDnsConfig({}, { /* no-op */ });
    expect(r).toBeNull();
  });
  it('禁用或未找到的模板 → null', () => {
    const r = resolveEffectiveDnsConfig({ profileDns: { mode: 'template', templateId: 't2' }, globalDns: {}, templates });
    expect(r).toBeNull();
  });

  it('无效客户端字段应独立回退默认 DNS', () => {
    const invalidTemplate = {
      id: 'invalid',
      enabled: true,
      clash: 'dns:\n  enable: true',
      singbox: '{"dns":{"servers":[]}}',
      surge: 'dns-server = 1.1.1.1',
      loon: '1.1.1.1\n8.8.8.8',
      quanx: '[dns]\nserver = 1.1.1.1'
    };

    const result = resolveEffectiveDnsConfig({
      globalDns: { mode: 'template', templateId: 'invalid' },
      templates: [invalidTemplate]
    });

    expect(result).toEqual({ clash: '', singbox: '', surge: '', loon: '', quanx: '' });
  });

  it('格式有效的客户端字段应保持原值', () => {
    const validTemplate = {
      id: 'valid',
      enabled: true,
      clash: 'enable: true\nnameserver:\n  - 1.1.1.1',
      singbox: '{"servers":[{"tag":"custom","address":"1.1.1.1"}]}',
      surge: '1.1.1.1, system',
      loon: 'system, 1.1.1.1',
      quanx: 'no-ipv6\nserver = 1.1.1.1'
    };

    const result = resolveEffectiveDnsConfig({
      globalDns: { mode: 'template', templateId: 'valid' },
      templates: [validTemplate]
    });

    expect(result).toEqual({
      clash: validTemplate.clash,
      singbox: validTemplate.singbox,
      surge: validTemplate.surge,
      loon: validTemplate.loon,
      quanx: validTemplate.quanx
    });
  });
});

describe('全局默认 dnsConfig', () => {
  it('全局默认 dnsConfig 为 builtin 空 templateId', () => {
    expect(DEFAULT_SETTINGS.dnsConfig).toEqual({ mode: 'builtin', templateId: '' });
  });
});
