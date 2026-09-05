/**
 * 卡片生命周期：进回收站 → 保存时剪枝 → 事后恢复内置卡片。
 *
 * 「删除」在这套设计里不是一个独立动作，而是「把卡片改到 trash 桶」+
 * 「保存时剪掉 trash 桶」两步。因此级联、撤销、预览一致性全部由既有的
 * 改桶机制承担，这里只钉住两个纯函数与往返行为。
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CARDS,
  LOOSE_PARENT_ID,
  TRASH_BUCKET,
  createDefaultState,
  pruneTrashed,
  restoreMissingBuiltins
} from '../../src/utils/rule-generator/catalog.js';
import { serializeState } from '../../src/utils/rule-generator/serialize.js';
import { parseIniToState } from '../../src/utils/rule-generator/parse.js';

/** 把一张大卡片连带它的小卡片一起丢进回收站，模拟 moveCard 的级联结果。 */
function trashGroup(cards, parentId) {
  cards.forEach(card => {
    if (card.id === parentId || card.parentId === parentId) card.bucket = TRASH_BUCKET;
  });
}

describe('pruneTrashed', () => {
  it('剔除回收站里的卡片，其余原样保留', () => {
    const cards = createDefaultState().cards;
    trashGroup(cards, 'cat-media');
    const before = cards.length;
    const trashed = cards.filter(card => card.bucket === TRASH_BUCKET).length;
    expect(trashed).toBeGreaterThan(1);   // 大卡片 + 它的小卡片

    const kept = pruneTrashed(cards);

    expect(kept).toHaveLength(before - trashed);
    expect(kept.some(card => card.bucket === TRASH_BUCKET)).toBe(false);
    expect(kept.some(card => card.id === 'youtube')).toBe(false);
    expect(kept.some(card => card.id === 'cat-ai')).toBe(true);
  });

  it('返回新数组，不改入参 —— 回收站在界面上必须还看得见', () => {
    const cards = createDefaultState().cards;
    trashGroup(cards, 'cat-game');
    const length = cards.length;

    const kept = pruneTrashed(cards);

    expect(kept).not.toBe(cards);
    expect(cards).toHaveLength(length);
    expect(cards.find(card => card.id === 'cat-game').bucket).toBe(TRASH_BUCKET);
  });

  it('没有卡片在回收站时内容等价', () => {
    const cards = createDefaultState().cards;
    expect(pruneTrashed(cards).map(card => card.id)).toEqual(cards.map(card => card.id));
  });

  it('容错空输入', () => {
    expect(pruneTrashed()).toEqual([]);
    expect(pruneTrashed(null)).toEqual([]);
    expect(pruneTrashed([null, undefined])).toEqual([]);
  });
});

describe('restoreMissingBuiltins', () => {
  it('把缺失的内置卡片按目录顺序补回待选栏', () => {
    const cards = pruneTrashed(
      createDefaultState().cards.map(card => (
        card.id === 'cat-media' || card.parentId === 'cat-media'
          ? { ...card, bucket: TRASH_BUCKET }
          : card))
    );
    expect(cards.some(card => card.id === 'cat-media')).toBe(false);

    const restored = restoreMissingBuiltins(cards);

    expect(restored).toHaveLength(BUILTIN_CARDS.length);
    const media = restored.find(card => card.id === 'cat-media');
    expect(media.bucket).toBe('off');

    // 补回的顺序跟着目录，不是随机附加
    const addedIds = restored.slice(cards.length).map(card => card.id);
    const catalogOrder = BUILTIN_CARDS.map(card => card.id).filter(id => addedIds.includes(id));
    expect(addedIds).toEqual(catalogOrder);
  });

  it('补回的小卡片带着目录里的完整来源，拖进桶就能用', () => {
    const cards = createDefaultState().cards.filter(card => card.id !== 'youtube');

    const youtube = restoreMissingBuiltins(cards).find(card => card.id === 'youtube');

    expect(youtube.parentId).toBe('cat-media');
    expect(youtube.sources).toHaveLength(1);
    expect(youtube.sources[0].value).toContain('YouTube.list');
  });

  it('已存在的内置卡片不重复补，且不覆盖它当前的桶', () => {
    const cards = createDefaultState().cards.map(card => (
      card.id === 'cat-ai' ? { ...card, bucket: 'flexible' } : card));

    const restored = restoreMissingBuiltins(cards);

    expect(restored).toHaveLength(cards.length);
    expect(restored.find(card => card.id === 'cat-ai').bucket).toBe('flexible');
  });

  it('用户卡片原样保留，且返回新数组', () => {
    const mine = {
      id: 'user-1', name: '我的清单', parentId: LOOSE_PARENT_ID, origin: 'user',
      bucket: 'off', order: -1, sources: []
    };
    const cards = [mine, ...createDefaultState().cards.filter(card => card.id !== 'docker')];

    const restored = restoreMissingBuiltins(cards);

    expect(restored).not.toBe(cards);
    expect(restored[0]).toBe(mine);
    expect(restored.some(card => card.id === 'docker')).toBe(true);
  });

  it('容错空输入 —— 空状态补成完整目录', () => {
    expect(restoreMissingBuiltins([])).toHaveLength(BUILTIN_CARDS.length);
    expect(restoreMissingBuiltins()).toHaveLength(BUILTIN_CARDS.length);
  });
});

describe('删除后的往返', () => {
  it('被剪掉的内置卡片不进注释头，重开时不复活', () => {
    const state = createDefaultState();
    trashGroup(state.cards, 'cat-media');
    const committed = { ...state, cards: pruneTrashed(state.cards) };

    const { ini } = serializeState(committed);
    const { state: reopened, partial, drifted } = parseIniToState(ini);

    expect(partial).toBe(false);
    expect(drifted).toBe(false);
    expect(reopened.cards.some(card => card.id === 'cat-media')).toBe(false);
    expect(reopened.cards.some(card => card.parentId === 'cat-media')).toBe(false);
    // 其余目录卡片一张不少
    expect(reopened.cards.some(card => card.id === 'cat-ai')).toBe(true);
  });

  it('删掉生效中的卡片后，正文里不再有它的规则行', () => {
    const state = createDefaultState();
    state.cards.forEach(card => {
      if (card.id === 'cat-media' || card.parentId === 'cat-media') card.bucket = 'proxy';
    });
    expect(serializeState(state).ini).toContain('YouTube.list');

    trashGroup(state.cards, 'cat-media');
    const committed = { ...state, cards: pruneTrashed(state.cards) };

    expect(serializeState(committed).ini).not.toContain('YouTube.list');
  });

  it('游离小卡片自己算一个输出单元，且能无损往返', () => {
    const state = createDefaultState();
    state.cards.unshift({
      id: 'user-1', name: '🧩 我的清单', parentId: LOOSE_PARENT_ID, origin: 'user',
      bucket: 'proxy', order: -1,
      sources: [{ id: 'src-1', kind: 'remote', value: 'https://example.com/mine.list' }]
    });

    const { ini } = serializeState(state);
    expect(ini).toContain('ruleset=🌍 国际代理,https://example.com/mine.list');

    const { state: reopened, drifted } = parseIniToState(ini);
    expect(drifted).toBe(false);
    const loose = reopened.cards.find(card => card.id === 'user-1');
    expect(loose.parentId).toBe(LOOSE_PARENT_ID);
    expect(loose.sources[0].value).toBe('https://example.com/mine.list');
  });

  it('回收站桶不在规则输出顺序里 —— 即便忘了剪枝也不会产出规则', () => {
    const state = createDefaultState();
    state.cards.forEach(card => {
      if (card.id === 'cat-media' || card.parentId === 'cat-media') card.bucket = TRASH_BUCKET;
    });

    expect(serializeState(state).ini).not.toContain('YouTube.list');
  });
});
