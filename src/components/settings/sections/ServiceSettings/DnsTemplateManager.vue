<script setup>
import { computed, ref, watch } from 'vue';
import { useDataStore } from '@/stores/useDataStore.js';
import { useI18n } from '@/i18n/index.js';
import { validateDnsTemplate, validatePolicyRecord, validateDnsTemplateResolvers, DNS_POLICY_WARNING_CODES } from '../../../../../shared/dns-template-validation.js';

const { t } = useI18n();

const dataStore = useDataStore();

const dnsFields = [
  { key: 'clash', name: 'Clash', labelKey: 'settings.dnsTemplateContentClash' },
  { key: 'singbox', name: 'Sing-Box', labelKey: 'settings.dnsTemplateContentSingbox' },
  { key: 'surge', name: 'Surge', labelKey: 'settings.dnsTemplateContentSurge' },
  { key: 'loon', name: 'Loon', labelKey: 'settings.dnsTemplateContentLoon' },
  { key: 'quanx', name: 'Quantumult X', labelKey: 'settings.dnsTemplateContentQuanx' }
];

const validationReasonKeys = {
  invalidYaml: 'settings.dnsValidationInvalidYaml',
  invalidJson: 'settings.dnsValidationInvalidJson',
  objectRequired: 'settings.dnsValidationObjectRequired',
  dnsWrapper: 'settings.dnsValidationDnsWrapper',
  singleLineRequired: 'settings.dnsValidationSingleLine',
  dnsServerWrapper: 'settings.dnsValidationDnsServerWrapper',
  sectionWrapper: 'settings.dnsValidationSectionWrapper',
  invalidLine: 'settings.dnsValidationInvalidLine',
  unsupportedField: 'settings.dnsValidationUnsupportedField'
};

const blankTemplate = () => ({
  id: '',
  name: '',
  description: '',
  enabled: true,
  kind: 'raw',
  policy: { mode: 'clean', domestic: [], foreign: [], polluted: [] },
  clash: '',
  singbox: '',
  surge: '',
  loon: '',
  quanx: ''
});

// 策略模式下 Clash / Sing-Box 由引擎合成，只有这三个格式仍需手写
const POLICY_RAW_FIELDS = ['surge', 'loon', 'quanx'];

const policyResolverFields = [
  { key: 'domestic', labelKey: 'settings.dnsPolicyDomestic' },
  { key: 'foreign', labelKey: 'settings.dnsPolicyForeign' },
  { key: 'polluted', labelKey: 'settings.dnsPolicyPolluted' }
];

const localTemplates = ref([]);
const selectedId = ref('');
const isSaving = ref(false);
const isLoading = ref(false);
const expandedFields = ref(new Set());

const selectedTemplate = computed(() => localTemplates.value.find(item => item.id === selectedId.value) || null);
const hasTemplates = computed(() => localTemplates.value.length > 0);
const selectedValidation = computed(() => validateDnsTemplate(selectedTemplate.value || {}));

const isPolicyMode = computed(() => selectedTemplate.value?.kind === 'policy');

// 策略模式只列出仍需手写的格式，手写模式列出全部
const visibleDnsFields = computed(() => (
  isPolicyMode.value ? dnsFields.filter(f => POLICY_RAW_FIELDS.includes(f.key)) : dnsFields
));

const policyWarnings = computed(() => (
  isPolicyMode.value ? validatePolicyRecord(selectedTemplate.value?.policy || {}).warnings : []
));

// validatePolicyRecord 只回 code，文案在这里按 code 取，保证中英一致
const policyWarningKeys = {
  [DNS_POLICY_WARNING_CODES.INVALID_MODE]: 'settings.dnsPolicyWarnInvalidMode',
  [DNS_POLICY_WARNING_CODES.DROPPED_RESOLVER]: 'settings.dnsPolicyWarnDroppedResolver'
};

function policyWarningText(warning) {
  const messageKey = policyWarningKeys[warning?.code];
  if (!messageKey) return '';
  const fieldEntry = policyResolverFields.find(item => item.key === warning.field);
  return t(messageKey, {
    value: warning.value ?? '',
    field: fieldEntry ? t(fieldEntry.labelKey) : (warning.field || '')
  });
}

// 手写字段里的回环/全零地址提示；纯 warn，不影响 status 与运行时取值
const resolverWarnings = computed(() => validateDnsTemplateResolvers(selectedTemplate.value || {}));

function fieldResolverWarnings(field) {
  return resolverWarnings.value[field] || [];
}

// 解析器列表在 UI 上按行编辑，存储仍是数组
function resolverText(field) {
  const list = selectedTemplate.value?.policy?.[field];
  return Array.isArray(list) ? list.join('\n') : '';
}

function setResolverText(field, value) {
  if (!selectedTemplate.value) return;
  if (!selectedTemplate.value.policy) {
    selectedTemplate.value.policy = { mode: 'clean', domestic: [], foreign: [], polluted: [] };
  }
  selectedTemplate.value.policy[field] = String(value || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function setKind(kind) {
  if (!selectedTemplate.value) return;
  selectedTemplate.value.kind = kind;
  if (kind === 'policy' && !selectedTemplate.value.policy) {
    selectedTemplate.value.policy = { mode: 'clean', domestic: [], foreign: [], polluted: [] };
  }
  expandedFields.value = new Set();
}

function validationResult(field) {
  return selectedValidation.value[field] || { status: 'empty', code: '' };
}

function validationLabel(field) {
  const status = validationResult(field).status;
  if (status === 'valid') return t('settings.dnsValidationValid');
  if (status === 'invalid') return t('settings.dnsValidationInvalid');
  return t('settings.dnsValidationEmpty');
}

function validationReason(field) {
  const key = validationReasonKeys[validationResult(field).code];
  return key ? t(key) : '';
}

function statusTextClass(field) {
  const status = validationResult(field).status;
  if (status === 'valid') return 'text-emerald-600 dark:text-emerald-400';
  if (status === 'invalid') return 'text-red-600 dark:text-red-400';
  return 'text-gray-400 dark:text-gray-500';
}

function statusDotClass(field) {
  const status = validationResult(field).status;
  if (status === 'valid') return 'bg-emerald-500';
  if (status === 'invalid') return 'bg-red-500';
  return 'bg-gray-300 dark:bg-gray-600';
}

function textareaBorderClass(field) {
  const status = validationResult(field).status;
  if (status === 'valid') return 'border-emerald-300 dark:border-emerald-700';
  if (status === 'invalid') return 'border-red-300 dark:border-red-700';
  return 'border-gray-200 dark:border-gray-700';
}

function cloneTemplates(items) {
  return JSON.parse(JSON.stringify(Array.isArray(items) ? items : []));
}

// 旧模板没有 kind / policy 字段，补齐后才能进 UI；未知 kind 回落 raw
function withKindDefaults(items) {
  return items.map(item => ({
    ...item,
    kind: item.kind === 'policy' ? 'policy' : 'raw',
    policy: {
      mode: item.policy?.mode === 'polluted' ? 'polluted' : 'clean',
      domestic: Array.isArray(item.policy?.domestic) ? item.policy.domestic : [],
      foreign: Array.isArray(item.policy?.foreign) ? item.policy.foreign : [],
      polluted: Array.isArray(item.policy?.polluted) ? item.policy.polluted : []
    }
  }));
}

function syncFromStore() {
  localTemplates.value = withKindDefaults(cloneTemplates(dataStore.dnsTemplates));
  if (!selectedId.value && localTemplates.value[0]) {
    selectedId.value = localTemplates.value[0].id;
  }
  if (selectedId.value && !localTemplates.value.some(item => item.id === selectedId.value)) {
    selectedId.value = localTemplates.value[0]?.id || '';
  }
}

watch(() => dataStore.dnsTemplates, syncFromStore, { immediate: true, deep: true });
watch(selectedId, () => {
  expandedFields.value = new Set();
});

function isFieldExpanded(field) {
  return expandedFields.value.has(field);
}

function toggleField(field) {
  const next = new Set(expandedFields.value);
  if (next.has(field)) {
    next.delete(field);
  } else {
    next.add(field);
  }
  expandedFields.value = next;
}

function textareaRows(value) {
  const lineCount = String(value || '').split('\n').length;
  return Math.min(12, Math.max(4, lineCount));
}

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
    localTemplates.value = withKindDefaults(cloneTemplates(saved));
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
          data-dns-save
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

        <div data-dns-kind-switch class="space-y-2">
          <span class="block text-[11px] font-bold uppercase tracking-wide text-gray-500">{{ t('settings.dnsTemplateKindLabel') }}</span>
          <div class="inline-flex rounded-lg border border-gray-200 p-0.5 dark:border-gray-700">
            <button
              v-for="kind in ['raw', 'policy']"
              :key="kind"
              type="button"
              :data-dns-kind="kind"
              :aria-pressed="selectedTemplate.kind === kind"
              @click="setKind(kind)"
              :class="selectedTemplate.kind === kind
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/5'"
              class="rounded-md px-3 py-1.5 text-xs font-semibold transition"
            >
              {{ kind === 'raw' ? t('settings.dnsTemplateKindRaw') : t('settings.dnsTemplateKindPolicy') }}
            </button>
          </div>
          <p class="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
            {{ isPolicyMode ? t('settings.dnsTemplateKindPolicyHint') : t('settings.dnsTemplateKindRawHint') }}
          </p>
        </div>

        <div v-if="isPolicyMode" data-dns-policy-panel class="space-y-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900/40">
          <label class="block">
            <span class="mb-1 block text-[11px] font-bold uppercase tracking-wide text-gray-500">{{ t('settings.dnsPolicyMode') }}</span>
            <select
              v-model="selectedTemplate.policy.mode"
              data-dns-policy-mode
              class="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="clean">{{ t('settings.dnsPolicyModeClean') }}</option>
              <option value="polluted">{{ t('settings.dnsPolicyModePolluted') }}</option>
            </select>
          </label>

          <label v-for="field in policyResolverFields" :key="field.key" class="block">
            <span class="mb-1 block text-[11px] font-bold uppercase tracking-wide text-gray-500">{{ t(field.labelKey) }}</span>
            <textarea
              :value="resolverText(field.key)"
              @input="setResolverText(field.key, $event.target.value)"
              :data-dns-policy-field="field.key"
              :aria-label="t(field.labelKey)"
              rows="3"
              spellcheck="false"
              :placeholder="t('settings.dnsPolicyResolverHint')"
              class="block w-full resize-none rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
            ></textarea>
          </label>

          <div data-dns-policy-warnings class="border-t border-gray-100 pt-2 dark:border-gray-800">
            <span class="text-[11px] font-semibold text-gray-500 dark:text-gray-400">{{ t('settings.dnsPolicyWarningsTitle') }}</span>
            <p v-if="!policyWarnings.length" class="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">{{ t('settings.dnsPolicyNoWarnings') }}</p>
            <ul v-else class="mt-1 space-y-0.5">
              <li v-for="(warning, index) in policyWarnings" :key="index" class="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">{{ policyWarningText(warning) }}</li>
            </ul>
          </div>
        </div>

        <div data-dns-validation-summary class="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-gray-200 py-2 dark:border-gray-700">
          <span class="text-[11px] font-semibold text-gray-500 dark:text-gray-400">{{ t('settings.dnsValidationSummary') }}</span>
          <span v-for="field in visibleDnsFields" :key="field.key" class="flex items-center gap-1.5 text-[11px]">
            <span class="h-1.5 w-1.5 rounded-full" :class="statusDotClass(field.key)"></span>
            <span class="font-medium text-gray-600 dark:text-gray-300">{{ field.name }}</span>
            <span :class="statusTextClass(field.key)">{{ validationLabel(field.key) }}</span>
          </span>
        </div>

        <div class="divide-y divide-gray-200 overflow-hidden rounded-lg border border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-900/40">
          <div v-for="field in visibleDnsFields" :key="field.key">
            <button
              type="button"
              :data-dns-toggle="field.key"
              :aria-expanded="isFieldExpanded(field.key)"
              :aria-controls="`dns-field-panel-${field.key}`"
              @click="toggleField(field.key)"
              class="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-gray-50 dark:hover:bg-white/5"
            >
              <span class="text-[11px] font-bold uppercase tracking-wide text-gray-500">{{ t(field.labelKey) }}</span>
              <span class="flex shrink-0 items-center gap-2">
                <span
                  v-if="fieldResolverWarnings(field.key).length"
                  :data-dns-resolver-badge="field.key"
                  :title="t('settings.dnsResolverLoopbackWarning')"
                  class="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                >{{ fieldResolverWarnings(field.key).length }}</span>
                <span :data-dns-status="field.key" class="flex items-center gap-1.5 text-[11px] font-semibold" :class="statusTextClass(field.key)">
                  <span class="h-1.5 w-1.5 rounded-full" :class="statusDotClass(field.key)"></span>
                  {{ validationLabel(field.key) }}
                </span>
                <svg
                  aria-hidden="true"
                  class="h-4 w-4 text-gray-400 transition-transform duration-200"
                  :class="{ 'rotate-90': isFieldExpanded(field.key) }"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
              </span>
            </button>
            <div
              v-if="isFieldExpanded(field.key)"
              :id="`dns-field-panel-${field.key}`"
              class="border-t border-gray-100 px-3 pb-3 pt-2 dark:border-gray-800"
            >
              <textarea
                v-model="selectedTemplate[field.key]"
                :data-dns-field="field.key"
                :aria-label="t(field.labelKey)"
                :aria-invalid="validationResult(field.key).status === 'invalid'"
                :rows="textareaRows(selectedTemplate[field.key])"
                spellcheck="false"
                :placeholder="t('settings.dnsPlaceholder')"
                :class="textareaBorderClass(field.key)"
                class="block w-full resize-none rounded-lg border bg-white px-3 py-2 font-mono text-xs leading-relaxed dark:bg-gray-950 dark:text-gray-100"
              ></textarea>
              <p v-if="validationResult(field.key).status === 'invalid'" class="mt-1 text-[11px] leading-relaxed text-red-600 dark:text-red-400">
                {{ validationReason(field.key) }} {{ t('settings.dnsValidationFallback') }}
              </p>
              <p
                v-if="fieldResolverWarnings(field.key).length"
                :data-dns-resolver-warning="field.key"
                class="mt-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400"
              >
                {{ t('settings.dnsResolverLoopbackWarning') }} {{ fieldResolverWarnings(field.key).join('、') }}
              </p>
            </div>
          </div>
        </div>

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
