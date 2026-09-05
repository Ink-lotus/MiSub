# 上游融合阶段二：机械合并 97 个提交 + DNS 收敛

**状态**：阶段 A（机械合并）与阶段 B（DNS 收敛）均已完成（2026-09-04）。
分支 `merge/upstream-20260904`，尚未合回 main。**后续工作先读第九节。**

**核实基准**：
- 阶段 A 部分写于 `08a1700` 之后，阶段 B 部分补于 `30514e7` 之后，所有数字为实测值而非估算
- 上游 `imzyb/MiSub` main = `1008b7c`（2026-09-02 00:37）
- 共同祖先 = `5f60563`（2026-07-30，`Merge pull request #431`）
- 合并规模：98 files，+3943 / −436
- 前置设计见 [`2026-09-02-dns-upstream-merge-design.md`](./2026-09-02-dns-upstream-merge-design.md)，本文承接其第九节

**提交序列**：

| 提交 | 内容 |
|---|---|
| `08a1700` | 合并上游 97 个提交，解 7 处冲突 |
| `9ac95f1` | 本文档初版 + 更正 DNS 文档失效的分叉数字 |
| `bc0890c` | DNS 以我们的模板库为基线，「DNS 走代理」改为可配开关 |
| `30514e7` | DNS 走代理复用入口组，规则生成器不变量回归 |

## 一、修正前置文档的一处过时断言

DNS 融合设计 §8.3 写「我们的 main 与上游共同祖先停在 2025-06-17，领先 1529 个提交、142 个文件不同」。**该数字已失效**：`backup/pre-replay-20260902` 这条分支表明 2026-09-02 做过一次历史 replay，祖先被推到了 `5f60563`（2026-07-30）。

实测：上游领先 97 个提交，我们领先 27 个，20 个文件双方都改过。因此整体 `git merge` 完全可行，不需要 §8.3 设想的「手工搬运几个文件」那套规避方案。

**注意**：§8.3 的结论本身仍然成立——给上游发 PR 时依旧要从 `upstream/main` 开干净分支，因为我们领先的 27 个提交里混着规则生成器与 DNS 模板仓库。只是理由从「1529 个提交太多」变成「27 个提交内容不相关」。

## 二、冲突面：7 处

`git merge-tree` 预先在内存里试算过一遍（不碰工作树），与实际合并结果完全一致。

| # | 文件 | 性质 | 解法 |
|---|---|---|---|
| 1 | `functions/modules/subscription/main-handler.js` | 假冲突（两处） | 两侧意图并存：`customDns`（我们）与 `customDnsOverride` + `dnsMode`（上游）同时透传给渲染层 |
| 2 | `functions/modules/subscription/template-renderers/render-clash.js` | import 行 | 两个 import 都留，`ruleModifierSuffix` 与 `resolveSafeDnsConfig` 各自被用到 |
| 3 | `functions/services/processor-service.js` | import 行 | 同上；`clashFix` 在 `:121`（我们的路径）、`resolveSafeDnsConfig` 在 `:92`（上游路径），两者都是活代码 |
| 4 | `tests/unit/builtin-clash-generator.test.js` | 假冲突 | 双方各自新增的用例都保留 |
| 5 | `tests/unit/builtin-loon-generator.test.js` | 假冲突 | 同上 |
| 6 | **`render-loon.js`** | **真语义冲突** | 见 2.1 |
| 7 | `wrangler-cf-pages.toml` | modify/delete | 见 2.2 |

### 2.1 `render-loon.js`：重构 vs 特性

唯一一处双方动了同一段代码、意图不同的冲突。

- **上游**（`14b5d08`、`649660d`）把 RULE-SET 的产出从 `buildRuleLine` 里剥出去，新增 `buildRemoteRuleLine`，改用 Loon 的 `[Remote Rule]` 段格式（`value, policy=..., enabled=true`）。因此 `buildRuleLine` 里 RULE-SET 分支改为返回 `null`
- **我们**（`3123930`）在 `buildRuleLine` 里加了 `ruleModifierSuffix(rule)`，给 IP 类规则按白名单透传 `no-resolve`

解法：**取上游的拆分结构，把我们的修饰符重新贴到 GEOIP 与通用分支上**。两个意图都完整保留。

判定依据：调用点 `:323` 在 `.map(buildRuleLine)` 之前已经过滤掉 RULE-SET，所以我们原来那条 `RULE-SET → 'RULE-SET,...'` 分支在模板路径上本就是死代码；`buildRemoteRuleLine`（`:331`）是唯一的 RULE-SET 出口。全文件只有这两处活调用点。

### 2.2 `wrangler-cf-pages.toml`：接受上游的修复版

按 DNS 文档 §9.3 的建议执行：接受上游 `f523295` 修好语法的版本，当作**部署意图文档**保留；本地开发行为继续由 `wrangler.jsonc` 决定。

两份文件可以共存，因为 wrangler 只自动识别 `wrangler.toml` / `.json` / `.jsonc`，`wrangler-cf-pages.toml` 这个文件名对工具链是惰性的。而 `wrangler.jsonc` 刻意不写 `pages_build_output_dir`，Cloudflare Pages 因此不会把它当生产配置的唯一来源，面板里的 KV / D1 绑定与环境变量照旧合并进部署。

两份的 `compatibility_date` 不一致（上游 `2024-04-01` vs 我们 `2026-07-20`）**是预期的**，后者对齐面板实际值。

## 三、两处断言随上游有意的行为变更更新

阶段 A 的验收口径不是「产物逐字节不变」——上游 `5dc262f` 在 clash 生成器里把 `allow-lan` 由 `true` 改 `false`、加 `bind-address: 127.0.0.1` 与 `ipv6: false`、把 `external-controller` 从 `:9090` 收窄到 `127.0.0.1:9090`。这些是安全加固，照收就必然改变产物，而照收正是合并的目的。

口径是：**我们的 DNS 模板功能行为不变 + 上游改进照收**，被上游有意改掉的默认值跟着改并更新断言。共两处：

### 3.1 `node-transformer.test.js`：继承上游自带的红灯

DNS 文档 §9.1 预测的红灯确认存在，且**在纯净 `upstream/main` 上同样失败**（可 `git checkout --detach upstream/main` 后单跑该文件复现）。

成因是上游 `b477c8b` 给 `isUselessNode` 加了 `isVirtualInfoNode` 放行分支（`node-transformer.js:273-279`），流量剩余 / 到期时间这类系统虚拟信息节点从此不再被 useless 过滤器剔除，但测试仍断言旧行为。功能改了、测试没跟。

改法：`toHaveLength(3)` → `4`，`流量剩余` 节点改为预期存活。逐条推演：

| 节点 | 判定 | 结果 |
|---|---|---|
| vmess `US Node 01` | 非 useless | 留 |
| trojan `HK Node 01` | 非 useless | 留 |
| ss `到期提醒` | 该词不在 useless 正则里 | 留 |
| trojan `流量剩余 ≫ 12GB` @ `127.0.0.1:443`，全零 UUID | 满足 `isVirtualInfoNode` 四项 → 主动放行 | **留**（旧行为：剔除） |
| trojan `套餐到期：2026-12-31` @ `info.example.com` | server 非 `127.0.0.1`，不满足虚拟节点特征；`套餐到期` 命中通用 useless 正则 | 剔除 |

共 4 条存活。

**这条值得单独给上游提一个小 PR**——他们自己 main 上的 CI 现在就是红的。但**不要现在提**：按项目决定，所有对上游的 PR 都要等上游更新全部合并完之后再统一考虑。

### 3.2 `builtin-conversion-matrix.test.js`：内置默认 DNS 换源

原断言期望远程模板产出 `https://dns.alidns.com/dns-query` / `https://doh.pub/dns-query`。排查后确认这**不是**用户写的模板 DNS——该用例的 fetch mock 返回的是 INI 模板（`[Proxy Group]` / `[Rule]`），根本没有 `dns:` 块，那两个地址是**合并前硬编码在生成器里的内置默认值**。

合并后内置默认值由 `resolveSafeDnsConfig` 合成，变为 `udp://8.8.8.8:53#🌐 DNS 出口` 等。

改法：更新为新的默认值，并**补一条 `expect(dns.nameserver).not.toContain('9.9.9.9')`**，把该用例的真实意图（「`customDns` 只作用于内置预设，不作用于远程模板」）显式化。原断言只是间接地通过「等于某个默认值」表达这个意图，默认值一变就误导人；补上的这条才是用例名字所说的那件事。

## 四、`🌐 DNS 出口`：阶段 A 接受上游原样，阶段 B 已推翻

> **本节记录的是阶段 A 当时的判断。结论已在阶段 B 被推翻**，最终形态见第八节。
> 保留本节是因为「它在上游是承重件」这个事实仍然成立，也是阶段 B 方案的前提。

DNS 文档 §7 曾把它列为三选一（A 不引入 / B 做成生成器里的可勾选基础组 / C 照上游自动注入），并倾向 A、标注 C「不建议」。**合并把这个判断推翻了**：它在上游不是可选装饰，而是承重件。

结构性依赖点：

| 位置 | 依赖形态 |
|---|---|
| `builtin-rules-provider.js:34` | `POLICY_GROUPS` 的正式成员 |
| `builtin-rules-provider.js:110` | 参与 fail-closed 判定 |
| `builtin-rules-provider.js:486` | sing-box rule-set 的 `download_detour` |
| `template-processor.js:195-198` | `ensureDnsProxyGroup` 自动注入 |
| `safe-dns.js:160/164/194/250` | `nameserver` 条目带 `#🌐 DNS 出口` 后缀 |
| `render-singbox.js:321/342/368/371` | outbound tag 与 detour |

关键在最后一类：`nameserver` 条目**带后缀引用这个组**，拆掉组就等于让配置引用一个不存在的组。上游测试也直接断言它存在（`builtin-clash-generator.test.js:32`、`builtin-singbox-generator.test.js:48/72/88`、`builtin-template-rules-audit.test.js:156`、`custom-template-and-dns-override.test.js:62` 注释写明「保留 DNS 出口策略组以供 nameserver 引用」）。

所以方案 A 在合并语境下不是「少做一件事」，而是「主动拆掉上游 DNS 设计的承重件并改掉他们 4 个测试文件，且每次同步都要重做一遍」。阶段 A 的取舍结论：**接受上游原样**，即落到方案 C。

**注入条件值得记住**：`template-processor.js` 是 `if (!hasCustomDns) ensureDnsProxyGroup(model)`，而 `hasCustomDns` 读的是上游的 `settings.customDnsOverride`。我们的 DNS 模板写的是自己的 `customDns` 字段，**永远不会让该条件为真**，因此这个组在我们的模板渲染路径上恒定出现。且它的成员是全部节点名（`proxyNames.length > 0 ? proxyNames : ['REJECT']`），非空，`pruneEmptyGroups` 也剪不掉。

**当时已付的代价**：规则生成器「策略组 = 卡片派生」这个不变量暂时打破，产物里会出现生成器预览中看不到的组。实测我们的规则生成器测试**未被打红**（`rule-generator-render-matrix.test.js` 等用的是按名 `.filter(group => group.name === X)` 定位，不做穷举计数），所以这是产品一致性问题而非功能故障。

**阶段 B 找到了第四条路**（既不拆承重件、也不留多余组）：见 8.3。那一节同时更正了本节的一处隐含假设——本节默认「这个组不显示给用户」，实测在模板路径上它是**可见的**。

## 五、13 个静默自动合并文件的语义审计

20 个双方都改过的文件里，13 个文本层面自动合并成功。**自动合并是本次合并真正的风险来源**——文本各自成立不等于语义正确，而两侧测试各测自己的路径，交叉行为可能无人覆盖。逐个审计结论如下，**无一需要修补**。

| 文件 | 审计结论 |
|---|---|
| `functions/storage-adapter.js` | 见 5.1 |
| `builtin-clash-generator.js` | 两套 DNS 机制并存，见 5.2 |
| `builtin-singbox-generator.js` | 与 clash 同形态：`buildSingboxDnsConfig(customDnsOverride)` 在 `:353` 先写，`customDns.singbox` 在 `:387` 后覆盖。非互相破坏 |
| `builtin-surge-generator.js` / `render-surge.js` | 只有 `customDns?.surge`（`:468`）与裸 `dns-server` 行。上游从未把 surge 接进 DNS 引擎（与 DNS 文档 §二「上游只支持 clash + sing-box」一致），无重叠 |
| `functions/modules/config.js` | `customDnsOverride` / `dnsMode` **两侧从来都没有**，不存在合并丢失。上游对该文件的唯一改动是会话时长（`SESSION_DURATION` 7d→30d，新增 `SESSION_RENEW_THRESHOLD`），已正确合入 |
| `src/constants/default-settings.js` | `customDnsOverride: ''`（来自上游）正常。后端从存储的 settings 对象直接读（`config.customDnsOverride \|\| ''`），不依赖 `config.js` 兜底，与上游行为一致 |
| `functions/modules/webdav-backup-handler.js` | DNS 模板双向覆盖：备份走 `readBusinessData:97` 的 `listDnsTemplates`，恢复走 `:237` 的 `KV_KEY_DNS_TEMPLATES` |
| `src/i18n/messages.js` | 见 5.3 |
| `functions/modules/api-handler.js` | 设置保存与双存储同步，测试覆盖，全绿 |
| `main-handler.js` 残余部分 | 冲突外的自动合并段落，测试覆盖 |
| `tests/unit/builtin-{clash,singbox,surge,loon}-generator.test.js` | 断言口径两侧不同，合并后全绿 |

### 5.1 `storage-adapter.js`：最高风险项，审计通过

两侧各改约 100 行同一文件却文本无冲突，纯属巧合，必须人工审。

- **我们**：`09e69d8` 修 KV→D1 迁移漏搬业务数据（+88/−18）
- **上游**：`88fa9e5` D1 collection 读缓存（+97/−44）

风险假设：如果迁移的写入绕过缓存失效，迁移后读取会拿到陈旧空值，等于**换一扇门重新引入静默丢失**。

逐项核实结论——不成立：

1. 缓存只覆盖 `subscriptions` / `profiles` 两张表（`D1_COLLECTION_CACHE_TTL_MS` 30s），**`settings` 表完全不缓存**
2. 我们迁移搬的业务键（`misub_dns_templates_v1`、`misub_rule_templates_v1`、`misub_clients_v1`、`misub_guestbook_v1`、`misub_settings_v1`、`misub_restore_snapshot_latest`、`misub_profile_download_count_*`）经 `_parseKey` 全部落 `settings` 表 → 不在缓存范围，无陈旧读风险
3. 迁移搬 `subscriptions` / `profiles` 时全程走 `d1Adapter.put()`，而失效钩子就在 `put()`（`:287-289`）与 `delete()`（`:305-307`）内部 → 正确触发
4. 行级方法 `putSubscription` / `putProfile` / `updateSubscriptionById` / `deleteSubscriptionById` / `deleteProfileById` 各自失效；`putAllSubscriptions` / `putAllProfiles` 逐项委派给行级方法，**不漏失效**
5. 遗留主行迁移里的裸 SQL 路径（`:921`、`:936`）上游补了显式 `invalidateD1CollectionCache`
6. 我们的 `D1_KNOWN_SETTINGS_KEYS` 白名单在 `_parseKey` 里完整存活，位置仍在「未知格式」告警兜底之前

### 5.2 `builtin-clash-generator.js`：两套 DNS 机制并存

合并后同一个 `config.dns` 字段有两个写入方：

1. 上游 `resolveSafeDnsConfig(options.customDnsOverride, ...)` 在构造 config 时写入
2. 我们 `options.customDns?.clash` 在 `:234` 之后覆盖

**我们靠执行顺序确定性地赢**，所以 DNS 模板功能行为不变。但这留下两个设置项抢一个字段的局面：`customDnsOverride`（上游，全局单值）在模板生效时是死的，无模板时又活过来。**这正是阶段 B 要收敛的东西**（已完成，见 8.1）。

同时留下一段引用 `customDnsOverride` 的剪组逻辑（`:199-203`），语义上与我们的模板路径无关。阶段 B 移除用户入口后该分支不再可达，但保留未删——它是上游代码，留着降低下次同步的冲突面。

### 5.3 `i18n/messages.js`：零键丢失

自动合并的 i18n 最容易出两类问题：丢键，以及重复键（JS 对象字面量静默容忍、后者覆盖前者，测试也测不出来）。用脚本把合并结果与两侧父提交的键集逐一比对：

| locale | 我方 | 上游 | 合并后 | 丢失我方键 | 丢失上游键 |
|---|---|---|---|---|---|
| `zh-CN` | 1252 | 1143 | 1268 | **0** | **0** |
| `en-US` | 1248 | 1139 | 1264 | **0** | **0** |

中英对齐：4 个键仅 `zh-CN` 有（`manualNodes.batchMoveGroupTitle`、`manualNodes.batchMoveGroupDesc`、`manualNodes.groupName`、`subscriptions.importedCount`）。核实为**上游既存的不对齐**——两侧父提交里各自都是 4 个差额，且这 4 个键在两份父文件里都只出现一次。非合并引入，不在本阶段范围内。

## 六、阶段 B 交接（已完成，落点见第八节）

> 本节是阶段 A 结束时写下的四项待办。**四项均已在阶段 B 完成**，逐项标注结论；
> 实施细节与推翻的判断见第八节。保留原文是为了让「当时预计什么、实际做了什么」
> 的差异可查。

阶段 A 刻意不碰 DNS 语义。以下是留给阶段 B 的四件事，按依赖顺序排列。

### 6.1 两套 DNS 设置收敛（主体工作）

现状：`customDnsOverride`（上游，全局单值，走 `functions/modules/subscription/safe-dns.js`）与 `customDns` + DNS 模板仓库（我们，多模板 + profile 级覆盖，走 `shared/safe-dns.js`）并存，同写 `config.dns`，我们靠执行顺序赢。

需要决定的是产品语义，不只是代码：一个用户同时设了全局 `customDnsOverride` 和一个 DNS 模板时，期望是什么？候选方向包括「把 `customDnsOverride` 降级为一个内置模板」、「让它成为模板选择为 `builtin` 时的回落值」、「彻底移除并提供一次性迁移」。

> **结论（`bc0890c`）**：以我们的模板库为基线，删掉上游那套**用户入口**（`DnsOverrideCard.vue`、
> `settings.customDnsOverride` 默认值、9 个 i18n 键），但**保留其引擎**作为无模板时的
> 安全默认。理由是我们的方案是上游的超集（5 格式 vs 2、多模板 + profile 级覆盖、
> 策略/高级双模），而引擎产出的 17 键安全块比合并前硬编码的 6 键强。
> 上述三个候选方向都没采用——见 8.1 说明为什么不做迁移。

### 6.2 `shared/safe-dns.js` 必须人工 diff 上游那份

`shared/safe-dns.js` 是上游 `safe-dns.js` 的改造拷贝（去掉 `DNS_PROXY_GROUP` 后缀、可被前后端共同 import），**不会自动跟随上游更新**。

阶段 A 之后仓库里同时存在两份：

- `functions/modules/subscription/safe-dns.js` — 上游原版，随合并更新到 `1008b7c`
- `shared/safe-dns.js` — 我们的改造拷贝，停在拷贝时的上游状态

上游这 97 个提交里有 6 个落在 DNS 区域（`1180385` 原始实现、`5dc262f` / `23393d6` / `9e12708` / `788174f` / `439c002` 五个加固）。**必须逐一确认这些修复有没有进到 `shared/` 那份里**，没进的挑进来。

**这项的定位是复查而非移植**：F3 落地时已对照过上游当时的实现，这些加固可能大部分已在 `shared/safe-dns.js` 里。开工时先逐个提交比对确认，别默认要重做一遍。

如果 6.1 的收敛结论是「统一到一份」，这个问题自然消解——这也是把 6.2 排在 6.1 之后的原因。

> **结论（`bc0890c`）**：问题按预测的方式自然消解，但路径不同。既然「DNS 走代理」
> 改由调用方传 `proxyGroup` 表达（传空串即不加后缀），原先那套「方案 A 改造」
> 就没必要了——`shared/safe-dns.js` **重建为上游镜像**，与上游那份的差异只剩
> 文件头注释与 `resolverHost` 导出两处。逐个比对上游 6 个 DNS 提交因此不再需要：
> 拷贝就是上游本体。以后同步只需 `diff` 一次确认差异仍是那两处。

### 6.3 `🌐 DNS 出口` 的最终归属

第四节记录了代价：生成器预览与实际产物不一致。DNS 文档 §7 的方案 B（在生成器顶栏加一个与 `♻️ 自动选择` 同级的可勾选基础组）是恢复不变量的路径，改动面为 `catalog.js` 的 `GROUP_NAMES`、`serialize.js` 的组装配与计数、i18n、若干测试。

> **结论（`bc0890c` + `30514e7`）**：方案 B 也没采用。最终形态是**第四条路**——
> 复用模型里已有的入口组，一个新组都不产出，`serialize.js` / `catalog.js` /
> `validate.js` 全部零改动。完整推导见 8.2 与 8.3。

### 6.4 交叉行为缺测试

两套 DNS 机制**同时有值**（模板选中 + `customDnsOverride` 非空）时的行为目前无人覆盖：上游测试只设 `customDnsOverride`，我们的测试只设 `customDns`。代码审读结论是「我们的覆盖在后、确定性地赢」，但这是读出来的而非测出来的。收敛时补一条定向测试，而不是现在加——现在加等于把待废弃的行为固化成断言。

> **结论（`bc0890c`）**：预判成立——`customDnsOverride` 的用户入口已删，
> 「两套机制同时有值」不再是可达状态，因此没有补这条测试，符合「不把待废弃的
> 行为固化成断言」的初衷。取而代之的是 8.4 那批围绕开关与不变量的测试。

## 七、阶段 A 的验证与回退

**验证**（实测值。阶段 B 的数字见 8.5）：

| 项 | 基线（`d00e483`） | 合并后（`08a1700`） |
|---|---|---|
| 测试文件 | 120 passed | **127 passed** |
| 测试用例 | 785 passed | **842 passed** |
| `npm run build` | 通过 | **通过**（7.00s） |

**回退**：阶段 A 与阶段 B 全部落在分支 `merge/upstream-20260904`（合并提交 `08a1700`，双父 `d00e483` + `1008b7c`；阶段 B 为其后的 `bc0890c`、`30514e7`）。`main` 与 `origin` 全程未动，弃掉该分支即完全回退。

**合并回 main 与推送均待定**：按项目决定，要等上游更新全部合并完、确认无问题之后再做。同理，向上游提 PR（含 3.1 提到的红灯修复）也一并推迟到那时。

## 八、阶段 B：DNS 收敛（`bc0890c` + `30514e7`）

> 本节于 2026-09-04 追加，记录阶段 B 的四项实施与两处被推翻的判断。

### 8.1 以我们的模板库为基线，去掉上游的用户入口

合并后 `config.dns` 有两个写入方（见 5.2），我们靠执行顺序赢——也就是说上游那个
设置项**在模板生效时是静默失效的**，用户改了不生效且无从得知。

去到哪一层是个取舍。**只去用户入口，保留安全默认引擎**：

| 删 | 留 |
|---|---|
| `DnsOverrideCard.vue` 及挂载点 | `resolveSafeDnsConfig` / `buildSingboxDnsConfig` |
| `settings.customDnsOverride` 默认值 | 生成器里的 `customDnsOverride` option（收空值即产出安全默认） |
| 9 个 `dnsOverride*` i18n 键（中英各一份） | 上游那 4 个测试文件的断言 |
| `main-handler` 两处对 `config.customDnsOverride` 的回读 | |

保留引擎的理由：它产出 17 键安全块（fake-ip、`nameserver-policy` 按 geosite 分流、
`proxy-server-nameserver`、`fallback-filter`），而合并前硬编码的默认只有 6 键；
且我们的策略模式本就是这个引擎，丢掉它等于自断默认正确性。

**不回读残留值是刻意的**：界面已删，若仍回读 `config.customDnsOverride`，老配置会
无声生效而用户无处可改。存量值留在 settings 对象里不动（不删用户数据），但已是死字段。
曾设过它的用户升级后全局 DNS 退回内置默认，改用 DNS 模板即可——**没做自动迁移**，
因为 6.1 列的三个候选方向都要引入「两个入口的映射关系」，与「只留一个入口」自相矛盾。

### 8.2 高级模式的整块替换：行为不改，补告警

排查时实测出一个真实落差：高级模式（原名「手写整块」）的内容会**整块替换** `dns`
（`processor-service.js` 的 `applyCustomDnsToBuiltinPreset`：`config.dns = parsedDns`），
只写 `nameserver` 的模板产出 **2 键** dns，对照默认 **17 键**——`enhanced-mode`、
`nameserver-policy`、`proxy-server-nameserver`、`fallback-filter` 全丢，国内域名会走
国外解析器。语法完全合法、`validateDnsTemplateField` 判 `valid`，所以无效回退链不触发。

回退链本身实测完好（这一点原先只是推断）：

| 输入 | 行为 |
|---|---|
| 无法解析的 YAML | 生成器 catch，产出 17 键安全默认 |
| 是数组而非映射体 | 同上 |
| 模板字段无效 | `filterValidDnsTemplateFields` 清成空 → 不覆盖 |
| 引用已删除的模板 | `resolveEffectiveDnsConfig` 返回 `null` → 不覆盖 |

判定：**「填错会回退，填少是故意」**，因此行为不改，只在编辑器里告警。
`shared/dns-template-validation.js` 新增 `collectMissingSafetyKeys`，只报
clash 4 键 + singbox 2 键这些「缺了有实际后果」的，不报全部 17 键（否则成噪音）；
空值与解析失败都不报，避免与格式错误重复。纯 warn，不参与 status、不拦保存。
策略模式不显示——块由引擎合成，本就完整。

同时把「手写整块」改名**「高级模式」**（en: `Advanced`），提示语补上整块替换的后果；
新建模板默认 `kind: 'policy'`，策略面板成为默认填入框。

### 8.3 `🌐 DNS 出口`：从「恒定产出」到「复用入口组」

分两步，第二步推翻了第四节的结论。

**第一步（`bc0890c`）：改成开关。** `settings.dnsConfig.throughProxy`，默认开。
开则创建隐藏组并绑定，关则既不创建也不引用——两者同真同假。

- `withProxy` 支持空 `proxyGroup`；`proxyGroup` 取值从 `||` 改 `??`，否则显式传空串会被默认值吃掉
- `parseSingboxResolver` 的 `detour` 为空时**省略整个键**，写空串会让 sing-box 去找一个名为 `""` 的出站
- `dnsProxyGroup()` → `dnsProxyGroups()`，要求显式 `emitDnsProxyGroup: true`。
  surge / loon / quanx 的 DNS 配置位没有绑策略组的写法，它们不传这个标志——
  **顺手修掉上游在这三个格式里留下的死组**（声明了但无人引用，实测各 1 处）
- `applySmartModelOptimizations` 加 `dnsBindable`，surge/loon/quanx/egern 传 false
- `resolveDnsThroughProxy`：Profile 显式设置 > 全局 > 默认开。只认布尔值，
  缺键视为跟随全局，否则存量 Profile 会被当成显式关闭
- `resolveEffectiveDnsConfig` 收 `dnsThroughProxy`：策略模板合成的块会整块替换生成器
  产出的 dns，必须与生成器用同一个开关值，否则合成出的块会引用一个不会被创建的组

顺带修一个真实 bug：`renderClashYamlProfileTemplate` 原先硬编码把 DNS 绑到
`🌐 DNS 出口`，但那条路的策略组完全由用户自带的 Clash YAML 决定，我们不往里塞组，
模板没写这个组就是引用不存在的组。改成只在模板确实定义了该组时才绑。

**第二步（`30514e7`）：复用入口组，不再产出专用组。**

实测暴露出第一步不够：开启时仍然凭空多一个组。生产口径下（规则模板 →
`templateSource.kind='custom'` → `ruleLevel='none'`）**生成器自报 9 组、产物 10 组**，
多出的正是 `🌐 DNS 出口`。

先排除了「用 `hidden` 藏起来」这条路，两条硬事实：

1. INI 模板格式**没有 `hidden` 字段的位置**（`ini-template-parser` 不解析、
   `render-clash` 不透传）。实测模板路径产出的那个组 `hidden=undefined`——
   **今天生成器用户在客户端面板里就已经能看到它**，只有内置生成器那条路带 `hidden`
2. mihomo 文档原话：`hidden` 是「在 **api** 返回 hidden 状态，以隐藏该策略组展示
   （**需要使用 api 的前端适配**）」，即建议位而非硬保证。sing-box 更是完全没有这个
   字段（`SagerNet/sing-box#4483` 仍 open），而生成器同样输出 sing-box

所以要真正不显示，只有像 `🔧 前置修正` 那样**根本不创建组**。前置修正的机制是把规则
指向字面量 `DIRECT` 而不是 `🎯 全球直连` 组；DNS 这边没有可用字面量（`#DIRECT`
意思是 DNS 直连，正好反了），但有等价做法：**把后缀指向一个已经存在的组**。

`🚀 节点选择` 在生成器输出里是无条件产出的（`serialize.js` 的 `buildGroupLines`
第 1 步两个分支都吐），链式代理形态用 `🌍 总出口`。因此：

| | 生成器自报 | 实际产出 | `🌐 DNS 出口` |
|---|---|---|---|
| 跟随代理 | 9 组 | **9 组** | 不出现 |
| 直连 | 9 组 | **9 组** | 不出现 |

`nameserver` 写成 `udp://8.8.8.8:53#🚀 节点选择`，sing-box 的 `detour` 与
`download_detour` 同理；国内解析器不带后缀（要直连）。

**语义变化**：DNS 从此跟着流量走。用户把出口切到 DIRECT 时 DNS 也直连，不会出现
「流量直连而 DNS 仍走代理」的错位。select 组默认选中首个成员，生成器产出里那是
`♻️ 自动选择`，所以默认行为与上游的专用 url-test 组基本一致。

**范围刻意收窄到规则模板一条路**：`processor-service` 按
`templateSource?.kind === 'custom'` 传 `cardDerivedGroups`，只有规则模板（生成器产物）
为真；内置模板与远程 INI 行为逐字不变，**上游那 4 个测试文件零修改**。

> 走过一次弯路：第一版按「模型里有没有入口组」判断，结果内置 INI 模板也含
> `🚀 节点选择`，打红 `builtin-template-rules-audit` 与上游的
> `custom-template-and-dns-override` 各一条。加 `cardDerivedGroups` 后回到预定范围。

**决定点收敛到一处**：`applySmartModelOptimizations` 决定绑哪个组、写进
`model.settings.dnsProxyGroup`，渲染器只读。「组是否存在」与「DNS 是否引用它」出自
同一次判断，不可能对不上。渲染器被直接调用（未过优化器）时由
`resolveModelDnsProxyGroup` 退回旧行为，内置模板注册表那条路产出不变。

**兜底**：卡片派生但入口组被删掉时（在高级模式手写、把 `🚀 节点选择` 删了）退回专用组。
宁可多一个可见的组，也不能让 DNS 引用不存在的组。

`getRemoteProviderDefinitions` / `getSingboxDnsRuleSet` 的 `download_detour` 从
`emitDnsProxyGroup` 布尔改成 `dnsProxyGroup` 组名，空串即不绑——绑一个不存在的出站
会让 sing-box 拒绝整份配置。

### 8.4 生成器右栏第七段：`🌐 DNS 出口`（只读）

`locked` 段，不承接卡片、不产出策略组，排在 `🔧 前置修正` 之上（DNS 解析先于规则匹配）。
折叠头显示状态徽标「跟随代理 / 直连」，展开显示绑定说明与开关位置。

**刻意不放开关。** DNS 只保留一个配置入口（设置 → 服务设置 → 转换设置 → DNS 配置），
编辑器里再放一个就是第二份持久化状态：生成器状态存在 INI 的 base64 注释头里、
开关存在 `settings.dnsConfig.throughProxy`，用户在高级模式手改 INI 或导入别人的模板时
必然漂移。只读则是单向数据流，整类 bug 不存在。

代价：改开关要关掉模态框，而 `RuleGeneratorModal` 的 state 每次打开都从
`props.content` 重解析（`:76` 的 watch），**关窗会丢未应用的卡片编辑**。段内文字
因此提醒「先点应用再去改」。

修 template 一处隐性错误：`<label v-if="modifiers">` 夹在中间会断开 `v-if/v-else` 链，
导致 DNS 段落进 `<draggable v-else>` 分支（会渲染出一个可拖放区）。其余段整块包进
`<template v-else>` 解决。这个错误只在测试里现形。

**`serialize.js` / `catalog.js` / `validate.js` 零改动**——因为不新增组，
`groupCount` 与 `countPolicyGroups` 本来就对，INI 也不需要多一行 `custom_proxy_group=`。
连带 `parse.js` 的往返与漂移检测都不受影响。这是第四条路相比 DNS 文档 §7 方案 B
的主要优势。

### 8.5 阶段 B 的验证

| 项 | 阶段 A（`08a1700`） | `bc0890c` | `30514e7` |
|---|---|---|---|
| 测试文件 | 127 | 127 | **128** |
| 测试用例 | 842 | 877 | **886** |
| `npm run build` | 通过 | 通过 | **通过** |

新增测试文件 `tests/unit/dns-through-proxy-toggle.test.js`（25 条）：
`resolveDnsThroughProxy` 优先级 4 条、内置生成器 5 格式 × 两状态、模板路径 5 格式 ×
两状态、与策略模板叠加 2 条、不变量回归 5 条。
`dns-resolver-warnings.test.js` +11 条覆盖结构性字段告警。
`rule-generator-modal.test.js` +3 条覆盖第七段。

**断言口径**是「产出的组 === INI 声明的组」与「组存在 ⟺ 被引用」这两个不变量本身，
而不是数具体多少个组——后者会随上游改动误报。

## 九、剩余风险

| 风险 | 说明 |
|---|---|
| DNS 跟随出口选择 | 用户在客户端把 `🚀 节点选择` 切到 DIRECT 时 DNS 也直连。默认选中项是 `♻️ 自动选择`，默认行为与上游的专用 url-test 组基本一致。「DNS 跟着流量走」比「流量直连而 DNS 仍走代理」更符合预期，但这是判断而非事实 |
| 两种绑定机制并存 | 生成器路径复用入口组、内置/远程路径用专用组。这是「窄改动」的直接代价，原因写在 `resolveDnsProxyGroup` 的注释里 |
| `#组名` 指向 select 组未真机验证 | 已确认 mihomo 的后缀接受策略组名，但没验证 select 组与 url-test 组在 DNS 解析上是否完全等价。上游用的是 url-test |
| 存量 `customDnsOverride` 值成为死字段 | 不再读取也不再可见，刻意不删用户数据。曾设过它的用户升级后全局 DNS 退回内置默认 |
| 合成的 DNS 块在真实客户端上的效果无法靠单测验证 | 沿袭 DNS 文档 §十一。结构可测，实际防污染效果要真机验 |
| 上游仍在同一区域活跃改动 | 他们 DNS 相关文件近期一直在动。下次同步前先 `git fetch upstream` 看有无新增；`shared/safe-dns.js` 现在是上游镜像，`diff` 一次即可确认差异仍只有文件头与 `resolverHost` 导出两处 |
| 上游 `isCustomOrNone` 的命名与实现不一致 | `!level \|\| level === 'none'`，**变量名说 custom 但代码没判 `'custom'`**。因此 `ruleLevel='custom'` 会注入 12 个 `🤖` 组。目前没有代码路径传 `'custom'`（生成器路径走 `'none'`），是待触发的雷而非现存 bug。属上游问题，未改 |

---

**文档版本**：2.0
**最后更新**：2026-09-04
**状态**：阶段 A 与阶段 B 均已完成并通过复核（`30514e7`，128 files / 886 tests 全绿，
构建通过）。分支 `merge/upstream-20260904` 尚未合回 main。

**2.0 变更**：追加第八节记录阶段 B 的四项实施；第四节标注结论已被推翻并说明原因
（`hidden` 靠不住、模板路径下那个组本来就可见）；第六节四项待办逐项标注实际结论
（6.1 保留引擎去掉入口、6.2 重建为上游镜像使问题自然消解、6.3 走了第四条路而非
方案 B、6.4 因入口移除而不再可达）；剩余风险表整体重写，新增「上游
`isCustomOrNone` 命名与实现不一致」一项（阶段 A 审计时漏报的 AI 组注入问题）。
