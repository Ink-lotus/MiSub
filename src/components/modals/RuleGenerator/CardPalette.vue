<script setup>
/**
 * 左栏待选栏。
 *
 * 展示 bucket === 'off' 的卡片，按「大卡片 → 其小卡片」两层嵌套。
 * 大卡片与小卡片都能拖进右侧桶：拖大卡片会连带其同桶小卡片，拖小卡片不影响大卡片。
 * 与右栏各段共享同一个 vuedraggable group，因此可双向拖动。
 *
 * 初始状态下全部卡片都在这里（目录 78 张），因此每节默认**收起**，
 * 只显示大卡片与它的小卡片数；搜索时自动展开命中的节。
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
  moveOptions: { type: Array, default: () => [] }
});

const emit = defineEmits(['move', 'drop']);

const query = ref('');
const expanded = ref(new Set());

/** 搜索中一律展开，否则命中的小卡片会被收起状态藏住。 */
function isExpanded(key) {
  return Boolean(query.value.trim()) || expanded.value.has(key);
}

function toggleSection(key) {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  expanded.value = next;
}

function matches(card, keyword) {
  if (!keyword) return true;
  if (String(card.name || '').toLowerCase().includes(keyword)) return true;
  return (card.sources || []).some(source =>
    String(source.value || '').toLowerCase().includes(keyword));
}

/**
 * 待选区的分组：每张待选大卡片一节，节内是它同样待选的小卡片。
 * 父卡片已被拖走的孤立小卡片单独归入「散card」节。
 */
const sections = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  const off = props.cards.filter(card => card.bucket === 'off');
  const parents = off.filter(card => card.parentId === null);
  const parentIds = new Set(parents.map(card => card.id));

  const groups = parents.map(parent => ({
    key: parent.id,
    parent,
    children: off.filter(card => card.parentId === parent.id)
  }));

  const orphans = off.filter(card => card.parentId !== null && !parentIds.has(card.parentId));
  if (orphans.length) {
    groups.push({ key: '__orphans__', parent: null, children: orphans });
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
    <div class="shrink-0 border-b border-gray-100 p-2 dark:border-white/5">
      <input
        v-model="query"
        type="search"
        :placeholder="`🔍 ${t('settings.ruleGenSearch')}`"
        class="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
      />
    </div>

    <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
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
        <!-- 大卡片本体，可整体拖走；左侧小三角展开它的小卡片 -->
        <div v-if="section.parent" class="flex items-start gap-1">
          <button
            type="button"
            :title="t('settings.ruleGenToggleSection')"
            :aria-expanded="isExpanded(section.key)"
            @click="toggleSection(section.key)"
            class="mt-2 shrink-0 px-0.5 text-[10px] text-gray-400 transition hover:text-gray-600 dark:hover:text-gray-200"
          >{{ isExpanded(section.key) ? '▾' : '▸' }}</button>

          <draggable
            :model-value="[section.parent]"
            @update:model-value="value => emit('drop', { bucket: 'off', cards: value })"
            :group="{ name: 'rule-cards', pull: true, put: true }"
            :disabled="!dragEnabled"
            item-key="id"
            handle=".drag-handle"
            animation="180"
            class="min-w-0 flex-1"
          >
            <template #item="{ element }">
              <RuleCardItem
                :card="element"
                :effective-count="countFor(element)"
                :children="childrenInBucket(element.id)"
                :show-move-menu="!dragEnabled"
                :move-options="moveOptions"
                @move="value => emit('move', { cardId: element.id, bucket: value })"
              />
            </template>
          </draggable>
        </div>

        <p v-else class="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
          {{ t('settings.ruleGenLooseCards') }}
        </p>

        <!-- 小卡片，可单独拖走且不影响大卡片 -->
        <draggable
          v-if="!section.parent || isExpanded(section.key)"
          :model-value="section.children"
          @update:model-value="value => emit('drop', { bucket: 'off', cards: value })"
          :group="{ name: 'rule-cards', pull: true, put: true }"
          :disabled="!dragEnabled"
          item-key="id"
          handle=".drag-handle"
          animation="180"
          class="mt-1 min-h-[1.5rem] space-y-1"
          :class="section.parent ? 'ml-5' : ''"
        >
          <template #item="{ element }">
            <RuleCardItem
              :card="element"
              :effective-count="countFor(element)"
              :show-move-menu="!dragEnabled"
              :move-options="moveOptions"
              @move="value => emit('move', { cardId: element.id, bucket: value })"
            />
          </template>
        </draggable>
      </div>
    </div>
  </div>
</template>
