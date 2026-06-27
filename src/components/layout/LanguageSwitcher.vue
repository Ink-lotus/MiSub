<script setup>
import { computed } from 'vue';
import { useI18n } from '../../i18n/index.js';

const { locale, setLocale, t } = useI18n();

const isZh = computed(() => locale.value === 'zh-CN');

function toggleLocale() {
  setLocale(isZh.value ? 'en-US' : 'zh-CN');
}
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
      <!-- Left: stylized "A" -->
      <path d="M3 17 L4 5 L9 17" />
      <path d="M3.5 11 h5" />
      <!-- Right: stylized character (vertical + 2 horizontals) -->
      <path d="M14 4 v14" />
      <path d="M12 9 h8" />
      <path d="M12 15 h8" />
    </svg>
  </button>
</template>