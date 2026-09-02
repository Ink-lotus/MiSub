<script setup>
import { computed, ref, watch } from 'vue';
import { useDataStore } from '@/stores/useDataStore.js';
import { useI18n } from '@/i18n/index.js';
import RuleGeneratorModal from '@/components/modals/RuleGeneratorModal.vue';
import { createDefaultState } from '@/utils/rule-generator/catalog.js';
import { serializeState } from '@/utils/rule-generator/serialize.js';

const { t } = useI18n();

const dataStore = useDataStore();

/**
 * 新模板的初始正文 = 可视化生成器默认状态的序列化结果。
 *
 * 刻意**不带** `; misub-visual-state-v1:` 注释头：那一行 base64 会占满文本框
 * 第一行且不可读。生成器的 parseIniToState() 认得这份骨架，会直接给默认状态、
 * 不报「按正文反推」的警告（parse.js 的 isUntouchedSkeleton）。
 *
 * 骨架里一张规则卡片都没有：分流方案由用户在可视化界面自己拼，不预设。
 * 旧版这里手写了一份含电报 / AI / 流媒体的样例，它的 URL 与内置目录不完全一致，
 * 反推时会撞出同名的重复卡片，已一并去掉。
 */
function defaultRuleTemplateContent() {
  return serializeState(createDefaultState(), { includeHeader: false }).ini;
}

const blankTemplate = () => ({
  id: '',
  name: '',
  description: '',
  type: 'ini',
  content: defaultRuleTemplateContent(),
  enabled: true
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
  localTemplates.value = cloneTemplates(dataStore.ruleTemplates);
  if (!selectedId.value && localTemplates.value[0]) {
    selectedId.value = localTemplates.value[0].id;
  }
  if (selectedId.value && !localTemplates.value.some(item => item.id === selectedId.value)) {
    selectedId.value = localTemplates.value[0]?.id || '';
  }
}

watch(() => dataStore.ruleTemplates, syncFromStore, { immediate: true, deep: true });

function createTemplate() {
  const now = Date.now().toString(36);
  const template = {
    ...blankTemplate(),
    id: `custom-${now}`,
    name: t('settings.ruleTemplateDefaultName')
  };
  localTemplates.value.unshift(template);
  selectedId.value = template.id;
}

function duplicateTemplate(template) {
  if (!template) return;
  const copy = cloneTemplates([template])[0];
  copy.id = `${template.id || 'custom'}-copy-${Date.now().toString(36)}`;
  copy.name = `${template.name || t('settings.ruleTemplateDefaultName')} ${t('settings.ruleTemplateCopySuffix')}`;
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
    await dataStore.fetchRuleTemplates();
    syncFromStore();
  } finally {
    isLoading.value = false;
  }
}

async function saveTemplates() {
  isSaving.value = true;
  try {
    const saved = await dataStore.saveRuleTemplates(localTemplates.value);
    localTemplates.value = cloneTemplates(saved);
    if (!localTemplates.value.some(item => item.id === selectedId.value)) {
      selectedId.value = localTemplates.value[0]?.id || '';
    }
  } finally {
    isSaving.value = false;
  }
}

// 可视化编辑器：只回写 content，落盘仍走上面的 saveTemplates（§7.1）
const showGenerator = ref(false);

/**
 * 顶栏入口。没有模板或未选中时先建一张，避免入口被
 * 「有模板」+「已选中」两层条件挡住而看不见。
 */
function openGenerator() {
  if (!selectedTemplate.value) createTemplate();
  showGenerator.value = true;
}

function applyGeneratedContent(ini) {
  if (selectedTemplate.value) selectedTemplate.value.content = ini;
}
</script>

<template>
  <div class="rounded-xl border border-emerald-100/80 bg-white/90 p-6 shadow-xs dark:border-emerald-900/30 dark:bg-gray-900/70">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h3 class="text-base font-bold text-gray-900 dark:text-gray-100">{{ t('settings.ruleTemplatesTitle') }}</h3>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {{ t('settings.ruleTemplatesDesc') }}
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          @click="refreshTemplates"
          :disabled="isLoading"
          class="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-white/5"
        >
          {{ isLoading ? t('settings.ruleTemplatesRefreshing') : t('settings.ruleTemplatesRefresh') }}
        </button>
        <button
          type="button"
          @click="createTemplate"
          class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700"
        >
          {{ t('settings.ruleTemplatesNew') }}
        </button>
        <button
          type="button"
          @click="openGenerator"
          class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-indigo-700"
        >
          {{ t('settings.ruleGenOpen') }}
        </button>
        <button
          type="button"
          @click="saveTemplates"
          :disabled="isSaving"
          class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
        >
          {{ isSaving ? t('settings.ruleTemplatesSaving') : t('settings.ruleTemplatesSave') }}
        </button>
      </div>
    </div>

    <div v-if="!hasTemplates" class="mt-5 rounded-xl border border-dashed border-gray-200 p-6 text-center dark:border-gray-700">
      <p class="text-sm font-medium text-gray-600 dark:text-gray-300">{{ t('settings.ruleTemplatesEmpty') }}</p>
      <p class="mt-1 text-xs text-gray-400">{{ t('settings.ruleTemplatesEmptyHint') }}</p>
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
          <div class="truncate text-xs font-bold">{{ template.name || t('settings.ruleTemplateUnnamed') }}</div>
          <div class="mt-1 truncate text-[10px] opacity-70">custom:{{ template.id }}</div>
        </button>
      </div>

      <div v-if="selectedTemplate" class="space-y-4 rounded-xl border border-gray-100 bg-gray-50/50 p-4 dark:border-white/10 dark:bg-white/5">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="mb-1 block text-[11px] font-bold uppercase tracking-wide text-gray-500">{{ t('settings.ruleTemplateName') }}</span>
            <input v-model="selectedTemplate.name" class="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
          </label>
          <label class="block">
            <span class="mb-1 block text-[11px] font-bold uppercase tracking-wide text-gray-500">{{ t('settings.ruleTemplateId') }}</span>
            <input v-model="selectedTemplate.id" class="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-mono dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
          </label>
        </div>

        <label class="block">
          <span class="mb-1 block text-[11px] font-bold uppercase tracking-wide text-gray-500">{{ t('settings.ruleTemplateDescription') }}</span>
          <input v-model="selectedTemplate.description" :placeholder="t('settings.ruleTemplateDescriptionPlaceholder')" class="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
        </label>

        <label class="block">
          <div class="mb-1 flex items-center justify-between gap-2">
            <span class="block text-[11px] font-bold uppercase tracking-wide text-gray-500">{{ t('settings.ruleTemplateContent') }}</span>
            <button
              type="button"
              @click="showGenerator = true"
              class="rounded-lg border border-indigo-200 px-2.5 py-1 text-[11px] font-semibold text-indigo-600 transition hover:bg-indigo-50 dark:border-indigo-500/40 dark:text-indigo-300 dark:hover:bg-indigo-900/20"
            >
              {{ t('settings.ruleGenOpen') }}
            </button>
          </div>
          <textarea
            v-model="selectedTemplate.content"
            rows="12"
            spellcheck="false"
            class="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
          ></textarea>
        </label>

        <div class="flex flex-wrap items-center justify-between gap-3">
          <label class="flex items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-300">
            <input v-model="selectedTemplate.enabled" type="checkbox" class="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500" />
            {{ t('settings.ruleTemplateEnabled') }}
          </label>
          <div class="flex gap-2">
            <button type="button" @click="duplicateTemplate(selectedTemplate)" class="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-white/5">{{ t('actions.copy') }}</button>
            <button type="button" @click="removeTemplate(selectedTemplate)" class="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 dark:border-red-900/40 dark:hover:bg-red-900/20">{{ t('actions.delete') }}</button>
          </div>
        </div>
      </div>
    </div>

    <RuleGeneratorModal
      v-if="selectedTemplate"
      v-model:show="showGenerator"
      :content="selectedTemplate.content"
      @apply="applyGeneratedContent"
    />
  </div>
</template>
