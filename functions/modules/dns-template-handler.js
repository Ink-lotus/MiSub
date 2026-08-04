import { StorageFactory } from '../storage-adapter.js';
import { createJsonResponse, createErrorResponse, readJsonWithLimit } from './utils.js';

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
        if (!hasAnyDns) continue;
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
        normalized.push({
            id,
            name: String(item.name || '').trim().slice(0, 80) || '未命名 DNS 模板',
            description: String(item.description || '').trim().slice(0, 300),
            enabled: item.enabled !== false,
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

export function resolveEffectiveDnsConfig({ profileDns = {}, globalDns = {}, templates = [] } = {}) {
    const pick = (mode, templateId) => {
        if (mode !== 'template' || !templateId) return null;
        const tpl = templates.find(t => t.enabled !== false && t.id === templateId);
        if (!tpl) return null;
        return { clash: tpl.clash || '', singbox: tpl.singbox || '', surge: tpl.surge || '', loon: tpl.loon || '', quanx: tpl.quanx || '' };
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
