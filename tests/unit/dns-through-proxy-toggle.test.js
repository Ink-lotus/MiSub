import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { DNS_PROXY_GROUP } from '../../shared/safe-dns.js';
import { createDefaultState } from '../../src/utils/rule-generator/catalog.js';
import { serializeState } from '../../src/utils/rule-generator/serialize.js';
import { resolveEffectiveDnsConfig } from '../../functions/modules/dns-template-handler.js';
import { resolveDnsThroughProxy } from '../../functions/modules/subscription/main-handler.js';
import { generateBuiltinClashConfig } from '../../functions/modules/subscription/builtin-clash-generator.js';
import { generateBuiltinSingboxConfig } from '../../functions/modules/subscription/builtin-singbox-generator.js';
import { generateBuiltinSurgeConfig } from '../../functions/modules/subscription/builtin-surge-generator.js';
import { generateBuiltinLoonConfig } from '../../functions/modules/subscription/builtin-loon-generator.js';
import { generateBuiltinQuanxConfig } from '../../functions/modules/subscription/builtin-quanx-generator.js';
import {
    renderClashFromIniTemplate,
    renderSingboxFromIniTemplate,
    renderSurgeFromIniTemplate,
    renderLoonFromIniTemplate,
    renderQuanxFromIniTemplate
} from '../../functions/modules/subscription/template-pipeline.js';

const NODE = 'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@1.2.3.4:8388#HK-Test';
const INI_TEMPLATE = [
    '[custom]',
    'ruleset=🚀 节点选择,[]GEOIP,CN',
    'custom_proxy_group=🚀 节点选择`select`.*',
    'enable_rule_generator=true',
    ''
].join('\n');

/** 该组存在与被引用必须同真同假：存在但无人引用是死组，被引用但不存在是坏配置 */
function clashConsistency(text) {
    const config = yaml.load(text);
    const exists = (config['proxy-groups'] || []).some(group => group?.name === DNS_PROXY_GROUP);
    const references = JSON.stringify(config.dns || {}).split(DNS_PROXY_GROUP).length - 1;
    return { exists, references, consistent: exists === (references > 0), config };
}

function singboxConsistency(text) {
    const config = JSON.parse(text);
    const exists = (config.outbounds || []).some(outbound => outbound?.tag === DNS_PROXY_GROUP);
    const detours = (config.dns?.servers || []).filter(server => server.detour === DNS_PROXY_GROUP).length;
    const downloads = (config.route?.rule_set || []).filter(item => item.download_detour === DNS_PROXY_GROUP).length;
    const references = detours + downloads;
    return { exists, references, consistent: exists === (references > 0), config };
}

const countGroupMentions = text => text.split('\n').filter(line => line.includes(DNS_PROXY_GROUP)).length;

describe('resolveDnsThroughProxy：取值优先级', () => {
    it('Profile 显式设置优先于全局', () => {
        expect(resolveDnsThroughProxy({ throughProxy: false }, { throughProxy: true })).toBe(false);
        expect(resolveDnsThroughProxy({ throughProxy: true }, { throughProxy: false })).toBe(true);
    });

    it('Profile 没有该键时跟随全局，而不是当成关闭', () => {
        expect(resolveDnsThroughProxy({ mode: 'global' }, { throughProxy: false })).toBe(false);
        expect(resolveDnsThroughProxy({ mode: 'global' }, { throughProxy: true })).toBe(true);
        expect(resolveDnsThroughProxy(undefined, { throughProxy: false })).toBe(false);
    });

    it('两侧都没有该键时默认开——存量配置行为不变', () => {
        expect(resolveDnsThroughProxy(undefined, undefined)).toBe(true);
        expect(resolveDnsThroughProxy({}, {})).toBe(true);
        expect(resolveDnsThroughProxy({ mode: 'builtin', templateId: '' }, { mode: 'builtin', templateId: '' })).toBe(true);
    });

    it('只认布尔值，字符串等真值不生效', () => {
        expect(resolveDnsThroughProxy({ throughProxy: 'false' }, { throughProxy: false })).toBe(false);
        expect(resolveDnsThroughProxy({ throughProxy: null }, { throughProxy: false })).toBe(false);
    });
});

describe('DNS 走代理开关：内置生成器', () => {
    it('开启（默认）时 clash 创建隐藏组且 dns 引用它', () => {
        const { exists, references, consistent, config } = clashConsistency(generateBuiltinClashConfig(NODE));
        expect(exists).toBe(true);
        expect(references).toBeGreaterThan(0);
        expect(consistent).toBe(true);
        // hidden 让 mihomo 面板不展示这个实现细节组
        expect(config['proxy-groups'].find(group => group.name === DNS_PROXY_GROUP).hidden).toBe(true);
    });

    it('关闭时 clash 既不创建该组也不引用它', () => {
        const { exists, references, consistent } = clashConsistency(
            generateBuiltinClashConfig(NODE, { dnsThroughProxy: false })
        );
        expect(exists).toBe(false);
        expect(references).toBe(0);
        expect(consistent).toBe(true);
    });

    it('开启时 sing-box 创建出站，dns detour 与 rule_set download_detour 都绑上', () => {
        const { exists, references, consistent } = singboxConsistency(
            generateBuiltinSingboxConfig(NODE, { ruleLevel: 'std' })
        );
        expect(exists).toBe(true);
        expect(references).toBeGreaterThan(0);
        expect(consistent).toBe(true);
    });

    it('关闭时 sing-box 不创建出站，且不留 detour / download_detour 悬空引用', () => {
        const { exists, references, consistent } = singboxConsistency(
            generateBuiltinSingboxConfig(NODE, { ruleLevel: 'std', dnsThroughProxy: false })
        );
        expect(exists).toBe(false);
        expect(references).toBe(0);
        expect(consistent).toBe(true);
    });

    it.each([
        ['surge', generateBuiltinSurgeConfig],
        ['loon', generateBuiltinLoonConfig],
        ['quanx', generateBuiltinQuanxConfig]
    ])('%s 的 DNS 配置位不能绑策略组，无论开关都不产出该组', (_name, generate) => {
        expect(countGroupMentions(generate(NODE))).toBe(0);
        expect(countGroupMentions(generate(NODE, { dnsThroughProxy: false }))).toBe(0);
    });
});

describe('DNS 走代理开关：模板渲染路径', () => {
    const options = extra => ({ nodeList: NODE, ruleLevel: 'std', ...extra });

    it('开启（默认）时 clash 模板注入该组且 dns 引用它', () => {
        const { exists, references, consistent } = clashConsistency(
            renderClashFromIniTemplate(INI_TEMPLATE, options())
        );
        expect(exists).toBe(true);
        expect(references).toBeGreaterThan(0);
        expect(consistent).toBe(true);
    });

    it('关闭时 clash 模板不注入该组', () => {
        const { exists, references, consistent } = clashConsistency(
            renderClashFromIniTemplate(INI_TEMPLATE, options({ dnsThroughProxy: false }))
        );
        expect(exists).toBe(false);
        expect(references).toBe(0);
        expect(consistent).toBe(true);
    });

    it('sing-box 模板路径两种开关下都自洽', () => {
        expect(singboxConsistency(renderSingboxFromIniTemplate(INI_TEMPLATE, options())).consistent).toBe(true);
        expect(singboxConsistency(
            renderSingboxFromIniTemplate(INI_TEMPLATE, options({ dnsThroughProxy: false }))
        ).consistent).toBe(true);
    });

    it.each([
        ['surge', renderSurgeFromIniTemplate],
        ['loon', renderLoonFromIniTemplate],
        ['quanx', renderQuanxFromIniTemplate]
    ])('%s 模板路径不注入该组，避免死组', (_name, render) => {
        expect(countGroupMentions(render(INI_TEMPLATE, options()))).toBe(0);
        expect(countGroupMentions(render(INI_TEMPLATE, options({ dnsThroughProxy: false })))).toBe(0);
    });
});

describe('DNS 走代理开关：与策略模板叠加', () => {
    const policyTemplate = {
        id: 'p1',
        name: '策略',
        enabled: true,
        kind: 'policy',
        policy: { mode: 'clean', domestic: ['223.5.5.5'], foreign: ['8.8.8.8'], polluted: [] }
    };

    const build = dnsThroughProxy => {
        // 策略模板合成的 dns 会整块替换生成器产出的 dns，两者必须用同一个开关值
        const customDns = resolveEffectiveDnsConfig({
            globalDns: { mode: 'template', templateId: 'p1' },
            templates: [policyTemplate],
            dnsThroughProxy
        });
        return clashConsistency(generateBuiltinClashConfig(NODE, { dnsThroughProxy, customDns }));
    };

    it('开启时策略模板合成的 dns 带后缀，且该组确实存在', () => {
        const { exists, references, consistent, config } = build(true);
        expect(exists).toBe(true);
        expect(references).toBeGreaterThan(0);
        expect(consistent).toBe(true);
        expect(config.dns.nameserver).toEqual([`udp://8.8.8.8:53#${DNS_PROXY_GROUP}`]);
    });

    it('关闭时策略模板合成的 dns 不带后缀，也没有该组', () => {
        const { exists, references, consistent, config } = build(false);
        expect(exists).toBe(false);
        expect(references).toBe(0);
        expect(consistent).toBe(true);
        expect(config.dns.nameserver).toEqual(['udp://8.8.8.8:53']);
    });
});

/**
 * 「策略组 = 卡片派生」不变量：可视化规则生成器的产出里，客户端看到的策略组
 * 必须与生成器自报的一致。DNS 走代理时复用已有入口组而不插专用组，正是为此。
 *
 * 生产口径：规则模板 → templateSource.kind='custom' → ruleLevel='none'
 * + cardDerivedGroups=true（见 processor-service.js 的 renderParams）。
 */
describe('策略组 = 卡片派生：生成器产出的组数与自报一致', () => {
    // 覆盖默认启用的各地区，否则 pruneEmptyGroups 会因无匹配节点剪掉地区组，
    // 那是另一条正当的减少路径，会掩盖本用例要测的「多出一个组」
    const REGION_NODES = ['🇭🇰 HK', '🇹🇼 TW', '🇸🇬 SG', '🇯🇵 JP', '🇺🇸 US', '🇰🇷 KR', '🇩🇪 DE']
        .map((name, index) => `ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@1.1.1.${index + 1}:8388#${name}-01`)
        .join('\n');

    const generated = () => serializeState(createDefaultState());
    const declaredGroupNames = ini => [...ini.matchAll(/^custom_proxy_group=([^`]+)`/gm)].map(match => match[1]);

    const renderGenerated = (ini, dnsThroughProxy) => renderClashFromIniTemplate(ini, {
        nodeList: REGION_NODES,
        ruleLevel: 'none',
        dnsThroughProxy,
        cardDerivedGroups: true
    });

    it.each([[true], [false]])('dnsThroughProxy=%s 时产出的组与 INI 声明的逐个对应', dnsThroughProxy => {
        const { ini, groupCount } = generated();
        const declared = declaredGroupNames(ini);
        const emitted = (yaml.load(renderGenerated(ini, dnsThroughProxy))['proxy-groups'] || [])
            .map(group => group.name);

        expect(declared).toHaveLength(groupCount);
        expect(emitted).toEqual(declared);
        expect(emitted).not.toContain(DNS_PROXY_GROUP);
    });

    it('走代理时 DNS 绑到入口组 🚀 节点选择，该组由卡片派生且确实存在', () => {
        const { ini } = generated();
        const config = yaml.load(renderGenerated(ini, true));
        const entryGroup = '🚀 节点选择';

        expect(config.dns.nameserver.every(value => value.endsWith(`#${entryGroup}`))).toBe(true);
        expect((config['proxy-groups'] || []).some(group => group.name === entryGroup)).toBe(true);
        // 国内解析器要直连，不跟着绑
        expect(config.dns['nameserver-policy']['geosite:cn'].every(value => !value.includes('#'))).toBe(true);
    });

    it('sing-box 侧同样复用入口组，不产出 DNS 出口出站', () => {
        const { ini } = generated();
        const config = JSON.parse(renderSingboxFromIniTemplate(ini, {
            nodeList: REGION_NODES, ruleLevel: 'none', cardDerivedGroups: true
        }));

        expect((config.outbounds || []).some(o => o.tag === DNS_PROXY_GROUP)).toBe(false);
        expect(config.dns.servers.find(s => s.tag === 'dns-foreign-1').detour).toBe('🚀 节点选择');
        expect((config.route.rule_set || []).every(item => item.download_detour === '🚀 节点选择')).toBe(true);
    });

    it('非卡片派生的模板（内置 / 远程 INI）仍用专用组，不改上游行为', () => {
        const config = yaml.load(renderClashFromIniTemplate(INI_TEMPLATE, {
            nodeList: NODE, ruleLevel: 'std'
        }));
        expect((config['proxy-groups'] || []).some(group => group.name === DNS_PROXY_GROUP)).toBe(true);
        expect(JSON.stringify(config.dns)).toContain(DNS_PROXY_GROUP);
    });

    it('卡片派生但入口组被删掉时退回专用组，绝不引用不存在的组', () => {
        // 高级模式里手写、把 🚀 节点选择 删了的极端情况
        const noEntry = [
            '[custom]',
            'custom_proxy_group=🐟 漏网之鱼`select`.*`[]DIRECT',
            'ruleset=🐟 漏网之鱼,[]FINAL',
            ''
        ].join('\n');
        const { exists, references, consistent } = clashConsistency(
            renderClashFromIniTemplate(noEntry, { nodeList: NODE, ruleLevel: 'none', cardDerivedGroups: true })
        );
        expect(exists).toBe(true);
        expect(references).toBeGreaterThan(0);
        expect(consistent).toBe(true);
    });
});
