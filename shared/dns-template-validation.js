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
