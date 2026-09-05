export function createUnifiedTemplateModel(input = {}) {
    return {
        meta: {
            name: input.meta?.name || 'MiSub',
            source: input.meta?.source || 'builtin',
            target: input.meta?.target || 'clash',
            ruleLevel: input.meta?.ruleLevel || 'std'
        },
        proxies: Array.isArray(input.proxies) ? input.proxies : [],
        groups: Array.isArray(input.groups) ? input.groups : [],
        rules: Array.isArray(input.rules) ? input.rules : [],
        settings: {
            managedConfigUrl: input.settings?.managedConfigUrl || '',
            interval: input.settings?.interval || 86400,
            skipCertVerify: Boolean(input.settings?.skipCertVerify),
            enableUdp: Boolean(input.settings?.enableUdp),
            customDnsOverride: input.settings?.customDnsOverride || '',
            dnsMode: input.settings?.dnsMode || 'clean',
            // 「DNS 走代理」开关，缺省视为开：老模型没有这个字段，行为保持不变
            dnsThroughProxy: input.settings?.dnsThroughProxy !== false,
            // DNS 绑定目标组名，由 applySmartModelOptimizations 决定后写进来。
            // 空串 = 不绑；null = 还没决定过（渲染器被直接调用，未过优化器）。
            dnsProxyGroup: typeof input.settings?.dnsProxyGroup === 'string'
                ? input.settings.dnsProxyGroup
                : null
        },
        extras: typeof input.extras === 'object' && input.extras !== null ? input.extras : {}
    };
}

/**
 * 取模型的 DNS 绑定目标组名。
 *
 * 优化器跑过就照它的决定（含空串「不绑」）；没跑过时退回旧行为，
 * 保证渲染器被直接调用（内置模板注册表、单测）时产出不变。
 */
export function resolveModelDnsProxyGroup(model, fallbackGroup) {
    const decided = model?.settings?.dnsProxyGroup;
    if (typeof decided === 'string') return decided;
    return model?.settings?.dnsThroughProxy === false ? '' : fallbackGroup;
}

export function normalizeUnifiedTemplateModel(model = {}) {
    return createUnifiedTemplateModel(model);
}
