import yaml from 'js-yaml';
import { StorageFactory } from '../storage-adapter.js';
import { createJsonResponse, createErrorResponse, readJsonWithLimit } from './utils.js';
import { filterValidDnsTemplateFields, DNS_TEMPLATE_KINDS } from '../../shared/dns-template-validation.js';
import { resolveSafeDnsConfig, buildSingboxDnsConfig, DNS_PROXY_GROUP } from '../../shared/safe-dns.js';

export const KV_KEY_DNS_TEMPLATES = 'misub_dns_templates_v1';
const MAX_TEMPLATE_COUNT = 50;
const MAX_TEMPLATE_CONTENT_LENGTH = 128 * 1024;
const MAX_REQUEST_BODY_LENGTH = 8 * 1024 * 1024;
const DNS_FIELDS = ['clash', 'singbox', 'surge', 'loon', 'quanx'];

function nowIso() { return new Date().toISOString(); }
function sanitizeId(value = '') {
    return String(value || '').trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}
function createId() {
    const random = Math.random().toString(36).slice(2, 10);
    return `dns-template-${Date.now().toString(36)}-${random}`;
}

export function normalizeDnsTemplates(input = []) {
    if (!Array.isArray(input)) return [];
    const seen = new Set();
    const normalized = [];
    for (const item of input.slice(0, MAX_TEMPLATE_COUNT)) {
        if (!item || typeof item !== 'object') continue;
        const hasAnyDns = DNS_FIELDS.some(f => typeof item[f] === 'string' && item[f].trim().length > 0);

        // kind 先确定，再决定是否因缺少 DNS 字段而跳过
        const rawKind = String(item.kind || 'raw').trim().toLowerCase();
        const kind = rawKind === 'policy' ? 'policy' : 'raw';

        // raw 模式要求至少一个 DNS 字段；policy 模式不要求
        if (kind === 'raw' && !hasAnyDns) continue;

        // policy 模式要求 policy 字段存在且是对象
        if (kind === 'policy' && (!item.policy || typeof item.policy !== 'object')) continue;
        let totalLen = 0;
        const fields = {};
        for (const f of DNS_FIELDS) {
            const v = typeof item[f] === 'string' ? item[f].trim() : '';
            totalLen += v.length;
            fields[f] = v;
        }
        if (totalLen > MAX_TEMPLATE_CONTENT_LENGTH) continue;
        const baseId = sanitizeId(item.id) || createId();
        let id = baseId;
        let duplicateIndex = 2;
        while (seen.has(id)) {
            const suffix = `-${duplicateIndex++}`;
            id = `${baseId.slice(0, 80 - suffix.length)}${suffix}`;
        }
        seen.add(id);
        const createdAt = item.createdAt && !Number.isNaN(Date.parse(item.createdAt)) ? item.createdAt : nowIso();

        // policy 字段：仅 kind=policy 时保留，其余忽略
        const policyField = (kind === 'policy' && item.policy && typeof item.policy === 'object')
            ? {
                mode: String(item.policy.mode || 'clean').trim().toLowerCase(),
                domestic: Array.isArray(item.policy.domestic) ? item.policy.domestic : [],
                foreign: Array.isArray(item.policy.foreign) ? item.policy.foreign : [],
                polluted: Array.isArray(item.policy.polluted) ? item.policy.polluted : []
            }
            : undefined;

        // kind=policy 时无需 DNS 字段内容，kind=raw 时需要至少一个 DNS 字段
        if (kind === 'raw' && !hasAnyDns) continue;

        normalized.push({
            id,
            name: String(item.name || '').trim().slice(0, 80) || '未命名 DNS 模板',
            description: String(item.description || '').trim().slice(0, 300),
            enabled: item.enabled !== false,
            kind,
            ...(policyField ? { policy: policyField } : {}),
            createdAt,
            updatedAt: nowIso(),
            ...fields
        });
    }
    return normalized;
}

export async function listDnsTemplates(storageAdapter) {
    const raw = await storageAdapter.get(KV_KEY_DNS_TEMPLATES);
    return normalizeDnsTemplates(Array.isArray(raw) ? raw : []);
}

/**
 * 解析生效的 DNS 配置。
 *
 * @param {Object}   params
 * @param {Object}   params.profileDns  Profile 级 dnsConfig
 * @param {Object}   params.globalDns   全局 dnsConfig
 * @param {Array}    params.templates   DNS 模板库
 * @param {boolean} [params.dnsThroughProxy=true] 「DNS 走代理」开关。
 *        策略模式合成的 clash / sing-box 块会整块替换掉生成器产出的 dns，
 *        因此这里必须与生成器用同一个开关值：关闭时不加 #🌐 DNS 出口 后缀，
 *        否则合成出的块会引用一个不会被创建的策略组。
 */
export function resolveEffectiveDnsConfig({ profileDns = {}, globalDns = {}, templates = [], dnsThroughProxy = true } = {}) {
    const proxyGroup = dnsThroughProxy ? DNS_PROXY_GROUP : '';
    const pick = (mode, templateId) => {
        if (mode !== 'template' || !templateId) return null;
        const tpl = templates.find(t => t.enabled !== false && t.id === templateId);
        if (!tpl) return null;

        // 策略模式：合成 clash / singbox 文本；其余格式无手写内容时保持空
        if (tpl.kind === 'policy' && tpl.policy) {
            const clashDns = resolveSafeDnsConfig(tpl.policy, { mode: tpl.policy.mode, proxyGroup });
            const singboxDns = buildSingboxDnsConfig(tpl.policy, { mode: tpl.policy.mode, proxyGroup });
            return {
                clash: yaml.dump(clashDns, { indent: 2, lineWidth: -1, noRefs: true }),
                singbox: JSON.stringify(singboxDns, null, 2),
                surge: typeof tpl.surge === 'string' ? tpl.surge.trim() : '',
                loon: typeof tpl.loon === 'string' ? tpl.loon.trim() : '',
                quanx: typeof tpl.quanx === 'string' ? tpl.quanx.trim() : ''
            };
        }

        // 手写模式（原有行为）
        return filterValidDnsTemplateFields(tpl);
    };
    const profileMode = profileDns?.mode || 'global';
    if (profileMode === 'template') return pick('template', profileDns?.templateId);
    if (profileMode === 'builtin') return null;
    // Profile 继承全局 或 普通订阅（无 profileDns）
    return pick(globalDns?.mode || 'builtin', globalDns?.templateId);
}

async function getStorageAdapter(env) {
    if (env?.__TEST_STORAGE_ADAPTER) return env.__TEST_STORAGE_ADAPTER;
    const storageType = await StorageFactory.getStorageType(env);
    return StorageFactory.createAdapter(env, storageType);
}

export async function handleDnsTemplatesRequest(request, env) {
    try {
        const storageAdapter = await getStorageAdapter(env);
        if (request.method === 'GET') {
            const templates = await listDnsTemplates(storageAdapter);
            return createJsonResponse({ success: true, data: templates });
        }
        if (request.method === 'POST') {
            let body;
            try {
                body = await readJsonWithLimit(request, MAX_REQUEST_BODY_LENGTH);
            } catch (e) {
                if (e?.status === 413) return createJsonResponse({ success: false, message: e.message, error: e.message }, 413);
                return createJsonResponse({ success: false, message: '请求数据格式错误' }, 400);
            }
            const templates = normalizeDnsTemplates(body?.templates || body?.data || []);
            await storageAdapter.put(KV_KEY_DNS_TEMPLATES, templates);
            return createJsonResponse({ success: true, message: 'DNS 模板已保存', data: templates });
        }
        return createErrorResponse('Method Not Allowed', 405);
    } catch (error) {
        console.error('[DnsTemplates] request failed:', error);
        return createJsonResponse({ success: false, message: `DNS 模板操作失败: ${error.message || '服务器内部错误'}` }, 500);
    }
}
