<script setup>
/**
 * 左栏待选栏。
 *
 * 展示 bucket === 'off' 的卡片，按「大卡片 → 其小卡片」两层嵌套。
 * 大卡片与小卡片都能拖进右侧桶：拖大卡片会连带其同桶小卡片，拖小卡片不影响大卡片。
 * 与右栏各段共享同一个 vuedraggable group，因此可双向拖动。
 *
 * 初始状态下全部卡片都在这里（目录 80 张），因此每节默认**收起**，
 * 只显示大卡片与它的小卡片数；搜索时自动展开命中的节。
 *
 * 顶部两个按钮：「🗑 整理卡片」切整理模式（卡片露出 ✕、右栏多一段回收站），
 * 「↩️ 恢复内置卡片」把上次保存时删掉的内置卡片补回来 —— 回收站只在保存前可撤。
 */
import { computed, ref } from 'vue';
import draggable from 'vuedraggable';
import { useI18n } from '@/i18n/index.js';
import { effectiveSources } from '@/utils/rule-generator/catalog.js';
import RuleCardItem from './RuleCardItem.vue';

const { t } = useI18n();

const props = defineProps({
  cards: { type: Array, required: true },
  dragEnabled: { type: Boolean, default: true },
  moveOptions: { type: Array, default: () => [] },
  /** 整理模式：卡片上露出 ✕，点它把卡片移到右栏的回收站 */
  editMode: { type: Boolean, default: false },
  /** 当前状态里缺失的内置卡片数，为 0 时不渲染「恢复内置卡片」 */
  missingBuiltinCount: { type: Number, default: 0 }
});

const emit = defineEmits(['move', 'drop', 'child-drop', 'toggle-edit', 'restore-builtins', 'delete']);

const query = ref('');
const expanded = ref(new Set());

/**
 * 共用的 vuedraggable / SortableJS 选项。
 *
 * `handle` 刻意不设：只能拖 `⋮⋮` 那个小把手时，指针恒在卡片最左侧，
 * 而 Sortable 的落点判定看的是**指针**位置，于是"卡片看着已经进右栏、
 * 其实指针还在左栏"。整张卡片可拖后这个错位就没了；卡片里的按钮与下拉
 * 由 `filter` 排除，`preventOnFilter: false` 让它们的点击照常生效。
 *
 * `emptyInsertThreshold` 默认只有 5px —— 空列表几乎贴着边才认，正是
 * "拖拽判定范围太小"的来源。抬到 44px。
 */
const dragOptions = computed(() => ({
  group: { name: 'rule-cards', pull: true, put: true },
  disabled: !props.dragEnabled,
  itemKey: 'id',
  animation: 180,
  filter: 'button, select, input, a, .no-drag',
  preventOnFilter: false,
  emptyInsertThreshold: 44,
  scroll: true,
  bubbleScroll: true,
  scrollSensitivity: 90,
  scrollSpeed: 14
}));

/** 搜索中一律展开，否则命中的小卡片会被收起状态藏住。 */
function isExpanded(key) {
  return Boolean(query.value.trim()) || expanded.value.has(key);
}

function toggleSection(key) {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  expanded.value = next;
}

/** 拖进收起的节 → 先展开再落位，否则卡片看着像凭空消失。 */
function onChildDrop(parentId, cards) {
  if (!expanded.value.has(parentId)) toggleSection(parentId);
  emit('child-drop', { parentId, cards });
}

function matches(card, keyword) {
  if (!keyword) return true;
  if (String(card.name || '').toLowerCase().includes(keyword)) return true;
  return (card.sources || []).some(source =>
    String(source.value || '').toLowerCase().includes(keyword));
}

/**
 * 待选区的分组：每张待选大卡片一节，节内是它同样待选的小卡片。
 * 父卡片已被拖走的孤立小卡片、以及顶栏刚建的游离小卡片，一并归入「散落卡片」节。
 *
 * 「散落卡片」**排在最前**：它是唯一恒定展开的一节，也是顶栏「提交为卡片」的
 * 落点。压在十节收起的内置集合下面的话，新建一张小卡片看着像什么都没发生。
 *
 * 节内小卡片按 `order` 排 —— 拖拽会重写 order，不按它排的话拖完看不出变化。
 */
const sections = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  const off = props.cards.filter(card => card.bucket === 'off');
  const parents = off.filter(card => card.parentId === null);
  const parentIds = new Set(parents.map(card => card.id));
  const byOrder = (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0);

  const groups = parents.map(parent => ({
    key: parent.id,
    parent,
    children: off.filter(card => card.parentId === parent.id).sort(byOrder)
  }));

  const orphans = off.filter(card => card.parentId !== null && !parentIds.has(card.parentId));
  if (orphans.length) {
    groups.unshift({ key: '__orphans__', parent: null, children: orphans.sort(byOrder) });
  }

  // 搜索命中大卡片名则整节保留，否则只留命中的小卡片
  return groups
    .map(group => {
      if (group.parent && matches(group.parent, keyword)) return group;
      return { ...group, children: group.children.filter(child => matches(child, keyword)) };
    })
    .filter(group => group.children.length > 0 || (group.parent && matches(group.parent, keyword)));
});

function countFor(card) {
  return effectiveSources(props.cards, card).length;
}

function childrenInBucket(parentId) {
  return props.cards.filter(card => card.parentId === parentId && card.bucket === 'off');
}
</script>

<template>
  <div class="flex min-h-0 flex-col rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-gray-900/50">
    <div class="shrink-0 space-y-1.5 border-b border-gray-100 p-2 dark:border-white/5">
      <input
        v-model="query"
        type="search"
        :placeholder="`🔍 ${t('settings.ruleGenSearch')}`"
        class="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
      />

      <!--
        整理模式的入口。它影响的是整个窗口（两栏的卡片都露出 ✕、右栏多一段
        回收站），因此文案说的是「整理卡片」而不是「编辑」。
      -->
      <div class="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-test="toggle-edit"
          :title="t('settings.ruleGenEditCardsHint')"
          :aria-pressed="editMode"
          @click="emit('toggle-edit')"
          class="rounded border px-2 py-1 text-[11px] font-semibold transition"
          :class="editMode
            ? 'border-red-300 bg-red-50 text-red-600 dark:border-red-500/50 dark:bg-red-900/25 dark:text-red-300'
            : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-white/5'"
        >{{ editMode ? t('settings.ruleGenEditCardsDone') : t('settings.ruleGenEditCards') }}</button>

        <!-- 回收站只在保存前可撤；保存之后要回被删的内置卡片就只能靠这个 -->
        <button
          v-if="missingBuiltinCount > 0"
          type="button"
          data-test="restore-builtins"
          :title="t('settings.ruleGenRestoreBuiltinsHint')"
          @click="emit('restore-builtins')"
          class="rounded border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-gray-500 transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-white/5"
        >{{ t('settings.ruleGenRestoreBuiltins') }} ({{ missingBuiltinCount }})</button>
      </div>
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
      <p v-if="!sections.length" class="py-6 text-center text-xs text-gray-400">
        {{ t('settings.ruleGenPaletteEmpty') }}
      </p>

      <!-- 一节 = 一张待选大卡片 + 其待选小卡片 -->
      <div
        v-for="section in sections"
        :key="section.key"
        class="rounded-lg"
        :class="section.parent ? 'border border-dashed border-gray-200 p-1.5 dark:border-gray-700' : ''"
      >
        <!-- 大卡片本体，可整体拖走；卡片左侧的小三角展开它的小卡片 -->
        <draggable
          v-if="section.parent"
          v-bind="dragOptions"
          :model-value="[section.parent]"
          @update:model-value="value => emit('drop', { bucket: 'off', cards: value })"
        >
          <template #item="{ element }">
            <RuleCardItem
              :card="element"
              :effective-count="countFor(element)"
              :children="childrenInBucket(element.id)"
              :expandable="true"
              :expanded="isExpanded(section.key)"
              :show-move-menu="!dragEnabled"
              :move-options="moveOptions"
              :deletable="editMode"
              @toggle="toggleSection(section.key)"
              @move="value => emit('move', { cardId: element.id, bucket: value })"
              @delete="emit('delete', element.id)"
            />
          </template>
        </draggable>

        <p v-else class="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
          {{ t('settings.ruleGenLooseCards') }}
        </p>

        <!--
          小卡片列表。拖进来即改父（emit child-drop），因此可以把小卡片
          在集合之间搬家；收起时给空数组，列表照旧接放、放进来后自动展开。
          缩进用 padding 而不是 margin，好让可接放区域横跨整栏而不是
          只有右边那一截。
        -->
        <draggable
          v-bind="dragOptions"
          :model-value="!section.parent || isExpanded(section.key) ? section.children : []"
          @update:model-value="value => section.parent
            ? onChildDrop(section.parent.id, value)
            : emit('drop', { bucket: 'off', cards: value })"
          class="mt-1 min-h-[2rem] space-y-1"
          :class="section.parent ? 'pl-7' : ''"
        >
          <template #item="{ element }">
            <RuleCardItem
              :card="element"
              :effective-count="countFor(element)"
              :show-move-menu="!dragEnabled"
              :move-options="moveOptions"
              :deletable="editMode"
              @move="value => emit('move', { cardId: element.id, bucket: value })"
              @delete="emit('delete', element.id)"
            />
          </template>
          <template #footer>
            <p
              v-if="section.parent && !isExpanded(section.key) && section.children.length"
              class="px-1 py-1 text-[10px] text-gray-400"
            >{{ section.children.length }} {{ t('settings.ruleGenCollapsedChildren') }}</p>
          </template>
        </draggable>
      </div>

      <!--
        尾部空白也接放：卡片拖到待选栏任意空处就回到左栏（保留原本的父卡片）。
        不加任何可见控件 —— 它只是把「拖回左边」这件事的判定范围铺满整栏。
        `flex-1` 吃掉剩余高度；窄屏不启用拖拽，因此整块不渲染。
      -->
      <draggable
        v-if="dragEnabled"
        v-bind="dragOptions"
        :model-value="[]"
        @update:model-value="value => emit('drop', { bucket: 'off', cards: value })"
        class="min-h-[2.5rem] flex-1"
      >
        <template #item="{ element }">
          <RuleCardItem :card="element" />
        </template>
      </draggable>
    </div>
  </div>
</template>
