# DNS 方案：上游对照、融合设计与上游 PR 计划

**状态**：分析与设计，**尚未实施任何代码改动**。等待决策，决策点集中在第七、八节。

**核实基准**：
- 本地 `main` = `4fec2e6`（2026-09-02）
- 上游 `imzyb/MiSub` main = `1008b7c`（2026-09-02 00:37），已通过 `git remote add upstream` 接回
- 共同祖先 `318b87d`（2025-06-17）；此后本地独有 1529 个提交、上游独有 1620 个提交，142 个文件有内容差异
- 本文所有断言都标了 `文件:行号`，上游侧可用 `git show upstream/main:<path>` 复核

## 一、一句话结论

两边不是同一个东西：**上游是 DNS 策略引擎，我们是 DNS 模板仓库**。上游在"默认就正确"上明显更强，我们在"覆盖面与产品形态"上明显更强，两者的强项不重叠，因此正确姿势是把上游的引擎接进我们的仓库，而不是二选一。

## 二、事实对照

| 维度 | 上游 `safe-dns.js`（270 行） | 我们 DNS 模板（约 500 行分三处） |
|---|---|---|
| 目标格式 | **clash + sing-box**（2 个；界面文案只提 Clash，见下） | **clash / singbox / surge / loon / quanx**（5 个，egern 无 DNS 段） |
| 用户输入 | 策略：`domestic` / `foreign` / `polluted` / `mode`；也接受完整 `dns:` 块 | 每个格式一段完整 DNS 配置文本 |
| 生成方式 | **合成**一份设计过的 DNS 块 | **整块替换**用户写的内容 |
| 注入时机 | 生成时就地注入 | 内置生成器内联 + 模板路径渲染后回炉 |
| 校验 | 语法 + **地址语义**（拒绝回环/非法主机、限定 scheme、空则回落默认） | 仅语法（能否 parse 成对象、不得包 `dns:` 外层等） |
| 存储 | 全局单值 `settings.customDnsOverride` | KV `misub_dns_templates_v1`，**最多 50 个命名模板** |
| 选择粒度 | 全局，所有订阅共用 | 全局默认 + **profile 级覆盖**（`builtin` / `template`） |
| 前端 | `DnsOverrideCard.vue`（101 行）单文本框 | `DnsTemplateManager.vue`（320 行）多模板管理 |
| 测试 | `safe-dns.test.js`、`custom-template-and-dns-override.test.js` | 6 个文件（handler / api / selectors / manager 校验 / 缓存 / 解析回归） |

一个值得注意的细节：上游的界面文案（`dnsOverrideDesc`）写的是「自定义 **Clash** 订阅生成时的 DNS 配置块」，而代码其实也喂给了 sing-box（`buildSingboxDnsConfig`，`safe-dns.js:248`）。即文案比实际能力窄，但对 surge / loon / quanx 用户来说没有误导——那三个格式确实完全没接。

关键代码位置：

- 上游：`functions/modules/subscription/safe-dns.js`；调用点 `builtin-clash-generator.js:207`、`builtin-singbox-generator.js:353`、`render-clash.js:170`、`render-singbox.js:369`、`processor-service.js:91`、`template-processor.js:194-208`（自动注入 DNS 策略组）
- 我们：`functions/services/processor-service.js:97-150`（`applyCustomDnsToBuiltinPreset`）、`:283`（模板路径调用）、`functions/modules/dns-template-handler.js:63-75`（`resolveEffectiveDnsConfig`）、`shared/dns-template-validation.js`

## 三、上游做对了什么

1. **默认就正确**（`safe-dns.js:142` 的 `DEFAULT_DNS_CONFIG` + `:187` 的 `resolveSafeDnsConfig`）。合成的 clash 块含 fake-ip、`nameserver-policy` 按 `geosite:cn` / `geosite:geolocation-!cn` 分流、`proxy-server-nameserver`、`direct-nameserver`、`fallback-filter`（geoip CN + 私有段 ipcidr）。这些字段错一个就是 DNS 泄漏或国内域名解析到国外 IP，让普通用户手写整块基本写不对。

2. **地址级校验**（`safe-dns.js:58-71` 的 `resolverHost`）。拒绝 `127.x` / `0.x` / `localhost` / `::1` 与非法主机名，只认 `udp/tcp/tls/https`，整份被过滤空时回落 `DEFAULT_DNS_POLICY`。**我们完全没有这一层**：用户在模板里填 `127.0.0.1`，我们照样写进配置，客户端 DNS 直接失效，而校验会说"合法"。

3. **专用 DNS 出口组** `🌐 DNS 出口`（`safe-dns.js:8`）。外部 DNS 带 `#🌐 DNS 出口` 后缀绑到策略组，sing-box 侧连 rule-set 下载都指定 `download_detour`（`render-singbox.js:321,342`）。"DNS 查询本身要不要走代理"这个真问题它答了，我们丢给用户。组不存在时 `template-processor.js:194-208` 会自动补一个 url-test 组。

4. **clean / polluted 双策略**（`safe-dns.js:100-127` 的 `resolveDnsPolicy`）。干净网络给外部解析器降级为明文 UDP（快），判定被污染时切 DoH 并填 `fallback`。

5. **留了逃生门**（`safe-dns.js:177` 的 `isExplicitDnsBlock`）。识别出用户写的是完整 `dns:` 块就原样透传——也就是我们的行为，被它当成高级模式的子集。

## 四、我们做对了什么

1. **5 个目标格式 vs 2 个**。用 Surge / Loon / QuanX 的用户在上游那边这个功能等于不存在。
2. **多模板 + profile 级选择**（`dns-template-handler.js:63-75`）。最多 50 个命名模板，profile 可覆盖全局，`builtin` 表示不覆盖。上游是全局唯一一份，所有订阅共用。
3. **自由度无上限**。想用 redir-host、开 ipv6、写任意字段都行。上游非 explicit 模式下强制 `enable:true / ipv6:false / enhanced-mode:fake-ip / respect-rules:true`，只放开 6 个字段（`SAFE_DNS_FIELDS`，`safe-dns.js:17`）。

## 五、我们的两个具体弱点

1. **渲染完再回炉**。`applyCustomDnsToBuiltinPreset` 把已生成的 YAML/JSON 重新 parse、塞 `.dns`、再 dump（clash 还要过一遍 `clashFix`）。每个订阅请求多一次全量 YAML 往返，格式也可能漂移。上游在生成时就地注入，没这层开销。

2. **quanx 的 `[dns]` 段替换正则有隐含前提**（`processor-service.js:141`）：
   ```js
   /(^\[dns\][^\S\r\n]*\r?\n)[\s\S]*?(?=\r?\n\[[^\]\r\n]+\])/im
   ```
   前瞻要求 `[dns]` 后面**还跟着另一个段头**。目前 `builtin-quanx-generator.js:284-285` 在 `[dns]` 后紧跟 `[server_remote]`，所以现在没事；一旦段序调整成 `[dns]` 收尾，就会静默不替换——用户以为生效了其实没有。**这是个埋着的坑，与融合无关也该修。**

## 六、融合方案（分四阶段，可各自独立取舍）

四个阶段按"风险从低到高、收益从确定到需要决策"排列。**F1 单独做也有价值**，不必等后面。

### F1 借上游的地址校验（低风险，纯增强）

把 `resolverHost` 那套语义校验搬进 `shared/dns-template-validation.js`：解析器地址必须是合法主机名/IP，scheme 限 `udp/tcp/tls/https`，拒绝 `127.x` / `0.x` / `localhost` / `::1`。

- 改动面：`shared/dns-template-validation.js` 加一个 `validateResolverValue()`；clash/singbox 分支在解析成对象后额外扫 `nameserver` / `fallback` / `default-nameserver` / `nameserver-policy` 里的字符串；surge/loon/quanx 扫行内的地址
- 不改数据模型、不改存储、不动生成链路
- 定位：从 `error`（拦保存）还是 `warn`（只提示）？倾向 **warn**——我们的卖点是自由度，硬拦会挡住"我就是要指向局域网 DNS"这类正当需求。局域网 `192.168.x` 不该拦，只拦回环与全零
- 验收：新增单测覆盖回环 / 非法 scheme / 空回落；现有 6 个 DNS 测试文件全绿

### F2 修 quanx 段替换（低风险，独立 bug）

`processor-service.js:141` 的正则改成"到下一个段头**或文件结尾**"，即把前瞻改为 `(?=\r?\n\[[^\]\r\n]+\]|\s*$)`。补一条 `[dns]` 收尾的用例。

### F3 给 DNS 模板加"策略模式"（中等风险，主体工作）

模板记录增加一种类型：除现有的"每格式一段整块文本"（手写模式）外，允许一条**策略**：

```jsonc
{
  "id": "dns-tpl-x", "name": "标准分流",
  "kind": "policy",                       // 新增；缺省视为 "raw"，旧模板不受影响
  "policy": {
    "mode": "clean",                      // clean | polluted
    "domestic": ["223.5.5.5", "119.29.29.29"],
    "foreign": ["udp://8.8.8.8:53"],
    "polluted": ["https://8.8.8.8/dns-query"]
  }
}
```

- 后端引入一份改造过的 `safe-dns.js`（建议放 `shared/`，见下），由策略合成 clash 与 sing-box 两块；surge / loon / quanx 仍走手写整块，策略模式下这三个格式留空即不覆盖
- **代码来源取舍**：直接 `git checkout upstream/main -- functions/modules/subscription/safe-dns.js` 拿过来，再改造成不依赖 `DNS_PROXY_GROUP`（见第七节）。保留原作者的实现结构，便于 F4 反向 PR 时 diff 小、可读
- 前端 `DnsTemplateManager.vue` 加模式切换：策略模式给三组解析器输入 + clean/polluted 单选，手写模式保持现状
- 验收三条：①策略模式产出的 clash / sing-box 块结构由**新增**单测覆盖，断言口径对齐上游 `safe-dns.test.js`；②模板选择优先级不受影响，`dns-resolution-regression.test.js`（测的是 `resolveEffectiveDnsConfig` 的 global/profile/builtin 优先级，不是块内容）保持全绿；③手写模式行为逐字不变，旧模板零迁移

### F4 反向给上游提 PR（见第八节）

把我们独有的"surge / loon / quanx 也支持 DNS 覆写"回馈上游。**放在 F3 之后**：先在自己这边跑通、有测试，再拿改造好的实现去提。

## 七、必须先决策：`🌐 DNS 出口` 策略组

这是唯一一个会跟我们既有设计打起来的点，**F3 之前必须定**。

上游的做法是给外部 DNS 加 `#🌐 DNS 出口` 后缀，把 DNS 查询钉到一个专用策略组；组不存在时由 `template-processor.js:194-208` 自动补一个 url-test 组。

冲突在于：我们刚做完的可视化规则生成器，**策略组完全由卡片派生**（`PROJECT_PLAN_2.0` §5.2），并且 0 成员组会被 `pruneEmptyGroups` 剪掉。凭空多一个不由卡片产生的组，会破坏"组列表 = 卡片归属的函数"这个不变量，也会让生成器的策略组计数与实际输出不一致。

三个选项：

| 选项 | 做法 | 代价 |
|---|---|---|
| **A. 不引入**（推荐起点） | 合成 DNS 时不加 `#组名` 后缀，外部解析器直接走客户端默认路径 | 丢掉"DNS 查询强制走代理"这个能力；防污染效果弱于上游 |
| **B. 作为基础策略组的第四个开关** | 在生成器顶栏加 `🌐 DNS 出口`，与 `♻️ 自动选择` 同级，勾选后恒定输出；DNS 模板只在该组存在时才加后缀 | 需要改 `catalog.js` 的 `GROUP_NAMES`、`serialize.js` 的组装配与计数、i18n、若干测试；两个功能从此耦合 |
| **C. 照上游那样自动注入** | 渲染时发现缺组就补 | 与"组由卡片派生"直接矛盾，且生成器预览里看不到这个组，用户会困惑。**不建议** |

我的倾向：**先 A 后 B**。A 让 F3 能独立落地、不牵动规则生成器；确认策略模式好用之后，再把 B 作为一个独立特性做，那时它是"用户主动勾选的一个基础组"，语义清晰。

## 八、给上游的 PR 计划

### 8.1 范围（刻意做小）

**只提一件事：让 `customDnsOverride` 也作用于 surge / loon / quanx。**

- 在 `safe-dns.js` 增加三个 emitter：`buildSurgeDnsLine()` / `buildLoonDnsLine()` / `buildQuanxDnsSection()`，输入仍是上游既有的 `resolveDnsPolicy()` 结果
- 接到 `builtin-surge-generator.js` / `builtin-loon-generator.js` / `builtin-quanx-generator.js` 与对应的 `render-*.js`
- 沿用上游的数据模型（全局 `settings.customDnsOverride`）与策略语义，**不引入我们的模板仓库**

为什么是这个范围：它对上游是纯增量、零数据迁移、不动既有 clash/sing-box 行为，也不要求他们接受我们的产品形态。这是最可能被合并的形状。

### 8.2 明确不提的东西

- 多模板存储 + profile 级选择（`misub_dns_templates_v1`、`resolveEffectiveDnsConfig`）——这是产品形态选择，塞进 PR 会让审阅者面对一个新的 KV key 与新 API 路由，被拒概率高
- 我们的 `DnsTemplateManager.vue`、`shared/dns-template-validation.js`
- 规则生成器（`src/utils/rule-generator/`、`rule plan/`）——与 DNS 无关，绝对不能混进去
- F1 的地址校验：上游服务端已有 `resolverHost`，它只缺前端提示，收益小、争议点多（拦不拦局域网 DNS），**另开一个 PR 或干脆不提**

### 8.3 分支怎么开（关键，别踩）

我们的 main 与上游共同祖先停在 2025-06-17，**领先 1529 个提交、142 个文件不同**。直接从我们的 main 发 PR，上游会看到一千五百多个提交和整个规则生成器——必然被关。

必须从上游的 tip 开一条干净分支，只把 DNS 那几个文件的改动搬过去：

```bash
git fetch upstream
git switch -c feat/dns-override-surge-loon-quanx upstream/main
# 手工把 F3 里写好的三个 emitter 与接线搬过来（不要 cherry-pick 我们的提交，
# 那些提交里混着模板仓库与规则生成器的改动）
git add functions/modules/subscription/safe-dns.js \
        functions/modules/subscription/builtin-{surge,loon,quanx}-generator.js \
        functions/modules/subscription/template-renderers/render-{surge,loon,quanx}.js \
        tests/unit/safe-dns.test.js
git commit
git push origin feat/dns-override-surge-loon-quanx
```

然后在 GitHub 上从 `Ink-lotus:feat/dns-override-surge-loon-quanx` → `imzyb:main` 发 PR。

注意事项：
- 分支基于 `upstream/main`，因此**不要**把它合回我们的 main（会把上游那 1620 个提交带进来）；它只是一条一次性的出货分支
- 测试写进上游既有的 `tests/unit/safe-dns.test.js`，用他们的风格（`describe` / `it` 英文描述）
- i18n 若需新键，中英两份都要加（上游 `src/i18n/messages.js` 同样是双语对照结构）
- 提交信息用英文，与上游历史一致（`feat(dns): ...`）

### 8.4 PR 描述要写什么

1. **问题**：`customDnsOverride` 目前只影响 clash 与 sing-box（`builtin-clash-generator.js:207`、`builtin-singbox-generator.js:353`）。界面文案本身写的是「自定义 Clash 订阅生成时的 DNS 配置块」，所以没有误导用户，但 Surge / Loon / QuanX 三个格式确实拿不到这个能力——而它们都有各自的 DNS 配置位（`dns-server=` 行、`[dns]` 段）
2. **做法**：复用既有 `resolveDnsPolicy()`，为三个格式各加一个 emitter；不改数据模型、不改 clash/sing-box 的既有输出
3. **兼容性**：未设置 `customDnsOverride` 时三个格式的输出逐字节不变（附测试）
4. **验证**：`npm run test:run` 全绿 + 三个格式的产物片段贴在 PR 里
5. **明确说明来源**：本改动来自 fork `Ink-lotus/MiSub`，那边还有一套多模板的 DNS 方案，本 PR 刻意不含它——如果上游有兴趣可以另开话题讨论

### 8.5 提 PR 需要单独授权

推分支到远端、开 PR 都是对外动作。**执行前需要你明确点头**，届时我会先把 diff 给你过一遍。

## 九、待决策清单

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | F1 的地址校验定 `error` 还是 `warn` | warn，且只拦回环/全零，不拦局域网 |
| 2 | `🌐 DNS 出口` 走第七节的 A / B / C | 先 A，B 作为后续独立特性 |
| 3 | 改造后的 `safe-dns.js` 放 `functions/modules/subscription/` 还是 `shared/` | `shared/`——前端做策略模式预览时也要用同一份逻辑 |
| 4 | F3 的策略模式与手写模式在 UI 上并列还是二选一 | 同一模板内二选一（`kind` 字段），列表里标出类型 |
| 5 | 要不要顺带把上游的 `anytls` 协议转换器拿过来 | 与 DNS 无关，另开一轮 |
| 6 | F4 的 PR 是否真的要提 | 由你定；技术上 F3 完成即可提 |

## 十、风险

| 风险 | 说明 |
|---|---|
| 策略模式合成的 DNS 块在真实客户端上的效果无法靠单测验证 | 单测只能保证结构；实际防污染效果要在真机上验。上游那份配置已在他们用户群里跑了一段时间，这是采用它而非自研的主要理由 |
| 上游可能在同一区域继续改动 | 他们 DNS 相关文件近期一直在动（`1008b7c` 就是 2026-09-02 的合并）。F3 若拖太久，F4 的 PR 会需要 rebase |
| 我们的手写模式与策略模式共存会让 UI 复杂度上升 | `DnsTemplateManager.vue` 已 320 行；策略模式再加一套输入，需要注意不要做成两个互相干扰的表单 |
| `git remote add upstream` 已执行 | 唯一已落地的改动，纯本地配置，`git remote remove upstream` 可撤销。除此之外本文全部为待实施状态 |

---

**文档版本**：1.0
**最后更新**：2026-09-02
**状态**：待决策。第九节 6 个问题定了之后再开工，F1 / F2 可以先做。
