import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
    createDefaultState,
    createRegionConfigs,
    applyRecommendedBuckets,
    effectiveSources,
    GROUP_NAMES,
    STATE_HEADER_PREFIX
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

const NON_SINGBOX_BASELINES = Object.freeze({
    clash: '60eaebfd2ad7ade7f9e6bef46470d725d5d06903c879cdbcfdbb103e9f6023b3',
    surge: 'f599274c5a18b67bbe760b08d8ad2e6fdf40c9147d0ad7296df45f00f8db2776',
    loon: 'e47b22135ce4fdfe31b9ebd24f52ca4044f23b830cf8c8f1d71d9da9c0b0ba4d',
    quanx: '0cb52e0372b7e02149685ae7e1aa44fb9044fc2b5cbb8723973e8a5bb84bf523',
    egern: 'f85e22e4ddb664384df73a155c276336f0267457239a569217bbfdbd9cacbb42'
});

const MANAGED_URL_BASELINES = {
    clash: 'c4dfcb5643656538e42c089810585431264b225ff0fd6027c3e755cfd5a6ca6a',
    surge: '6fa3264673e1ecbdb3056650132f49a78420418c23701ca39d386aae230dbec9',
    loon: '35eae51efd81646796861f566d807c58ff5de743ca79ee98061cbf30ab8ca898',
    quanx: '41912bc508ceb7ddeca9a03c863fbedc3c9846e0bea8fc22351dcd990b1dfdbb',
    egern: 'bf8b30acd3c00160f7a4e6bcfd8f8457ee571c4bf4a91a7d38640a0542f63678'
};

/**
 * 生成一份压满输出形态的状态。
 *
 * 默认状态里卡片全在待选栏，正文只有兜底规则，撑不起渲染矩阵 ——
 * 先按推荐落点把内置卡片铺开，再叠用户卡片。
 */
function richState() {
    const state = createDefaultState();
    state.base.fallback = true;
    state.cards = applyRecommendedBuckets(state.cards);

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

/**
 * 取路由到某个策略的规则。
 *
 * 不能用 `endsWith(',策略')` —— IP 类规则的策略之后还跟着 `no-resolve`
 * 修饰符（rule-modifiers.js），按后缀匹配会漏掉它们。
 */
function rulesFor(rules, policy) {
    return rules.filter(rule => rule.split(',').includes(policy));
}

describe('rule-generator render matrix', () => {
    it('preserves the other five renderers with a nonempty managed URL', () => {
        const state = createDefaultState();
        state.cards = applyRecommendedBuckets(state.cards);
        const { ini } = serializeState(state);
        for (const { name, render } of RENDERERS.filter(renderer => renderer.name !== 'singbox')) {
            const output = render(ini, {
                nodeList: 'trojan://p@1.1.1.1:443#Node',
                managedConfigUrl: 'https://misub.example/sub/demo?token=test',
                ruleLevel: 'none', dnsThroughProxy: false
            });
            expect(crypto.createHash('sha256').update(output).digest('hex'), name).toBe(MANAGED_URL_BASELINES[name]);
        }
    });

    it.each(RENDERERS)('$name 渲染不抛错且产出非空', ({ render, name }) => {
        const { ini } = serializeState(richState());
        const output = render(ini, renderParams(name));
        expect(typeof output).toBe('string');
        expect(output.length).toBeGreaterThan(200);
    });

    it('往返注释头不进入任何目标格式的产物 —— 客户端订阅里看不到它', () => {
        const { ini } = serializeState(richState());
        const headerLine = ini.split('\n').find(line => line.startsWith(STATE_HEADER_PREFIX));
        const payload = headerLine.slice(STATE_HEADER_PREFIX.length).trim();

        expect(payload.length).toBeGreaterThan(100);   // 确实带着一大串 base64

        RENDERERS.forEach(({ name, render }) => {
            const output = render(ini, renderParams(name));
            // ini-template-parser.js:10 跳过 `;` 行，注释根本没进模型，
            // 六个渲染器又都是从模型重新拼产物，因此不可能透出去
            expect(output, name).not.toContain(STATE_HEADER_PREFIX);
            expect(output, name).not.toContain('misub-visual-state');
            expect(output, name).not.toContain(payload.slice(0, 40));
        });
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
        const state = richState();
        const config = yaml.load(renderClashFromIniTemplate(
            serializeState(state).ini, renderParams('clash')));

        // 🤖 AI 服务：目录里的多张小卡片合成一个组，条数随目录变化，因此按状态算
        const aiSources = effectiveSources(state.cards, state.cards.find(card => card.id === 'cat-ai'));
        const remoteCount = new Set(aiSources.filter(source => source.kind === 'remote')
            .map(source => source.value)).size;
        const inlineCount = aiSources.filter(source => source.kind === 'inline').length;
        expect(remoteCount).toBeGreaterThan(1);
        expect(inlineCount).toBeGreaterThan(1);

        expect(config['proxy-groups'].filter(group => group.name === '🤖 AI 服务')).toHaveLength(1);
        const aiRules = rulesFor(config.rules, '🤖 AI 服务');
        expect(aiRules).toHaveLength(remoteCount + inlineCount);
        expect(aiRules.filter(rule => rule.startsWith('RULE-SET,'))).toHaveLength(remoteCount);
        expect(aiRules.filter(rule => rule.startsWith('DOMAIN-SUFFIX,'))).toHaveLength(inlineCount);

        // 🎮 我的游戏 = 1 远程 + 2 内联，两个 URL 各建一个 rule-provider
        expect(config['proxy-groups'].filter(group => group.name === '🎮 我的游戏')).toHaveLength(1);
        expect(rulesFor(config.rules, '🎮 我的游戏')).toHaveLength(3);

        // 渲染器按白名单透传 IP 类规则的 no-resolve，见 rule-modifiers.js。
        // 生成器写它（serialize.js 的 formatRuleLine），ini-template-parser.js:82
        // 收进 extras，到这里才真正落进产物。修饰符在**策略之后**：
        // mihomo 的规则形态是 TYPE,VALUE,POLICY[,no-resolve]。
        expect(config.rules).toContain('IP-CIDR,203.0.113.0/24,🎮 我的游戏,no-resolve');
    });

    it('clash：GEOIP,CN 带上 no-resolve —— 兜底流量不再被强制解析', () => {
        const { ini } = serializeState(richState());
        const config = yaml.load(renderClashFromIniTemplate(ini, renderParams('clash')));

        expect(config.rules).toContain(`GEOIP,CN,${GROUP_NAMES.direct},no-resolve`);
        expect(config.rules.some(rule => /^GEOIP,CN,[^,]+$/.test(rule))).toBe(false);
    });

    it('surge / loon / quanx 同样透传 no-resolve', () => {
        const { ini } = serializeState(richState());

        [
            { name: 'surge', render: renderSurgeFromIniTemplate },
            { name: 'loon', render: renderLoonFromIniTemplate },
            { name: 'quanx', render: renderQuanxFromIniTemplate }
        ].forEach(({ name, render }) => {
            const lines = render(ini, renderParams(name)).split('\n').map(line => line.trim());
            const ipCidr = lines.find(line => line.toUpperCase().startsWith('IP-CIDR,203.0.113.0/24'));
            expect(ipCidr, name).toBeTruthy();
            expect(ipCidr, name).toContain('no-resolve');
        });
    });

    // no-resolve 挂在域名规则上是非法语法，部分客户端会整份配置拒绝加载。
    // 渲染器必须按规则类型 gate，不能见到 extras 就拼上去。
    it('域名类规则上的 no-resolve 被丢弃，不透传', () => {
        const state = richState();
        state.cards.push({
            id: 'u3', name: '✳️ 误标的域名卡', parentId: null, origin: 'user',
            bucket: 'proxy', order: -2,
            sources: [{ id: 'u3s1', kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'bad.example.com', noResolve: true }]
        });
        const { ini } = serializeState(state);

        // 生成器照写第三段，透不透传由渲染器决定
        expect(ini).toContain('[]DOMAIN-SUFFIX,bad.example.com,no-resolve');

        const config = yaml.load(renderClashFromIniTemplate(ini, renderParams('clash')));
        expect(config.rules).toContain(`DOMAIN-SUFFIX,bad.example.com,${GROUP_NAMES.proxy}`);
        expect(config.rules.some(rule => rule.startsWith('DOMAIN-SUFFIX,bad.example.com') && rule.includes('no-resolve')))
            .toBe(false);
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

        expect(config.route.final).toBe(GROUP_NAMES.final);
        const ruleSetTags = new Set(config.route.rule_set.map(ruleSet => ruleSet.tag));
        expect(ruleSetTags.size).toBe(config.route.rule_set.length);
        [...config.route.rules, ...config.dns.rules].forEach(rule => {
            if (rule.outbound) expect(tags.has(rule.outbound), rule.outbound).toBe(true);
            (rule.rule_set || []).forEach(tag => expect(ruleSetTags.has(tag), tag).toBe(true));
        });
        config.route.rules.forEach(rule => {
            const matchKeys = Object.keys(rule).filter(key => !['outbound', 'action'].includes(key));
            expect(matchKeys.length, JSON.stringify(rule)).toBeGreaterThan(0);
        });
    });

    it('singbox：以 action reject 替代 block 出站，并清理拒绝成员', () => {
        const { ini } = serializeState(richState());
        const config = JSON.parse(renderSingboxFromIniTemplate(ini, renderParams('singbox')));

        expect(config.outbounds.some(outbound => outbound.type === 'block')).toBe(false);
        expect(config.outbounds.some(outbound => outbound.tag === 'REJECT')).toBe(false);
        config.outbounds.forEach(outbound => {
            if (Array.isArray(outbound.outbounds)) {
                expect(outbound.outbounds).not.toContain('REJECT');
                expect(outbound.outbounds.length, outbound.tag).toBeGreaterThan(0);
            }
        });

        expect(config.route.rules.some(rule => rule.action === 'reject')).toBe(true);
    });

    it.each(RENDERERS)('$name：九种内联规则全部保留在规则段中', ({ name, render }) => {
        const cases = [
            ['DOMAIN', 'exact.example.com'],
            ['DOMAIN-SUFFIX', 'suffix.example.com'],
            ['DOMAIN-KEYWORD', 'keyword-example'],
            ['IP-CIDR', '203.0.113.0/24'],
            ['IP-CIDR6', '2001:db8::/32'],
            ['GEOIP', 'JP'],
            ['GEOSITE', 'private'],
            ['PROCESS-NAME', 'MiSubProbe.exe'],
            ['DST-PORT', '18080']
        ];
        const state = createDefaultState();
        state.cards.push({
            id: 'inline-probe', name: 'Inline Probe', parentId: null, origin: 'user',
            bucket: 'flexible', order: -1,
            sources: cases.map(([ruleType, value], index) => ({
                id: `inline-${index}`, kind: 'inline', ruleType, value
            }))
        });
        const { ini } = serializeState(state);
        const output = render(ini, renderParams(name));
        if (name === 'clash') {
            const config = yaml.load(output);
            cases.forEach(([type, value]) => expect(config.rules).toContain(`${type},${value},Inline Probe`));
            return;
        }
        if (name === 'egern') {
            const config = yaml.load(output);
            cases.forEach(([type, value]) => expect(config.rules).toContainEqual({
                [type.toLowerCase().replace(/-/g, '_')]: { match: value, policy: 'Inline Probe' }
            }));
            return;
        }
        if (name !== 'singbox') {
            const lines = output.split('\n').map(line => line.split(',').map(part => part.trim().toLowerCase()).join(','));
            cases.forEach(([type, value]) => {
                expect(lines).toContain(`${type},${value},Inline Probe`.toLowerCase());
            });
            return;
        }
        const config = JSON.parse(output);
        expect(config.route.rules).toContainEqual({ domain: ['exact.example.com'], outbound: 'Inline Probe' });
        expect(config.route.rules).toContainEqual({ domain_suffix: ['suffix.example.com'], outbound: 'Inline Probe' });
        expect(config.route.rules).toContainEqual({ domain_keyword: ['keyword-example'], outbound: 'Inline Probe' });
        expect(config.route.rules).toContainEqual({ ip_cidr: ['203.0.113.0/24'], outbound: 'Inline Probe' });
        expect(config.route.rules).toContainEqual({ ip_cidr: ['2001:db8::/32'], outbound: 'Inline Probe' });
        expect(config.route.rules).toContainEqual({ rule_set: ['geoip-jp'], outbound: 'Inline Probe' });
        expect(config.route.rules).toContainEqual({ rule_set: ['geosite-private'], outbound: 'Inline Probe' });
        expect(config.route.rules).toContainEqual({ process_name: ['MiSubProbe.exe'], outbound: 'Inline Probe' });
        expect(config.route.rules).toContainEqual({ port: [18080], outbound: 'Inline Probe' });
    });

    it('singbox：Rule 段的远程 URL 会声明 rule_set，跨策略共享同一 tag', () => {
        const url = 'https://example.com/shared.list';
        const ini = [
            '[Proxy Group]',
            'A = select, DIRECT',
            'B = select, DIRECT',
            '[Rule]',
            `RULE-SET,${url},A`,
            `RULE-SET,${url},B`,
            'MATCH,B'
        ].join('\n');
        const config = JSON.parse(renderSingboxFromIniTemplate(ini, renderParams('singbox')));
        const definitions = config.route.rule_set.filter(ruleSet => ruleSet.url === url);
        expect(definitions).toHaveLength(1);
        const references = config.route.rules.filter(rule => Array.isArray(rule.rule_set)
            && rule.rule_set.includes(definitions[0].tag));
        expect(references).toHaveLength(2);
    });

    it('其余五个渲染器产物保持既有字节基线', () => {
        const { ini } = serializeState(richState());
        RENDERERS.filter(({ name }) => name !== 'singbox').forEach(({ name, render }) => {
            const output = render(ini, renderParams(name));
            const digest = crypto.createHash('sha256').update(output).digest('hex');
            expect(digest, name).toBe(NON_SINGBOX_BASELINES[name]);
        });
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

/**
 * 两张非 ACL4SSR 的广告卡片。它们的选型只有一个约束，而这个约束在文件名上看不出来：
 * render-clash.js:103 的 getRuleProviderBehavior() 对非 IP 类一律返回 `classical`，
 * 因此来源文件的每一行必须是 `TYPE,value`。
 *
 * anti-AD 同时发布 `anti-ad-clash.yaml`（payload 是 `'+.domain'`，domain behavior）、
 * `anti-ad-domains.txt`（裸域名）与 `anti-ad-surge2.txt`（Surge DOMAIN-SET）——
 * 名字最像「给 Clash 用」的那个恰恰是唯一不能用的。日后有人「顺手改成官方 clash 格式」
 * 就会把整张清单变成 0 条生效规则，而界面上完全看不出来。这个用例钉住那件事。
 */
describe('广告卡片的来源格式', () => {
    const AD_CARD_IDS = ['ad-anti-ad', 'ad-awavenue'];

    it('来源指向 classical 可解析的文本清单，不是 domain-behavior 的 yaml', () => {
        const cards = createDefaultState().cards;

        AD_CARD_IDS.forEach(id => {
            const card = cards.find(item => item.id === id);
            expect(card, id).toBeTruthy();
            expect(card.parentId).toBe('cat-ad');
            expect(card.sources, id).toHaveLength(1);

            const url = card.sources[0].value;
            expect(url, id).toMatch(/^https:\/\//);
            // .yaml / .yml 一律不行：那是 domain behavior 的形态
            expect(url, id).toMatch(/\.(txt|list)$/);
            expect(url, id).not.toMatch(/\.ya?ml$/);
        });
    });

    it('clash：两张卡片各渲染成一个 classical + text 的 rule-provider', () => {
        const state = createDefaultState();
        state.cards.forEach(card => {
            if (card.id === 'cat-ad' || AD_CARD_IDS.includes(card.id)) card.bucket = 'adblock';
        });

        const config = yaml.load(renderClashFromIniTemplate(
            serializeState(state).ini, renderParams('clash')));

        const urls = AD_CARD_IDS.map(id => state.cards.find(card => card.id === id).sources[0].value);
        const providers = Object.values(config['rule-providers'] || {})
            .filter(provider => urls.includes(provider.url));

        expect(providers).toHaveLength(AD_CARD_IDS.length);
        providers.forEach(provider => {
            expect(provider.behavior).toBe('classical');
            expect(provider.format).toBe('text');
        });

        // 规则行挂在 🛑 广告拦截 上，且两张卡片各一条
        expect(rulesFor(config.rules, GROUP_NAMES.adBlock)
            .filter(rule => rule.startsWith('RULE-SET,')).length).toBeGreaterThanOrEqual(2);
    });

    it('两张卡片默认留在待选栏，也不进推荐预设', () => {
        const cards = createDefaultState().cards;
        AD_CARD_IDS.forEach(id => {
            expect(cards.find(card => card.id === id).bucket, id).toBe('off');
        });

        const recommended = applyRecommendedBuckets(cards);
        AD_CARD_IDS.forEach(id => {
            expect(recommended.find(card => card.id === id).bucket, id).toBe('off');
        });
    });
});
