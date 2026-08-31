<script setup>
/**
 * 可视化规则生成器主容器（PROJECT_PLAN_2.0 §7.1 / B1）
 *
 * 职责：持有 GeneratorState、收口全部拖放与编辑事件、把序列化结果回传给
 * RuleTemplateManager。**不直接调 API** —— 落盘仍由现有的
 * dataStore.saveRuleTemplates() 完成（§7.1）。
 */
import { computed, ref, watch } from 'vue';
import Modal from '../forms/Modal.vue';
import { useI18n } from '@/i18n/index.js';
import {
  OTHER_REGION_ID,
  createDefaultState,
  effectiveSources
} from '@/utils/rule-generator/catalog.js';
import { serializeState } from '@/utils/rule-generator/serialize.js';
import { parseIniToState } from '@/utils/rule-generator/parse.js';
import { validateState } from '@/utils/rule-generator/validate.js';
import {
  findSourceConflicts,
  resolveConflictKeepMine,
  removeSourceFromCard
} from '@/utils/rule-generator/dedupe.js';
import GeneratorTopBar from './RuleGenerator/GeneratorTopBar.vue';
import CardPalette from './RuleGenerator/CardPalette.vue';
import BucketPanel from './RuleGenerator/BucketPanel.vue';
import DedupeConflictBar from './RuleGenerator/DedupeConflictBar.vue';
import IniPreview from './RuleGenerator/IniPreview.vue';

const { t } = useI18n();

const props = defineProps({
  show: Boolean,
  /** 打开时的模板正文，用于反解还原状态 */
  content: { type: String, default: '' }
});

const emit = defineEmits(['update:show', 'apply']);

const state = ref(createDefaultState());
const parseWarnings = ref([]);
const isPartial = ref(false);
const isDrifted = ref(false);

/** 每段的折叠状态。默认只展开有内容的几段。 */
const collapsed = ref({
  prepend: false, flexible: false,
  adblock: true, proxy: true, direct: true, final: true
});

/** 窄屏不启用拖拽，改用「移到… ▾」下拉，语义等价（§7.2）。 */
const isNarrow = ref(false);
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const query = window.matchMedia('(max-width: 1023px)');
  isNarrow.value = query.matches;
  const onChange = event => { isNarrow.value = event.matches; };
  if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
}
const dragEnabled = computed(() => !isNarrow.value);

let sequence = 0;
function nextId(prefix) {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

// 打开时从模板正文反解状态
watch(() => props.show, opened => {
  if (!opened) return;
  const result = parseIniToState(props.content);
  state.value = result.state;
  parseWarnings.value = result.warnings;
  isPartial.value = result.partial;
  isDrifted.value = result.drifted;
}, { immediate: true });

// —— 派生数据 ——

const enabledRegionNames = computed(() => state.value.base.regions
  .filter(region => region.enabled && region.id !== OTHER_REGION_ID)
  .map(region => region.name));

/** 「移到…」下拉的选项，窄屏降级用。 */
const moveOptions = computed(() => [
  { value: 'off', label: t('settings.ruleGenPalette') },
  { value: 'prepend', label: t('settings.ruleGenSegPrepend') },
  { value: 'flexible', label: t('settings.ruleGenSegFlexible') },
  { value: 'adblock', label: t('settings.ruleGenSegAdBlock') },
  { value: 'proxy', label: t('settings.ruleGenSegProxy') },
  { value: 'direct', label: t('settings.ruleGenSegDirect') }
]);

/**
 * 按输出顺序展平生效卡片，供冲突检测复用（口径与 serialize.js 一致）。
 * 只取顶层卡片 —— 跟父卡片同桶的小卡片其来源已被父卡片收进 effectiveSources。
 */
const orderedActiveCards = computed(() => {
  const order = ['prepend', 'flexible', 'adblock', 'proxy', 'direct'];
  const all = state.value.cards;
  const byId = new Map(all.map(card => [card.id, card]));

  return order.flatMap(bucket => all
    .filter(card => {
      if (card.bucket !== bucket) return false;
      if (card.parentId !== null) {
        const parent = byId.get(card.parentId);
        if (parent && parent.bucket === bucket) return false;
      }
      return effectiveSources(all, card).length > 0;
    })
    .sort((a, b) => {
      const rank = card => (card.origin === 'user' ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return (Number(a.order) || 0) - (Number(b.order) || 0);
    })
    .map(card => ({ ...card, sources: effectiveSources(all, card) })));
});

const conflicts = computed(() =>
  findSourceConflicts(orderedActiveCards.value).filter(conflict => conflict.active));

const conflictingIds = computed(() =>
  new Set(conflicts.value.flatMap(conflict => conflict.entries.map(entry => entry.cardId))));

const validation = computed(() => validateState(state.value));
const serialized = computed(() => serializeState(state.value));
const canApply = computed(() => validation.value.canGenerate);

// —— 事件处理 ——

function toggleBase(key) {
  state.value.base[key] = !state.value.base[key];
}

function toggleRegion(regionId) {
  const region = state.value.base.regions.find(item => item.id === regionId);
  if (region) region.enabled = !region.enabled;
}

function toggleModifier(key) {
  state.value.headModifiers[key] = !state.value.headModifiers[key];
}

/** 大卡片改桶时把同桶的小卡片一起带走（方案 A 的核心行为）。 */
function moveCard({ cardId, bucket }) {
  const card = state.value.cards.find(item => item.id === cardId);
  if (!card || !bucket) return;

  const previous = card.bucket;
  card.bucket = bucket;

  if (card.parentId === null) {
    state.value.cards.forEach(child => {
      if (child.parentId === card.id && child.bucket === previous) child.bucket = bucket;
    });
  }

  if (bucket !== 'off') collapsed.value[bucket] = false;
}

/**
 * 拖放落地。vuedraggable 给的是该段的新顶层卡片数组，据此重写 bucket 与 order，
 * 让拖拽顺序即输出顺序。大卡片连带小卡片。
 */
function handleDrop({ bucket, cards }) {
  (cards || []).forEach((dropped, index) => {
    const card = state.value.cards.find(item => item.id === dropped.id);
    if (!card) return;

    const previous = card.bucket;
    card.bucket = bucket;
    card.order = index;

    if (card.parentId === null && previous !== bucket) {
      state.value.cards.forEach(child => {
        if (child.parentId === card.id && child.bucket === previous) child.bucket = bucket;
      });
    }
  });
}

/**
 * 顶栏提交自定义规则集：整组行合成**一张大卡片 + 每行一张小卡片**，
 * 落到左栏候选区顶部（bucket: 'off'），不直接进右侧桶。
 */
function submitRuleset({ name, rows }) {
  const valid = (rows || []).filter(row => String(row.value || '').trim());
  if (!valid.length) return;

  const parentId = nextId('user');
  const parent = {
    id: parentId,
    name: name.trim() || `📦 自定义规则集 ${state.value.cards.filter(c => c.origin === 'user' && c.parentId === null).length + 1}`,
    parentId: null,
    origin: 'user',
    bucket: 'off',
    order: -1,
    sources: []
  };

  const children = valid.map((row, index) => ({
    id: nextId('user'),
    name: shortLabel(row),
    parentId,
    origin: 'user',
    bucket: 'off',
    order: index,
    sources: [{
      id: nextId('src'),
      ...(row.kind === 'inline'
        ? { kind: 'inline', ruleType: row.ruleType, value: row.value.trim() }
        : { kind: 'remote', value: row.value.trim() })
    }]
  }));

  state.value.cards.unshift(parent, ...children);
}

/** 小卡片的显示名：远程取文件名，内联取「类型 值」。 */
function shortLabel(row) {
  const value = String(row.value || '').trim();
  if (row.kind === 'inline') return `${row.ruleType} ${value}`;
  try {
    return new URL(value).pathname.split('/').filter(Boolean).pop() || value;
  } catch {
    return value;
  }
}

function removeSource({ cardId, sourceId }) {
  state.value.cards = removeSourceFromCard(state.value.cards, cardId, sourceId);
}

function keepMine({ conflict, winnerCardId }) {
  state.value.cards = resolveConflictKeepMine(state.value.cards, conflict, winnerCardId);
}

/** 放弃手改，接受反推结果 —— state 本就是反推结果，只需清掉警告条。 */
function acceptRecovered() {
  parseWarnings.value = [];
  isDrifted.value = false;
  isPartial.value = false;
}

function apply() {
  if (!canApply.value) return;
  emit('apply', serialized.value.ini);
  emit('update:show', false);
}
</script>

<template>
  <Modal
    :show="show"
    size="6xl"
    :confirm-text="t('settings.ruleGenApply')"
    :confirm-disabled="!canApply"
    :close-on-confirm="false"
    @update:show="emit('update:show', $event)"
    @confirm="apply"
  >
    <template #title>
      <h3 class="text-lg font-bold text-gray-900 dark:text-white">{{ t('settings.ruleGenTitle') }}</h3>
    </template>

    <template #body>
      <div class="space-y-3">
        <!-- §10：注释头与正文不一致时以正文为准，让用户显式选择，不静默覆盖 -->
        <div
          v-if="parseWarnings.length"
          class="rounded-xl border border-amber-300 bg-amber-50 p-2.5 dark:border-amber-500/40 dark:bg-amber-900/20"
        >
          <p class="text-[11px] leading-snug text-amber-800 dark:text-amber-200">
            {{ isDrifted ? t('settings.ruleGenDriftWarning') : t('settings.ruleGenPartialWarning') }}
          </p>
          <div class="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              @click="acceptRecovered"
              class="rounded border border-amber-400 bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-700 transition hover:bg-amber-100 dark:bg-transparent dark:text-amber-300"
            >{{ t('settings.ruleGenDiscardEdits') }}</button>
            <button
              type="button"
              @click="emit('update:show', false)"
              class="rounded border border-gray-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-gray-600 transition hover:bg-gray-50 dark:border-gray-600 dark:bg-transparent dark:text-gray-300"
            >{{ t('settings.ruleGenKeepAdvanced') }}</button>
          </div>
        </div>

        <GeneratorTopBar
          :base="state.base"
          @toggle-base="toggleBase"
          @toggle-region="toggleRegion"
          @submit-ruleset="submitRuleset"
        />

        <DedupeConflictBar :conflicts="conflicts" @keep-mine="keepMine" />

        <!-- 左右双栏：右栏的垂直顺序直接可视化了匹配优先级（§7.3） -->
        <div class="grid grid-cols-1 gap-3 lg:grid-cols-[280px_1fr]">
          <CardPalette
            :cards="state.cards"
            :drag-enabled="dragEnabled"
            :move-options="moveOptions"
            class="max-h-[26rem]"
            @move="moveCard"
            @drop="handleDrop"
          />
          <BucketPanel
            :cards="state.cards"
            :head-modifiers="state.headModifiers"
            :conflicting-ids="conflictingIds"
            :collapsed="collapsed"
            :drag-enabled="dragEnabled"
            :move-options="moveOptions"
            class="max-h-[26rem]"
            @toggle-collapse="key => collapsed[key] = !collapsed[key]"
            @toggle-modifier="toggleModifier"
            @move="moveCard"
            @drop="handleDrop"
            @remove-source="removeSource"
          />
        </div>

        <IniPreview
          :ini="serialized.ini"
          :group-count="serialized.groupCount"
          :rule-count="serialized.ruleCount"
          :count-level="validation.groupCountLevel"
          :findings="validation.findings"
        />
      </div>
    </template>
  </Modal>
</template>
