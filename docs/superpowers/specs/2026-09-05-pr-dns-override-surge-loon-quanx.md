# PR 提案二：让 `customDnsOverride` 也作用于 Surge / Loon / Quantumult X

**状态**：待执行，**代码尚未编写**（与 PR 一不同，这个需要从零写实现）

| 项 | 值 |
|---|---|
| 目标 | `imzyb:main` |
| 基线 | `upstream/main` @ `1008b7c`（2026-09-02） |
| 建议分支名 | `feat/dns-override-surge-loon-quanx` |
| 改动面 | 约 7 个文件（3 个 emitter + 3 个生成器接线 + 3 个渲染器接线 + 测试） |
| 风险 | 中——纯增量，但要保证未配置时输出逐字节不变 |

---

## 一、问题

上游的 `customDnsOverride` 目前只影响 clash 与 sing-box：

| 格式 | 现状 | 位置 |
|---|---|---|
| clash | ✅ `resolveSafeDnsConfig` 合成 `dns:` 块 | `builtin-clash-generator.js:207`、`render-clash.js:172` |
| sing-box | ✅ `buildSingboxDnsConfig` 合成 `dns` 段 | `builtin-singbox-generator.js:353`、`render-singbox.js:370` |
| **surge** | ❌ 硬编码 | `builtin-surge-generator.js:472` → `dns-server = 119.29.29.29, 223.5.5.5, system` |
| **loon** | ❌ 硬编码 | `builtin-loon-generator.js:325` → `dns-server = system, 223.5.5.5, 119.29.29.29` |
| **quanx** | ❌ 硬编码 | `builtin-quanx-generator.js:281` → `[dns]\nno-ipv6\nserver = 223.5.5.5\nserver = 119.29.29.29` |

这三个格式**都有各自的 DNS 配置位**（`dns-server =` 行、`[dns]` 段），只是没接上。

**界面文案没有误导用户**：`dnsOverrideDesc` 写的是「自定义 **Clash** 订阅生成时的 DNS
配置块」，与实际能力（clash + sing-box）基本吻合。所以这是**缺失的能力**，不是 bug。
PR 描述里要照实这么说——把它说成 bug 会让审阅者觉得被夸大。

## 二、范围：刻意做小

**只提一件事：给三个格式各加一个 emitter，接到既有的 `resolveDnsPolicy()` 上。**

沿用上游既有的数据模型（全局 `settings.customDnsOverride`）与策略语义，
**不引入任何新的存储、新的 API 路由、新的前端组件**。

### 明确不提的东西

| 不提 | 原因 |
|---|---|
| 我们的多模板 DNS 仓库（`misub_dns_templates_v1`、`resolveEffectiveDnsConfig`） | 产品形态选择。塞进去会让审阅者面对一个新 KV key + 新 API 路由，被拒概率高 |
| `DnsTemplateManager.vue`、`shared/dns-template-validation.js` | 同上 |
| 可视化规则生成器（`src/utils/rule-generator/`） | 与 DNS 无关，绝对不能混进去 |
| 「DNS 走代理」开关（`settings.dnsConfig.throughProxy`） | 我们自己的产品决策，且三个目标格式的 DNS 配置位**本来就绑不了策略组**，与本 PR 无关 |
| 前端地址校验提示 | 上游服务端已有 `resolverHost`，只缺前端提示，收益小、争议点多（拦不拦局域网 DNS）。另开 PR 或不提 |

## 三、实现方案

### 3.1 三个 emitter（加在 `functions/modules/subscription/safe-dns.js`）

输入统一是上游既有的 `resolveDnsPolicy(raw, options)` 结果 `{ mode, domestic, foreign, polluted }`。

**关键设计约束：这三个格式的 DNS 配置位不支持绑策略组**（没有 clash 的 `#组名`、
也没有 sing-box 的 `detour`）。所以 emitter **不能**输出带 `#🌐 DNS 出口` 后缀的地址——
带了客户端会把整串当主机名。必须先剥掉后缀，或者干脆不传 `proxyGroup`。

```js
/**
 * Surge / Loon 的 dns-server 行值。
 *
 * 这两个格式的 DNS 配置位不支持绑策略组，因此不加 #组名 后缀。
 * `system` 保留在末位：客户端拿不到结果时回落到系统解析器。
 */
export function buildSurgeDnsLine(raw, options = {}) { /* → '223.5.5.5, 119.29.29.29, system' */ }
export function buildLoonDnsLine(raw, options = {}) { /* 同上，Loon 惯例 system 在首位 */ }

/**
 * Quantumult X 的 [dns] 段正文（不含 `[dns]` 段头）。
 * 每个解析器一行 `server = <addr>`；`no-ipv6` 保留。
 */
export function buildQuanxDnsSection(raw, options = {}) { /* → 'no-ipv6\nserver = 223.5.5.5\n…' */ }
```

**地址形态要注意**：`resolveDnsPolicy` 的 `foreign` 在 clean 模式下是
`udp://8.8.8.8:53` 这种带 scheme 的形式（`plainResolver` 的产出）。
Surge / Loon / QuanX 的 `dns-server` / `server =` 期望的是**裸地址或 DoH URL**，
`udp://` 前缀它们不认。emitter 必须把 `udp://host:53` 还原成 `host`。
`https://` 前缀则要保留（三者都支持 DoH，Surge 用 `encrypted-dns-server`、
QuanX 用 `server = https://...`，Loon 用 `dns-server` 直接写）。

> **这是本 PR 最容易出错的地方**，也是必须写测试覆盖的地方。

### 3.2 接线

| 文件 | 改法 |
|---|---|
| `builtin-surge-generator.js:472` | `dns-server = ${buildSurgeDnsLine(options.customDnsOverride \|\| '', { mode: options.dnsMode })}` |
| `builtin-loon-generator.js:325` | 同上，换 `buildLoonDnsLine` |
| `builtin-quanx-generator.js:281` | `` `[dns]\n${buildQuanxDnsSection(...)}` `` |
| `render-surge.js:335` | 模板路径同样接上，读 `normalizedModel.settings?.customDnsOverride`。注意 `:336` 还有一行 `encrypted-dns-server = h3://223.6.6.6/dns-query`——DoH 解析器要么合并进它、要么写进 `dns-server`，两者语义不同，需选定一种并在 PR 里说明 |
| `render-loon.js:327` | 同上，Loon 没有独立的 encrypted 行 |
| `render-quanx.js:213-216` | `[dns]` 段是一个字符串数组（`'[dns]'`, `'no-ipv6'`, `'server = 223.5.5.5'`, `'server = 114.114.114.114'`），改成把 emitter 的产出按行展开进去 |

> **注意两处硬编码不一致**（上游既有，不是本 PR 引入）：内置生成器用
> `223.5.5.5` + `119.29.29.29`，而 `render-quanx.js` 用 `223.5.5.5` + `114.114.114.114`。
> 接上 emitter 后两条路会统一到 `DEFAULT_DNS_POLICY.domestic`，**这本身就是产物变化**——
> 未设置 `customDnsOverride` 时 `render-quanx` 的输出会从 `114.114.114.114` 变成
> `119.29.29.29`。要么在 emitter 里为模板路径保留原值，要么在 PR 里明确说明这处统一。
> 别让它成为审阅时才被发现的意外。

**注意 quanx 的段序**：上游 `builtin-quanx-generator.js:285` 在 `[dns]` 后紧跟
`[server_remote]`。如果 emitter 的产出末尾没有换行、或段序被调整成 `[dns]` 收尾，
后续处理可能出问题。**建议顺带在 PR 里说明这一点，但不要顺手重排段序**。

### 3.3 测试

写进上游既有的 `tests/unit/safe-dns.test.js`，用他们的风格（`describe` / `it` + 英文描述）。

必测四条：

1. **未设置 `customDnsOverride` 时，三个格式的输出逐字节不变**——这是能否被合并的关键。
   建议做法：先在基线上跑一次生成器、把产物存成 fixture，改完再比对。
   **例外**：`render-quanx.js` 的国内解析器会从 `114.114.114.114` 变成 `119.29.29.29`
   （见 3.2 的注意事项）。要么保留原值，要么把这条例外写进测试与 PR 描述
2. `udp://8.8.8.8:53` 被还原成 `8.8.8.8`（scheme 剥离）
3. `https://8.8.8.8/dns-query` 原样保留（DoH 不剥）
4. `polluted` 模式下三个格式都改用 `polluted` 那组解析器

另外验证：`resolverHost` 已有的地址校验对新 emitter 同样生效（回环 / 非法 scheme 被过滤，
整组被过滤空时回落 `DEFAULT_DNS_POLICY`）——复用既有逻辑即可，不需要新写校验。

## 四、操作步骤

```bash
git fetch upstream
git switch -c feat/dns-override-surge-loon-quanx upstream/main

# 手工编写实现——不要 cherry-pick 我们的提交。
# 我们的实现走的是完全不同的路（customDns 模板 + applyCustomDnsToBuiltinPreset 渲染后回炉），
# 与本 PR 的「生成时就地注入 + 复用 resolveDnsPolicy」不是同一套东西，搬不过来。

npm run test:run      # 注意：node-transformer.test.js 在此基线上即已失败，见第六节

git add functions/modules/subscription/safe-dns.js \
        functions/modules/subscription/builtin-{surge,loon,quanx}-generator.js \
        functions/modules/subscription/template-renderers/render-{surge,loon,quanx}.js \
        tests/unit/safe-dns.test.js
git commit
git push -u origin feat/dns-override-surge-loon-quanx
```

提交信息用英文，与上游历史一致：`feat(dns): apply customDnsOverride to Surge / Loon / QuanX`

## 五、PR 描述要点

1. **问题**：`customDnsOverride` 只影响 clash 与 sing-box（附两处调用点行号）。界面文案本身
   写的是「自定义 Clash 订阅生成时的 DNS 配置块」，**所以没有误导用户**，但 Surge / Loon /
   QuanX 三个格式确实拿不到这个能力——而它们都有各自的 DNS 配置位
2. **做法**：复用既有 `resolveDnsPolicy()`，为三个格式各加一个 emitter；不改数据模型、
   不改 clash / sing-box 的既有输出
3. **兼容性**：未设置 `customDnsOverride` 时三个格式的输出**逐字节不变**（附测试）
4. **实现细节**：说明为什么不加 `#🌐 DNS 出口` 后缀（这三个格式的 DNS 配置位绑不了策略组），
   以及 `udp://` scheme 的剥离规则
5. **验证**：贴出三个格式在设置了 `customDnsOverride` 前后的产物片段
6. **明确说明来源**：本改动来自 fork `Ink-lotus/MiSub`，那边还有一套多模板的 DNS 方案，
   本 PR 刻意不含它——如果上游有兴趣可以另开话题讨论

## 六、注意事项

### 6.1 不要写「全量测试通过」

`tests/unit/node-transformer.test.js` 在 `upstream/main` 上**本来就是失败的**（成因见
`2026-09-05-pr-node-transformer-test-fix.md`）。所以：

- 只能说「本 PR 新增的 N 条测试通过；`node-transformer.test.js` 在本 PR 基线上即已失败，
  与本改动无关」
- 如果 PR 一已经合并，这条注意事项自动消失——**建议先提 PR 一**，它一眼可审、合得快，
  合完这个 PR 的验证叙述会干净得多

### 6.2 分支不要合回我们的 main

分支基于 `upstream/main`，合回来会把上游那套 DNS 形态带进我们的仓库，与我们已收敛好的
模板方案打架。它只是一条一次性的出货分支。

### 6.3 我们自己不需要这个能力

我们的 DNS 模板库**早就支持 surge / loon / quanx**（那是我们相对上游的主要优势之一）。
所以这个 PR 纯粹是回馈，对我们没有功能收益。**如果实现过程中发现要动上游其他区域、
或者工作量明显超出预期，直接放弃是合理选择**——不要为了「提成 PR」而扩大改动面。

### 6.4 三个 PR 彼此独立

我们 fork 还有另外两个待提 PR（`2026-09-04-pr-kv-d1-migration-fix.md` 与
`2026-09-05-pr-node-transformer-test-fix.md`）。三者**彼此独立、可任意顺序提**，
不要合并成一个。建议顺序：PR 一（测试修复，最易合）→ 本 PR → KV→D1 迁移修复
（那个动数据迁移逻辑，审阅最重）。

---

**文档版本**：1.0
**最后更新**：2026-09-05
**前置状态**：`Ink-lotus/MiSub` 已把上游合并到 `1008b7c`（`38bc1bb`，已推送 origin/main）。
**本 PR 的代码尚不存在**——我们自己的实现路径与它不同，需要在上游基线上从零编写。
原始规划见 `2026-09-02-dns-upstream-merge-design.md` 第八节（该文档已转为历史记录，
但第八节的 PR 范围划定仍然有效）。
