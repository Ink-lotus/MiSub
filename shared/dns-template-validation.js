import yaml from 'js-yaml';

export const DNS_TEMPLATE_FIELDS = ['clash', 'singbox', 'surge', 'loon', 'quanx'];

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
