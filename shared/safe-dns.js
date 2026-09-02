/**
 * shared/safe-dns.js
 *
 * DNS 策略引擎 — 改造自上游 safe-dns.js，适配本仓库：
 *   - 去掉 DNS_PROXY_GROUP 后缀（方案 A），外部解析器直接走客户端默认路径
 *   - 不依赖 functions/ 路径，可被前后端共同 import
 *   - 保留上游全部引擎逻辑与地址级校验
 *
 * Original: imzyb/MiSub — functions/modules/subscription/safe-dns.js
 */
import yaml from 'js-yaml';

export const DNS_MODES = Object.freeze({
    CLEAN: 'clean',
    POLLUTED: 'polluted'
});

export const SINGBOX_CN_RULE_SET = 'geosite-cn';

export const DEFAULT_DNS_POLICY = Object.freeze({
    domestic: ['223.5.5.5', '119.29.29.29'],
    foreign: ['udp://8.8.8.8:53', 'udp://1.1.1.1:53'],
    polluted: ['https://8.8.8.8/dns-query', 'https://1.1.1.1/dns-query']
});

const SAFE_DNS_FIELDS = [
    'cache-algorithm',
    'fake-ip-range',
    'fake-ip-filter-mode',
    'fake-ip-ttl',
    'use-hosts',
    'use-system-hosts'
];

const DNS_HOST_PATTERN = /^(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])$/i;
const DNS_SCHEME_PATTERN = /^(?:udp|tcp|tls|https):\/\//i;

function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
    return value;
}

function parseOverride(raw) {
    if (isObject(raw)) return raw;
    if (typeof raw !== 'string' || !raw.trim()) return {};
    try {
        const parsed = yaml.load(raw.trim());
        if (!isObject(parsed)) return {};
        return isObject(parsed.dns) ? parsed.dns : parsed;
    } catch {
        return {};
    }
}

function normalizeMode(value) {
    return String(value || '').trim().toLowerCase() === DNS_MODES.POLLUTED
        ? DNS_MODES.POLLUTED
        : DNS_MODES.CLEAN;
}

/**
 * 语义校验单个解析器地址：
 *   - 拒绝回环地址 (127.x / 0.x / localhost / ::1)
 *   - 只接受 udp / tcp / tls / https scheme
 *   - 允许 'system'
 * 返回原值（合法）或空字符串（不合法）
 */
export function resolverHost(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.includes('#') || raw === 'system') return raw === 'system' ? raw : '';

    const candidate = DNS_SCHEME_PATTERN.test(raw) ? raw : `udp://${raw}`;
    try {
        const parsed = new URL(candidate);
        const host = parsed.hostname.replace(/^\[|\]$/g, '');
        if (!DNS_HOST_PATTERN.test(parsed.hostname)) return '';
        if (host === 'localhost' || host === '::1' || /^127\./.test(host) || /^0\./.test(host)) return '';
        return raw;
    } catch {
        return '';
    }
}

function resolverList(value, fallback) {
    const values = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
    const normalized = values.map(resolverHost).filter(Boolean);
    return normalized.length > 0 ? normalized : [...fallback];
}

function plainResolver(value) {
    const raw = String(value || '').trim();
    if (!raw || raw === 'system') return '';
    const candidate = DNS_SCHEME_PATTERN.test(raw) ? raw : `udp://${raw}`;
    try {
        const parsed = new URL(candidate);
        const host = parsed.hostname.replace(/^\[|\]$/g, '');
        if (!DNS_HOST_PATTERN.test(parsed.hostname)) return '';
        const formattedHost = host.includes(':') ? `[${host}]` : host;
        return `udp://${formattedHost}:53`;
    } catch {
        return '';
    }
}

function policyInput(override) {
    return isObject(override.policy) ? { ...override, ...override.policy } : override;
}

export function resolveDnsPolicy(raw, options = {}) {
    const override = parseOverride(raw);
    const input = policyInput(override);
    const mode = normalizeMode(options.mode || input.mode || input['dns-mode']);

    const foreign = resolverList(
        input.foreign || input.foreignNameservers || input['foreign-nameserver'] || input.nameserver,
        DEFAULT_DNS_POLICY.foreign
    );
    const plainForeign = mode === DNS_MODES.CLEAN
        ? foreign.map(plainResolver).filter(Boolean)
        : foreign;

    return {
        mode,
        domestic: resolverList(
            input.domestic || input.domesticNameservers || input['domestic-nameserver'] || input['default-nameserver'],
            DEFAULT_DNS_POLICY.domestic
        ),
        foreign: plainForeign.length > 0 ? plainForeign : [...DEFAULT_DNS_POLICY.foreign],
        polluted: resolverList(
            input.polluted || input.pollutedNameservers || input['polluted-nameserver'] || input.fallback,
            DEFAULT_DNS_POLICY.polluted
        )
    };
}

function cloneResolverPolicy(policy) {
    return {
        mode: policy.mode,
        domestic: [...policy.domestic],
        foreign: [...policy.foreign],
        polluted: [...policy.polluted]
    };
}

// 方案 A：不加 #🌐 DNS 出口 后缀，外部 DNS 走客户端默认路径
function withProxy(value, _proxyGroup) {
    return String(value || '').trim();
}

export const DEFAULT_DNS_CONFIG = {
    enable: true,
    ipv6: false,
    'enhanced-mode': 'fake-ip',
    'fake-ip-range': '198.18.0.1/16',
    'fake-ip-filter-mode': 'blacklist',
    'fake-ip-filter': [
        'geosite:private',
        'geosite:category-ntp',
        '*.lan',
        '*.local',
        'localhost',
        '*.arpa'
    ],
    'use-hosts': true,
    'use-system-hosts': true,
    'respect-rules': true,
    'default-nameserver': [...DEFAULT_DNS_POLICY.domestic],
    nameserver: DEFAULT_DNS_POLICY.foreign.map(v => withProxy(v, '')),
    'nameserver-policy': {
        'geosite:private': [...DEFAULT_DNS_POLICY.domestic],
        'geosite:cn': [...DEFAULT_DNS_POLICY.domestic],
        'geosite:geolocation-!cn': DEFAULT_DNS_POLICY.foreign.map(v => withProxy(v, ''))
    },
    'proxy-server-nameserver': [...DEFAULT_DNS_POLICY.domestic],
    'direct-nameserver': [...DEFAULT_DNS_POLICY.domestic],
    'direct-nameserver-follow-policy': true,
    fallback: [],
    'fallback-filter': {
        geoip: true,
        'geoip-code': 'CN',
        ipcidr: ['240.0.0.0/4', '0.0.0.0/32', '127.0.0.0/8', '100.64.0.0/10']
    }
};

export function isExplicitDnsBlock(override) {
    if (!isObject(override)) return false;
    return (
        override.enable !== undefined ||
        override['enhanced-mode'] !== undefined ||
        override['proxy-server-nameserver'] !== undefined ||
        (Array.isArray(override.nameserver) && isObject(override['nameserver-policy']))
    );
}

export function resolveSafeDnsConfig(raw, options = {}) {
    const rawOverride = parseOverride(raw);
    if (isExplicitDnsBlock(rawOverride)) {
        return clone(rawOverride);
    }

    const policy = resolveDnsPolicy(raw, options);
    const foreign = policy.mode === DNS_MODES.POLLUTED ? policy.polluted : policy.foreign;
    const dns = clone(DEFAULT_DNS_CONFIG);

    dns['default-nameserver'] = [...policy.domestic];
    dns.nameserver = foreign.map(v => withProxy(v, ''));
    dns['nameserver-policy'] = {
        'geosite:private': [...policy.domestic],
        'geosite:cn': [...policy.domestic],
        'geosite:geolocation-!cn': foreign.map(v => withProxy(v, ''))
    };
    dns['proxy-server-nameserver'] = [...policy.domestic];
    dns['direct-nameserver'] = [...policy.domestic];
    dns.fallback = policy.mode === DNS_MODES.POLLUTED
        ? foreign.map(v => withProxy(v, ''))
        : [];

    const override = policyInput(rawOverride);
    SAFE_DNS_FIELDS.forEach(key => {
        if (override[key] === undefined) return;
        if (key === 'fake-ip-filter-mode' && !['blacklist', 'whitelist', 'rule'].includes(String(override[key]))) return;
        if (['use-hosts', 'use-system-hosts'].includes(key)) {
            dns[key] = Boolean(override[key]);
            return;
        }
        if (key === 'fake-ip-filter') {
            if (Array.isArray(override[key]) && override[key].every(item => typeof item === 'string')) {
                dns[key] = [...override[key]];
            }
            return;
        }
        if (typeof override[key] === 'string' || typeof override[key] === 'number') dns[key] = override[key];
    });

    dns.enable = true;
    dns.ipv6 = false;
    dns['enhanced-mode'] = 'fake-ip';
    dns['respect-rules'] = true;
    return dns;
}

function parseSingboxResolver(value, tag) {
    const raw = String(value || '').trim();
    const candidate = DNS_SCHEME_PATTERN.test(raw) ? raw : `udp://${raw}`;
    const parsed = new URL(candidate);
    const type = parsed.protocol.slice(0, -1);
    const server = parsed.hostname.replace(/^\[|\]$/g, '');
    const serverPort = Number(parsed.port) || (type === 'https' ? 443 : type === 'tls' ? 853 : 53);
    // 方案 A：detour 留空，走客户端默认
    const result = { tag, type, server, server_port: serverPort };
    if (type === 'https') result.path = parsed.pathname || '/dns-query';
    if (type === 'tls') result.tls = { enabled: true, server_name: server };
    return result;
}

export function buildSingboxDnsConfig(raw, options = {}) {
    const policy = resolveDnsPolicy(raw, options);
    const foreign = policy.mode === DNS_MODES.POLLUTED ? policy.polluted : policy.foreign;
    const domesticServers = policy.domestic.map((value, index) => parseSingboxResolver(value, `dns-cn-${index + 1}`));
    const foreignServers = foreign.map((value, index) => parseSingboxResolver(value, `dns-foreign-${index + 1}`));
    const domesticTag = domesticServers[0]?.tag || 'dns-cn-1';
    const foreignTag = foreignServers[0]?.tag || 'dns-foreign-1';

    return {
        strategy: 'prefer_ipv4',
        servers: [...domesticServers, ...foreignServers],
        rules: [
            { rule_set: [SINGBOX_CN_RULE_SET], action: 'route', server: domesticTag },
            { domain_suffix: ['.cn', '.lan', '.local'], action: 'route', server: domesticTag }
        ],
        final: foreignTag
    };
}

export function cloneDnsPolicy(raw, options = {}) {
    return cloneResolverPolicy(resolveDnsPolicy(raw, options));
}
