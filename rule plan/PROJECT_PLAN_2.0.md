# MiSub 内置可视化规则生成器 — 实施方案 2.0

**文档状态**：阶段 A + B 已实现并通过本地验收；C0（目录分组粒度重做）已完成。本文已回写实现期间的全部设计变更，与代码同步。

**取代关系**：本文取代 `PROJECT_DESIGN.md`、`DESIGN_REVIEW.md`、`PROJECT_PLAN_1.0.md`。三份旧文档为"独立零后端工具 + 外部 subconverter"路线所写，该路线在 MiSub 内不成立，整体作废。仍然有效的已核实事实收进附录 A，作废条目对照见附录 B。

**核实基准**：MiSub v2.7.0，本文所有关于宿主行为的断言均来自阅读仓库代码，标注了 `文件:行号`。

**实现期变更**：本文 2.0 初稿与最终实现有若干差异，全部来自本地验收反馈，逐条记录在**附录 C**。读本文时以正文为准，附录 C 只说明"为什么改"。其中影响面最大的三条：卡片模型由单层改为**两层嵌套**（4.2）、**出口不再绑在卡片上**（5.2.1）、「⬆️ 优先匹配」段**删除**并由「🔧 前置修正」段接管（5.1）。

**第二轮验收变更**（附录 D）：卡片**默认全部留在待选栏**、内置目录细化到 10 大卡片 / 68 小卡片、反推时不再撞出同名卡片、注释头瘦身。

---

## 一、定位与范围收敛

### 1.1 一句话定位

把 MiSub 现有的裸 INI 文本框（`RuleTemplateManager.vue`）升级为可视化分流配置界面，让不会写 `custom_proxy_group` / `ruleset` 语法的用户也能产出可用的自定义规则模板。

### 1.2 与旧方案的根本差异

旧方案是一个**独立工具**：自己不转换，把配置塞进 URL，依赖公共 subconverter 后端。

本方案是 MiSub 的**内置前端功能**：只负责把可视化状态序列化成 INI 文本，写进 MiSub 已有的规则模板存储。转换、渲染、分发全部由 MiSub 现有引擎完成。

后果是范围大幅收窄：**功能可以做成纯前端，`functions/` 一行都不用改。**

### 1.3 明确不做的事

- 不做订阅转换本体（MiSub 已有）
- 不引入 subconverter，不做后端选择器、不做后端探活
- 不做 `data:` URI 内联、不做 URL 体积管理
- 不新增存储结构、不新增 API 路由
- 不做规则内容级重叠分析（阶段 C，见 6.4）
- 不新增依赖

---

## 二、宿主环境已提供的能力

### 2.1 现有渲染链路（核实结论）

一个 `custom:<id>` 规则模板在 MiSub 内走这条链路（`functions/services/processor-service.js:231-284`）：

```
misub_rule_templates_v1  (KV，INI 文本)
  → resolveRuleTemplateSource()        rule-template-handler.js:77
  → parseIniTemplate()                 template-parsers/ini-template-parser.js:146
  → applySmartModelOptimizations()     template-processor.js:197
  → render{Clash,Singbox,Surge,Loon,Quanx,Egern}FromTemplateModel()
  → applyCustomDnsToBuiltinPreset()    processor-service.js:97
```

**生成器只需产出这条链路的入口——INI 文本。后面全部免费继承。**

### 2.2 白拿的能力

| 能力 | 出处 |
|---|---|
| 六个目标格式（clash / sing-box / surge / loon / quanx / egern） | `processor-service.js:251-275` |
| 远程 ruleset URL 自动转 `rule-providers`，客户端自更新 | `render-clash.js:130-159` |
| ACL4SSR `.list` → `Providers/*.yaml` 路径重写与 `behavior` 判定 | `render-clash.js:64-109` |
| 自己的 base config（`mixed-port` / `mode` / `dns` 等），不继承任何外部默认值 | `render-clash.js:161-178` |
| 自定义 DNS 模板覆盖，六目标各自实现 | `processor-service.js:97-150, 282-284` |
| 0 成员策略组连带引用与规则一起递归剪除 | `template-processor.js:43-76` |
| 悬空成员引用清理 | `template-processor.js:178-190` |
| 同名策略组合并去重 | `template-processor.js:102-137` |
| 正则过滤器按节点名展开（带 `i` flag） | `template-processor.js:7-37` |
| 存储、读写 API、Pinia store、模板选择器 | `rule-template-handler.js`、`useDataStore.js:207-231`、`TransformSelector.vue` |

### 2.3 存储约束

`functions/modules/rule-template-handler.js`：

- KV key `misub_rule_templates_v1`（`:4`）
- 最多 50 个模板（`:5`），单模板内容 128 KB（`:6`）
- 内容必须含 `[custom]` / `[proxy group]` / `[rule]` 等段头才被接受（`:28` `hasIniShape()`）
- 记录字段白名单：`id / name / description / type / content / enabled / createdAt / updatedAt`（`:51-60`）——**额外字段会被静默丢弃**，这决定了 4.5 的往返方案

---

## 三、必须避开的两个宿主特有约束

旧文档基于 subconverter + PCRE2 实测得出的两条结论，在 MiSub 内是反的。这是本方案最容易踩的坑。

### 3.1 地区正则禁止 `(?i)` 前缀，禁止多层括号

`ini-template-parser.js:125` 对以 `(` 开头且以 `)` 结尾的过滤器直接 `slice(1, -1)`：

```
(?i)(港|HK)   →  slice  →  ?i)(港|HK      →  new RegExp 抛错
(港|HK)|(台|TW) →  slice  →  港|HK)|(台|TW  →  new RegExp 抛错
```

抛错被 `template-processor.js:30-32` 捕获并 `console.warn`，该组得到 0 成员，随后被 `pruneEmptyGroups` **静默删除**。用户只会看到地区组凭空消失。

而 `template-processor.js:24` 本来就用 `new RegExp(filter, 'i')`，`(?i)` 既不必要也有害。

**约束**：地区 pattern 只允许单层外括号（如 `(港|HK|Hong ?Kong)`）或不带括号；禁止 `(?i)`；禁止多个并列括号组。

反向前瞻是安全的：`^(?!.*(港|HK)).*$` 以 `^` 开头，不触发 `slice` 分支，走 `:133` 兜底进入 `filters`，JS 原生支持。

### 3.2 禁止依赖 `<%regionStrategyChain%>`

`main-handler.js:590-591` 对 `templateSource.kind === 'custom'` 强制 `ruleLevel = 'none'`。而 `template-processor.js:206` 在 `none` 下跳过地区组注入。因此 `expandMagicPlaceholders`（`:143-172`）只会展开成**模板自己声明的 url-test 组**。

这造成一个不对称：同样内容作为 `builtin:` 预设时占位符能展开（`builtin:` 保留真实 ruleLevel），作为 `custom:` 模板时展开为空。

**约束**：生成器必须显式输出每一个地区策略组，不使用占位符。这也更确定，且 0 命中地区组会被自动剪除——**白拿了旧文档 R2「0 命中静默变 DIRECT」的解**。

---

## 四、数据模型

### 4.1 GeneratorState

```ts
interface GeneratorState {
  version: 1

  base: {
    // 🚀 节点选择 恒定生成，不入 state
    autoSelect: boolean            // ♻️ 自动选择
    manualSelect: boolean          // ☑️ 手动切换
    fallback: boolean              // 🔯 故障转移
    regions: RegionConfig[]        // 地区分组，逐个可选
  }

  cards: RuleCard[]                // 左侧待选栏与右栏各段的全部卡片，见 4.2
                                   // 初始状态一律 bucket: 'off'（全在待选栏）

  headModifiers: {
    localAreaNetwork: boolean      // 局域网直连
  }
}

interface RegionConfig {
  id: string                       // 'hk' | 'jp' | 'us' | 'sg' | 'tw' | 'kr' | 'other'
  enabled: boolean
  name: string                     // '🇭🇰 香港节点'  —— emoji 直接写进组名
  pattern: string                  // '港|HK|Hong ?Kong'  —— 见 3.1 约束
  type: 'url-test' | 'select'
  testUrl: string                  // 'http://www.gstatic.com/generate_204'
  interval: number                 // 300
  tolerance: number                // 50
}
```

设计决定，逐条对应旧文档 8.3 的数据模型问题：

- **emoji 写进 `name`**（旧 M1）：MiSub 的组名本来就内联 emoji（`builtin-rules-provider.js:6-10`），不需要独立字段
- **测速参数显式化**（旧 M2 / M3）：`testUrl` / `interval` / `tolerance` 必填，不在序列化器里写死
- **`其他地区` 用 `url-test`**（旧 M8）：旧文档标 `select`，让用户从杂牌节点里手选体验差
- **未勾选任何地区时不输出 `其他地区`**（旧 M9）：避免空捕获组 `^(?!.*()).*$`
- **不再有 `assignments: Record<PresetId, Assignment>`**（旧 M4）：桶归属直接长在卡片上，见 4.2
- **`headModifiers` 只剩一个开关**：原先的 `unban` 是 ACL4SSR 的 `UnBan.list`，实测 31 条规则里既有 `vd.l.qq.com` 这类国内域名，也有 `dl.google.com`、`ol.epicgames.com`、`tracking-protection.cdn.mozilla.net` 这类非国内域名——**它是广告规则的误杀捞回表，不是 CN 清单**。作为不可见的开关会让用户完全无法理解它在做什么，因此降级为「🔧 前置修正」段里的一张普通小卡片 `🩹 误杀捞回`，可拖动、可关闭、展开后能看到真实 URL

### 4.2 RuleCard（两层嵌套的统一卡片模型）

左侧待选栏与右栏各段里的每一个可拖动对象都是同一种结构，靠 `parentId` 区分两层：

- **大卡片**（`parentId === null`）：集合容器，`sources` **恒为空**，本身不带任何规则
- **小卡片**（`parentId` 指向某张大卡片）：规则来源**全部**绑在这一层

```ts
interface RuleCard {
  id: string
  parentId: string | null          // null = 大卡片；否则指向所属大卡片
  name: string                     // 落进灵活桶时即策略组名
  origin: 'builtin' | 'user'
  sources: CardSource[]            // 大卡片恒为空数组
  bucket: 'off' | 'prepend' | 'flexible' | 'adblock' | 'proxy' | 'direct'
  order: number                    // 桶内排序
  note?: string
}

interface CardSource {
  id: string
  kind: 'remote' | 'inline'
  value: string                    // remote: 规则集 URL；inline: 规则值
  ruleType?: 'DOMAIN' | 'DOMAIN-SUFFIX' | 'DOMAIN-KEYWORD'
           | 'IP-CIDR' | 'IP-CIDR6' | 'GEOIP' | 'GEOSITE'
           | 'PROCESS-NAME' | 'DST-PORT'          // 仅 inline
  noResolve?: boolean                              // 仅 IP-CIDR / IP-CIDR6 / GEOIP
}
```

**两层都能独立拖进右侧任意桶。** 拖大卡片会连带其**当前同桶**的全部小卡片；拖小卡片不影响大卡片位置。

**只有落进灵活桶才生成独立策略组**，落进其它桶只是把规则并入该桶的承接组。

**大卡片内同桶小卡片数为 0 时不产出任何内容**——这是"空集合"的唯一判定口径，UI 给 `warn` 提示而非拦截。

`RuleCard` 上**没有 `target` 字段**：出口由策略组决定，不在卡片上写死（5.2.1）。也没有 `category` / `cnException`——分节改由大卡片本身承担，CN 例外策展改由「🔧 前置修正」段的默认落点承担。

#### 4.2.1 顶层卡片：序列化与 UI 共用的口径

一个桶里"算一个输出单元"的卡片称为**顶层卡片**：

- 大卡片，或
- 被单独拖出父卡片的小卡片（其父卡片**不在**同一个桶里）

跟父卡片留在同桶的小卡片**不是**顶层卡片——它们的来源已由父卡片的 `effectiveSources()` 收进去，单独再算一次会重复输出。

```ts
// catalog.js
effectiveSources(cards, card): CardSource[]
// 小卡片 → 自身 sources
// 大卡片 → 自身 sources（恒空）+ 其同桶小卡片的 sources，按 order 排列
```

`serialize.js` 的 `topLevelCardsIn()`、`validate.js` 的 `orderedActiveCards()`、`BucketPanel.vue` 的 `topLevelIn()` 三处必须保持同一口径，否则 UI 显示的卡片数与实际输出会不一致。

统一成一种结构的收益：

- `assignments` 这张独立映射表消失，桶归属只有一个真相源
- 大卡片天然是"多来源容器"，直接服务于抑制组膨胀（`🤖 AI 服务` = OpenAi + Claude + 3 条内联 = **1 个**策略组）
- 用户自定义规则集退化为"一张大卡片 + 每行一张小卡片"，与内置目录同构（7.2）

`bucket` 的六种语义：

| bucket | 输出 | `name` 的作用 |
|---|---|---|
| `off` | 不输出，留在左侧待选栏 | 卡片标题 |
| `prepend` | 全部来源指向字面量 `DIRECT` | 仅卡片标题 |
| `flexible` | 新建策略组 `name`，全部来源指向它 | **策略组名** |
| `adblock` | 全部来源指向共享的 `🛑 广告拦截` | 仅卡片标题 |
| `proxy` | 全部来源指向共享的 `🌍 国外代理` | 仅卡片标题 |
| `direct` | 全部来源指向共享的 `🎯 全球直连` | 仅卡片标题 |

四个承接桶（`adblock` / `proxy` / `direct` 以及兜底的 `🐟 漏网之鱼`）**无论放入多少卡片都只生成一个策略组**；灵活桶则是"每张顶层卡片一个组"。

#### 4.2.2 内置目录的两层结构

**10 张大卡片，68 张小卡片，初始 `bucket` 一律是 `off`** —— 生成器不替用户决定分流，右栏六段开局全空，全部卡片都在左栏待选栏，由用户自己拖。

每张卡片另有一个**推荐落点**（`RECOMMENDED_BUCKETS`），它**不参与初始状态**，只是把策展意见存下来，供后续「一键设定规则分组」使用；纯函数内核 `applyRecommendedBuckets(cards)` 已实现，界面入口尚未做。下表的「推荐桶」列即此值，`(可选)` 标记的小卡片推荐值为 `off`——它们与同组其它卡片重叠、覆盖面过大或过于小众。

| 大卡片 | 推荐桶 | 小卡片 |
|---|---|---|
| `✅ 直连例外` | `prepend` | 谷歌中国 / Steam 中国 / 误杀捞回 / 谷歌推送(可选) |
| `🛑 广告过滤` | `adblock` | 广告基础 / EasyList 广告(可选) / EasyPrivacy 广告追踪(可选) / EasyList 中国广告(可选) / 营销广告(可选) |
| `🤖 AI 服务` | `flexible` | OpenAI / Claude / Gemini / Copilot / Grok·xAI / Perplexity / 其它 AI / AI 合集(可选) |
| `🎬 流媒体` | `flexible` | 油管视频 / 油管音乐(可选) / 奈飞 / 迪士尼 / 声破天 / HBO(可选) / Twitch(可选) / 抖音国际(可选) / 巴哈姆特(可选) / 哔哩哔哩港澳台(可选) / 国际媒体合集(可选) |
| `📲 社交通讯` | `proxy` | 电报消息 / 推特 / 脸书 / Instagram / Discord / WhatsApp(可选) / Reddit(可选) |
| `💻 科技服务` | `proxy` | 谷歌服务 / 微软服务 / 苹果服务 / OneDrive(可选) / 必应(可选) / 亚马逊(可选) / Adobe(可选) / Zoom(可选) |
| `👨‍💻 开发与学术` | `proxy` | GitHub / 维基百科 / Docker(可选) / JetBrains(可选) / 开发者服务(可选) / 学术资源(可选) |
| `🎮 游戏平台` | `flexible` | Steam / Epic / 暴雪战网(可选) / 任天堂(可选) / 索尼 PSN(可选) / Xbox(可选) / EA·Origin(可选) / 游戏下载(可选) |
| `🏠 国内直连` | `direct` | 中国域名 / 国内媒体 / 哔哩哔哩 / 网易云音乐 / 国内大厂 / 下载工具 / 国内厂商 IP / 国内 IP |
| `🌏 广覆盖代理清单` | `off` | GFW 清单 / 精简代理清单(可选) / 常被墙站点(可选) |

大卡片名刻意与 `GROUP_NAMES` 全部不同——大卡片进灵活桶后其 `name` 即策略组名，撞名会被 `dedupeGroupsByName`（`template-processor.js:102-137`）静默合并（6.2）。**78 张卡片的名字彼此也不重复**，这条由反推逻辑依赖（4.6）。

`✅ 直连例外` 而非"CN 例外"：其四张小卡片的共性是"必须先直连、别被后面的规则吞掉"，而 `UnBan.list` 本身不是 CN 清单（4.1）。

`🛍️ 国内大厂` 一张卡片装 4 条清单（阿里 / 百度 / 腾讯 / 字节），是"多来源合一"抑制组膨胀的示范（4.2.1）。

**目录内全部 URL 与其在 `render-clash.js:64-99` 下的重写目标已逐条 HEAD 探测**（2026-09-01 复查，68 条来源、原始 URL 与重写目标全部 200）。三处与本文初稿不符：

- `SteamCN.list` 与 `GoogleFCM.list` 在 `Clash/Ruleset/` 下，root 路径为 404
- PayPal / PrimeVideo / Copilot / Perplexity 在 ACL4SSR 中确实不存在，后两者改用内联规则
- 初稿记的「Disney / GitHub / GameDownloadCN 不存在」是**文件名记错**：实际是 `DisneyPlus.list` / `Github.list` / `GameDownload.list`，均存在且已收入目录

注意 `Clash/Ruleset/` 里有 `.list` 不代表 `Clash/Providers/Ruleset/` 里有对应 `.yaml`（`Hulu` / `Line` / `JD` 就没有），而 clash 路径重写后拉的是后者，因此两个 URL 都要探。

### 4.3 内置的 GEOIP 卡片

`GEOIP,CN` 不是一个开关，而是 `🏠 国内直连` 大卡片下的一张普通小卡片：

```ts
{
  id: 'geoip-cn',
  parentId: 'cat-cn',              // 挂在 🏠 国内直连 下
  name: '🇨🇳 国内 IP',
  origin: 'builtin',
  sources: [{ id: '…', kind: 'inline', ruleType: 'GEOIP', value: 'CN', noResolve: true }],
  bucket: 'off',                   // 与其它卡片一样，初始在待选栏；推荐落点 direct
  order: 999,                      // 桶内钉底
  note: 'IP 段判定，粒度粗，应排在所有域名规则之后'
}
```

因此它和其它卡片一样在待选栏里等着被拖走，也可以单独拖到任意桶。`order: 999` 让它一旦入桶就钉在该桶末尾，满足"IP 规则排在域名规则之后"的位置约定。同桶的 `🏢 国内厂商 IP` 用 `order: 998` 紧挨其前。

**拖出 `🎯 全球直连` 要给警告**：`GEOIP,CN` 覆盖面极大，一旦落进灵活桶或 `🌍 国外代理`，它会排在 `🎯 全球直连` 的全部域名规则之前，把 `ChinaDomain` 之类清单整体遮蔽。这是 `warn` 级提示而非拦截——用户可能确有此意图（如刻意让国内 IP 走代理）。判定口径是"该卡片的全部来源都是 `GEOIP` / `IP-CIDR` / `IP-CIDR6` 类型"，域名与 IP 混合的卡片不触发。

**这个形态无需任何输出格式改动。** `ruleset=<组名>,<源>` 允许多行共享同一组名，MiSub 自己的内置预设已经这么用——`builtin-template-registry.js:67-85` 的 `🤖 AI 服务` 就由 2 个远程清单加 15 条内联规则组成。`render-clash.js:130-159` 为每个**不同 URL** 建一个 `rule-provider`（`:148` 用递增计数器命名，同名文件不冲突），再由 `:195-200` 输出多条 `RULE-SET` 指向同一 policy。N 个来源合成一个组是原生可表达的。

自填 URL 不命中 `render-clash.js:64-99` 的 ACL4SSR 路径映射表，一律 `behavior: classical`（`.list` 附带 `format: text`）。classical 是最宽容的 behavior，支持全部规则类型，因此是安全默认值。

### 4.4 自定义规则集的创建与去重

**创建**：顶栏「🧱 自定义规则集」是一个多行构建器（7.2）。可命名，默认一行输入框，每行可选**远程 URL** 或**内联规则**（内联再选 `ruleType`），右侧按钮加行。提交后合成**一张大卡片 + 每行一张小卡片**，落到**左栏候选区顶部**（`bucket: 'off'`），不直接进右侧桶——用户随后自行决定拖到哪一段。

这样它与内置目录完全同构：拖进灵活桶就是一个独立策略组（组名 = 用户起的名字），拖进承接桶就是并入该组的规则。

**去重（用户输入优先）**：每条来源与所有其它**生效**卡片的来源做字面比对，命中则：

1. 双方同时标红，顶部出现冲突条
2. 每条冲突给出"保留我的：〈卡片名〉"按钮，按下即从**其余**卡片移除该来源

去重在**来源粒度**而非卡片粒度生效：一张三来源的卡片只有一条撞车时，另外两条与卡片本身都保留。

**嵌套模型下的一个坑**：冲突条目携带的是**顶层卡片** id，而来源实际长在它的小卡片上（大卡片 `sources` 恒空）。`removeSourceFromCard()` 因此必须"先在目标卡片上找，找不到再降到它的小卡片里找"——否则会把大卡片误删、留下孤立的小卡片，冲突还在。

字面比对前先归一化 URL（去尾斜杠、统一大小写 host、剥离 query；**path 大小写保留**，因为 raw.githubusercontent.com 区分大小写）。**只能查出 URL 字面相同**，查不出内容重叠——见第十节缺口。

### 4.5 往返存储：INI 注释头

**问题**：模板在 KV 里是 INI 文本，重新打开可视化界面需要还原卡片的两层嵌套关系、桶归属、卡内来源的拆分边界，这些无法从 INI 正文完整反推。记录字段白名单（2.3）又不允许加字段。

**方案**：把 `GeneratorState` 序列化成 JSON、base64 后写进 INI 首行注释。

```ini
; misub-visual-state-v1: eyJ2ZXJzaW9uIjoxLCJiYXNlIjp7Li4u
[custom]
ruleset=...
```

`ini-template-parser.js:10` 跳过 `;` 与 `#` 开头的行——**对渲染器完全惰性**。`[custom]` 仍在，`hasIniShape()` 通过。128 KB 上限对一份状态 JSON 绰绰有余。

**代价**：`functions/` 零改动，整个功能纯前端。

**风险**：用户在高级模式手改 INI 后，注释头与正文不同步。处理策略见 8.3 A3 与第十节。

#### 4.5.1 卡片瘦身（`version: 2`）

全量写法下 78 张卡片的注释头约 **31 KB**——单模板 128 KB 上限的四分之一，且在高级模式的 textarea 里是一行谁也看不懂的巨串。因此内置卡片只记**与目录不同的字段**，一字未改的整张压成一个 id 字符串：

```jsonc
"cards": [
  "cat-ai",                              // 与目录逐字段相同
  { "id": "telegram", "bucket": "proxy" }, // 只改了桶
  { "id": "user-3", "name": "🎮 我的游戏", … } // 用户卡片，完整
]
```

默认状态的注释头由此降到约 **3.2 KB**，且不再随目录条数线性膨胀。数组长度与下标顺序原样保留——`compareCards` 的最后一级排序依赖数组下标。编码在 `serialize.js` 的 `compactCards()`、解码在 `parse.js` 的 `expandCards()`，两者必须对称。

`STATE_VERSION` 因此从 1 升到 2，`SUPPORTED_STATE_VERSIONS` 同时接受两者：**v1 的全量注释头照旧能读**（展开时目录打底、条目字段覆盖，等价于原行为）。反过来，旧版本 MiSub 读到 v2 头会判定版本不符、退回正文反推——比读进一堆缺字段的卡片安全。

`STATE_HEADER_PREFIX` 刻意保持 `; misub-visual-state-v1:` 不变：它标识的是"这里有可视化状态"这件事，改了会让已存模板的头整个找不到。

### 4.6 反推时的卡片同名约束

`recoverFromBody`（A3）按组名归桶。组名恰好等于某张内置卡片名时，**接管那张卡片**而不是另建一张同名用户卡片；命中的小卡片其组名就是它自己的名字时，**不把父卡片拉进来改名**。两条都是为了同一件事：反推出来的卡片集合里不出现两张同名卡片。

不做这两条会出现的实际故障：旧的「新建模板」初始正文里 `📲 电报消息` 组用的是 ACL4SSR 的 root 路径 `Clash/Telegram.list`，与目录里的 `Clash/Ruleset/Telegram.list` 字面不同（二者渲染后其实是同一个 rule-provider，但识别这层等价属于 C3 的内容级分析）。反推既认不出它、又按组名建了一张用户卡片，界面上于是出现两张「📲 电报消息」——一张在灵活桶、一张在待选栏。同名卡片一起进灵活桶还会被 `dedupeGroupsByName` 静默合并。

接管的两种形态：撞上**小卡片**名就直接接管该小卡片（父卡片留在待选栏，它自己当顶层卡片，组名即它的名字）；撞上**大卡片**名则把大卡片提进灵活桶，来源挂到它下面新建的一张 `🧩 自定义来源` 用户小卡片上——大卡片自身 `sources` 恒空（4.2）。

顺带定下另一条口径：**正文只提到某张多来源卡片里的一部分来源时，以正文为准**，另几条不再从目录补回。补回会让再序列化多出用户从未写过的规则行。完全没被正文提到的卡片不受影响，仍保留目录里的全部来源（附录 C.2）。

### 4.7 新建模板的初始正文

`RuleTemplateManager.vue` 给新模板的初始正文 = `serializeState(createDefaultState(), { includeHeader: false })`，即**默认状态的骨架、不带注释头**：局域网直连 + `[]FINAL` + 基础组与地区组，一张规则卡片都不铺。

不带头是因为那一行 base64 会占满文本框第一行且不可读。作为交换，`parseIniToState()` 多一条快路径 `isUntouchedSkeleton()`：正文与默认骨架逐行相同时直接给默认状态，不走反推——反推出来的东西一模一样，却会挂一条"结果可能有损"的警告条，对刚建模板的用户是纯噪音。

旧版这里手写了一份含电报 / AI / 流媒体的样例。它同时踩了两个坑：URL 与内置目录不完全一致（4.6 的同名卡片），以及"替用户决定了分流方案"。已整份去掉。

---

## 五、生成契约

### 5.1 输出顺序

`ruleset=` 的行序即最终规则优先级。固定输出六段：

```
1. 🔧 前置修正          局域网直连开关 + 该段卡片，全部指向字面量 DIRECT
2. 🧩 灵活桶            每张顶层卡片一个独立策略组
3. 🛑 广告拦截          全部指向该组
4. 🌍 国外代理          全部指向该组
5. 🎯 全球直连          全部指向该组
6. []FINAL              恒定末位，指向 🐟 漏网之鱼
```

`[]GEOIP,CN` 不是独立一段。它是 `🏠 国内直连` 下的一张小卡片（4.3），落进 `🎯 全球直连` 时 `order: 999`，因此自然排在该组所有域名规则之后、`[]FINAL` 之前，位置约定不变。

同一桶内**用户卡片恒排在内置卡片之前**（`origin === 'user'` 优先），其次按 `order`，最后按数组下标保持稳定。大卡片内多个小卡片按其 `order` 展开。

#### 5.1.1 「🔧 前置修正」段：为什么它取代了「⬆️ 优先匹配」

固定顺序"`🌍 国外代理` → `🎯 全球直连`"本身会制造问题：`Google.list` 含 `DOMAIN-KEYWORD,google`，会吞掉 `🎯 全球直连` 里 `GoogleCN.list` 的 `google.cn`。这正是 ACL4SSR 必须把 GoogleCN 置顶的原因（附录 A）。

本文初稿为此设计了一个「⬆️ 优先匹配」段，卡片各自带一个目标下拉。**该段已删除**，理由有两条：

1. **它与灵活桶定位重合**。两段都是"位于承接组之前、用户可放任意卡片"，区别仅在优先匹配段不建策略组。而"不建策略组"这件事本身没有独立价值——真正需要的只是"排在最前"。
2. **目标下拉与"出口由策略组决定"的原则冲突**（5.2.1）。既然卡片上不该有出口，这一段就失去了它唯一的独有能力。

现在由「🔧 前置修正」段接管：它是右栏第一段、接受拖放，段内规则**全部指向字面量 `DIRECT`**，语义就是"最高优先级且强制直连"。GoogleCN / SteamCN / 误杀捞回作为 `✅ 直连例外` 大卡片的小卡片，推荐落点就在这里。

**为什么用字面量 `DIRECT` 而不是 `🎯 全球直连` 组**：后者会让"前置修正非空"反过来强制生成 `🎯 全球直连` 组，把两段耦合在一起——用户可能只想要前置修正而完全不用直连桶。代价是这批规则在客户端里不能临时切代理，但前置修正的语义本就是"最高优先级直连"，可接受。

完整的内容级重叠分析仍留在阶段 C。

### 5.2 策略组装配

策略组只有这些，**顺序即客户端列表顺序**：

| 策略组 | 生成条件 | 类型 | 成员 / 过滤器 |
|---|---|---|---|
| `🚀 节点选择` | **恒定** | select | 已启用可选基础组 + 已勾选地区组 + `DIRECT` |
| `☑️ 手动切换` | 勾选 | select | `.*` |
| `♻️ 自动选择` | 勾选 | url-test | `.*` + testUrl + interval,,tolerance |
| `🔯 故障转移` | 勾选 | fallback | `.*` + testUrl + interval,,tolerance |
| 地区组 | 逐个勾选 | url-test | `(港|HK|Hong ?Kong|HKG)` + 测速参数 |
| `🌐 其他地区` | 勾选且至少一个具名地区 | url-test | `^(?!.*(<已启用地区 pattern 合并>)).*$` + 测速参数 |
| 灵活桶各组 | **每张顶层卡片一组** | select | 桶标准成员 |
| `🛑 广告拦截` | 该桶非空 | select | `REJECT` → `DIRECT` → `🚀 节点选择` |
| `🌍 国外代理` | 该桶非空 | select | 桶标准成员 |
| `🎯 全球直连` | 该桶非空 | select | `DIRECT` 提到首位（5.2.1） |
| `🐟 漏网之鱼` | **恒定** | select | 桶标准成员 |

**桶标准成员** = `🚀 节点选择` + 已勾选的 `☑️ 手动切换` / `♻️ 自动选择` / `🔯 故障转移` + `DIRECT`。

地区组数量由勾选决定：勾了香港与美国就产生香港组、美国组，再加 `🌐 其他地区`（该组命中 0 个节点时被 `pruneEmptyGroups` 自动剪除，不会出现在客户端里）。

灵活桶组数量由放入的顶层卡片决定：放入 `🕹️ Steam 平台` 与一张用户自建的 `百度`，就生成 `🕹️ Steam 平台` 与 `百度` 两个组。

策略组是否生成由基础配置与卡片归属**派生**，不维护独立 `enabled` 真相源（旧 R4）。`effectiveSources()` 为空的顶层卡片整卡跳过——否则会输出一个有成员但无任何规则指向的孤立组（`pruneEmptyGroups` 只剪 0 成员组，剪不掉它）。

#### 5.2.1 出口由策略组决定，不在卡片上写死

**卡片上没有出口目标字段。** 这是实现期最重要的一处修正。

初稿让灵活桶卡片带一个"出口目标"下拉（如 `📹 油管视频 → 🇯🇵 日本节点`），把该地区组置于成员首位。这做法把**客户端该做的选择提前写死在生成时**：策略组成员里本来就有 `🚀 节点选择` 与 `DIRECT`，用户在客户端里点几下就能改，没必要在生成器里固化。

因此四类承接组（灵活桶各组 / `🌍 国外代理` / `🎯 全球直连` / `🐟 漏网之鱼`）**成员完全一致**，都是「桶标准成员」：`🚀 节点选择` 打头，其后是用户实际勾选了的可选基础组，末位 `DIRECT`。

连带后果，已确认接受：**"AI 服务固定走日本"这个场景不再有生成时的表达方式**，只能在客户端里手选。作为交换，配置界面少了一整类需要理解的概念，且不会出现"地区组被取消勾选后卡片出口悬空"这类需要回落逻辑的状态。

**`🎯 全球直连` 把 `DIRECT` 提到首位（唯一排列例外）。** select 组的默认选中项是第一个成员。若照抄标准顺序，`🚀 节点选择` 在首位，该组承接的全部规则**默认走代理**，"全球直连"的语义就反了。因此成员集合不变，排列改为 `DIRECT` → `🚀 节点选择` → 已勾选基础组：默认直连，同时保留在客户端临时切代理的入口。

**`🛑 广告拦截` 是唯一不用桶标准成员的承接组。** 成员为 `REJECT` → `DIRECT` → `🚀 节点选择`：`REJECT` 置首因此默认拦截，其后两项是放行入口，让用户可在客户端把误杀的请求临时改走直连或代理。前两项与 `builtin-template-registry.js:51` 的既有形态一致，`🚀 节点选择` 是本方案的补充。

**该组同样由桶是否非空派生**：广告桶为空时整个策略组与相关规则都不输出，不会在客户端里留一个空壳组。

**地区组不进桶成员。** 地区通常有 6–7 个，逐桶枚举会让每个组的选项列表膨胀到十几项。用户想让某个服务走某国，在客户端里点该组 → 选 `🚀 节点选择` → 选地区即可。

`🐟 漏网之鱼` **是兜底段，不是基础策略组**。它和其它承接组同形，唯一区别是它承接 `[]FINAL`。此前版本让它枚举全部基础组与地区组，与 `🚀 节点选择` 的成员集完全重合，是纯冗余。

右栏六段里有四段各自对应策略组：灵活桶（每张顶层卡片一组）、`🛑 广告拦截`、`🌍 国外代理`、`🎯 全球直连`；`🔧 前置修正` 不产生组（指向字面量 `DIRECT`），`🐟 漏网之鱼` 恒定产生组但不接受拖放。

#### 5.2.2 不设只含 `DIRECT` 的基础组

曾另外考虑加一个只含 `DIRECT` 的强制基础组，让各组成员统一写 `[]🎯 全球直连` 取代 `[]DIRECT`，使客户端界面上的选项全是中文。**该做法放弃。**

六个渲染器从 url-test / fallback / load-balance 组的成员里剔除的是**字面量** `DIRECT` / `REJECT` / `REJECT-DROP` / `PASS`（`render-clash.js:13-20`、`render-surge.js:137`、`render-loon.js:153`、`render-quanx.js:157`、`render-singbox.js:245`），剔不掉一个组名。它一旦出现在 url-test 组里，测速会把直连组当候选线路、延迟最低恒定胜出，静默变成全量直连。为纯显示收益引入一类静默故障不划算。

因此各组成员里的直连一律写字面量 `DIRECT`，交给渲染器既有的剔除逻辑兜底。

#### 5.2.3 无可选基础组时的降级

`autoSelect` / `manualSelect` / `fallback` / `regions` 全部未启用时，`🚀 节点选择` 没有任何可引用的下级组。此时它降级为直接容纳全部节点：成员为过滤器 `.*` 加 `[]DIRECT`。

#### 5.2.4 策略组输出顺序

组的输出顺序即客户端界面上的显示顺序，固定为：

```
1. 🚀 节点选择          恒定
2. ☑️ 手动切换
3. ♻️ 自动选择
4. 🔯 故障转移
5. 地区组（按预置顺序）→ 🌐 其他地区
6. 灵活桶各顶层卡片形成的组
7. 🛑 广告拦截
8. 🌍 国外代理
9. 🎯 全球直连
10. 🐟 漏网之鱼        恒定
```

基础组全部排在最前，承接组在后，兜底段末位。注意这与 5.1 的**规则**顺序是两件独立的事：规则顺序决定匹配优先级，组顺序只决定客户端列表的排列。

### 5.3 INI 输出样例

样例状态：按推荐落点铺开一部分内置卡片（`applyRecommendedBuckets` 的一个子集，非默认状态——默认状态卡片全在待选栏，只输出局域网直连与 `[]FINAL`），另加一张用户自建的 `🎮 我的游戏`（1 条远程 + 1 条内联，落在灵活桶）。AI 段按当时的三张小卡片写，现目录已细化到八张（4.2.2），此处不逐条展开。为便于阅读，下面把 `https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash` 缩写为 `$ACL`；实际输出是完整 URL。

```ini
; misub-visual-state-v1: <base64>
[custom]
ruleset=DIRECT,$ACL/LocalAreaNetwork.list
ruleset=DIRECT,$ACL/GoogleCN.list
ruleset=DIRECT,$ACL/Ruleset/SteamCN.list
ruleset=DIRECT,$ACL/UnBan.list
ruleset=🎮 我的游戏,https://example.com/game.list
ruleset=🎮 我的游戏,[]DOMAIN-SUFFIX,battle.net
ruleset=🤖 AI 服务,$ACL/Ruleset/OpenAi.list
ruleset=🤖 AI 服务,$ACL/Ruleset/Claude.list
ruleset=🤖 AI 服务,[]DOMAIN-SUFFIX,grok.com
ruleset=🤖 AI 服务,[]DOMAIN-SUFFIX,x.ai
ruleset=🤖 AI 服务,[]DOMAIN-SUFFIX,gemini.google.com
ruleset=🎬 流媒体,$ACL/Ruleset/YouTube.list
ruleset=🎬 流媒体,$ACL/Ruleset/Netflix.list
ruleset=🛑 广告拦截,$ACL/BanAD.list
ruleset=🛑 广告拦截,$ACL/BanProgramAD.list
ruleset=🌍 国外代理,$ACL/Ruleset/Telegram.list
ruleset=🌍 国外代理,$ACL/Ruleset/Google.list
ruleset=🎯 全球直连,$ACL/ChinaDomain.list
ruleset=🎯 全球直连,$ACL/ChinaMedia.list
ruleset=🎯 全球直连,$ACL/Download.list
ruleset=🎯 全球直连,$ACL/ChinaCompanyIp.list
ruleset=🎯 全球直连,[]GEOIP,CN,no-resolve
ruleset=🐟 漏网之鱼,[]FINAL

custom_proxy_group=🚀 节点选择`select`[]☑️ 手动切换`[]♻️ 自动选择`[]🇭🇰 香港节点`[]🇯🇵 日本节点`[]🇸🇬 狮城节点`[]🇺🇸 美国节点`[]🌐 其他地区`[]DIRECT
custom_proxy_group=☑️ 手动切换`select`.*
custom_proxy_group=♻️ 自动选择`url-test`.*`http://www.gstatic.com/generate_204`300,,50
custom_proxy_group=🇭🇰 香港节点`url-test`(港|HK|Hong ?Kong|HKG)`http://www.gstatic.com/generate_204`300,,50
custom_proxy_group=🇯🇵 日本节点`url-test`(日本|JP|Japan|Tokyo|Osaka)`http://www.gstatic.com/generate_204`300,,50
custom_proxy_group=🇸🇬 狮城节点`url-test`(新加坡|狮城|SG|Singapore)`http://www.gstatic.com/generate_204`300,,50
custom_proxy_group=🇺🇸 美国节点`url-test`(美|US|United ?States|America|Los ?Angeles|San ?Jose)`http://www.gstatic.com/generate_204`300,,50
custom_proxy_group=🌐 其他地区`url-test`^(?!.*(港|HK|Hong ?Kong|HKG|日本|JP|Japan|Tokyo|Osaka|新加坡|狮城|SG|Singapore|美|US|United ?States|America|Los ?Angeles|San ?Jose)).*$`http://www.gstatic.com/generate_204`300,,50
custom_proxy_group=🎮 我的游戏`select`[]🚀 节点选择`[]☑️ 手动切换`[]♻️ 自动选择`[]DIRECT
custom_proxy_group=🤖 AI 服务`select`[]🚀 节点选择`[]☑️ 手动切换`[]♻️ 自动选择`[]DIRECT
custom_proxy_group=🎬 流媒体`select`[]🚀 节点选择`[]☑️ 手动切换`[]♻️ 自动选择`[]DIRECT
custom_proxy_group=🛑 广告拦截`select`[]REJECT`[]DIRECT`[]🚀 节点选择
custom_proxy_group=🌍 国外代理`select`[]🚀 节点选择`[]☑️ 手动切换`[]♻️ 自动选择`[]DIRECT
custom_proxy_group=🎯 全球直连`select`[]DIRECT`[]🚀 节点选择`[]☑️ 手动切换`[]♻️ 自动选择
custom_proxy_group=🐟 漏网之鱼`select`[]🚀 节点选择`[]☑️ 手动切换`[]♻️ 自动选择`[]DIRECT

enable_rule_generator=true
overwrite_original_rules=true
```

15 个策略组，23 条规则。

**规则段**对照 5.1 的六段：`LocalAreaNetwork` 是局域网直连开关，`GoogleCN` / `SteamCN` / `UnBan` 是 `✅ 直连例外` 大卡片的三张小卡片——四行全部指向字面量 `DIRECT`；`🎮 我的游戏`（用户）排在 `🤖 AI 服务`、`🎬 流媒体`（内置）之前；`BanAD` 系列在 `🛑 广告拦截`；`Telegram` 与 `Google` 在 `🌍 国外代理`；`🏠 国内直连` 的五张小卡片在 `🎯 全球直连`，`ChinaCompanyIp`（`order: 998`）与 `GEOIP,CN`（`order: 999`）钉在段尾。

**组段**对照 5.2.4 的十段：基础组两个（未勾选故障转移）、地区组五个、灵活桶三组、广告拦截、国外代理、全球直连、漏网之鱼。

`🤖 AI 服务` 演示大卡片的多来源合一：3 张小卡片的 5 条来源合成**一个**策略组，而不是三个或五个。`render-clash.js` 会为两个 URL 各建一个 `rule-provider`，输出两条 `RULE-SET` 加三条 `DOMAIN-SUFFIX`，全部指向 `🤖 AI 服务`。

三个灵活桶组与 `🌍 国外代理`、`🐟 漏网之鱼` 的成员**逐字相同**（5.2.1：出口不在卡片上写死）。`🎯 全球直连` 只是把 `DIRECT` 提到首位。`🛑 广告拦截` 是唯一另一套成员。

---

## 六、校验

宿主已经解决了 0 命中降级与悬空引用（2.2），旧文档 17 条问题里只剩一条 🔴 仍然成立。

### 6.1 分隔符注入（旧 R1，唯一仍成立的高危项）

MiSub 的解析器与 subconverter 同样按分隔符切分，风险等价：

| 字符 | 破坏点 | 出处 |
|---|---|---|
| `,` | `ruleset=` 的组名/规则边界 | `ini-template-parser.js:64` |
| 反引号 | `custom_proxy_group=` 的字段边界 | `ini-template-parser.js:97` |
| `=` | 被误判为 option 键值对 | `ini-template-parser.js:107-110, 133` |
| 换行 | ini 行边界 | `ini-template-parser.js:4` |

**处理**：所有用户可编辑字符串（地区组名、卡片名、内联规则值）在序列化前逐一拒绝上述字符，UI 内联报错，不做静默转义。生成前再做一次全量扫描。

注意内联来源的 `value` 只存**规则值**，类型由 `ruleType` 单独承载（4.2）。因此 `,` 可以无条件拒绝——用户永远不需要在值里输入逗号，`DOMAIN-SUFFIX,claude.ai` 这个逗号是序列化时拼出来的，不是用户输入的。

`!!` 前缀是 subconverter `applyMatcher` 的指令语法，MiSub 无对应实现，不构成风险，但仍建议一并拒绝以保持模板在其它转换器下的可移植性。

### 6.2 其它生成前校验

- **卡片名唯一性**：进入灵活桶的**顶层卡片**名不得与地区组、基础组（`🚀 节点选择` / `☑️ 手动切换` / `♻️ 自动选择` / `🔯 故障转移`）、承接组（`🛑 广告拦截` / `🌍 国外代理` / `🎯 全球直连` / `🐟 漏网之鱼`）、其它灵活桶顶层卡片重名，也不得与 `DIRECT` / `REJECT` 等保留字冲突。`dedupeGroupsByName`（`template-processor.js:102-137`）会**静默合并**同名组并合并其成员与 options，语义被改变而用户无感。判定必须走 `effectiveSources()` 而非 `card.sources`——大卡片自身 sources 恒空，否则会漏检
- 正则合法性：用 `new RegExp(pattern, 'i')` 预演，口径与 `resolveGroupFilters` 完全一致；同时拒绝 `(?i)` 与多层并列括号（3.1）
- **URL 字面重复 / 跨桶来源遮蔽**：底层是同一件事——同一个来源出现在两张**顶层生效**卡片上时，按 5.1 顺序先出现者生效、后者完全失效。命中即双方标红、顶部出现冲突条，未处理则拦截生成。同一卡片内重复来源直接静默去重
- **自填来源撞上内置目录**：只给 `warn`。它与上一条的区别是"即使两张卡片不同时生效也提示"，避免用户重复配置
- **GEOIP 卡片位置**：全部来源都是 IP 类型（`GEOIP` / `IP-CIDR` / `IP-CIDR6`）的卡片落在 `🎯 全球直连` 以外的任何段时给 `warn`，说明它会遮蔽其后所有域名规则（4.3）
- **空集合**：大卡片内同桶小卡片数为 0 且自身无来源时给 `warn`（4.2）。留在待选栏的空大卡片不提示
- 来源本身的合法性：值非空、remote 必须 `http(s)://` 开头、inline 的 `ruleType` 必须在支持列表内
- `[]FINAL` 存在且位于末位
- 至少一条实质规则（`🚀 节点选择` / `🐟 漏网之鱼` / `[]FINAL` 恒定输出，只需检查是否有卡片或局域网直连开关生效）

**已删除的两项**：「优先匹配区目标有效性」与「灵活桶出口目标有效性」。出口不再绑在卡片上（5.2.1），这两类悬空状态从模型上就不存在了。反解旧模板时若带进 `target` 字段，一律忽略而非报错。

### 6.3 策略组数量软提示

多来源合成一张卡片正是抑制组数量膨胀的手段，因此 UI 需要把这个指标显式暴露出来：常驻计数器显示预计生成的策略组数，≤12 绿、13–20 黄、>20 红。

**只提示，不拦截。** MiSub 侧不存在任何策略组数量上限，按一个自定的数字硬拦截会重复旧文档 R6 的错误——那条硬拦截依据的 `max_allowed_rulesets=64` 在实测后端上根本不生效，却会无谓阻止用户。

### 6.4 不做的校验

规则内容级重叠分析（下载 `.list` 建后缀树、`DOMAIN-KEYWORD` 子串包含判定）留在阶段 C。MVP 靠「🔧 前置修正」段的默认落点覆盖最常见的一类（5.1.1）。

---

## 七、界面设计

### 7.1 入口

`RuleTemplateManager.vue` 增加「🎨 可视化编辑」按钮，打开 `RuleGeneratorModal.vue`（`Modal.vue` `size="6xl"`，`forms/Modal.vue:143` 支持）。原 textarea 保留为高级模式。

这与 `SubscriptionEditModal/RuleSection.vue:105-112` 已有的「可视化模式 / 高级模式」互切风格一致，不新增路由、不动导航。

保存时把序列化结果写回 `selectedTemplate.content`，仍由现有的 `dataStore.saveRuleTemplates()` 落盘。**生成器不直接调 API。**

### 7.2 分区结构

```
┌ 顶栏 ────────────────────────────────────────────────────────────────┐
│ 📋 基础策略组  [🚀 节点选择 🔒]                                        │
│                [☑️ 手动切换] [♻️ 自动选择] [🔯 故障转移] [📍 地区分组 ▾] │
│ 🧱 自定义规则集  [名称____]  整组提交为一张卡片，落到左栏候选区顶部       │
│   [远程▾] [_______________________________________]  [✕]             │
│   [内联▾] [DOMAIN-SUFFIX▾] [_____________________]  [✕]             │
│   [+ 规则集 URL] [+ 内联规则]                        [提交为卡片]     │
│ 💡 为什么要按国家分流？（why 文案，可折叠）                              │
└──────────────────────────────────────────────────────────────────────┘
┌ 左：待选栏 ──────────────┐ ┌ 右：策略桶 ───────────────────────────┐
│ 🔍 [搜索]                │ │ ▾ 🔧 前置修正                    (1)   │
│ ┌ 待选大卡片 ──────────┐ │ │     [✓] 局域网直连                    │
│ │ 🎬 流媒体      5  ⋮⋮ │ │ │     ┌──────────────────────────────┐  │
│ │   ┌────────────────┐ │ │ │     │ ✅ 直连例外            3  ⋮⋮ │  │
│ │   │ 🎬 HBO     ⋮⋮ │ │ │ │     │   · 🇨🇳 谷歌中国        1     │  │
│ │   │ 🍿 巴哈姆特 ⋮⋮ │ │ │ │     │   · 🎮 Steam 中国       1     │  │
│ │   └────────────────┘ │ │ │     │   · 🩹 误杀捞回         1     │  │
│ └──────────────────────┘ │ │     └──────────────────────────────┘  │
│ ┌ 🎮 游戏平台   2  ⋮⋮ ─┐ │ │ ▾ 🧩 灵活桶                      (2)   │
│ │   · 🕹️ Steam 平台   │ │ │     ┌──────────────────────────────┐  │
│ │   · 👾 Epic 平台    │ │ │     │ 🤖 AI 服务             3  ⋮⋮ │  │
│ └──────────────────────┘ │ │     │   · 🧠 OpenAI           1     │  │
│ ── 散落卡片 ──           │ │     │   · 📎 Claude           1     │  │
│  ┌────────────────────┐  │ │     │   · ✨ 其它 AI          3     │  │
│  │ 📹 油管视频     ⋮⋮ │  │ │     └──────────────────────────────┘  │
│  └────────────────────┘  │ │ ▸ 🛑 广告拦截                    (1)   │
│                          │ │ ▸ 🌍 国外代理                    (2)   │
│                          │ │ ▾ 🎯 全球直连                    (1)   │
│                          │ │     ┌──────────────────────────────┐  │
│                          │ │     │ 🏠 国内直连            5  ⋮⋮ │  │
│                          │ │     │   · 🇨🇳 国内 IP  📌 钉底  1  │  │
│                          │ │     └──────────────────────────────┘  │
│                          │ │ ▸ 🐟 漏网之鱼                    🔒    │
└──────────────────────────┘ └────────────────────────────────────────┘
┌ 📄 生成的 INI + 校验结果 ────────────────────────────────────────────┐
│ 📊 策略组 14 个（13–20 黄）· 规则集 21 条  ✓ 校验通过     [复制]      │
└──────────────────────────────────────────────────────────────────────┘
```

**顶栏**只放不可拖动的东西：基础策略组勾选、地区面板、自定义规则集构建器、why 文案。**不放"导入订阅"**——本功能是纯粹的规则生成，节点来自 MiSub 自身的订阅管理，与此处无关。

`🚀 节点选择` 显示为锁定的已勾选态，不可取消。其余三项可选，地区分组是一个展开面板、逐个地区勾选。四个承接组由卡片归属派生，不在此处勾选。

**「🧱 自定义规则集」是一个多行构建器**（4.4）：可命名，默认一行，每行可选远程/内联，提交后整组变成一张大卡片 + 每行一张小卡片，落到**左栏候选区顶部**。刻意不直接进右侧桶——用户需要先看到它、再决定放哪一段。

**左栏待选栏**按"待选大卡片 + 其待选小卡片"两层展示，父卡片已被拖走的孤立小卡片归入「散落卡片」节。搜索命中大卡片名则整节保留，否则只留命中的小卡片。

**每节默认收起**，只显示大卡片与它的小卡片数，点左侧小三角展开；搜索时自动展开命中的节，否则命中的小卡片会被收起状态藏住。初始状态下 78 张卡片全在这一栏，全展开会把左栏撑成一条无法浏览的长列表。

上面的示意图画的是**已配置好**的状态。初始状态是：右栏五个可拖放段全空（`🐟 漏网之鱼` 恒定但无可配置项），左栏 10 节全部收起。五个可拖放段因此**默认全展开**——段收起时它的 draggable 整个不渲染、拖不进去，而拖进来是唯一的填充方式。

**右栏六段**自上而下即匹配优先级（5.1）：

| 段 | 接受拖放 | 展开后 |
|---|---|---|
| 🔧 前置修正 | ✓ | 局域网直连开关 + 卡片列表 |
| 🧩 灵活桶 | ✓ | 卡片列表 + 小卡片明细 |
| 🛑 广告拦截 | ✓ | 卡片列表 + 小卡片明细 |
| 🌍 国外代理 | ✓ | 卡片列表 + 小卡片明细 |
| 🎯 全球直连 | ✓ | 卡片列表 + 小卡片明细 |
| 🐟 漏网之鱼 | ✗ | 固定说明 |

**卡片上没有任何出口下拉**（5.2.1）。大卡片展开后列出其同桶小卡片，小卡片展开后列出自身来源、可逐条移除。

**已移除的两个组件**：「⚡ 一键方案」与「🚦 流量路线说明表」。前者在出口解绑后只剩"勾选哪些地区"的作用，与地区面板重复；后者的每一行都退化成"某卡片 → 某组 → 🚀 节点选择"，信息量归零。

**拖放行为**：卡片从左栏拖入某段后，从左栏移到该段（不是销毁）。拖**大卡片**连带其当前同桶的全部小卡片；拖**小卡片**不影响大卡片位置。落位下标会重写 `card.order`，使拖拽顺序即 `ruleset=` 行序——否则卡片的视觉位置与实际匹配优先级会脱节。

**嵌套深度限定两层**：已有父卡片的小卡片不能再收子卡片，否则拖拽会出现循环嵌套。

**漏网之鱼锁定的含义**：不接受拖放，也没有可配置项。前置修正段则是可拖放的，只是额外带一个局域网直连开关。

**窄屏降级**：`vuedraggable` 在触屏上体验差，且现有 6 处用法全是单列表重排、无跨列表先例。窄屏（<1024px）下不启用拖拽，改为每张卡片一个「移到… ▾」下拉，大卡片展开后每张小卡片也各有一个，语义完全等价。

### 7.3 与参照工具的关系

从参照工具吸收一点：**内嵌 why 文案**——解释"为什么按国家分流"：IP 频繁跨国跳转会导致账号异常、内容锁定、验证频繁。面向小白用户，这类文案比功能本身更决定留存。

初稿另外吸收的「⚡ 一键方案」（旧 R10）与「🚦 流量路线说明表」（旧 R13）已在实现期移除，理由见 7.2 末段与附录 C。

三处**超出**参照工具：

- 参照工具用下拉给每个服务选组，本方案用左右双栏拖拽，右栏的垂直顺序直接可视化了匹配优先级——下拉表达不出优先级
- 参照工具一条 URL 对一个组，横跨多域名的服务被拆成多组、组数量随之膨胀；本方案的大卡片是多来源容器（4.2），"多来源 → 一组"是界面上的默认表达
- 参照工具输出**完整 YAML 文件**，需手动导入、不随订阅更新、移动端不可用；MiSub 输出**订阅链接**

---

## 八、任务清单

阶段 A、B **已全部实现**，本地验收通过。下列内容为最终落地形态，`✅` 标记已完成。

### 阶段 A：核心逻辑（纯函数，可独立验证）

- ✅ **A1** `src/utils/rule-generator/catalog.js`（526 行）
  10 张大卡片 + 68 张小卡片 + 6 个地区预置，初始 `bucket` 一律 `off`（4.2.2）。大卡片 `sources` 恒空，规则绑在小卡片上。地区 pattern 存**内层形式**、序列化时统一包一层外括号，满足 3.1 约束。含 `geoip-cn` 小卡片（`order: 999`，挂在 `🏠 国内直连` 下）。另导出 `effectiveSources()` / `childrenOf()` 两个供三处共用的口径函数（4.2.1），以及 `RECOMMENDED_BUCKETS` / `applyRecommendedBuckets()`（供后续「一键设定规则分组」，界面入口未做）。
- ✅ **A2** `src/utils/rule-generator/serialize.js`（约 360 行）
  `GeneratorState → INI`。含 `; misub-visual-state-v1:` 注释头，内置卡片经 `compactCards()` 瘦身（4.5.1）。规则按 5.1 六段顺序、组按 5.2.4 十段顺序输出。`topLevelCardsIn()` 决定哪些卡片算一个输出单元；`flexible` 建新组，`prepend` 指向字面量 `DIRECT`，其余并入各自承接组。四类承接组成员统一为「桶标准成员」，`🎯 全球直连` 把 `DIRECT` 提到首位，`🛑 广告拦截` 用 `REJECT`/`DIRECT`/`🚀 节点选择`（5.2.1）。纯函数，无副作用。
- ✅ **A3** `src/utils/rule-generator/parse.js`（约 490 行）
  `INI → GeneratorState`。三条路径：注释头（无损，`expandCards()` 与 A2 的瘦身对称，同时吃 v1 全量头）、未动过的初始骨架（直接给默认状态，4.7）、正文反推（`partial: true`）。反推口径：**未被正文提到的内置卡片保留目录原始 sources**、只留在待选栏；被提到的卡片以正文为准重建来源；组名撞上内置卡片名时接管那张卡片而不另建同名卡片（4.6）。另检测"注释头与正文漂移"，返回 `drifted: true`。
- ✅ **A4** `src/utils/rule-generator/dedupe.js`（约 200 行）
  URL 归一化与字面比对，返回冲突对；`removeSourceFromCard()` 支持"目标是大卡片但来源在小卡片上"的降级查找（4.4）。两种处理动作作为纯函数暴露。
- ✅ **A5** `src/utils/rule-generator/validate.js`（约 430 行）
  6.1–6.3 全部校验项，返回结构化 `{ level, field, message }` 列表。`level` 区分 `error`（拦截生成）与 `warn`（仅提示）。判定一律走 `effectiveSources()`。
- ✅ **A6** 测试（116 个用例）
  - `rule-generator-serialize.test.js`（15）— 默认状态只输出兜底、按推荐落点铺开后的段序 golden、大卡片多来源合一、小卡片单独拖出、空集合、承接组只生成一组、前置修正指向 DIRECT
  - `rule-generator-roundtrip.test.js`（17）— state → INI → state 幂等、注释头瘦身与 v1 兼容、初始骨架快路径、正文反推等价、嵌套关系保持、**未提到的小卡片保留来源**、漂移检测，外加 4 条「反推不撞出同名卡片」（4.6）
  - `rule-generator-dedupe.test.js`（18）— 单条/多条撞车、来源粒度去重、归一化边界、入参不被改动
  - `rule-generator-validate.test.js`（30）— 注入字符、`(?i)`、多层括号、重名、跨桶遮蔽、空集合、target 残留被忽略、默认与推荐状态的策略组计数
  - `rule-generator-render-matrix.test.js`（16）— 生成的 INI 过六个渲染器，断言无悬空引用、`MATCH`/`FINAL` 末位、地区组存在与 0 命中被剪除、**一张大卡片只产出 1 个策略组与 N 条规则**（条数按状态算，不写死目录条目）、桶组成员不含地区组、`🎯 全球直连` 首位为 `DIRECT`、`🛑 广告拦截` 三成员。写法对齐现有 `builtin-conversion-matrix.test.js`

### 阶段 B：界面

- ✅ **B1** `src/components/modals/RuleGeneratorModal.vue` — 主容器（`Modal.vue` `size="6xl"`）、`GeneratorState` 管理、拖放事件收口、大卡片连带小卡片的改桶逻辑
- ✅ **B2** `src/components/modals/RuleGenerator/` 子组件
  - `GeneratorTopBar.vue` — 基础策略组勾选 + 地区面板 + 自定义规则集多行构建器 + why 文案
  - `CardPalette.vue` — 左栏待选栏（两层嵌套、搜索、散落卡片节、每节可折叠且默认收起）
  - `BucketPanel.vue` — 右栏六段容器，负责段折叠与拖放接收
  - `RuleCardItem.vue` — 卡片本体，大/小卡片共用，无出口下拉
  - `DedupeConflictBar.vue` — 撞车标红与"保留我的"动作
  - `IniPreview.vue` — INI 预览 + 校验结果 + 策略组计数器
- ✅ **B3** 跨列表拖拽接线：左栏与右栏各段共享 `vuedraggable` 的 `group: 'rule-cards'`；窄屏改「移到… ▾」下拉（7.2）
- ✅ **B4** `RuleTemplateManager.vue` 顶部操作栏加「🎨 可视化编辑」入口按钮与回写逻辑；新模板的初始正文改为生成器骨架（4.7）
- ✅ **B5** i18n 键补进 `src/i18n/messages.js`（61 键中英双语，对齐现有 `settings.ruleTemplate*` 命名）
- ✅ **B6** 组件测试 `rule-generator-modal.test.js`（20）— 六段可见顺序与输出行序一致、apply 回传而非落盘、漂移警告、大/小卡片拖动语义、自定义规则集落候选区、AD 角标与撞车标红区分，外加 3 条待选栏折叠与搜索

### 阶段 C：后续增强（不进 MVP）

- ✅ **C0** 内置目录的分组粒度重做 —— 已完成，见 4.2.2 与附录 D
- **C6** 「⚡ 一键设定规则分组」的界面入口（第二轮验收明确要求"现在不实现"）。纯函数内核 `applyRecommendedBuckets()` 与策展数据 `RECOMMENDED_BUCKETS` 已就位，缺的只是顶栏一个按钮 + 一次确认（它会覆盖用户当前的桶归属）
- **C1** 地区组命中数预览——复用现有节点预览接口，实现旧文档 Step 1 的 0 命中告警
- **C2** 生成后自查——同源 fetch 自己的订阅链接，`js-yaml` 解析做结构校验（旧 R11）
- **C3** 规则内容级重叠分析（旧 R5 / 6.4），含 `DOMAIN-KEYWORD` 子串包含判定与"生成例外规则置顶"第三选项
- **C4** 多规则源切换（blackmatrix7 / Loyalsoldier）。注意换源前需核实各源的规则类型分布，非基础类型在部分渲染路径下会被静默丢弃
- **C5** 拖拽手感优化。已验收确认"功能上没问题但手感有点怪"，暂不处理

---

## 九、验收标准

阶段 A + B 与 C0 已全部满足，`npm run test:run` 116 文件 / 674 用例全绿，`npm run build` 通过。

1. ✅ 用户不接触任何 INI 语法即可完成一次完整分流配置并保存为 `custom:` 模板
2. ✅ 生成的模板经六个目标格式渲染均无悬空策略组引用
3. ✅ `MATCH` / `FINAL` 恒定存在且位于规则末位
4. ✅ 卡片名与规则值中的 `,`、反引号、`=`、换行被拦截，不产生残废配置
5. ✅ 地区正则不含 `(?i)`、不含多层并列括号；命中 0 个节点的地区组被自动剪除而非降级为 `DIRECT`
6. ✅ `🚀 节点选择` 恒定生成且不可关闭；所有组的成员一律使用字面量 `DIRECT`，不存在只含 `DIRECT` 的基础组
7. ✅ 未启用任何可选基础组时，`🚀 节点选择` 降级为 `.*` + `DIRECT`，不产生空组
8. ✅ 灵活桶各组 / `🌍 国外代理` / `🐟 漏网之鱼` 的成员**逐字相同**，都是「桶标准成员」= `🚀 节点选择` + 已勾选的手动切换/自动选择/故障转移 + `DIRECT`；地区组不进桶成员；**卡片上没有出口目标**
9. ✅ `🎯 全球直连` 的第一个成员是 `DIRECT`（默认直连而非默认代理）；`🛑 广告拦截` 的成员是 `REJECT` / `DIRECT` / `🚀 节点选择` 且 `REJECT` 在首位；策略组输出顺序符合 5.2.4 的十段
10. ✅ 一张含 N 个来源的大卡片只产出 **1 个**策略组与 N 条规则；`effectiveSources()` 为空的顶层卡片不产出任何输出
11. ✅ 灵活桶顶层卡片名与地区组、基础组、承接组、其它灵活桶卡片、保留字重名时被拦截，不发生静默合并
12. ✅ 自填来源与内置卡片撞车时双方标红，「保留我的」正确从对方移除该来源，且在嵌套模型下不会误删大卡片
13. ✅ 右栏六段的可见顺序与生成的 `ruleset=` 行序完全一致
14. ✅ 大卡片与小卡片都可在左栏与任意可拖放段之间双向移动；拖大卡片连带同桶小卡片，拖小卡片不影响大卡片，均不发生数据丢失
15. ✅ 大卡片内同桶小卡片归零时给出「不会产出内容」提示，且不产出任何输出
16. ✅ 保存后重新打开可视化界面，状态完整还原；手改过正文的模板给出明确提示而非静默覆盖；未被正文提到的内置卡片保留其目录来源
17. ✅ `functions/` 无改动；无新增依赖；`npm run test:run` 全绿
18. ✅ 初始状态下右栏六段全空、78 张卡片全在左栏待选栏——生成器不替用户决定分流
19. ✅ 反推结果里不出现两张同名卡片；新建模板打开可视化界面不报"结果可能有损"
20. ✅ 目录的 68 条远程来源与其 clash 重写目标全部可达；注释头不随目录条数线性膨胀

**验收环境**：`scripts/dev-local.ps1` 起 `wrangler pages dev :8787` + `vite :5173` 两个进程。该脚本注释了三个必需参数的原因（`--show-interactive-dev-session false`、`--compatibility-date 2024-04-01`），以及 `vite.config.js` 代理排除列表必须含 `dashboard/` 与 `shared/` 的原因——后者是**既有 dev 配置缺陷**，与本功能无关但会让设置页整页白屏。

---

## 十、风险与缺口

| 风险 | 缓解 |
|---|---|
| A3 反解对手改过的模板必然有损 | 注释头与正文不一致时**以正文为准**，顶部显示警告条，让用户显式选择"放弃手改回到可视化"或"继续用高级模式"。不静默覆盖。 |
| 注释头随 state 增长可能变大 | 已瘦身：内置卡片只记与目录的差异（4.5.1），默认状态约 3.2 KB，128 KB 上限下余量充足 |
| 自填 URL 一律 `behavior: classical` | classical 支持全部规则类型，是安全默认值；UI 说明自填 URL 不享受 ACL4SSR 路径优化 |
| A3 反推用户卡片只能靠"组名不在内置目录中"这一启发式，可能误判手写模板 | 仅在注释头缺失时启用；误判结果一并落在 `partial: true` 的警告条里，由用户决定是否接受 |
| 「🔧 前置修正」的推荐落点只覆盖常见情况 | 明确标注为 MVP 权衡；阶段 C3 做完整重叠分析 |
| 目录中的 ACL4SSR URL 可能失效（旧 U2 / U3 未结案） | 已逐条 HEAD 探测（2026-09-01 复查，68 条来源的原始 URL 与 clash 重写目标全部 200）；卡片展开后暴露真实 URL 便于用户自查。仍需在后续版本周期性复查 |
| 卡片全在待选栏后，用户面对 78 张卡片可能不知从哪下手 | 待选栏每节默认收起、只见 10 张大卡片；顶栏有 why 文案；「一键设定规则分组」列为 C6（本轮明确不做） |
| 旧版本 MiSub 读不到 v2 注释头 | 判定版本不符后退回正文反推、挂 `partial` 警告条，比读进一堆缺字段的卡片安全；v1 头则照旧能读（4.5.1） |
| 跨列表拖拽在 MiSub 内无先例（现有 6 处 `vuedraggable` 全是单列表重排） | 标准 SortableJS 能力，不新增依赖；窄屏另有下拉降级路径（7.2）。已验收：功能正确，手感待优化（C5） |
| **`no-resolve` 被六个渲染器静默丢弃** | 已核实：`mapRule` 只输出 `type/value/policy`（`render-clash.js:110-119`），`rule.extras` 无人读取。生成器仍照写——它保留在往返状态里，也让模板在支持该语法的转换器下正确。**列为已知偏差**，测试已固定该行为。 |
| **sing-box 的兜底出口不是 `🐟 漏网之鱼`** | `render-singbox.js:379` 把 `route.final` 硬编码为 `groups[0].name`，而 `[]FINAL` 在 `:284` 只产出一条无匹配条件的退化 route 规则。本方案的组输出顺序以 `🚀 节点选择` 开头（Clash 客户端列表顺序需要它在前），因此 sing-box 的兜底实际是 `🚀 节点选择`。二者成员高度重叠，行为差异很小；要彻底对齐需改 `functions/`，超出本方案范围，**列为已知偏差**。 |

### 未结缺口

**自填 URL 与内置卡片的内容级重叠查不出来。** 4.4 的去重只做 URL 字面比对。若用户填入 blackmatrix7 的 YouTube 清单，与内置 ACL4SSR 的 YouTube 卡片内容大量重叠但 URL 不同，字面比对无从发现；要查就得下载两边内容做域名比对，即阶段 C3 的运行时版本。**已决定接受该缺口**，后续视实际使用情况再评估是否补做。

**`Clash/Ruleset/X.list` 与其重写目标 `Clash/Providers/Ruleset/X.yaml` 在去重时视为两个不同来源。** 二者确实渲染成同一个 rule-provider，但识别这层等价属于内容级分析，同样归入 C3。

---

## 附录 A：仍然有效的已核实事实

来自 `DESIGN_REVIEW.md` 的实测结论中，在本方案下仍有价值的部分：

- **`ruleset=` 行序即最终规则优先级，生成器无重排**——本方案 5.1 固定顺序的前提
- **`DOMAIN-KEYWORD` 的重叠是子串包含问题，不是集合交集**——`Google.list` 的 `DOMAIN-KEYWORD,google` 会吞掉 `google.cn`，这是 ACL4SSR 必须把 GoogleCN 置顶的真正原因，也是 5.1.1「🔧 前置修正」段的依据
- **空策略组会被填充为 `DIRECT`**——subconverter 的行为。MiSub 走的是剪除而非填充（`pruneEmptyGroups`），但这条说明了为什么"0 命中地区组"必须被处理而不能放任
- **`raw.githubusercontent.com` 返回 `Access-Control-Allow-Origin: *`**——阶段 C3 内容分析可直接在浏览器侧 fetch
- **参照工具输出完整 YAML 而非订阅链接**——其架构定位与 MiSub 不同，界面可借鉴、产品差异化仍成立
- **`GEOIP,CN` / `GEOSITE,*` 不可静态分析**——只能靠位置约定兜底：恒在所有域名规则之后、`FINAL` 之前，对应 4.3 GEOIP 卡片的 `order: 999`

以下实测数据针对 subconverter，MiSub 不使用该组件，已无参考价值，不再保留：`config=data:` 支持情况、URL-safe base64 解码表行为、PCRE2 正则能力与 `(?i)`、`max_allowed_rulesets` / `max_allowed_rules` 上限、`exclude_remarks` 生效时机、后端默认 base 模板污染、三层静默叠加、公共后端探活表、复现脚本。

## 附录 B：旧计划作废条目对照

| 旧文档条目 | 作废原因 |
|---|---|
| Step 0 后端选择器、公共后端探活 | MiSub 本地转换，无 subconverter |
| `data:text/plain;base64` 内联 remote config | 模板存 KV，`custom:<id>` 引用 |
| R3 `clash_rule_base` 缺席（原列 MVP 必修） | `render-clash.js:161-178` 自带 base config |
| URL 长度 30/40 KB 安全线 | 输出走 MiSub 自己的 token 链接 |
| R6 `max_allowed_rulesets=64` 硬拦截 | 无 subconverter，MiSub 解析器无此限制 |
| R7 后端 fan-out 拉取延迟 | `render-clash.js:130-159` 已转 `rule-providers` |
| R8 `add_emoji` / `new_name` / `insert` 行为漂移 | MiSub 有自己的 `exclude` 规则与 rename operator |
| R11 CORS 阻碍生成后校验 | 同源 |
| R14 二维码分享不可行 | MiSub 订阅链接短，已有 `QRCodeModal` |
| R15 `subUrl` 不落盘导致 UX 差 | MiSub 本来就持有订阅 |
| R17 公共后端日志记录订阅地址 | 无公共后端 |
| R2 0 命中地区组静默变 `DIRECT` | `pruneEmptyGroups` 已递归清理 |
| R4 多个独立 `enabled` 真相源 | 本方案 5.2 改为派生 |
| 仅限 Mihomo 内核（`PROJECT_PLAN_1.0` §一、§二整章） | 取消该收窄，INI 路径本就通六目标 |
| §十 隐私与安全整章 | 订阅地址不出现在任何生成物中 |
| React + Zustand 技术栈（§九） | 实际为 Vue 3 + Pinia + Tailwind 4 |
| M1 / M2 / M3 / M4 / M5 / M8 / M9 数据模型问题 | 已在 4.1 逐条处理 |
| M10 base64 padding | 无 base64 URL |
| U1 `exclude_remarks` 真实订阅下是否生效 | 不涉及 subconverter |
| U4 / U5 移动端本地覆写与超长 URL | 不涉及，MiSub 走订阅链接 |
| U6 `max_allowed_download_size` | 无 subconverter |

---

## 附录 C：实现期变更对照

本文 2.0 初稿与最终实现的全部差异，来源标注为「验收」（本地人工验收反馈）或「实现」（编码时发现的宿主事实或自身缺陷）。

### C.1 结构性变更

| 变更 | 来源 | 说明 |
|---|---|---|
| 卡片模型由单层改为**两层嵌套** | 验收 | 大卡片是集合容器（`sources` 恒空），小卡片持有规则。两者都能独立拖进任意桶，拖大卡片连带同桶小卡片。只有进灵活桶才各自成组。见 4.2 |
| **「⬆️ 优先匹配」段删除** | 验收 | 用户指出它与灵活桶定位重合。原有能力（最高优先级）由「🔧 前置修正」段接管，后者从"两个开关"改为可拖放段。见 5.1.1 |
| **出口不再绑在卡片上** | 验收 | 用户指出"决定出口的是策略组，组内含 `🚀 节点选择` 与 `DIRECT`，应让用户在客户端自选"。`RuleCard.target` 字段整个删除，四类承接组成员逐字相同。见 5.2.1 |
| 「🛑 广告拦截」补第三个成员 | 验收 | 原为 `REJECT` + `DIRECT`，加 `🚀 节点选择` 让用户可把误杀请求临时改走代理 |
| 前置修正指向字面量 `DIRECT` 而非 `🎯 全球直连` 组 | 验收 | 用户指出指向组会让"前置修正非空"反过来强制生成该组，把两段耦合 |
| 「⚡ 一键方案」与「🚦 流量路线说明表」移除 | 验收 | 出口解绑后前者只剩"勾选哪些地区"、与地区面板重复；后者每行退化成"某卡片 → 某组 → 🚀 节点选择"，信息量归零 |
| 「🔗 规则集 URL」改为「🧱 自定义规则集」多行构建器 | 验收 | 可命名、每行可选远程/内联、右侧加行按钮、提交后落**左栏候选区顶部**而非直接进右侧桶。见 4.4 |
| AD 卡片只留橙色角标 | 验收 | 原方案橙框+橙底与红色撞车标红区分度不足。现容器类与普通卡片完全一致，只差一个角标；红色归撞车独占 |
| `headModifiers.unban` 降级为卡片 | 实现 | 实测 `UnBan.list` 是广告误杀捞回表而非 CN 清单（4.1），作为不可见开关无法理解，改为 `🩹 误杀捞回` 小卡片 |
| 大卡片改名 `✅ 直连例外` | 实现 | 原拟名"CN 例外"名不副实，理由同上 |

### C.2 实现期修掉的自身缺陷

| 缺陷 | 表现 | 修法 |
|---|---|---|
| `recoverFromBody` 清空未匹配内置卡片的 `sources` | 23/29 张卡片在左栏看着正常，一拖进桶就报「没有任何来源，不会产出内容」 | 未被正文提到的内置卡片**保留目录原始 sources**，只留在 `bucket: 'off'` |
| `findHeadBoundary` 位置消歧不可靠 | 旧默认模板把 `GEOIP,CN` / `GEOSITE,CN` 放在首行，被误判进「⬆️ 优先匹配」段；`🇨🇳 国内 IP` 明明标了 `bucket: 'direct'` 却被挪走 | 随「⬆️ 优先匹配」段一起删除。反推现在只按承接组名归桶，不再需要位置启发式 |
| `removeSourceFromCard` 在嵌套模型下误删大卡片 | 冲突条目携带顶层卡片 id，但来源长在小卡片上；函数在大卡片上找不到该来源、判定 sources 清空、把大卡片整张删了，小卡片变孤儿而冲突还在 | 先在目标卡片上找，找不到再降到它的小卡片里找。见 4.4 |
| `checkFlexibleNames` 用 `card.sources` 判定 | 大卡片自身 sources 恒空，重名检查被整体跳过 | 一律走 `effectiveSources()` |
| 入口按钮嵌在两层条件里 | 没有模板或未选中模板时整个右侧编辑区不渲染，按钮看不见 | 提到顶部操作栏，与「新建模板」「保存模板」并列；没有模板时点它自动建一张 |

### C.3 顺带修掉的既有 dev 配置缺陷

**与本功能无关，但会让设置页整页白屏。** `vite.config.js` 的订阅链接反代规则按"两段式路径"匹配，排除列表缺两项：

- `dashboard/` — `/dashboard/settings` 被当成订阅链接 `/{token}/{profile}` 转给后端，后端按未知 token 返回 404。表现为"点设置页没反应、多点几次跳 404"
- `shared/` — `/shared/dns-template-validation.js` 同样被转走并 404。它被 `DnsTemplateManager.vue` 静态引入，一断就让 `SettingsView → ServiceSettings → TransformCard → DnsTemplateManager` 整条模块链失败，路由抛 `Failed to fetch dynamically imported module`，设置页渲染成空白 `<main>`

两项均已加入排除列表并注释原因。仅影响 `vite dev`；生产由 Pages 直接托管静态资源并兜 SPA fallback。

### C.4 已核实但与初稿假设不同的宿主行为

- **`no-resolve` 被静默丢弃**：六个渲染器的 `mapRule` 只输出 `type/value/policy`（`render-clash.js:110-119`），`rule.extras` 无人读取。生成器仍照写，理由见第十节
- **`^(?!...)` 会出现在 clash 输出的 `filter` 字段里**：`render-clash.js:190` 把 filters 原样写入，这是既有行为（内置预设的 `♻️ 自动选择` 同样输出 `filter: ".*"`）。查证 mihomo 用 `dlclark/regexp2` 而非 Go 标准库 RE2，**支持前瞻**；且成员已显式展开、`include-all` 未开启，该字段对成员集合不再产生影响。安全
- **ACL4SSR 目录探测结果**：`SteamCN.list` / `GoogleFCM.list` 在 `Clash/Ruleset/` 下（root 为 404）；PayPal / PrimeVideo / Copilot 不存在。**「Disney / GitHub / GameDownloadCN 不存在」这条记错了**，实际是文件名写错，见附录 D

---

## 附录 D：第二轮验收变更（2026-09-01）

三条验收反馈，加上处理它们时顺带发现的两处问题。

### D.1 卡片默认全部留在待选栏

**反馈**："我希望默认情况下所有卡片都默认在左侧待选栏，不要替用户做决定，后续会添加一键设定规则分组的功能，但是不在现在实现。"

`createDefaultState()` 里全部卡片 `bucket: 'off'`。原先写在大卡片上的默认落点、以及小卡片的 `off` 标记，改存为 `RECOMMENDED_BUCKETS` 与 `applyRecommendedBuckets()`——**策展意见留着，但不再自动生效**，等 C6 的界面入口来用。测试里凡是需要"右栏有内容"的用例都改用 `applyRecommendedBuckets()` 铺开，因此这批策展仍然被持续验证。

连带两处：新模板的初始正文改为空骨架（4.7）；右栏五个可拖放段默认全展开，否则收起的段拖不进去（7.2）。

### D.2 内置目录细化（C0）

**反馈**："子卡片分得不够细，比如 ai 智能下只有一个 openai，没有 Claude、Gemini 等。"

9 大 / 30 小 → **10 大 / 68 小**（4.2.2）。AI 从 3 张扩到 8 张（OpenAI / Claude / Gemini / Copilot / Grok·xAI / Perplexity / 其它 AI / AI 合集），其中 Copilot、Grok、Perplexity、其它 AI 用内联规则——ACL4SSR 没有对应清单。另拆出 `👨‍💻 开发与学术` 大卡片，把原先塞在一张卡片里的 Microsoft+OneDrive+Bing、BanEasyList+BanEasyPrivacy 拆开。

顺带纠正附录 C.4 的一条记录：**Disney / GitHub / GameDownload 在 ACL4SSR 里是存在的**，早先探测用错了文件名（实际是 `DisneyPlus.list` / `Github.list` / `GameDownload.list`），三者已收入目录。

新增前 68 条来源的原始 URL 与 clash 重写目标都做了 HEAD 探测，全部 200。探测口径见 4.2.2 末段——`Clash/Ruleset/` 有 `.list` 不代表 `Clash/Providers/Ruleset/` 有对应 `.yaml`。

### D.3 「规则组出现了两个电报信息」

**反馈**：界面上出现两张「📲 电报消息」。

根因不在界面，在**反推**：旧的新建模板初始正文里 `📲 电报消息` 组用的是 ACL4SSR 的 root 路径，与目录里的 `Ruleset/` 路径字面不同，反推认不出来、于是按组名另建了一张用户卡片，与目录里同名的那张并存。同一份正文里 `🤖 AI 服务` 组只写了 OpenAi 一条，因此该集合在灵活桶里只有一张小卡片——这也是 D.2 反馈里"AI 下只有一个 OpenAI"的直接来源。

三处修改，见 4.6 与 4.7：

1. 组名撞上内置卡片名时**接管那张卡片**，不另建同名卡片
2. 命中的小卡片其组名就是自己的名字时**不把父卡片拉进来改名**（否则父子同名，这是同一个 bug 的另一半，任何手写模板都可能踩到）
3. 新模板的初始正文换成空骨架，从源头上不再产生这种正文

### D.4 注释头瘦身（顺带发现）

目录扩到 78 张卡片后，全量写法的注释头达 **31 KB**——单模板 128 KB 上限的四分之一，且在高级模式的文本框里是一行不可读的巨串。改为只记与目录的差异后降到约 **3.2 KB**，`STATE_VERSION` 升到 2 并兼容 v1（4.5.1）。

### D.5 一处过时文案（顺带发现）

`ruleGenSegFlexibleHint` 还写着"可指定固定地区出口"，而出口早在附录 C.1 就从卡片上解绑了。已改为"出口在客户端里自己选"。

---

**文档版本**：2.0（第二轮验收同步稿）
**最后更新**：2026-09-01
**状态**：阶段 A + B 与 C0 已实现，`npm run test:run` 116 文件 / 674 用例全绿，`npm run build` 通过；阶段 C 余项待排期，C6（一键设定规则分组的界面入口）为下一个候选
