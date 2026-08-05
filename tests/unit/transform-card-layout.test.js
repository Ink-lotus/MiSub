import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import TransformCard from '../../src/components/settings/sections/ServiceSettings/TransformCard.vue';
import { DEFAULT_SETTINGS } from '../../src/constants/default-settings.js';
import { createI18n } from '../../src/i18n/index.js';

function mountTransformCard() {
  return mount(TransformCard, {
    props: {
      settings: {
        ...DEFAULT_SETTINGS,
        subconverter: {
          ...DEFAULT_SETTINGS.subconverter,
          defaultOptions: { ...DEFAULT_SETTINGS.subconverter.defaultOptions }
        },
        dnsConfig: { mode: 'builtin', templateId: '' }
      }
    },
    global: {
      plugins: [createI18n({ initialLocale: 'zh-CN' }), createPinia()],
      stubs: {
        TransformSelector: true,
        RuleTemplateManager: true,
        DnsTemplateManager: true,
        Switch: { template: '<span />' }
      }
    }
  });
}

function findLabel(wrapper, text) {
  return wrapper.findAll('label').find(label => label.text().includes(text));
}

describe('规则与配置方案布局', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('将 DNS 配置置于模板配置下方的同一列', () => {
    const wrapper = mountTransformCard();
    const ruleSource = findLabel(wrapper, '1. 规则来源');
    const templateConfig = findLabel(wrapper, '2. 模板配置');
    const dnsConfig = findLabel(wrapper, '3. DNS 配置');
    const grid = ruleSource.element.closest('.grid');
    const rightColumn = grid.children[1];

    expect(rightColumn.contains(templateConfig.element)).toBe(true);
    expect(rightColumn.contains(dnsConfig.element)).toBe(true);
    expect(templateConfig.element.compareDocumentPosition(dnsConfig.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('模板配置和 DNS 配置标题与规则来源使用相同颜色', () => {
    const wrapper = mountTransformCard();
    const labels = [
      findLabel(wrapper, '1. 规则来源'),
      findLabel(wrapper, '2. 模板配置'),
      findLabel(wrapper, '3. DNS 配置')
    ];

    labels.forEach((label) => {
      expect(label.classes()).toContain('text-gray-500');
      expect(label.classes()).toContain('dark:text-gray-400');
    });
  });
});
