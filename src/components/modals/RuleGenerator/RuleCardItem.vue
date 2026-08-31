<script setup>
/**
 * 单张规则卡片。大卡片与小卡片共用本组件，靠 `card.parentId` 区分层级。
 *
 * 卡片上**没有出口下拉** —— 出口由策略组决定，组成员里含 🚀 节点选择 与 DIRECT，
 * 用户在客户端自行选择，不在卡片上写死。
 *
 * 广告类卡片只加一个橙色 AD 角标，不改底色边框：红色留给去重撞车独占，
 * 两种状态才不会混淆。
 */
import { computed } from 'vue';
import { useI18n } from '@/i18n/index.js';

const { t } = useI18n();

const props = defineProps({
  card: { type: Object, required: true },
  /** 该卡片实际产出的来源数（大卡片含其小卡片） */
  effectiveCount: { type: Number, default: 0 },
  /** 大卡片下当前同桶的小卡片 */
  children: { type: Array, default: () => [] },
  /** 是否展开来源明细 */
  showSources: { type: Boolean, default: false },
  /** 窄屏降级：显示「移到…」下拉取代拖拽 */
  showMoveMenu: { type: Boolean, default: false },
  moveOptions: { type: Array, default: () => [] },
  /** 命中去重冲突时标红 */
  conflicting: { type: Boolean, default: false },
  /** 大卡片内小卡片归零 —— 不产出任何内容 */
  isEmpty: { type: Boolean, default: false }
});

const emit = defineEmits(['move', 'remove-source', 'move-child']);

const isParent = computed(() => props.card.parentId === null);
const isAd = computed(() => /广告/.test(props.card.name));
const isPinned = computed(() => Number(props.card.order) >= 900);

/** 来源摘要：远程取文件名，内联取「类型 值」。 */
function sourceLabel(source) {
  if (source.kind === 'inline') return `${source.ruleType},${source.value}`;
  try {
    return new URL(source.value).pathname.split('/').filter(Boolean).pop() || source.value;
  } catch {
    return source.value;
  }
}
</script>

<template>
  <div
    class="group rounded-lg border px-3 py-2 transition"
    :class="[
      conflicting
        ? 'border-red-400 bg-red-50 dark:border-red-500/60 dark:bg-red-900/20'
        : 'border-gray-200 bg-white hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-white/5',
      isParent ? 'border-l-2 border-l-indigo-300 dark:border-l-indigo-500/50' : ''
    ]"
  >
    <div class="flex items-center gap-2">
      <span class="drag-handle cursor-grab select-none text-gray-300 dark:text-gray-600" aria-hidden="true">⋮⋮</span>

      <span
        class="min-w-0 flex-1 truncate text-xs"
        :class="isParent
          ? 'font-bold text-gray-800 dark:text-gray-100'
          : 'font-medium text-gray-600 dark:text-gray-300'"
      >{{ card.name }}</span>

      <!-- 广告卡片只加角标，不改配色 —— 红色专属于撞车状态 -->
      <span
        v-if="isAd"
        :title="t('settings.ruleGenAdCardHint')"
        class="shrink-0 rounded bg-orange-500 px-1.5 py-0.5 text-[9px] font-bold leading-none text-white"
      >{{ t('settings.ruleGenAdBadge') }}</span>

      <span
        v-if="isPinned"
        :title="card.note || ''"
        class="shrink-0 text-[9px] text-gray-400"
      >{{ t('settings.ruleGenPinned') }}</span>

      <!-- 大卡片显示小卡片数，小卡片显示自身来源数 -->
      <span
        v-if="isParent"
        class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
        :class="isEmpty
          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
          : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'"
      >{{ children.length }}</span>
      <span
        v-else-if="effectiveCount > 1"
        class="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold text-gray-500 dark:bg-white/10 dark:text-gray-400"
      >{{ effectiveCount }}</span>
    </div>

    <p v-if="isEmpty" class="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
      {{ t('settings.ruleGenEmptyParent') }}
    </p>

    <div v-if="showMoveMenu" class="mt-2">
      <select
        value=""
        @change="emit('move', $event.target.value); $event.target.value = ''"
        class="rounded border border-gray-200 bg-white px-1.5 py-1 text-[11px] dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
      >
        <option value="">{{ t('settings.ruleGenMoveTo') }}</option>
        <option v-for="option in moveOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    </div>

    <!-- 大卡片展开：列出小卡片，各自可单独移走 -->
    <ul v-if="showSources && isParent && children.length" class="mt-2 space-y-1 border-t border-gray-100 pt-2 dark:border-white/5">
      <li
        v-for="child in children"
        :key="child.id"
        class="flex items-center gap-2 text-[10px] text-gray-500 dark:text-gray-400"
      >
        <span class="truncate">· {{ child.name }}</span>
        <span class="shrink-0 rounded bg-gray-100 px-1 text-[9px] dark:bg-white/10">
          {{ (child.sources || []).length }}
        </span>
        <select
          v-if="showMoveMenu"
          value=""
          @change="emit('move-child', { cardId: child.id, bucket: $event.target.value }); $event.target.value = ''"
          class="ml-auto shrink-0 rounded border border-gray-200 bg-white px-1 py-0.5 text-[10px] dark:border-gray-700 dark:bg-gray-900"
        >
          <option value="">{{ t('settings.ruleGenMoveTo') }}</option>
          <option v-for="option in moveOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </li>
    </ul>

    <!-- 小卡片展开：列出自身来源 -->
    <ul v-if="showSources && !isParent && (card.sources || []).length" class="mt-2 space-y-1 border-t border-gray-100 pt-2 dark:border-white/5">
      <li
        v-for="source in card.sources"
        :key="source.id"
        class="flex items-center gap-2 text-[10px] text-gray-500 dark:text-gray-400"
      >
        <span class="truncate font-mono">· {{ sourceLabel(source) }}</span>
        <button
          type="button"
          :title="t('settings.ruleGenRemoveSource')"
          @click="emit('remove-source', source.id)"
          class="ml-auto shrink-0 text-gray-300 opacity-0 transition group-hover:opacity-100 hover:text-red-500"
        >✕</button>
      </li>
    </ul>

    <p v-if="card.note && !showSources" class="mt-1 truncate text-[10px] text-gray-400">{{ card.note }}</p>
  </div>
</template>
