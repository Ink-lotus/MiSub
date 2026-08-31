<script setup>
/**
 * 去重撞车提示条（PROJECT_PLAN_2.0 §4.4 / B2）
 *
 * 用户输入优先：每条冲突给两个动作 ——
 *   保留我的 → 从对方卡片移除该来源，对方被移空后整卡消失
 *   删除     → 只从本卡片移除该来源
 */
import { useI18n } from '@/i18n/index.js';

const { t } = useI18n();

defineProps({
  conflicts: { type: Array, default: () => [] }
});

const emit = defineEmits(['keep-mine', 'drop-source']);

/** 冲突展示用的短标签：远程取文件名，内联取原值。 */
function shortValue(conflict) {
  if (conflict.kind === 'inline') return conflict.value;
  try {
    return new URL(conflict.value).pathname.split('/').filter(Boolean).pop() || conflict.value;
  } catch {
    return conflict.value;
  }
}
</script>

<template>
  <div v-if="conflicts.length" class="space-y-1.5 rounded-xl border border-red-300 bg-red-50 p-2.5 dark:border-red-500/40 dark:bg-red-900/20">
    <h4 class="text-xs font-bold text-red-700 dark:text-red-300">
      ⚠ {{ t('settings.ruleGenConflictTitle') }} ({{ conflicts.length }})
    </h4>

    <div
      v-for="conflict in conflicts"
      :key="conflict.key"
      class="flex flex-wrap items-center gap-2 rounded-lg bg-white/70 px-2 py-1.5 dark:bg-black/20"
    >
      <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-red-700 dark:text-red-300" :title="conflict.value">
        {{ shortValue(conflict) }}
      </span>

      <span class="shrink-0 text-[10px] text-gray-500 dark:text-gray-400">
        {{ conflict.entries.map(entry => entry.cardName).join(' ↔ ') }}
      </span>

      <div class="flex shrink-0 gap-1">
        <button
          v-for="entry in conflict.entries"
          :key="entry.cardId"
          type="button"
          @click="emit('keep-mine', { conflict, winnerCardId: entry.cardId })"
          class="rounded border border-emerald-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 transition hover:bg-emerald-50 dark:border-emerald-500/40 dark:bg-transparent dark:text-emerald-300"
        >{{ t('settings.ruleGenConflictKeepMine') }}: {{ entry.cardName }}</button>
      </div>
    </div>
  </div>
</template>
