import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import {
    resolveSafeDnsConfig,
    buildSingboxDnsConfig,
    resolverHost,
    isExplicitDnsBlock,
    DNS_MODES
} from '../../shared/safe-dns.js';
import { validatePolicyRecord } from '../../shared/dns-template-validation.js';
import { normalizeDnsTemplates, resolveEffectiveDnsConfig } from '../../functions/modules/dns-template-handler.js';

const POLICY = Object.freeze({
    mode: 'clean',
    domestic: ['223.5.5.5'],
    foreign: ['udp://8.8.8.8:53'],
    polluted: ['https://1.1.1.1/dns-query']
});

describe('safe-dns 引擎：clash DNS 块合成', () => {
    it('clean 模式产出 fake-ip 与 geosite 分流的完整块', () => {
        const dns = resolveSafeDnsConfig(POLICY, { mode: DNS_MODES.CLEAN });

        expect(dns.enable).toBe(true);
        expect(dns.ipv6).toBe(false);
        expect(dns['enhanced-mode']).toBe('fake-ip');
        expect(dns['respect-rules']).toBe(true);
        expect(dns['fake-ip-range']).toBe('198.18.0.1/16');
        expect(dns['fake-ip-filter']).toContain('geosite:private');

        expect(dns['default-nameserver']).toEqual(['223.5.5.5']);
        expect(dns.nameserver).toEqual(['udp://8.8.8.8:53']);
        expect(dns['nameserver-policy']).toEqual({
            'geosite:private': ['223.5.5.5'],
            'geosite:cn': ['223.5.5.5'],
            'geosite:geolocation-!cn': ['udp://8.8.8.8:53']
        });
        expect(dns['proxy-server-nameserver']).toEqual(['223.5.5.5']);
        expect(dns['direct-nameserver']).toEqual(['223.5.5.5']);
    });

    it('clean 模式 fallback 为空且保留 geoip CN 与私有段过滤', () => {
        const dns = resolveSafeDnsConfig(POLICY, { mode: DNS_MODES.CLEAN });
        expect(dns.fallback).toEqual([]);
        expect(dns['fallback-filter'].geoip).toBe(true);
        expect(dns['fallback-filter']['geoip-code']).toBe('CN');
        expect(dns['fallback-filter'].ipcidr).toContain('127.0.0.0/8');
    });

    it('polluted 模式改用 DoH 解析器并填充 fallback', () => {
        const dns = resolveSafeDnsConfig(POLICY, { mode: DNS_MODES.POLLUTED });
        expect(dns.nameserver).toEqual(['https://1.1.1.1/dns-query']);
        expect(dns.fallback).toEqual(['https://1.1.1.1/dns-query']);
    });

    it('方案 A：不给解析器附加 #🌐 DNS 出口 策略组后缀', () => {
        const dns = resolveSafeDnsConfig(POLICY, { mode: DNS_MODES.CLEAN });
        const allResolvers = [
            ...dns.nameserver,
            ...dns['default-nameserver'],
            ...Object.values(dns['nameserver-policy']).flat()
        ];
        expect(allResolvers.every(v => !v.includes('#'))).toBe(true);
    });

    it('识别用户写的完整 dns 块并原样透传（高级模式逃生门）', () => {
        const explicit = { enable: true, 'enhanced-mode': 'redir-host', nameserver: ['1.1.1.1'] };
        expect(isExplicitDnsBlock(explicit)).toBe(true);
        expect(resolveSafeDnsConfig(explicit)).toEqual(explicit);
    });

    it('解析器全部非法时回落内置默认策略', () => {
        const dns = resolveSafeDnsConfig({ domestic: ['127.0.0.1'], foreign: ['ftp://x'] });
        expect(dns['default-nameserver']).toEqual(['223.5.5.5', '119.29.29.29']);
        expect(dns.nameserver.length).toBeGreaterThan(0);
    });
});

describe('safe-dns 引擎：sing-box DNS 合成', () => {
    it('产出 servers / rules / final 三段结构', () => {
        const dns = buildSingboxDnsConfig(POLICY, { mode: DNS_MODES.CLEAN });

        expect(dns.strategy).toBe('prefer_ipv4');
        expect(dns.servers.map(s => s.tag)).toEqual(['dns-cn-1', 'dns-foreign-1']);
        expect(dns.final).toBe('dns-foreign-1');

        expect(dns.rules[0]).toEqual({
            rule_set: ['geosite-cn'],
            action: 'route',
            server: 'dns-cn-1'
        });
        expect(dns.rules[1].domain_suffix).toEqual(['.cn', '.lan', '.local']);
        expect(dns.rules[1].server).toBe('dns-cn-1');
    });

    it('按 scheme 推导端口与协议字段', () => {
        const dns = buildSingboxDnsConfig(POLICY, { mode: DNS_MODES.POLLUTED });
        const foreign = dns.servers.find(s => s.tag === 'dns-foreign-1');
        expect(foreign.type).toBe('https');
        expect(foreign.server).toBe('1.1.1.1');
        expect(foreign.server_port).toBe(443);
        expect(foreign.path).toBe('/dns-query');
    });

    it('方案 A：servers 不带 detour 字段', () => {
        const dns = buildSingboxDnsConfig(POLICY, { mode: DNS_MODES.CLEAN });
        expect(dns.servers.every(s => s.detour === undefined)).toBe(true);
    });
});

describe('safe-dns 引擎：地址语义校验 resolverHost', () => {
    it.each([
        ['223.5.5.5', '223.5.5.5'],
        ['192.168.1.1', '192.168.1.1'],
        ['https://8.8.8.8/dns-query', 'https://8.8.8.8/dns-query'],
        ['system', 'system']
    ])('放行合法地址 %s', (input, expected) => {
        expect(resolverHost(input)).toBe(expected);
    });

    it.each([
        ['127.0.0.1', '回环'],
        ['0.0.0.0', '全零'],
        ['localhost', '本机名'],
        ['::1', 'IPv6 回环'],
        ['ftp://1.1.1.1', '非法 scheme'],
        ['', '空值']
    ])('拒绝 %s（%s）', input => {
        expect(resolverHost(input)).toBe('');
    });
});

describe('validatePolicyRecord：策略字段校验为 warn 级', () => {
    it('回环地址给出警告但不拦保存', () => {
        const r = validatePolicyRecord({ domestic: ['127.0.0.1'] });
        expect(r.valid).toBe(true);
        expect(r.warnings).toHaveLength(1);
        expect(r.warnings[0]).toContain('127.0.0.1');
    });

    it('非法 scheme 给出警告', () => {
        const r = validatePolicyRecord({ foreign: ['ftp://1.1.1.1'] });
        expect(r.valid).toBe(true);
        expect(r.warnings[0]).toContain('ftp://1.1.1.1');
    });

    it('局域网地址不告警——自由度是我们的卖点', () => {
        expect(validatePolicyRecord({ domestic: ['192.168.1.1'] }).warnings).toEqual([]);
    });

    it('mode 非法值给出警告并说明回落 clean', () => {
        const r = validatePolicyRecord({ mode: 'weird' });
        expect(r.warnings[0]).toContain('clean');
    });

    it('空策略不告警（引擎会回落默认）', () => {
        expect(validatePolicyRecord({}).warnings).toEqual([]);
    });

    it('逗号分隔字符串同样逐项校验', () => {
        const r = validatePolicyRecord({ domestic: '223.5.5.5, 127.0.0.1' });
        expect(r.warnings).toHaveLength(1);
        expect(r.warnings[0]).toContain('127.0.0.1');
    });

    it('system 视为合法，不告警', () => {
        expect(validatePolicyRecord({ domestic: ['system'] }).warnings).toEqual([]);
    });
});

describe('DNS 模板 kind 字段归一化', () => {
    it('缺省 kind 视为 raw，旧模板零迁移', () => {
        const [tpl] = normalizeDnsTemplates([{ name: 'r', clash: 'enable: true' }]);
        expect(tpl.kind).toBe('raw');
        expect(tpl.policy).toBeUndefined();
    });

    it('未知 kind 回落 raw', () => {
        const [tpl] = normalizeDnsTemplates([{ name: 'u', kind: 'weird', clash: 'enable: true' }]);
        expect(tpl.kind).toBe('raw');
    });

    it('raw 模板无任何 DNS 字段时被丢弃（原有行为）', () => {
        expect(normalizeDnsTemplates([{ name: '空' }])).toHaveLength(0);
    });

    it('policy 模板无 DNS 字段仍保留，并清洗 policy 子字段', () => {
        const [tpl] = normalizeDnsTemplates([{
            id: 'p1',
            name: 'pol',
            kind: 'policy',
            policy: { mode: 'CLEAN', domestic: ['223.5.5.5'], foreign: ['udp://8.8.8.8:53'] }
        }]);
        expect(tpl.kind).toBe('policy');
        expect(tpl.policy).toEqual({
            mode: 'clean',
            domestic: ['223.5.5.5'],
            foreign: ['udp://8.8.8.8:53'],
            polluted: []
        });
        expect(tpl.clash).toBe('');
    });

    it('policy 模板缺少 policy 对象时被丢弃', () => {
        expect(normalizeDnsTemplates([{ id: 'p2', kind: 'policy' }])).toHaveLength(0);
    });
});

describe('resolveEffectiveDnsConfig：策略模式合成', () => {
    const policyTemplate = {
        id: 'p1',
        enabled: true,
        kind: 'policy',
        policy: { mode: 'clean', domestic: ['223.5.5.5'], foreign: ['udp://8.8.8.8:53'], polluted: [] },
        clash: '',
        singbox: '',
        surge: '223.5.5.5, system',
        loon: '',
        quanx: ''
    };

    const resolve = (templates, globalId = 'p1') => resolveEffectiveDnsConfig({
        globalDns: { mode: 'template', templateId: globalId },
        templates
    });

    it('返回五个格式字段，形状与手写模式一致', () => {
        expect(Object.keys(resolve([policyTemplate])).sort())
            .toEqual(['clash', 'loon', 'quanx', 'singbox', 'surge']);
    });

    it('clash 字段是可解析的 YAML 且含 fake-ip 与 geosite 分流', () => {
        const dns = yaml.load(resolve([policyTemplate]).clash);
        expect(dns['enhanced-mode']).toBe('fake-ip');
        expect(dns.nameserver).toEqual(['udp://8.8.8.8:53']);
        expect(Object.keys(dns['nameserver-policy']))
            .toEqual(['geosite:private', 'geosite:cn', 'geosite:geolocation-!cn']);
    });

    it('singbox 字段是可解析的 JSON 且含 servers 与 rules', () => {
        const dns = JSON.parse(resolve([policyTemplate]).singbox);
        expect(dns.servers.map(s => s.tag)).toEqual(['dns-cn-1', 'dns-foreign-1']);
        expect(dns.final).toBe('dns-foreign-1');
        expect(dns.rules).toHaveLength(2);
    });

    it('surge / loon / quanx 仍沿用手写内容，未填即留空', () => {
        const r = resolve([policyTemplate]);
        expect(r.surge).toBe('223.5.5.5, system');
        expect(r.loon).toBe('');
        expect(r.quanx).toBe('');
    });

    it('polluted 策略经 resolveEffectiveDnsConfig 后 clash 填充 fallback', () => {
        const polluted = {
            ...policyTemplate,
            policy: { mode: 'polluted', domestic: ['223.5.5.5'], foreign: [], polluted: ['https://1.1.1.1/dns-query'] }
        };
        const dns = yaml.load(resolve([polluted]).clash);
        expect(dns.nameserver).toEqual(['https://1.1.1.1/dns-query']);
        expect(dns.fallback).toEqual(['https://1.1.1.1/dns-query']);
    });

    it('手写模板（kind=raw）路径逐字不变，不走合成', () => {
        const raw = {
            id: 'r1',
            enabled: true,
            kind: 'raw',
            clash: 'enable: true\nnameserver:\n  - 1.1.1.1',
            singbox: '{"servers":[{"tag":"custom","address":"1.1.1.1"}]}',
            surge: '1.1.1.1, system',
            loon: 'system, 1.1.1.1',
            quanx: 'no-ipv6\nserver = 1.1.1.1'
        };
        expect(resolve([raw], 'r1')).toEqual({
            clash: raw.clash,
            singbox: raw.singbox,
            surge: raw.surge,
            loon: raw.loon,
            quanx: raw.quanx
        });
    });

    it('禁用的策略模板不生效', () => {
        expect(resolve([{ ...policyTemplate, enabled: false }])).toBeNull();
    });
});
