<script setup>
/**
 * 顶栏：基础策略组勾选 + 地区面板 + 自定义规则集构建器 + why 文案。
 *
 * 只放不可拖动的东西。自定义规则集在这里拼好后整组提交为
 * 一张大卡片 + 每行一张小卡片，落到左栏候选区顶部，不直接进右侧桶。
 */
import { computed, ref } from 'vue';
import { useI18n } from '@/i18n/index.js';
import { GROUP_NAMES, OTHER_REGION_ID } from '@/utils/rule-generator/catalog.js';

const { t } = useI18n();

const props = defineProps({
  base: { type: Object, required: true }
});

const emit = defineEmits(['toggle-base', 'toggle-region', 'submit-ruleset']);

const INLINE_TYPES = [
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD',
  'IP-CIDR', 'IP-CIDR6', 'GEOIP', 'GEOSITE',
  'PROCESS-NAME', 'DST-PORT'
];

const BASE_TOGGLES = [
  { key: 'manualSelect', labelKey: 'settings.ruleGenManualSelect' },
  { key: 'autoSelect', labelKey: 'settings.ruleGenAutoSelect' },
  { key: 'fallback', labelKey: 'settings.ruleGenFallback' }
];

const regionsOpen = ref(false);
const whyOpen = ref(false);

const namedRegions = computed(() => props.base.regions.filter(region => region.id !== OTHER_REGION_ID));
const otherRegion = computed(() => props.base.regions.find(region => region.id === OTHER_REGION_ID));
const enabledCount = computed(() => props.base.regions.filter(region => region.enabled).length);

// —— 自定义规则集草稿 ——

let rowSeq = 0;
function makeRow(kind = 'remote') {
  rowSeq += 1;
  return { key: `row-${rowSeq}`, kind, ruleType: 'DOMAIN-SUFFIX', value: '' };
}

const draftName = ref('');
const draftRows = ref([makeRow('remote')]);

const canSubmit = computed(() => draftRows.value.some(row => String(row.value || '').trim()));

function addRow(kind) {
  draftRows.value.push(makeRow(kind));
}

function removeRow(key) {
  draftRows.value = draftRows.value.filter(row => row.key !== key);
  if (draftRows.value.length === 0) draftRows.value = [makeRow('remote')];
}

function submit() {
  if (!canSubmit.value) return;
  emit('submit-ruleset', { name: draftName.value, rows: draftRows.value.map(row => ({ ...row })) });
  draftName.value = '';
  draftRows.value = [makeRow('remote')];
}
</script>

<template>
  <div class="space-y-3 rounded-xl border border-gray-200 bg-gray-50/60 p-3 dark:border-white/10 dark:bg-white/5">
    <!-- 📋 基础策略组 -->
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-[11px] font-bold text-gray-500">{{ t('settings.ruleGenBaseGroups') }}</span>

      <span
        :title="t('settings.ruleGenNodeSelectLocked')"
        class="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-900/20 dark:text-emerald-300"
      >{{ GROUP_NAMES.nodeSelect }} 🔒</span>

      <label
        v-for="toggle in BASE_TOGGLES"
        :key="toggle.key"
        class="flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition"
        :class="base[toggle.key]
          ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-900/20 dark:text-emerald-300'
          : 'border-gray-200 bg-white text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400'"
      >
        <input
          type="checkbox"
          :checked="base[toggle.key]"
          @change="emit('toggle-base', toggle.key)"
          class="h-3 w-3 rounded border-gray-300 text-emerald-600"
        />
        {{ t(toggle.labelKey) }}
      </label>

      <button
        type="button"
        @click="regionsOpen = !regionsOpen"
        class="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/5"
      >
        {{ t('settings.ruleGenRegions') }} ({{ enabledCount }}) {{ regionsOpen ? '▴' : '▾' }}
      </button>
    </div>

    <!-- 地区面板：逐个勾选，选中数量决定地区策略组数量 -->
    <div v-if="regionsOpen" class="flex flex-wrap gap-2 rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900">
      <label
        v-for="region in namedRegions"
        :key="region.id"
        class="flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition"
        :class="region.enabled
          ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-900/20 dark:text-emerald-300'
          : 'border-gray-200 text-gray-500 dark:border-gray-700 dark:text-gray-400'"
      >
        <input
          type="checkbox"
          :checked="region.enabled"
          @change="emit('toggle-region', region.id)"
          class="h-3 w-3 rounded border-gray-300 text-emerald-600"
        />
        {{ region.name }}
      </label>

      <label
        v-if="otherRegion"
        class="flex cursor-pointer items-center gap-1.5 rounded border border-dashed px-2 py-1 text-[11px] transition"
        :class="otherRegion.enabled
          ? 'border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-900/20 dark:text-emerald-300'
          : 'border-gray-300 text-gray-500 dark:border-gray-600 dark:text-gray-400'"
        :title="t('settings.ruleGenOtherRegionHint')"
      >
        <input
          type="checkbox"
          :checked="otherRegion.enabled"
          @change="emit('toggle-region', OTHER_REGION_ID)"
          class="h-3 w-3 rounded border-gray-300 text-emerald-600"
        />
        {{ GROUP_NAMES.otherRegion }}
      </label>
    </div>

    <!-- 🧱 自定义规则集：整组行合成一张大卡片，提交到左栏候选区顶部 -->
    <div class="space-y-2 rounded-lg border border-indigo-200 bg-indigo-50/50 p-2.5 dark:border-indigo-500/40 dark:bg-indigo-900/15">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[11px] font-bold text-gray-600 dark:text-gray-300">{{ t('settings.ruleGenCustomSet') }}</span>
        <input
          v-model="draftName"
          :placeholder="t('settings.ruleGenCustomSetName')"
          class="w-40 rounded border border-gray-200 bg-white px-2 py-1 text-[11px] dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        />
        <span class="text-[10px] text-gray-400">{{ t('settings.ruleGenCustomSetHint') }}</span>
      </div>

      <div v-for="row in draftRows" :key="row.key" class="flex flex-wrap items-center gap-2">
        <select
          v-model="row.kind"
          class="rounded border border-gray-200 bg-white px-1.5 py-1 text-[11px] dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          <option value="remote">{{ t('settings.ruleGenSourceRemote') }}</option>
          <option value="inline">{{ t('settings.ruleGenSourceInline') }}</option>
        </select>

        <select
          v-if="row.kind === 'inline'"
          v-model="row.ruleType"
          class="rounded border border-gray-200 bg-white px-1.5 py-1 text-[11px] dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          <option v-for="type in INLINE_TYPES" :key="type" :value="type">{{ type }}</option>
        </select>

        <input
          v-model="row.value"
          spellcheck="false"
          :placeholder="row.kind === 'inline' ? t('settings.ruleGenInlineValue') : t('settings.ruleGenRulesetUrl')"
          class="min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 py-1 font-mono text-[11px] dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
        />

        <button
          type="button"
          @click="removeRow(row.key)"
          :title="t('settings.ruleGenRemoveSource')"
          class="shrink-0 rounded border border-gray-200 px-1.5 py-1 text-[11px] text-gray-400 transition hover:border-red-300 hover:text-red-500 dark:border-gray-700"
        >✕</button>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          @click="addRow('remote')"
          class="rounded border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/5"
        >{{ t('settings.ruleGenAddUrlRow') }}</button>
        <button
          type="button"
          @click="addRow('inline')"
          class="rounded border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/5"
        >{{ t('settings.ruleGenAddInline') }}</button>
        <button
          type="button"
          @click="submit"
          :disabled="!canSubmit"
          class="ml-auto rounded bg-indigo-600 px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-40"
        >{{ t('settings.ruleGenSubmitSet') }}</button>
      </div>
    </div>

    <!-- why 文案：面向小白用户，这类文案比功能本身更决定留存 -->
    <div>
      <button
        type="button"
        @click="whyOpen = !whyOpen"
        class="text-[11px] font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
      >{{ t('settings.ruleGenWhyTitle') }} {{ whyOpen ? '▴' : '▾' }}</button>
      <p v-if="whyOpen" class="mt-1 rounded-lg bg-indigo-50/70 p-2 text-[11px] leading-relaxed text-indigo-800 dark:bg-indigo-900/20 dark:text-indigo-200">
        {{ t('settings.ruleGenWhyBody') }}
      </p>
    </div>
  </div>
</template>
