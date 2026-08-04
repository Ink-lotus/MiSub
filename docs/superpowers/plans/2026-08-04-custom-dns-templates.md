# 内置渲染自定义 DNS 模板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 MiSub 内置渲染提供可复用的命名 DNS 模板库，支持各端（Clash/Sing-Box/Surge/Loon/QX）整段替换 DNS，并在全局「3. DNS 配置」与 Profile 三选中应用。

**Architecture:** 新增独立 KV 键 `misub_dns_templates_v1` 与 API `/api/dns_templates`（完全仿自定义规则模板 `rule-template-handler.js`）。全局设置与 Profile 各新增 `dnsConfig` 字段（mode + templateId）。`main-handler` 按优先级（Profile 指定模板 > 全局 DNS > 内置默认）解析出 `builtinOptions.customDns`，各生成器据此整段替换 DNS 区；解析失败回退内置默认。

**Tech Stack:** Cloudflare Pages Functions (ESM)、KV/D1 双存储（storage-adapter）、Vue 3 + Pinia + Vite、Vitest、js-yaml、Tailwind。

参考设计文档：`docs/superpowers/specs/2026-08-04-custom-dns-templates-design.md`

## Global Constraints

- 数据库操作必须经 `functions/storage-adapter.js` 的 Adapter 实例（`storageAdapter.get/put`），严禁直接访问 `env.KV`/`env.DB`。DNS 模板库走泛化键，天然兼容 KV/D1（`_parseKey` 默认落到 settings 表）。
- KV 键常量 `misub_dns_templates_v1`；最多 50 条；单条各格式字段合计 ≤128KB（沿用规则模板 `MAX_TEMPLATE_CONTENT_LENGTH`）。
- Clash（`js-yaml`）与 Sing-Box（`JSON.parse`）自定义 DNS **解析失败必须静默回退内置默认**，绝不中断生成、不向输出抛错。
- DNS 覆盖仅作用于内置生成器输出；不作用于整份自定义规则模板或外部 subconverter。
- 后端 `DEFAULT_SETTINGS` 与前端 `src/constants/default-settings.js` 需同步新增同一 `dnsConfig` 默认值。
- i18n 文案需同时补充 `zh-CN` 与 `en` 两个 locale。
- 提交策略：遵循本仓库/用户偏好，**不主动 `git push`**；`git commit` 需在任务内明确执行并遵守既有提交信息风格（如 `feat(...)`）。
- 验证命令：`npm run test:run`、`npm run build`。

---

### Task 1: 后端 DNS 模板处理器

**Files:**
- Create: `functions/modules/dns-template-handler.js`
- Test: `tests/unit/dns-template-handler.test.js`

**Interfaces:**
- Consumes: `StorageFactory`（`../storage-adapter.js`）、`createJsonResponse/createErrorResponse/readJsonWithLimit/JSON_BODY_LIMITS`（`./utils.js`）。
- Produces:
  - `export const KV_KEY_DNS_TEMPLATES = 'misub_dns_templates_v1'`
  - `export function normalizeDnsTemplates(input = []) -> Array`
  - `export async function listDnsTemplates(storageAdapter) -> Array`
  - `export function resolveEffectiveDnsConfig({ profileDns, globalDns, templates }) -> {clash,singbox,surge,loon,quanx} | null`
  - `export async function handleDnsTemplatesRequest(request, env) -> Response`

- [ ] **Step 1: 写失败测试**

`tests/unit/dns-template-handler.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { normalizeDnsTemplates, resolveEffectiveDnsConfig } from '../../functions/modules/dns-template-handler.js';

describe('DNS 模板归一化', () => {
  it('应清洗字段、生成 id、默认 enabled', () => {
    const normalized = normalizeDnsTemplates([{ name: '带空格的模板!', clash: 'enable: true', surge: '1.1.1.1' }]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].name).toBe('带空格的模板!');
    expect(normalized[0].id).toMatch(/^dns-template-/);
    expect(normalized[0].enabled).toBe(true);
    expect(normalized[0].clash).toBe('enable: true');
    expect(normalized[0].quanx).toBe('');
  });
  it('应过滤无任何 DNS 内容的空模板', () => {
    const normalized = normalizeDnsTemplates([{ name: '空', content: 'x' }, { name: '无字段' }]);
    expect(normalized).toHaveLength(0);
  });
});

describe('DNS 生效优先级', () => {
  const templates = [
    { id: 't1', enabled: true, clash: 'a', singbox: '', surge: '', loon: '', quanx: '' },
    { id: 't2', enabled: false, clash: 'b' },
  ];
  it('Profile 指定模板优先', () => {
    const r = resolveEffectiveDnsConfig({ profileDns: { mode: 'template', templateId: 't1' }, globalDns: { mode: 'template', templateId: 't2' }, templates });
    expect(r.clash).toBe('a');
  });
  it('Profile 默认内置 → 忽略全局', () => {
    const r = resolveEffectiveDnsConfig({ profileDns: { mode: 'builtin' }, globalDns: { mode: 'template', templateId: 't1' }, templates });
    expect(r).toBeNull();
  });
  it('Profile 继承全局(global) → 用全局模板', () => {
    const r = resolveEffectiveDnsConfig({ profileDns: { mode: 'global' }, globalDns: { mode: 'template', templateId: 't1' }, templates });
    expect(r.clash).toBe('a');
  });
  it('全局内置默认 → null', () => {
    const r = resolveEffectiveDnsConfig({}, { /* no-op */ });
    expect(r).toBeNull();
  });
  it('禁用或未找到的模板 → null', () => {
    const r = resolveEffectiveDnsConfig({ profileDns: { mode: 'template', templateId: 't2' }, globalDns: {}, templates });
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:run -- tests/unit/dns-template-handler.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`functions/modules/dns-template-handler.js`：

```js
import { StorageFactory } from '../storage-adapter.js';
import { createJsonResponse, createErrorResponse, JSON_BODY_LIMITS, readJsonWithLimit } from './utils.js';

export const KV_KEY_DNS_TEMPLATES = 'misub_dns_templates_v1';
const MAX_TEMPLATE_COUNT = 50;
const MAX_TEMPLATE_CONTENT_LENGTH = 128 * 1024;
const DNS_FIELDS = ['clash', 'singbox', 'surge', 'loon', 'quanx'];

function nowIso() { return new Date().toISOString(); }
function sanitizeId(value = '') {
    return String(value || '').trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}
function createId() {
    const random = Math.random().toString(36).slice(2, 10);
    return `dns-template-${Date.now().toString(36)}-${random}`;
}

export function normalizeDnsTemplates(input = []) {
    if (!Array.isArray(input)) return [];
    const seen = new Set();
    const normalized = [];
    for (const item of input.slice(0, MAX_TEMPLATE_COUNT)) {
        if (!item || typeof item !== 'object') continue;
        const hasAnyDns = DNS_FIELDS.some(f => typeof item[f] === 'string' && item[f].trim().length > 0);
        if (!hasAnyDns) continue;
        let totalLen = 0;
        const fields = {};
        for (const f of DNS_FIELDS) {
            const v = typeof item[f] === 'string' ? item[f].trim() : '';
            totalLen += v.length;
            fields[f] = v;
        }
        if (totalLen > MAX_TEMPLATE_CONTENT_LENGTH) continue;
        let id = sanitizeId(item.id) || createId();
        while (seen.has(id)) id = `${id}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 80);
        seen.add(id);
        const createdAt = item.createdAt && !Number.isNaN(Date.parse(item.createdAt)) ? item.createdAt : nowIso();
        normalized.push({
            id,
            name: String(item.name || '').trim().slice(0, 80) || '未命名 DNS 模板',
            description: String(item.description || '').trim().slice(0, 300),
            enabled: item.enabled !== false,
            createdAt,
            updatedAt: nowIso(),
            ...fields
        });
    }
    return normalized;
}

export async function listDnsTemplates(storageAdapter) {
    const raw = await storageAdapter.get(KV_KEY_DNS_TEMPLATES);
    return normalizeDnsTemplates(Array.isArray(raw) ? raw : []);
}

export function resolveEffectiveDnsConfig({ profileDns = {}, globalDns = {}, templates = [] } = {}) {
    const pick = (mode, templateId) => {
        if (mode !== 'template' || !templateId) return null;
        const tpl = templates.find(t => t.enabled !== false && t.id === templateId);
        if (!tpl) return null;
        return { clash: tpl.clash || '', singbox: tpl.singbox || '', surge: tpl.surge || '', loon: tpl.loon || '', quanx: tpl.quanx || '' };
    };
    const profileMode = profileDns?.mode || 'global';
    if (profileMode === 'template') return pick('template', profileDns?.templateId);
    if (profileMode === 'builtin') return null;
    // Profile 继承全局 或 普通订阅（无 profileDns）
    return pick(globalDns?.mode || 'builtin', globalDns?.templateId);
}

async function getStorageAdapter(env) {
    if (env?.__TEST_STORAGE_ADAPTER) return env.__TEST_STORAGE_ADAPTER;
    const storageType = await StorageFactory.getStorageType(env);
    return StorageFactory.createAdapter(env, storageType);
}

export async function handleDnsTemplatesRequest(request, env) {
    try {
        const storageAdapter = await getStorageAdapter(env);
        if (request.method === 'GET') {
            const templates = await listDnsTemplates(storageAdapter);
            return createJsonResponse({ success: true, data: templates });
        }
        if (request.method === 'POST') {
            let body;
            try {
                body = await readJsonWithLimit(request, JSON_BODY_LIMITS.normal);
            } catch (e) {
                if (e?.status === 413) return createJsonResponse({ success: false, message: e.message, error: e.message }, 413);
                return createJsonResponse({ success: false, message: '请求数据格式错误' }, 400);
            }
            const templates = normalizeDnsTemplates(body?.templates || body?.data || []);
            await storageAdapter.put(KV_KEY_DNS_TEMPLATES, templates);
            return createJsonResponse({ success: true, message: 'DNS 模板已保存', data: templates });
        }
        return createErrorResponse('Method Not Allowed', 405);
    } catch (error) {
        console.error('[DnsTemplates] request failed:', error);
        return createJsonResponse({ success: false, message: `DNS 模板操作失败: ${error.message || '服务器内部错误'}` }, 500);
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:run -- tests/unit/dns-template-handler.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add functions/modules/dns-template-handler.js tests/unit/dns-template-handler.test.js
git commit -m "feat(dns): add DNS template handler with KV storage"
```

---

### Task 2: 注册 API 路由与 /api/data 透出

**Files:**
- Modify: `functions/modules/api-router.js`（顶部 import + `switch`）
- Modify: `functions/modules/api-handler.js`（`/api/data` 追加 `dnsTemplates`）
- Test: `tests/unit/api-handler-storage-helpers.test.js`（或新增断言）

- [ ] **Step 1: 写失败/断言测试**

在 `tests/unit/api-handler-storage-helpers.test.js` 追加（或新增 `tests/unit/dns-templates-api.test.js`，用假 adapter + 假 env）：

```js
import { describe, it, expect } from 'vitest';
import { handleDnsTemplatesRequest } from '../../functions/modules/dns-template-handler.js';

function fakeAdapter(seed = []) {
  let store = seed;
  return {
    async get() { return store; },
    async put(_k, v) { store = v; return true; }
  };
}
const fakeEnv = { __TEST_STORAGE_ADAPTER: fakeAdapter() };

describe('DNS 模板 API', () => {
  it('GET 返回列表', async () => {
    const res = await handleDnsTemplatesRequest(new Request('http://x/api/dns_templates', { method: 'GET' }), fakeEnv);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });
  it('POST 保存并回读', async () => {
    const req = new Request('http://x/api/dns_templates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templates: [{ name: 't', surge: '1.1.1.1' }] })
    });
    const res = await handleDnsTemplatesRequest(req, fakeEnv);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data[0].surge).toBe('1.1.1.1');
  });
});
```

- [ ] **Step 2: 运行确认失败**
Run: `npm run test:run -- tests/unit/dns-templates-api.test.js`
Expected: 测试通过（handler 已在 Task 1 实现），此步用于锁定 API 行为。若 `readJsonWithLimit` 对 `undefined` content-length 有特殊处理，按既有规则微调。

- [ ] **Step 3: 注册路由并透出 /api/data**

`functions/modules/api-router.js`：
- 顶部：`import { handleDnsTemplatesRequest } from './dns-template-handler.js';`
- `switch (path)` 内（仿 `/rule_templates`）：
```js
case '/dns_templates':
    return await handleDnsTemplatesRequest(request, env);
```

`functions/modules/api-handler.js`：
- 顶部：`import { listDnsTemplates, KV_KEY_DNS_TEMPLATES } from './dns-template-handler.js';`
- `/api/data` 的 `Promise.all` 增加并行读取（仿 `ruleTemplates`）：
```js
listDnsTemplates(storageAdapter).catch(error => {
    console.warn('[API /data] Failed to load DNS templates:', error?.message || error);
    return [];
})
```
- 返回值追加：`return createJsonResponse({ misubs, profiles, ruleTemplates, dnsTemplates, config });`

- [ ] **Step 4: 运行相关测试确认通过**
Run: `npm run test:run -- tests/unit/api-handler-storage-helpers.test.js tests/unit/dns-templates-api.test.js`
Expected: PASS

- [ ] **Step 5: 提交**
```bash
git add functions/modules/api-router.js functions/modules/api-handler.js tests/unit/dns-templates-api.test.js
git commit -m "feat(dns): register /api/dns_templates and expose in /api/data"
```

---

### Task 3: 全局默认值 + 备份对等

**Files:**
- Modify: `functions/modules/config.js`（`DEFAULT_SETTINGS` 新增 `dnsConfig`）
- Modify: `src/constants/default-settings.js`（同步新增 `dnsConfig`）
- Modify: `functions/modules/webdav-backup-handler.js`（备份/恢复 `dnsTemplates`，与 `ruleTemplates` 对等）
- Test: 扩展 `tests/unit/dns-template-handler.test.js` 或新增对 `config` 的断言

- [ ] **Step 1: 写断言测试**

在 `tests/unit/dns-template-handler.test.js` 追加：

```js
import { DEFAULT_SETTINGS } from '../../functions/modules/config.js';
it('全局默认 dnsConfig 为 builtin 空 templateId', () => {
  expect(DEFAULT_SETTINGS.dnsConfig).toEqual({ mode: 'builtin', templateId: '' });
});
```

- [ ] **Step 2: 运行确认失败**
Run: `npm run test:run -- tests/unit/dns-template-handler.test.js`
Expected: FAIL（`dnsConfig` 未定义）

- [ ] **Step 3: 实现**

`functions/modules/config.js` 的 `DEFAULT_SETTINGS` 末尾（`subconverter` 之后）新增：

```js
    // 自定义 DNS 模板：mode='builtin'|'template'，templateId 引用 DNS 模板库
    dnsConfig: {
        mode: 'builtin',
        templateId: ''
    }
```

`src/constants/default-settings.js` 同步新增同样结构。

`functions/modules/webdav-backup-handler.js`（仿 `ruleTemplates` 全部出现处）：
- 顶部：`import { KV_KEY_DNS_TEMPLATES, listDnsTemplates } from './dns-template-handler.js';`
- 数据收集 `Promise.all` 追加 `listDnsTemplates(storageAdapter).catch(() => [])`，并在 businessData 增加 `dnsTemplates: Array.isArray(dnsTemplates) ? dnsTemplates : []`。
- 导出/恢复 payload 均加入 `dnsTemplates`（克隆与回写，`payload.data.dnsTemplates`）。
- 恢复落库：`await storageAdapter.put(KV_KEY_DNS_TEMPLATES, Array.isArray(payload.data.dnsTemplates) ? payload.data.dnsTemplates : []);`

- [ ] **Step 4: 运行确认通过**
Run: `npm run test:run -- tests/unit/dns-template-handler.test.js tests/unit/storage-adapter-row-level.test.js`
Expected: PASS

- [ ] **Step 5: 提交**
```bash
git add functions/modules/config.js src/constants/default-settings.js functions/modules/webdav-backup-handler.js tests/unit/dns-template-handler.test.js
git commit -m "feat(dns): add global dnsConfig defaults and backup parity"
```

---

### Task 4: main-handler 解析与 customDns 传递

**Files:**
- Modify: `functions/modules/subscription/main-handler.js`（两处 `builtinOptions` 构造处 :771 与 :909）
- Test: 新增 `tests/unit/dns-resolution-regression.test.js`

**Interfaces:**
- Consumes: `listDnsTemplates`、`resolveEffectiveDnsConfig`（Task 1）。
- Produces: `builtinOptions.customDns = {clash,singbox,surge,loon,quanx} | null`，供 `ProcessorService.renderOutput` → 各生成器。

- [ ] **Step 1: 写失败测试**

`tests/unit/dns-resolution-regression.test.js`（纯函数级验证解析逻辑；main-handler 集成路径由既有流水线测试覆盖）：

```js
import { describe, it, expect } from 'vitest';
import { resolveEffectiveDnsConfig } from '../../functions/modules/dns-template-handler.js';

describe('DNS 解析优先级（回归）', () => {
  const tpl = (id, clash = '') => ({ id, enabled: true, clash, singbox: '', surge: '', loon: '', quanx: '' });
  it('普通订阅：全局 template 生效', () => {
    const r = resolveEffectiveDnsConfig({ profileDns: { mode: 'global' }, globalDns: { mode: 'template', templateId: 'g' }, templates: [tpl('g', 'yaml')] });
    expect(r.clash).toBe('yaml');
  });
  it('Profile 默认内置覆盖全局', () => {
    const r = resolveEffectiveDnsConfig({ profileDns: { mode: 'builtin' }, globalDns: { mode: 'template', templateId: 'g' }, templates: [tpl('g', 'yaml')] });
    expect(r).toBeNull();
  });
  it('Profile 指定模板优先于全局', () => {
    const r = resolveEffectiveDnsConfig({ profileDns: { mode: 'template', templateId: 'p' }, globalDns: { mode: 'template', templateId: 'g' }, templates: [tpl('g', 'g'), tpl('p', 'p')] });
    expect(r.clash).toBe('p');
  });
});
```

- [ ] **Step 2: 运行确认失败**
Run: `npm run test:run -- tests/unit/dns-resolution-regression.test.js`
Expected: FAIL（模块未导出解析器）——在 Task 3 完成后该解析器已存在，此步用于锁定语义。

- [ ] **Step 3: main-handler 接线**

在 `main-handler.js` 顶部 import：`import { listDnsTemplates, resolveEffectiveDnsConfig } from '../dns-template-handler.js';`

在构造 `builtinOptions`（约 :909，含 :771 的 profile 路径）**之前**，计算（放在已有 `config` 与 `currentProfile` 可用之处）：

```js
// 解析自定义 DNS：Profile 指定模板 > 全局 DNS > 内置默认
let customDns = null;
try {
    const dnsTemplates = await listDnsTemplates(storageAdapter);
    customDns = resolveEffectiveDnsConfig({
        profileDns: currentProfile?.dnsConfig,
        globalDns: config.dnsConfig,
        templates: dnsTemplates
    });
} catch (e) {
    console.warn('[CustomDns] resolve failed, using default:', e?.message || e);
}
```

并在这两处 `builtinOptions` 对象字面量中加入 `customDns,` 字段。

- [ ] **Step 4: 运行确认通过**
Run: `npm run test:run -- tests/unit/dns-resolution-regression.test.js tests/unit/misub-request-regression.test.js`
Expected: PASS（既有流水线未回归）

- [ ] **Step 5: 提交**
```bash
git add functions/modules/subscription/main-handler.js tests/unit/dns-resolution-regression.test.js
git commit -m "feat(dns): resolve customDns into builtin generation options"
```

---

### Task 5: Clash 与 Sing-Box 注入（YAML/JSON）

**Files:**
- Modify: `functions/modules/subscription/builtin-clash-generator.js`（约 :228，`yaml.dump(config)` 之前）
- Modify: `functions/modules/subscription/builtin-singbox-generator.js`（约 :383，`JSON.stringify(config)` 之前）
- Test: `tests/unit/builtin-clash-generator.test.js`、`tests/unit/builtin-singbox-generator.test.js` 追加用例

- [ ] **Step 1: 写失败测试**

追加到 `tests/unit/builtin-clash-generator.test.js`：

```js
import yaml from 'js-yaml';
it('customDns.clash 应替换内置 DNS（YAML 映射体）', () => {
  const node = 'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@1.2.3.4:8388#HK-Test';
  const result = generateBuiltinClashConfig(node, { customDns: { clash: 'enable: true\nnameserver:\n  - 1.1.1.1' } });
  const parsed = yaml.load(result);
  expect(parsed.dns.nameserver).toEqual(['1.1.1.1']);
  expect(parsed.dns.enable).toBe(true);
});
it('customDns.clash 解析失败应回退默认', () => {
  const node = 'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@1.2.3.4:8388#HK-Test';
  const result = generateBuiltinClashConfig(node, { customDns: { clash: '::this is not yaml: [' } });
  const parsed = yaml.load(result);
  expect(parsed.dns.enable).toBe(true);
});
```

追加到 `tests/unit/builtin-singbox-generator.test.js`：

```js
it('customDns.singbox 应替换内置 dns（JSON 对象）', () => {
  const node = 'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@1.2.3.4:8388#HK-Test';
  const result = JSON.parse(generateBuiltinSingboxConfig(node, { customDns: { singbox: '{"strategy":"prefer_ipv6","servers":[]}' } }));
  expect(result.dns.strategy).toBe('prefer_ipv6');
});
it('customDns.singbox 非法 JSON 应回退默认', () => {
  const node = 'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@1.2.3.4:8388#HK-Test';
  const result = JSON.parse(generateBuiltinSingboxConfig(node, { customDns: { singbox: 'not-json{' } }));
  expect(result.dns.servers.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 运行确认失败**
Run: `npm run test:run -- tests/unit/builtin-clash-generator.test.js tests/unit/builtin-singbox-generator.test.js`
Expected: FAIL（customDns 未生效）

- [ ] **Step 3: 实现**

`builtin-clash-generator.js`：在 config 对象构建后、`yaml.dump` 前插入：

```js
// 自定义 DNS：解析 YAML 映射体覆盖 dns
if (options.customDns?.clash) {
    try {
        const parsed = yaml.load(options.customDns.clash);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            config.dns = parsed;
        }
    } catch (e) {
        console.warn('[BuiltinClash] custom DNS invalid, keep default:', e?.message || e);
    }
}
```

`builtin-singbox-generator.js`：在 return 前插入：

```js
// 自定义 DNS：解析 JSON 对象覆盖 dns
if (options.customDns?.singbox) {
    try {
        const parsed = JSON.parse(options.customDns.singbox);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            config.dns = parsed;
        }
    } catch (e) {
        console.warn('[BuiltinSingbox] custom DNS invalid, keep default:', e?.message || e);
    }
}
```

- [ ] **Step 4: 运行确认通过**
Run: `npm run test:run -- tests/unit/builtin-clash-generator.test.js tests/unit/builtin-singbox-generator.test.js`
Expected: PASS

- [ ] **Step 5: 提交**
```bash
git add functions/modules/subscription/builtin-clash-generator.js functions/modules/subscription/builtin-singbox-generator.js tests/unit/builtin-clash-generator.test.js tests/unit/builtin-singbox-generator.test.js
git commit -m "feat(dns): inject custom dns into Clash and Sing-Box generators"
```

---

### Task 6: Surge 与 Loon 注入（dns-server 值）

**Files:**
- Modify: `functions/modules/subscription/builtin-surge-generator.js`（约 :450-453）
- Modify: `functions/modules/subscription/builtin-loon-generator.js`（约 :317-322）
- Test: `tests/unit/builtin-surge-generator.test.js`、`tests/unit/builtin-loon-generator.test.js` 追加用例

- [ ] **Step 1: 写失败测试**

追加到 `tests/unit/builtin-surge-generator.test.js`：

```js
it('customDns.surge 应替换 dns-server 行', () => {
  const node = 'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@1.2.3.4:8388#HK-Test';
  const result = generateBuiltinSurgeConfig(node, { customDns: { surge: '8.8.8.8, 1.1.1.1' } });
  expect(result).toContain('dns-server = 8.8.8.8, 1.1.1.1');
});
```

追加到 `tests/unit/builtin-loon-generator.test.js`：

```js
it('customDns.loon 应替换 dns-server 行', () => {
  const node = 'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@1.2.3.4:8388#HK-Test';
  const result = generateBuiltinLoonConfig(node, { customDns: { loon: '223.5.5.5' } });
  expect(result).toContain('dns-server = 223.5.5.5');
});
```

- [ ] **Step 2: 运行确认失败**
Run: `npm run test:run -- tests/unit/builtin-surge-generator.test.js tests/unit/builtin-loon-generator.test.js`
Expected: FAIL（仍为默认行）

- [ ] **Step 3: 实现**

`builtin-surge-generator.js`：在构建 `sections` 前定义默认值并插入模板字符串：

```js
const dnsServerValue = options.customDns?.surge || '119.29.29.29, 223.5.5.5, system';
```
将 `sections.push(\`${managedLine}[General]\n...\ndns-server = 119.29.29.29, 223.5.5.5, system\`)` 中的 `dns-server = 119.29.29.29, 223.5.5.5, system` 改为 `dns-server = ${dnsServerValue}`。

`builtin-loon-generator.js`：同理：
```js
const dnsServerValue = options.customDns?.loon || 'system, 223.5.5.5, 119.29.29.29';
```
将 `sections.push(\`[General]\nipv6 = false\ndns-server = system, 223.5.5.5, 119.29.29.29\n...\`)` 中的该行改为 `dns-server = ${dnsServerValue}`。

- [ ] **Step 4: 运行确认通过**
Run: `npm run test:run -- tests/unit/builtin-surge-generator.test.js tests/unit/builtin-loon-generator.test.js`
Expected: PASS

- [ ] **Step 5: 提交**
```bash
git add functions/modules/subscription/builtin-surge-generator.js functions/modules/subscription/builtin-loon-generator.js tests/unit/builtin-surge-generator.test.js tests/unit/builtin-loon-generator.test.js
git commit -m "feat(dns): inject custom dns-server into Surge and Loon generators"
```

---

### Task 7: Quanx 注入（[dns] 段体）

**Files:**
- Modify: `functions/modules/subscription/builtin-quanx-generator.js`（约 :281）
- Test: `tests/unit/builtin-quanx-generator.test.js` 追加用例

- [ ] **Step 1: 写失败测试**

追加到 `tests/unit/builtin-quanx-generator.test.js`：

```js
it('customDns.quanx 应替换 [dns] 段体', () => {
  const node = 'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@1.2.3.4:8388#HK-Test';
  const result = generateBuiltinQuanxConfig(node, { customDns: { quanx: 'no-ipv6\nserver = 8.8.8.8' } });
  expect(result).toContain('[dns]\nno-ipv6\nserver = 8.8.8.8');
  expect(result).not.toContain('server = 223.5.5.5');
});
```

- [ ] **Step 2: 运行确认失败**
Run: `npm run test:run -- tests/unit/builtin-quanx-generator.test.js`
Expected: FAIL（仍为默认 server 行）

- [ ] **Step 3: 实现**

`builtin-quanx-generator.js` 中 `sections.push(\`[dns]\nno-ipv6\nserver = 223.5.5.5\nserver = 119.29.29.29\`)` 改为：

```js
const dnsSection = options.customDns?.quanx
    ? `[dns]\n${options.customDns.quanx.trim()}`
    : `[dns]\nno-ipv6\nserver = 223.5.5.5\nserver = 119.29.29.29`;
sections.push(dnsSection);
```

- [ ] **Step 4: 运行确认通过**
Run: `npm run test:run -- tests/unit/builtin-quanx-generator.test.js`
Expected: PASS

- [ ] **Step 5: 提交**
```bash
git add functions/modules/subscription/builtin-quanx-generator.js tests/unit/builtin-quanx-generator.test.js
git commit -m "feat(dns): inject custom [dns] section into Quanx generator"
```

---

### Task 8: 前端 store 与 i18n

**Files:**
- Modify: `src/stores/useDataStore.js`
- Modify: `src/i18n/messages.js`
- Test: `tests/unit/*.test.js`（store 相关，如存在）或手测

- [ ] **Step 1: store 增加 dnsTemplates**

`src/stores/useDataStore.js`（仿 `ruleTemplates` 全部出现处）：
- ref：`const dnsTemplates = ref([]);`（紧邻 `ruleTemplates`）
- 初始 data 默认：`dnsTemplates: []`
- `/api/data` 加载：`dnsTemplates.value = data.dnsTemplates || [];`（仿 line 58）
- savedData / 保存对象：`dnsTemplates: dnsTemplates.value,`
- 方法：
```js
async function fetchDnsTemplates() {
    const result = await api.get('/api/dns_templates');
    dnsTemplates.value = Array.isArray(result?.data) ? result.data : [];
    lastSavedData.dnsTemplates = JSON.parse(JSON.stringify(dnsTemplates.value));
    return dnsTemplates.value;
}
async function saveDnsTemplates(items = dnsTemplates.value) {
    try {
        const result = await api.post('/api/dns_templates', { templates: items });
        if (!result?.success && !Array.isArray(result?.data)) throw new Error(result?.message || t('store.saveDnsTemplatesFailed'));
        dnsTemplates.value = Array.isArray(result.data) ? result.data : [];
        lastSavedData.dnsTemplates = JSON.parse(JSON.stringify(dnsTemplates.value));
        showToast(t('store.dnsTemplatesSaved'), 'success');
        return dnsTemplates.value;
    } catch (error) {
        showToast(t('store.saveDnsTemplatesFailedWithMessage', { message: error.message }), 'error');
        throw error;
    }
}
```
- return 暴露 `dnsTemplates, fetchDnsTemplates, saveDnsTemplates`。

- [ ] **Step 2: i18n 新增文案（zh-CN 与 en 各一份）**

在 `src/i18n/messages.js` 的 `zh-CN.settings` 与 `en.settings` 各加（`dnsTemplatesTitle` 等）：

```js
dnsTemplatesTitle: 'DNS 模板库',
dnsTemplatesDesc: '创建可复用的 DNS 模板，并在「规则与配置方案」或订阅组中选择应用。',
dnsTemplatesEmpty: '还没有 DNS 模板',
dnsTemplatesEmptyHint: '新建模板后，可为各端填写对应格式的 DNS 配置，留空则该端使用默认 DNS。',
dnsTemplatesNew: '新建模板',
dnsTemplatesRefresh: '刷新',
dnsTemplatesSave: '保存',
dnsTemplateDefaultName: 'DNS 模板',
dnsTemplateName: '模板名称',
dnsTemplateDescription: '描述',
dnsTemplateContentClash: 'Clash DNS（YAML 映射体）',
dnsTemplateContentSingbox: 'Sing-Box DNS（JSON 对象）',
dnsTemplateContentSurge: 'Surge dns-server 值',
dnsTemplateContentLoon: 'Loon dns-server 值',
dnsTemplateContentQuanx: 'Quantumult X [dns] 段体',
dnsTemplateEnabled: '启用',
dnsPlaceholder: '留空 = 使用默认 DNS',
dnsConfigTitle: '3. DNS 配置',
dnsConfigModeBuiltin: '默认内置 DNS',
dnsConfigModeTemplate: '使用 DNS 模板',
```
`profileModal` 各加（`profileModal.dnsLabel` 等）：

```js
dnsLabel: 'DNS',
dnsFollowGlobal: '继承全局 DNS',
dnsBuiltin: '默认内置 DNS',
dnsUseTemplate: '指定 DNS 模板',
currentGlobalDns: '当前全局：{value}',
```

`store` 各加：

```js
saveDnsTemplatesFailed: '保存 DNS 模板失败',
dnsTemplatesSaved: 'DNS 模板已保存',
saveDnsTemplatesFailedWithMessage: '保存 DNS 模板失败: {message}',
```

- [ ] **Step 3: 运行测试/构建确认**
Run: `npm run build`
Expected: 构建通过（无未定义 key 引用）

- [ ] **Step 4: 提交**
```bash
git add src/stores/useDataStore.js src/i18n/messages.js
git commit -m "feat(dns): add dnsTemplates store methods and i18n copy"
```

---

### Task 9: DNS 模板库管理板（DnsTemplateManager.vue）

**Files:**
- Create: `src/components/settings/sections/ServiceSettings/DnsTemplateManager.vue`
- Modify: `src/components/settings/sections/ServiceSettings/TransformCard.vue`（挂载 `<DnsTemplateManager />`，位于 `<RuleTemplateManager />` 之后）

- [ ] **Step 1: 新建组件（复刻 RuleTemplateManager）**

`DnsTemplateManager.vue` 结构同 `RuleTemplateManager.vue`，差异：
- `blankTemplate` 含 5 个字段：`{ id:'', name:'', description:'', enabled:true, clash:'', singbox:'', surge:'', loon:'', quanx:'' }`，type 字段不需要。
- 从 `useDataStore` 取 `dnsTemplates / fetchDnsTemplates / saveDnsTemplates`（代替 `ruleTemplates`）。
- 右侧编辑区：名称、描述、启用 + 5 个 textarea：
```html
<label>
  <span class="mb-1 block text-[11px] font-bold uppercase tracking-wide text-gray-500">{{ t('settings.dnsTemplateContentClash') }}</span>
  <textarea v-model="selectedTemplate.clash" rows="4" spellcheck="false" :placeholder="t('settings.dnsPlaceholder')"
    class="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"></textarea>
</label>
```
（singbox/surge/loon/quanx 同理，标签用 `dnsTemplateContentSingbox/Surge/Loon/Quanx`。）
- 复制/删除/刷新/保存按钮与空态提示沿用 `RuleTemplateManager.vue`，文案用新增 i18n 键。

- [ ] **Step 2: 挂载到 TransformCard**

`TransformCard.vue`：`import DnsTemplateManager from './DnsTemplateManager.vue';`，并在模板末尾 `<RuleTemplateManager />` 之后追加 `<DnsTemplateManager />`。

- [ ] **Step 3: 运行构建确认**
Run: `npm run build`
Expected: 通过

- [ ] **Step 4: 提交**
```bash
git add src/components/settings/sections/ServiceSettings/DnsTemplateManager.vue src/components/settings/sections/ServiceSettings/TransformCard.vue
git commit -m "feat(dns): add DNS template library management board"
```

---

### Task 10: 全局「3. DNS 配置」小节

**Files:**
- Modify: `src/components/settings/sections/ServiceSettings/TransformCard.vue`（「2. 模板配置」之后、「规则与配置方案」卡片闭合 `</div>` 之前）
- 依赖：`useDataStore.dnsTemplates`

- [ ] **Step 1: 引入 dnsTemplates**

`TransformCard.vue` script 中 `import { useDataStore } from '@/stores/useDataStore.js';`，`const dataStore = useDataStore();`，并确保 `dataStore.dnsTemplates` 已加载（若空可在分组查询后 `dataStore.fetchDnsTemplates()` 或依赖 `/api/data` 初始加载）。

- [ ] **Step 2: 新增「3. DNS 配置」区块**

在「2. 模板配置」右栏所在网格之后、卡片闭合前，新增全宽区块（绑定 `settings.dnsConfig`）：

```html
<div class="mt-4 rounded-xl border border-gray-100 bg-gray-50/50 p-4 dark:border-white/10 dark:bg-white/5">
  <div class="mb-3 flex items-center justify-between">
    <label class="block text-xs font-medium uppercase tracking-wider text-purple-600 dark:text-purple-400">
      {{ t('settings.dnsConfigTitle') }}
    </label>
    <select v-model="settings.dnsConfig.mode"
      class="block rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
      <option value="builtin">{{ t('settings.dnsConfigModeBuiltin') }}</option>
      <option value="template">{{ t('settings.dnsConfigModeTemplate') }}</option>
    </select>
  </div>
  <div v-if="settings.dnsConfig.mode === 'template'" class="mt-2">
    <select v-model="settings.dnsConfig.templateId"
      class="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
      <option v-for="tpl in dataStore.dnsTemplates" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
    </select>
  </div>
  <p class="mt-2 text-[10px] leading-relaxed text-gray-400">{{ t('settings.dnsPlaceholder') }}</p>
</div>
```

- [ ] **Step 3: 兜底 settings.dnsConfig**

在 `TransformCard.vue` script 顶部（仿现有 `subconverter` 兜底）加：
```js
if (!props.settings.dnsConfig) props.settings.dnsConfig = { mode: 'builtin', templateId: '' };
```

- [ ] **Step 4: 运行构建确认**
Run: `npm run build`
Expected: 通过

- [ ] **Step 5: 提交**
```bash
git add src/components/settings/sections/ServiceSettings/TransformCard.vue
git commit -m "feat(dns): add global DNS config section in transform card"
```

---

### Task 11: Profile DNS 三选

**Files:**
- Modify: `src/components/modals/ProfileModal/ProfileForm.vue`

- [ ] **Step 1: 兜底 localProfile.dnsConfig**

在 `ProfileForm.vue` script setup 中（多处 `props.localProfile?.subconverter` 兜底附近）加：
```js
if (!props.localProfile.dnsConfig) props.localProfile.dnsConfig = { mode: 'global', templateId: '' };
```

- [ ] **Step 2: 新增 DNS 三选 UI**

在「方案选择」（约 line 205-232）之后、「区块 B」之前，仿该 `<select>` 风格新增：

```html
<!-- DNS 配置 -->
<div class="space-y-1.5">
  <label class="block text-xs font-medium text-gray-500 dark:text-gray-400">{{ t('profileModal.dnsLabel') }}</label>
  <select v-model="localProfile.dnsConfig.mode"
    class="block w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 misub-radius-md focus:ring-indigo-500 sm:text-sm dark:text-white">
    <option value="global">{{ t('profileModal.dnsFollowGlobal') }}</option>
    <option value="builtin">{{ t('profileModal.dnsBuiltin') }}</option>
    <option value="template">{{ t('profileModal.dnsUseTemplate') }}</option>
  </select>
  <div v-if="localProfile.dnsConfig.mode === 'global'" class="flex items-center gap-1.5 mt-1.5">
    <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
    <span class="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold uppercase tracking-tight">
      {{ t('profileModal.currentGlobalDns', { value: globalDnsLabel }) }}
    </span>
  </div>
  <select v-if="localProfile.dnsConfig.mode === 'template'" v-model="localProfile.dnsConfig.templateId"
    class="block w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 misub-radius-md focus:ring-indigo-500 sm:text-sm dark:text-white">
    <option v-for="tpl in dataStore.dnsTemplates" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
  </select>
</div>
```

- [ ] **Step 3: 引入 dnsTemplates 与 globalDnsLabel**

`ProfileForm.vue` script 中 `import { useDataStore } from '@/stores/useDataStore.js';`，`const dataStore = useDataStore();`，并新增：
```js
const globalDnsLabel = computed(() => {
  const mode = props.globalSettings?.dnsConfig?.mode || 'builtin';
  if (mode !== 'template' || !props.globalSettings?.dnsConfig?.templateId) return t('profileModal.dnsBuiltin');
  const tpl = dataStore.dnsTemplates.find(t => t.id === props.globalSettings.dnsConfig.templateId);
  return tpl ? tpl.name : t('profileModal.notSet');
});
```

- [ ] **Step 4: 运行构建确认**
Run: `npm run build`
Expected: 通过

- [ ] **Step 5: 提交**
```bash
git add src/components/modals/ProfileModal/ProfileForm.vue
git commit -m "feat(dns): add per-profile DNS selection (default/global/template)"
```

---

### Task 12: 端到端回归与验证

**Files:**
- Modify: `tests/unit/*`（按需补充）
- 验证全量

- [ ] **Step 1: 全量单测**
Run: `npm run test:run`
Expected: 全部 PASS（含既有回归）

- [ ] **Step 2: 前端构建**
Run: `npm run build`
Expected: 构建通过

- [ ] **Step 3: 手动验证清单（可选，需本地起服务）**
- 后台管理 → 服务集成：DNS 模板库可新建/编辑 5 字段模板并保存。
- 规则与配置方案：「3. DNS 配置」选内置 / 选模板。
- Profile 弹窗：DNS 三选（默认/继承全局/指定模板）。
- 生成 Clash/Sing-Box/Surge/Loon/QX 订阅：对应端 DNS 段被替换；留空仍为默认；Clash/Sing-Box 填非法值回退默认。

- [ ] **Step 4: 提交（如新增测试文件）**
```bash
git add tests/unit
git commit -m "test(dns): end-to-end dns template regression coverage"
```

---

## 后续步骤（非本期）

- Egern 生成器接入同一 `customDns` 方案（用户未要求，属扩展）。
- DNS 模板库前端备份导出对等（已含 `webdav-backup-handler`；如需 `export_data` 亦纳入可后续补）。
