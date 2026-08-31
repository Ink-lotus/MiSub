/**
 * 可视化规则生成器 —— 常量、地区预置与内置卡片目录
 *
 * 纯数据模块，不含逻辑、不做 IO。
 *
 * 卡片模型是两层嵌套：
 *   大卡片  parentId === null 且 sources 恒为空，只是一个集合容器
 *   小卡片  挂在大卡片下（parentId 指向它），规则来源全部绑在小卡片上
 *
 * 两者都能独立拖进右侧桶。拖大卡片会连带其全部小卡片；拖小卡片不影响大卡片。
 * 只有落进「灵活桶」才各自生成独立策略组，落进其它桶只是把规则并入该桶的组。
 * 大卡片内小卡片数为 0 时不产出任何内容。
 *
 * 目录内的 URL 与其在 render-clash.js:64-99 下的重写目标已逐条探测（2026-08-30，
 * 全部 200）。两处与早期设计稿不符、已按实际情况修正：
 *   - SteamCN.list 与 GoogleFCM.list 在 `Clash/Ruleset/` 下，root 下为 404
 *   - Disney / GitHub / PayPal / PrimeVideo / Copilot 在 ACL4SSR 中不存在
 */

/** 往返状态的版本号与注释头前缀。 */
export const STATE_VERSION = 1;
export const STATE_HEADER_PREFIX = '; misub-visual-state-v1:';

/**
 * 固定策略组名。emoji 直接内联在组名里，与 builtin-rules-provider.js:6-10
 * 的既有风格一致。
 */
export const GROUP_NAMES = {
    nodeSelect: '🚀 节点选择',
    manualSelect: '☑️ 手动切换',
    autoSelect: '♻️ 自动选择',
    fallback: '🔯 故障转移',
    otherRegion: '🌐 其他地区',
    adBlock: '🛑 广告拦截',
    proxy: '🌍 国外代理',
    direct: '🎯 全球直连',
    final: '🐟 漏网之鱼'
};

/**
 * 保留策略名，卡片名与地区组名都不得撞上。
 *
 * 注意 template-processor.js:179-183 的 `pruneInvalidMembers` 只把 `DIRECT`
 * 与 `REJECT` 当作合法的非组成员 —— `REJECT-DROP` / `PASS` 会被静默剔除，
 * 因此生成器只使用前两者。
 */
export const RESERVED_POLICY_NAMES = Object.freeze([
    'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'MATCH', 'FINAL', 'GLOBAL'
]);

/** 测速默认参数，显式化，不在序列化器里写死。 */
export const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';
export const DEFAULT_INTERVAL = 300;
export const DEFAULT_TOLERANCE = 50;

/** 桶标识。`off` = 留在左栏待选栏，不产出任何输出。 */
export const BUCKETS = Object.freeze(['off', 'prepend', 'flexible', 'adblock', 'proxy', 'direct']);

/**
 * 规则段输出顺序。`ruleset=` 的行序即最终匹配优先级。
 *
 * prepend（前置修正）在最前 —— 落进它的卡片拿到最高优先级，
 * 用于让 CN 例外一类规则赢过后面的广覆盖清单。
 */
export const RULE_BUCKET_ORDER = Object.freeze(['prepend', 'flexible', 'adblock', 'proxy', 'direct']);

/**
 * 各桶承接的策略组名。灵活桶不在此表 —— 它的每张顶层卡片各自成组，组名即卡片名。
 *
 * prepend 用字面量 `DIRECT`，不指向 `🎯 全球直连` 组：后者会让「前置修正非空」
 * 反过来强制生成该组，把两段耦合在一起。代价是这批规则在客户端里不能临时切代理 ——
 * 前置修正的语义本就是「最高优先级直连」，可接受。
 */
export const BUCKET_POLICY = Object.freeze({
    prepend: 'DIRECT',
    adblock: GROUP_NAMES.adBlock,
    proxy: GROUP_NAMES.proxy,
    direct: GROUP_NAMES.direct
});

/**
 * `🛑 广告拦截` 的成员。`REJECT` 置首 —— select 组默认选中首个成员，
 * 因此默认拦截；其后是两个放行入口。这是四类承接组里唯一不用桶标准成员的。
 *
 * 与 builtin-template-registry.js:51 的既有形态一致（那里是 `REJECT`+`DIRECT`），
 * 额外加 `🚀 节点选择` 让用户可在客户端把误杀的请求临时改走代理。
 */
export const AD_BLOCK_MEMBERS = Object.freeze(['REJECT', 'DIRECT', GROUP_NAMES.nodeSelect]);

/**
 * 地区正则预置。
 *
 * pattern 存的是**内层形式**（不带外括号），序列化时统一包一层 `(...)`：
 * ini-template-parser.js:125-127 见到首尾括号会 `slice(1, -1)` 剥掉。
 * 因此内层形式**不得再含任何括号**，否则剥壳后括号不配对、
 * `new RegExp` 抛错，该组拿到 0 成员并被 pruneEmptyGroups 静默删除。
 *
 * 同理禁止 `(?i)` 前缀 —— template-processor.js:24 本就用 `new RegExp(filter, 'i')`。
 */
export const REGION_PRESETS = Object.freeze([
    { id: 'hk', name: '🇭🇰 香港节点', pattern: '港|HK|Hong ?Kong|HKG' },
    { id: 'tw', name: '🇹🇼 台湾节点', pattern: '台|TW|Taiwan|Tai ?wan' },
    { id: 'jp', name: '🇯🇵 日本节点', pattern: '日本|JP|Japan|Tokyo|Osaka' },
    { id: 'kr', name: '🇰🇷 韩国节点', pattern: '韩|KR|Korea|Seoul' },
    { id: 'sg', name: '🇸🇬 狮城节点', pattern: '新加坡|狮城|SG|Singapore' },
    { id: 'us', name: '🇺🇸 美国节点', pattern: '美|US|United ?States|America|Los ?Angeles|San ?Jose' }
]);

/**
 * `🌐 其他地区` 的 id。它的 pattern 由已启用地区反向前瞻合成，不是静态值，
 * 因此不进 REGION_PRESETS。命中 0 个节点时会被 pruneEmptyGroups 自动剪除。
 *
 * 反向前瞻 `^(?!.*(…)).*$` 以 `^` 开头，不触发上述 slice 分支，
 * 走 ini-template-parser.js:133-139 兜底进入 filters，JS 原生支持。
 */
export const OTHER_REGION_ID = 'other';

/** 前置修正区的固定开关：局域网直连。 */
export const LOCAL_AREA_NETWORK_SOURCE =
    'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/LocalAreaNetwork.list';

const ACL = 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash';

/**
 * 大卡片（集合容器）。sources 恒为空，规则全绑在小卡片上。
 * `bucket` 是它的默认落点，用户可拖走。
 */
const PARENT_DEFS = [
    // 「直连例外」而非「CN 例外」：UnBan.list 里既有国内域名，也有 dl.google.com、
    // ol.epicgames.com 这类非国内域名，它是广告规则的误杀捞回表，不是 CN 清单。
    // 四张小卡片的共性是「必须先直连、别被后面的规则吞掉」，故取此名。
    { id: 'cat-direct-exception', name: '✅ 直连例外', bucket: 'prepend',
        note: '放入这里的规则拥有最高优先级且强制直连，用于避免被后面的广覆盖清单吞掉' },
    { id: 'cat-ad', name: '🛑 广告过滤', bucket: 'adblock' },
    { id: 'cat-ai', name: '🤖 AI 服务', bucket: 'flexible' },
    { id: 'cat-media', name: '🎬 流媒体', bucket: 'flexible' },
    { id: 'cat-social', name: '📲 社交通讯', bucket: 'proxy' },
    { id: 'cat-tech', name: '💻 科技服务', bucket: 'proxy' },
    { id: 'cat-game', name: '🎮 游戏平台', bucket: 'off' },
    { id: 'cat-cn', name: '🏠 国内直连', bucket: 'direct' },
    { id: 'cat-proxy', name: '🌏 广覆盖代理清单', bucket: 'off',
        note: '与各单项服务卡片大量重叠，与它们二选一' }
];

/** 小卡片。`parentId` 指向所属大卡片，`sources` 是真正的规则来源。 */
const CHILD_DEFS = [
    // —— CN 例外 ——
    { id: 'google-cn', parentId: 'cat-direct-exception', name: '🇨🇳 谷歌中国',
        sources: [{ kind: 'remote', value: `${ACL}/GoogleCN.list` }],
        note: 'google.cn 等国内可直连域名，必须排在谷歌服务之前' },
    { id: 'steam-cn', parentId: 'cat-direct-exception', name: '🎮 Steam 中国',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/SteamCN.list` }],
        note: 'Steam 国内 CDN，排在 Steam 平台之前' },
    { id: 'ad-unban', parentId: 'cat-direct-exception', name: '🩹 误杀捞回',
        sources: [{ kind: 'remote', value: `${ACL}/UnBan.list` }],
        note: 'dl.google.com、ol.epicgames.com 等被广告规则误杀的域名。需排在广告过滤之前' },
    { id: 'google-fcm', parentId: 'cat-direct-exception', name: '🔔 谷歌推送', off: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/GoogleFCM.list` }],
        note: 'Android 推送服务，部分用户需要直连以保证及时性' },

    // —— 广告过滤 ——
    { id: 'ad-basic', parentId: 'cat-ad', name: '🚫 广告基础',
        sources: [
            { kind: 'remote', value: `${ACL}/BanAD.list` },
            { kind: 'remote', value: `${ACL}/BanProgramAD.list` }
        ] },
    { id: 'ad-easylist', parentId: 'cat-ad', name: '🧹 EasyList 增强', off: true,
        sources: [
            { kind: 'remote', value: `${ACL}/BanEasyList.list` },
            { kind: 'remote', value: `${ACL}/BanEasyPrivacy.list` }
        ],
        note: '规则量大，可能误杀，按需启用' },

    // —— AI 服务 ——
    { id: 'ai-openai', parentId: 'cat-ai', name: '🧠 OpenAI',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/OpenAi.list` }] },
    { id: 'ai-claude', parentId: 'cat-ai', name: '📎 Claude',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Claude.list` }] },
    { id: 'ai-others', parentId: 'cat-ai', name: '✨ 其它 AI',
        sources: [
            { kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'grok.com' },
            { kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'x.ai' },
            { kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'gemini.google.com' }
        ] },

    // —— 流媒体 ——
    { id: 'youtube', parentId: 'cat-media', name: '📹 油管视频',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/YouTube.list` }] },
    { id: 'netflix', parentId: 'cat-media', name: '🎥 奈飞视频',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Netflix.list` }] },
    { id: 'hbo', parentId: 'cat-media', name: '🎬 HBO', off: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/HBO.list` }] },
    { id: 'bahamut', parentId: 'cat-media', name: '🍿 巴哈姆特', off: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Bahamut.list` }],
        note: '台湾动画疯，需台湾节点' },
    { id: 'spotify', parentId: 'cat-media', name: '🎵 声破天', off: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Spotify.list` }] },
    { id: 'tiktok', parentId: 'cat-media', name: '🎼 抖音国际', off: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/TikTok.list` }] },
    { id: 'media-proxy', parentId: 'cat-media', name: '🌏 国际媒体合集', off: true,
        sources: [{ kind: 'remote', value: `${ACL}/ProxyMedia.list` }],
        note: '覆盖面广，与上面各单项清单大量重叠，二选一' },

    // —— 社交通讯 ——
    { id: 'telegram', parentId: 'cat-social', name: '📲 电报消息',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Telegram.list` }] },
    { id: 'twitter', parentId: 'cat-social', name: '🐦 推特', off: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Twitter.list` }] },

    // —— 科技服务 ——
    { id: 'google', parentId: 'cat-tech', name: '🔍 谷歌服务',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Google.list` }],
        note: '含 DOMAIN-KEYWORD,google，会吞掉 google.cn —— 谷歌中国必须排在它之前' },
    { id: 'microsoft', parentId: 'cat-tech', name: 'Ⓜ️ 微软服务', off: true,
        sources: [
            { kind: 'remote', value: `${ACL}/Ruleset/Microsoft.list` },
            { kind: 'remote', value: `${ACL}/OneDrive.list` },
            { kind: 'remote', value: `${ACL}/Bing.list` }
        ] },
    { id: 'apple', parentId: 'cat-tech', name: '🍎 苹果服务', off: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Apple.list` }] },

    // —— 游戏平台 ——
    { id: 'steam', parentId: 'cat-game', name: '🕹️ Steam 平台',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Steam.list` }] },
    { id: 'epic', parentId: 'cat-game', name: '👾 Epic 平台',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Epic.list` }] },

    // —— 国内直连。IP 类清单靠 order 钉在域名类之后 ——
    { id: 'china-domain', parentId: 'cat-cn', name: '🏠 中国域名', order: 100,
        sources: [{ kind: 'remote', value: `${ACL}/ChinaDomain.list` }] },
    { id: 'media-cn', parentId: 'cat-cn', name: '📺 国内媒体', order: 105,
        sources: [{ kind: 'remote', value: `${ACL}/ChinaMedia.list` }] },
    { id: 'download', parentId: 'cat-cn', name: '⬇️ 下载工具', order: 110,
        sources: [{ kind: 'remote', value: `${ACL}/Download.list` }],
        note: 'PT / BT 与软件下载，走直连避免占用代理带宽' },
    { id: 'china-company-ip', parentId: 'cat-cn', name: '🏢 国内厂商 IP', order: 998,
        sources: [{ kind: 'remote', value: `${ACL}/ChinaCompanyIp.list` }],
        note: 'IP 段判定，粒度粗，排在所有域名规则之后' },
    { id: 'geoip-cn', parentId: 'cat-cn', name: '🇨🇳 国内 IP', order: 999,
        sources: [{ kind: 'inline', ruleType: 'GEOIP', value: 'CN', noResolve: true }],
        note: 'IP 段判定，粒度粗，应排在所有域名规则之后' },

    // —— 广覆盖代理清单 ——
    { id: 'proxy-gfw', parentId: 'cat-proxy', name: '🚀 GFW 清单',
        sources: [{ kind: 'remote', value: `${ACL}/ProxyGFWlist.list` }] },
    { id: 'proxy-lite', parentId: 'cat-proxy', name: '🪶 精简代理清单', off: true,
        sources: [{ kind: 'remote', value: `${ACL}/ProxyLite.list` }] }
];

/**
 * 展平成统一卡片数组。大卡片与小卡片是同一种结构，只靠 `parentId` 区分：
 *   parentId === null  → 大卡片，sources 恒为空
 *   parentId !== null  → 小卡片，规则来源在此
 *
 * 小卡片默认跟随父卡片的桶；标了 `off` 的留在待选栏，需要用户手动拖入。
 */
function buildCatalog() {
    const parents = PARENT_DEFS.map((def, index) => Object.freeze({
        id: def.id,
        name: def.name,
        parentId: null,
        origin: 'builtin',
        bucket: def.bucket,
        order: index,
        sources: Object.freeze([]),
        ...(def.note ? { note: def.note } : {})
    }));

    const parentBucket = new Map(PARENT_DEFS.map(def => [def.id, def.bucket]));

    const children = CHILD_DEFS.map((def, index) => Object.freeze({
        id: def.id,
        name: def.name,
        parentId: def.parentId,
        origin: 'builtin',
        // 标了 off 的小卡片留在待选栏，其余跟随父卡片
        bucket: def.off ? 'off' : (parentBucket.get(def.parentId) || 'off'),
        order: def.order ?? index,
        sources: Object.freeze((def.sources || []).map((source, sourceIndex) => Object.freeze({
            id: `${def.id}-s${sourceIndex + 1}`,
            ...source
        }))),
        ...(def.note ? { note: def.note } : {})
    }));

    return Object.freeze([...parents, ...children]);
}

/** 内置卡片目录（大卡片 + 小卡片展平）。 */
export const BUILTIN_CARDS = buildCatalog();

/** 把冻结的内置卡片深拷成可变卡片，供 state 使用。 */
export function cloneBuiltinCards() {
    return BUILTIN_CARDS.map(card => ({
        ...card,
        sources: card.sources.map(source => ({ ...source }))
    }));
}

const DEFAULT_ENABLED_REGIONS = Object.freeze(['hk', 'jp', 'sg', 'us', OTHER_REGION_ID]);

/** 构造地区配置列表，含派生的 `🌐 其他地区`。 */
export function createRegionConfigs(enabledIds = DEFAULT_ENABLED_REGIONS) {
    const enabled = new Set(enabledIds);

    const regions = REGION_PRESETS.map(preset => ({
        ...preset,
        enabled: enabled.has(preset.id),
        type: 'url-test',
        testUrl: DEFAULT_TEST_URL,
        interval: DEFAULT_INTERVAL,
        tolerance: DEFAULT_TOLERANCE
    }));

    regions.push({
        id: OTHER_REGION_ID,
        name: GROUP_NAMES.otherRegion,
        pattern: '',            // 由已启用地区反向前瞻合成，见 serialize.js
        derived: true,
        enabled: enabled.has(OTHER_REGION_ID),
        type: 'url-test',
        testUrl: DEFAULT_TEST_URL,
        interval: DEFAULT_INTERVAL,
        tolerance: DEFAULT_TOLERANCE
    });

    return regions;
}

/** 生成器的初始状态。 */
export function createDefaultState() {
    return {
        version: STATE_VERSION,
        base: {
            autoSelect: true,
            manualSelect: true,
            fallback: false,
            regions: createRegionConfigs()
        },
        cards: cloneBuiltinCards(),
        headModifiers: {
            localAreaNetwork: true
        }
    };
}

/** 某张大卡片当前的小卡片（仅同桶的才算，被拖走的不再计入）。 */
export function childrenOf(cards, parentId) {
    return (cards || []).filter(card => card && card.parentId === parentId);
}

/**
 * 一张顶层卡片实际产出的全部来源 = 自身 sources + 其小卡片的 sources。
 *
 * 大卡片自身 sources 恒为空，因此它的产出完全取决于小卡片；小卡片被单独拖到
 * 别处后不再计入，大卡片内小卡片归零时该卡片不产出任何内容。
 */
export function effectiveSources(cards, card) {
    if (!card) return [];
    const own = Array.isArray(card.sources) ? card.sources : [];
    if (card.parentId !== null) return own;

    const childSources = childrenOf(cards, card.id)
        .filter(child => child.bucket === card.bucket)
        .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
        .flatMap(child => (Array.isArray(child.sources) ? child.sources : []));

    return [...own, ...childSources];
}
