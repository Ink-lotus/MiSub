const SIMPLE_FIELDS = Object.freeze({
    domain: 'domain',
    'domain-suffix': 'domain_suffix',
    'domain-keyword': 'domain_keyword',
    'ip-cidr': 'ip_cidr',
    'ip-cidr6': 'ip_cidr',
    'process-name': 'process_name'
});

export function toSingboxHeadlessRule(type, value) {
    const normalized = String(type || '').toLowerCase();
    const field = Object.hasOwn(SIMPLE_FIELDS, normalized) ? SIMPLE_FIELDS[normalized] : null;
    if (field) return { [field]: [value] };
    if (normalized !== 'dst-port') return null;

    const text = String(value ?? '').trim();
    const port = Number(text);
    if (!/^\d+$/.test(text) || !Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('[Singbox] Invalid DST-PORT: expected an integer from 0 to 65535');
    }
    return { port: [port] };
}
