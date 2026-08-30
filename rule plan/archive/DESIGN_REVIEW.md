# PROJECT_DESIGN.md 设计审核 + 技术核实报告

> **性质**：对 `PROJECT_DESIGN.md` v1.0 的审核记录，**不修改原文档**。
> **日期**：2026-08-20
> **核实方式**：subconverter 源码精读（tindy2013/subconverter master）+ 对 `api.v1.mk` 的端到端真实请求实测
> **状态**：待消化，尚未据此修订设计文档

---

## 〇、总体结论

**技术路径可行，选型正确。** `subconverter + data: URI 内联 remote config` 的核心假设**已实测成立**，不再是「未文档化的赌注」。

桶模型（代理桶/直连桶 + 分配阶段消解重叠）逻辑自洽，相比 ACL4SSR 预设 ini 是一次真实升级。

主要问题集中在三处：
1. **静默故障面**比文档预估的大（三层静默叠加，实测复现两个）
2. **`clash_rule_base` 缺席**是 MVP 正确性问题，被误放到阶段二
3. **重叠检测**是整个顺序正确性的承重墙，但文档只有一句话

---

## 一、核实方法

```
方式 A：源码精读
  仓库 tindy2013/subconverter @ master
  文件 src/handler/webget.cpp, src/utils/regexp.cpp, src/utils/base64/base64.cpp,
       src/utils/network.h, src/handler/settings.{h,cpp}, src/handler/interfaces.cpp,
       src/generator/config/subexport.cpp, src/generator/config/ruleconvert.cpp,
       base/pref.example.yml

方式 B：端到端实测
  后端 https://api.v1.mk  (subconverter v1.9.9)
  输入 伪造的 ss:// 节点链接（HK-01 香港 / JP-02 Japan / us-03 LosAngeles / 剩余流量：50GB）
  请求 GET {backend}/sub?target=clash&url=<enc>&config=data:text/plain;base64,<b64>
  核对 返回 YAML 的 proxies / proxy-groups / rules 三段
```

**实测局限**：使用的是伪造的裸节点链接，不是真实机场订阅。凡涉及「订阅解析路径」的结论（主要是 `exclude_remarks`）**未能完全验证**，已在下文逐条标注。

---

## 二、核实结果：文档假设成立的部分 ✅

| # | 待核实项 | 结论 | 证据 |
|---|---|---|---|
| 1 | `config=data:text/plain;base64,...` | ✅ **成立** | `webget.cpp:308` `if(startsWith(url,"data:")) return dataGet(url);`<br>`dataGet()` 定义于 `webget.cpp:277-291`<br>实测 763 字节 ini 完整生效 |
| 2 | URL-safe base64 | ✅ **正是要求的形式** | `dataGet()` 调用 `urlSafeBase64Decode()`；解码表同时接受 `-_` 与 `+/`（`base64.cpp:78-82`），遇 `=` 即停（`:85`）——padding 留不留都可以 |
| 3 | 正则引擎 | ✅ **PCRE2**（jpcre2）<br>`std::regex` 分支已整体注释掉 | `regexp.cpp:9` `#include <jpcre2.hpp>`<br>`regexp.cpp:134-166` |
| 3a | 负向前瞻 `(?!...)` | ✅ **可用** | 实测 `(?i)^(?!.*(港\|hk\|hong ?kong\|德国\|germany)).*$` → 正确排除香港节点，保留 JP/US |
| 3b | 内联标志 `(?i)` | ✅ **可用**（PCRE2 原生） | 实测 `(?i)(港\|hk\|hong ?kong)` 命中 `HK-01 香港` |
| 4 | emoji 用于组名与正则 | ✅ 支持 | `PCRE2_UTF` 已启用；🚀 ♻️ 🇭🇰 🇩🇪 🌐 实测全部正常 |
| 5 | `[]FINAL` → `MATCH` | ✅ | `ruleconvert.cpp:152-153` 显式替换<br>实测输出 `MATCH,🚀 节点选择` |
| 6 | `custom_proxy_group` 语法 | ✅ **文档写法正确** | 反引号分隔；`300,,50` = `interval,timeout,tolerance`（`settings.cpp:209`）<br>实测输出 `interval: 300` / `tolerance: 50` |
| 7 | 节点筛选的匹配语义 | **search**（非全匹配） | `subexport.cpp:226` 用 `regFind`<br>→ `(港\|HK)` 这类不加锚点的写法是对的 |
| 8 | `clash_rule_base` 支持 `data:` | ✅ **成立** | `network.h:15-18` `isLink()` 显式包含 `data:`<br>**实测内联 base 生效，`rule-providers` 出现在输出中** |
| 9 | 规则顺序 = ruleset 声明顺序 | ✅ | 实测 70 条 ruleset 按声明序输出，无重排 |

### URL 体积实测

```
ini 原文        763 字节
base64 后      1020 字符
完整请求 URL   1492 字符
```

文档第八节第 3 点担心的 URL 长度问题，**方向性上不成立**。40 条 ruleset 的实际规模约 6 KB ini / 8 KB base64，距离 40 KB 安全线很远。

---

## 三、核实结果：文档假设被推翻的部分 ⚠️

### ⚠️ 3.1 `max_allowed_rulesets = 64` 在真实后端上不存在

```cpp
// settings.h:66 —— 代码默认确实是 64
size_t maxAllowedRulesets = 64, maxAllowedRules = 32768;
```

```yaml
# base/pref.example.yml:150-152 —— 但发布的示例配置是 0
max_allowed_rulesets: 0
max_allowed_rules: 0
max_allowed_download_size: 0
```

```cpp
// settings.cpp:1252 —— 0 表示不限
if(global.maxAllowedRulesets && vArray.size() > global.maxAllowedRulesets)
```

**实测**：向 api.v1.mk 提交 **71 条 ruleset**，`test70.com` 出现在输出中，`DOMAIN-SUFFIX,test` 匹配 70 次。**限制未触发。**

**影响**：
- 防错机制 #2 的「≥64 红色拦截」会在不限的后端上**无谓阻止用户**
- 该值**客户端无法探测**（没有暴露接口）
- 建议改为：软提示（说明「部分后端限制 64 条」）+ 依赖生成后校验，而非硬拦截

**同时注意**：计数对象是 ini 里 `ruleset=` 的**行数**（`vArray.size()`），内联 `[]` 规则**同样计入**。所以每条自定义规则都吃配额。

**另一个静默截断**：`max_allowed_rules`（规则总条数）超限时是 `break`（`ruleconvert.cpp:167-168, 302-303`）——**静默截断规则列表**，不报错。

---

### ⚠️ 3.2 `exclude_remarks` 对裸节点链接输入完全不生效

**实测**（三种写法全部失败）：

| 写法 | 结果 |
|---|---|
| ini `[custom] exclude_remarks=(剩余\|到期\|流量)` | ❌ `剩余流量：50GB` 仍在输出中 |
| URL 参数 `&exclude=(剩余\|到期\|流量)` | ❌ 同上 |
| URL 参数 `&exclude=HK`（对照组） | ❌ `HK-01` 也仍在输出中 |

对照组是关键：连最简单的 `HK` 都过滤不掉，说明**裸链接输入根本不走 remark 过滤流程**。

**但源码接线是正确的**：
```
interfaces.cpp:482-483   外部配置 → lExcludeRemarks
interfaces.cpp:560-585   URL 参数 → lExcludeRemarks
interfaces.cpp:606       lExcludeRemarks → parse_set.exclude_remarks
```
过滤发生在解析器内部（`parse_settings` 的消费点未在已下载文件中找到）。

**结论边界**：
- ✅ 已证实：裸 `ss://` 链接作为 `url=` 时，include/exclude 不生效
- ❓ 未证实：真实订阅 URL 下是否正常（**大概率正常**，但需要真实订阅复测）
- 📌 文档第八节第 2 点（exclude_remarks 生效时机）**仍然待验证**

**对项目的直接影响**：若将来允许用户粘贴裸节点链接（而非订阅 URL），`exclude_remarks` 会静默失效，信息节点会污染所有 `.*` 策略组。

**附带发现**：`url=data:text/plain;base64,<订阅内容>` 被拒绝（HTTP 400）。订阅参数不接受 data: URI，只有 `config=` 和 `*_rule_base=` 接受。

---

### ⚠️ 3.3 后端默认 base 模板的污染比预想严重

未指定 `clash_rule_base` 时，api.v1.mk 注入它自己的 `base/all_base.tpl`，实测内容包含：

```yaml
port: 7890
socks-port: 7891
allow-lan: true              # ← 用户从未选择，安全相关
bind-address: "*"
ipv6: false
mode: Rule
external-controller: 127.0.0.1:9090
dns:
  enable: true
  fake-ip-range: 198.18.0.1/16
  fake-ip-filter: [ "*.lan", "*.local", ... ]
  nameserver: [119.29.29.29, 223.5.5.5]
  nameserver-policy:
    geosite:cn: [...]
    geosite:geolocation-!cn: [tls://1.0.0.1:853, tls://dns.google:853]
  fallback: [8.8.8.8, 1.1.1.1, ...]
  fallback-filter:
    geoip: true
    geoip-code: CN
    geosite: [gfw]
    ipcidr: [240.0.0.0/4]
```

**换一个后端，这些全部改变。** 这直接摧毁「跨客户端、可预期」的核心卖点。`allow-lan: true` 尤其值得注意——这是一个用户从未同意的、有安全含义的默认值。

**结论**：`clash_rule_base` 不是阶段二增强，是 **MVP 正确性问题**。且已证实它支持 `data:`，可零托管内联。

---

## 四、实测复现的静默故障

### 🔴 4.1 空策略组静默降级为 DIRECT

**源码**：
```cpp
// subexport.cpp:650-651 (proxyToClash)
if(filtered_nodelist.empty())
    filtered_nodelist.emplace_back("DIRECT");
```
同样的模式出现在 Surge/Quan/Loon/sing-box 等所有导出函数中（`:1041, :1434, :1685, :1948, :2173, :2589`）。

**实测复现**：故意加一个订阅里不存在的地区组
```yaml
- name: 🇩🇪 德国
  type: url-test
  url: http://www.gstatic.com/generate_204
  interval: 300
  tolerance: 50
  proxies:
    - DIRECT          # ← 0 命中，静默填 DIRECT
```

**危害**：客户端界面上这个组显示得和正常代理组一模一样，但**所有指向它的流量全部裸奔直连**。用户不会察觉。

**建议**：不能只靠 Step 1 的「0 命中告警」（那是可选路径，依赖用户提供订阅）。应在**生成侧**兜底：命中 0 个节点的地区组直接不生成，并从所有引用它的策略组选项里移除。

---

### 🔴 4.2 组名含逗号 → 配置静默残废

**机制**：`ruleset=` 按**第一个逗号**切分组名与规则。

```
ruleset=🚀 我的,组,[]FINAL
        └─group─┘└─── rule = "组,[]FINAL" ───┘   ← 解析错位
```

**实测结果**：HTTP 200，策略组 `🚀 我的,组` 正常创建，但 **`rules:` 段为空，MATCH 兜底规则整条丢失**。返回的是一个看起来正常、实际没有兜底的配置。

**同类风险**（数据模型允许用户自定义的所有字符串）：

| 字符 | 破坏点 | 受影响字段 |
|---|---|---|
| `,` | `ruleset=` 的组名/规则分隔 | `buckets.*.name`, `emoji`, `RegionConfig.name` |
| `` ` `` | `custom_proxy_group=` 的字段分隔 | 同上 |
| `=` | ini 键值分隔 | 同上 |
| 换行 | ini 行分隔 | 所有字段，含 `customRules.value` |
| `!!` 前缀 | 触发 `applyMatcher` 特殊语法 | 正则字段（见下） |

**`applyMatcher` 的特殊前缀**（`subexport.cpp:118-119`）：
```
!!GROUPID= / !!INSERT= / !!GROUP= / !!TYPE= / !!PORT= / !!SERVER=
```
另有 `!!import:` 指令（`settings.cpp:181`）。用户输入的正则若以 `!!` 开头会被当作指令解析。

---

### 🔴 4.3 三层静默叠加

```
第 1 层  base64Decode 遇到非法字符 → 原样拷贝进输出，不报错  (base64.cpp:90)
第 2 层  ini 解析失败 / ruleset 超限 → loadExternalConfig 返回 -1  (settings.cpp:1235, 1255)
第 3 层  interfaces.cpp:452  if(loadExternalConfig(...) == 0) { ... }
         ↑ 没有 else 分支 —— 整个外部配置被静默忽略，用默认配置继续生成
```

用户拿到的是一个 HTTP 200、格式合法、但完全不是自己配置的订阅。

**这就是防错机制 #1（生成后自动校验）存在的正当性**——而且好消息是它现在完全可行（见 5.3）。

---

## 五、实测打开的三个机会

### ⭐ 5.1 `clash_rule_base=data:` + rule-providers（最大的架构升级）

**实测可行**。形态：

```ini
[custom]
enable_rule_generator=false
clash_rule_base=data:text/plain;base64,<内含 rule-providers + rules 的最小 YAML>
custom_proxy_group=🚀 节点选择`select`.*`[]DIRECT
```

内联 base 示例（实测通过，返回 YAML 中 `rule-providers` 正常出现）：
```yaml
port: 7890
mode: rule
rule-providers:
  yt:
    type: http
    behavior: classical
    url: "https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/YouTube.list"
    path: ./ruleset/yt.yaml
    interval: 86400
rules:
  - RULE-SET,yt,🚀 节点选择
  - MATCH,🚀 节点选择
```

**收益**：

| 收益 | 说明 |
|---|---|
| 绕开 `max_allowed_rulesets` | 无论后端设成多少都不受限 |
| 后端零 fan-out | 不再逐个拉规则集，生成延迟从「40 次 GitHub 请求」降到 0 |
| 输出体积暴降 | 从几万行内联规则降到几百行 |
| 规则自动更新 | 客户端按 `interval` 自更新，**改规则集不用换订阅链接** → 直接消解文档风险 #2「配置不可版本化」 |
| 收回配置控制权 | DNS / `allow-lan` / mode 全部自己定，解决 3.3 |

**代价**：
- 仅 mihomo / Clash Premium 内核支持 rule-providers（2026 年主流客户端均为 mihomo 内核，可接受）
- URL 中出现两个 data: URI（基数很小，无实质影响）

**建议**：从阶段二提到 MVP 主线，或至少 MVP 就把 `clash_rule_base` 内联化（哪怕先不用 rule-providers）。

---

### ⭐ 5.2 `[]GEOSITE,xxx` 内联规则可用

**实测**：`ruleset=🚀 节点选择,[]GEOSITE,youtube` → 输出 `GEOSITE,youtube,🚀 节点选择`

**原理**：规则类型白名单只过滤**从规则集文件读到的行**：
```cpp
// ruleconvert.cpp:173 —— 文件内容走白名单过滤
if(std::none_of(ClashRuleTypes.begin(), ClashRuleTypes.end(),
    [strLine](const std::string& type){return startsWith(strLine, type);}))
    continue;
```
而内联 `[]` 分支（`:149-158`）**跳过校验**直接透传。

一条 GEOSITE = 一条规则，零网络下载。可大幅压缩规则集数量。

**⚠️ 反面警告**：因为白名单会过滤文件内容，**规则集文件里的 `RULE-SET` / `GEOSITE` / `PROCESS-PATH` / `DOMAIN-REGEX` / `AND` / `OR` / `NOT` 行会被静默丢弃**。

Clash target 的白名单（`ruleconvert.cpp:12-13`）：
```
DOMAIN, DOMAIN-SUFFIX, DOMAIN-KEYWORD, IP-CIDR, SRC-IP-CIDR, GEOIP,
MATCH, FINAL, IP-CIDR6, SRC-PORT, DST-PORT, PROCESS-NAME
```
ACL4SSR 只用基础类型，没问题。但**换用 blackmatrix7 等规则源时会静默丢规则**。

---

### ⭐ 5.3 节点预览与自动校验都完全可行

**实测**：
```
GET https://api.v1.mk/sub?target=clash&list=true&url=<订阅>

HTTP 200
Access-Control-Allow-Origin: *          ← 关键
Content-Type: text/plain;charset=utf-8

proxies:
  - {name: 🇭🇰 HK-01 香港, server: ..., type: ss, ...}
  - {name: 🇯🇵 JP-02 Japan, server: ..., type: ss, ...}
```

**这推翻了两个悲观判断**：

1. **节点名预览不需要浏览器直连机场**（那确实会 CORS 失败），走 subconverter 中转即可。而且**更好**——拿到的是经过后端 rename / add_emoji 流水线**之后**的名字，正是地区正则实际会看到的字符串。
2. **自动校验（防错机制 #1）的 CORS 顾虑对 api.v1.mk 不成立**，可以直接 fetch 生成的 URL 做完整校验。

仍需按后端探测后降级（不是所有后端都开 CORS）。

**附带确认**：上面返回的 `🇭🇰` 前缀是**后端加的**（该次请求未设 `add_emoji=false`）。对照第一次测试设了 `add_emoji=false` 时输出为 `HK-01 香港`（无旗）——**证实 ini 里的 `add_emoji` 开关有效，且必须显式设置**，否则节点名会随后端配置变化，进而影响地区正则命中。

---

## 六、重叠检测的展开（设计的承重墙）

分流模型「重叠在分配阶段消解，桶间顺序不重要」的逻辑**自洽且成立**。但文档目前只有「弹窗询问保留哪一个」一句话，而这一句要扛起整个顺序正确性。需要决策四个点：

### 6.1 可静态分析 vs 不可分析

| 规则类型 | 能否算重叠 | 算法 |
|---|---|---|
| `DOMAIN` / `DOMAIN-SUFFIX` | ✅ | 后缀树；含包含关系（`google.com` ⊃ `cloud.google.com`） |
| `IP-CIDR` / `IP-CIDR6` | ✅ | 前缀包含判定 |
| **`DOMAIN-KEYWORD`** | ⚠️ **特殊，最关键** | 见 6.2 |
| `GEOIP,CN` | ❌ 不可静态分析 | 内容在客户端 geo 数据库 |
| `GEOSITE,*` | ❌ 不可静态分析 | 同上 |
| `PROCESS-NAME` / `DST-PORT` | ✅ 但少见 | 精确比对 |

对不可分析的类型，只能靠**位置约定**兜底：`GEOIP,CN` 永远排在所有域名规则之后、`FINAL` 之前。

### 6.2 `DOMAIN-KEYWORD` 是关键

它不是集合交集问题，是**子串包含**问题。

```
Google.list   含 DOMAIN-KEYWORD,google
GoogleCN.list 含 DOMAIN-SUFFIX,google.cn
              ↓
DOMAIN-KEYWORD,google 会吞掉 google.cn
```

这就是 ACL4SSR 必须把 GoogleCN 置顶的真正原因。检测时必须拿前者的每个 keyword 去匹配后者的每个域名，**纯 set intersection 会漏掉**。

### 6.3 数据来源

`raw.githubusercontent.com` 返回 `Access-Control-Allow-Origin: *`，浏览器可直接 fetch 规则集内容做分析。

代价：首次分配时要下载数十个文件（ChinaMax 这类几百 KB）。
建议：懒加载 + IndexedDB 缓存 + 仅在「代理桶与直连桶均非空」时触发计算。

**顺带解锁**：
- 「🔍详情」可展示**真实规则内容**，而不只是 note + URL
- 可预估最终配置的规则总条数（比 URL 长度更有意义的容量指标）

### 6.4 数据模型需要扩展

现在 `assignments: Record<PresetId, Assignment>` 只能把**整个规则集**分到一个桶。但重叠是**域名级**的——用户可能想要「Google.list 走代理，但其中 google.cn 走直连」。

**建议冲突弹窗给三个选项**：
1. 保留在代理桶
2. 保留在直连桶
3. **生成例外规则置顶**（把冲突域名提取成 customRule 排在最前）← 这才是 ACL4SSR 的实际做法

---

## 七、参照工具分析

**目标**：`https://tools.huanghaiwan.com/tools/rule-generator.html`（32.5 KB 纯前端页面）

### 7.1 它和本项目不是同一类东西

它的输出按钮是 **「⬇️ 下载 YAML / 📋 复制」**——生成完整 YAML 文件，**不是订阅链接**。

按 `PROJECT_DESIGN.md` 第十二节的对比表，它属于 **mihomo-constructor 那一列**：

| 维度 | 该工具 |
|---|---|
| 输出 | 完整 YAML |
| 跨客户端 | ❌ 需手动导入 |
| 移动端 | ❌ |
| 随订阅自动更新 | ❌ |

**所以本项目的核心差异化（订阅链接 + 自动更新 + 移动端可用）对它依然完全成立。** 它「不够全面」只是表层差距，架构差异才是根本的。

**建议**：把它加进第十二节对比表，因为它比 sub-web 更接近本项目的交互形态。

### 7.2 值得借鉴的三点

1. **「⚡ 一键方案」放在第一屏**
   印证「预设模板应是 MVP 主入口，而非阶段三」。目标用户是不会写 ini 的人，逐条配 40 个下拉是高级操作。

2. **「📦 流量路线说明」表**
   一张「访问 X 时流量走哪条线路」的大白话表格。
   本设计 Step 4 只有**策略组预览**（技术视角），缺这个**用户视角**的最终确认表。这是最容易建立信任的组件。

3. **内嵌 why 文案**
   它专门解释「为什么要做国家分流」：*访问 TikTok、Netflix 等服务时，如果 IP 频繁在不同国家间跳转，会导致账号异常、内容锁定、验证频繁等问题。把特定服务固定到某个国家组（如 TikTok → 🇯🇵 日本），IP 始终在该国范围内，可避免这些问题。*
   面向小白用户，这类 why 文案比功能本身更决定留存。

### 7.3 关于「策略组多余，应该合并」

「国外媒体 + 电报 → 合并为代理组」「全球直连 + 国内媒体 → 合并为直连组」——这正是本设计代理桶/直连桶的出发点，**方向正确**。

唯一要注意：合并后失去了**分组切换粒度**（原本可以只让 Netflix 走某个节点而 Telegram 走另一个）。这个粒度由**灵活桶**补回来了，所以设计上是完整的。

---

## 八、问题清单

### 8.1 已作废的审核意见

| 原编号 | 内容 | 作废原因 |
|---|---|---|
| #1 | 「顺序模型错误、例外会被抢走」 | 误读。重叠在分配阶段消解，桶间顺序确实不重要 |
| #4 | 「冲突检测机制是空的」 | 误读。要检测的是**规则内容级**重叠，非 preset 级重复 |
| #5 | 「缺 REJECT / 广告拦截桶」 | 明确不做 |
| #12 | 「从订阅链接自动拉取节点名不可行」 | 实测推翻，走后端 `list=true` 可行且更好 |
| #32 | 「四类桶但有 6 个子节，编号越界」 | 「四类桶」= 用户可编辑的桶；前置修正与漏网之鱼不计入。文档补一句限定即可 |

### 8.2 现存问题（按优先级）

| 级别 | # | 问题 | 状态 |
|---|---|---|---|
| 🔴 | R1 | 组名/规则值分隔符注入（`,` `` ` `` `=` 换行 `!!`） | **实测复现**，配置静默残废 |
| 🔴 | R2 | 0 命中地区组静默变 DIRECT | **实测复现**，需生成侧拦截 |
| 🔴 | R3 | `clash_rule_base` 缺席 → 继承后端 DNS / `allow-lan:true` | **实测确认**，MVP 必修 |
| 🟠 | R4 | 悬空引用：`buckets.*.enabled` 与 `assignments`/`headModifiers`/`enableGeoipCN` 是多个独立真相源 | 结构性缺陷，改派生即可 |
| 🟠 | R5 | 重叠检测未展开（承重墙） | 见第六节 |
| 🟠 | R6 | 64 上限硬拦截会误伤 | 实测 v1.mk 不限，改软提示 |
| 🟠 | R7 | 真正的性能风险是**后端 fan-out 拉取**（40 个规则集 = 40 次 GitHub 请求），文档完全未提；而被列为主要风险的 URL 长度实测不成立 | 风险章节需重排；5.1 可根治 |
| 🟡 | R8 | `add_emoji` / `remove_old_emoji` / `new_name` / `insert` 未显式设置，行为随后端漂移 | 实测确认 emoji 会改节点名 |
| 🟡 | R9 | 无测试策略。`serializeIni` 是纯函数 + 项目核心，是 golden-file 测试的教科书场景 | 阶段一未列测试 |
| 🟡 | R10 | 预设模板应从阶段三提前到 MVP | 参照工具佐证 |
| 🟡 | R11 | 自动校验太弱（只查「有没有 🚀 节点选择」）；应改为 js-yaml 完整结构校验 | CORS 可用，能做完整版 |
| 🟡 | R12 | MVP 太胖：灵活桶、节点预览、自动校验可后置 | — |
| 🟢 | R13 | 缺「流量路线说明」用户视角表 | 新增建议 |
| 🟢 | R14 | 二维码分享不可行（8–20 KB 链接 vs QR 上限 ~3 KB），而扫码是订阅分享常见方式 | 文档未提 |
| 🟢 | R15 | `subUrl` 不落盘 → 刷新页面要重填，UX 差 | 建议 sessionStorage 或显式开关 |
| 🟢 | R16 | 竞品表漏了 **Sub-Store**（最直接的竞品）和本次分析的参照工具 | — |
| 🟢 | R17 | 隐私论述漏了：公共后端**访问日志会记录用户机场订阅地址** | 比「别分享链接」更值得提示 |

### 8.3 数据模型细节问题

| # | 位置 | 问题 |
|---|---|---|
| M1 | `RulesetPreset` | 缺 `emoji` 字段，但灵活桶示例是 `📺 YouTube` —— emoji 来源未定义 |
| M2 | `Config.base` | autoSelect / fallback 无 `testUrl` / `interval` / `tolerance` 字段，生成器却写死 `300,,50` |
| M3 | `RegionConfig` | `testUrl?` / `interval?` 可选但缺省值未定义 |
| M4 | `Assignment` | tagged union 无附加字段 → 退化成字符串枚举更简洁；或补上它本该承载的 `{bucket:'flexible', defaultTarget?}`（如 YouTube 默认选香港） |
| M5 | 全局 | 无规则集源切换字段（ACL4SSR / blackmatrix7 / Loyalsoldier），换源要改死数据 |
| M6 | `CustomRule.kind` | 缺 `IP-CIDR6` / `DST-PORT` / `SRC-IP-CIDR`（这些在 Clash 白名单内）<br>⚠️ 注意 `GEOSITE` 只能内联、不能出现在规则集文件里 |
| M7 | `version: 1` | 无迁移策略说明 |
| M8 | `其他地区` | 文档标为 `select`，用户要从一堆杂牌节点里手选，体验差；建议 url-test |
| M9 | `其他地区` 正则 | 「未勾选任何地区」时退化为 `^(?!.*()).*$`（空捕获组），边界未定义 |
| M10 | `toUrlSafeBase64` | 未处理 `=` padding。实测后端遇 `=` 即停，**留着也无妨**。2026 年可用 `Uint8Array.prototype.toBase64({alphabet:'base64url'})` 作 fast path |

---

## 九、公共后端探活（2026-08-20）

| 后端 | 状态 | 版本 | CORS | 备注 |
|---|---|---|---|---|
| `https://api.v1.mk` | ✅ 200 | subconverter **v1.9.9** | `*` | **推荐默认**；`max_allowed_rulesets` 实测不限 |
| `https://api.wcc.best` | ✅ 200 | subconverter **v0.9.0** | `*` | 版本老，`data:` 可用但建议只作备选 |
| `https://sub.xeton.dev` | ❌ 502 | — | — | 已挂 |
| `https://api.dler.io` | ❌ 502 | — | — | 已挂 |
| `https://sub.id9.cc` | ❌ | — | — | TLS 证书链验证失败 |
| `https://sub.d1.mk` | ⚠️ | — | 无 | 不是后端，是广告落地页 |

> `data:` 支持在 v0.9.0 和 v1.9.9 上均可用，说明该特性历史悠久、较稳定。

---

## 十、仍未验证的事项

| # | 事项 | 阻碍 |
|---|---|---|
| U1 | **`exclude_remarks` 在真实订阅 URL 下是否生效** | 无真实机场订阅。这是文档第八节第 2 点的原始待办，仍未结案 |
| U2 | ACL4SSR 仓库维护状态、默认分支、各 `.list` URL 有效性 | 未逐个探测 |
| U3 | 文档预置目录里的 `Anthropic` 条目在 ACL4SSR 中是否存在对应规则集 | 未核实 |
| U4 | mihomo 各客户端（CMFA / FlClash / clashmi）2026 年是否仍不支持本地覆写 | 未核实，文档 L17 声称「已核实」 |
| U5 | 超长 URL（>8 KB）在各移动端客户端输入框 / 数据库中的实际表现 | 需真机测试 |
| U6 | `max_allowed_download_size`（代码默认 1 MB）对 ChinaMax.list 等大规则集的影响 | pref.example.yml 设为 0（不限），但自建后端可能不同 |

---

## 十一、复现脚本

```powershell
# 环境：Windows PowerShell 5.1
$ProgressPreference='SilentlyContinue'

function B64($s){
  [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s)).Replace('+','-').Replace('/','_')
}
function New-SS($tag){
  $u=[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("aes-256-gcm:test")).TrimEnd('=')
  "ss://$u@1.2.3.4:8388#"+[uri]::EscapeDataString($tag)
}
function Get-Body($u){
  $r=Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 90
  [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
}

$nodes = @(New-SS "HK-01 香港"; New-SS "JP-02 Japan"; New-SS "剩余流量：50GB") -join "|"
$enc   = [uri]::EscapeDataString($nodes)

# 注意：PowerShell 双引号 here-string 中反引号是转义符，需写成双反引号
$ini = @"
[custom]
enable_rule_generator=true
overwrite_original_rules=true
add_emoji=false
remove_old_emoji=true
custom_proxy_group=🚀 节点选择``select``[]🇭🇰 香港``[]🇩🇪 德国``[]🌐 其他地区``[]DIRECT
custom_proxy_group=🇭🇰 香港``url-test``(?i)(港|hk|hong ?kong)``http://www.gstatic.com/generate_204``300,,50
custom_proxy_group=🇩🇪 德国``url-test``(?i)(德国|germany)``http://www.gstatic.com/generate_204``300,,50
custom_proxy_group=🌐 其他地区``select``(?i)^(?!.*(港|hk|hong ?kong|德国|germany)).*$
ruleset=🚀 节点选择,[]GEOSITE,youtube
ruleset=🚀 节点选择,[]FINAL
"@

Get-Body ("https://api.v1.mk/sub?target=clash&insert=false&new_name=true&url=$enc" +
          "&config=data:text/plain;base64," + (B64 $ini))
```

**预期观察点**：
- `🇩🇪 德国` 组的 `proxies:` 只有 `DIRECT`（0 命中降级）
- `🌐 其他地区` 不含 `HK-01`（负向前瞻生效）
- `🇭🇰 香港` 含 `HK-01`（`(?i)` 生效）
- `rules:` 含 `GEOSITE,youtube,🚀 节点选择` 与 `MATCH,🚀 节点选择`
- `剩余流量：50GB` **仍在**（裸链接输入下 exclude 不生效）

---

## 十二、建议的修订顺序（供参考，尚未执行）

1. **收敛数据模型**：删 `buckets.*.enabled` 改派生；补 `emoji`、测速参数、规则集源字段（R4 / M1–M5）
2. **重写第七节防错机制**：换成「悬空引用自检 / 组名唯一性 / 分隔符注入校验 / 用户正则合法性」四项，其中前三项已实测证明必要（R1 / R2）
3. **`clash_rule_base` 内联化提到 MVP**，同时显式设置 `add_emoji` / `remove_old_emoji` / `new_name` / `insert`（R3 / R8）
4. **展开重叠检测方案**（第六节），特别是 `DOMAIN-KEYWORD` 的处理与「生成例外规则」第三选项（R5）
5. **风险章节重排**：URL 长度降级为提示；后端 fan-out 延迟升为主要风险；评估 5.1 的 rule-providers 方案（R6 / R7）
6. **补测试策略**；MVP 瘦身 + 预设模板提前（R9 / R10 / R12）
7. **更新第八节**：把本报告第二/三节的核实结论写回，保留 U1 作为唯一未结案项
8. **补充第十二节竞品表**：加入 Sub-Store 与 huanghaiwan 参照工具（R16）
