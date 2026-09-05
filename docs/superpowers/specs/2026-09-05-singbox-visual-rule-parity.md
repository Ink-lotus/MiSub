# sing-box 渲染器与其余五个的能力对齐（可视化规则编辑）

**状态**：待执行，**代码尚未编写**。调查与实测已完成（2026-09-05），结论与复现方法见下。

| 项 | 值 |
|---|---|
| 目标 | 本仓库 `main` |
| 建议分支名 | `fix/singbox-visual-rule-parity` |
| 改动面 | `render-singbox.js`、新增 `shared/` 一张映射表、测试；约 150–200 行 |
| 风险 | 中——三件独立修复，其中一件引入新的第三方规则源（需先确认） |
| 前置决定 | 见 §4.2「要你拍板的两点」，未定不要开工 |

**一句话**：可视化规则编辑器的产物在 sing-box 下部分静默失效，而其余五个渲染器（clash /
surge / loon / quanx / egern）都是好的。三个独立 bug，共同成因是**模板渲染路径比内置模板
路径不完整**。

---

## 一、问题

### 1.1 九种内联规则类型，sing-box 丢五种（实测）

界面上「🧱 自定义规则集 → 内联规则」的类型下拉提供 9 种
（`GeneratorTopBar.vue` 的 `INLINE_TYPES`）。把 9 种各放一条进同一张卡片，
跑六个渲染器，逐条在产物里查：

| 类型 | clash | surge | loon | quanx | egern | **sing-box** |
|---|---|---|---|---|---|---|
| DOMAIN-SUFFIX | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| DOMAIN-KEYWORD | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GEOIP | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GEOSITE | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **DOMAIN** | ✓ | ✓ | ✓ | ✓ | ✓ | **丢** |
| **IP-CIDR** | ✓ | ✓ | ✓ | ✓ | ✓ | **丢** |
| **IP-CIDR6** | ✓ | ✓ | ✓ | ✓ | ✓ | **丢** |
| **PROCESS-NAME** | ✓ | ✓ | ✓ | ✓ | ✓ | **丢** |
| **DST-PORT** | ✓ | ✓ | ✓ | ✓ | ✓ | **丢** |

成因在 `render-singbox.js:264-304` 的 `mapRuleToSingbox()`：它只认
`rule-set` / `geoip` / `geosite` / `match` / `domain-suffix` / `domain-keyword`，
其余一律 `return null`，随后被第 370 行的 `.filter(Boolean)` 吃掉。

**这是数据丢失级别的问题**：用户在界面上填了 `IP-CIDR,10.0.0.0/8`，sing-box 产物里
没有任何痕迹，也没有任何提示。三个 bug 里这一件最要紧。

对照：`builtin-rules-provider.js:433-436` 的 `translateRuleLine()` **正确处理了**
`DOMAIN` 与 `IP-CIDR`。同一个仓库里，内置模板路径比模板渲染路径完整。

#### 复现

```js
// node --input-type=module，路径按需改
import { renderSingboxFromIniTemplate } from './functions/modules/subscription/template-pipeline.js';
import { createDefaultState } from './src/utils/rule-generator/catalog.js';
import { serializeState } from './src/utils/rule-generator/serialize.js';

const state = createDefaultState();
state.cards.push({
  id: 'u1', name: 'PROBE', parentId: null, origin: 'user', bucket: 'proxy', order: -1,
  sources: [
    { id: 's1', kind: 'inline', ruleType: 'DOMAIN',       value: 'exact.example.com' },
    { id: 's2', kind: 'inline', ruleType: 'IP-CIDR',      value: '203.0.113.0/24' },
    { id: 's3', kind: 'inline', ruleType: 'PROCESS-NAME', value: 'Telegram.exe' },
    { id: 's4', kind: 'inline', ruleType: 'DST-PORT',     value: '8080' }
  ]
});
const cfg = JSON.parse(renderSingboxFromIniTemplate(serializeState(state).ini, {
  nodeList: 'trojan://p@1.1.1.1:443#HK01', fileName: 'M', targetFormat: 'singbox',
  ruleLevel: 'none', interval: 86400, managedConfigUrl: '',
  skipCertVerify: false, enableUdp: true, isMeta: true
}));
// 四条全都查不到
console.log(JSON.stringify(cfg).includes('203.0.113.0/24'));  // false
```

**注意 GEOIP 的验证要大小写不敏感**：`GEOIP,JP` 会变成 `rule_set: ['geoip-jp']`，
按字面 `JP` 去查会得到假阴性。第一次实测就踩了这个，误报 GEOIP 也丢了。

### 1.2 远程规则集的 `format` 猜错

`render-singbox.js:306` 的 `detectRuleSetFormat()`：

```js
return raw.endsWith('.srs') ? 'binary' : 'source';
```

sing-box 文档明确：`format` 必填，只能是 `source` 或 `binary`，仅当 URL 扩展名是
`json` / `srs` 时可省。而 `source` 指的是 sing-box 自己那套 JSON 结构
（`{"version":N,"rules":[…]}`），**不是** Surge 风格的 `TYPE,value` 文本清单。

我们卡片里的来源全是 `.list` / `.txt` 文本清单，于是每一条都被声明成
`format: "source"` 并指向一个非 JSON 文件。实测产物（默认状态把广告卡片放进桶）：

```json
{ "tag": "🛑 广告拦截_https://.../Clash/BanAD.list",
  "type": "remote", "format": "source",
  "url": "https://.../Clash/BanAD.list", "update_interval": "24h" }
```

命中范围：内置目录的 68 个 ACL4SSR 文件 + 局域网直连 + 两张新增的广告卡片
（anti-AD / 秋风）+ 用户自填的一切远程 URL。

对照 `render-clash.js` 为什么没事：它能**从 ACL4SSR 的路径推导**出 Provider yaml
（`toClashRuleProviderUrl()`，`:66`），并对 `.list` / `.txt` 正确加上
`format: 'text'` + `behavior: 'classical'`。sing-box 没有可推导的等价物。

### 1.3 重复的 `rule_set` tag

`buildRuleSets()`（`render-singbox.js:313`）用 `.map` 直接展开，**没有去重**。
两张不同卡片挂同一个 URL、又落在同一个桶里时，产出两条 tag 完全相同的 `rule_set`：

```
rule_set 条数: 4 | 重复 tag: ["🌍 国际代理_https://.../Ruleset/Telegram.list"]
```

`render-clash.js:130` 那边有 `ruleProviderMap` 挡着，所以只有 sing-box 有这个毛病。
sing-box 的 rule_set 按 tag 索引，重复至少是白下载两遍，**很可能直接拒绝整份配置**
—— 后半句我没有实机验证，执行时值得先在真客户端上确认一次。

触发路径不算罕见：`dedupeSourcesWithinCard()` 只在单张卡片内去重，跨卡片同 URL 由
`findSourceConflicts()` 提示但**不阻止**，用户点「保留我的」以外的选择就会留下两份。

---

## 二、成因：两条流水线的抽象层级不同

| | 内置模板生成器 | 模板渲染器 |
|---|---|---|
| 文件 | `builtin-*-generator.js` + `builtin-rules-provider.js` | `template-renderers/render-*.js` + `template-pipeline.js` |
| 何时走 | 用户选内置模板（ACL4SSR lite/std/full/relay） | 模板是 INI —— 自定义模板、**可视化生成器产物**、远程 INI |
| 规则来源 | `RULE_SETS[level]` 里的逻辑键 → `translateRuleLine(line, format)` → `REMOTE_SOURCES[key][format]` | INI 正文的 `ruleset=` 行 → `ini-template-parser.js` → 统一 model |
| 每格式各自的 URL | **有**（`REMOTE_SOURCES`，`builtin-rules-provider.js:294`） | **没有** |
| 入口签名 | `generateBuiltinSingboxConfig(nodeList, options)` | `renderSingboxFromIniTemplate(templateText, options)` |

可视化编辑走右边那套（`processor-service.js:281`），治 sing-box 的机制在左边那套。

**为什么右边套不了左边整体**：内置生成器是**固定预设生成器，不是转换器**。跟规则有关的
入参只有一个字符串 `ruleLevel: 'base'|'std'|'full'|'relay'`；规则来自硬编码的
`RULE_SETS[level]`，策略组来自 `POLICY_GROUPS[level]`（`builtin-rules-provider.js:168`）
—— 组名全是写死的常量。**没有任何入口能传进任意规则或任意策略组**，而可视化编辑器产出的
恰好就是这两样（灵活桶里每张顶层卡片一个同名组、6–7 个地区组、桶顺序即优先级）。

**为什么右边套不了左边的表**：抽象在 INI 那一步丢了。左边的输入是 `RULE-SET,ADS,…`，
`ADS` 是逻辑键可以查表；右边的输入是 `ruleset=🛑 广告拦截,https://…/BanAD.list`，
只有一个字面 URL。而 INI 写 URL 不是随意决定 —— `ruleset=` 是 subconverter 语法，
本身没有「按客户端给不同 URL」的概念，保持兼容才能让用户在高级模式手改、或粘到别处用。

**可复用的只有左边那套里的两小块**，都是纯数据/纯函数，`import` 就能用：

- `REMOTE_SOURCES`（`:294`）—— 约 50 行「逻辑规则集 → 每格式 URL」
- `getRemoteProviderDefinitions()` 第 501 行 `format: endsWith('.srs') ? 'binary' : 'source'`

所以方向是**把表搬过去，不是把渲染搬过来**。

---

## 三、范围

**只修 sing-box 渲染器的这三件事。** 其余五个渲染器一行不动，产物必须逐字节不变。

### 明确不做

| 不做 | 原因 |
|---|---|
| 让服务端读 `; misub-visual-state-v1:` 注释头（下称「接法 C」） | 那是更彻底的方案，也是补齐用户自填 URL 的唯一出路，但它要把 `catalog.js` 移进 `shared/`、改渲染入口的数据流。单独一轮做，见 §七 |
| MiSub 自建规则集转换端点 | 新路由 + SSRF 防护 + 缓存 + 流式转换，独立项目，见 §七 |
| 支持 Clash 的 `behavior: domain`（让 anti-AD 用官方 `.yaml`/`.mrs`） | 与本次无关，另有取舍 |
| 动 `builtin-*-generator.js` | 内置模板路径本来是好的，碰它只会引入回归 |
| 改 INI 的 `ruleset=` 语法 | 会破坏 subconverter 兼容与高级模式手改 |

---

## 四、实现方案

### 4.1 补全 `mapRuleToSingbox()`（bug 1.1，先做这个）

在 `render-singbox.js:264` 的 `mapRuleToSingbox()` 里补五个分支，映射到 sing-box 原生
route rule 字段。前两个可以直接照抄 `builtin-rules-provider.js:433-436`：

| 生成器类型 | sing-box 字段 |
|---|---|
| `DOMAIN` | `domain: [value]` |
| `IP-CIDR` | `ip_cidr: [value]` |
| `IP-CIDR6` | `ip_cidr: [value]`（sing-box 的 `ip_cidr` 同时吃 v4/v6，不分字段） |
| `PROCESS-NAME` | `process_name: [value]` |
| `DST-PORT` | `port: [Number(value)]`（**注意是数字数组**，字符串会被拒） |

`no-resolve` 修饰符：sing-box 没有对应字段（`rule-modifiers.js` 的白名单里本来也不含
singbox），照旧丢弃即可，不必特殊处理。

**兜底分支要改掉**。现在末尾是 `return null`，任何将来新增的类型都会静默消失。改成保留
`return null` 但在返回前记一条 `console.warn`，让下次漏类型时至少在日志里看得见。

### 4.2 远程规则集的 URL 映射（bug 1.2）

新建 `shared/singbox-ruleset-map.js`（放 `shared/` 是为了将来接法 C 换键时不用搬家；
`shared/` 已被 `functions/` 与 `src/` 双向引用，见 `shared/safe-dns.js`）：

```js
// 键 = 卡片里写的来源 URL（去掉 revision 后的规范形式）
// 值 = sing-box 用的规则集 URL（.srs → binary，.json → source）
export function toSingboxRuleSetUrl(sourceUrl) { /* … */ }
```

`buildRuleSets()` 里只改两个字段，**tag 保持从原始 `rule.value` 派生**：

```js
const singboxUrl = toSingboxRuleSetUrl(rule.value) || rule.value;
return {
  tag: sanitizeTag(`${rule.policy}_${rule.value}`),   // ← 不动
  type: 'remote',
  format: singboxUrl.endsWith('.srs') ? 'binary' : 'source',
  url: pinRemoteRuleUrl(singboxUrl),
  …
};
```

tag 不动是关键：`mapRuleToSingbox()` 与 `buildRuleSets()` 都从原始 `rule.value` 派生
tag，只改 `url`/`format` 两边就照旧对得上，不用同步改两处。

#### 内容来源：两个候选（已核实）

| | `KaringX/karing-ruleset` | `SagerNet/sing-geosite` |
|---|---|---|
| 内容 | **同一个 ACL4SSR 文件**编译成 `.srs`，语义一致 | geosite 分类，是**近似物**而非同一份规则 |
| 覆盖 | `ACL4SSR/` 目录扁平、按基名命名，171 个 `.srs`。与我们目录实际用到的 68 个 ACL4SSR 文件做差集：**一个不缺** | 分类广但对不上名，`BanAD.list` 只能换成 `geosite-category-ads-all` |
| 供应链 | **多一个第三方** | **零新依赖**——已在 `PINNED_RULE_REVISIONS`，已被 sing-box 渲染器用于 geoip/geosite |
| 格式 | 171 个 `.srs` + 25 个 `.json`（`.json` 覆盖不全我们用到的 68 个） | `.srs` |

**已决定用 karing-ruleset**，理由是可视化编辑器里用户是逐张卡片挑的，静默换成别的清单违背
他挑的意思；内置模板路径接受这个代价（`REMOTE_SOURCES.ADS` 就是 `geosite-category-ads-all`）
是因为那里本来就只承诺「广告拦截」这个粒度。

两张非 ACL4SSR 的广告卡片各有**官方** sing-box 产物，直接写死在表里，不经第三方：

| 卡片 | sing-box 用 |
|---|---|
| `ad-anti-ad` | `privacy-protection-tools/anti-AD/master/anti-ad-sing-box.srs` |
| `ad-awavenue` | `TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-Singbox.json` |

#### 要你拍板的两点（未定不要开工）

1. **多信一个第三方。** karing-ruleset 编译的是别人家的规则内容，理论上能往用户路由里塞
   任何东西。现有代码已这样依赖 ACL4SSR / blackmatrix7（都钉了 revision），加它是同性质的
   决定。**务必把它加进 `builtin-rules-provider.js:278` 的 `PINNED_RULE_REVISIONS`**，把风险
   压成「某个时间点的快照」。
2. **`.srs` 的客户端版本地板。** `.srs` 是版本化二进制（v1=sing-box 1.8 / v2=1.10 /
   v3=1.11…），用哪版编译就要求客户端不低于它。要么统一 `.srs` 接受地板，要么「有 `.json`
   用 `.json`、其余退 `.srs`」混着来（代码稍多，兼容面更宽）。

### 4.3 `rule_set` 去重（bug 1.3）

照 `render-clash.js:130` 的 `ruleProviderMap` 做法，在 `buildRuleSets()` 里用一个 `Set`
按 tag 去重。注意 tag 里含 policy，所以「同 URL 不同桶」仍然是两条独立 rule_set，
那是对的，不能一起去掉。

---

## 五、测试

`tests/unit/rule-generator-render-matrix.test.js` 已有 23 个用例覆盖六个渲染器的结构，
新增用例挂在那里。三件修复各自要有钉子：

| 用例 | 钉住什么 |
|---|---|
| 九种内联类型在六个渲染器下全部存活 | §1.1。**直接把实测矩阵变成断言**——这是最有价值的一个，它同时防住五个渲染器的回归 |
| `DST-PORT` 在 sing-box 下是数字数组不是字符串 | 容易写错且客户端才报错 |
| 远程 `.list` 卡片在 sing-box 下渲染成 `.srs` + `format: binary` | §1.2 |
| 两张卡片同 URL 同桶时 `rule_set` tag 不重复；同 URL 不同桶时仍是两条 | §1.3 两个方向 |
| 其余五个渲染器的产物在改动前后逐字节相同 | 范围约束。可以先跑一次存基线字符串 |
| 表里没有的 URL（用户自填）走原样透传，不抛错 | 降级路径 |

GEOIP 的断言记得大小写不敏感，理由见 §1.1。

---

## 六、验收：修完之后成立到什么程度

分三层写，因为确定性不一样。**不要把这三层混着说成「六平台通用」。**

**层 1 — 配置形状正确。** 修完即成立，单测可验证。

**层 2 — 客户端能否消费远程清单。** clash 已实测（`behavior: classical` + `format: text`）。
其余四个各有对应入口，消费的都是 Surge 风格 `TYPE,value` 清单，而 ACL4SSR 的 `.list`
正是那个格式，所以把握较大 —— 但**没有实机验证过**：

| 格式 | 入口 | 位置 |
|---|---|---|
| surge | `RULE-SET,<url>,<policy>` | `render-surge.js:297` |
| loon | `[Remote Rule]` 段 `<url>, policy=…, enabled=true` | `render-loon.js:294` |
| quanx | `filter_remote, <url>, tag=…, force-policy=…` | `render-quanx.js:206` |
| egern | `rule_set: { match: <url>, policy }` | `render-egern.js:279` |

**执行时请在真客户端上各过一遍**，尤其 quanx 与 egern。PR/提交信息里不要写「六平台验证通过」
除非真跑过。

**层 3 — 修完之后的可用范围。**

| 场景 | 结果 |
|---|---|
| 只用内置目录卡片的方案 | 六平台可用 |
| 自建**内联规则**卡片 | 六平台可用（§4.1 修完后） |
| 自建**远程 URL** 卡片 | **sing-box 下仍然不生效**，其余五个可用 |

最后一格是本次修不掉的。所以严格讲「一种可视化方式六平台通用」只达成大部分，
而「自定义规则集」恰好是可视化编辑器最有价值的功能之一。

**因此本次必须附带一条可见提示**：在 `src/utils/rule-generator/validate.js` 里，对
`origin === 'user'` 且含远程来源的卡片加一条 `warn`（「这条来源在 sing-box 下不生效」）。
把静默失效变成明说的限制，几行的事，但它是本次唯一让用户知道边界的手段。

---

## 七、遗留：怎么补上最后一格

两条路，都独立于本次：

**接法 C：服务端读注释头。** INI 里已经有一条无损的 MiSub 专用旁路 ——
`; misub-visual-state-v1:` 那行 base64 是完整卡片状态。现在只有前端
`src/utils/rule-generator/parse.js` 在读，服务端 `ini-template-parser.js:78` 把 `;` 开头的
行整行跳过。服务端也读它的话，拿到的是**卡片身份**（`ad-basic`、`ai-openai`…）而不只是
URL，于是每个上游都能用自己官方发布的 sing-box 产物，不需要第三方编译源、也不换内容。
本次那张表届时只需把键从 URL 换成卡片 id，不用搬家 —— 这就是它放 `shared/` 的原因。
代价：`catalog.js` 要能被 `functions/` import（`shared/` 已有先例）。

**MiSub 自建转换端点。** 一条路由拉上游文本清单 → 转成 sing-box source JSON → 缓存 → 返回。
唯一能覆盖任意用户 URL 的方案。工作量在周边不在转换：SSRF（必须白名单主机或 HMAC 签名 URL，
否则是开放代理）、缓存（anti-AD 那类 3.35 MB 清单不能每客户端每天回源；可抄
`github-proxy-handler.js` 的 KV + timestamp 或 `cf: { cacheTtl, cacheEverything }`）、
CPU/内存（10 万行必须走 `TransformStream` 流式，不能整块 buffer 再 `JSON.stringify`）。
这条路通了之后顺带能解决 Clash 侧 `behavior` 硬编码 `classical` 的问题。

---

## 八、操作步骤

1. 先确认 §4.2 那两个待拍板项，未定不要动手
2. `git switch -c fix/singbox-visual-rule-parity`
3. 按 §4.1 → §4.3 顺序做。4.1 独立且收益最大，先让它单独绿
4. 每一步按 §五 补对应用例；改动前先存五个渲染器的产物基线
5. `npx vitest run` 全绿 + `npm run build` 通过
6. 层 2 的真客户端验证
7. 停下报告，**不要自行 commit / push / 合并**

## 九、注意事项

- **`.filter(Boolean)` 是这次的元凶模式**：`render-singbox.js:370` 把 `mapRuleToSingbox()`
  返回的 `null` 静默吃掉。同文件 `:364` 的那个作用在出站上，与规则无关，别一起改
- 五个渲染器的产物必须逐字节不变。`render-loon.js:283` 与 `render-quanx.js:180` 对
  `RULE-SET` 都是 `return null` 然后走各自的 remote 段，别以为那也是 bug
- `pinRemoteRuleUrl()`（`builtin-rules-provider.js:268`）只对表里的仓库生效，非表内 URL
  原样返回 —— 加了 karing-ruleset 就会被钉版本，这是想要的；anti-AD / 秋风刻意不钉，
  它们每日重建
- **起点状态**：本文的 `functions/` 行号基于提交 `6ee94fe`（回收站那一笔），那次改动没有碰
  `functions/`，所以行号对 `main` 直接有效。§4.2 提到的两张广告卡片（`ad-anti-ad`、
  `ad-awavenue`）在 `ee39020` 已入库，从 `main` 起步即可直接引用





