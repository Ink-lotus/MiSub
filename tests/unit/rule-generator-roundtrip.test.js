import { describe, expect, it } from 'vitest';
import {
    createDefaultState,
    createRegionConfigs,
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
        const { ini } = serializeState(createDefaultState());
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
        const body = stripHeader(serializeState(createDefaultState()).ini);
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
        const recovered = parseIniToState(stripHeader(serializeState(createDefaultState()).ini)).state;

        // 这是曾经的 bug：正文没提到的内置卡片被清空 sources，
        // 在左栏看着正常、一拖进桶就报「没有任何来源」
        const emptyChildren = recovered.cards.filter(card =>
            card.parentId !== null && (card.sources || []).length === 0);
        expect(emptyChildren).toEqual([]);

        // 默认关掉的小卡片留在待选栏，但来源仍在
        const hbo = recovered.cards.find(card => card.id === 'hbo');
        expect(hbo.bucket).toBe('off');
        expect(hbo.sources).toHaveLength(1);
    });

    it('反推保持大卡片与小卡片的同桶关系', () => {
        const recovered = parseIniToState(stripHeader(serializeState(createDefaultState()).ini)).state;

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
        const body = stripHeader(serializeState(createDefaultState()).ini);

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
});
