# 上游融合阶段二：机械合并 97 个提交

**状态**：阶段 A 已完成（2026-09-04，合并提交 `08a1700`）。阶段 B「DNS 收敛」待执行，**开工前先读第六节**。

**核实基准**：
- 本文写于 `08a1700` 之后，所有数字为实测值而非估算
- 上游 `imzyb/MiSub` main = `1008b7c`（2026-09-02 00:37）
- 共同祖先 = `5f60563`（2026-07-30，`Merge pull request #431`）
- 合并规模：98 files，+3943 / −436
- 前置设计见 [`2026-09-02-dns-upstream-merge-design.md`](./2026-09-02-dns-upstream-merge-design.md)，本文承接其第九节

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

## 四、`🌐 DNS 出口`：按既定取舍接受上游原样

**这是本阶段唯一的架构级取舍，已定，但代价需要记录清楚。**

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

所以方案 A 在合并语境下不是「少做一件事」，而是「主动拆掉上游 DNS 设计的承重件并改掉他们 4 个测试文件，且每次同步都要重做一遍」。取舍结论：**接受上游原样**，即落到方案 C。

**注入条件值得记住**：`template-processor.js` 是 `if (!hasCustomDns) ensureDnsProxyGroup(model)`，而 `hasCustomDns` 读的是上游的 `settings.customDnsOverride`。我们的 DNS 模板写的是自己的 `customDns` 字段，**永远不会让该条件为真**，因此这个组在我们的模板渲染路径上恒定出现。且它的成员是全部节点名（`proxyNames.length > 0 ? proxyNames : ['REJECT']`），非空，`pruneEmptyGroups` 也剪不掉。

**已付的代价**：规则生成器「策略组 = 卡片派生」这个不变量暂时打破，产物里会出现生成器预览中看不到的组。实测我们的规则生成器测试**未被打红**（`rule-generator-render-matrix.test.js` 等用的是按名 `.filter(group => group.name === X)` 定位，不做穷举计数），所以这是产品一致性问题而非功能故障。留给阶段 B。

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

**我们靠执行顺序确定性地赢**，所以 DNS 模板功能行为不变。但这留下两个设置项抢一个字段的局面：`customDnsOverride`（上游，全局单值）在模板生效时是死的，无模板时又活过来。**这正是阶段 B 要收敛的东西。**

同时留下一段引用 `customDnsOverride` 的剪组逻辑（`:199-203`），语义上与我们的模板路径无关。

### 5.3 `i18n/messages.js`：零键丢失

自动合并的 i18n 最容易出两类问题：丢键，以及重复键（JS 对象字面量静默容忍、后者覆盖前者，测试也测不出来）。用脚本把合并结果与两侧父提交的键集逐一比对：

| locale | 我方 | 上游 | 合并后 | 丢失我方键 | 丢失上游键 |
|---|---|---|---|---|---|
| `zh-CN` | 1252 | 1143 | 1268 | **0** | **0** |
| `en-US` | 1248 | 1139 | 1264 | **0** | **0** |

中英对齐：4 个键仅 `zh-CN` 有（`manualNodes.batchMoveGroupTitle`、`manualNodes.batchMoveGroupDesc`、`manualNodes.groupName`、`subscriptions.importedCount`）。核实为**上游既存的不对齐**——两侧父提交里各自都是 4 个差额，且这 4 个键在两份父文件里都只出现一次。非合并引入，不在本阶段范围内。

## 六、阶段 B 交接：DNS 收敛前必读

阶段 A 刻意不碰 DNS 语义。以下是留给阶段 B 的四件事，按依赖顺序排列。

### 6.1 两套 DNS 设置收敛（主体工作）

现状：`customDnsOverride`（上游，全局单值，走 `functions/modules/subscription/safe-dns.js`）与 `customDns` + DNS 模板仓库（我们，多模板 + profile 级覆盖，走 `shared/safe-dns.js`）并存，同写 `config.dns`，我们靠执行顺序赢。

需要决定的是产品语义，不只是代码：一个用户同时设了全局 `customDnsOverride` 和一个 DNS 模板时，期望是什么？候选方向包括「把 `customDnsOverride` 降级为一个内置模板」、「让它成为模板选择为 `builtin` 时的回落值」、「彻底移除并提供一次性迁移」。

### 6.2 `shared/safe-dns.js` 必须人工 diff 上游那份

`shared/safe-dns.js` 是上游 `safe-dns.js` 的改造拷贝（去掉 `DNS_PROXY_GROUP` 后缀、可被前后端共同 import），**不会自动跟随上游更新**。

阶段 A 之后仓库里同时存在两份：

- `functions/modules/subscription/safe-dns.js` — 上游原版，随合并更新到 `1008b7c`
- `shared/safe-dns.js` — 我们的改造拷贝，停在拷贝时的上游状态

上游这 97 个提交里有 6 个落在 DNS 区域（`1180385` 原始实现、`5dc262f` / `23393d6` / `9e12708` / `788174f` / `439c002` 五个加固）。**必须逐一确认这些修复有没有进到 `shared/` 那份里**，没进的挑进来。

**这项的定位是复查而非移植**：F3 落地时已对照过上游当时的实现，这些加固可能大部分已在 `shared/safe-dns.js` 里。开工时先逐个提交比对确认，别默认要重做一遍。

如果 6.1 的收敛结论是「统一到一份」，这个问题自然消解——这也是把 6.2 排在 6.1 之后的原因。

### 6.3 `🌐 DNS 出口` 的最终归属

第四节记录了代价：生成器预览与实际产物不一致。DNS 文档 §7 的方案 B（在生成器顶栏加一个与 `♻️ 自动选择` 同级的可勾选基础组）是恢复不变量的路径，改动面为 `catalog.js` 的 `GROUP_NAMES`、`serialize.js` 的组装配与计数、i18n、若干测试。

### 6.4 交叉行为缺测试

两套 DNS 机制**同时有值**（模板选中 + `customDnsOverride` 非空）时的行为目前无人覆盖：上游测试只设 `customDnsOverride`，我们的测试只设 `customDns`。代码审读结论是「我们的覆盖在后、确定性地赢」，但这是读出来的而非测出来的。收敛时补一条定向测试，而不是现在加——现在加等于把待废弃的行为固化成断言。

## 七、验证与回退

**验证**（实测值）：

| 项 | 基线（`d00e483`） | 合并后（`08a1700`） |
|---|---|---|
| 测试文件 | 120 passed | **127 passed** |
| 测试用例 | 785 passed | **842 passed** |
| `npm run build` | 通过 | **通过**（7.00s） |

**回退**：阶段 A 全部落在分支 `merge/upstream-20260904`（合并提交 `08a1700`，双父 `d00e483` + `1008b7c`）。`main` 与 `origin` 全程未动，弃掉该分支即完全回退。

**合并回 main 与推送均待定**：按项目决定，要等上游更新全部合并完、确认无问题之后再做。同理，向上游提 PR（含 3.1 提到的红灯修复）也一并推迟到那时。

## 八、剩余风险

| 风险 | 说明 |
|---|---|
| 单测无法覆盖两套 DNS 机制的交叉行为 | 见 6.4。已知盲区，非未知风险 |
| 产物里出现生成器预览中没有的策略组 | 见第四节。既定取舍，功能不受影响，但用户可能困惑 |
| `shared/safe-dns.js` 可能缺上游的 DNS 加固 | 见 6.2。阶段 A 未核实这一项——它属于 DNS 语义，刻意留给阶段 B |
| 合成的 DNS 块在真实客户端上的效果无法靠单测验证 | 沿袭 DNS 文档 §十一。结构可测，实际防污染效果要真机验 |
| 上游仍在同一区域活跃改动 | 他们 DNS 相关文件近期一直在动。阶段 B 拖太久会需要再合一轮 |

---

**文档版本**：1.0
**最后更新**：2026-09-04
**状态**：阶段 A 完成并通过复核（`08a1700`，127 files / 842 tests 全绿，构建通过）。阶段 B「DNS 收敛」待另起会话执行，开工前先读第六节。
