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
 * 小卡片与大卡片同桶时默认由大卡片代表（合并进它那一组）；标了
 * `standalone: true` 的小卡片即便与父卡片同桶也自己算一个输出单元，
 * 用于在灵活桶里把某一张小卡片单独拎出来成组，见 isTopLevelIn()。
 *
 * **全部卡片的初始桶一律是 `off`（留在左栏待选栏）**，生成器不替用户决定分流。
 * 每张卡片各自的推荐落点仍保留在 RECOMMENDED_BUCKETS 里，供后续「一键设定
 * 规则分组」使用，见 applyRecommendedBuckets()。
 *
 * 目录内的 URL 与其在 render-clash.js:64-99 下的重写目标已逐条探测
 * （2026-09-01 复查，全部 200）：
 *   - SteamCN.list 与 GoogleFCM.list 在 `Clash/Ruleset/` 下，root 下为 404
 *   - PayPal / PrimeVideo / Copilot / Perplexity 在 ACL4SSR 中确实不存在，
 *     后两者改用内联规则
 *   - 早期文档记的「Disney / GitHub / GameDownloadCN 不存在」是文件名记错：
 *     实际是 `DisneyPlus.list` / `Github.list` / `GameDownload.list`，均存在
 */

/**
 * 往返状态的版本号与注释头前缀。
 *
 * v2 起注释头里的卡片经过瘦身（内置卡片只记与目录不同的字段，见
 * serialize.js 的 compactCards）。parse.js 同时接受 v1 的全量写法。
 * 前缀刻意不跟着改 —— 它标识的是「这里有可视化状态」这件事，改了会让
 * 已存模板的头整个找不到。
 */
export const STATE_VERSION = 2;
export const SUPPORTED_STATE_VERSIONS = Object.freeze([1, 2]);
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
    proxy: '🌍 国际代理',
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
 *
 * `recommend` 是这张卡片的**推荐**落点，不是初始落点 —— 初始一律 `off`。
 * 它只在后续「一键设定规则分组」里被用到（applyRecommendedBuckets）。
 */
const PARENT_DEFS = [
    // 「直连例外」而非「CN 例外」：UnBan.list 里既有国内域名，也有 dl.google.com、
    // ol.epicgames.com 这类非国内域名，它是广告规则的误杀捞回表，不是 CN 清单。
    // 四张小卡片的共性是「必须先直连、别被后面的规则吞掉」，故取此名。
    { id: 'cat-direct-exception', name: '✅ 直连例外', recommend: 'prepend',
        note: '放入这里的规则拥有最高优先级且强制直连，用于避免被后面的广覆盖清单吞掉' },
    { id: 'cat-ad', name: '🛑 广告过滤', recommend: 'adblock' },
    { id: 'cat-ai', name: '🤖 AI 服务', recommend: 'flexible' },
    { id: 'cat-media', name: '🎬 流媒体', recommend: 'flexible' },
    { id: 'cat-social', name: '📲 社交通讯', recommend: 'proxy' },
    { id: 'cat-tech', name: '💻 科技服务', recommend: 'proxy' },
    { id: 'cat-dev', name: '👨‍💻 开发与学术', recommend: 'proxy' },
    { id: 'cat-game', name: '🎮 游戏平台', recommend: 'flexible',
        note: '游戏对延迟敏感，单独成组便于挑低延迟节点' },
    { id: 'cat-cn', name: '🏠 国内直连', recommend: 'direct' },
    { id: 'cat-proxy', name: '🌏 广覆盖代理清单', recommend: 'off',
        note: '与各单项服务卡片大量重叠，与它们二选一' }
];

/**
 * 小卡片。`parentId` 指向所属大卡片，`sources` 是真正的规则来源。
 *
 * `optional: true` = 推荐预设里不含它（与同组其它卡片重叠、覆盖面过大或过于小众），
 * 需要用户自己拖进右栏。与初始落点无关 —— 初始所有卡片都在待选栏。
 */
const CHILD_DEFS = [
    // —— 直连例外 ——
    { id: 'google-cn', parentId: 'cat-direct-exception', name: '🇨🇳 谷歌中国',
        sources: [{ kind: 'remote', value: `${ACL}/GoogleCN.list` }],
        note: 'google.cn 等国内可直连域名，必须排在谷歌服务之前' },
    { id: 'steam-cn', parentId: 'cat-direct-exception', name: '🎮 Steam 中国',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/SteamCN.list` }],
        note: 'Steam 国内 CDN，排在 Steam 平台之前' },
    { id: 'ad-unban', parentId: 'cat-direct-exception', name: '🩹 误杀捞回',
        sources: [{ kind: 'remote', value: `${ACL}/UnBan.list` }],
        note: 'dl.google.com、ol.epicgames.com 等被广告规则误杀的域名。需排在广告过滤之前' },
    { id: 'google-fcm', parentId: 'cat-direct-exception', name: '🔔 谷歌推送', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/GoogleFCM.list` }],
        note: 'Android 推送服务，部分用户需要直连以保证及时性' },

    // —— 广告过滤 ——
    { id: 'ad-basic', parentId: 'cat-ad', name: '🚫 广告基础',
        sources: [
            { kind: 'remote', value: `${ACL}/BanAD.list` },
            { kind: 'remote', value: `${ACL}/BanProgramAD.list` }
        ],
        note: '通用广告与应用内广告，误杀少，适合作为唯一的广告清单' },
    { id: 'ad-easylist', parentId: 'cat-ad', name: '🧹 EasyList 广告', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/BanEasyList.list` }],
        note: '规则量大，可能误杀，按需启用' },
    { id: 'ad-easyprivacy', parentId: 'cat-ad', name: '🕵️ EasyPrivacy 广告追踪', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/BanEasyPrivacy.list` }],
        note: '拦截统计与追踪域名，可能影响部分站点功能' },
    { id: 'ad-easylist-cn', parentId: 'cat-ad', name: '🇨🇳 EasyList 中国广告', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/BanEasyListChina.list` }],
        note: '国内站点广告，误杀概率高于基础清单' },
    { id: 'ad-marketing', parentId: 'cat-ad', name: '📢 营销广告', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Marketing.list` }] },

    // —— AI 服务 ——
    { id: 'ai-openai', parentId: 'cat-ai', name: '🧠 OpenAI',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/OpenAi.list` }],
        note: 'ChatGPT / API。多数账号对 IP 归属地敏感，建议固定一个地区出口' },
    { id: 'ai-claude', parentId: 'cat-ai', name: '📎 Claude',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Claude.list` }],
        note: 'anthropic.com 与 claude.ai' },
    { id: 'ai-gemini', parentId: 'cat-ai', name: '💠 Gemini',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Gemini.list` }],
        note: 'Gemini / AI Studio / Colab / DeepMind' },
    { id: 'ai-copilot', parentId: 'cat-ai', name: '🧑‍💻 Copilot',
        sources: [
            { kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'copilot.microsoft.com' },
            { kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'copilot.cloud.microsoft' },
            { kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'githubcopilot.com' }
        ],
        note: 'ACL4SSR 无对应清单，用内联规则覆盖' },
    { id: 'ai-grok', parentId: 'cat-ai', name: '🛰️ Grok / xAI',
        sources: [
            { kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'grok.com' },
            { kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'x.ai' }
        ] },
    { id: 'ai-perplexity', parentId: 'cat-ai', name: '🔎 Perplexity',
        sources: [{ kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'perplexity.ai' }] },
    { id: 'ai-others', parentId: 'cat-ai', name: '✨ 其它 AI',
        sources: [
            { kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'mistral.ai' },
            { kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'meta.ai' },
            { kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'cursor.com' },
            { kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'groq.com' },
            { kind: 'inline', ruleType: 'DOMAIN-SUFFIX', value: 'huggingface.co' }
        ] },
    { id: 'ai-collection', parentId: 'cat-ai', name: '🤖 AI 合集', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/AI.list` }],
        note: '一张清单覆盖 OpenAI / Claude / Gemini / Copilot / Perplexity 等，与上面各单项卡片二选一' },

    // —— 流媒体 ——
    { id: 'youtube', parentId: 'cat-media', name: '📹 YouTube 油管',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/YouTube.list` }] },
    { id: 'youtube-music', parentId: 'cat-media', name: '🎧 YouTube Music 油管音乐', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/YouTubeMusic.list` }],
        note: '与油管视频大量重叠，单独启用只在需要区分出口时有意义' },
    { id: 'netflix', parentId: 'cat-media', name: '🎥 Netflix 奈飞',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Netflix.list` }] },
    { id: 'disney', parentId: 'cat-media', name: '🐭 Disney+ 迪士尼',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/DisneyPlus.list` }] },
    { id: 'spotify', parentId: 'cat-media', name: '🎵 Spotify 声破天',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Spotify.list` }] },
    { id: 'hbo', parentId: 'cat-media', name: '🎬 HBO', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/HBO.list` }] },
    { id: 'twitch', parentId: 'cat-media', name: '🟣 Twitch', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Twitch.list` }] },
    { id: 'tiktok', parentId: 'cat-media', name: '🎼 TikTok 抖音国际', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/TikTok.list` }] },
    { id: 'bahamut', parentId: 'cat-media', name: '🍿 Bahamut 巴哈姆特', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Bahamut.list` }],
        note: '台湾动画疯，需台湾节点' },
    { id: 'bilibili-hmt', parentId: 'cat-media', name: '📺 哔哩哔哩港澳台', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/BilibiliHMT.list` }],
        note: '港澳台限定番剧，需港澳台节点。与「🅱️ 哔哩哔哩」直连卡片配合使用' },
    { id: 'media-proxy', parentId: 'cat-media', name: '🌏 国际媒体合集', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/ProxyMedia.list` }],
        note: '覆盖面广，与上面各单项清单大量重叠，二选一' },

    // —— 社交通讯 ——
    { id: 'telegram', parentId: 'cat-social', name: '📲 Telegram 电报',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Telegram.list` }] },
    { id: 'twitter', parentId: 'cat-social', name: '🐦 Twitter·X 推特',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Twitter.list` }] },
    { id: 'facebook', parentId: 'cat-social', name: '📘 Facebook 脸书',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Facebook.list` }] },
    { id: 'instagram', parentId: 'cat-social', name: '📷 Instagram',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Instagram.list` }] },
    { id: 'discord', parentId: 'cat-social', name: '🎧 Discord',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Discord.list` }] },
    { id: 'whatsapp', parentId: 'cat-social', name: '💬 WhatsApp', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Whatsapp.list` }] },
    { id: 'reddit', parentId: 'cat-social', name: '🗨️ Reddit', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Reddit.list` }] },

    // —— 科技服务 ——
    { id: 'google', parentId: 'cat-tech', name: '🔍 谷歌服务',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Google.list` }],
        note: '含 DOMAIN-KEYWORD,google，会吞掉 google.cn —— 谷歌中国必须排在它之前' },
    { id: 'microsoft', parentId: 'cat-tech', name: 'Ⓜ️ 微软服务',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Microsoft.list` }] },
    { id: 'apple', parentId: 'cat-tech', name: '🍎 苹果服务',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Apple.list` }] },
    { id: 'onedrive', parentId: 'cat-tech', name: '☁️ OneDrive', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/OneDrive.list` }] },
    { id: 'bing', parentId: 'cat-tech', name: '🔷 Bing 必应', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Bing.list` }] },
    { id: 'amazon', parentId: 'cat-tech', name: '📦 亚马逊', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Amazon.list` }],
        note: '含 AWS 与 Prime Video' },
    { id: 'adobe', parentId: 'cat-tech', name: '🅰️ Adobe', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Adobe.list` }] },
    { id: 'zoom', parentId: 'cat-tech', name: '🎥 Zoom', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Zoom.list` }] },

    // —— 开发与学术 ——
    { id: 'github', parentId: 'cat-dev', name: '🐙 GitHub',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Github.list` }] },
    { id: 'wikipedia', parentId: 'cat-dev', name: '📚 维基百科',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Wikipedia.list` }] },
    { id: 'docker', parentId: 'cat-dev', name: '🐳 Docker', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Docker.list` }] },
    { id: 'jetbrains', parentId: 'cat-dev', name: '🧩 JetBrains', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/JetBrains.list` }] },
    { id: 'developer', parentId: 'cat-dev', name: '🧰 开发者服务', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Developer.list` }],
        note: 'npm / PyPI / Maven 等包仓库与开发平台' },
    { id: 'scholar', parentId: 'cat-dev', name: '🎓 学术资源', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Scholar.list` }] },

    // —— 游戏平台 ——
    { id: 'steam', parentId: 'cat-game', name: '🕹️ Steam 平台',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Steam.list` }],
        note: '「🎮 Steam 中国」需排在它之前，否则国内 CDN 会被一起代理' },
    { id: 'epic', parentId: 'cat-game', name: '👾 Epic 平台',
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Epic.list` }] },
    { id: 'blizzard', parentId: 'cat-game', name: '❄️ 暴雪战网', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Blizzard.list` }] },
    { id: 'nintendo', parentId: 'cat-game', name: '🎮 任天堂', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Nintendo.list` }] },
    { id: 'playstation', parentId: 'cat-game', name: '🎯 索尼 PSN', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Sony.list` }] },
    { id: 'xbox', parentId: 'cat-game', name: '🟩 Xbox', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Xbox.list` }] },
    { id: 'origin', parentId: 'cat-game', name: '🎲 EA / Origin', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Origin.list` }] },
    { id: 'game-download', parentId: 'cat-game', name: '⬇️ 游戏下载', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/GameDownload.list` }],
        note: '游戏本体下载。放进直连桶更划算，代理带宽通常更贵' },

    // —— 国内直连。IP 类清单靠 order 钉在域名类之后 ——
    { id: 'china-domain', parentId: 'cat-cn', name: '🏠 中国域名', order: 100,
        sources: [{ kind: 'remote', value: `${ACL}/ChinaDomain.list` }] },
    { id: 'media-cn', parentId: 'cat-cn', name: '📺 国内媒体', order: 105,
        sources: [{ kind: 'remote', value: `${ACL}/ChinaMedia.list` }] },
    { id: 'bilibili', parentId: 'cat-cn', name: '🅱️ 哔哩哔哩', order: 106,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/Bilibili.list` }] },
    { id: 'netease-music', parentId: 'cat-cn', name: '🎶 网易云音乐', order: 107,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/NetEaseMusic.list` }],
        note: '版权按 IP 归属地判定，走代理会大面积变灰' },
    { id: 'cn-vendors', parentId: 'cat-cn', name: '🛍️ 国内大厂', order: 108,
        sources: [
            { kind: 'remote', value: `${ACL}/Ruleset/Alibaba.list` },
            { kind: 'remote', value: `${ACL}/Ruleset/Baidu.list` },
            { kind: 'remote', value: `${ACL}/Ruleset/Tencent.list` },
            { kind: 'remote', value: `${ACL}/Ruleset/ByteDance.list` }
        ],
        note: '阿里 / 百度 / 腾讯 / 字节，四张清单合成一张卡片' },
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
    { id: 'proxy-lite', parentId: 'cat-proxy', name: '🪶 精简代理清单', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/ProxyLite.list` }] },
    { id: 'proxy-blocked', parentId: 'cat-proxy', name: '🚧 常被墙站点', optional: true,
        sources: [{ kind: 'remote', value: `${ACL}/Ruleset/TopBlockedSites.list` }] }
];

/**
 * 展平成统一卡片数组。大卡片与小卡片是同一种结构，只靠 `parentId` 区分：
 *   parentId === null  → 大卡片，sources 恒为空
 *   parentId !== null  → 小卡片，规则来源在此
 *
 * **所有卡片的 `bucket` 一律是 `off`**：生成器不替用户决定分流，全部卡片
 * 初始都在左栏待选栏，由用户自己拖进右栏。推荐落点另存 RECOMMENDED_BUCKETS。
 */
function buildCatalog() {
    const parents = PARENT_DEFS.map((def, index) => Object.freeze({
        id: def.id,
        name: def.name,
        parentId: null,
        origin: 'builtin',
        bucket: 'off',
        order: index,
        sources: Object.freeze([]),
        ...(def.note ? { note: def.note } : {})
    }));

    const children = CHILD_DEFS.map((def, index) => Object.freeze({
        id: def.id,
        name: def.name,
        parentId: def.parentId,
        origin: 'builtin',
        bucket: 'off',
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

/**
 * 卡片 id → 推荐落点。**不参与初始状态**，只供后续「一键设定规则分组」使用。
 *
 * 小卡片跟随父卡片的推荐落点；标了 `optional` 的小卡片推荐值为 `off`
 * （与同组其它卡片重叠、覆盖面过大或过于小众）。
 */
export const RECOMMENDED_BUCKETS = Object.freeze(Object.fromEntries([
    ...PARENT_DEFS.map(def => [def.id, def.recommend]),
    ...CHILD_DEFS.map(def => [
        def.id,
        def.optional
            ? 'off'
            : (PARENT_DEFS.find(parent => parent.id === def.parentId)?.recommend || 'off')
    ])
]));

/**
 * 按推荐落点批量改桶，返回新数组，不改入参。用户卡片与目录里没有的卡片原样保留。
 *
 * 这是后续「一键设定规则分组」的纯函数内核 —— 界面入口尚未实现。
 */
export function applyRecommendedBuckets(cards) {
    return (cards || []).map(card => {
        const recommend = card && RECOMMENDED_BUCKETS[card.id];
        return recommend ? { ...card, bucket: recommend } : { ...card };
    });
}

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

/**
 * 生成器的初始状态。
 *
 * 卡片全部落在待选栏（`bucket: 'off'`）—— 分流方案由用户自己拼，生成器不做预设。
 * 基础策略组与地区分组仍带默认勾选：它们是节点侧的组织方式，不决定任何流量走向。
 */
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
 * 某张大卡片当前**代表**的小卡片：同桶、且没有被标成独立成组的那些。
 * 这是「一张大卡片产出什么」与「界面上它下面挂着谁」的共同口径。
 */
export function representedChildren(cards, card) {
    if (!card || card.parentId !== null) return [];
    return childrenOf(cards, card.id)
        .filter(child => child.bucket === card.bucket && !child.standalone)
        .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

/**
 * 卡片在某个桶里是否算一个**顶层卡片**（= 一个输出单元）。
 *
 * 三种情况：
 *   - 大卡片：恒是
 *   - 小卡片，父卡片不在这个桶里：是（它被单独拖出来了）
 *   - 小卡片，父卡片同桶：默认**不是**（由父卡片代表），除非 `standalone: true`
 *
 * `standalone` 是为灵活桶准备的：那里每张顶层卡片各自成一个策略组，用户需要
 * 能把某一张小卡片从集合里拎出来单独成组（例如 `🤖 AI 服务` 整体一组、但
 * `💠 Gemini` 要单独一组走别的出口），同时集合里其余小卡片照旧合并。
 *
 * serialize.js / validate.js / RuleGeneratorModal / BucketPanel 一律走这个函数 ——
 * 这个判定曾经在四处各写一遍，改一处漏三处。
 */
export function isTopLevelIn(cards, card, bucket) {
    if (!card || card.bucket !== bucket) return false;
    if (card.parentId === null) return true;
    if (card.standalone) return true;

    const parent = (cards || []).find(item => item && item.id === card.parentId);
    return !(parent && parent.bucket === bucket);
}

/**
 * 一张顶层卡片实际产出的全部来源 = 自身 sources + 它代表的小卡片的 sources。
 *
 * 大卡片自身 sources 恒为空，因此它的产出完全取决于小卡片；小卡片被单独拖到
 * 别处、或标成 `standalone` 之后不再计入（否则同一条规则会输出两次），
 * 大卡片内小卡片归零时该卡片不产出任何内容。
 */
export function effectiveSources(cards, card) {
    if (!card) return [];
    const own = Array.isArray(card.sources) ? card.sources : [];
    if (card.parentId !== null) return own;

    const childSources = representedChildren(cards, card)
        .flatMap(child => (Array.isArray(child.sources) ? child.sources : []));

    return [...own, ...childSources];
}
