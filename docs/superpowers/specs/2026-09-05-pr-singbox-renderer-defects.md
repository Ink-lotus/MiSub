# sing-box 渲染器既有缺陷修复（可提上游）

**状态**（2026-09-07）：五项路由修复已在本地 `test` 分支实现，本地提交已获用户授权；全量 977 个单测与构建通过。
**最低版本已按用户最新决定统一为 sing-box >=1.12，沿用既有 DNS 格式；尚未完成真实客户端验收**，见 §三、§九。
原始调查基于 2026-09-05；下文保留历史复现，并补充实现时的纠正。

| 项 | 值 |
|---|---|
| 目标 | 本地 `test` 分支验证；上游与 `main` 的集成由用户另行决定 |
| 当前分支 | `test`（用户指定） |
| 改动面 | 两条 sing-box 路径、专用策略清理 helper、INI 保留策略参数、三份测试；清单见实施计划 |
| 风险 | L3：影响路由拒绝语义与客户端兼容，按 red-green 验证 |
| 前置决定 | 用户已将最低版本统一为 >=1.12，与既有 DNS 格式一致，见 §三 |
| 依赖 | 无。不依赖可视化编辑器，不引入任何新依赖，不新增远程来源 |

**一句话**：sing-box 渲染器有五处缺陷，**全是上游原文**，与可视化编辑器无关。其中一处让产物在
sing-box 1.13 及以上**整份加载不了**，内置模板路径同样中招。

**为什么单独一轮**：这五件是纯代码修复，零新依赖，同仓库内都有正确写法可对照，适合提上游。
远程规则集的格式问题要新增托管来源、是可视化编辑器特有的，走另一轮
（`2026-09-05-singbox-visual-rule-parity.md`）。那一轮以本轮落地为前置。

**与上游的关系（已核实）**：`upstream` remote 指 `imzyb/MiSub`，本地缓存 `1008b7c`（2026-09-02）。
`git diff upstream/main main -- render-singbox.js` 只有一笔，是之前「DNS 出口组按开关绑定」那个
PR 的 `download_detour` 改动。下面五处缺陷一条都不是本仓库引入的。

---

## 一、五件事，按严重度排

| # | 缺陷 | 后果 | 位置 |
|---|---|---|---|
| 1 | `{ tag: 'REJECT', type: 'block' }` | 1.13+ **整份配置拒绝加载** | `render-singbox.js:390`、`builtin-singbox-generator.js:378` |
| 2 | `[]FINAL` 渲染成无条件规则 | 冗余兜底且 `route.final` 取错组；是否启动报错尚无实机证据 | `render-singbox.js:286`、`:371` |
| 3 | `rule.source` 缺省时产出悬空 `rule_set` 引用 | 启动期 rule-set not found | `render-singbox.js:266` vs `:315` |
| 4 | 九种内联规则类型丢五种 | 数据静默丢失，界面无任何提示 | `render-singbox.js:264-304` |
| 5 | `rule_set` tag 不去重 | 同一份清单下载两遍、常驻两份 | `render-singbox.js:313` |

共同成因是一件事：**模板渲染路径比内置模板路径不完整**。内置那条路的 `translateRuleLine()`
（`builtin-rules-provider.js:401`）与 `render-clash.js` 都已经是正确写法，五处修复全部有同仓库
对照物 —— 这也是它们适合提上游的理由：不是新特性，是补齐。

### 1.1 `type: 'block'` 出站 —— sing-box 1.13.0 已移除

官方 deprecated 页写的是过去式：Legacy special outbounds（`block` / `dns`）1.11.0 弃用，
**1.13.0 移除**，替代是 rule action。而两条路径都无条件输出它：

```js
outbounds: [
    { tag: 'DIRECT', type: 'direct' },
    { tag: 'REJECT', type: 'block' },   // ← 1.13+ 未知出站类型
    ...
]
```

它一定被引用，不是死代码：内置 `POLICY_GROUPS` 里有
`{ name: '🎬 视频广告', type: 'select', proxies: ['REJECT', 'DIRECT'] }`
（`builtin-rules-provider.js:194`）；可视化编辑器里 `🛑 广告拦截` 的成员是
`['REJECT', 'DIRECT', '🚀 节点选择']`（`catalog.js` 的 `AD_BLOCK_MEMBERS`）。

**修法三步，必须一起做**，只做任一步都会留下更糟的状态：

1. 从 `outbounds` 去掉 `REJECT` 那一项
2. 规则目标解析为「拒绝」时，输出 `action: 'reject'` 而不是 `outbound: 'REJECT'`
3. 从所有策略组的成员列表里剔除 `REJECT`；剔完为空的组连组一起去掉

第 2 步「解析为拒绝」的判据：策略字面是 `REJECT` / `REJECT-DROP`，**或**策略是一个策略组、
且该组的默认成员递归解析为拒绝。select 组默认选中首位，
`['REJECT', 'DIRECT', …]` 这个写法本身就表示「默认拦截，另两项是放行入口」
（`serialize.js:315` 的注释已经写明这个约定）。

只做第 1、3 步不做第 2 步的后果：广告规则会指向一个只剩 `['DIRECT']` 的单成员组，
**配置能加载，但广告拦截静默失效**，比现在的「加载不了」更难发现。

**实现补充**：用 sing-box 专用 `prepareSingboxGroups()` 同时服务两条路径，先以固定点解析嵌套默认
拒绝，再清理组，避免修改其他平台的共享策略定义。`REJECT-DROP` 必须输出 `method: 'drop'`，
不能降成普通 reject；INI 预处理也必须保留这个成员，本轮只为 sing-box 启用额外保留策略。

- `urltest` 不等同 selector：仅所有成员默认拒绝时才把整个组视为拒绝；混合组须排除默认拒绝的
  候选，否则该候选被清成 DIRECT 后会参与测速，意外把代理流量改为直连。
- 删除空组后递归删除父组中的引用，并修正 selector 的 `default`；`urltest` 本身不能输出 `default`。
- 对仍被普通规则、显式 FINAL、隐式兜底引用的已删非拒绝组，显式报错，不输出悬空目标或另选出口。
- DNS 绑定目标若不存在或默认拒绝，同样显式报错，不输出无效 `detour` / `download_detour`。

### 1.2 `[]FINAL` 渲染成一条无条件规则

实测每一份可视化产物的 `route.rules` 末位恒为：

```json
{"outbound":"🐟 漏网之鱼"}
```

零匹配条件。来源是 `serialize.js:244` 恒写 `ruleset=<final>,[]FINAL`，而 `mapRuleToSingbox` 的
`match` / `final` 分支（`:286`）只返回 `{ outbound }`。

内置那条路不会这样：`translateRuleLine` 对 singbox 的 `MATCH` 返回 `null`，兜底交给
`route.final`。又是同一个「模板路径比内置路径不完整」。

sing-box 是否因此报 `missing conditions` **未实机确认**（抓取端拿不到 sing-box 源码，
raw.githubusercontent / jsdelivr 都被拒）。但无论报不报都该删：`route.final` 已经承担兜底，
这条规则是冗余的。

**修法**：第一个 `match` / `final` 决定兜底，其后规则不可达，不再输出。普通出口写
`route.final = rule.policy`，不产无条件路由；**拒绝出口例外**，用末尾 `{ action: 'reject' }`
（DROP 另带 `method: 'drop'`），`route.final` 保持真实出站 DIRECT，不能把 REJECT 当作出站 tag。
无 FINAL 时保留原来的第一个非 DNS 组兜底；该组被删且无拒绝语义时显式报错。
顺带治掉现有测试里
记着的偏差（`rule-generator-render-matrix.test.js:344-345`）：`route.final` 现在取
`groups[0]`（即 `🚀 节点选择`），修完变成 `🐟 漏网之鱼`，与其余五个渲染器的 `FINAL` 一致。
那条断言要跟着改，注释里那句「§10 已知偏差」可以删掉。

### 1.3 `rule.source` 缺省时产出悬空 `rule_set` 引用

`buildRuleSets()` 只收 `source === 'remote'` 的规则（`:315`），而 `mapRuleToSingbox()` 对所有
`rule-set` 规则都发引用（`:266`）。`source` 这个字段只由 `parseAclRuleSetLine` 设置
（`ini-template-parser.js:91`）；`[Rule]` 段走的是 `parseRuleLine`（`:51`），**它不设**。
全仓库只有 `render-singbox.js:315` 与 `render-loon.js:320` 读这个字段。

实测，手写 INI：

```ini
[Rule]
RULE-SET,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Apple.list,🚀 节点选择
MATCH,🚀 节点选择
```

产物：

```
route.rules     引用 tag  "🚀 节点选择_https://.../Clash/Apple.list"
route.rule_set  里只有    ["geosite-cn"]
```

sing-box 对未声明的 rule-set tag 是启动期报错。可视化编辑器不走这条路（`serializeState` 只产
`ruleset=` 行，恒有 `source`），但自定义模板与远程 INI 会。

**修法**：把 `buildRuleSets()` 的筛选条件放宽到「`type === 'rule-set'` 且 `value` 是 http(s)
URL」，不再依赖 `source`。取这个方向而不是反过来收紧 `mapRuleToSingbox()`：`[Rule]` 段里写远程
URL 是合理用法，静默丢掉它比多产一条 `rule_set` 更糟。

实现使用 `URL` API 校验绝对 HTTP(S) 地址，并让声明和引用使用同一个 pin 后地址；无法声明的
本地名字、非法地址或其他协议会显式报错，不再生成悬空引用。

`render-loon.js:320` 那处同样在读 `source`，但它是 `rule.source === 'remote' || …` 的或条件，
有别的兜底分支，**不要一起改** —— 那五个渲染器的产物本轮必须逐字节不变（例外见 §五）。

### 1.4 九种内联规则类型，sing-box 丢五种

界面上「🧱 自定义规则集 → 内联规则」的类型下拉提供 9 种（`GeneratorTopBar.vue` 的
`INLINE_TYPES`）。九种各放一条进同一张卡片，跑六个渲染器，逐条在产物里查（实测复核过两次）：

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

`mapRuleToSingbox()` 只认 `rule-set` / `geoip` / `geosite` / `match` / `domain-suffix` /
`domain-keyword`，其余一律 `return null`，随后被 `:370` 的 `.filter(Boolean)` 吃掉。用户填了
`IP-CIDR,10.0.0.0/8`，产物里没有任何痕迹，界面上也没有任何提示。

对照：`builtin-rules-provider.js:433-436` 的 `translateRuleLine()` 已经正确处理了 `DOMAIN` 与
`IP-CIDR`，前两个分支直接照抄即可。

**修法**：补五个分支，映射到 sing-box 原生 route rule 字段。

| 生成器类型 | sing-box 字段 |
|---|---|
| `DOMAIN` | `domain: [value]` |
| `IP-CIDR` | `ip_cidr: [value]` |
| `IP-CIDR6` | `ip_cidr: [value]`（sing-box 的 `ip_cidr` 同时吃 v4/v6，不分字段） |
| `PROCESS-NAME` | `process_name: [value]` |
| `DST-PORT` | `port: [Number(value)]`（**数字数组**，字符串会被拒） |

`Number(value)` 之前必须校验：只接受十进制整数 0..65535。空值、非数字、小数、负数、超范围值
及尚未支持的端口区间显式报错，否则 `NaN` 在 JSON 中会变成 `null`，或空串误变端口 0。

`no-resolve` 修饰符：sing-box 没有对应字段，`rule-modifiers.js:20-21` 的注释已经写明不覆盖
sing-box，照旧丢弃，不必特殊处理。

**兜底分支要改掉**。现在末尾是裸 `return null`，任何将来新增的类型都会静默消失。保留
`return null`，但返回前记一条 `console.warn`，让下次漏类型时至少在日志里看得见。

复现脚本（`node --input-type=module`，路径按需改）：

```js
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
console.log(JSON.stringify(cfg).includes('203.0.113.0/24'));  // false，四条全都查不到
```

**GEOIP 的验证必须大小写不敏感**：`GEOIP,JP` 会变成 `rule_set: ['geoip-jp']`，按字面 `JP` 去查
会得到假阴性。第一次实测就踩了这个，误报 GEOIP 也丢了。

### 1.5 `rule_set` tag 不去重

`buildRuleSets()`（`:313`）用 `.map` 直接展开，没有去重。两张不同卡片挂同一个 URL、又落在同一个
桶里时，产出两条 tag 完全相同的 `rule_set`。触发路径不算罕见：`dedupeSourcesWithinCard()` 只在
单张卡片内去重，跨卡片同 URL 由 `findSourceConflicts()` 提示但**不阻止**。

**修法：tag 只从 URL 派生，不带 policy。** 照 `render-clash.js:138` 的 `ruleProviderMap` —— 它按
**URL** 建 key，两条 `RULE-SET` 规则共享一个 provider。**仅改 tag 不会去重**：原来的 `.map()`
仍会展开重复声明。实现须用规范化、pin 后 URL 作为 `Map` 的 key，且声明与引用共用同一 tag。

不要保留「tag 含 policy」再加 `Set` 去重：那样同 URL 不同桶仍是两条独立 `rule_set`，配置合法但
sing-box 会把同一份清单下载两遍、常驻两份内存，而 clash 那边不是这么做的。

---

## 二、明确不做

| 不做 | 原因 |
|---|---|
| 远程规则集的 `format` / URL 映射 | 要新增托管来源，是可视化编辑器特有的问题，走另一轮 |
| 动 `render-clash/surge/loon/quanx/egern` | 它们本来是好的；产物必须逐字节不变（例外见 §五） |
| 改 INI 的 `ruleset=` 语法 | 会破坏 subconverter 兼容与高级模式手改 |
| 把 `download_detour` 换成 `http_client` | 1.14.0 才弃用、1.16.0 才移除，现在改会抬高地板且与本轮无关 |
| 动 `REMOTE_SOURCES` 那张表 | 内置模板路径的规则来源本来是好的，见 §六 |

---

## 三、客户端版本地板：>=1.12

沿用 `type: 'block'` = 要求客户端 **≤ 1.12**；改用 `action: 'reject'` = 要求 **≥ 1.11**。
二者在 1.11 / 1.12 有重叠，但 `block` 无法用于 1.13 及以上，必须迁移。

**用户最新决定为 >=1.12**，整份配置与既有 DNS 格式采用同一地板，不增加旧版本兼容分支，理由：

- 1.13 已经移除 `block`，必须迁移为 reject action 才能适配较新版本
- route action 自 1.11 提供；官方 Rule Action 文档明确 `route` 是默认 action，普通路由可保留
  `outbound` 而省略 `action: 'route'`。不能只凭旧字段表标注弃用就推断当前结构必定非法
- 既有新版 DNS server 与 `route.default_domain_resolver` 从 1.12 开始支持，保留现有输出即可
- 另一轮使用的 AWAvenue source 格式 `version: 3` 最低要求 1.11，不会额外抬高本轮的 1.12 地板

**支持范围**：sing-box 1.12 及以上；1.11 及更早版本不在本轮适配与验收范围内。

**附带一个行为差异，要写进验收，不要漏说**：sing-box 下「广告拦截可以在客户端里切成放行」这个
能力没了。1.13+ 的 selector 成员只能是真出站，拒绝只能靠规则上的 `action`，没法塞进成员列表让
用户点选。其余五个平台的 `🛑 广告拦截` 仍是可切换的 select 组。这是平台差异，不是回归。

**DNS 约束已纳入版本决定**：两条路径已有的 `buildSingboxDnsConfig()` 输出带 `type` / `server` /
`server_port` 的新版 DNS server，且写入 `route.default_domain_resolver`，这是 **1.12** 开始的格式。
因此「reject action 支持 1.11」不等于「整份配置支持 1.11」。旧 DNS 格式又在 **1.14 移除**，
简单回退旧格式也不能同时覆盖 1.11 与较新版本。

用户已明确选择只适配 >=1.12，因此不再为 1.11 增加按版本生成 DNS 的逻辑，也不回退旧格式。
`safe-dns.js` 保持不变；原先的版本范围阻断已解除，真实客户端校验仍待执行。

官方依据：[Rule Action](https://sing-box.sagernet.org/configuration/route/rule_action/)、
[DNS Server](https://sing-box.sagernet.org/configuration/dns/server/)、
[Legacy DNS Server](https://sing-box.sagernet.org/configuration/dns/server/legacy/)。

---

## 四、测试

`tests/unit/rule-generator-render-matrix.test.js` 已有 23 个用例覆盖六个渲染器的结构，新增用例挂
在那里；`tests/unit/builtin-singbox-generator.test.js` 承接内置路径那一半。五件修复各自要有钉子：

| 用例 | 钉住什么 |
|---|---|
| 产物里不出现 `"type": "block"`，且 `outbounds` 无 `REJECT` tag | §1.1 |
| 原本指向「首成员为 REJECT 的组」的规则，输出 `action: "reject"` | §1.1 第 2 步，这条最容易漏 |
| 所有策略组的成员列表都不含 `REJECT`，且无空成员组 | §1.1 第 3 步 |
| 普通 FINAL 不输出无条件规则；拒绝 FINAL 保留末尾 reject action | §1.2，不能把拒绝兜底一起删掉 |
| `route.final` 等于 `🐟 漏网之鱼`（六个渲染器的 FINAL 目标一致） | §1.2，替换掉现有那条「已知偏差」断言 |
| route 与 DNS 引用的每个 `rule_set` tag 都有声明，且 tag 唯一 | §1.3 / §1.5；出站与组成员引用另行验证 |
| `[Rule]` 段里的 `RULE-SET,<url>,<policy>` 能产出对应的 `rule_set` | §1.3 |
| 九种内联类型在六个渲染器下全部存活 | §1.4。**直接把实测矩阵变成断言**，它同时防住五个渲染器的回归 |
| `DST-PORT` 在 sing-box 下是数字数组不是字符串 | §1.4，容易写错且只有客户端才报错 |
| 两张卡片同 URL 时 `rule_set` 只有一条，两条规则引用同一个 tag | §1.5 |
| 其余五个渲染器的产物在改动前后逐字节相同 | 范围约束。改动前先存基线字符串 |
| 嵌套 REJECT-DROP、urltest 混合拒绝候选、递归删组、已删组兜底报错 | §1.1 的策略语义边界 |
| 非法端口、非法 URL 与无声明的本地 rule-set 显式报错 | 避免静默丢规则或输出无效 JSON 配置 |

GEOIP 的断言记得大小写不敏感，理由见 §1.4。

---

## 五、验收

**层 1 — 配置形状正确。** 修完即成立，单测可验证。

**层 2 — 真客户端能加载。** 这一层是本轮的真正目标，**必须实机跑一次**：sing-box ≥ 1.13
（有 `type: block` 的话它一定失败，是最直接的对照）与最低支持版本 1.12 各一次。要确认的三件：

当前未执行，见 §九。必须区分原始产物与为单独验证路由而替换 DNS / 远程规则集的测试配置，
后者通过不能算完整产物兼容。1.11 不再是验收目标。

1. `type: 'block'` 去掉后配置能加载
2. 无条件规则是否真的报 `missing conditions`（本轮唯一没查实的推断）
3. 悬空 `rule_set` 引用的确切报错形态

**层 3 — 能力范围。** 修完之后：

| 场景 | 结果 |
|---|---|
| 自建**内联规则**卡片 | 六平台可用 |
| 只用内置目录卡片、或自填远程 URL | **sing-box 下远程规则集仍然不生效**，那是另一轮的事 |

PR / 提交信息里不要写「六平台验证通过」，本轮只把 sing-box 从「加载不了」修到「能加载、内联规则
生效」是验收目标，**不是现阶段已获实机证明的结论**。远程规则集那一格没动。

**产物基线的例外**：本轮改了 `builtin-singbox-generator.js`（§1.1 的三步同样作用在内置路径），
所以 `builtin-singbox-generator.test.js` 与相关快照会变，得重立基线。其余五个渲染器
（clash / surge / loon / quanx / egern）的产物必须逐字节不变。

---

## 六、上游那条路为什么没暴露这些问题

值得写在 PR 描述里，能省掉一轮来回。

内置模板路径的 sing-box 规则集**全部来自 SagerNet 官方 `.srs`**，不碰 ACL4SSR：

| 逻辑键 | clash / surge / quanx | sing-box |
|---|---|---|
| `ADS` | ACL4SSR `BanAD.yaml` / `BanAD.list` | `geosite-category-ads-all.srs` |
| `STREAM` | `Netflix.yaml` / `Netflix.list` | `geosite-netflix.srs` |
| `SOCIAL` | `Telegram.yaml` / `Telegram.list` | `geosite-telegram.srs` |
| `APPLE` / `MICROSOFT` / `AI` | ACL4SSR 对应文件 | `geosite-apple` / `-microsoft` / `-openai.srs` |

所以 `getRemoteProviderDefinitions:501` 那个 `endsWith('.srs') ? 'binary' : 'source'` 永远走
binary 分支 —— 内置路径「没毛病」不是因为格式判断写得对，而是**因为那张表里只可能出现 `.srs`**。
同样的判断在 `render-singbox.js:306` 就会咬人，因为那边 URL 来自模板正文。

`type: 'block'`（§1.1）是唯一一处内置路径也中招的：它跟规则来源无关。

这也解释了为什么 §二 不动 `REMOTE_SOURCES`：它是「换内容」（sing-box 用户拿到的是 geosite 近似
分类而不是 ACL4SSR 规则），这个取舍在只承诺 8 个粗粒度键的内置模板里成立，不该在本轮翻案。

---

## 七、操作步骤

1. 先确认 §三 的版本地板（用户最新决定为 >=1.12；保持既有 DNS 格式）
2. `git switch -c test`（已按用户要求执行）
3. **改动前先存六个渲染器的产物基线字符串**（其中五个用来钉「逐字节不变」）
4. 顺序：§1.1 → §1.2 + §1.3 → §1.4 → §1.5。§1.1 最要紧且独立，先让它单独绿
5. 每一步按 §四 补对应用例
6. `npx vitest run` 全绿 + `npm run build` 通过
7. §五 层 2 的真客户端验证
8. 按用户最新授权仅提交本轮改动到本地 `test`，**不要 push / 提 PR / 合并**

## 八、注意事项

- **`.filter(Boolean)` 是这轮的元凶模式**：`render-singbox.js:370` 把 `mapRuleToSingbox()` 返回的
  `null` 静默吃掉。同文件 `:364` 的那个作用在出站上，与规则无关，别一起改
- `render-loon.js:283` 与 `render-quanx.js:180` 对 `RULE-SET` 都是 `return null` 然后走各自的
  remote 段，别以为那也是 bug
- `mapRuleToSingbox()` 的 `rule-set` 分支返回的是**字符串** `rule_set: '<tag>'`，geoip/geosite
  分支返回**数组**。sing-box 的 Listable 两种都吃，但既然要动这个函数，统一成数组是顺手的事
- 路由规则的 `outbound` 已迁至 Rule Action；默认 action 是 `route`，本轮普通路由不额外加
  `action: 'route'`，拒绝规则显式输出 `action: 'reject'`
- **起点状态**：本文行号基于 `3debf8c`（`main`）。`functions/` 相对 `upstream/main` 只有
  `download_detour` 那一笔差异，因此这些行号对上游也基本有效，提 PR 时无需重新定位
- sing-box 源格式版本对照（另一轮会用到，记在这里免得再查）：1→1.8、2→1.10、3→1.11、
  4→1.13、5→1.14

## 九、2026-09-07 实施与验证记录

- 实施计划：`docs/superpowers/plans/2026-09-07-singbox-renderer-defects.md`，含完整文件清单。
- 原始两份定向测试 34/34 通过；新增缺陷与边界回归已观察到失败，再由实现修复。
- 只读独立审阅发现 urltest 拒绝组转直连、已删组被路由引用两项问题；新增 6 个失败回归后修复，复核关闭。
- 六份定向测试（缺陷、渲染矩阵、内置 sing-box、模板 pipeline、内置规则审计、DNS 开关）：143/143 通过。
- `npx vitest run`：130 个文件、977 个用例通过；其中固定丰富模板样例的其他五渲染器 SHA-256 字节基线不变。
- `npm run build`：通过；首次受沙箱 `spawn EPERM` 阻止启动 esbuild，放宽执行权限后重试成功，未改环境配置。
- `git diff --check`：通过。
- 未跑真实 `sing-box check`：本地未找到二进制；已请求临时下载官方 Windows 包的授权，尚未获答复。
  未下载、未启动 TUN、未修改系统代理，也未安装项目依赖。
- 版本决定已更新为 >=1.12，与既有 DNS 一致；不再需要实现或验收 1.11 兼容，也不增加版本选择逻辑。
- 剩余风险：真实客户端兼容尚未验证；远程 `.list` 格式转换仍属另一轮；拒绝策略编译为
  action 后不再支持在 sing-box 客户端中切换广告组以放行。
- 用户已授权将本轮改动提交到本地 `test`，不执行 push / PR / 合并；用户原有的 visual-rule-parity 文档修改不纳入提交并保持不动。
