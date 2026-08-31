<script setup>
/**
 * INI 预览 + 校验结果 + 策略组计数器（PROJECT_PLAN_2.0 §6.3 / §7.2 / B2）
 *
 * 计数器只提示不拦截：MiSub 侧不存在策略组数量上限，按自定数字硬拦截会重复
 * 旧文档 R6 的错误。
 */
import { computed, ref } from 'vue';
import { useI18n } from '@/i18n/index.js';

const { t } = useI18n();

const props = defineProps({
  ini: { type: String, default: '' },
  groupCount: { type: Number, default: 0 },
  ruleCount: { type: Number, default: 0 },
  countLevel: { type: String, default: 'green' },
  findings: { type: Array, default: () => [] }
});

const copied = ref(false);
const expanded = ref(false);

const errors = computed(() => props.findings.filter(item => item.level === 'error'));
const warnings = computed(() => props.findings.filter(item => item.level === 'warn'));

const countClass = computed(() => ({
  green: 'text-emerald-600 dark:text-emerald-400',
  yellow: 'text-amber-600 dark:text-amber-400',
  red: 'text-red-600 dark:text-red-400'
}[props.countLevel] || ''));

/** 预览里把 base64 注释头折叠，它对用户没有阅读价值。 */
const previewText = computed(() => props.ini
  .split('\n')
  .map(line => (line.startsWith('; misub-visual-state-v1:')
    ? '; misub-visual-state-v1: <可视化状态，勿手动修改>'
    : line))
  .join('\n'));

async function copyIni() {
  try {
    await navigator.clipboard.writeText(props.ini);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <div class="rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-gray-900/50">
    <div class="flex flex-wrap items-center gap-3 border-b border-gray-100 px-3 py-2 dark:border-white/5">
      <button
        type="button"
        @click="expanded = !expanded"
        class="text-xs font-bold text-gray-700 dark:text-gray-200"
      >{{ expanded ? '▾' : '▸' }} {{ t('settings.ruleGenPreviewTitle') }}</button>

      <span class="text-[11px]" :class="countClass">
        📊 {{ t('settings.ruleGenGroupCount') }} {{ groupCount }}
      </span>
      <span class="text-[11px] text-gray-500 dark:text-gray-400">
        · {{ t('settings.ruleGenRuleCount') }} {{ ruleCount }}
      </span>

      <span v-if="!errors.length" class="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
        ✓ {{ t('settings.ruleGenNoErrors') }}
      </span>
      <span v-else class="text-[11px] font-semibold text-red-600 dark:text-red-400">
        ✕ {{ errors.length }} {{ t('settings.ruleGenErrorCount') }}
      </span>
      <span v-if="warnings.length" class="text-[11px] text-amber-600 dark:text-amber-400">
        ⚠ {{ warnings.length }} {{ t('settings.ruleGenWarnCount') }}
      </span>

      <button
        type="button"
        @click="copyIni"
        class="ml-auto rounded border border-gray-200 px-2 py-0.5 text-[11px] font-semibold text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-white/5"
      >{{ copied ? t('settings.ruleGenCopied') : t('settings.ruleGenCopy') }}</button>
    </div>

    <ul v-if="findings.length" class="max-h-32 space-y-1 overflow-y-auto px-3 py-2">
      <li
        v-for="(item, index) in findings"
        :key="`${item.field}-${index}`"
        class="flex items-start gap-1.5 text-[11px] leading-snug"
        :class="item.level === 'error'
          ? 'text-red-600 dark:text-red-400'
          : 'text-amber-600 dark:text-amber-400'"
      >
        <span class="shrink-0">{{ item.level === 'error' ? '✕' : '⚠' }}</span>
        <span>{{ item.message }}</span>
      </li>
    </ul>

    <pre
      v-if="expanded"
      class="max-h-64 overflow-auto border-t border-gray-100 p-3 font-mono text-[10px] leading-relaxed text-gray-700 dark:border-white/5 dark:text-gray-300"
    >{{ previewText }}</pre>
  </div>
</template>
