import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
    createDefaultState,
    createRegionConfigs,
    GROUP_NAMES
} from '../../src/utils/rule-generator/catalog.js';
import { serializeState } from '../../src/utils/rule-generator/serialize.js';
import {
    renderClashFromIniTemplate,
    renderSingboxFromIniTemplate,
    renderSurgeFromIniTemplate,
    renderLoonFromIniTemplate,
    renderQuanxFromIniTemplate,
    renderEgernFromIniTemplate
} from '../../functions/modules/subscription/template-pipeline.js';

/** 覆盖全部预置地区，外加两个不属于任何地区的节点验证「其他地区」。 */
const NODE_LIST = [
    'trojan://p@1.1.1.1:443#香港01',
    'trojan://p@1.1.1.2:443#HK-Premium',
    'trojan://p@1.1.1.3:443#日本东京01',
    'trojan://p@1.1.1.4:443#JP-Osaka',
    'trojan://p@1.1.1.5:443#新加坡01',
    'trojan://p@1.1.1.6:443#US-San Jose',
    'trojan://p@1.1.1.7:443#美国洛杉矶',
    'trojan://p@1.1.1.8:443#德国法兰克福',
    'trojan://p@1.1.1.9:443#土耳其伊斯坦布尔'
].join('\n');

/**
 * main-handler.js:590-591 对 custom 模板强制 ruleLevel='none'。
 * 渲染矩阵必须照此传参，否则测的就不是真实链路（§3.2）。
 */
function renderParams(targetFormat) {
    return {
        nodeList: NODE_LIST,
        fileName: 'MiSub',
        targetFormat,
        ruleLevel: 'none',
        interval: 86400,
        managedConfigUrl: '',
        skipCertVerify: false,
        enableUdp: true,
        isMeta: true
    };
}

const RENDERERS = [
    { name: 'clash', render: renderClashFromIniTemplate },
    { name: 'singbox', render: renderSingboxFromIniTemplate },
    { name: 'surge', render: renderSurgeFromIniTemplate },
    { name: 'loon', render: renderLoonFromIniTemplate },
    { name: 'quanx', render: renderQuanxFromIniTemplate },
    { name: 'egern', render: renderEgernFromIniTemplate }
];

/** 生成一份带用户卡片与优先匹配区的状态，尽量压满生成器的输出形态。 */
function richState() {
    const state = createDefaultState();
    state.base.fallback = true;

    // 用户自定义规则集：一张大卡片 + 三张小卡片，落在灵活桶
    state.cards.push(
        {
            id: 'u1', name: '🎮 我的游戏', parentId: null, origin: 'user',
            bucket: 'flexible', order: -1, sources: []
        },
        {
            id: 'u1c1', name: 'game.list', parentId: 'u1', origin: 'user',
            bucket: 'flexible', order: 0,
            sources: [{ id: 'u1s1', kind: 'remote', value: 'https://example.com/game.list' }]
        },
        {
            id: 'u1c2', name: 'battle.net', parentId: 'u1', origin: 'user',
            bucket: 'flexible', order: 1,
            sources: [{ id: 'u1s2', kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'battle.net' }]
        },
        {
            id: 'u1c3', name: '游戏 IP 段', parentId: 'u1', origin: 'user',
            bucket: 'flexible', order: 2,
            sources: [{ id: 'u1s3', kind: 'inline', ruleType: 'IP-CIDR', value: '203.0.113.0/24', noResolve: true }]
        }
    );

    // 单独一张小卡片直接落进前置修正段
    state.cards.push({
        id: 'u2', name: '✏️ 我的直连', parentId: null, origin: 'user',
        bucket: 'prepend', order: -1,
        sources: [{ id: 'u2s1', kind: 'inline', ruleType: 'DOMAIN', value: 'intranet.example.com' }]
    });

    return state;
}

describe('rule-generator render matrix', () => {
    it.each(RENDERERS)('$name 渲染不抛错且产出非空', ({ render, name }) => {
        const { ini } = serializeState(richState());
        const output = render(ini, renderParams(name));
        expect(typeof output).toBe('string');
        expect(output.length).toBeGreaterThan(200);
    });

    it('clash：策略组无悬空引用，MATCH 末位，地区组存在（§验收 2 / 3 / 5）', () => {
        const { ini } = serializeState(richState());
        const config = yaml.load(renderClashFromIniTemplate(ini, renderParams('clash')));

        const proxyNames = new Set(config.proxies.map(proxy => proxy.name));
        const groupNames = new Set(config['proxy-groups'].map(group => group.name));
        const valid = new Set([...proxyNames, ...groupNames, 'DIRECT', 'REJECT']);

        config['proxy-groups'].forEach(group => {
            group.proxies.forEach(member => {
                expect(valid.has(member), `${group.name} -> ${member}`).toBe(true);
            });
            expect(group.proxies.length, group.name).toBeGreaterThan(0);
        });

        // 地区组存在且真的吸到了节点
        ['🇭🇰 香港节点', '🇯🇵 日本节点', '🇸🇬 狮城节点', '🇺🇸 美国节点', GROUP_NAMES.otherRegion]
            .forEach(name => expect(groupNames.has(name), name).toBe(true));
        const other = config['proxy-groups'].find(group => group.name === GROUP_NAMES.otherRegion);
        // url-to-clash.js:1381 会给节点名补地区旗帜，因此这里按后缀匹配
        expect(other.proxies.some(name => name.endsWith('德国法兰克福'))).toBe(true);
        expect(other.proxies.some(name => name.endsWith('土耳其伊斯坦布尔'))).toBe(true);
        expect(other.proxies.some(name => name.includes('香港'))).toBe(false);

        const rules = config.rules;
        expect(rules[rules.length - 1]).toBe(`MATCH,${GROUP_NAMES.final}`);
        expect(rules.filter(rule => rule.startsWith('MATCH,'))).toHaveLength(1);
    });

    it('clash：一张含 N 个来源的卡片只产出 1 个策略组与 N 条规则（§验收 10）', () => {
        const { ini } = serializeState(richState());
        const config = yaml.load(renderClashFromIniTemplate(ini, renderParams('clash')));

        // 🤖 AI 服务 = 2 远程 + 3 内联
        expect(config['proxy-groups'].filter(group => group.name === '🤖 AI 服务')).toHaveLength(1);
        const aiRules = config.rules.filter(rule => rule.endsWith(',🤖 AI 服务'));
        expect(aiRules).toHaveLength(5);
        expect(aiRules.filter(rule => rule.startsWith('RULE-SET,'))).toHaveLength(2);
        expect(aiRules.filter(rule => rule.startsWith('DOMAIN-SUFFIX,'))).toHaveLength(3);

        // 🎮 我的游戏 = 1 远程 + 2 内联，两个 URL 各建一个 rule-provider
        expect(config['proxy-groups'].filter(group => group.name === '🎮 我的游戏')).toHaveLength(1);
        expect(config.rules.filter(rule => rule.endsWith(',🎮 我的游戏'))).toHaveLength(3);

        // 宿主的六个渲染器都不透传规则 extras（render-clash.js:110-119 的 mapRule
        // 只输出 type/value/policy），因此 INI 里的 no-resolve 被静默丢弃。
        // 生成器仍照写 —— 它保留在往返状态里，且让模板在 subconverter 等
        // 支持该修饰符的转换器下仍然正确。此处固定该已知行为。
        expect(config.rules).toContain('IP-CIDR,203.0.113.0/24,🎮 我的游戏');
        expect(config.rules.some(rule => rule.includes('no-resolve'))).toBe(false);
    });

    it('clash：远程来源转成 rule-providers，URL 各自独立（§2.2）', () => {
        const { ini } = serializeState(richState());
        const config = yaml.load(renderClashFromIniTemplate(ini, renderParams('clash')));

        const providers = config['rule-providers'] || {};
        expect(Object.keys(providers).length).toBeGreaterThan(5);
        Object.values(providers).forEach(provider => {
            expect(provider.type).toBe('http');
            expect(provider.url).toMatch(/^https?:\/\//);
            expect(['domain', 'ipcidr', 'classical']).toContain(provider.behavior);
        });

        // 自填 URL 不命中 ACL4SSR 映射表，一律 classical（§4.3）
        const custom = Object.values(providers).find(provider => provider.url === 'https://example.com/game.list');
        expect(custom.behavior).toBe('classical');
    });

    it('clash：桶组成员不含地区组枚举，🎯 全球直连 首位为 DIRECT（§验收 8 / 9）', () => {
        const { ini } = serializeState(richState());
        const config = yaml.load(renderClashFromIniTemplate(ini, renderParams('clash')));
        const byName = new Map(config['proxy-groups'].map(group => [group.name, group]));

        const regionNames = ['🇭🇰 香港节点', '🇯🇵 日本节点', '🇸🇬 狮城节点', '🇺🇸 美国节点', GROUP_NAMES.otherRegion];
        [GROUP_NAMES.proxy, GROUP_NAMES.direct, GROUP_NAMES.final].forEach(name => {
            regionNames.forEach(region => {
                expect(byName.get(name).proxies, `${name} 不应含 ${region}`).not.toContain(region);
            });
        });

        expect(byName.get(GROUP_NAMES.direct).proxies[0]).toBe('DIRECT');

        // 出口不再绑在卡片上：灵活桶各组一律以 🚀 节点选择 打头，
        // 由用户在客户端里自行选择走哪个地区
        expect(byName.get('🎮 我的游戏').proxies[0]).toBe(GROUP_NAMES.nodeSelect);
        expect(byName.get('🤖 AI 服务').proxies[0]).toBe(GROUP_NAMES.nodeSelect);
        expect(byName.get('🎮 我的游戏').proxies).toEqual(byName.get('🤖 AI 服务').proxies);
    });

    it('clash：🛑 广告拦截 组为 REJECT / DIRECT / 🚀 节点选择，桶为空时整组消失', () => {
        const withAd = yaml.load(renderClashFromIniTemplate(
            serializeState(richState()).ini, renderParams('clash')));
        const adGroup = withAd['proxy-groups'].find(group => group.name === GROUP_NAMES.adBlock);
        expect(adGroup.proxies).toEqual(['REJECT', 'DIRECT', GROUP_NAMES.nodeSelect]);
        expect(withAd.rules.some(rule => rule.endsWith(`,${GROUP_NAMES.adBlock}`))).toBe(true);

        const emptied = richState();
        emptied.cards.filter(item => item.bucket === 'adblock').forEach(item => { item.bucket = 'off'; });
        const withoutAd = yaml.load(renderClashFromIniTemplate(
            serializeState(emptied).ini, renderParams('clash')));
        expect(withoutAd['proxy-groups'].map(group => group.name)).not.toContain(GROUP_NAMES.adBlock);
        expect(withoutAd.rules.some(rule => rule.endsWith(`,${GROUP_NAMES.adBlock}`))).toBe(false);
    });

    it('clash：0 命中地区组被自动剪除，而非降级为 DIRECT（§验收 5）', () => {
        const state = createDefaultState();
        state.base.regions = createRegionConfigs(['hk', 'kr']);   // 韩国无对应节点

        const config = yaml.load(renderClashFromIniTemplate(
            serializeState(state).ini, renderParams('clash')));
        const groupNames = config['proxy-groups'].map(group => group.name);

        expect(groupNames).toContain('🇭🇰 香港节点');
        expect(groupNames).not.toContain('🇰🇷 韩国节点');
        // 剪除后不留悬空引用
        config['proxy-groups'].forEach(group => {
            expect(group.proxies).not.toContain('🇰🇷 韩国节点');
        });
    });

    it('surge / loon / quanx：FINAL 恒在规则末位（§验收 3）', () => {
        const { ini } = serializeState(richState());

        [
            { name: 'surge', render: renderSurgeFromIniTemplate },
            { name: 'loon', render: renderLoonFromIniTemplate },
            { name: 'quanx', render: renderQuanxFromIniTemplate }
        ].forEach(({ name, render }) => {
            const output = render(ini, renderParams(name));
            const finals = output.split('\n')
                .map(line => line.trim())
                .filter(line => line.startsWith('FINAL,'));
            expect(finals, name).toHaveLength(1);
            expect(finals[0], name).toContain(GROUP_NAMES.final);
        });
    });

    it('singbox：输出合法 JSON，route.final 有效，无悬空 outbound 引用', () => {
        const { ini } = serializeState(richState());
        const config = JSON.parse(renderSingboxFromIniTemplate(ini, renderParams('singbox')));

        const tags = new Set(config.outbounds.map(outbound => outbound.tag));
        expect(tags.has(config.route.final)).toBe(true);

        config.outbounds
            .filter(outbound => Array.isArray(outbound.outbounds))
            .forEach(outbound => {
                outbound.outbounds.forEach(member => {
                    expect(tags.has(member), `${outbound.tag} -> ${member}`).toBe(true);
                });
                expect(outbound.outbounds.length, outbound.tag).toBeGreaterThan(0);
            });

        // §10 已知偏差：route.final 取 groups[0]，即 🚀 节点选择，而非 🐟 漏网之鱼
        expect(config.route.final).toBe(GROUP_NAMES.nodeSelect);
    });

    it('egern：输出合法 YAML 且含策略组', () => {
        const { ini } = serializeState(richState());
        const config = yaml.load(renderEgernFromIniTemplate(ini, renderParams('egern')));
        expect(config).toBeTruthy();
        expect(JSON.stringify(config)).toContain(GROUP_NAMES.nodeSelect);
    });

    it('六个渲染器都不产生 (?i) 残留；反向前瞻只出现在 clash 的惰性 filter 字段（§3.1）', () => {
        const { ini } = serializeState(richState());

        RENDERERS.forEach(({ name, render }) => {
            const output = render(ini, renderParams(name));
            // (?i) 会让 template-processor.js:24 的 new RegExp 抛错、该组被静默剪除
            expect(output, name).not.toContain('(?i)');
        });

        // render-clash.js:190 把 filters 原样写进 filter 字段，这是既有行为
        // （内置预设的 ♻️ 自动选择 同样输出 filter: ".*"）。mihomo 用
        // dlclark/regexp2 编译该字段，支持前瞻；且 proxies 已显式展开、
        // include-all 未开启，filter 对成员集合不再产生影响。
        const config = yaml.load(renderClashFromIniTemplate(ini, renderParams('clash')));
        const withLookahead = config['proxy-groups'].filter(group =>
            typeof group.filter === 'string' && group.filter.includes('(?!'));
        expect(withLookahead.map(group => group.name)).toEqual([GROUP_NAMES.otherRegion]);

        // 前瞻绝不能外泄到规则或成员名里
        config.rules.forEach(rule => expect(rule).not.toContain('(?!'));
        config['proxy-groups'].forEach(group =>
            group.proxies.forEach(member => expect(member).not.toContain('(?!')));
    });
});
