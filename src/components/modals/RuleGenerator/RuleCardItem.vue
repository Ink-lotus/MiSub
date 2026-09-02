<script setup>
/**
 * 单张规则卡片。大卡片与小卡片共用本组件，靠 `card.parentId` 区分层级。
 *
 * 卡片上**没有出口下拉** —— 出口由策略组决定，组成员里含 🚀 节点选择 与 DIRECT，
 * 用户在客户端自行选择，不在卡片上写死。
 *
 * 大卡片的小卡片**不在这里渲染** —— 它们在 CardPalette / BucketPanel 里各自是
 * 一条可拖放列表（拖进去即改父）。本组件只用 `children` 显示数量与空集合判定。
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
  /** 大卡片下当前同桶的小卡片，只用于计数与空集合提示 */
  children: { type: Array, default: () => [] },
  /** 大卡片：它有自己的小卡片列表，卡片左侧给一个展开钮 */
  expandable: { type: Boolean, default: false },
  expanded: { type: Boolean, default: false },
  /** 小卡片与父卡片同桶时，是否给「独立成组 / 并入集合」开关 */
  detachable: { type: Boolean, default: false },
  standalone: { type: Boolean, default: false },
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

const emit = defineEmits(['move', 'remove-source', 'toggle', 'toggle-standalone']);

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
    class="group cursor-grab rounded-lg border px-3 py-2 transition active:cursor-grabbing"
    :class="[
      conflicting
        ? 'border-red-400 bg-red-50 dark:border-red-500/60 dark:bg-red-900/20'
        : 'border-gray-200 bg-white hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-white/5',
      isParent ? 'border-l-2 border-l-indigo-300 dark:border-l-indigo-500/50' : ''
    ]"
  >
    <div class="flex items-center gap-2">
      <!--
        展开钮长在卡片里、占原来 `⋮⋮` 那个位置。整张卡片都能拖之后
        把手已无必要，留着反而挤掉一格宽度。它是 <button>，被
        dragOptions 的 filter 排除，因此点它不会起拖拽。
      -->
      <button
        v-if="expandable"
        type="button"
        :title="t('settings.ruleGenToggleSection')"
        :aria-expanded="expanded"
        @click.stop="emit('toggle')"
        class="no-drag -ml-1.5 flex h-7 w-6 shrink-0 items-center justify-center rounded text-sm leading-none text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200"
      >{{ expanded ? '▾' : '▸' }}</button>

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

      <!--
        独立成组开关。只在灵活桶里、且这张小卡片与父卡片同桶时出现：
        那种情况下它默认被父卡片代表（并进同一个策略组），点一下改为自己成组。
      -->
      <button
        v-if="detachable"
        type="button"
        :title="standalone ? t('settings.ruleGenAttachHint') : t('settings.ruleGenDetachHint')"
        @click.stop="emit('toggle-standalone')"
        class="no-drag shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-bold leading-none transition"
        :class="standalone
          ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/50 dark:bg-indigo-900/30 dark:text-indigo-300'
          : 'border-gray-200 text-gray-400 hover:text-gray-600 dark:border-gray-700 dark:hover:text-gray-200'"
      >{{ standalone ? t('settings.ruleGenAttach') : t('settings.ruleGenDetach') }}</button>

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

    <!--
      窄屏降级用的「移到…」下拉：放在卡片**右下角**，那里离拇指最近。
      它排在来源清单与备注之后，因此永远是卡片里最后一个可操作元素。
    -->
    <div v-if="showMoveMenu" class="mt-2 flex justify-end">
      <select
        value=""
        :aria-label="t('settings.ruleGenMoveTo')"
        @change="emit('move', $event.target.value); $event.target.value = ''"
        class="rounded border border-gray-200 bg-white px-2 py-1.5 text-[11px] dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
      >
        <option value="">{{ t('settings.ruleGenMoveTo') }}</option>
        <option v-for="option in moveOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    </div>
  </div>
</template>
