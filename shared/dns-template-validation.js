import yaml from 'js-yaml';
import { resolverHost, DEFAULT_DNS_POLICY, DNS_MODES } from './safe-dns.js';

export const DNS_TEMPLATE_FIELDS = ['clash', 'singbox', 'surge', 'loon', 'quanx'];
export const DNS_TEMPLATE_KINDS = ['raw', 'policy'];

function result(status, code = '') {
    return { status, code, valid: status !== 'invalid' };
}

function isObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateStructuredField(text, parser, invalidCode) {
    try {
        const parsed = parser(text);
        if (!isObject(parsed)) return result('invalid', 'objectRequired');
        if (Object.prototype.hasOwnProperty.call(parsed, 'dns')) {
            return result('invalid', 'dnsWrapper');
        }
        return result('valid');
    } catch {
        return result('invalid', invalidCode);
    }
}

function validateDnsServerValue(text) {
    if (/\r|\n/.test(text)) return result('invalid', 'singleLineRequired');
    if (/^\s*dns-server\s*=/i.test(text)) return result('invalid', 'dnsServerWrapper');
    if (/^\s*\[[^\]]+\]/.test(text)) return result('invalid', 'sectionWrapper');
    return result('valid');
}

function validateQuanxBody(text) {
    if (/^\s*\[[^\]]+\]/m.test(text)) return result('invalid', 'sectionWrapper');

    const invalidLine = text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && !line.startsWith(';'))
        .find(line => !/^[a-z][\w-]*(?:\s*=\s*.+)?$/i.test(line));

    return invalidLine ? result('invalid', 'invalidLine') : result('valid');
}

export function validateDnsTemplateField(field, value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return result('empty');

    if (field === 'clash') {
        return validateStructuredField(text, input => yaml.load(input), 'invalidYaml');
    }
    if (field === 'singbox') {
        return validateStructuredField(text, input => JSON.parse(input), 'invalidJson');
    }
    if (field === 'surge' || field === 'loon') {
        return validateDnsServerValue(text);
    }
    if (field === 'quanx') {
        return validateQuanxBody(text);
    }

    return result('invalid', 'unsupportedField');
}

export function validateDnsTemplate(template = {}) {
    return Object.fromEntries(
        DNS_TEMPLATE_FIELDS.map(field => [field, validateDnsTemplateField(field, template?.[field])])
    );
}

export function filterValidDnsTemplateFields(template = {}) {
    return Object.fromEntries(DNS_TEMPLATE_FIELDS.map(field => {
        const value = typeof template?.[field] === 'string' ? template[field].trim() : '';
        const validation = validateDnsTemplateField(field, value);
        return [field, validation.status === 'valid' ? value : ''];
    }));
}

/**
 * 校验策略模式（kind: 'policy'）的 policy 字段。
 * 返回 { valid: boolean, warnings: string[] }。
 * 所有问题均作为 warn 级别（不硬拦保存），回环/全零地址才警告，局域网地址放行。
 */
export function validatePolicyRecord(policy = {}) {
    const warnings = [];

    // mode
    if (policy.mode !== undefined) {
        const m = String(policy.mode).trim().toLowerCase();
        if (m !== DNS_MODES.CLEAN && m !== DNS_MODES.POLLUTED) {
            warnings.push(`mode 无效值 "${policy.mode}"，将回落为 clean`);
        }
    }

    // 校验解析器列表字段
    const resolverFields = ['domestic', 'foreign', 'polluted'];
    for (const field of resolverFields) {
        if (policy[field] === undefined) continue;
        const values = Array.isArray(policy[field])
            ? policy[field]
            : (typeof policy[field] === 'string' ? policy[field].split(',').map(s => s.trim()).filter(Boolean) : []);

        for (const v of values) {
            if (!v || v === 'system') continue;
            const validated = resolverHost(v);
            if (validated === '') {
                warnings.push(`${field} 包含无效或不安全的地址 "${v}"（回环/全零/非法 scheme）`);
            }
        }
    }

    return { valid: true, warnings };
}

/**
 * 手写模式（kind: 'raw'）的解析器地址提示。
 *
 * 与 validatePolicyRecord 的判定口径刻意不同：手写模式只标出回环与全零地址，
 * 不限制 scheme。原因是 mihomo 支持 quic:// / h3:// / dhcp:// / rcode:// 等写法，
 * 按 resolverHost 的四种 scheme 去卡会大量误报；而回环与全零一定让客户端 DNS 失效。
 *
 * 纯 warn，不参与 validateDnsTemplateField 的 status，不影响运行时取值。
 */
const LOOPBACK_HOSTS = new Set(['localhost', '::1', '0.0.0.0']);

function stripPolicyGroup(value) {
    const raw = String(value ?? '');
    const idx = raw.indexOf('#');
    return idx === -1 ? raw : raw.slice(0, idx);
}

function extractHost(value) {
    let raw = stripPolicyGroup(value).trim();
    if (!raw || raw === 'system') return '';

    raw = raw.replace(/^[a-z0-9+.-]+:\/\//i, '');   // scheme
    raw = raw.split(/[/?]/)[0];                      // path / query

    if (raw.startsWith('[')) {                       // IPv6 字面量
        const end = raw.indexOf(']');
        return end === -1 ? '' : raw.slice(1, end).toLowerCase();
    }

    // 裸 IPv6（两个以上冒号）不可能再带端口，整串就是主机
    if ((raw.match(/:/g) || []).length > 1) return raw.toLowerCase();

    const parts = raw.split(':');
    const host = parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])
        ? parts.slice(0, -1).join(':')
        : raw;
    return host.toLowerCase();
}

export function isLoopbackResolver(value) {
    const host = extractHost(value);
    if (!host) return false;
    return LOOPBACK_HOSTS.has(host) || /^127\./.test(host) || /^0\./.test(host);
}

const CLASH_RESOLVER_KEYS = [
    'nameserver',
    'fallback',
    'default-nameserver',
    'proxy-server-nameserver',
    'direct-nameserver'
];

function flattenStrings(value, out) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(item => flattenStrings(item, out));
    else if (isObject(value)) Object.values(value).forEach(item => flattenStrings(item, out));
}

function clashResolverValues(text) {
    const parsed = yaml.load(text);
    if (!isObject(parsed)) return [];
    const out = [];
    CLASH_RESOLVER_KEYS.forEach(key => flattenStrings(parsed[key], out));
    flattenStrings(parsed['nameserver-policy'], out);
    return out;
}

function singboxResolverValues(text) {
    const parsed = JSON.parse(text);
    if (!isObject(parsed) || !Array.isArray(parsed.servers)) return [];
    // 新版字段是 server，旧版是 address；两者都扫
    return parsed.servers
        .filter(isObject)
        .flatMap(item => [item.server, item.address])
        .filter(v => typeof v === 'string');
}

function quanxResolverValues(text) {
    return text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^server\s*=/i.test(line))
        .map(line => line.replace(/^server\s*=\s*/i, ''))
        // server=/domain/1.1.1.1 这种域名定向写法，地址在最后一段
        .map(value => (value.startsWith('/') ? value.split('/').filter(Boolean).pop() || '' : value));
}

/** 返回该字段里所有回环/全零地址；解析失败一律返回空数组（格式问题交给 status 报） */
export function collectResolverWarnings(field, value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return [];

    let candidates = [];
    try {
        if (field === 'clash') candidates = clashResolverValues(text);
        else if (field === 'singbox') candidates = singboxResolverValues(text);
        else if (field === 'surge' || field === 'loon') candidates = text.split(',');
        else if (field === 'quanx') candidates = quanxResolverValues(text);
    } catch {
        return [];
    }

    return candidates
        .map(v => stripPolicyGroup(v).trim())
        .filter(v => v && isLoopbackResolver(v));
}

/** 逐字段收集手写模板的地址提示 */
export function validateDnsTemplateResolvers(template = {}) {
    return Object.fromEntries(
        DNS_TEMPLATE_FIELDS.map(field => [field, collectResolverWarnings(field, template?.[field])])
    );
}
