import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import TransformCard from '../../src/components/settings/sections/ServiceSettings/TransformCard.vue';
import ProfileForm from '../../src/components/modals/ProfileModal/ProfileForm.vue';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { DEFAULT_SETTINGS } from '../../src/constants/default-settings.js';

function installTemplates() {
  const dataStore = useDataStore();
  dataStore.dnsTemplates = [
    { id: 'enabled', name: '可用 DNS 模板', enabled: true, clash: 'enable: true' },
    { id: 'disabled', name: '禁用 DNS 模板', enabled: false, clash: 'enable: true' }
  ];
}

describe('DNS 模板选择器', () => {
  let pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    installTemplates();
  });

  it('全局选择器只显示启用的 DNS 模板', () => {
    const wrapper = mount(TransformCard, {
      props: {
        settings: {
          ...DEFAULT_SETTINGS,
          subconverter: {
            ...DEFAULT_SETTINGS.subconverter,
            defaultOptions: { ...DEFAULT_SETTINGS.subconverter.defaultOptions }
          },
          dnsConfig: { mode: 'template', templateId: '' }
        }
      },
      global: {
        plugins: [pinia],
        stubs: {
          TransformSelector: true,
          RuleTemplateManager: true,
          DnsTemplateManager: true,
          Switch: { template: '<span />' }
        }
      }
    });

    expect(wrapper.text()).toContain('可用 DNS 模板');
    expect(wrapper.text()).not.toContain('禁用 DNS 模板');
  });

  it('Profile 选择器只显示启用的 DNS 模板', () => {
    const wrapper = mount(ProfileForm, {
      props: {
        localProfile: {
          name: 'test',
          transformConfigMode: 'global',
          transformConfig: '',
          dnsConfig: { mode: 'template', templateId: '' },
          subconverter: { engineMode: '', backend: '', options: {} },
          prefixSettings: {},
          operators: []
        },
        uiText: {},
        globalSettings: DEFAULT_SETTINGS
      },
      global: {
        plugins: [pinia],
        stubs: {
          TransformSelector: true,
          OperatorChain: true,
          Switch: { template: '<span />' },
          Input: { template: '<span />' }
        }
      }
    });

    expect(wrapper.text()).toContain('可用 DNS 模板');
    expect(wrapper.text()).not.toContain('禁用 DNS 模板');
  });

  it('Profile 继承全局时不应把禁用模板显示为当前生效值', () => {
    const wrapper = mount(ProfileForm, {
      props: {
        localProfile: {
          name: 'test',
          transformConfigMode: 'global',
          transformConfig: '',
          dnsConfig: { mode: 'global', templateId: '' },
          subconverter: { engineMode: '', backend: '', options: {} },
          prefixSettings: {},
          operators: []
        },
        uiText: {},
        globalSettings: {
          ...DEFAULT_SETTINGS,
          dnsConfig: { mode: 'template', templateId: 'disabled' }
        }
      },
      global: {
        plugins: [pinia],
        stubs: {
          TransformSelector: true,
          OperatorChain: true,
          Switch: { template: '<span />' },
          Input: { template: '<span />' }
        }
      }
    });

    expect(wrapper.text()).not.toContain('禁用 DNS 模板');
  });
});
