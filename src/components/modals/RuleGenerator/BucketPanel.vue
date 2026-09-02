<script setup>
/**
 * 右栏六段容器。自上而下的排列**就是**匹配优先级承诺，
 * 段顺序必须与 serialize.js 的 RULE_BUCKET_ORDER 一致。
 *
 * 段内只渲染**顶层**卡片：大卡片，或被单独拖出父卡片的小卡片。
 * 大卡片下面挂一条自己的小卡片列表 —— 它是独立的可拖放列表，
 * 因此小卡片在段内可以重排、也可以直接拖进另一张大卡片（改父）。
 */
import { computed, ref } from 'vue';
import draggable from 'vuedraggable';
import { useI18n } from '@/i18n/index.js';
import { GROUP_NAMES, effectiveSources } from '@/utils/rule-generator/catalog.js';
import RuleCardItem from './RuleCardItem.vue';

const { t } = useI18n();

const props = defineProps({
  cards: { type: Array, required: true },
  headModifiers: { type: Object, required: true },
  conflictingIds: { type: Object, default: () => new Set() },
  collapsed: { type: Object, required: true },
  dragEnabled: { type: Boolean, default: true },
  moveOptions: { type: Array, default: () => [] }
});

const emit = defineEmits([
  'toggle-collapse', 'toggle-modifier', 'move', 'drop', 'child-drop', 'remove-source'
]);

/**
 * 大卡片的小卡片列表**默认收起**，与左栏待选区一致：段里放进来的是集合，
 * 一上来就摊开全部小卡片会把右栏撑得没法浏览。收起时列表仍然接放
 * （`model-value` 给空数组，靠 emptyInsertThreshold 命中），放进去之后
 * 自动展开 —— 否则卡片会像凭空消失。
 */
const expanded = ref(new Set());

function isExpanded(cardId) {
  return expanded.value.has(cardId);
}

function toggleCard(cardId) {
  const next = new Set(expanded.value);
  if (next.has(cardId)) next.delete(cardId); else next.add(cardId);
  expanded.value = next;
}

function onChildDrop(parentId, cards) {
  if (!expanded.value.has(parentId)) toggleCard(parentId);
  emit('child-drop', { parentId, cards });
}

/** 与 CardPalette 保持同一套 SortableJS 选项，理由见那边的注释。 */
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

/** 六段。顺序即规则输出顺序。 */
const SEGMENTS = [
  { bucket: 'prepend', labelKey: 'settings.ruleGenSegPrepend', hintKey: 'settings.ruleGenSegPrependHint',
    droppable: true, showSources: true, modifiers: true },
  { bucket: 'flexible', labelKey: 'settings.ruleGenSegFlexible', hintKey: 'settings.ruleGenSegFlexibleHint',
    droppable: true, showSources: true },
  { bucket: 'adblock', labelKey: 'settings.ruleGenSegAdBlock', hintKey: 'settings.ruleGenSegAdBlockHint',
    droppable: true, showSources: true },
  { bucket: 'proxy', labelKey: 'settings.ruleGenSegProxy', hintKey: 'settings.ruleGenSegProxyHint',
    droppable: true, showSources: true },
  { bucket: 'direct', labelKey: 'settings.ruleGenSegDirect', hintKey: 'settings.ruleGenSegDirectHint',
    droppable: true, showSources: true },
  { bucket: 'final', labelKey: 'settings.ruleGenSegFinal', hintKey: 'settings.ruleGenSegFinalHint',
    droppable: false, locked: true }
];

/** 顶层卡片，口径与 serialize.js 的 topLevelCardsIn 一致。 */
function topLevelIn(bucket) {
  const byId = new Map(props.cards.map(card => [card.id, card]));

  return props.cards
    .filter(card => {
      if (card.bucket !== bucket) return false;
      if (card.parentId !== null) {
        const parent = byId.get(card.parentId);
        if (parent && parent.bucket === bucket) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const rank = card => (card.origin === 'user' ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return (Number(a.order) || 0) - (Number(b.order) || 0);
    });
}

const counts = computed(() => {
  const map = {};
  SEGMENTS.forEach(segment => { map[segment.bucket] = topLevelIn(segment.bucket).length; });
  return map;
});

/** 大卡片当前同桶的小卡片，按 order 排 —— 拖拽重写 order，不排就看不出变化。 */
function childrenSameBucket(card) {
  return props.cards
    .filter(item => item.parentId === card.id && item.bucket === card.bucket)
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

function countFor(card) {
  return effectiveSources(props.cards, card).length;
}

/** 大卡片内小卡片归零 → 不产出任何内容。 */
function isEmptyParent(card) {
  return card.parentId === null
    && (card.sources || []).length === 0
    && childrenSameBucket(card).length === 0;
}
</script>

<template>
  <div class="flex min-h-0 flex-col gap-2 overflow-y-auto rounded-xl border border-gray-200 bg-white p-2 dark:border-white/10 dark:bg-gray-900/50">
    <section
      v-for="segment in SEGMENTS"
      :key="segment.bucket"
      class="rounded-lg border border-gray-200 dark:border-gray-700"
    >
      <button
        type="button"
        @click="emit('toggle-collapse', segment.bucket)"
        class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-gray-50 dark:hover:bg-white/5"
      >
        <span class="w-3 text-sm leading-none text-gray-400">{{ collapsed[segment.bucket] ? '▸' : '▾' }}</span>
        <span class="text-xs font-bold text-gray-700 dark:text-gray-200">{{ t(segment.labelKey) }}</span>

        <span v-if="segment.locked" class="text-[10px] text-gray-400">🔒</span>
        <span
          v-else
          class="rounded-full bg-gray-100 px-1.5 text-[10px] font-bold text-gray-500 dark:bg-white/10 dark:text-gray-400"
        >{{ counts[segment.bucket] }}</span>
      </button>

      <div v-if="!collapsed[segment.bucket]" class="border-t border-gray-100 p-2 dark:border-white/5">
        <p v-if="segment.hintKey" class="mb-2 text-[10px] leading-snug text-gray-400">{{ t(segment.hintKey) }}</p>

        <!-- 前置修正段自带局域网直连开关 -->
        <label
          v-if="segment.modifiers"
          class="mb-2 flex cursor-pointer items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-300"
        >
          <input
            type="checkbox"
            :checked="headModifiers.localAreaNetwork"
            @change="emit('toggle-modifier', 'localAreaNetwork')"
            class="h-3.5 w-3.5 rounded border-gray-300 text-emerald-600"
          />
          {{ t('settings.ruleGenModLan') }}
        </label>

        <!-- 🐟 漏网之鱼：无可配置项 -->
        <p v-if="segment.bucket === 'final'" class="text-[11px] text-gray-500 dark:text-gray-400">
          {{ GROUP_NAMES.final }}
        </p>

        <draggable
          v-else
          v-bind="dragOptions"
          :model-value="topLevelIn(segment.bucket)"
          @update:model-value="value => emit('drop', { bucket: segment.bucket, cards: value })"
          class="min-h-[3.5rem] space-y-1.5"
        >
          <!--
            一个 item = 一张顶层卡片 +（大卡片时）它自己的小卡片列表。

            注意：`#item` 插槽里**只能有一个节点**，注释也算一个 —— vuedraggable
            会抛 "Item slot must have only one child"。而 Vue 只在 dev 构建里保留
            注释节点，生产构建把它编译掉，所以这类错误只在 dev 现形。
            因此说明文字一律写在插槽外面或那个根 div 里面。
          -->
          <template #item="{ element }">
            <div :class="element.parentId === null ? 'rounded-lg border border-dashed border-gray-200 p-1.5 dark:border-gray-700' : ''">
              <RuleCardItem
                :card="element"
                :effective-count="countFor(element)"
                :children="childrenSameBucket(element)"
                :expandable="element.parentId === null"
                :expanded="isExpanded(element.id)"
                :show-sources="Boolean(segment.showSources)"
                :show-move-menu="!dragEnabled"
                :move-options="moveOptions"
                :conflicting="conflictingIds.has(element.id)"
                :is-empty="isEmptyParent(element)"
                @toggle="toggleCard(element.id)"
                @move="value => emit('move', { cardId: element.id, bucket: value })"
                @remove-source="sourceId => emit('remove-source', { cardId: element.id, sourceId })"
              />

              <!--
                大卡片的小卡片列表。独立的可拖放列表：拖进来即改父，
                因此小卡片可以在集合之间搬家，也能在集合内重排。
                收起时给空数组 —— 列表照旧接放，放进来后 onChildDrop 自动展开。
                缩进用 padding，好让可接放区域横跨整段宽度。
              -->
              <draggable
                v-if="element.parentId === null"
                v-bind="dragOptions"
                :model-value="isExpanded(element.id) ? childrenSameBucket(element) : []"
                @update:model-value="value => onChildDrop(element.id, value)"
                class="mt-1 min-h-[2rem] space-y-1 pl-7"
              >
                <template #item="{ element: child }">
                  <RuleCardItem
                    :card="child"
                    :effective-count="countFor(child)"
                    :show-move-menu="!dragEnabled"
                    :move-options="moveOptions"
                    :conflicting="conflictingIds.has(child.id)"
                    @move="value => emit('move', { cardId: child.id, bucket: value })"
                  />
                </template>
                <template #footer>
                  <p
                    v-if="!isExpanded(element.id) && childrenSameBucket(element).length"
                    class="px-1 py-1 text-[10px] text-gray-400"
                  >{{ childrenSameBucket(element).length }} {{ t('settings.ruleGenCollapsedChildren') }}</p>
                </template>
              </draggable>
            </div>
          </template>
          <template #footer>
            <p v-if="!counts[segment.bucket]" class="py-3 text-center text-[10px] text-gray-300 dark:text-gray-600">
              {{ t('settings.ruleGenDropHere') }}
            </p>
          </template>
        </draggable>
      </div>
    </section>
  </div>
</template>
