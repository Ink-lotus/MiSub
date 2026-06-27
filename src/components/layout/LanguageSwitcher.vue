<script setup>
import { computed } from 'vue';
import { useI18n } from '../../i18n/index.js';

const { locale, setLocale, t } = useI18n();

const isZh = computed(() => locale.value === 'zh-CN');

function toggleLocale() {
  setLocale(isZh.value ? 'en-US' : 'zh-CN');
}

// Heroicons v2 globe-alt
const globePath = 'M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9';
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
      <path :d="globePath" />
    </svg>
    <span
      class="absolute -bottom-[2px] right-[1px] text-[7px] font-bold uppercase leading-none opacity-70"
    >{{ isZh ? '中' : 'EN' }}</span>
  </button>
</template>
