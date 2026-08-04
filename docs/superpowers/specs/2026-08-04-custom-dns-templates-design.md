# 设计：内置渲染自定义 DNS 模板

日期：2026-08-04
状态：已批准（用户确认）
范围：仅作用于 MiSub 内置渲染生成器输出

## 1. 背景与目标

MiSub 内置渲染模式为 Clash、Sing-Box、Surge、Loon、Quantumult X 等客户端生成完整订阅配置，每个端都有一段默认 DNS 配置。当前无法定制该 DNS 段。

本功能提供**可复用的命名 DNS 模板库**：全局可新建/编辑多个 DNS 模板（每个模板内含 5 个格式各自独立的 DNS 输入）；并在「规则与配置方案」中提供全局 DNS 入口、在 Profile 中提供 DNS 选择。留空则使用当前内置默认 DNS。

已确认的关键决策（来自用户选择）：

- **不做"统一"开关**：5 个端 DNS 语法差异大（Clash=YAML 映射、Sing-Box=JSON 对象、Surge/Loon=`dns-server` 行、QX=`[dns]` 段），一个统一内容框兼容性差，故去掉。
- **模板库承载方式 = 仿自定义规则模板**（独立 KV + 独立 API + 独立管理 UI）。
- **作用范围与"自定义规则"一致**：全局 DNS 应用于普通订阅（无 Profile）及继承全局的 Profile；Profile 可三选（默认内置 / 继承全局 / 指定某模板）。优先级：**Profile 指定模板 > 全局 DNS > 内置默认**。
- **D1 兼容**：DNS 模板库复用 `storageAdapter.get/put` 泛化键模式，D1 下与规则模板走完全相同的落库路径（未知键落到 settings 键值表，见 `storage-adapter.js:_parseKey` 默认分支），天然兼容 KV/D1 切换。
- **前端落位**：「DNS 模板库」板块放"服务集成"模块、位于"自定义规则模板"之后（同级）；「3. DNS 配置」小节放"规则与配置方案"卡片内、"2. 模板配置"之后。

## 2. 数据模型

### 2.1 DNS 模板库（KV 数组）

新 KV 键：`misub_dns_templates_v1`，值为 DNS 模板数组。

```js
{
  id: 'dns-template-<ts>-<rand>',   // sanitizeId 处理
  name: '模板名',                   // ≤80 字符，默认 '未命名 DNS 模板'
  description: '',                  // ≤300 字符
  enabled: true,
  createdAt: '<ISO>',
  updatedAt: '<ISO>',
  clash: '',                        // Clash YAML 映射体（`dns:` 之下的键），可空
  singbox: '',                      // Sing-Box JSON 对象，可空
  surge: '',                        // dns-server 的值（如 `8.8.8.8, 1.1.1.1`），可空
  loon: '',                         // 同 surge，可空
  quanx: ''                         // [dns] 段体（no-ipv6 + server 行），可空
}
```

约束：最多 50 条；每条各格式字段合计 ≤128KB（沿用规则模板的 MAX_TEMPLATE_CONTENT_LENGTH）。各格式字段**均可选为空**，空表示该端在该模板内仍用内置默认 DNS。

### 2.2 全局设置

全局设置（`DEFAULT_SETTINGS`，存储于 `worker_settings_v1`）新增：

```js
dnsConfig: { mode: 'builtin', templateId: '' }
```

- `mode: 'builtin'` = 使用内置默认 DNS（留空亦如此）。
- `mode: 'template'` + `templateId` = 指定 DNS 模板库中某一模板作为全局默认。

作用范围与规则模板一致：应用于普通订阅（无 Profile）及继承全局的 Profile。

### 2.3 Profile

Profile 新增字段：

```js
dnsConfig: { mode: 'global', templateId: '' }
```

- `mode: 'global'`（默认）= 继承全局 DNS 配置。
- `mode: 'builtin'` = 使用内置默认（忽略全局）。
- `mode: 'template'` + `templateId` = 指定某已存 DNS 模板。

字段随 Profile 归一化保留（`normalizeProfile` 已 `{...profile}` 展开，无需额外处理）。

## 3. 后端 API（仿 rule-template-handler）

新增 `functions/modules/dns-template-handler.js`：

- `normalizeDnsTemplates(input)`：清洗、去重 id、限长度与数量。
- `listDnsTemplates(storageAdapter)`：读取并归一化 KV。
- `resolveDnsTemplate(storageAdapter, id)`：按 id 返回启用的模板或 `null`（仿 `resolveRuleTemplateSource`）。
- `handleDnsTemplatesRequest(request, env)`：GET 返回 `{ success, data }`；POST 保存 `body.templates || body.data` 并回写 KV。

路由注册（`api-router.js`）：`case '/dns_templates': return await handleDnsTemplatesRequest(request, env);`

`/api/data`（`api-handler.js`）：在返回值中追加 `dnsTemplates`（`listDnsTemplates(...).catch(...)`，仿规则模板的容错写法）。

## 4. 生成链路注入

### 4.1 解析与传递

`functions/modules/subscription/main-handler.js` 中，按以下优先级解析 DNS（读取 DNS 模板库需经 `storageAdapter`）：

1. Profile `dnsConfig.mode === 'template'` → `resolveDnsTemplate(storageAdapter, profile.dnsConfig.templateId)`。
2. Profile `dnsConfig.mode === 'builtin'` → 不使用自定义 DNS（内置默认）。
3. 其余（Profile `mode === 'global'`，或普通订阅无 Profile）→ 看全局 `config.dnsConfig`：
   - `mode === 'template'` → 解析全局 `templateId` 对应模板；
   - `mode === 'builtin'` → 不使用自定义 DNS。

命中模板 → `builtinOptions.customDns = { clash, singbox, surge, loon, quanx }`（空字段保留为空字符串）；未命中 → `builtinOptions.customDns = null`（内置默认）。

### 4.2 各生成器注入（整段替换）

| 端 | 文件 | 读取键 | 注入方式 |
|---|---|---|---|
| Clash | `builtin-clash-generator.js` | `customDns.clash` | `yaml.parse(text)` 成功则 `config.dns = parsed`；失败回退默认（约 :206） |
| Sing-Box | `builtin-singbox-generator.js` | `customDns.singbox` | `JSON.parse(text)` 成功则 `config.dns = parsed`；失败回退默认（约 :351） |
| Surge | `builtin-surge-generator.js` | `customDns.surge` | 替换 `[General]` 内 `dns-server = …` 行为 `dns-server = <value>`（:453） |
| Loon | `builtin-loon-generator.js` | `customDns.loon` | 替换 `[General]` 内 `dns-server = …` 行为 `dns-server = <value>`（:319） |
| Quantumult X | `builtin-quanx-generator.js` | `customDns.quanx` | 替换 `[dns]` 段体（`no-ipv6`/`server` 行）为粘贴内容（:281） |

规则：
- 字段为空 → 保持该端内置默认 DNS 不变。
- Clash/Sing-Box 输入**解析失败一律回退默认**，绝不中断生成。
- **边界**：仅作用于内置生成器输出；若订阅使用了整份自定义规则模板（kind=custom/remote）或外部 subconverter，DNS 模板不生效（模板/外部后端自带 DNS）。

## 5. 前端 UI

### 5.1 DNS 模板库管理板（新组件 `DnsTemplateManager.vue`）

放在「服务集成」模块内（`ServiceSettings.vue` → `TransformCard.vue`），作为"自定义规则模板"（`<RuleTemplateManager />`）的**同级板块**，位于其之后。交互完全复刻 `RuleTemplateManager.vue`：

- 左侧模板列表（名称 + `dns:<id>`），支持新建/复制/删除/刷新/保存。
- 右侧选中模板编辑区：名称、描述、启用 + 5 个格式文本域（clash/singbox/surge/loon/quanx），各带格式占位符说明。
- 空白态提示"留空 = 使用默认 DNS"。

### 5.2 全局「3. DNS 配置」（全局入口）

在「规则与配置方案」卡片（`TransformCard.vue`）内、"2. 模板配置"之后新增「3. DNS 配置」小节：一个全局 DNS 选择器，绑定 `settings.dnsConfig`：

- 默认内置（`mode='builtin'`）。
- 从 DNS 模板库选择一模板（`mode='template'` + `templateId`）。

### 5.3 Profile DNS 选择

`src/components/modals/ProfileModal/ProfileForm.vue` 增加 DNS 三选（`dnsConfig.mode` + `templateId`）：默认内置 / 继承全局 / 指定某已存模板。仅选择，不做 5 字段编辑。

### 5.4 Store 与 i18n

- `src/stores/useDataStore.js`：新增 `dnsTemplates` ref、从 `/api/data` 响应加载、`fetchDnsTemplates()`、`saveDnsTemplates()`（仿 `ruleTemplates`）。
- `src/i18n/messages.js`：新增 DNS 模板库与「3. DNS 配置」相关文案。
- `src/lib/api.js`：无新增端点（store 直接 `api.get/post('/api/dns_templates')`，仿规则模板）。

## 6. 涉及文件

后端：
- `functions/modules/dns-template-handler.js`（新）
- `functions/modules/config.js`（DEFAULT_SETTINGS 新增 `dnsConfig`）
- `functions/modules/api-router.js`（路由）
- `functions/modules/api-handler.js`（/api/data 追加 dnsTemplates）
- `functions/modules/subscription/main-handler.js`（解析全局/Profile→builtinOptions.customDns）
- 5 个生成器各加注入

前端：
- `src/components/settings/sections/ServiceSettings/DnsTemplateManager.vue`（新，模板库管理板）
- `src/components/settings/sections/ServiceSettings/TransformCard.vue`（追加"3. DNS 配置"小节 + 挂载 DnsTemplateManager）
- `src/components/modals/ProfileModal/ProfileForm.vue`（DNS 三选）
- `src/stores/useDataStore.js`
- `src/i18n/messages.js`

测试：`tests/unit/` 增补 5 端各至少一个 DNS 覆盖回归用例、模板解析/回退用例、以及全局/Profile DNS 解析与优先级用例。

## 7. 验证

- `npm run test:run`（新增 + 既有回归）
- `npm run build`（前端构建通过）
- 手动验证：新建 DNS 模板 → 在全局「3. DNS 配置」设为该模板 → 普通订阅输出中相应端 DNS 段被替换；Profile 设为指定模板/继承全局/默认内置时分别验证；留空仍为默认。

## 8. 不在范围内

- 不做"统一"单框开关。
- 不作用于外部 subconverter 或整份自定义规则模板。
- Egern 生成器不在本期（用户未要求；若后续需要可扩展同方案）。
