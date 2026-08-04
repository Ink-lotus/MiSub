<script setup>
import { computed, ref, watch } from 'vue';
import { useDataStore } from '@/stores/useDataStore.js';
import { useI18n } from '@/i18n/index.js';

const { t } = useI18n();

const dataStore = useDataStore();

const blankTemplate = () => ({
  id: '',
  name: '',
  description: '',
  enabled: true,
  clash: '',
  singbox: '',
  surge: '',
  loon: '',
  quanx: ''
});

const localTemplates = ref([]);
const selectedId = ref('');
const isSaving = ref(false);
const isLoading = ref(false);

const selectedTemplate = computed(() => localTemplates.value.find(item => item.id === selectedId.value) || null);
const hasTemplates = computed(() => localTemplates.value.length > 0);

function cloneTemplates(items) {
  return JSON.parse(JSON.stringify(Array.isArray(items) ? items : []));
}

function syncFromStore() {
  localTemplates.value = cloneTemplates(dataStore.dnsTemplates);
  if (!selectedId.value && localTemplates.value[0]) {
    selectedId.value = localTemplates.value[0].id;
  }
  if (selectedId.value && !localTemplates.value.some(item => item.id === selectedId.value)) {
    selectedId.value = localTemplates.value[0]?.id || '';
  }
}

watch(() => dataStore.dnsTemplates, syncFromStore, { immediate: true, deep: true });

function createTemplate() {
  const now = Date.now().toString(36);
  const template = {
    ...blankTemplate(),
    id: `dns-${now}`,
    name: t('settings.dnsTemplateDefaultName')
  };
  localTemplates.value.unshift(template);
  selectedId.value = template.id;
}

function duplicateTemplate(template) {
  if (!template) return;
  const copy = cloneTemplates([template])[0];
  copy.id = `${template.id || 'dns'}-copy-${Date.now().toString(36)}`;
  copy.name = `${template.name || t('settings.dnsTemplateDefaultName')} ${t('actions.copy')}`;
  localTemplates.value.unshift(copy);
  selectedId.value = copy.id;
}

function removeTemplate(template) {
  if (!template) return;
  localTemplates.value = localTemplates.value.filter(item => item.id !== template.id);
  selectedId.value = localTemplates.value[0]?.id || '';
}

async function refreshTemplates() {
  isLoading.value = true;
  try {
    await dataStore.fetchDnsTemplates();
    syncFromStore();
  } finally {
    isLoading.value = false;
  }
}

async function saveTemplates() {
  isSaving.value = true;
  try {
    const saved = await dataStore.saveDnsTemplates(localTemplates.value);
    localTemplates.value = cloneTemplates(saved);
    if (!localTemplates.value.some(item => item.id === selectedId.value)) {
      selectedId.value = localTemplates.value[0]?.id || '';
    }
  } finally {
    isSaving.value = false;
  }
}
</script>

<template>
  <div class="rounded-xl border border-emerald-100/80 bg-white/90 p-6 shadow-xs dark:border-emerald-900/30 dark:bg-gray-900/70">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h3 class="text-base font-bold text-gray-900 dark:text-gray-100">{{ t('settings.dnsTemplatesTitle') }}</h3>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {{ t('settings.dnsTemplatesDesc') }}
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          @click="refreshTemplates"
          :disabled="isLoading"
          class="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-white/5"
        >
          {{ t('settings.dnsTemplatesRefresh') }}
        </button>
        <button
          type="button"
          @click="createTemplate"
          class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700"
        >
          {{ t('settings.dnsTemplatesNew') }}
        </button>
        <button
          type="button"
          @click="saveTemplates"
          :disabled="isSaving"
          class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
        >
          {{ t('settings.dnsTemplatesSave') }}
        </button>
      </div>
    </div>

    <div v-if="!hasTemplates" class="mt-5 rounded-xl border border-dashed border-gray-200 p-6 text-center dark:border-gray-700">
      <p class="text-sm font-medium text-gray-600 dark:text-gray-300">{{ t('settings.dnsTemplatesEmpty') }}</p>
      <p class="mt-1 text-xs text-gray-400">{{ t('settings.dnsTemplatesEmptyHint') }}</p>
    </div>

    <div v-else class="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
      <div class="space-y-2">
        <button
          v-for="template in localTemplates"
          :key="template.id"
          type="button"
          @click="selectedId = template.id"
          :class="selectedId === template.id ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/5'"
          class="w-full rounded-lg border px-3 py-2 text-left transition"
        >
          <div class="truncate text-xs font-bold">{{ template.name || t('settings.dnsTemplateDefaultName') }}</div>
          <div class="mt-1 truncate text-[10px] opacity-70">dns:{{ template.id }}</div>
        </button>
      </div>

      <div v-if="selectedTemplate" class="space-y-4 rounded-xl border border-gray-100 bg-gray-50/50 p-4 dark:border-white/10 dark:bg-white/5">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="mb-1 block text-[11px] font-bold uppercase tracking-wide text-gray-500">{{ t('settings.dnsTemplateName') }}</span>
            <input v-model="selectedTemplate.name" class="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
          </label>
          <label class="block">
            <span class="mb-1 block text-[11px] font-bold uppercase tracking-wide text-gray-500">{{ t('settings.dnsTemplateDescription') }}</span>
            <input v-model="selectedTemplate.description" class="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
          </label>
        </div>

        <label class="block">
          <span class="mb-1 block text-[11px] font-bold uppercase tracking-wide text-gray-500">{{ t('settings.dnsTemplateContentClash') }}</span>
          <textarea v-model="selectedTemplate.clash" rows="4" spellcheck="false" :placeholder="t('settings.dnsPlaceholder')" class="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"></textarea>
        </label>

        <label class="block">
          <span class="mb-1 block text-[11px] font-bold uppercase tracking-wide text-gray-500">{{ t('settings.dnsTemplateContentSingbox') }}</span>
          <textarea v-model="selectedTemplate.singbox" rows="4" spellcheck="false" :placeholder="t('settings.dnsPlaceholder')" class="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"></textarea>
        </label>

        <label class="block">
          <span class="mb-1 block text-[11px] font-bold uppercase tracking-wide text-gray-500">{{ t('settings.dnsTemplateContentSurge') }}</span>
          <textarea v-model="selectedTemplate.surge" rows="4" spellcheck="false" :placeholder="t('settings.dnsPlaceholder')" class="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"></textarea>
        </label>

        <label class="block">
          <span class="mb-1 block text-[11px] font-bold uppercase tracking-wide text-gray-500">{{ t('settings.dnsTemplateContentLoon') }}</span>
          <textarea v-model="selectedTemplate.loon" rows="4" spellcheck="false" :placeholder="t('settings.dnsPlaceholder')" class="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"></textarea>
        </label>

        <label class="block">
          <span class="mb-1 block text-[11px] font-bold uppercase tracking-wide text-gray-500">{{ t('settings.dnsTemplateContentQuanx') }}</span>
          <textarea v-model="selectedTemplate.quanx" rows="4" spellcheck="false" :placeholder="t('settings.dnsPlaceholder')" class="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"></textarea>
        </label>

        <div class="flex flex-wrap items-center justify-between gap-3">
          <label class="flex items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-300">
            <input v-model="selectedTemplate.enabled" type="checkbox" class="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500" />
            {{ t('settings.dnsTemplateEnabled') }}
          </label>
          <div class="flex gap-2">
            <button type="button" @click="duplicateTemplate(selectedTemplate)" class="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-white/5">{{ t('actions.copy') }}</button>
            <button type="button" @click="removeTemplate(selectedTemplate)" class="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 dark:border-red-900/40 dark:hover:bg-red-900/20">{{ t('actions.delete') }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
