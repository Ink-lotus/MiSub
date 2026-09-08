# 可视化编辑器的远程规则集在 sing-box 下可用

**状态**：2026-09-08 已在 `test` 分支完成转换、映射、渲染、提示与静态路由修复，并按授权生成 68 份规则集。全量单测、生产构建、sing-box 1.12.0 / 1.13.0 对打包产物的真实下载与规则命中，以及桌面/手机浏览器验收均通过。以下历史调查以本节的复核修订及验收结果为准。

## 2026-09-07 实施复核

- 前置修复已在 `4f35533` 落地，当前最低客户端版本是 **sing-box >=1.12**。前置四组定向测试共 111 项通过；本轮补验 1.12.0 与 1.13.0，详见下方执行结果。
- 本次在已有 `test` 分支就地实施推荐方案 A，不新建分支。生成器采用**离线 snapshot JSON 输入**，保存固定 ACL4SSR revision 的 GitHub API base64 原文及 Git blob SHA；普通 `npm run build` 不联网、不重建规则快照。生成物及来源清单一起纳入版本管理。
- URL tag 沿用当前 `remoteRuleSetUrl()` 的规范化、钉版本结果；转换只改变下载 URL 和 format，跨策略复用及引用一致性必须保留。
- 映射必须限定到生成清单覆盖的路径，不能把任意 ACL4SSR `.list` 改成本站不存在的 JSON。通过 `new URL()` 比较精确主机、仓库及 pathname；扩展名检测不受 query/hash 影响，不使用字符串 `startsWith(origin)` 判断同源。
- 静态路径包含源 revision；来源清单记录源文件与输出文件 SHA-256、转换/丢弃数量。测试同时校验 revision、文件哈希、目录覆盖率及实际输出，阻止换 revision 后继续发布旧快照。后续更新须保留仍被已订阅配置引用的旧 revision 目录，清理需单独决定。
- `.list` 中同一匹配字段合并进数组，不同字段保留为独立 headless rule，保持 OR 语义，避免域名与进程/端口组合成 AND。只忽略注释、空行和 `no-resolve`；已知无法表示的规则明确报告，未知类型、非法值或仅剩空规则的文件直接失败，禁止发布部分成功的快照。所有输入验证完成后才写生成物。
- 用户自填来源不能一概判定失效：原生 sing-box `.json` / `.srs`、可映射的内置来源仍可用；仅对生效卡片中未识别的远程格式提示无法确认兼容，`.list` / `.txt` 提示不兼容且可能导致启动失败。提示以实际来源为准，覆盖修改过来源的内置卡片，排除 off/trash。
- 缺失或非法 `managedConfigUrl` 保留现有透传行为；这只是兼容直接调用的旧行为，不能列为 sing-box 可用的验收结果。从 model.settings 传递的合法 URL 也应被支持。
- 同站静态资源须验证未登录下载、JSON 内容类型及打包后文件可达，不能仅验证 URL 字符串。五个其它渲染器沿用现有 SHA-256 基线，并补有 managed URL 的基线。
- 文档原来的“全部自填 URL 不生效”“只用内置目录即六平台可用”过于绝对；实际能力须按格式、丢弃报告与真客户端验收分别报告。
- 工具实测：`tinyfish fetch content get` 的 markdown/html 输出会折叠 `.list` 原文换行，不能作为可重现的转换输入。改为 `tinyfish` 读取 GitHub contents API 的 base64；超过 1 MB 的文件通过 git blob API 获取。校验字节数和 Git blob SHA 后才能转换，无需规则下载的工具例外。官方客户端下载的工具例外已获本次会话授权。
- 2026-09-08 真实输入试转换：68 份清单共转换 97,400 条，JSON 合计 2,947,292 B。同字段合并前为 7,318,421 B。`ChinaMedia.list` / `ProxyMedia.list` / `Ruleset/Amazon.list` 各丢弃 1 条 URL-REGEX，`Download.list` 丢弃 7 条（保留 15 条）；这 4 份来源必须给出部分覆盖提示。
- 生成物沿用 ACL4SSR 的 CC BY-SA 4.0，附来源、revision、许可链接与转换说明；不混同于应用代码许可。
- 独立审阅补充：合法历史配置允许 `mytoken` / `profileToken` / `customLoginPath` 为 `rulesets`，会抢占本轮静态 URL。入口只对版本化规则 JSON 与许可 README 优先走静态处理，保留其它 token/登录路径；6 项静态路由回归通过。
- 转换器额外拒绝 JavaScript 原型属性名、带 zone 的 IPv6 以及前导零 CIDR prefix，避免输出 sing-box 无法解析的 JSON。当前转换器 30 项测试通过。

### 执行与验收结果

- 批量生成与官方客户端下载均已获得明确授权。已执行 `node scripts/build-singbox-rulesets.mjs --source-file "$env:TEMP/misub-singbox-433381eb-snapshot.json"`，生成 manifest 与 68 个 JSON；`--check` 校验全部 69 份文件可重现。`.gitattributes` 已将 JSON 和 manifest 标记为生成物。
- `npx vitest run` 全量 133 个文件、1,066 项测试通过，包含全部目录来源/产物哈希、映射、静态路由、提示可见且不阻止应用，以及其余五个渲染器的既有字节基线和 managed URL 字节基线。
- 官方 Windows amd64 1.12.0 / 1.13.0 下载至临时目录，分别校验 SHA-256 `49a5b90b390974a87b4660308446dfd9630f60ac655f76383abbd5f0994b09b3` / `c080ac4f53f1e92fe44a5440958bfe6ff6a3db75347fe6b31afc6d6517a8d76e` 后解压。`Invoke-WebRequest` 受 Windows SSPI 凭据错误影响，使用 Node `fetch` 完成同一项已授权的官方下载。未安装、未改 PATH、未启动 TUN。
- 两个版本分别成功执行全部 68 份实际 JSON 的 `rule-set compile`。新增 `scripts/smoke-singbox-rulesets.mjs --client <sing-box.exe> [--client <另一版本>]`：渲染全部来源的配置，仅将入站、无关 DNS 来源和接口探测限制为本机验收设置；两个版本均通过 `check`、HTTP 下载全部 68 份生成物、直连控制请求和 Claude 规则集的精确拒绝命中。
- 实测原始 `.list` 以 `format: source` 加载时，两个版本均非零退出并报 `FATAL ... invalid character 'D' looking for beginning of value: row 1, column 1`，确认是启动失败。验收脚本断言来源 tag 和具体解析错误，保留临时配置/日志并关闭自己的客户端与 HTTP 服务；退出等待有上限，并处理 SIGINT / SIGTERM。
- 用户授权按单个子代理串行重试后，自动审批通过，`npm run build` 成功：Vite 7.3.3，326 个模块，9.10 秒，退出码 0。此前的 Windows 子进程 `EPERM` 未通过修改依赖、构建配置或 CI 处理。
- `dist` 当前 revision 的 68 份 JSON 路径与 manifest 精确一致，全部 SHA-256 匹配；Vite preview 的全部 68 条实际 HTTP 路径均返回 `200` / `application/json` 且响应字节哈希匹配，不需要登录。入口回归额外覆盖历史 `rulesets` token/登录路径冲突。两个版本再以 `--public-dir dist` 运行原生验收，全部下载、启动、直连控制、Claude 命中及非法清单 FATAL 断言通过。
- Playwright 使用本机 Edge 对打包页面在 `1440x1000` 与 `390x844` 视口验收，API 响应使用浏览器内测试数据，未写真实设置。三类 sing-box 提示正确、原生 JSON/SRS 无误报、警告无横向溢出，应用模板成功，页面 JavaScript 错误为 0。已复核关闭动画后的截图；原生格式来源仍需满足编辑器既有的 INI 字符校验。
- 本地静态预览保留在 `http://127.0.0.1:4173/`，未接后端；测试浏览器与原生客户端均已关闭。Surge / Loon / Quantumult X / Egern 无本机客户端，未声称实机验证。
- 实施相关批量操作与下载没有待回复授权。本轮按用户要求提交到本地 `test`，不进行推送或合并。

本节只修订本次实施范围；历史候选和调查数据保留供核对。批量新增生成物、工具例外及任何 Git 提交/远程操作遵守会话授权门禁。

| 项 | 值 |
|---|---|
| 目标 | 本仓库 `main`。**不提上游** —— 带本地生成物与构建期步骤，是本仓库特有能力 |
| 建议分支名 | `feat/singbox-visual-ruleset-hosting` |
| 前置 | `2026-09-05-pr-singbox-renderer-defects.md` **必须先落地**，否则本轮改完也验不出来 |
| 改动面 | `render-singbox.js`、新增构建期转换脚本 + 生成物、`shared/` 一张映射表、测试 |
| 风险 | 中高——要选一个规则集托管来源，三个候选各有实质代价 |
| 前置决定 | 见 §三，**未定不要开工** |

**一句话**：可视化编辑器里的**远程规则集**在 sing-box 下全部不生效。这不是少写了转换代码 ——
配置里只有一个 URL，内容由客户端自己去下载，而 sing-box 读不了 ACL4SSR 的 `.list` 文本清单。
要修就得有人以 sing-box 格式托管同一份内容，所以这一轮的核心是**选托管方案**，不是写代码。

---

## 一、问题：`format: "source"` 指向 `.list`

`render-singbox.js:306` 的 `detectRuleSetFormat()`：

```js
return raw.endsWith('.srs') ? 'binary' : 'source';
```

sing-box 文档明确：`format` 必填，只能是 `source` 或 `binary`，仅当 URL 扩展名是 `json` / `srs`
时可省。而 `source` 指的是 sing-box 自己那套 JSON 结构（`{"version":N,"rules":[…]}`），**不是**
Surge 风格的 `TYPE,value` 文本清单。

卡片里的来源全是 `.list` / `.txt`，于是每一条都被声明成 `format: "source"` 并指向一个非 JSON
文件。实测（默认状态过 `applyRecommendedBuckets` 铺开，贴近真实用法）：

```
rule_set 声明 37 条 | format 分布 {"binary":2,"source":35}
声明 source 但 URL 非 .json/.srs 的: 35 条
例: { "tag": "DIRECT_https://.../Clash/LocalAreaNetwork.list",
      "type": "remote", "format": "source",
      "url": "https://.../Clash/LocalAreaNetwork.list", "update_interval": "24h" }
```

**这大概率不是「静默失效」而是启动失败**：同类报错在 v2rayN #7682 里是
`FATAL[0000] create service: initialize router: parse rule-set[0]: invalid sing-box rule-set file`。
本轮**没有实机确认**远程规则集解析失败时 sing-box 是 FATAL 还是降级重试，执行时先验这一件，
它决定 §七 验收要不要多一层。

命中范围：内置目录的 68 个 ACL4SSR 文件 + 局域网直连 + 两张广告卡片 + 用户自填的一切远程 URL。

---

## 二、为什么只有 sing-box 卡住

这一节是整份文档的前提，别跳。卡片里有两种来源，性质完全不同：

**内联规则**（`ruleset=🎮 我的游戏,[]IP-CIDR,203.0.113.0/24`）—— 值就写在配置里，六种格式全靠
MiSub 自己翻译。这是纯代码问题，归前一轮（`pr-singbox-renderer-defects.md` §1.4）。

**远程规则集**（`ruleset=🛑 广告拦截,https://.../BanAD.list`）—— 配置里只有一个 URL，内容由客户端
自己去下载，**MiSub 从头到尾没碰过内容**。

clash / surge / loon / quanx / egern 五个都能直接吃 Surge 风格的 `TYPE,value` 文本清单，而
ACL4SSR 的 `.list` 正好就是那个格式，所以它们天生就通：

| 格式 | 入口 | 位置 |
|---|---|---|
| clash | `rule-providers` + `format: text` + `behavior: classical` | `render-clash.js:153-161` |
| surge | `RULE-SET,<url>,<policy>` | `render-surge.js:297` |
| loon | `[Remote Rule]` 段 `<url>, policy=…, enabled=true` | `render-loon.js:294` |
| quanx | `filter_remote, <url>, tag=…, force-policy=…` | `render-quanx.js:206` |
| egern | `rule_set: { match: <url>, policy }` | `render-egern.js:279` |

clash 还多一手：能**从 ACL4SSR 的路径推导**出 Provider yaml（`toClashRuleProviderUrl()`，`:66`），
并对 `.list` / `.txt` 正确加上 `format: 'text'` + `behavior: 'classical'`。

sing-box 只认自己那两种格式，文本清单它读不了，而且**没有可推导的等价物** —— ACL4SSR 不发布任何
sing-box 产物。所以这不是「MiSub 少写了转换代码」，是格式不兼容 + 上游不提供，必须有人把同一份
内容以 sing-box 格式托管出来。这就是「供应链」这个词的全部含义。

**上游内置模板路径为什么没暴露这个问题**：它的 sing-box 规则集全部换成了 SagerNet 官方 `.srs`
（`ADS` → `geosite-category-ads-all.srs` 等），根本不碰 ACL4SSR。详见
`pr-singbox-renderer-defects.md` §六。

**为什么这条路我们照抄不了**：那是「换内容」而不是「转格式」，sing-box 用户拿到的是 geosite 近似
分类。这在只承诺 8 个粗粒度键、用户改不了的内置模板里成立；而可视化编辑器卖的恰恰是「逐张卡片
挑你要的那份清单」，68 张卡片 + 用户自填，静默换成别的清单违背用户挑的意思。

---

## 三、要你拍板：托管方案三选一

三个候选，都能让那 68 张卡片在 sing-box 下生效，代价不同。**推荐方案 A。**

| | **A. 构建期自转 + 随 Pages 托管** | **B. 引用 karing-ruleset** | **C. 自建动态转换端点** |
|---|---|---|---|
| 第三方 | **零** | 多一个 | 零 |
| 内容一致性 | 与 clash 侧钉的**同一份** | karing 在另一时间点编译，钉版本后必然 drift | 同一份 |
| 客户端版本地板 | 1.8（source `version: 1`） | 1.8（karing 的 `.srs` 是 v1） | 自定 |
| 覆盖用户自填 URL | 否 | 否 | **是** |
| 新增故障面 | 规则集绑在用户自己的部署域名上 | 见下方「钉版本两难」 | SSRF / 缓存 / CPU |
| 工作量 | 一个构建期脚本 + 生成物进仓库 | 一张映射表 | 独立项目级 |

**A 的具体做法**：构建期把钉住 revision 的 68 个 `.list` 转成 sing-box source JSON
（`{"version":1,"rules":[…]}`），提交进 `public/`，随 Pages 一起发布，客户端从用户自己的 MiSub
域名取。转换是纯文本变换，用的就是前一轮 §1.4 那张类型映射表 —— 复用，不是重复劳动。

- 尺寸不成问题：68 个文件 source JSON 合计 **2,229 KB**（同内容 `.srs` 是 861 KB，但 `.srs` 要
  `sing-box rule-set compile` 二进制，source JSON 纯 JS 就能生成，且地板更低）
- 换 ACL4SSR revision 时 diff 里能直接看出规则变了什么，这是把生成物提交进仓库换来的
- 附带好处：客户端不必能连 `raw.githubusercontent.com`
- URL 从 `managedConfigUrl` 派生，`main-handler.js:1102` 的 `buildManagedConfigUrl(request.url)`
  在真实订阅路径上恒有值；为空时（单测、渲染器被直接调用）退回原始 URL 原样透传

**A 唯一实质的新增故障面**：域名换了、Pages 挂了，sing-box 侧规则集就取不到 —— 其余五个不受影响，
它们直连 GitHub。这是要接受的代价。

**B 的钉版本两难（这是不推荐它的主要原因）**：`KaringX/karing-ruleset` 默认分支是 `sing`（不是
`main`），是 ACL4SSR 的 fork，**`sing` 分支只有一个 commit**（`90965732`，2026-09-04，message 就叫
「Released on」）—— 每次发布 force-push 覆盖。在这种分支上钉 SHA，下一次发布后那个 commit 就成了
unreachable object，raw 还能服务多久没有承诺。**钉 = 可能全线 404，不钉 = 第三方内容不受控。**
加上钉住 ACL4SSR revision 后两边内容必然不同源，「同一个 ACL4SSR 文件、语义一致」这个说法不成立。

**C 留给遗留问题**，见 §八。它是唯一能覆盖用户自填 URL 的方案，但周边工作量在转换之外，本轮不做。

### 两张广告卡片：三个方案下都用上游官方产物，不自建

anti-AD 与 AWAvenue 每日重建，自建等于把日更内容钉成快照，反而更差；而且 anti-AD 转出来是 2–3 MB
的生成物天天变，不该进 git。

| 卡片 | sing-box 用 | 已核实 |
|---|---|---|
| `ad-anti-ad` | `privacy-protection-tools/anti-ad.github.io/master/docs/anti-ad-sing-box.srs` | 783,964 B，头四字节 `53 52 53 02` = **v2 → 地板 1.10** |
| `ad-awavenue` | `TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-Singbox.json` | 28,718 B，`"version": 3` = **地板 1.11**；`-Singbox.srs` 不存在（404） |

**注意**：anti-AD 的 sing-box 文件**不在 `anti-AD` 仓库里**，在 `anti-ad.github.io`。
`privacy-protection-tools/anti-AD/master/anti-ad-sing-box.srs` 实测 404 —— 该仓库默认分支整棵树里
没有任何 `srs` / `sing` 文件，只有 README 的表格提到它。官网镜像 `https://anti-ad.net/anti-ad-sing-box.srs`。

**所以整体客户端地板是 1.11**，由 AWAvenue 定，与选哪个方案无关。这和前一轮 §三 定的 1.11 一致。
想压到 1.10 就把 AWAvenue 也纳入自建（28 KB，可以接受）；压到 1.8 得连 anti-AD 一起，不划算。

---

## 四、已核实的事实（选方案 B 时才需要，留档免得重查）

`sing` 分支 commit `90965732` 的树，用 GitHub API `git/trees?recursive=1` 拉全量后比对：

- `ACL4SSR/` 下 **328 个 `.srs` + 182 个 `.json`**，**保留了 `Ruleset/` 子目录**，与 ACL4SSR 原路径
  一一对应（不是扁平按基名命名 —— 这一点最初记错过）
- 拿目录里那 68 个 ACL4SSR 来源逐个比对：**同路径 `.srs` 缺 0 个，同路径 `.json` 也缺 0 个**
- `ACL4SSR/Ruleset/Telegram.srs` 头四字节 `53 52 53 01`（magic `SRS` + version byte `01`）
  → rule-set **version 1** → 地板 sing-box 1.8.0；它的 `.json` 同样是 `"version": 1`

所以选 B 的话，映射可以写成**纯路径改写**而不是 68 行硬编码表：

```
/ACL4SSR/ACL4SSR/<rev>/Clash/X.list          → /KaringX/karing-ruleset/<rev>/ACL4SSR/X.srs
/ACL4SSR/ACL4SSR/<rev>/Clash/Ruleset/X.list  → /KaringX/karing-ruleset/<rev>/ACL4SSR/Ruleset/X.srs
```

形状与现成的 `toClashRuleProviderUrl()`（`render-clash.js:66`）一样，新增 ACL4SSR 卡片时自动生效。

选 B 还必须做的一件事：**加进钉版本要改两处**。`PINNED_RULE_REVISIONS` 在
`builtin-rules-provider.js:257`，而真正生效的查找表是 `pinRemoteRuleUrl()` 内部的 `revisions`
（`:278`）。只改前者不产生任何钉版本效果。

---

## 五、实现方案（按推荐的 A 写）

### 5.1 构建期转换脚本

新增 `scripts/build-singbox-rulesets.mjs`：

1. 读 `catalog.js` 的 `BUILTIN_CARDS` + `LOCAL_AREA_NETWORK_SOURCE`，取出所有 `kind: 'remote'` 的
   ACL4SSR URL（当前 68 个，别硬编码清单，让它跟着目录走）
2. 按 `pinRemoteRuleUrl()` 钉到 `PINNED_RULE_REVISIONS.ACL4SSR` 后拉取
3. 逐行转成 sing-box headless rule，写 `{"version":1,"rules":[…]}`
4. 输出到 `public/rulesets/singbox/<相对路径>.json`，保持 ACL4SSR 的目录结构

行级映射复用前一轮 §1.4 那张表。`.list` 里出现的、sing-box 没有对应字段的类型（`USER-AGENT`、
`URL-REGEX` 等）**丢弃并计数**，脚本末尾打印每个文件丢了多少行 —— 这个数字要看一眼，某个文件丢
太多说明它本来就不该给 sing-box 用。

`no-resolve` 修饰符丢弃，理由同 `rule-modifiers.js:20-21`。

### 5.2 渲染器改动

新建 `shared/singbox-ruleset-map.js`（放 `shared/` 是为了将来换键时不用搬家；`shared/` 已被两侧
分别 import —— `functions/modules/dns-template-handler.js:5` 引 `shared/safe-dns.js`，
`DnsTemplateManager.vue:5` 引 `shared/dns-template-validation.js`）：

```js
// 输入 = 卡片里写的来源 URL；输出 = sing-box 用的 URL，认不出来就返回 null
export function toSingboxRuleSetUrl(sourceUrl, { origin }) { /* … */ }
```

- ACL4SSR URL → `${origin}/rulesets/singbox/<相对路径>.json`
- 两张广告卡片的 URL → 硬编码成 §三 那张表里的官方产物
- 其余（用户自填）→ `null`

`buildRuleSets()` 里只改两个字段：

```js
const singboxUrl = toSingboxRuleSetUrl(rule.value, { origin }) || rule.value;
return {
    tag: sanitizeTag(rule.value),        // ← 前一轮已改成只从 URL 派生，本轮不再动
    type: 'remote',
    format: singboxUrl.endsWith('.srs') ? 'binary' : 'source',
    url: singboxUrl.startsWith(origin) ? singboxUrl : pinRemoteRuleUrl(singboxUrl),
    …
};
```

`tag` 不动是关键：`mapRuleToSingbox()` 与 `buildRuleSets()` 都从原始 `rule.value` 派生 tag，只改
`url` / `format` 两边就照旧对得上。**前提是前一轮的 §1.5 已经把 tag 改成只从 URL 派生**，否则这里
要连带处理 policy，两处得同步改。

`origin` 从 `options.managedConfigUrl` 取 `new URL(...).origin`；为空时 `toSingboxRuleSetUrl` 对
ACL4SSR 也返回 `null`，走原样透传 —— 单测与渲染器直接调用的场景由此保持可跑。

### 5.3 用户自填远程 URL 的可见提示

本轮修不掉用户自填的 URL（见 §八），所以必须附带一条可见提示，把静默失效变成明说的限制：在
`src/utils/rule-generator/validate.js` 里，对 `origin === 'user'` 且含远程来源的卡片加一条 `warn`
（「这条来源在 sing-box 下不生效」）。几行的事，但它是本轮唯一让用户知道边界的手段。

---

## 六、测试

新增用例挂在 `tests/unit/rule-generator-render-matrix.test.js`。

| 用例 | 钉住什么 |
|---|---|
| 内置目录的 ACL4SSR 卡片在 sing-box 下 `url` 指向本站 `/rulesets/singbox/…json`、`format: source` | §五 主路径 |
| 每个生成的 `.json` 都能 `JSON.parse` 且有 `version` / `rules` 两个键 | 转换脚本的产物形状 |
| 生成物覆盖目录里全部 ACL4SSR 来源，一个不缺 | 防「加了卡片忘了跑脚本」。**这条最有价值** |
| 两张广告卡片指向 §三 表里的官方 URL，且那两个 URL 不被 `pinRemoteRuleUrl` 改写 | 它们刻意不钉版本，每日重建 |
| 表里没有的 URL（用户自填）原样透传，不抛错 | 降级路径 |
| `managedConfigUrl` 为空时 ACL4SSR 也走原样透传 | 单测与直接调用渲染器的场景 |
| `validate.js` 对含远程来源的用户卡片给出 warn | §5.3 |
| 其余五个渲染器的产物在改动前后逐字节相同 | 范围约束。改动前先存基线 |

转换脚本本身也要一个用例：喂一小段构造的 `.list`（含一条会被丢弃的 `URL-REGEX`），断言输出的
`rules` 内容与丢弃计数。不要在单测里打网络。

---

## 七、验收：修完之后成立到什么程度

分层写，因为确定性不一样。**不要把这几层混着说成「六平台通用」。**

**层 0 — sing-box 能启动。** 由前一轮负责。本轮开工前它必须已经绿。

**层 1 — 配置形状正确。** 修完即成立，单测可验证。

**层 2 — 客户端能消费远程清单。** clash 已实测（`behavior: classical` + `format: text`）。
sing-box 本轮要**实机验一次**：确认 source JSON 能被拉取并生效，且规则真的命中。
surge / loon / quanx / egern 四个消费的都是 Surge 风格清单，把握较大但**没有实机验证过**，
执行时各过一遍，尤其 quanx 与 egern。

PR / 提交信息里不要写「六平台验证通过」，除非真跑过。

**层 3 — 能力范围。**

| 场景 | 结果 |
|---|---|
| 只用内置目录卡片的方案 | 六平台可用 |
| 自建**内联规则**卡片 | 六平台可用（前一轮修完后） |
| 自建**远程 URL** 卡片 | **sing-box 下仍然不生效**，其余五个可用 |

最后一格是本轮修不掉的，靠 §5.3 的 warn 明说。

---

## 八、遗留：怎么补上最后一格

**MiSub 自建转换端点。** 一条路由拉上游文本清单 → 转成 sing-box source JSON → 缓存 → 返回。唯一能
覆盖任意用户 URL 的方案。工作量在周边不在转换（转换逻辑本轮的构建期脚本已经写好，可以直接复用）：

- **SSRF**：必须白名单主机或 HMAC 签名 URL，否则是开放代理
- **缓存**：anti-AD 那类 3.35 MB 清单不能每客户端每天回源；可抄 `github-proxy-handler.js` 的
  KV + timestamp，或 `cf: { cacheTtl, cacheEverything }`
- **CPU / 内存**：10 万行必须走 `TransformStream` 流式，不能整块 buffer 再 `JSON.stringify`

这条路通了之后顺带能解决 Clash 侧 `behavior` 硬编码 `classical` 的问题。

**接法 C（服务端读注释头）不能替代它。** INI 里 `; misub-visual-state-v1:` 那行 base64 是完整卡片
状态，现在只有前端 `parse.js` 在读，服务端 `ini-template-parser.js:11` 把 `;` 开头的行整行跳过。
服务端也读它的话能拿到**卡片身份**（`ad-basic`、`ai-openai`…）而不只是 URL —— 但那只对「上游自己
发布了 sing-box 产物」的卡片有用，**ACL4SSR 不发布**，那 68 张卡片照样要靠 §三 的方案，用户自填的
URL 更是完全帮不上。所以接法 C 不解决本轮的问题，也不解决最后一格，价值有限，暂不排期。

---

## 九、操作步骤

1. 确认前一轮（`pr-singbox-renderer-defects.md`）已落地并全绿
2. 先验 §一 末尾那件事：远程规则集解析失败时 sing-box 是 FATAL 还是降级重试。这决定层 2 怎么写
3. 确认 §三 的托管方案，**未定不要动手**
4. `git switch -c feat/singbox-visual-ruleset-hosting`
5. 改动前先存六个渲染器的产物基线（五个用来钉「逐字节不变」）
6. 顺序：转换脚本（§5.1）→ 映射表 + 渲染器（§5.2）→ warn（§5.3）
7. 每一步按 §六 补对应用例
8. `npx vitest run` 全绿 + `npm run build` 通过
9. §七 层 2 的真客户端验证
10. 停下报告，**不要自行 commit / push / 合并**

## 十、注意事项

- **生成物要不要进 git 是个真决定**：进 git = 部署可重现、换 revision 时 diff 可审计、构建不依赖
  网络；不进 = 仓库干净但构建期必须能连 GitHub。本文按「进 git」写，改主意的话 §5.1 的输出目标和
  §六 那条「覆盖全部来源」的用例都要跟着调
- **`.gitattributes` 记一笔**：`public/rulesets/**` 标 `linguist-generated`，否则 GitHub 上的 diff
  和语言统计会被 2 MB 生成物淹掉
- 换 `PINNED_RULE_REVISIONS.ACL4SSR` 时必须重跑转换脚本，否则 clash 侧换了新 revision、sing-box
  侧还是旧内容 —— 这正是方案 B 那个 drift 问题，方案 A 只是把它变成了「一条能在 CI 里检查的约束」。
  值得加一个断言：生成物里记下当时的 revision，与 `PINNED_RULE_REVISIONS.ACL4SSR` 不一致就让测试红
- `pinRemoteRuleUrl()`（`builtin-rules-provider.js:268`）只对表里的仓库生效，非表内 URL 原样返回。
  anti-AD / 秋风刻意不钉，它们每日重建
- **起点状态**：本文行号基于 `3debf8c`（`main`）。§5.2 假定前一轮已经把 `rule_set` tag 改成只从
  URL 派生；若前一轮改了主意保留 policy，§5.2 的代码片段要跟着改
- sing-box 源格式版本对照：1→1.8、2→1.10、3→1.11、4→1.13、5→1.14。生成物写 `version: 1`
  是刻意的 —— 我们只用最基础的那几个 rule item，没有理由抬高地板
