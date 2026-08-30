# MiSub 内置可视化规则生成器 — 实施方案 2.0

**文档状态**：实施方案，等待开工确认，不包含实现代码

**取代关系**：本文取代 `PROJECT_DESIGN.md`、`DESIGN_REVIEW.md`、`PROJECT_PLAN_1.0.md`。三份旧文档为"独立零后端工具 + 外部 subconverter"路线所写，该路线在 MiSub 内不成立，整体作废。仍然有效的已核实事实收进附录 A，作废条目对照见附录 B。

**核实基准**：MiSub v2.7.0，本文所有关于宿主行为的断言均来自阅读仓库代码，标注了 `文件:行号`。

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

  headModifiers: {
    localAreaNetwork: boolean      // 局域网直连
    unban: boolean                 // 白名单修正
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

### 4.2 RuleCard（统一卡片模型）

左侧待选栏与右栏各段里的每一个可拖动对象都是同一种结构。内置目录条目与用户自填条目**不是两种类型，只是 `origin` 不同**：

```ts
interface RuleCard {
  id: string
  name: string                     // '🤖 AI 服务'，flexible 时即策略组名
  origin: 'builtin' | 'user'
  sources: CardSource[]            // 1..N，清空后整卡移除
  bucket: 'off' | 'head' | 'flexible' | 'proxy' | 'direct'   // 'off' = 留在左侧待选栏
  target?: string                  // 仅 bucket === 'flexible' | 'head'
  order: number                    // 桶内排序
  category?: string                // 仅 builtin：左侧待选栏的分组依据
  cnException?: boolean            // 仅 builtin：策展标记，见 5.1.1
  note?: string
}

interface CardSource {
  id: string
  kind: 'remote' | 'inline'
  value: string                    // remote: 规则集 URL；inline: 规则值
  ruleType?: 'DOMAIN' | 'DOMAIN-SUFFIX' | 'DOMAIN-KEYWORD'
           | 'IP-CIDR' | 'IP-CIDR6' | 'GEOIP' | 'GEOSITE'
           | 'PROCESS-NAME' | 'DST-PORT'          // 仅 inline
  noResolve?: boolean                              // 仅 IP-CIDR / IP-CIDR6
}
```

统一成一种结构由 ④ 的去重语义反推得出：既然要"从预置卡片里删掉重复的那几条 URL、保留剩余 URL 组成的卡片"，预置卡片本身就必须是多来源容器。顺带三个收益：

- `assignments` 这张独立映射表消失，桶归属只有一个真相源
- 内置目录策展时可以把语义同一的多个清单合成一张卡（`AI 服务` = `OpenAi.list` + `Claude.list`），直接服务于抑制组膨胀
- 单条自定义规则退化为"只含 inline 来源的卡片"，因此也能拖进灵活桶，不再受"无独立组名"的限制

`bucket` 的五种语义：

| bucket | 输出 | `name` 的作用 |
|---|---|---|
| `off` | 不输出，留在左侧待选栏 | 卡片标题 |
| `head` | 全部 sources 指向卡片上的目标下拉所选组 | 仅卡片标题 |
| `flexible` | 新建策略组 `name`，全部 sources 指向它 | 策略组名 |
| `proxy` | 全部 sources 指向共享的 `🌍 国外代理` | 仅卡片标题 |
| `direct` | 全部 sources 指向共享的 `🎯 全球直连` | 仅卡片标题 |

`head` 即「⬆️ 优先匹配」区（5.1.1）。`proxy` 与 `direct` 各自汇入一个共享策略组——它们是同一类东西，只是默认出口不同（5.2.1）。

灵活桶卡片额外需要一个出口目标（如 `📹 油管视频 → 🇯🇵 日本节点`），优先匹配区卡片额外需要一个目标下拉。两者都不入 `RuleCard` 的固定字段，而是存在同一个可选字段里：

```ts
  target?: string                  // 仅 bucket === 'flexible' | 'head'
```

避免为两个仅在特定 bucket 下有意义的语义各开一个字段。

### 4.3 内置的 GEOIP 卡片

`GEOIP,CN` 不再是一个开关，而是目录里的一张普通内置卡片：

```ts
{
  id: 'geoip-cn',
  name: '🇨🇳 国内 IP',
  origin: 'builtin',
  sources: [{ id: '…', kind: 'inline', ruleType: 'GEOIP', value: 'CN' }],
  bucket: 'direct',                // 默认落在 🎯 全球直连
  order: 999,                      // 桶内钉底
  note: 'IP 段判定，粒度粗，应排在所有域名规则之后'
}
```

因此它和其它卡片一样可以拖回左侧待选栏（等于关掉），也可以换到别的桶。`order: 999` 让它默认钉在所属桶的末尾，满足"IP 规则排在域名规则之后"的位置约定。

**拖出 `🎯 全球直连` 要给警告**：`GEOIP,CN` 覆盖面极大，一旦落进灵活桶或 `🌍 国外代理`（5.1 的第 3、4 段），它会排在 `🎯 全球直连` 的全部域名规则之前，把 `ChinaDomain` 之类清单整体遮蔽。这是 `warn` 级提示而非拦截——用户可能确有此意图（如刻意让国内 IP 走代理）。

**这个形态无需任何输出格式改动。** `ruleset=<组名>,<源>` 允许多行共享同一组名，MiSub 自己的内置预设已经这么用——`builtin-template-registry.js:67-85` 的 `🤖 AI 服务` 就由 2 个远程清单加 15 条内联规则组成。`render-clash.js:130-159` 为每个**不同 URL** 建一个 `rule-provider`（`:148` 用递增计数器命名，同名文件不冲突），再由 `:195-200` 输出多条 `RULE-SET` 指向同一 policy。N 个来源合成一个组是原生可表达的。

自填 URL 不命中 `render-clash.js:64-99` 的 ACL4SSR 路径映射表，一律 `behavior: classical`（`.list` 附带 `format: text`）。classical 是最宽容的 behavior，支持全部规则类型，因此是安全默认值。

### 4.4 卡片的创建与去重

**创建**：顶栏输入框一次提交的全部 URL 合成**一张**卡片；想要多张就多次提交。这是分卡边界的唯一依据，界面上需要写明。

**去重（用户输入优先）**：新卡片的每条 URL 与所有内置卡片的 `sources` 做字面比对，命中则：

1. 新卡片与被命中的内置卡片同时标红，提示重复
2. 新卡片上对这条重复来源给两个操作：
   - **保留我的**：从内置卡片的 `sources` 中移除这条 URL；内置卡片 `sources` 清空后整卡移除
   - **删除**：从新卡片中移除这条 URL；新卡片 `sources` 清空后整卡移除

去重在**来源粒度**而非卡片粒度生效：一张三 URL 的新卡片只有一条撞车时，另外两条与卡片本身都保留。

字面比对前先归一化 URL（去尾斜杠、统一大小写 host、剥离 query）。**只能查出 URL 字面相同**，查不出内容重叠——见第十节缺口。

### 4.5 往返存储：INI 注释头

**问题**：模板在 KV 里是 INI 文本，重新打开可视化界面需要还原卡片的桶归属、卡内来源的拆分边界、灵活桶出口目标、优先匹配区的目标选择等信息，这些无法从 INI 正文完整反推。记录字段白名单（2.3）又不允许加字段。

**方案**：把 `GeneratorState` 序列化成 JSON、base64 后写进 INI 首行注释。

```ini
; misub-visual-state-v1: eyJ2ZXJzaW9uIjoxLCJiYXNlIjp7Li4u
[custom]
ruleset=...
```

`ini-template-parser.js:10` 跳过 `;` 与 `#` 开头的行——**对渲染器完全惰性**。`[custom]` 仍在，`hasIniShape()` 通过。128 KB 上限对一份状态 JSON 绰绰有余。

**代价**：`functions/` 零改动，整个功能纯前端。

**风险**：用户在高级模式手改 INI 后，注释头与正文不同步。处理策略见 8.3 A3 与第十节。

---

## 五、生成契约

### 5.1 输出顺序

`ruleset=` 的行序即最终规则优先级。固定输出顺序：

```
1. 前置修正            局域网 / 白名单（开关，不接受拖放）
2. ⬆️ 优先匹配         该区卡片，各自按卡片上的目标下拉指向已有组
3. 灵活桶              用户卡片 → 内置卡片，各自独立组
4. 🌍 国外代理         用户卡片 → 内置卡片，全部指向该组
5. 🎯 全球直连         用户卡片 → 内置卡片，全部指向该组
6. []FINAL             恒定末位，指向 🐟 漏网之鱼
```

`[]GEOIP,CN` 不再是独立一段。它是一张普通内置卡片（4.3），默认落在 `🎯 全球直连` 且 `order: 999`，因此自然排在该组所有域名规则之后、`[]FINAL` 之前，位置约定不变。

同一桶内**用户卡片恒排在内置卡片之前**：用户显式定义优先于策展的广覆盖清单。卡片内多个 source 按其在 `sources` 数组中的顺序输出。

#### 5.1.1 「⬆️ 优先匹配」为什么是独立一段

旧文档把 R5「规则内容级重叠检测」列为承重墙，原因是固定顺序"`🌍 国外代理` → `🎯 全球直连`"本身会制造问题：`Google.list` 含 `DOMAIN-KEYWORD,google`，会吞掉 `🎯 全球直连` 里 `GoogleCN.list` 的 `google.cn`。这正是 ACL4SSR 必须把 GoogleCN 置顶的原因。

MVP 不做内容下载与后缀树分析，改用**策展 + 可见位置**解决：目录里给 GoogleCN、SteamCN 这类"CN 例外"打 `cnException: true`，它们默认落进「⬆️ 优先匹配」区。

**这一段必须是右栏的独立一段，不能做成 `🎯 全球直连` 内部的子区。** 拖拽 UI 里右栏自上而下的排列就是优先级承诺。若把它塞在 `🎯 全球直连`（第 5 段）内部却按第 2 段输出，UI 与输出就不一致；反过来若真按第 5 段的位置输出，它就排在 `🌍 国外代理` 之后，起不到"置顶"作用，等于白做。因此它必须紧跟前置修正、位于灵活桶之前，让可见顺序与匹配顺序对齐。

该区顺带解决另一件事：单条内联规则卡片如果只能落在某个桶里，就会被前面桶的广覆盖清单遮蔽。放进「⬆️ 优先匹配」是用户表达"这条必须赢"的唯一手段。

该区卡片不新建策略组，各自带一个目标下拉。选项只有三类：`🚀 节点选择`、`🎯 全球直连`、任一**已勾选**的地区组。`cnException` 卡片默认选中 `🎯 全球直连`。刻意不提供 `🌍 国外代理` 与灵活桶组名——前者的语义已由 `🚀 节点选择` 覆盖，后者会让"优先匹配区依赖某张灵活桶卡片是否存在"，产生跨段耦合。完整重叠分析仍留在阶段 C。

### 5.2 策略组装配

| 策略组 | 类型 | 成员 / 过滤器 |
|---|---|---|
| `🚀 节点选择` | select | 已启用的可选基础组 + 已勾选地区组 + `DIRECT` |
| `☑️ 手动切换` | select | `.*` |
| `♻️ 自动选择` | url-test | `.*` + testUrl + interval,,tolerance |
| `🔯 故障转移` | fallback | `.*` + testUrl + interval,,tolerance |
| 地区组 | url-test | `(港|HK|Hong ?Kong)` + 测速参数 |
| `🌐 其他地区` | url-test | `^(?!.*(<已启用地区 pattern 合并>)).*$` + 测速参数 |
| 灵活桶卡片 | select | 出口目标（某地区组）置首 + 桶标准成员 |
| `🌍 国外代理` | select | 桶标准成员 |
| `🎯 全球直连` | select | 桶标准成员，`DIRECT` 提到首位（5.2.1） |
| `🐟 漏网之鱼` | select | 桶标准成员 |

**桶标准成员** = `🚀 节点选择` + 已勾选的 `☑️ 手动切换` / `♻️ 自动选择` / `🔯 故障转移` + `DIRECT`。

策略组是否生成由基础配置与卡片归属**派生**，不维护独立 `enabled` 真相源（旧 R4）。`sources` 为空的卡片整卡跳过——否则会输出一个有成员但无任何规则指向的孤立组（`pruneEmptyGroups` 只剪 0 成员组，剪不掉它）。

#### 5.2.1 承接段就是策略组本身

`🌍 国外代理` 与 `🎯 全球直连` **不是"桶"之外另有一个共享组**——右栏那一段与它输出的策略组是同一个东西，段名即组名。文档与界面统一用组名指代，不再出现"代理桶 / 直连桶"这类别名。

右栏六段里有四段各自对应策略组：灵活桶（每张卡片一组）、`🌍 国外代理`、`🎯 全球直连`、`🐟 漏网之鱼`；另两段（前置修正、⬆️ 优先匹配）不产生组。

`🚀 节点选择` 是统一入口，它一处聚合了全部基础组与地区组。上述四类承接组**是同一类东西**——都是承接一批规则的策略组，区别只在默认出口。因此成员集统一为「桶标准成员」：`🚀 节点选择` 打头，其后跟上用户实际勾选了的 `☑️ 手动切换` / `♻️ 自动选择` / `🔯 故障转移`，末位 `DIRECT`。

**`🎯 全球直连` 把 `DIRECT` 提到首位（已定）。** select 组的默认选中项是第一个成员。若严格照抄标准顺序，`🚀 节点选择` 在首位，该组承接的全部规则**默认走代理**，"全球直连"的语义就反了。因此成员集合不变，排列改为 `DIRECT` → `🚀 节点选择` → 已勾选基础组：默认直连，同时保留在客户端临时切代理的入口。这是四类承接组中唯一的排列例外。

**地区组不进桶成员。** 地区通常有 6–7 个，逐桶枚举会让每个组的选项列表膨胀到十几项；需要按地区固定出口的场景由灵活桶卡片的出口目标解决——那才是"某个服务固定走某国"的正确表达位置。

`🐟 漏网之鱼` **是兜底段，不是基础策略组**。它和其它三类承接组同形，唯一区别是它承接 `[]FINAL`。此前版本让它枚举全部基础组与地区组，与 `🚀 节点选择` 的成员集完全重合，是纯冗余。

#### 5.2.2 不设只含 `DIRECT` 的基础组

曾另外考虑加一个只含 `DIRECT` 的强制基础组，让各组成员统一写 `[]🎯 全球直连` 取代 `[]DIRECT`，使客户端界面上的选项全是中文。**该做法放弃。**

六个渲染器从 url-test / fallback / load-balance 组的成员里剔除的是**字面量** `DIRECT` / `REJECT` / `REJECT-DROP` / `PASS`（`render-clash.js:13-20`、`render-surge.js:137`、`render-loon.js:153`、`render-quanx.js:157`、`render-singbox.js:245`），剔不掉一个组名。它一旦出现在 url-test 组里，测速会把直连组当候选线路、延迟最低恒定胜出，静默变成全量直连。为纯显示收益引入一类静默故障不划算。

因此各组成员里的直连一律写字面量 `DIRECT`，交给渲染器既有的剔除逻辑兜底。

#### 5.2.3 无可选基础组时的降级

`autoSelect` / `manualSelect` / `fallback` / `regions` 全部未启用时，`🚀 节点选择` 没有任何可引用的下级组。此时它降级为直接容纳全部节点：成员为过滤器 `.*` 加 `[]DIRECT`。

#### 5.2.4 策略组输出顺序

组的输出顺序即客户端界面上的显示顺序，固定为：

```
1. 🚀 节点选择
2. ☑️ 手动切换
3. ♻️ 自动选择
4. 🔯 故障转移
5. 地区组（按勾选顺序）→ 🌐 其他地区
6. 灵活桶卡片形成的组
7. 🌍 国外代理
8. 🎯 全球直连
9. 🐟 漏网之鱼
```

基础组全部排在最前，承接组在后，兜底段末位。注意这与 5.1 的**规则**顺序是两件独立的事：规则顺序决定匹配优先级，组顺序只决定客户端列表的排列。


### 5.3 INI 输出样例

```ini
; misub-visual-state-v1: <base64>
[custom]
ruleset=🎯 全球直连,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/LocalAreaNetwork.list
ruleset=🎯 全球直连,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/GoogleCN.list
ruleset=🚀 节点选择,[]DOMAIN-SUFFIX,example.com
ruleset=🤖 AI 服务,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/OpenAi.list
ruleset=🤖 AI 服务,https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/Claude.list
ruleset=🤖 AI 服务,[]DOMAIN-SUFFIX,grok.com
ruleset=📹 油管视频,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/YouTube.list
ruleset=🌍 国外代理,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Telegram.list
ruleset=🎯 全球直连,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaDomain.list
ruleset=🎯 全球直连,[]GEOIP,CN
ruleset=🐟 漏网之鱼,[]FINAL

custom_proxy_group=🚀 节点选择`select`[]☑️ 手动切换`[]♻️ 自动选择`[]🔯 故障转移`[]🇭🇰 香港节点`[]🇯🇵 日本节点`[]🌐 其他地区`[]DIRECT
custom_proxy_group=☑️ 手动切换`select`.*
custom_proxy_group=♻️ 自动选择`url-test`.*`http://www.gstatic.com/generate_204`300,,50
custom_proxy_group=🔯 故障转移`fallback`.*`http://www.gstatic.com/generate_204`300,,50
custom_proxy_group=🇭🇰 香港节点`url-test`(港|HK|Hong ?Kong)`http://www.gstatic.com/generate_204`300,,50
custom_proxy_group=🇯🇵 日本节点`url-test`(日本|JP|Japan|Tokyo)`http://www.gstatic.com/generate_204`300,,50
custom_proxy_group=🌐 其他地区`url-test`^(?!.*(港|HK|Hong ?Kong|日本|JP|Japan|Tokyo)).*$`http://www.gstatic.com/generate_204`300,,50
custom_proxy_group=🤖 AI 服务`select`[]🇯🇵 日本节点`[]🚀 节点选择`[]☑️ 手动切换`[]♻️ 自动选择`[]🔯 故障转移`[]DIRECT
custom_proxy_group=📹 油管视频`select`[]🇯🇵 日本节点`[]🚀 节点选择`[]☑️ 手动切换`[]♻️ 自动选择`[]🔯 故障转移`[]DIRECT
custom_proxy_group=🌍 国外代理`select`[]🚀 节点选择`[]☑️ 手动切换`[]♻️ 自动选择`[]🔯 故障转移`[]DIRECT
custom_proxy_group=🎯 全球直连`select`[]DIRECT`[]🚀 节点选择`[]☑️ 手动切换`[]♻️ 自动选择`[]🔯 故障转移
custom_proxy_group=🐟 漏网之鱼`select`[]🚀 节点选择`[]☑️ 手动切换`[]♻️ 自动选择`[]🔯 故障转移`[]DIRECT

enable_rule_generator=true
overwrite_original_rules=true
```

**规则段**对照 5.1 的六段：`LocalAreaNetwork` 是前置修正；`GoogleCN` 与内联的 `example.com` 在「⬆️ 优先匹配」区，前者策展默认指向 `🎯 全球直连`、后者用户选了 `🚀 节点选择`；`🤖 AI 服务` 与 `📹 油管视频` 在灵活桶；`Telegram` 在 `🌍 国外代理`；`ChinaDomain` 与 `🇨🇳 国内 IP` 卡片在 `🎯 全球直连`，后者 `order: 999` 因而钉在段尾。

**组段**对照 5.2.4 的九段：基础组四个在前，地区组三个居中，灵活桶两组、`🌍 国外代理`、`🎯 全球直连`、`🐟 漏网之鱼` 在后。

`🤖 AI 服务` 演示多来源合一：两个远程清单加一条内联规则合成**一个**策略组，而不是三个。`render-clash.js` 会为两个 URL 各建一个 `rule-provider`，输出两条 `RULE-SET` 加一条 `DOMAIN-SUFFIX`，全部指向 `🤖 AI 服务`。

四类承接组的成员是同一套「桶标准成员」（5.2.1）：`🚀 节点选择` 打头，其后是本例中全部勾选的三个可选基础组，末位 `DIRECT`；地区组不进桶成员。`📹 油管视频` 与 `🤖 AI 服务` 额外把出口目标 `🇯🇵 日本节点` 置于首位。

只有 `🎯 全球直连` 的排列不同：成员集合一样，但 `DIRECT` 提到首位，因此客户端默认直连、又保留了临时切代理的入口（5.2.1）。

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

- **卡片名唯一性**：进入灵活桶的卡片名不得与地区组、基础组（`🚀 节点选择` / `☑️ 手动切换` / `♻️ 自动选择` / `🔯 故障转移`）、桶组（`🌍 国外代理` / `🎯 全球直连` / `🐟 漏网之鱼`）、其它灵活桶卡片重名，也不得与 `DIRECT` / `REJECT` 等保留字冲突。`dedupeGroupsByName`（`template-processor.js:102-137`）会**静默合并**同名组并合并其成员与 options，语义被改变而用户无感
- 正则合法性：用 `new RegExp(pattern, 'i')` 预演，口径与 `resolveGroupFilters` 完全一致；同时拒绝 `(?i)` 与多层并列括号（3.1）
- **URL 字面重复**：按 4.4 归一化后比对，命中即双方标红并要求用户选择处理方式，未处理则拦截生成。同一卡片内重复来源直接静默去重
- **跨桶来源遮蔽**：同一个 URL 落在不同桶的两张卡片里时，按 5.1 顺序先出现者生效、后者完全失效。这是 4.4 去重的兜底——去重覆盖"新卡片 vs 内置卡片"，此项覆盖用户手动把同一 URL 拖到两处的情况
- **GEOIP 卡片位置**：`🇨🇳 国内 IP` 落在 `🎯 全球直连` 以外的任何段时给 `warn`，说明它会遮蔽其后所有域名规则（4.3）
- **优先匹配区目标有效性**：卡片指向的地区组若被取消勾选，该卡片必须回落到 `🚀 节点选择` 并提示，不能留下悬空目标
- 空来源卡片：`sources` 为空的卡片整卡跳过并提示
- `[]FINAL` 存在且位于末位
- 至少一个策略组、至少一条规则

### 6.3 策略组数量软提示

多来源合成一张卡片正是抑制组数量膨胀的手段，因此 UI 需要把这个指标显式暴露出来：常驻计数器显示预计生成的策略组数，≤12 绿、13–20 黄、>20 红。

**只提示，不拦截。** MiSub 侧不存在任何策略组数量上限，按一个自定的数字硬拦截会重复旧文档 R6 的错误——那条硬拦截依据的 `max_allowed_rulesets=64` 在实测后端上根本不生效，却会无谓阻止用户。

### 6.4 不做的校验

规则内容级重叠分析（下载 `.list` 建后缀树、`DOMAIN-KEYWORD` 子串包含判定）留在阶段 C。MVP 用 5.1 的 `cnException` 策展字段覆盖最常见的一类。

---

## 七、界面设计

### 7.1 入口

`RuleTemplateManager.vue` 增加「🎨 可视化编辑」按钮，打开 `RuleGeneratorModal.vue`（`Modal.vue` `size="6xl"`，`forms/Modal.vue:143` 支持）。原 textarea 保留为高级模式。

这与 `SubscriptionEditModal/RuleSection.vue:105-112` 已有的「可视化模式 / 高级模式」互切风格一致，不新增路由、不动导航。

保存时把序列化结果写回 `selectedTemplate.content`，仍由现有的 `dataStore.saveRuleTemplates()` 落盘。**生成器不直接调 API。**

### 7.2 分区结构

对齐参照工具 `tools.huanghaiwan.com/tools/rule-generator.html` 的信息层级，自上而下：

```
┌ 顶栏 ────────────────────────────────────────────────────────────────┐
│ ⚡ 一键方案  [🇯🇵 日本优先] [🇺🇸 美国优先] [🇭🇰 香港优先] [🔄 默认推荐]   │
│ 📋 基础策略组  [🚀 节点选择 🔒]                                        │
│                [☑️ 手动切换] [♻️ 自动选择] [🔯 故障转移] [📍 地区分组 ▾] │
│ 🔗 规则集 URL  [___________________________________]  [确定]          │
│                多条 URL 换行分隔，一次提交合成一张卡片                   │
│ 💡 为什么要按国家分流？（why 文案，可折叠）                              │
└──────────────────────────────────────────────────────────────────────┘
┌ 左：待选栏 ──────────────┐ ┌ 右：策略桶 ───────────────────────────┐
│ 🔍 [搜索]                │ │ ▸ 🔧 前置修正                    🔒    │
│                          │ │     [✓] 局域网直连  [✓] 白名单修正     │
│ ── 流媒体 ──             │ │ ▾ ⬆️ 优先匹配                    (2)   │
│  ┌────────────────────┐  │ │     ┌──────────────────────────────┐  │
│  │ 📹 油管视频      ⋮⋮ │  │ │     │ 🌐 谷歌中国  [→🎯 全球直连▾] │  │
│  └────────────────────┘  │ │     │ ✏️ 我的直连  [→🚀 节点选择▾] │  │
│  ┌────────────────────┐  │ │     └──────────────────────────────┘  │
│  │ 🎥 奈飞视频      ⋮⋮ │  │ │ ▾ 🧩 灵活桶                      (2)   │
│  └────────────────────┘  │ │     ┌──────────────────────────────┐  │
│ ── AI ──                 │ │     │ 🤖 AI 服务   [→🇯🇵 日本节点▾] │  │
│  ┌────────────────────┐  │ │     │   · OpenAi.list      (远程)  │  │
│  │ 🤖 AI 服务   3  ⋮⋮ │  │ │     │   · Claude.list      (远程)  │  │
│  └────────────────────┘  │ │     │   · grok.com         (内联)  │  │
│ ── 我的卡片 ──           │ │     └──────────────────────────────┘  │
│  ┌────────────────────┐  │ │ ▸ 🌍 国外代理                    (1)   │
│  │ 🎮 我的游戏  2  ⋮⋮ │  │ │ ▾ 🎯 全球直连                    (2)   │
│  └────────────────────┘  │ │     ┌──────────────────────────────┐  │
│ [+ 内联规则卡片]         │ │     │ 🎯 中国域名                  │  │
│                          │ │     │ 🇨🇳 国内 IP        📌 钉底   │  │
│                          │ │     └──────────────────────────────┘  │
│                          │ │ ▸ 🐟 漏网之鱼                    🔒    │
└──────────────────────────┘ └────────────────────────────────────────┘
┌ 🚦 流量路线说明 ─────────────────────────────────────────────────────┐
│ 访问 YouTube  →  📹 油管视频  →  🇯🇵 日本节点                          │
│ 访问 Claude   →  🤖 AI 服务   →  🇯🇵 日本节点                          │
│ 访问 淘宝      →  🎯 全球直连  →  直连                                 │
└──────────────────────────────────────────────────────────────────────┘
┌ 📄 生成的 INI + 校验结果 ────────────────────────────────────────────┐
│ 📊 策略组 9 个（≤12 绿）· 规则集 14 条                                 │
└──────────────────────────────────────────────────────────────────────┘
```

**顶栏**只放不可拖动的东西：一键方案、基础策略组勾选、规则集 URL 输入框、why 文案。**不放"导入订阅"**——本功能是纯粹的规则生成，节点来自 MiSub 自身的订阅管理，与此处无关。

`🚀 节点选择` 显示为锁定的已勾选态，不可取消。其余四项可选，地区分组是一个展开面板、逐个地区勾选。`🌍 国外代理` / `🎯 全球直连` / `🐟 漏网之鱼` 由卡片归属派生，不在此处勾选。

**左栏待选栏**按 `category` 分节；用户自建卡片归入「我的卡片」节。卡片右上角数字是 `sources.length`，为 1 时不显示。顶部搜索按卡片名与来源 URL 过滤。

**右栏六段**自上而下即匹配优先级（5.1）：

| 段 | 接受拖放 | 展开后 | 卡片上的额外控件 |
|---|---|---|---|
| 🔧 前置修正 | ✗ | 两个开关 | — |
| ⬆️ 优先匹配 | ✓ | 卡片列表 | 目标下拉（节点选择 / 全球直连 / 已勾选地区组） |
| 🧩 灵活桶 | ✓ | 卡片列表 + 来源明细 | 出口目标下拉（已勾选地区组） |
| 🌍 国外代理 | ✓ | 卡片列表 | — |
| 🎯 全球直连 | ✓ | 卡片列表 | — |
| 🐟 漏网之鱼 | ✗ | 固定说明 | — |

**拖放行为**：卡片从左栏拖入某段后，从左栏移到该段（不是销毁）。每段默认折叠，只显示段名与卡片数；展开后可继续把卡片拖到其它段，或拖回左栏待选栏。灵活桶展开时额外显示每张卡的来源明细，便于确认多来源合并结果。

**前置修正与漏网之鱼锁定的含义**：不接受拖放，但前置修正的两个开关仍可点。漏网之鱼没有可配置项。

**窄屏降级**：`vuedraggable` 在触屏上体验差，且现有 6 处用法全是单列表重排、无跨列表先例。窄屏下不启用拖拽，改为每张卡片一个「移到… ▾」下拉，语义完全等价。

### 7.3 与参照工具的关系

从参照工具吸收三点：

1. **⚡ 一键方案置顶**（旧 R10）：目标用户不会写 ini，逐条配三十张卡片是高级操作。预设方案必须是主入口而非后期功能。
2. **🚦 流量路线说明表**（旧 R13）：用户视角的最终确认表，从 `GeneratorState` 直接推导，不需要后端。旧文档 Step 4 只有技术视角的策略组预览，缺这个最容易建立信任的组件。
3. **内嵌 why 文案**：解释"为什么按国家分流"——IP 频繁跨国跳转会导致账号异常、内容锁定、验证频繁。面向小白用户，这类文案比功能本身更决定留存。

三处**超出**参照工具：

- 参照工具用下拉给每个服务选组，本方案用左右双栏拖拽，右栏的垂直顺序直接可视化了匹配优先级——下拉表达不出优先级
- 参照工具一条 URL 对一个组，横跨多域名的服务被拆成多组、组数量随之膨胀；本方案的卡片是多来源容器（4.2），"多来源 → 一组"是界面上的默认表达
- 参照工具输出**完整 YAML 文件**，需手动导入、不随订阅更新、移动端不可用；MiSub 输出**订阅链接**

---

## 八、任务清单

### 阶段 A：核心逻辑（纯函数，可独立验证）

- **A1** `src/utils/rule-generator/catalog.js`
  ACL4SSR 内置卡片目录约 30 张 + 地区预置。语义同一的多个清单直接合成一张多来源卡片。地区 pattern 必须满足 3.1 约束。给 GoogleCN / SteamCN 等打 `cnException`。含 4.3 的 `geoip-cn` 内置卡片（`order: 999`，默认 `bucket: 'direct'`）。
- **A2** `src/utils/rule-generator/serialize.js`
  `GeneratorState → INI`。含 `; misub-visual-state-v1:` 注释头。规则按 5.1 六段顺序、组按 5.2.4 九段顺序输出。卡片按 `bucket` 分派：`flexible` 建新组，`proxy` 并入 `🌍 国外代理`，`direct` 并入 `🎯 全球直连`，`head` 按卡片 `target` 指向已有组；卡内多来源展开为多行同组名 `ruleset=`。四类承接组的成员统一为「桶标准成员」，仅 `🎯 全球直连` 把 `DIRECT` 提到首位（5.2.1）。地区组不进桶成员。纯函数，无副作用。
- **A3** `src/utils/rule-generator/parse.js`
  `INI → GeneratorState`。优先读注释头；读不到时从 `ruleset=` / `custom_proxy_group=` 尽力反推，并返回 `partial: true` 标记供 UI 提示。反推时把"多行同组名且组名不在内置目录中"识别为一张用户卡片。
- **A4** `src/utils/rule-generator/dedupe.js`
  4.4 的 URL 归一化与字面比对，返回冲突对；两种处理动作（保留我的 / 删除）作为纯函数暴露，便于测试。
- **A5** `src/utils/rule-generator/validate.js`
  6.1–6.3 全部校验项，返回结构化 `{ level, field, message }` 列表。`level` 区分 `error`（拦截生成）与 `warn`（仅提示，如策略组数量超阈值）。
- **A6** 测试
  - `tests/unit/rule-generator-serialize.test.js` — golden file（旧 R9），含多来源合一、优先匹配区、组输出顺序三组用例
  - `tests/unit/rule-generator-roundtrip.test.js` — state → INI → state 幂等，覆盖含用户卡片与优先匹配区的状态
  - `tests/unit/rule-generator-dedupe.test.js` — 单条撞车、多条撞车、内置卡片清空后整卡移除、归一化边界
  - `tests/unit/rule-generator-validate.test.js` — 注入字符、`(?i)`、多层括号、卡片名与保留字/地区组重名、跨桶来源遮蔽、优先匹配区目标失效
  - `tests/unit/rule-generator-render-matrix.test.js` — 生成的 INI 过六个渲染器，断言无悬空引用、`MATCH` 末位、地区组存在、**一张含 N 个来源的卡片只产出 1 个策略组和 N 条规则**、桶组成员不含地区组枚举、`🎯 全球直连` 首位成员为 `DIRECT`。写法对齐现有 `builtin-conversion-matrix.test.js`

### 阶段 B：界面

- **B1** `src/components/modals/RuleGeneratorModal.vue` — 主容器（`Modal.vue` `size="6xl"`）、`GeneratorState` 管理、拖放事件收口
- **B2** `src/components/modals/RuleGenerator/` 子组件
  - `GeneratorTopBar.vue` — 一键方案 + 基础策略组勾选 + URL 输入框 + why 文案
  - `CardPalette.vue` — 左栏待选栏（按 category 分节、搜索、`+ 内联规则卡片`）
  - `BucketPanel.vue` — 右栏六段容器，负责段折叠与拖放接收
  - `RuleCardItem.vue` — 卡片本体，按所属段决定是否渲染目标下拉与来源明细
  - `DedupeConflictBar.vue` — 撞车标红与两个处理动作
  - `TrafficRouteTable.vue` — 流量路线说明表
  - `IniPreview.vue` — INI 预览 + 校验结果 + 策略组计数器
- **B3** 跨列表拖拽接线：左栏与右栏各段共享 `vuedraggable` 的 `group`；窄屏改「移到… ▾」下拉（7.2）
- **B4** `RuleTemplateManager.vue` 加「🎨 可视化编辑」入口按钮与回写逻辑
- **B5** i18n 键补进 `src/i18n/messages.js`（中英双语，对齐现有 `settings.ruleTemplate*` 命名）

### 阶段 C：后续增强（不进 MVP）

- **C1** 地区组命中数预览——复用现有节点预览接口，实现旧文档 Step 1 的 0 命中告警
- **C2** 生成后自查——同源 fetch 自己的订阅链接，`js-yaml` 解析做结构校验（旧 R11）
- **C3** 规则内容级重叠分析（旧 R5 / 6.4），含 `DOMAIN-KEYWORD` 子串包含判定与"生成例外规则置顶"第三选项
- **C4** 多规则源切换（blackmatrix7 / Loyalsoldier）。注意换源前需核实各源的规则类型分布，非基础类型在部分渲染路径下会被静默丢弃

---

## 九、验收标准

1. 用户不接触任何 INI 语法即可完成一次完整分流配置并保存为 `custom:` 模板
2. 生成的模板经六个目标格式渲染均无悬空策略组引用
3. `MATCH` / `FINAL` 恒定存在且位于规则末位
4. 卡片名与规则值中的 `,`、反引号、`=`、换行被拦截，不产生残废配置
5. 地区正则不含 `(?i)`、不含多层并列括号；命中 0 个节点的地区组被自动剪除而非降级为 `DIRECT`
6. `🚀 节点选择` 恒定生成且不可关闭；所有组的成员一律使用字面量 `DIRECT`，不存在只含 `DIRECT` 的基础组
7. 未启用任何可选基础组时，`🚀 节点选择` 降级为 `.*` + `DIRECT`，不产生空组
8. 四类承接组（灵活桶卡片 / `🌍 国外代理` / `🎯 全球直连` / `🐟 漏网之鱼`）的成员统一为「桶标准成员」= `🚀 节点选择` + 已勾选的手动切换/自动选择/故障转移 + `DIRECT`；地区组不进桶成员；灵活桶卡片额外把出口目标置于首位
9. `🎯 全球直连` 的第一个成员是 `DIRECT`（默认直连而非默认代理）；策略组输出顺序符合 5.2.4 的九段
10. 一张含 N 个来源的卡片只产出 **1 个**策略组与 N 条规则；`sources` 为空的卡片不产出任何输出
11. 卡片名与地区组、基础组、桶组、其它灵活桶卡片、保留字重名时被拦截，不发生静默合并
12. 自填 URL 与内置卡片撞车时双方标红，两个处理动作行为正确：「保留我的」从内置卡片移除该来源并在清空后移除整卡；「删除」只移除新卡片中的该来源
13. 右栏六段的可见顺序与生成的 `ruleset=` 行序完全一致
14. 卡片可在左栏与任意可拖放段之间双向移动，不发生数据丢失
15. 优先匹配区卡片指向的地区组被取消勾选时回落到 `🚀 节点选择`，不留悬空目标
16. 保存后重新打开可视化界面，状态完整还原；手改过正文的模板给出明确提示而非静默覆盖
17. `functions/` 无改动；无新增依赖；`npm run test:run` 全绿

---

## 十、风险与缺口

| 风险 | 缓解 |
|---|---|
| A3 反解对手改过的模板必然有损 | 注释头与正文不一致时**以正文为准**，顶部显示警告条，让用户显式选择"放弃手改回到可视化"或"继续用高级模式"。不静默覆盖。 |
| 注释头随 state 增长可能变大 | 128 KB 上限下余量充足；序列化时省略默认值字段 |
| 自填 URL 一律 `behavior: classical` | classical 支持全部规则类型，是安全默认值；UI 说明自填 URL 不享受 ACL4SSR 路径优化 |
| A3 反推用户卡片只能靠"多行同组名且组名不在内置目录中"这一启发式，可能误判手写模板 | 仅在注释头缺失时启用；误判结果一并落在 `partial: true` 的警告条里，由用户决定是否接受 |
| `cnException` 策展只覆盖常见情况 | 明确标注为 MVP 权衡；阶段 C3 做完整重叠分析 |
| 目录中的 ACL4SSR URL 可能失效（旧 U2 / U3 未结案） | A1 落地时逐条探测一次；卡片展开后暴露真实 URL 便于用户自查 |
| 跨列表拖拽在 MiSub 内无先例（现有 6 处 `vuedraggable` 全是单列表重排） | 标准 SortableJS 能力，不新增依赖；窄屏另有下拉降级路径（7.2） |
| **sing-box 的兜底出口不是 `🐟 漏网之鱼`** | `render-singbox.js:379` 把 `route.final` 硬编码为 `groups[0].name`，而 `[]FINAL` 在 `:284` 只产出一条无匹配条件的退化 route 规则。本方案的组输出顺序以 `🚀 节点选择` 开头（Clash 客户端列表顺序需要它在前），因此 sing-box 的兜底实际是 `🚀 节点选择`。二者成员高度重叠，行为差异很小；要彻底对齐需改 `functions/`，超出本方案范围，**列为已知偏差**。 |

### 未结缺口

**自填 URL 与内置卡片的内容级重叠查不出来。** 4.4 的去重只做 URL 字面比对。若用户填入 blackmatrix7 的 YouTube 清单，与内置 ACL4SSR 的 YouTube 卡片内容大量重叠但 URL 不同，字面比对无从发现；要查就得下载两边内容做域名比对，即阶段 C3 的运行时版本。**已决定接受该缺口**，后续视实际使用情况再评估是否补做。

---

## 附录 A：仍然有效的已核实事实

来自 `DESIGN_REVIEW.md` 的实测结论中，在本方案下仍有价值的部分：

- **`ruleset=` 行序即最终规则优先级，生成器无重排**——本方案 5.1 固定顺序的前提
- **`DOMAIN-KEYWORD` 的重叠是子串包含问题，不是集合交集**——`Google.list` 的 `DOMAIN-KEYWORD,google` 会吞掉 `google.cn`，这是 ACL4SSR 必须把 GoogleCN 置顶的真正原因，也是 5.1.1「⬆️ 优先匹配」区与 `cnException` 策展的依据
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

**文档版本**：2.0
**最后更新**：2026-08-30
**状态**：等待开工确认
