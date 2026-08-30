# Clash 规则可视化生成器 - 项目设计文档

## 一、项目定位

### 核心价值主张
- **为谁解决什么问题**：为不会编写 `.ini` remote config 的 Clash/mihomo 用户，提供可视化配置界面，生成可自动更新、跨客户端通用的订阅链接
- **与现有方案的差异**：
  - **vs ACL4SSR / sub-web**：从"选预设 ini URL"升级为"可视化配置每个规则集的分流意图"
  - **vs Clash Verge Rev 内置编辑器**：不依赖特定客户端；生成的是订阅链接，随订阅自动更新，而非本地覆写
  - **vs 手写 `.ini`**：零语法门槛；自动处理策略组引用完整性、规则顺序、正则生成
- **不做什么**：订阅转换本体、节点管理、完整 Clash 配置生成、任何后端服务与数据存储

### 技术路径
**subconverter + `data:` URI 内联 remote config**
- 用户配置 → 生成 `.ini` remote config → urlsafe base64 编码 → 内联到 `&config=data:text/plain;base64,...`
- **零后端、零托管、零内容责任**：ini 内容在 URL 里，不经过本项目服务器
- **跨客户端通用**：任何能吃订阅链接的客户端都能用，包括所有移动端（已核实：CMFA / FlClash / clashmi 不支持本地覆写，只能靠订阅链接注入规则）

---

## 二、分流模型设计

### 核心思想
**精确匹配 + MATCH 兜底，不用广域黑名单**
- 代理桶/直连桶只装**用户显式选择的规则集**，不含 `ProxyGFWlist` / `ChinaDomain` 这类广域兜底
- 真正兜底是「漏网之鱼」策略组（对应 `MATCH` 规则）
- 优势：不存在"直连例外被抢走"的顺序陷阱；用户能明确预期哪些流量走哪；策略组数量可控

### 四类桶

#### 1. 基础桶
**定义**：通用策略组，其它桶引用它们来继承行为  
**用户可配置**：勾选需要的组；地区分组可单独选择需要的地区  
**生成的策略组**（按此顺序出现在客户端界面）：
- `🚀 节点选择` (select)：统一入口，选项 = `[]手动` `[]自动` `[]故障转移` `[]<地区组>...` `[]DIRECT`
- `✋ 手动选择` (select)：选项 = 订阅的所有节点（正则 `.*`）
- `♻️ 自动选择` (url-test)：正则 `.*` 筛全部节点，300s 测速
- `🔃 故障转移` (fallback)：正则 `.*` 筛全部节点
- `🇭🇰 香港` / `🇯🇵 日本` / ... (url-test / select)：按正则筛选地区节点
- `🌐 其他地区` (select)：负向前瞻正则，排除已勾选的地区

**策略组选项联动规则**：
- `节点选择` 的选项 = 所有已启用的基础组（手动/自动/故障转移/地区组）+ `[]DIRECT`
- 每个地区组的选项 = 仅该地区的节点（不含其它组）
- `其他地区` 的正则 = 排除所有已勾选地区的关键词

#### 2. 灵活桶
**定义**：为特定服务创建独立策略组，用户可逐服务指定走哪  
**用户操作**：从预置目录选规则集 → 标记为"灵活"  
**生成规则**：
- 每个条目生成**一个独立策略组** + **一条 ruleset**
- 策略组选项 = `[]节点选择` `[]手动` `[]自动` `[]故障转移` `[]<地区组>...` `[]DIRECT`（与基础桶联动）

示例：
```ini
custom_proxy_group=📺 YouTube`select`[]🚀 节点选择`[]✋ 手动选择`[]🇭🇰 香港`[]🇯🇵 日本`[]🌐 其他地区`[]DIRECT
ruleset=📺 YouTube,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/YouTube.list
```

#### 3. 代理桶
**定义**：用户选择的"应该走代理"的规则集，共享一个策略组  
**生成规则**：
- 一个策略组 `🌍 代理` (select)，选项 = `[]节点选择` `[]手动` `[]自动` `[]故障转移` `[]<地区组>...` `[]DIRECT`
- N 条 ruleset，target 都指向 `🌍 代理`

示例：
```ini
custom_proxy_group=🌍 代理`select`[]🚀 节点选择`[]✋ 手动选择`[]♻️ 自动选择`[]🇭🇰 香港`[]🌐 其他地区`[]DIRECT
ruleset=🌍 代理,https://…/Telegram.list
ruleset=🌍 代理,https://…/Netflix.list
```

#### 4. 直连桶
**定义**：用户选择的"应该直连"的规则集，共享一个策略组  
**用户可配置**：
- 勾选需要的规则集（从预置目录选择）
- `[✓] 国内 IP 直连 (GEOIP,CN)`：默认勾选，可取消

**生成规则**：
- 一个策略组 `🎯 直连` (select)，选项 = `[]DIRECT` `[]节点选择`（注意顺序：默认直连，但可临时切代理）
- N 条 ruleset（用户选择的）+ `[]GEOIP,CN`（若用户勾选），target 都指向 `🎯 直连`

示例（启用 GEOIP）：
```ini
custom_proxy_group=🎯 直连`select`[]DIRECT`[]🚀 节点选择
ruleset=🎯 直连,https://…/SteamCN.list
ruleset=🎯 直连,https://…/GoogleCN.list
ruleset=🎯 直连,[]GEOIP,CN    ← 用户勾选了「国内 IP 直连」
```

示例（不启用 GEOIP）：
```ini
custom_proxy_group=🎯 直连`select`[]DIRECT`[]🚀 节点选择
ruleset=🎯 直连,https://…/SteamCN.list
ruleset=🎯 直连,https://…/GoogleCN.list
; 用户取消了 GEOIP，国内未匹配的 IP 会走「漏网之鱼」
```

#### 5. 漏网之鱼（自动生成，用户不配置）
**定义**：兜底策略组，对应 `MATCH` 规则，捕获所有未被前序规则匹配的流量  
**生成规则**：
```ini
custom_proxy_group=🐟 漏网之鱼`select`[]🚀 节点选择`[]DIRECT`[]✋ 手动选择`[]♻️ 自动选择`[]<地区组>...
ruleset=🐟 漏网之鱼,[]FINAL    ← 永远最后一条规则
```

**注意**：用户不需要配置，但生成的配置里默认包含。它是真正的全局兜底，排在所有桶之后。

#### 6. 前置修正（半自动）
**定义**：必须优先匹配的规则，避免被后续规则误伤  
**用户操作**：勾选「保留局域网直连」「保留白名单修正」等开关  
**生成规则**：排在所有桶之前
```ini
ruleset=🎯 直连,https://…/LocalAreaNetwork.list   # 局域网地址
ruleset=🎯 直连,https://…/UnBan.list              # 白名单修正
```

**注意**：前置修正**对用户可见**，由用户决定启用。不再包含 GoogleCN / SteamCN（它们可通过灵活桶或直连桶解决）。

---

## 三、规则顺序

### 顺序即优先级
subconverter 的 `ruleset=` 行序 = 最终 Clash 配置的规则顺序。已核实：`refreshRulesets()` 按声明顺序 `emplace_back`，生成器无任何重排。

### 固定顺序（按此序输出 ruleset 行）
```
0. 前置修正（用户启用的）   ← 局域网 / 白名单
1. 用户自定义规则          ← "这个域名必须直连/代理"
2. 灵活桶的所有 ruleset    ← 具体服务
3. 代理桶的所有 ruleset    ← 用户选的代理规则集
4. 直连桶的所有 ruleset    ← 用户选的直连规则集
   + []GEOIP,CN（若用户勾选「国内 IP 直连」）
5. []FINAL                 ← 对应「漏网之鱼」策略组（自动生成，永远最后）
```

**同桶内的顺序**：按预置目录的 `bucketOrder` 字段升序（策展值，确保同桶内合理排列）。

**特殊规则**：
- `[]GEOIP,CN` 是**直连桶的可选项**，默认勾选，用户可取消。取消后，国内未匹配的 IP 会走「漏网之鱼」
- `[]FINAL` 永远最后一条，对应 `🐟 漏网之鱼` 策略组

### 冲突检测
**场景**：用户把同一个规则集既加进代理桶、又加进直连桶  
**处理**：弹窗询问「`YouTube.list` 同时在代理桶和直连桶中，保留在哪一个？」  
**实现时机**：分配操作时实时检测 + 生成前最终校验

---

## 四、数据模型

### Config（顶层状态）
```ts
interface Config {
  version: 1
  backend: string               // subconverter 后端 URL
  subUrl: string                // 用户订阅链接 —— 不写入 localStorage
  
  base: {
    manualSelect: boolean       // ✋ 手动选择
    autoSelect: boolean         // ♻️ 自动选择
    fallback: boolean           // 🔃 故障转移
    regions: RegionConfig[]     // 地区分组配置
  }
  
  buckets: {
    proxy:  { enabled: boolean; name: string; emoji: string }   // 🌍 代理
    direct: { enabled: boolean; name: string; emoji: string }   // 🎯 直连
    leak:   { name: string; emoji: string }                     // 🐟 漏网之鱼（固定生成）
  }
  
  assignments: Record<PresetId, Assignment>  // 规则集分配
  customRules: CustomRule[]                   // 用户自定义规则
  
  headModifiers: {
    localAreaNetwork: boolean   // 局域网直连
    unban: boolean              // 白名单修正
  }
  
  enableGeoipCN: boolean          // [✓] 国内 IP 直连（直连桶的可选项，默认 true）
}

interface RegionConfig {
  id: string                      // 'hk' | 'jp' | 'us' | 'sg' | 'tw' | 'kr' | 'other'
  enabled: boolean
  name: string                    // '香港' | '日本' | ...
  emoji: string                   // '🇭🇰' | '🇯🇵' | ...
  pattern: string                 // 正则：'(港|HK|Hong ?Kong|🇭🇰)'
  type: 'url-test' | 'select'     // 策略组类型
  testUrl?: string                // url-test 的测试 URL
  interval?: number               // url-test 的测速间隔
}

type Assignment = 
  | { bucket: 'proxy' }
  | { bucket: 'direct' }
  | { bucket: 'flexible' }        // 生成独立策略组
  | { bucket: 'off' }             // 不启用

interface CustomRule {
  id: string
  kind: 'DOMAIN-SUFFIX' | 'DOMAIN' | 'DOMAIN-KEYWORD' | 'IP-CIDR' | 'PROCESS-NAME'
  value: string
  bucket: 'proxy' | 'direct'      // 自定义规则不能放灵活框（没有独立组名）
  noResolve?: boolean             // 仅 IP-CIDR
}
```

### RulesetPreset（预置目录条目）
```ts
interface RulesetPreset {
  id: string                      // 唯一标识
  name: string                    // 显示名称
  category: string                // 分类：谷歌 | 微软 | 苹果 | 流媒体 | AI | 游戏 | 社交 | 兜底
  url: string                     // ACL4SSR 规则集 URL
  defaultBucket: 'proxy' | 'direct' | 'flexible'   // 默认分配
  bucketOrder: number             // 同桶内排序（0–999）
  note?: string                   // 说明（tooltip）
}
```

预置目录示例（只列部分）：
```ts
const RULESET_CATALOG: RulesetPreset[] = [
  // ── 具体服务（灵活桶候选）──
  { id: 'youtube',    name: 'YouTube',      category: '流媒体', url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/YouTube.list',      defaultBucket: 'flexible', bucketOrder: 100 },
  { id: 'netflix',    name: 'Netflix',      category: '流媒体', url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/Netflix.list',      defaultBucket: 'flexible', bucketOrder: 110 },
  { id: 'openai',     name: 'OpenAI',       category: 'AI',    url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/OpenAi.list',       defaultBucket: 'flexible', bucketOrder: 200 },
  { id: 'telegram',   name: 'Telegram',     category: '社交',   url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/Telegram.list',     defaultBucket: 'proxy',    bucketOrder: 300 },
  { id: 'googlecn',   name: '谷歌中国服务', category: '谷歌',   url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/GoogleCN.list',      defaultBucket: 'direct',   bucketOrder: 50,  note: 'google.cn 等国内服务' },
  { id: 'steamcn',    name: 'Steam 国内',   category: '游戏',   url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/SteamCN.list',       defaultBucket: 'direct',   bucketOrder: 60 },
  // ── 前置修正（不在分配界面出现，只以开关呈现）──
  { id: '_lan',       name: '局域网',       category: '_head',  url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/LocalAreaNetwork.list',    defaultBucket: 'direct',   bucketOrder: 0,   note: '内网地址直连' },
  { id: '_unban',     name: '白名单修正',   category: '_head',  url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/UnBan.list',                defaultBucket: 'direct',   bucketOrder: 0,   note: '被误拦的常见域名' },
]
```

`category: '_head'` 的条目不出现在分配界面，由 `config.headModifiers` 控制。

---

## 五、UI 流程

### Step 0：起点配置
- **后端地址**：下拉 + 自定义输入
  - 预置：`https://api.v1.mk`（标注：公开，订阅会经过该服务）
  - 「使用自建后端」输入框
- **订阅链接**（可选）：用于节点名预览功能

### Step 1：基础策略组
**勾选项**：
- `[ ] ✋ 手动选择`
- `[ ] ♻️ 自动选择`
- `[ ] 🔃 故障转移`

**地区分组**（可展开）：
```
[ ] 🇭🇰 香港    [ ] 🇯🇵 日本    [ ] 🇺🇸 美国
[ ] 🇸🇬 新加坡  [ ] 🇨🇳 台湾    [ ] 🇰🇷 韩国
[✓] 🌐 其他地区（兜底，建议保留）
```

**「粘贴节点名预览」按钮**：
- 弹窗：粘贴订阅返回的节点列表（或从 Step 0 的订阅链接自动拉取）
- 实时显示：
  ```
  🇭🇰 香港：命中 8 个节点
  🇯🇵 日本：命中 5 个节点
  🌐 其他地区：命中 12 个节点
      ├─ 美国 IEPL 01 ✅
      ├─ 深港专线② ⚠️ 未被任何地区组匹配
      └─ 剩余流量: 50GB ⚠️ 信息节点，将被 exclude_remarks 过滤
  ```
- **0 命中告警**：「❌ 香港：命中 0 个节点 — 你的订阅里可能没有香港节点，或命名方式未被识别」

### Step 2：分配规则集
**布局**：按 `category` 分组，卡片网格
```
┌─ 流媒体 ────────────────────────────┐
│ ○ YouTube     [代理▼] [🔍详情]      │
│ ○ Netflix     [代理▼] [🔍详情]      │
│ ○ Disney+     [代理▼] [🔍详情]      │
└──────────────────────────────────────┘

┌─ AI ────────────────────────────────┐
│ ○ OpenAI      [灵活▼] [🔍详情]      │
│ ○ Anthropic   [灵活▼] [🔍详情]      │
└──────────────────────────────────────┘
```

**下拉选项**：`[ 不启用 | 代理 | 直连 | 灵活 ]`（默认值 = `defaultBucket`）

**🔍详情**：悬浮显示 `note` + 规则集 URL

**前置修正**（独立区块，置顶）：
```
前置修正（优先匹配，避免被后续规则误伤）
[✓] 局域网直连       [i] 192.168.* / 10.* 等内网地址
[✓] 白名单修正       [i] 被误拦的常见域名
```

### Step 3：自定义规则
**表单**：
```
[ 类型▼ ]  [ 值输入框 ]  [ 桶▼ ]  [+ 添加]
```
- 类型：`DOMAIN-SUFFIX` | `DOMAIN` | `DOMAIN-KEYWORD` | `IP-CIDR` | `PROCESS-NAME`
- 桶：`代理` | `直连`（不含灵活，因为没有对应的独立组名）
- 实时校验：域名格式 / CIDR 格式

**已添加列表**（可拖拽排序，但只影响同类内顺序 —— 自定义规则永远排最前）

### Step 4：输出
**左侧**：
- 🔗 **订阅链接**（复制按钮）
  ```
  https://api.v1.mk/sub?target=clash
    &url=<用户订阅>
    &config=data:text/plain;base64,<生成的ini>
  ```
  ⚠️ **安全提示**：「此链接含你的订阅地址，请勿分享给他人」

- 📄 **INI 原文**（可折叠，带复制按钮）
  ```ini
  [custom]
  enable_rule_generator=true
  ...
  ```

**右侧**：
- **策略组预览**（最终在客户端看到的顺序）
  ```
  1. 🚀 节点选择 (select) — 6 项
  2. ✋ 手动选择 (select) — 所有节点
  3. 🇭🇰 香港 (url-test) — 8 个节点
  ...
  ```

- **自动校验结果**
  - ✅ 配置已生效（策略组 "🚀 节点选择" 出现在返回配置中）
  - ⚠️ URL 长度 18.2 KB / 40 KB 安全线
  - ⚠️ ruleset 数量 42 / 64 上限

**侧边常驻计数器**（所有步骤可见）：
```
📊 统计
策略组: 9 个
规则集: 42 / 64
URL: 18.2 KB
```

---

## 六、生成器逻辑

### 核心函数
```ts
function serializeIni(config: Config, catalog: RulesetPreset[]): string
```

### 步骤
1. **全局键**
   ```ini
   [custom]
   enable_rule_generator=true
   overwrite_original_rules=true
   exclude_remarks=(到期|剩余|流量|官网|重置|订阅)
   ```

2. **策略组**（按此序输出，即客户端显示顺序）
   - `🚀 节点选择`：选项 = 所有启用的基础组 + `[]DIRECT`
   - 基础组：手动/自动/故障转移/地区组（按勾选顺序）
   - 灵活组：按 `bucketOrder` 升序
   - 代理组：`🌍 代理`
   - 直连组：`🎯 直连`
   - 漏网之鱼：`🐟 漏网之鱼`

3. **规则集**（按此序输出，即匹配优先级）
   ```
   0. headModifiers 启用的条目（_lan / _unban）
   1. customRules（按添加顺序）
   2. assignments['flexible'] 的条目（按 bucketOrder 升序）
   3. assignments['proxy'] 的条目（按 bucketOrder 升序）
   4. assignments['direct'] 的条目（按 bucketOrder 升序）
      + ruleset=🎯 直连,[]GEOIP,CN（若 enableGeoipCN = true）
   5. ruleset=🐟 漏网之鱼,[]FINAL（漏网之鱼自带，永远最后）
   ```

4. **URL 编码**
   ```ts
   const ini = serializeIni(...)
   const b64 = toUrlSafeBase64(ini)
   const url = `${backend}/sub?target=clash&url=${encodeURIComponent(subUrl)}&config=data:text/plain;base64,${b64}`
   ```

### 策略组选项装配规则
| 策略组 | 选项列表 |
|---|---|
| `节点选择` | `[]手动` `[]自动` `[]故障转移` `[]<地区>...` `[]DIRECT` |
| `手动选择` | `.*`（正则匹配所有节点） |
| `自动选择` / `故障转移` | `.*` + 测试 URL + `300,,50` |
| 地区组（如 `香港`） | `(港\|HK\|Hong ?Kong\|🇭🇰)` |
| `其他地区` | `^(?!.*(港\|HK\|Hong ?Kong\|...<所有已勾选地区的pattern合并>)).*$` |
| 灵活组（如 `YouTube`） | `[]节点选择` `[]手动` `[]自动` `[]故障转移` `[]<地区>...` `[]DIRECT` |
| `代理` | 同灵活组 |
| `直连` | `[]DIRECT` `[]节点选择`（注意顺序） |
| `漏网之鱼` | `[]节点选择` `[]DIRECT` `[]手动` `[]自动` `[]<地区>...` |

---

## 七、四个防错机制

### 1. 生成后自动校验
**目标**：检测 `loadExternalConfig` 静默失败（base64 编码错误、ini 语法错误）

**方法**：对生成的 URL 发 fetch，检查返回 YAML 里是否出现 `🚀 节点选择`（或用户自定义的组名）

**⚠️ CORS 风险**：浏览器直连第三方 subconverter 后端可能被 CORS 挡住
- 降级方案：「打开链接自查」+ 检查清单（「配置加载成功的标志：策略组列表里出现 🚀 节点选择」）

### 2. ruleset ≤ 64 计数
**限制**：`max_allowed_rulesets` 默认 64，超限**整个列表被拒绝且静默回落默认配置**

**实现**：
- 侧边计数器实时显示 `n / 64`
- `n >= 60` 时黄色告警
- `n >= 64` 时红色拦截，不允许生成

计数对象：前置修正 + 自定义规则 + 灵活桶 + 代理桶 + 直连桶 + `[]GEOIP,CN`（若勾选）+ `[]FINAL`（固定 1 条）

### 3. 顺序自动编排
**用户无法手动排序 ruleset**，顺序由桶分类 + `bucketOrder` 决定

**UI 里的"拖拽排序"仅限**：
- 自定义规则在同类内的顺序（但整类仍在前置修正之后）
- 灵活组在其桶内的顺序（但桶位置固定）

### 4. 冲突检测
**场景**：同一规则集同时分配给代理桶和直连桶

**时机**：
- 实时检测：用户操作分配下拉时，若检测到冲突，弹窗询问保留位置
- 最终校验：生成前扫描 `assignments`，若仍有冲突，拦截生成

---

## 八、待核实的技术细节

### 1. 正则引擎能力（未核实完成，agent 连续 502）
**问题**：「其他地区」的负向前瞻 `^(?!.*(港|HK|...)).*$` 是否可用

**降级方案**（若不支持）：
- 改用「全匹配」模式：`.* `（匹配所有节点），在客户端手动排除已有地区组
- 或穷举所有非目标地区的关键词（工程量大且不完备）

**大小写不敏感**：
- 若不支持 `(?i)`：穷举大小写变体（ACL4SSR 已有实践）
- 若支持：在正则前加 `(?i)` 前缀

**当前假设**：按 ACL4SSR 现有写法（穷举大小写）生成，待核实后优化

### 2. `exclude_remarks` 的生效时机
**假设**：在策略组生成**之前**从节点池剔除

**影响**：若假设成立，`.*` 不会匹配到信息节点，「其他地区」的负向前瞻无需额外排除 `(到期|剩余|...)`

**待实测**：构造一个含信息节点的订阅 + `exclude_remarks=(剩余)` 的 ini，看输出的策略组 proxies 列表

### 3. URL 长度实际上限
**已知**：实测 `api.v1.mk` 约 40 KB 返回 200，≥80 KB 返回 414

**安全策略**：
- 绿色：< 30 KB
- 黄色：30–40 KB，提示「接近部分 CDN 上限」
- 红色：≥ 40 KB，建议「减少规则集数量」或「改用托管 URL」

---

## 九、技术栈

- **框架**：React 18 + TypeScript + Vite
- **状态管理**：Zustand（需导入/导出/分享，单一 store）
- **样式**：Tailwind CSS（快速原型）
- **依赖**：
  - `js-yaml`：解析校验返回的 YAML
  - 手写 `toUrlSafeBase64`（避免 `btoa()` 的 Latin-1 限制 + emoji 爆栈问题）

**关键实现**：
```ts
function toUrlSafeBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  // 分块避免 String.fromCharCode(...长数组) 爆栈
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
    .replace(/\+/g, '-')  // URL-safe：必须替换，否则 query string 里 + 被解码成空格
    .replace(/\//g, '_')
}
```

---

## 十、风险与限制

### 技术风险
1. **`config=` 支持 `data:` 是未文档化行为**  
   缓解：始终展示 ini 原文；保留"改用托管 URL"降级路径

2. **`data:` 方案下配置不可版本化**  
   改一个字符链接全变，用户已保存的链接失效  
   缓解：UI 明确提示；提供配置 JSON 导入/导出（阶段三）

3. **CORS 可能阻止自动校验**  
   缓解：降级为"打开链接自查" + 检查清单

### 隐私风险
- 生成的链接**内含用户订阅地址**，属敏感信息  
  缓解：复制时给出警告；分享功能只导出不含 `subUrl` 的配置 JSON

### 依赖风险
- 用户仍需一个 subconverter 后端，订阅会经过它  
  缓解：默认引导自建；公开后端标注「订阅会经过该服务，请评估信任」

---

## 十一、阶段划分

### 阶段一（MVP）
- [ ] 完整 UI 流程（Step 0–4）
- [ ] 基础桶 + 灵活桶 + 代理桶 + 直连桶 + 漏网之鱼
- [ ] 前置修正（局域网 / 白名单）
- [ ] 自定义规则
- [ ] INI 生成 + URL 编码
- [ ] 四个防错机制
- [ ] 预置目录（ACL4SSR，30–40 条）
- [ ] 节点名预览（可选功能，依赖用户提供订阅）

### 阶段二
- [ ] 自定义 DNS（取决于 `clash_rule_base` 能否内联 `data:`，若不能需托管）
- [ ] YAML 格式 remote config 输出（可读性更好）

### 阶段三
- [ ] 配置 JSON 导入/导出
- [ ] 分享链接（不含 `subUrl`）
- [ ] 预设模板（「轻度翻墙」「重度使用」「游戏优化」等）

---

## 十二、与竞品的差异

| 维度 | ACL4SSR + sub-web | Clash Verge Rev | mihomo-constructor | **本项目** |
|---|---|---|---|---|
| 输入方式 | 选预设 ini URL | GUI 表单（prepend/append） | 拖拽 + 下拉 | 按桶分配 + 自动排序 |
| 输出 | 订阅链接 | 本地覆写 | 完整 YAML | 订阅链接 |
| 跨客户端 | ✅ | ❌（仅 Verge） | ❌（YAML 需手动导入） | ✅ |
| 移动端 | ✅ | ❌ | ❌ | ✅ |
| 顺序保证 | ❌（手写，易错） | 部分（只管 prepend/append 顺序） | ❌（用户手排） | ✅（自动） |
| 节点预览 | ❌ | ✅ | ❌ | ✅（可选） |
| 零后端 | ✅（公共后端） | ✅ | ❌（需 Docker） | ✅ |
| 策略组数量 | 20+ | 取决于订阅 | 全自定义 | <10（精简） |

---

## 十三、开发注意事项

### 必须遵守的约束
1. **不擅自新增依赖**：仅 React + Zustand + Tailwind + js-yaml
2. **不实现订阅转换本体**：100% 依赖 subconverter
3. **不存储用户数据**：订阅链接只存内存，不写 localStorage
4. **策略组引用完整性**：生成器必须保证不产生悬空引用（`[]不存在的组`）
5. **ruleset 顺序不可人为破坏**：UI 不提供跨桶拖拽

### 代码组织建议
```
src/
├── stores/
│   └── configStore.ts          # Zustand store
├── components/
│   ├── Step0Backend.tsx
│   ├── Step1BaseGroups.tsx
│   ├── Step2Assignments.tsx
│   ├── Step3CustomRules.tsx
│   └── Step4Output.tsx
├── lib/
│   ├── iniGenerator.ts         # serializeIni()
│   ├── urlEncoder.ts           # toUrlSafeBase64()
│   ├── validator.ts            # 冲突检测 / 格式校验
│   └── catalog.ts              # RULESET_CATALOG
└── types/
    └── index.ts                # Config / RulesetPreset / ...
```

---

## 十四、未来可能的扩展

- 预设模板市场（用户分享配置 JSON）
- 多订阅合并（目前只支持单订阅）
- 规则集热度排行（统计最常用的组合）
- 浏览器扩展（右键"添加当前网站到直连"）
- 与 Sub-Store / Stash 等生态集成

---

**文档版本**：v1.0  
**最后更新**：2026-08-20  
**状态**：设计阶段，待进入实施
