import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import RuleGeneratorModal from '../../src/components/modals/RuleGeneratorModal.vue';
import RuleCardItem from '../../src/components/modals/RuleGenerator/RuleCardItem.vue';
import BucketPanel from '../../src/components/modals/RuleGenerator/BucketPanel.vue';
import CardPalette from '../../src/components/modals/RuleGenerator/CardPalette.vue';
import { createI18n } from '../../src/i18n/index.js';
import { createDefaultState, applyRecommendedBuckets, GROUP_NAMES } from '../../src/utils/rule-generator/catalog.js';
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
    expect(text).toContain('🌍 国际代理');
    expect(text).toContain('🎯 全球直连');
    expect(text).toContain('🐟 漏网之鱼');
    expect(text).toContain('策略组');

    // 一键方案与流量路线说明已按要求移除
    expect(text).not.toContain('一键方案');
    expect(text).not.toContain('流量路线');
  });

  it('右栏段落的可见顺序与生成的 ruleset= 行序一致', () => {
    // 默认状态卡片全在待选栏，右栏各段是空的 —— 用铺开后的模板内容打开
    const configured = createDefaultState();
    configured.cards = applyRecommendedBuckets(configured.cards);
    const wrapper = mountModal({ content: serializeState(configured).ini });

    const headings = wrapper.findComponent(BucketPanel)
      .findAll('section > button')
      .map(button => button.text());

    expect(headings).toEqual([
      // 只读说明段，不承接卡片、不产出策略组，排在最前是因为 DNS 解析先于规则匹配
      expect.stringContaining('🌐 DNS 出口'),
      expect.stringContaining('🔧 前置修正'),
      expect.stringContaining('🧩 灵活桶'),
      expect.stringContaining('🛑 广告拦截'),
      expect.stringContaining('🌍 国际代理'),
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

    // 先让内置的「📲 社交通讯」集合生效，它带着电报卡片一起进桶
    wrapper.vm.moveCard({ cardId: 'cat-social', bucket: 'proxy' });
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
    // 内置电报卡片被移空 → 整卡消失，且没有留下孤立的大卡片来源
    expect(wrapper.vm.state.cards.find(card => card.id === 'telegram')).toBeUndefined();
  });
  it('小卡片拖进另一张大卡片的列表即改父，并跟到该大卡片所在的桶', async () => {
    const wrapper = mountModal();

    wrapper.vm.moveCard({ cardId: 'cat-ai', bucket: 'flexible' });
    await wrapper.vm.$nextTick();

    // 把「🎵 Spotify 声破天」（流媒体下）拖进「🤖 AI 服务」的小卡片列表
    const spotify = wrapper.vm.state.cards.find(card => card.id === 'spotify');
    wrapper.vm.handleChildDrop({ parentId: 'cat-ai', cards: [spotify] });
    await wrapper.vm.$nextTick();

    const moved = wrapper.vm.state.cards.find(card => card.id === 'spotify');
    expect(moved.parentId).toBe('cat-ai');
    expect(moved.bucket).toBe('flexible');

    // 它的来源因此计入 🤖 AI 服务 这一个组，而不是自己成组
    const { ini } = serializeState(wrapper.vm.state);
    const groups = ini.split('\n')
      .filter(line => line.startsWith('custom_proxy_group='))
      .map(line => line.replace(/^custom_proxy_group=/, '').split('`')[0]);
    expect(groups).toContain('🤖 AI 服务');
    expect(groups).not.toContain('🎵 Spotify 声破天');
    expect(ini).toContain('ruleset=🤖 AI 服务,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/Spotify.list');
  });

  it('大卡片被拖进小卡片列表时不变成小卡片，只跟着改桶', async () => {
    const wrapper = mountModal();

    wrapper.vm.moveCard({ cardId: 'cat-ai', bucket: 'proxy' });
    await wrapper.vm.$nextTick();

    const media = wrapper.vm.state.cards.find(card => card.id === 'cat-media');
    wrapper.vm.handleChildDrop({ parentId: 'cat-ai', cards: [media] });
    await wrapper.vm.$nextTick();

    const moved = wrapper.vm.state.cards.find(card => card.id === 'cat-media');
    expect(moved.parentId).toBeNull();      // 嵌套只有两层
    expect(moved.bucket).toBe('proxy');
    // 连带它自己的小卡片
    expect(wrapper.vm.state.cards.find(card => card.id === 'youtube').bucket).toBe('proxy');
  });

  it('自定义规则集不填任何规则时创建一张空分组卡片', async () => {
    const wrapper = mountModal();
    const before = wrapper.vm.state.cards.length;

    wrapper.vm.submitRuleset({ name: '🧺 我的分组', rows: [{ kind: 'remote', value: '  ' }] });
    await wrapper.vm.$nextTick();

    expect(wrapper.vm.state.cards).toHaveLength(before + 1);
    const parent = wrapper.vm.state.cards[0];
    expect(parent.name).toBe('🧺 我的分组');
    expect(parent.parentId).toBeNull();
    expect(parent.sources).toEqual([]);
    expect(parent.bucket).toBe('off');

    // 连名字都没有就不建 —— 空卡片没法称呼
    wrapper.vm.submitRuleset({ name: '   ', rows: [] });
    await wrapper.vm.$nextTick();
    expect(wrapper.vm.state.cards).toHaveLength(before + 1);
  });
  it('小卡片可在灵活桶里独立成组，并入集合可还原', async () => {
    const wrapper = mountModal();

    wrapper.vm.moveCard({ cardId: 'cat-ai', bucket: 'flexible' });
    await wrapper.vm.$nextTick();

    const groupsOf = () => serializeState(wrapper.vm.state).ini.split('\n')
      .filter(line => line.startsWith('custom_proxy_group='))
      .map(line => line.replace(/^custom_proxy_group=/, '').split('`')[0]);

    // 默认由 🤖 AI 服务 代表，Gemini 不单独成组
    expect(groupsOf()).toContain('🤖 AI 服务');
    expect(groupsOf()).not.toContain('💠 Gemini');

    wrapper.vm.setStandalone({ cardId: 'ai-gemini', standalone: true });
    await wrapper.vm.$nextTick();

    expect(wrapper.vm.state.cards.find(card => card.id === 'ai-gemini').standalone).toBe(true);
    expect(groupsOf()).toContain('💠 Gemini');
    expect(groupsOf()).toContain('🤖 AI 服务');       // 其余小卡片照旧合并

    wrapper.vm.setStandalone({ cardId: 'ai-gemini', standalone: false });
    await wrapper.vm.$nextTick();

    // 并回集合后连字段都不留，注释头因此不多记一条
    expect('standalone' in wrapper.vm.state.cards.find(card => card.id === 'ai-gemini')).toBe(false);
    expect(groupsOf()).not.toContain('💠 Gemini');
  });

  it('小卡片被拖进段的顶层列表即独立成组，拖回集合或退回待选栏则取消', async () => {
    const wrapper = mountModal();

    wrapper.vm.moveCard({ cardId: 'cat-ai', bucket: 'flexible' });
    await wrapper.vm.$nextTick();
    const gemini = wrapper.vm.state.cards.find(card => card.id === 'ai-gemini');

    // 摆到集合旁边 = 它自己算一个
    wrapper.vm.handleDrop({ bucket: 'flexible', cards: [gemini] });
    await wrapper.vm.$nextTick();
    expect(wrapper.vm.state.cards.find(card => card.id === 'ai-gemini').standalone).toBe(true);

    // 拖回集合的小卡片列表 → 并回去
    wrapper.vm.handleChildDrop({ parentId: 'cat-ai', cards: [gemini] });
    await wrapper.vm.$nextTick();
    expect('standalone' in wrapper.vm.state.cards.find(card => card.id === 'ai-gemini')).toBe(false);

    // 退回待选栏也清掉：待选栏按父子分节展示，不体现独立成组
    wrapper.vm.setStandalone({ cardId: 'ai-gemini', standalone: true });
    wrapper.vm.moveCard({ cardId: 'ai-gemini', bucket: 'off' });
    await wrapper.vm.$nextTick();
    expect('standalone' in wrapper.vm.state.cards.find(card => card.id === 'ai-gemini')).toBe(false);
  });
});

describe('真实 vuedraggable 下的渲染', () => {
  /**
   * 其余用例把 vuedraggable 换成静态壳（它要真实 DOM 度量），代价是
   * 「`#item` 插槽只能有一个节点」这类只有真组件才会抛的错整个测不到 ——
   * 曾经就因此漏掉一次：插槽里多写了一行 HTML 注释，注释也算一个节点，
   * 一拖动就抛 "Item slot must have only one child"。生产构建会把注释
   * 编译掉，所以它只在 dev 现形。这里用真组件挂一次兜住这类回归。
   */
  it('两栏都能用真 draggable 挂载，插槽结构合法', () => {
    const configured = createDefaultState();
    configured.cards = applyRecommendedBuckets(configured.cards);

    const wrapper = mount(RuleGeneratorModal, {
      props: { show: true, content: serializeState(configured).ini },
      global: {
        plugins: [createPinia(), createI18n({ initialLocale: 'zh-CN' })],
        stubs: { Modal: modalStub }
      }
    });

    expect(wrapper.findComponent(BucketPanel).exists()).toBe(true);
    expect(wrapper.findComponent(CardPalette).exists()).toBe(true);
    // 大卡片渲染出来了；它的小卡片默认收起，所以此时不在 DOM 里
    const ids = wrapper.findAllComponents(RuleCardItem).map(item => item.props('card').id);
    expect(ids).toContain('cat-ai');
    expect(ids).not.toContain('ai-openai');
  });
});

describe('BucketPanel', () => {
  const parent = {
    id: 'p1', name: '🤖 AI 服务', parentId: null, origin: 'builtin',
    bucket: 'flexible', order: 0, sources: []
  };
  const kid = {
    id: 'c1', name: '🧠 OpenAI', parentId: 'p1', origin: 'builtin',
    bucket: 'flexible', order: 0,
    sources: [{ id: 's1', kind: 'remote', value: 'https://example.com/openai.list' }]
  };

  function mountPanel(overrides = {}) {
    return mount(BucketPanel, {
      props: {
        cards: [parent, kid],
        headModifiers: { localAreaNetwork: true },
        collapsed: { dns: false, prepend: false, flexible: false, adblock: false, proxy: false, direct: false, final: true },
        dragEnabled: true,
        moveOptions: [],
        ...overrides
      },
      global: {
        plugins: [createI18n({ initialLocale: 'zh-CN' })],
        stubs: { draggable: draggableStub }
      }
    });
  }

  /** 大卡片的展开钮：h-8 w-7 的方块按钮，段头那个是整行的。 */
  function toggleOf(wrapper) {
    return wrapper.findAll('button').find(button => ['▸', '▾'].includes(button.text()));
  }

  /** 大卡片自己的小卡片列表：靠 pl-7 缩进类认，其它 draggable 都没有它。 */
  function childListOf(wrapper) {
    return wrapper.findAllComponents(draggableStub).find(list => list.classes().includes('pl-7'));
  }

  it('大卡片默认收起，展开后小卡片各自是一张可拖动的卡片', async () => {
    const wrapper = mountPanel();

    // 收起时只有大卡片本体，但角标告诉你里面有几张
    expect(wrapper.findAllComponents(RuleCardItem).map(item => item.props('card').id))
      .toEqual(['p1']);
    expect(wrapper.text()).toContain('1 张小卡片已收起');

    await toggleOf(wrapper).trigger('click');

    expect(wrapper.findAllComponents(RuleCardItem).map(item => item.props('card').id))
      .toEqual(['p1', 'c1']);
    expect(childListOf(wrapper).props('modelValue').map(card => card.id)).toEqual(['c1']);
  });

  it('小卡片列表落位后 emit child-drop，带上目标大卡片 id', async () => {
    const wrapper = mountPanel();
    await toggleOf(wrapper).trigger('click');

    await childListOf(wrapper).vm.$emit('update:model-value', [kid]);

    expect(wrapper.emitted('child-drop')).toEqual([[{ parentId: 'p1', cards: [kid] }]]);
  });

  it('往收起的大卡片里拖东西会自动展开 —— 否则卡片看着凭空消失', async () => {
    const wrapper = mountPanel();

    // 收起状态下列表给的是空数组，但仍然接放
    expect(childListOf(wrapper).props('modelValue')).toEqual([]);
    await childListOf(wrapper).vm.$emit('update:model-value', [kid]);

    expect(wrapper.emitted('child-drop')).toEqual([[{ parentId: 'p1', cards: [kid] }]]);
    expect(wrapper.findAllComponents(RuleCardItem).map(item => item.props('card').id))
      .toEqual(['p1', 'c1']);
  });

  it('「独立成组」开关只给灵活桶里与父卡片同桶的小卡片', async () => {
    const wrapper = mountPanel();
    await toggleOf(wrapper).trigger('click');

    const childCard = wrapper.findAllComponents(RuleCardItem)
      .find(item => item.props('card').id === 'c1');
    expect(childCard.props('detachable')).toBe(true);

    // 点它 → 冒出 set-standalone，取反当前值
    await childCard.find('button').trigger('click');
    expect(wrapper.emitted('set-standalone')).toEqual([[{ cardId: 'c1', standalone: true }]]);

    // 承接桶整桶汇进同一个组，独立与否看不出区别，因此不给开关
    const proxied = mount(BucketPanel, {
      props: {
        cards: [{ ...parent, bucket: 'proxy' }, { ...kid, bucket: 'proxy' }],
        headModifiers: { localAreaNetwork: true },
        collapsed: { dns: true, prepend: false, flexible: false, adblock: false, proxy: false, direct: false, final: true },
        dragEnabled: true,
        moveOptions: []
      },
      global: {
        plugins: [createI18n({ initialLocale: 'zh-CN' })],
        stubs: { draggable: draggableStub }
      }
    });
    await proxied.findAll('button').find(button => ['▸', '▾'].includes(button.text())).trigger('click');
    expect(proxied.findAllComponents(RuleCardItem)
      .find(item => item.props('card').id === 'c1').props('detachable')).toBe(false);
  });

  /**
   * 🌐 DNS 出口 段是只读说明：不承接卡片、不产出策略组，开关在 DNS 配置模块。
   * 它存在的意义是让「策略组 = 卡片派生」在用户眼里成立——DNS 绑到哪个组、
   * 会不会多出一个组，都能在这里看明白。
   */
  it('DNS 段是只读的：没有输入控件，不接受拖放', () => {
    const wrapper = mountPanel();
    const section = wrapper.findAll('section')
      .find(item => item.find('[data-dns-segment-state]').exists());

    expect(section).toBeTruthy();
    expect(section.findAll('input')).toHaveLength(0);
    expect(section.find('.draggable-stub').exists()).toBe(false);
  });

  it('DNS 段排在最前，且状态徽标随 dnsThroughProxy 变化', () => {
    const on = mountPanel({ dnsThroughProxy: true });
    expect(on.findAll('section')[0].find('[data-dns-segment-state]').text()).toBe('跟随代理');
    expect(on.get('[data-dns-segment-body]').text()).toContain('🚀 节点选择');

    const off = mountPanel({ dnsThroughProxy: false });
    expect(off.findAll('section')[0].find('[data-dns-segment-state]').text()).toBe('直连');
    expect(off.get('[data-dns-segment-body]').text()).not.toContain('🚀 节点选择');
  });

  it('DNS 段不显示卡片计数徽标——它不承接卡片', () => {
    const wrapper = mountPanel();
    const header = wrapper.findAll('section')[0].find('button');
    expect(header.text()).toContain('🌐 DNS 出口');
    expect(header.text()).not.toContain('🔒');
  });
});

describe('CardPalette', () => {
  function mountPalette(dragEnabled = true) {
    return mount(CardPalette, {
      props: { cards: createDefaultState().cards, dragEnabled, moveOptions: [] },
      global: {
        plugins: [createI18n({ initialLocale: 'zh-CN' })],
        stubs: { draggable: draggableStub }
      }
    });
  }

  it('默认全部卡片在待选栏，每节收起后只见大卡片', () => {
    const text = mountPalette().text();

    // 十张大卡片全在
    ['✅ 直连例外', '🛑 广告过滤', '🤖 AI 服务', '🎬 流媒体', '📲 社交通讯',
      '💻 科技服务', '👨‍💻 开发与学术', '🎮 游戏平台', '🏠 国内直连', '🌏 广覆盖代理清单']
      .forEach(name => expect(text).toContain(name));

    // 小卡片默认收起 —— 78 张卡片全展开会把左栏撑爆
    expect(text).not.toContain('🧠 OpenAI');
    expect(text).not.toContain('📎 Claude');
  });

  it('点小三角展开该节的小卡片', async () => {
    const wrapper = mountPalette();
    const section = wrapper.findAll('button').find(button => ['▸', '▾'].includes(button.text()));

    await section.trigger('click');
    expect(wrapper.text()).toContain('🇨🇳 谷歌中国');
  });

  it('搜索时自动展开命中的节', async () => {
    const wrapper = mountPalette();

    await wrapper.find('input[type="search"]').setValue('Gemini');
    const text = wrapper.text();

    expect(text).toContain('💠 Gemini');
    expect(text).toContain('🤖 AI 服务');       // 命中项所在的集合仍可见
    expect(text).not.toContain('📹 YouTube 油管');   // 未命中的节不出现
  });

  it('尾部空白接放，等于「拖回左栏任意空处」；窄屏不渲染它', async () => {
    const wrapper = mountPalette();

    // 不再有任何可见的回收控件
    expect(wrapper.text()).not.toContain('拖到这里');

    const tail = wrapper.findAllComponents(draggableStub)
      .find(list => list.classes().includes('flex-1'));
    expect(tail).toBeTruthy();

    const card = createDefaultState().cards.find(item => item.id === 'youtube');
    await tail.vm.$emit('update:model-value', [card]);
    expect(wrapper.emitted('drop')).toEqual([[{ bucket: 'off', cards: [card] }]]);

    // 窄屏走「移到…」下拉，拖放整个不启用，这块空白也就没有意义
    expect(mountPalette(false).findAllComponents(draggableStub)
      .some(list => list.classes().includes('flex-1'))).toBe(false);
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

  it('窄屏降级时渲染「移到…」下拉，且落在卡片右下角', () => {
    const wrapper = mountCard(child, {
      showMoveMenu: true,
      showSources: true,
      moveOptions: [{ value: 'direct', label: '🎯 全球直连' }]
    });
    expect(wrapper.text()).toContain('移到…');

    // 右对齐、且排在来源清单与备注之后 —— 手机上拇指最容易够到的位置
    const holder = wrapper.find('select').element.parentElement;
    expect(holder.className).toContain('justify-end');
    expect(wrapper.element.lastElementChild).toBe(holder);
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

  it('大卡片本体只显示小卡片数，小卡片由外层列表渲染', () => {
    // 小卡片改由 CardPalette / BucketPanel 各自的可拖放列表渲染，
    // 卡片本体不再内嵌一份只读清单 —— 否则同一张小卡片会出现两次
    const wrapper = mountCard(
      { ...child, id: 'p1', name: '🎬 流媒体', parentId: null, sources: [] },
      { showSources: true, children: [{ ...child, name: '📹 YouTube 油管' }] }
    );
    expect(wrapper.text()).not.toContain('📹 YouTube 油管');
    expect(wrapper.text()).toContain('1');
  });

  it('大卡片的展开钮长在卡片里，⋮⋮ 把手已移除', async () => {
    const parentCard = { ...child, id: 'p1', parentId: null, sources: [] };
    const wrapper = mountCard(parentCard, { expandable: true, children: [child] });

    // 整张卡片都能拖之后把手没用了，反而挤掉一格宽度
    expect(wrapper.text()).not.toContain('⋮⋮');
    expect(wrapper.text()).toContain('▸');

    await wrapper.find('button').trigger('click');
    expect(wrapper.emitted('toggle')).toHaveLength(1);

    // 小卡片没有展开钮
    expect(mountCard(child).text()).not.toContain('▸');
  });
});
