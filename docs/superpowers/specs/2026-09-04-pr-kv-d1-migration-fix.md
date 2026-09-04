# PR 提案：修复 KV→D1 迁移数据丢失

**状态**：待你审核，**尚未提交 PR**

**分支**：`Ink-lotus:fix/kv-d1-migration` → `imzyb:main`
**基线**：`upstream/main` @ `1008b7c`
**提交**：`5038f81`（单个提交，3 文件，+244/-20）
**创建 PR 链接**：https://github.com/Ink-lotus/MiSub/pull/new/fix/kv-d1-migration

---

## ⚠️ 提交前必读：上游测试已有一条红灯

在纯净的 `upstream/main`（`1008b7c`，未含我们任何改动）上运行测试，`tests/unit/node-transformer.test.js` 就已经失败：

```
FAIL  removes useless info nodes when useless filter is enabled
AssertionError: expected [ …(4) ] to have a length of 3 but got 4
```

**这不是我们造成的。** 成因是上游自己的 `b477c8b`（2026-08-29，「添加放行系统虚拟信息节点」）给 `isUselessNode` 加了虚拟信息节点放行逻辑：

```js
const isVirtualInfoNode = protocol === 'trojan'
    && server === '127.0.0.1'
    && Number(record?.port) === 443
    && String(record?.url || '').includes(`trojan://${VIRTUAL_INFO_NODE_UUID}@127.0.0.1:443#`)
    && /(?:流量剩余|到期时间|您的订阅已到期)/.test(name);

if (isVirtualInfoNode) return false;
```

而 `node-transformer.test.js:81` 仍断言旧行为（流量剩余节点应被过滤掉）。功能改了，测试没跟着改。

**这对 PR 的影响：**

1. **不能在 PR 里写「全量测试通过」** —— 会被一眼看穿，损害可信度
2. 只能说「本 PR 新增的 10 条测试通过；`node-transformer.test.js` 在本 PR 基线上即已失败，与本改动无关」
3. 可选：在 PR 里附带一句提醒，或另开一个 issue 告知作者

我倾向在 PR 正文里用一小段说明这件事，既澄清了自己，也帮作者发现问题。

---

## PR 标题

```
修复 KV→D1 迁移时业务数据静默丢失 / Fix silent data loss during KV→D1 migration
```

---

## PR 正文（双语，中文在前）

### 问题 / Problem

`migrateKVToD1` 只搬运 `subscriptions` / `profiles` / `settings` 三个键，其余业务数据留在 KV。迁移后 `storageType` 切换为 `d1`，读取走 D1，这些数据全部变空 —— 而接口仍返回「数据已成功迁移到 D1 数据库」。用户若按引导解绑 KV，数据彻底无法找回。

`migrateKVToD1` only migrated `subscriptions`, `profiles`, and `settings`, leaving other business data in KV. After migration `storageType` switches to `d1`, reads go through D1, and these keys become empty — yet the API still returns "Data successfully migrated to D1 database". If users unbind KV as guided, the data is unrecoverable.

**本地实测 / Local reproduction:**

| | 迁移前 / Before | 迁移后重启 / After migration + restart |
|---|---|---|
| 修复前 / Before fix | 2 条 DNS 模板 | **0 条** |
| 修复后 / After fix | 2 条 DNS 模板 | **2 条** |

### 漏搬的键 / Keys that were skipped

| 键 / Key | 承载内容 / Contents |
|---|---|
| `misub_dns_templates_v1` | DNS 模板 / DNS templates |
| `misub_rule_templates_v1` | 规则模板 / Rule templates |
| `misub_clients_v1` | 客户端列表 / Client list |
| `misub_guestbook_v1` | 留言板 / Guestbook |
| `misub_settings_v1` | 其它设置 / Other settings |
| `misub_restore_snapshot_latest` | 恢复快照 / Restore snapshot |
| `misub_profile_download_count_*` | 订阅组下载计数（前缀枚举）/ Download counts (prefix) |

### 修复内容 / Changes

**1. 搬运清单改为声明式 / Declarative migration list**

从硬编码的三段 try-catch 改成 `D1_MIGRATION_KEYS` + `D1_MIGRATION_KEY_PREFIXES`，后者先 `list()` 枚举再逐条搬运。

**刻意排除的键（代码注释已说明）/ Intentionally excluded (documented in code):**

- `misub_webdav_backup_lock` —— 定时任务互斥锁，搬一个过期锁会挡住下次备份 / Mutex lock; migrating a stale lock would block the next backup
- `misub_system_logs` / `misub_error_reports` —— 诊断日志，体积可能很大，非业务数据 / Diagnostic logs, potentially large, not business data
- `misub_data_v1` —— 更早的遗留格式，由 `api-router` 的 `/migrate` 独立升级路径处理 / Legacy format, handled by the separate `/migrate` path in `api-router`

**2. `settings` 改到最后搬 / Migrate `settings` last**

`storageType` 一旦翻成 `d1`，后续读取就切库。原实现把 settings 放在中间，若后续步骤失败会留下「已切 d1、数据还在 kv」的半迁移状态。

Once `storageType` flips to `d1`, subsequent reads switch databases. The original order left a half-migrated state if a later step failed.

**3. 逐键状态报告 / Per-key status reporting**

返回对象新增 `keys` 字段（`migrated` / `empty` / `failed`），保留原有三个布尔位以兼容既有调用方；接口响应带上 `migratedKeys` 与键数量。

Added a `keys` field while preserving the original three booleans for backward compatibility.

修复前 / Before:
```json
{"success": true, "message": "数据已成功迁移到 D1 数据库"}
```

修复后 / After:
```json
{
  "success": true,
  "message": "数据已成功迁移到 D1 数据库（搬运 2 个键）",
  "migratedKeys": ["misub_dns_templates_v1", "worker_settings_v1"]
}
```

**4. 收窄 `_parseKey` 告警 / Narrow `_parseKey` warnings**

这些业务键本就以 `settings` 表为家，原实现每写一次就打一行 `Unknown key format`，会把真正的异常 key 淹没。新增 `D1_KNOWN_SETTINGS_KEYS` 白名单，只对真正未知的键告警。

These business keys legitimately live in the `settings` table; the previous code logged `Unknown key format` on every write, drowning out real anomalies.

### 测试 / Tests

新增 `tests/unit/storage-migration-completeness.test.js`，10 条用例，用内存版 KV / D1 假件覆盖：

- DNS 模板确实落到 D1（修复前静默丢失的那条路径）
- 规则模板 / 客户端 / 留言板 / 恢复快照一并搬运
- 前缀键 `misub_profile_download_count_*` 枚举搬运
- 瞬时锁与诊断日志不被搬运
- `settings` 搬运时 `storageType` 正确翻成 `d1`
- 旧布尔位 `subscriptions` / `profiles` 兼容
- KV 里不存在的键报 `empty` 而非 `failed`
- 缺少 KV 绑定时抛错，不静默成功

**关于测试状态的说明 / Note on test status:**

本 PR 新增的 10 条测试全部通过。需要说明的是，`tests/unit/node-transformer.test.js > removes useless info nodes when useless filter is enabled` 在本 PR 的基线 `1008b7c` 上**即已失败**，与本改动无关 —— `b477c8b`（添加放行系统虚拟信息节点）为虚拟信息节点加了放行逻辑，但该测试仍断言旧的过滤行为。可能需要单独更新该测试。

The 10 tests added by this PR all pass. Note that `node-transformer.test.js > removes useless info nodes...` **already fails on the base commit `1008b7c`**, unrelated to this change — `b477c8b` added passthrough logic for virtual info nodes, but that test still asserts the old filtering behavior. It likely needs a separate update.

### 与 #423 的关系 / Relation to #423

Issue #423「D1数据库无法订阅」症状不同：节点是从上游 URL **实时拉取**的，不作为独立键存在 KV/D1 中（只有 `node_cache_*` 性能缓存层）。#423 更可能源于缓存层在 D1 模式下的行为差异或订阅拉取本身的问题，与本 PR 修复的「迁移漏搬业务键」是不同的 bug。此处提及是因为两者都表现为「D1 下数据不可用」，但根因与修复路径不同。

Issue #423 has different symptoms: nodes are **fetched on demand** from upstream URLs, not stored as standalone keys (only the `node_cache_*` performance layer). Likely a different root cause. Mentioned here because both surface as "data unavailable under D1", but the causes differ.

### 兼容性 / Compatibility

- 未改动数据模型或 D1 schema / No data model or D1 schema changes
- 未改动 KV 模式下的任何行为 / No behavior changes in KV mode
- 返回对象保留原有三个布尔字段 / Original three boolean fields preserved
- `_parseKey` 的 catch-all 分支保持不变，仅收窄告警 / `_parseKey` catch-all unchanged, only warnings narrowed

---

## 变更文件

```
functions/modules/api-router.js                   |   8 +-
functions/storage-adapter.js                      | 106 ++++++++++++---
tests/unit/storage-migration-completeness.test.js | 150 ++++++++++++++++++++++
3 files changed, 244 insertions(+), 20 deletions(-)
```

---

## 待你决定

1. **上游那条红灯要不要在 PR 里提？** 我的建议是提（如上文所写），既澄清自己也帮作者。另一个选项是不提、只说「新增测试通过」，但作者跑 CI 时还是会看到。
2. **要不要顺便修那条测试？** 技术上一行就能改（`toHaveLength(3)` → `4`，并调整后两条断言），但它属于另一个功能范畴，混进来会让 PR 不再"小而专"。我倾向不修，只在正文里提一句。
3. **`_parseKey` 告警收窄要不要拆出去？** 它严格说是行为变更（少打日志），拆掉能让核心修复的 diff 更小。但它与本次修复直接相关（新增的搬运键正是告警源头），我倾向保留。
