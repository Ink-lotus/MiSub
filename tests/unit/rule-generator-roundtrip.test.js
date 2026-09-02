import { describe, expect, it } from 'vitest';
import {
    createDefaultState,
    createRegionConfigs,
    applyRecommendedBuckets,
    BUILTIN_CARDS,
    GROUP_NAMES,
    STATE_HEADER_PREFIX
} from '../../src/utils/rule-generator/catalog.js';
import { serializeState } from '../../src/utils/rule-generator/serialize.js';
import { parseIniToState } from '../../src/utils/rule-generator/parse.js';

/** 归一化 INI 用于比较：去注释头、空行与行尾空白。 */
function normalize(ini) {
    return ini.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith(';'))
        .join('\n');
}

function stripHeader(ini) {
    return ini.split('\n').filter(line => !line.startsWith(STATE_HEADER_PREFIX)).join('\n');
}

/**
 * 默认状态里卡片全在待选栏、正文只有兜底规则，反推路径无从发挥。
 * 因此凡是测反推的用例都用「按推荐落点铺开」的状态当底座。
 */
function recommendedState() {
    const state = createDefaultState();
    state.cards = applyRecommendedBuckets(state.cards);
    return state;
}

/** 注释头里的 JSON。 */
function decodeHeader(ini) {
    const line = ini.split('\n').find(item => item.startsWith(STATE_HEADER_PREFIX));
    const payload = line.slice(STATE_HEADER_PREFIX.length).trim();
    return JSON.parse(new TextDecoder().decode(
        Uint8Array.from(atob(payload), char => char.charCodeAt(0))));
}

/** 与 serialize.js 的 toBase64 同口径，供构造历史格式的注释头使用。 */
function encodeUtf8Base64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 1) {
        binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
}

describe('rule-generator roundtrip', () => {
    it('注释头路径无损：state → INI → state 完全一致（§4.5）', () => {
        const state = createDefaultState();
        const { ini } = serializeState(state);
        const result = parseIniToState(ini);

        expect(result.source).toBe('header');
        expect(result.partial).toBe(false);
        expect(result.drifted).toBe(false);
        expect(result.warnings).toEqual([]);
        expect(result.state).toEqual(state);
        // 再序列化必须逐字节相同
        expect(serializeState(result.state).ini).toBe(ini);
    });

    it('含用户自定义规则集（大卡片 + 小卡片）的状态往返幂等', () => {
        const state = createDefaultState();
        state.base.fallback = true;

        // 一张用户大卡片 + 两张小卡片，模拟顶栏提交的自定义规则集
        state.cards.unshift(
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
                id: 'u1c2', name: 'DOMAIN-SUFFIX battle.net', parentId: 'u1', origin: 'user',
                bucket: 'flexible', order: 1,
                sources: [{ id: 'u1s2', kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'battle.net' }]
            }
        );

        const { ini } = serializeState(state);
        const first = parseIniToState(ini);
        expect(first.state).toEqual(state);

        const second = parseIniToState(serializeState(first.state).ini);
        expect(second.state).toEqual(state);
        expect(serializeState(second.state).ini).toBe(ini);
    });

    it('注释头缺失时按正文反推，INI 层面等价且 partial 标记为真（§A3）', () => {
        const { ini } = serializeState(recommendedState());
        const body = stripHeader(ini);

        const result = parseIniToState(body);
        expect(result.source).toBe('body');
        expect(result.partial).toBe(true);
        expect(result.drifted).toBe(false);
        expect(result.warnings).toHaveLength(1);

        // 反推有损（卡片 id / category 等还原不出），但生成的 INI 必须等价
        const regenerated = serializeState(result.state, { includeHeader: false }).ini;
        expect(normalize(regenerated)).toBe(normalize(body));
    });

    it('反推结果二次往返稳定，不逐轮漂移', () => {
        const body = stripHeader(serializeState(recommendedState()).ini);
        const first = parseIniToState(body).state;
        const firstIni = serializeState(first, { includeHeader: false }).ini;

        const second = parseIniToState(firstIni).state;
        expect(serializeState(second, { includeHeader: false }).ini).toBe(firstIni);
    });

    it('反推还原基础组、局域网直连开关与地区勾选', () => {
        const state = createDefaultState();
        state.base.manualSelect = false;
        state.base.fallback = true;
        state.base.regions = createRegionConfigs(['hk', 'tw']);
        state.headModifiers = { localAreaNetwork: true };

        const recovered = parseIniToState(stripHeader(serializeState(state).ini)).state;

        expect(recovered.base.manualSelect).toBe(false);
        expect(recovered.base.autoSelect).toBe(true);
        expect(recovered.base.fallback).toBe(true);
        expect(recovered.headModifiers).toEqual({ localAreaNetwork: true });
        expect(recovered.base.regions.filter(region => region.enabled).map(region => region.id))
            .toEqual(['hk', 'tw']);
    });

    it('反推保留未被正文提到的小卡片来源，不留空壳', () => {
        const recovered = parseIniToState(stripHeader(serializeState(recommendedState()).ini)).state;

        // 这是曾经的 bug：正文没提到的内置卡片被清空 sources，
        // 在左栏看着正常、一拖进桶就报「没有任何来源」
        const emptyChildren = recovered.cards.filter(card =>
            card.parentId !== null && (card.sources || []).length === 0);
        expect(emptyChildren).toEqual([]);

        // 推荐落点里不含的小卡片留在待选栏，但来源仍在
        const hbo = recovered.cards.find(card => card.id === 'hbo');
        expect(hbo.bucket).toBe('off');
        expect(hbo.sources).toHaveLength(1);
    });

    it('反推保持大卡片与小卡片的同桶关系', () => {
        const recovered = parseIniToState(stripHeader(serializeState(recommendedState()).ini)).state;

        const parent = recovered.cards.find(card => card.id === 'cat-direct-exception');
        expect(parent.bucket).toBe('prepend');
        expect(parent.sources).toEqual([]);          // 大卡片自身恒无来源

        const lit = recovered.cards.filter(card => card.parentId === 'cat-direct-exception');
        const active = lit.filter(card => card.bucket === 'prepend');
        expect(active.map(card => card.id).sort()).toEqual(['ad-unban', 'google-cn', 'steam-cn']);
    });

    it('手改过正文的模板以正文为准并报漂移，不静默覆盖（§10）', () => {
        const state = createDefaultState();
        const { ini } = serializeState(state);
        const handEdited = ini.replace(
            `ruleset=${GROUP_NAMES.final},[]FINAL`,
            `ruleset=${GROUP_NAMES.proxy},[]DOMAIN-SUFFIX,manual.example\nruleset=${GROUP_NAMES.final},[]FINAL`
        );

        const result = parseIniToState(handEdited);
        expect(result.drifted).toBe(true);
        expect(result.partial).toBe(true);
        expect(result.source).toBe('body');
        expect(result.warnings[0]).toContain('正文');

        // 手改的那条规则必须留在反推结果里
        const manual = result.state.cards.find(item => item.origin === 'user');
        expect(manual.bucket).toBe('proxy');
        expect(manual.sources).toEqual([
            { id: expect.any(String), kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'manual.example' }
        ]);
    });

    it('注释头损坏或版本不符时退回正文反推', () => {
        const body = stripHeader(serializeState(recommendedState()).ini);

        const broken = parseIniToState(`${STATE_HEADER_PREFIX} !!!not-base64!!!\n${body}`);
        expect(broken.source).toBe('body');
        expect(broken.partial).toBe(true);

        const futureVersion = parseIniToState(`${STATE_HEADER_PREFIX} ${btoa(JSON.stringify({ version: 99 }))}\n${body}`);
        expect(futureVersion.source).toBe('body');
        expect(futureVersion.warnings[0]).toContain('无法识别');
    });

    it('空模板返回默认状态而非报错', () => {
        const result = parseIniToState('');
        expect(result.source).toBe('default');
        expect(result.partial).toBe(false);
        expect(result.state).toEqual(createDefaultState());
    });

    it('未动过的初始骨架直接给默认状态，不挂「结果可能有损」的警告', () => {
        // 新建模板的初始正文就是这个：默认状态、不带注释头
        const skeleton = serializeState(createDefaultState(), { includeHeader: false }).ini;

        const result = parseIniToState(skeleton);
        expect(result.source).toBe('default');
        expect(result.partial).toBe(false);
        expect(result.drifted).toBe(false);
        expect(result.warnings).toEqual([]);
        expect(result.state).toEqual(createDefaultState());
    });

    it('注释头里的内置卡片只记与目录的差异，体积不随目录膨胀', () => {
        const header = decodeHeader(serializeState(createDefaultState()).ini);

        // 一字未改的内置卡片压成一个 id 字符串
        expect(header.cards).toHaveLength(BUILTIN_CARDS.length);
        expect(header.cards.every(entry => typeof entry === 'string')).toBe(true);

        // 改过桶的那张只多记一个 bucket 字段
        const moved = createDefaultState();
        moved.cards.find(card => card.id === 'telegram').bucket = 'proxy';
        const movedHeader = decodeHeader(serializeState(moved).ini);
        expect(movedHeader.cards).toContainEqual({ id: 'telegram', bucket: 'proxy' });

        // 78 张卡片的目录，默认状态的注释头仍在 4 KB 以内（全量写法约 31 KB）
        const headerLine = serializeState(createDefaultState()).ini.split('\n')[0];
        expect(headerLine.length).toBeLessThan(4096);
    });

    it('v1 的全量注释头仍能读，读出来即归一到当前版本', () => {
        const state = recommendedState();
        const legacy = `${STATE_HEADER_PREFIX} ${encodeUtf8Base64(
            JSON.stringify({ ...state, version: 1 }))}\n`
            + stripHeader(serializeState(state).ini);

        const result = parseIniToState(legacy);
        expect(result.source).toBe('header');
        expect(result.partial).toBe(false);
        expect(result.state).toEqual(state);
    });
});

/**
 * 反推时的卡片同名问题。
 *
 * 起因是旧的「新建模板」初始正文：它的 `📲 电报消息` 组用的是 ACL4SSR 的
 * root 路径 `Clash/Telegram.list`，与目录里的 `Clash/Ruleset/Telegram.list`
 * 字面不同，反推时既认不出来、又按组名建了一张用户卡片 —— 界面上于是出现
 * 两张「📲 电报消息」。同名卡片一起进灵活桶还会被 dedupeGroupsByName 静默合并。
 */
describe('rule-generator 反推：卡片不同名', () => {
    const ACL = 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash';

    /** 拼一份最小的手写模板。 */
    function iniWith(...ruleLines) {
        return ['[custom]', ...ruleLines, `ruleset=${GROUP_NAMES.final},[]FINAL`, '',
            `custom_proxy_group=${GROUP_NAMES.nodeSelect}\`select\`[]DIRECT`, ''].join('\n');
    }

    function namesOf(state) {
        return state.cards.map(card => card.name);
    }

    it('组名撞上内置小卡片名时接管那张卡片，不另建同名用户卡片', () => {
        // 旧默认模板的写法：组名与目录里某张卡片同名，URL 却是另一条
        const { state } = parseIniToState(iniWith(`ruleset=📲 Telegram 电报,${ACL}/Telegram.list`));

        const named = state.cards.filter(card => card.name === '📲 Telegram 电报');
        expect(named).toHaveLength(1);

        // 接管的就是内置那张，且以正文为准换成正文里的 URL
        expect(named[0].id).toBe('telegram');
        expect(named[0].bucket).toBe('flexible');
        expect(named[0].sources.map(source => source.value)).toEqual([`${ACL}/Telegram.list`]);

        // 父卡片不跟进来 —— 它一跟进来就得改叫同一个名字
        expect(state.cards.find(card => card.id === 'cat-social').bucket).toBe('off');

        // 组名原样还原
        const regenerated = serializeState(state, { includeHeader: false }).ini;
        expect(regenerated).toContain(`ruleset=📲 Telegram 电报,${ACL}/Telegram.list`);
        expect(regenerated).toContain('custom_proxy_group=📲 Telegram 电报`select`');
    });

    it('组名撞上内置大卡片名时接管大卡片，来源挂到它下面的小卡片上', () => {
        const { state } = parseIniToState(iniWith('ruleset=🤖 AI 服务,https://example.com/my-ai.list'));

        expect(namesOf(state).filter(name => name === '🤖 AI 服务')).toHaveLength(1);

        const parent = state.cards.find(card => card.id === 'cat-ai');
        expect(parent.bucket).toBe('flexible');
        expect(parent.sources).toEqual([]);          // 大卡片自身恒无来源

        const holder = state.cards.find(card => card.parentId === 'cat-ai' && card.origin === 'user');
        expect(holder.bucket).toBe('flexible');
        expect(holder.sources.map(source => source.value)).toEqual(['https://example.com/my-ai.list']);

        // 目录里的 AI 小卡片没被点亮，因此只输出正文那一条
        const regenerated = serializeState(state, { includeHeader: false }).ini;
        expect(regenerated).toContain('ruleset=🤖 AI 服务,https://example.com/my-ai.list');
    });

    it('命中的小卡片其组名就是自己的名字时不把父卡片拉进来改名', () => {
        const { state } = parseIniToState(iniWith(`ruleset=🔍 谷歌服务,${ACL}/Ruleset/Google.list`));

        expect(namesOf(state).filter(name => name === '🔍 谷歌服务')).toHaveLength(1);
        expect(state.cards.find(card => card.id === 'google').bucket).toBe('flexible');
        expect(state.cards.find(card => card.id === 'cat-tech').bucket).toBe('off');
        expect(state.cards.find(card => card.id === 'cat-tech').name).toBe('💻 科技服务');
    });

    it('正文只提了多来源卡片里的一条时以正文为准，不补回另几条', () => {
        const { state } = parseIniToState(iniWith(`ruleset=${GROUP_NAMES.adBlock},${ACL}/BanAD.list`));

        const card = state.cards.find(item => item.id === 'ad-basic');
        expect(card.bucket).toBe('adblock');
        expect(card.sources.map(source => source.value)).toEqual([`${ACL}/BanAD.list`]);

        // 不多出用户从未写过的 BanProgramAD 行
        const regenerated = serializeState(state, { includeHeader: false }).ini;
        expect(regenerated).not.toContain('BanProgramAD');
    });
});
