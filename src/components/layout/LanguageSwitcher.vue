<script setup>
import { computed } from 'vue';
import { useI18n } from '../../i18n/index.js';

const { locale, setLocale, t } = useI18n();

const isZh = computed(() => locale.value === 'zh-CN');

function toggleLocale() {
  setLocale(isZh.value ? 'en-US' : 'zh-CN');
}

// Lucide "languages" — translate icon (A + 文)
const langPath = 'm5 8 6 6m-7-6 6-6 2-3M2 5h12M7 7h2m8 6 3 9h2l3-9m-8 0h6m-3 9v-6';
</script>

<template>
  <button
    @click="toggleLocale"
    class="nav-action-btn nav-action-btn-neutral rounded-full relative"
    :title="isZh ? t('common.switchToEnglish') : t('common.switchToChinese')"
    :aria-label="isZh ? t('common.switchToEnglish') : t('common.switchToChinese')"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path :d="langPath" />
    </svg>
    </button>
</template>
