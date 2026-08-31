import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import RuleGeneratorModal from '../../src/components/modals/RuleGeneratorModal.vue';
import RuleCardItem from '../../src/components/modals/RuleGenerator/RuleCardItem.vue';
import BucketPanel from '../../src/components/modals/RuleGenerator/BucketPanel.vue';
import { createI18n } from '../../src/i18n/index.js';
import { createDefaultState, GROUP_NAMES } from '../../src/utils/rule-generator/catalog.js';
import { serializeState } from '../../src/utils/rule-generator/serialize.js';

/** Modal 的 focus-trap 在 happy-dom 下噪音大，替换成直通壳。 */
const modalStub = {
  props: ['show', 'size', 'confirmText', 'confirmDisabled', 'closeOnConfirm'],
  emits: ['update:show', 'confirm'],
  template: `<div v-if="show">
    <slot name="title" /><slot name="body" />
    <button data-test="confirm" :disabled="confirmDisabled" @click="$emit('confirm')">{{ confirmText }}</button>
  </div>`
};

/** vuedraggable 需要真实 DOM 度量，替换成静态列表。 */
const draggableStub = {
  props: ['modelValue', 'group', 'disabled', 'itemKey', 'handle', 'animation'],
  template: `<div class="draggable-stub">
    <template v-for="(element, index) in modelValue" :key="element.id">
      <slot name="item" :element="element" :index="index" />
    </template>
    <slot name="footer" />
  </div>`
};

function mountModal(props = {}) {
  return mount(RuleGeneratorModal, {
    props: { show: true, content: '', ...props },
    global: {
      plugins: [createPinia(), createI18n({ initialLocale: 'zh-CN' })],
      stubs: { Modal: modalStub, draggable: draggableStub }
    }
  });
}

describe('RuleGeneratorModal', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('空内容时用默认状态挂载，渲染六段与预览', () => {
    const text = mountModal().text();

    expect(text).toContain('🔧 前置修正');
    expect(text).toContain('🧩 灵活桶');
    expect(text).toContain('🛑 广告拦截');
    expect(text).toContain('🌍 国外代理');
    expect(text).toContain('🎯 全球直连');
    expect(text).toContain('🐟 漏网之鱼');
    expect(text).toContain('策略组');

    // 一键方案与流量路线说明已按要求移除
    expect(text).not.toContain('一键方案');
    expect(text).not.toContain('流量路线');
  });

  it('右栏段落的可见顺序与生成的 ruleset= 行序一致', () => {
    const wrapper = mountModal();

    const headings = wrapper.findComponent(BucketPanel)
      .findAll('section > button')
      .map(button => button.text());

    expect(headings).toEqual([
      expect.stringContaining('🔧 前置修正'),
      expect.stringContaining('🧩 灵活桶'),
      expect.stringContaining('🛑 广告拦截'),
      expect.stringContaining('🌍 国外代理'),
      expect.stringContaining('🎯 全球直连'),
      expect.stringContaining('🐟 漏网之鱼')
    ]);

    const policies = serializeState(wrapper.vm.state).ini.split('\n')
      .filter(line => line.startsWith('ruleset='))
      .map(line => line.replace(/^ruleset=/, '').split(',')[0]);

    const first = name => policies.indexOf(name);
    expect(first('DIRECT')).toBe(0);
    expect(first('🤖 AI 服务')).toBeLessThan(first(GROUP_NAMES.adBlock));
    expect(first(GROUP_NAMES.adBlock)).toBeLessThan(first(GROUP_NAMES.proxy));
    expect(policies.at(-1)).toBe(GROUP_NAMES.final);
  });

  it('打开已有模板时还原状态，apply 回传 INI 而不直接落盘', async () => {
    const { ini } = serializeState(createDefaultState());
    const wrapper = mountModal({ content: ini });

    await wrapper.get('[data-test="confirm"]').trigger('click');

    const applied = wrapper.emitted('apply');
    expect(applied).toHaveLength(1);
    expect(applied[0][0]).toBe(ini);          // 往返无损
    expect(wrapper.emitted('update:show')).toEqual([[false]]);
  });

  it('校验有 error 时 apply 按钮禁用，不发出 apply', async () => {
    const wrapper = mountModal();

    // 直接改 state：带逗号的组名无法经 INI 往返（那正是它被拦的原因）
    wrapper.vm.submitRuleset({ name: '坏,名字', rows: [{ kind: 'remote', value: 'https://example.com/a.list' }] });
    wrapper.vm.moveCard({ cardId: wrapper.vm.state.cards[0].id, bucket: 'flexible' });
    await wrapper.vm.$nextTick();

    expect(wrapper.vm.validation.canGenerate).toBe(false);
    const confirm = wrapper.get('[data-test="confirm"]');
    expect(confirm.attributes('disabled')).toBeDefined();

    await confirm.trigger('click');
    expect(wrapper.emitted('apply')).toBeUndefined();
  });

  it('手改过正文的模板给出漂移警告与两个选择，不静默覆盖', () => {
    const { ini } = serializeState(createDefaultState());
    const handEdited = ini.replace(
      `ruleset=${GROUP_NAMES.final},[]FINAL`,
      `ruleset=${GROUP_NAMES.proxy},[]DOMAIN-SUFFIX,manual.example\nruleset=${GROUP_NAMES.final},[]FINAL`
    );

    const text = mountModal({ content: handEdited }).text();
    expect(text).toContain('正文');
    expect(text).toContain('放弃手改');
    expect(text).toContain('继续用高级模式');
  });

  it('拖动大卡片会连带同桶的小卡片一起改桶', async () => {
    const wrapper = mountModal();
    const cards = wrapper.vm.state.cards;
    const parent = cards.find(card => card.id === 'cat-media');
    const before = cards.filter(card => card.parentId === 'cat-media' && card.bucket === parent.bucket)
      .map(card => card.id);
    expect(before.length).toBeGreaterThan(0);

    wrapper.vm.moveCard({ cardId: 'cat-media', bucket: 'proxy' });
    await wrapper.vm.$nextTick();

    expect(wrapper.vm.state.cards.find(card => card.id === 'cat-media').bucket).toBe('proxy');
    before.forEach(id => {
      expect(wrapper.vm.state.cards.find(card => card.id === id).bucket).toBe('proxy');
    });
  });

  it('拖动小卡片不影响大卡片位置', async () => {
    const wrapper = mountModal();
    const parentBucket = wrapper.vm.state.cards.find(card => card.id === 'cat-media').bucket;

    wrapper.vm.moveCard({ cardId: 'youtube', bucket: 'direct' });
    await wrapper.vm.$nextTick();

    expect(wrapper.vm.state.cards.find(card => card.id === 'youtube').bucket).toBe('direct');
    expect(wrapper.vm.state.cards.find(card => card.id === 'cat-media').bucket).toBe(parentBucket);
  });

  it('顶栏提交的自定义规则集落到左栏候选区顶部，不直接进桶', async () => {
    const wrapper = mountModal();
    const before = wrapper.vm.state.cards.length;

    wrapper.vm.submitRuleset({
      name: '百度',
      rows: [
        { kind: 'remote', value: 'https://example.com/baidu.list' },
        { kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'baidu.com' }
      ]
    });
    await wrapper.vm.$nextTick();

    // 一张大卡片 + 两张小卡片
    expect(wrapper.vm.state.cards).toHaveLength(before + 3);

    const parent = wrapper.vm.state.cards[0];
    expect(parent.name).toBe('百度');
    expect(parent.parentId).toBeNull();
    expect(parent.sources).toEqual([]);       // 大卡片自身无来源
    expect(parent.bucket).toBe('off');        // 落在候选区，不进右侧桶

    const children = wrapper.vm.state.cards.filter(card => card.parentId === parent.id);
    expect(children).toHaveLength(2);
    children.forEach(child => expect(child.bucket).toBe('off'));
    expect(children[1].sources[0]).toMatchObject({ kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'baidu.com' });
  });

  it('自定义规则集拖进灵活桶后生成一个同名策略组', async () => {
    const wrapper = mountModal();

    wrapper.vm.submitRuleset({ name: '百度', rows: [{ kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'baidu.com' }] });
    await wrapper.vm.$nextTick();

    const parentId = wrapper.vm.state.cards[0].id;
    wrapper.vm.moveCard({ cardId: parentId, bucket: 'flexible' });
    await wrapper.vm.$nextTick();

    const { ini } = serializeState(wrapper.vm.state);
    const groups = ini.split('\n')
      .filter(line => line.startsWith('custom_proxy_group='))
      .map(line => line.replace(/^custom_proxy_group=/, '').split('`')[0]);

    expect(groups.filter(name => name === '百度')).toHaveLength(1);
    expect(ini).toContain('ruleset=百度,[]DOMAIN-SUFFIX,baidu.com');
  });

  it('自填来源撞上内置卡片时冲突条出现，保留我的可消解', async () => {
    const wrapper = mountModal();

    wrapper.vm.submitRuleset({
      name: '我的电报',
      rows: [{ kind: 'remote', value: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/Telegram.list' }]
    });
    await wrapper.vm.$nextTick();

    // 提交后在候选区，尚未生效 → 不算冲突
    expect(wrapper.vm.conflicts).toHaveLength(0);

    wrapper.vm.moveCard({ cardId: wrapper.vm.state.cards[0].id, bucket: 'proxy' });
    await wrapper.vm.$nextTick();

    expect(wrapper.vm.conflicts).toHaveLength(1);
    expect(wrapper.text()).toContain('来源重复');

    const conflict = wrapper.vm.conflicts[0];
    const mine = conflict.entries.find(entry => entry.origin === 'user');
    wrapper.vm.keepMine({ conflict, winnerCardId: mine.cardId });
    await wrapper.vm.$nextTick();

    expect(wrapper.vm.conflicts).toHaveLength(0);
    expect(wrapper.vm.state.cards.find(card => card.id === 'telegram')).toBeUndefined();
  });
});

describe('RuleCardItem', () => {
  function mountCard(card, props = {}) {
    return mount(RuleCardItem, {
      props: { card, ...props },
      global: { plugins: [createI18n({ initialLocale: 'zh-CN' })] }
    });
  }

  const child = {
    id: 'c1', name: '测试卡', parentId: 'p1', origin: 'builtin', bucket: 'proxy', order: 0,
    sources: [{ id: 's1', kind: 'remote', value: 'https://example.com/a.list' }]
  };

  it('广告卡片只加橙色 AD 角标，不改底色 —— 红色留给撞车独占', () => {
    const ad = mountCard({ ...child, name: '🚫 广告基础' });
    const normal = mountCard(child);

    expect(ad.text()).toContain('AD');
    expect(ad.html()).toContain('bg-orange-500');   // 角标
    expect(normal.text()).not.toContain('AD');

    // 卡片容器本身的类与普通卡片完全一致 —— 只有角标不同
    const containerClass = wrapper => wrapper.find('div').attributes('class');
    expect(containerClass(ad)).toBe(containerClass(normal));
  });

  it('撞车卡片标红，且与 AD 角标可共存而不混淆', () => {
    const conflicting = mountCard({ ...child, name: '🚫 广告基础' }, { conflicting: true });
    expect(conflicting.html()).toContain('border-red-400');
    expect(conflicting.text()).toContain('AD');
  });

  it('卡片上没有出口下拉 —— 出口由策略组决定', () => {
    expect(mountCard({ ...child, bucket: 'flexible' }).find('select').exists()).toBe(false);
    expect(mountCard({ ...child, parentId: null, sources: [] }).find('select').exists()).toBe(false);
  });

  it('大卡片显示小卡片数，空集合给提示', () => {
    const filled = mountCard(
      { ...child, id: 'p1', parentId: null, sources: [] },
      { children: [child, { ...child, id: 'c2' }] }
    );
    expect(filled.text()).toContain('2');
    expect(filled.text()).not.toContain('没有规则卡片');

    const empty = mountCard(
      { ...child, id: 'p1', name: '空集合', parentId: null, sources: [] },
      { children: [], isEmpty: true }
    );
    expect(empty.text()).toContain('没有规则卡片');
  });

  it('窄屏降级时渲染「移到…」下拉', () => {
    const wrapper = mountCard(child, {
      showMoveMenu: true,
      moveOptions: [{ value: 'direct', label: '🎯 全球直连' }]
    });
    expect(wrapper.text()).toContain('移到…');
  });

  it('小卡片展开后可移除单条来源', async () => {
    const wrapper = mountCard({
      ...child,
      sources: [
        { id: 's1', kind: 'remote', value: 'https://example.com/YouTube.list' },
        { id: 's2', kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'grok.com' }
      ]
    }, { showSources: true, effectiveCount: 2 });

    expect(wrapper.text()).toContain('YouTube.list');
    expect(wrapper.text()).toContain('DOMAIN-SUFFIX,grok.com');

    await wrapper.findAll('button')[0].trigger('click');
    expect(wrapper.emitted('remove-source')).toEqual([['s1']]);
  });

  it('大卡片展开后列出小卡片名', () => {
    const wrapper = mountCard(
      { ...child, id: 'p1', name: '🎬 流媒体', parentId: null, sources: [] },
      { showSources: true, children: [{ ...child, name: '📹 油管视频' }] }
    );
    expect(wrapper.text()).toContain('📹 油管视频');
  });
});
