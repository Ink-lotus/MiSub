# test 分支问题的上游归属与 Issue 草稿

核对日期：2026-09-08。状态：本地草稿，尚未提交 issue、PR 或代码修复。

## 结论与范围

上一轮审查确认的 **5 项问题全部属于上游既有问题，本地新增回归为 0 项**。
本结论只覆盖下表中的问题，不能推导为整个 `test` 分支不存在其他缺陷。

| 编号 | 审查优先级 | 问题 | 归属 | 后续处理 |
| --- | --- | --- | --- | --- |
| U1 | P1 | KV 密码读取异常时回退为 `admin` | 上游既有 | 上游 issue 草稿 |
| U2 | P1 | GET 请求可触发 KV→D1 迁移，绕过 CSRF 检查 | 上游既有 | 上游 issue 草稿 |
| U3 | P1 | 两条 sing-box 生成路径输出非法 VMess 配置 | 上游既有 | 上游 issue 草稿，必要时拆成两个问题 |
| U4 | P2 | 设置 `ADMIN_PASSWORD` 后，界面改密返回成功但不生效 | 上游既有 | 上游 issue 草稿 |
| U5 | P2 | 修改密码后旧会话继续有效，并可续期 | 上游既有 | 上游 issue 草稿 |

本轮交付为 L1 文档变更，采用定向验证。这些问题以后若进入代码修复，涉及认证、公共 API 或共享转换逻辑，应按 L3 重新设计并执行完整 red-green 验证。

用户要求仅为我们自己引入的问题构建本地修复计划。本次没有命中该条件，因此不新增修复计划，不把下面的建议当作已经批准的实施方案。

## 对比基线与证据

- 本地：`test@00044a5c2c8c11c824a47f540ae2b7914bf9aa7f`。
- 在线上游：[imzyb/MiSub@be2f7218c0c7197bffc6f19779d6765b7decbf0f][upstream-head]。
- 上游提交时间：2026-09-08 12:06:29 UTC，即北京时间 20:06:29。
- 上游提交内容：合并 [PR #474][migration-pr]，即 KV→D1 迁移完整性修复。
- 本地缓存的 `upstream/main` 仍是 `1008b7c9090d3d789d0ecb27bb2dc387d27881bd`，不能用它代表核对时的在线 HEAD。

通过 `tinyfish` 查询 GitHub API 的 `commits/main`，再以返回的固定 SHA 获取 7 个源码文件的 Contents API 数据，解码 Base64 后核对代码。相关 blob 已存在于本地 Git 对象库，使用 API 返回的 blob SHA 读取原文，不移动分支、不更新远程引用。

使用仓库现有 `rollup/parseAst` 解析源码，抽取函数或路由语句，忽略 CRLF/LF 差异后逐段比较。**12 个关键代码块全部相同**：

| 文件 | 在线上游 blob SHA | 相同性证据 |
| --- | --- | --- |
| `functions/modules/utils.js` | `d723dbf49ad54e218c90898db648ce76cb4509d7` | 整文件相同；另核对 `safeKvGet`、`getAdminPassword`、`setAdminPassword`、`getCookieSecret` |
| `functions/modules/auth-middleware.js` | `23e5351ed433b71cf6c42fa2c8a0beba8ad2e4f2` | 整文件相同；另核对 `handleLogin`、`getAuthSessionDiagnostic`、`renewAuthSession` |
| `functions/modules/api-router.js` | `e7e2d869fea5089d80b7708bdccc83a831294225` | `/migrate_to_d1` 整个条件分支相同 |
| `functions/modules/api-handler.js` | `bb98aa4654e1703a73e7e2732d06aaebe7a577bb` | `handleUpdatePassword` 相同 |
| `functions/modules/subscription/template-renderers/render-singbox.js` | `314c5b15ec5a47b1596392a6d7dd3d4b9ca926c6` | `buildOutbound` 相同 |
| `functions/modules/subscription/builtin-singbox-generator.js` | `d4cbee5379342e79afe8eb72bcb8d3aca4d4d29a` | `buildOutbound` 相同 |
| `functions/middleware/cors.js` | `88cb9594202c197c1224e64215fbb97b3c97f705` | 整文件及 `csrfOriginMiddleware` 相同 |

历史归属也已核对：在早于本次本地 sing-box 改动及 PR #474 的上游 `1008b7c` 中，相关问题已经存在。`git blame` 可追溯到 `7e2b530e` 的认证存储回退、`0cf1826a` 的迁移入口、`d0407fe7` 的密码更新，以及 `136e8fd9` / `d716f987` 的 VMess 映射。

特别说明 U2：我们补齐迁移数据种类，改变了被复制的数据范围；**入口缺少 HTTP 方法限制的根因早已存在**。不能因为当前上游 HEAD 合入了我们的迁移 PR，就把这个 CSRF 问题归因于该 PR。

以下链接均固定到核对时的上游提交。若之后提交 issue，需要先检查上游是否已经修复，并重新核对相关 issue，本文不声称已经完成全量查重。

## U1：认证存储失败时降级为默认密码

**建议 issue 标题：** `KV 密码读取失败时回退为 admin，可在存储异常期间获得管理员会话`

### 现象与触发条件

管理员密码只保存在 KV，没有配置 `ADMIN_PASSWORD`。当读取抛出被 `isStorageUnavailableError` 识别的错误，例如 `KV storage is paused`，`safeKvGet` 返回 `null`，随后 `getAdminPassword` 返回默认值 `admin`。

如果 `COOKIE_SECRET` 环境变量仍提供稳定的签名密钥，登录接口可以签发后续鉴权接受的会话。此时只返回“正在使用默认密码”的警告，不能阻止登录。

### 复现步骤

1. 使用内存 KV 保存非默认密码和固定 Cookie 密钥，环境变量只设置 `COOKIE_SECRET`。
2. 正常读取时，以 `admin` 登录，得到 401。
3. 让模拟 KV 的 `get` / `put` 抛出 `KV storage is paused`。
4. 再以 `admin` 登录，得到 200 和 `Set-Cookie`。
5. 将该 Cookie 交给 `authMiddleware`，结果为 `true`。

附录 A 提供无外部副作用的脚本，实际输出：

```json
{"id":"U1","healthyDefaultLogin":401,"pausedDefaultLogin":200,"authenticated":true}
```

**预期：** 无法读取既有认证配置时拒绝登录并报告存储错误，不将读取失败解释成初次部署。

**影响：** 在上述部署条件与存储故障同时满足时，已设置的管理员密码失去保护作用。该复现证明认证绕过，不代表已经在真实 Cloudflare 环境验证所有故障模式下的数据读取或修改能力。

### 上游依据与建议

- [上游 `safeKvGet`：将暂停类错误转换为 `null`][up-safe-kv]。
- [上游 `getAdminPassword`：回退到 `admin`][up-admin-password]。
- [上游登录成功分支：签发 Cookie][up-login]。

建议区分“键确实不存在”和“存储读取失败”，后者应拒绝认证；已有环境变量密码时仍可采用明确配置的密码。不要仅靠登录成功后的警告处理认证存储故障。

## U2：GET 迁移入口绕过 CSRF 防护

**建议 issue 标题：** `/api/migrate_to_d1 接受 GET，可通过跨站导航触发数据迁移`

### 现象与触发条件

`/api/migrate_to_d1` 只检查会话和 D1 绑定，没有要求请求使用 POST。CSRF 中间件只检查 POST、PUT、PATCH、DELETE，GET 会直接放行。

登录 Cookie 使用 `SameSite=Lax`。已登录管理员通过顶层跨站 GET 导航访问该路径时，浏览器可以携带 Cookie，因此不能依赖 SameSite 或 CORS 阻止这类写操作。

### 复现步骤

1. 用内存 KV 完成一次正常登录，取得有效 Cookie。
2. 构造 `GET https://review.invalid/api/migrate_to_d1`，携带该 Cookie 和跨站 `Referer: https://outside.invalid/`。
3. 按生产入口顺序调用 `csrfOriginMiddleware` 和 `handleApiRequest`。
4. 将 `DataMigrator.migrateKVToD1` 替换为仅计数的内存桩，确认请求进入迁移函数。

附录 A 实际输出：

```json
{"id":"U2","status":200,"migrationsInvoked":1}
```

**预期：** GET 返回 405，且迁移函数不被调用；跨站 POST 继续由既有 CSRF 检查拒绝。

**影响：** 有 KV 和 D1 绑定的部署可被非预期地触发迁移。迁移会复制 KV 数据到 D1；若 KV 留有较旧数据，可能覆盖 D1 中的更新数据。真实数据库没有参与本次复现，实际数据范围取决于部署状态。

### 上游依据与建议

- [上游迁移入口：无方法校验][up-migration-route]。
- [上游 CSRF 中间件：GET 直接放行][up-csrf]。
- [上游登录 Cookie 的 `SameSite=Lax`][up-login]。

建议限定迁移接口为 POST，并保留来源验证。对同类维护接口检查方法约束，但不要把尚未逐一复现的其他接口混入本 issue 的确定结论。

## U3：VMess 产物不符合 sing-box 配置格式

**建议 issue 标题：** `VMess 配置生成包含不支持的 udp_relay_mode / congestion_control 或 transport.type=tcp`

### 路径 A：统一模板渲染器

`render-singbox.js` 的 VMess 分支无条件输出：

```json
{"udp_relay_mode":"native","congestion_control":"cubic"}
```

这两个字段不属于 VMess 出站格式。即使输入节点没有设置这两个属性，也会因为默认值而出现在产物中。

在 sing-box 1.12.0 和 1.13.0 中，本地配置校验均失败：

```text
decode config at stdin: outbounds[1].udp_relay_mode: json: unknown field "udp_relay_mode"
```

### 路径 B：内置生成器

`builtin-singbox-generator.js` 将非 WebSocket VMess 的传输写成：

```json
{"transport":{"type":"tcp"}}
```

普通 TCP 不应作为这种 V2Ray transport 类型输出。实际校验失败：

```text
decode config at stdin: outbounds[1].transport: unknown transport type: tcp
```

### 复现步骤与预期

1. 使用一个普通 TCP VMess 节点，地址使用测试值、UUID 使用有效格式即可，无需连接服务器。
2. 分别走统一模板和内置生成器导出 JSON。
3. 对产物执行 `sing-box check -c stdin`，观察上述错误。
4. 为排除上游其他兼容性问题干扰，可仅保留真实生成的 VMess outbound 构造最小配置；附录 B 使用这种方式，此时错误中的下标为 `outbounds[0]`。

**预期：** 两条路径都生成 sing-box 接受的 VMess 出站，普通 TCP 省略 `transport`，WebSocket 等受支持传输保留正确参数。

**影响：** 一个 VMess 节点就可能导致整份订阅加载失败。此前 68 份远程规则集的冒烟测试不覆盖节点协议映射，因此通过该测试不能排除此问题。

### 上游依据与建议

- [上游模板 VMess 字段][up-template-vmess]。
- [上游内置 VMess transport][up-builtin-vmess]。

两个 `buildOutbound` 函数与本地完全相同。本地的拒绝策略、规则集托管和 DNS 改进没有引入这两处字段错误。

建议修正两条协议映射并加入真实 sing-box 校验。单元测试应覆盖 TCP / WS / TLS 的代表输入，避免只检查 JSON 中是否存在某个节点。维护者也可以将路径 A、B 拆成两个 issue。

## U4：环境变量密码使界面改密失效

**建议 issue 标题：** `配置 ADMIN_PASSWORD 时，界面修改密码返回成功，但新密码无法登录`

### 复现步骤

1. 设置 `ADMIN_PASSWORD=review-env-password` 并提供 KV 绑定。
2. 正常登录后，在密码设置接口提交 `review-new-password`。
3. 接口返回 200 和“密码已更新”。
4. 用新密码重新登录，得到 401；用原环境变量密码登录，仍得到 200。

附录 A 实际输出：

```json
{"id":"U4","updateStatus":200,"oldPasswordStatus":200,"newPasswordStatus":401}
```

**预期：** 密码更新成功后，后续登录使用新密码；或者明确告知密码由环境变量管理，拒绝此次界面修改。不能在没有改变有效密码时返回成功。

**影响：** 管理员可能以为旧密码已经失效，实际仍可用于登录。此问题不依赖存储故障，与 U1、U5 是独立问题。

### 上游依据与建议

- [上游读取顺序：`ADMIN_PASSWORD` 优先][up-admin-password]。
- [上游写入：仅更新 KV][up-set-password]。
- [上游更新接口：写入后直接返回成功][up-update-password]。

建议先确定环境变量与持久化设置的所有权规则，再统一读写行为。若环境变量作为运维强制配置，应在接口和界面中明确体现其不可被页面覆盖。

## U5：改密不撤销旧会话

**建议 issue 标题：** `修改管理员密码后，旧 Cookie 仍可鉴权并自动续期`

### 复现步骤

1. 不设置 `ADMIN_PASSWORD`，使用 KV 中的密码登录并保留 Cookie A。
2. 调用密码更新接口，确认新密码已经实际生效，以排除 U4。
3. 使用 Cookie A 调用 `authMiddleware`，仍得到 `true`。
4. 源码还会对达到 7 天续期阈值的有效会话重新签发当前时间戳；密码更新没有改变签名密钥或加入会话撤销条件。

附录 A 实际输出：

```json
{"id":"U5","updateStatus":200,"oldPasswordStatus":401,"newPasswordStatus":200,"oldSessionAccepted":true}
```

**预期：** 改密应撤销旧会话，或提供明确、可靠的“撤销其他会话”机制，让管理员能够收回泄露 Cookie 的访问权限。

**影响：** 知道旧密码和持有旧 Cookie 是不同情况。即使旧密码不能再登录，泄露 Cookie 仍有效，并可在保持活动的情况下继续续期。仅修改密码不能完成凭据失窃后的访问收回。

### 上游依据与建议

- [上游更新接口没有会话失效处理][up-update-password]。
- [上游会话检查只验证签名与时间][up-session-check]。
- [上游自动续期逻辑][up-session-renew]。

建议引入会话版本或改密时间并在鉴权时校验。单纯更换 Cookie 密钥也需考虑 `COOKIE_SECRET` 环境变量、KV、缓存和多实例之间的一致性，本文不预先决定实施方案。

## 原有优化项

上一轮的两项优化建议也能在上游原代码中定位，暂不计入上述 5 个缺陷：

| 优化项 | 上游依据 | 说明 |
| --- | --- | --- |
| 无认证 Cookie 的请求提前跳过密钥读取 | [上游会话检查先读密钥，再检查 Cookie][up-session-secret-order] | 减少匿名静态资源请求的 KV 读取。我们新增规则集资源可能增加请求次数，但这个读取顺序原本就存在。 |
| 增加登录失败限流 | [上游登录处理函数][up-login-handler] | 该函数及当前入口链路未见应用层登录限流。没有检查部署侧 WAF 配置，因此不能断言所有部署均无外部限流。可作为独立 enhancement 讨论。 |

这两项没有新增负载测试或部署侧验证，不能将预期优化收益写成已测量结果。

## 附录 A：安全问题的本地复现脚本

在仓库根目录、已具备项目依赖的 Node 环境中，以 ESM 执行下面的代码。
所有凭据均为固定测试值；KV 为内存 Map；迁移函数为计数桩。不会访问真实数据库、发送网络请求或修改源文件。
断言用于确认本文描述的现有缺陷，未来修复后对应断言应失败，不应将它作为“正确行为”的回归测试直接加入测试套件。

```javascript
import assert from 'node:assert/strict';
import { handleLogin, authMiddleware } from './functions/modules/auth-middleware.js';
import { handleUpdatePassword } from './functions/modules/api-handler.js';
import { handleApiRequest } from './functions/modules/api-router.js';
import { csrfOriginMiddleware } from './functions/middleware/cors.js';
import { DataMigrator } from './functions/storage-adapter.js';

function fixture(overrides = {}) {
    const values = new Map([
        ['SYSTEM_ADMIN_PASSWORD', 'review-old-password'],
        ['SYSTEM_COOKIE_SECRET', 'review-cookie-secret']
    ]);
    let paused = false;
    const check = () => {
        if (paused) throw new Error('KV storage is paused');
    };
    return {
        pause: () => { paused = true; },
        env: {
            COOKIE_SECRET: 'review-cookie-secret',
            MISUB_KV: {
                get: async key => { check(); return values.get(key) ?? null; },
                put: async (key, value) => { check(); values.set(key, value); },
                delete: async key => { check(); values.delete(key); }
            },
            ...overrides
        }
    };
}

const passwordRequest = (path, password) => new Request(`https://review.invalid${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
});
const login = (env, password) => handleLogin(passwordRequest('/api/login', password), env);
const update = (env, password) => handleUpdatePassword(passwordRequest('/api/settings/password', password), env);
const cookieFrom = response => response.headers.get('Set-Cookie').split(';')[0];
const authenticated = (env, cookie) => authMiddleware(new Request('https://review.invalid/api/data', {
    headers: { Cookie: cookie }
}), env);

{
    const test = fixture();
    const healthy = await login(test.env, 'admin');
    test.pause();
    const paused = await login(test.env, 'admin');
    const accepted = await authenticated(test.env, cookieFrom(paused));
    assert.equal(healthy.status, 401);
    assert.equal(paused.status, 200);
    assert.equal(accepted, true);
    console.log(JSON.stringify({ id: 'U1', healthyDefaultLogin: healthy.status,
        pausedDefaultLogin: paused.status, authenticated: accepted }));
}

{
    const { env } = fixture();
    const cookie = cookieFrom(await login(env, 'review-old-password'));
    const original = DataMigrator.migrateKVToD1;
    let migrationsInvoked = 0;
    try {
        DataMigrator.migrateKVToD1 = async () => {
            migrationsInvoked++;
            return { errors: [], keys: {} };
        };
        const request = new Request('https://review.invalid/api/migrate_to_d1', {
            headers: { Cookie: cookie, Referer: 'https://outside.invalid/' }
        });
        const response = await csrfOriginMiddleware(request,
            () => handleApiRequest(request, { ...env, MISUB_DB: {} }));
        assert.equal(response.status, 200);
        assert.equal(migrationsInvoked, 1);
        console.log(JSON.stringify({ id: 'U2', status: response.status, migrationsInvoked }));
    } finally {
        DataMigrator.migrateKVToD1 = original;
    }
}

{
    const { env } = fixture({ ADMIN_PASSWORD: 'review-env-password' });
    const changed = await update(env, 'review-new-password');
    const oldLogin = await login(env, 'review-env-password');
    const newLogin = await login(env, 'review-new-password');
    assert.equal(changed.status, 200);
    assert.equal(oldLogin.status, 200);
    assert.equal(newLogin.status, 401);
    console.log(JSON.stringify({ id: 'U4', updateStatus: changed.status,
        oldPasswordStatus: oldLogin.status, newPasswordStatus: newLogin.status }));
}

{
    const { env } = fixture();
    const oldCookie = cookieFrom(await login(env, 'review-old-password'));
    const changed = await update(env, 'review-new-password');
    const oldLogin = await login(env, 'review-old-password');
    const newLogin = await login(env, 'review-new-password');
    const oldSessionAccepted = await authenticated(env, oldCookie);
    assert.equal(changed.status, 200);
    assert.equal(oldLogin.status, 401);
    assert.equal(newLogin.status, 200);
    assert.equal(oldSessionAccepted, true);
    console.log(JSON.stringify({ id: 'U5', updateStatus: changed.status,
        oldPasswordStatus: oldLogin.status, newPasswordStatus: newLogin.status, oldSessionAccepted }));
}
```

## 附录 B：VMess 的客户端校验

以下 PowerShell 命令在仓库根目录执行。`$reviewSingbox` 指向本机已有的 sing-box 可执行文件；本次验证使用临时目录内保留的 1.12.0 / 1.13.0，不安装软件、不修改 PATH。
命令只执行 `check`，不启动 TUN、不连接节点。仅保留生成的 VMess 出站，以隔离其他配置问题。

路径 A：

```powershell
$reviewSingbox = Join-Path $env:TEMP 'misub-singbox-clients/sing-box-1.12.0-windows-amd64/sing-box.exe'
@'
import { renderSingboxFromTemplateModel } from './functions/modules/subscription/template-renderers/render-singbox.js';
const config = JSON.parse(renderSingboxFromTemplateModel({
    settings: { dnsThroughProxy: false },
    proxies: [{ name: 'Review', type: 'vmess', server: '192.0.2.1', port: 443,
        uuid: '11111111-1111-4111-8111-111111111111' }],
    rules: [{ type: 'final', policy: 'DIRECT' }]
}));
console.log(JSON.stringify({ outbounds: config.outbounds.filter(item => item.type === 'vmess') }));
'@ | node --input-type=module | & $reviewSingbox check -c stdin --disable-color
```

路径 B：沿用同一个 `$reviewSingbox`。

```powershell
@'
import { generateBuiltinSingboxConfig } from './functions/modules/subscription/builtin-singbox-generator.js';
const node = 'vmess://' + Buffer.from(JSON.stringify({
    v: '2', ps: 'Review', add: '192.0.2.1', port: '443',
    id: '11111111-1111-4111-8111-111111111111', aid: '0', scy: 'auto', net: 'tcp', tls: ''
})).toString('base64');
const config = JSON.parse(generateBuiltinSingboxConfig(node, { ruleLevel: 'lite', dnsThroughProxy: false }));
console.log(JSON.stringify({ outbounds: config.outbounds.filter(item => item.type === 'vmess') }));
'@ | node --input-type=module | & $reviewSingbox check -c stdin --disable-color
```

## 验证记录与限制

- 在线获取固定上游提交和 7 个源码文件；12 个关键代码块的 AST 边界比较相同。
- 附录 A 的 4 个独立场景在本地执行，均得到文中记录的缺陷结果。
- 附录 B 的两条路径在 sing-box 1.12.0 / 1.13.0 中执行，均以非零状态退出，报对应的 VMess 字段或 transport 错误。
- 上一轮对 `test@00044a5` 执行 `npm run test:run`：133 个文件、1066 个用例通过；`npm run build` 通过。构建曾受沙箱 `spawn EPERM` 阻挡，在允许的沙箱外本地执行后通过。
- 上一轮两个 sing-box 版本都通过构建产物中 68 份规则集的本地下载及路由冒烟测试；该脚本替换 DNS 与入站配置，不能视为所有节点协议或完整生产配置通过。
- 本轮仅增加文档，不重新运行全量单测和构建；验证重点是在线源码归属、文档内复现脚本、客户端校验与 `git diff --check`。
- 没有启动完整上游部署，没有用真实 Cloudflare KV/D1 复现安全问题。上游归属由固定源码及关键代码块相同性证明，运行结果来自本地代码和隔离测试数据。
- 未使用子代理，未修改应用代码、测试、依赖或环境配置，未提交、推送、创建 issue/PR。提交上游问题仍由用户决定。

[upstream-head]: https://github.com/imzyb/MiSub/commit/be2f7218c0c7197bffc6f19779d6765b7decbf0f
[migration-pr]: https://github.com/imzyb/MiSub/pull/474
[up-safe-kv]: https://github.com/imzyb/MiSub/blob/be2f7218c0c7197bffc6f19779d6765b7decbf0f/functions/modules/utils.js#L68-L79
[up-admin-password]: https://github.com/imzyb/MiSub/blob/be2f7218c0c7197bffc6f19779d6765b7decbf0f/functions/modules/utils.js#L163-L176
[up-set-password]: https://github.com/imzyb/MiSub/blob/be2f7218c0c7197bffc6f19779d6765b7decbf0f/functions/modules/utils.js#L244-L250
[up-login]: https://github.com/imzyb/MiSub/blob/be2f7218c0c7197bffc6f19779d6765b7decbf0f/functions/modules/auth-middleware.js#L333-L349
[up-login-handler]: https://github.com/imzyb/MiSub/blob/be2f7218c0c7197bffc6f19779d6765b7decbf0f/functions/modules/auth-middleware.js#L307
[up-migration-route]: https://github.com/imzyb/MiSub/blob/be2f7218c0c7197bffc6f19779d6765b7decbf0f/functions/modules/api-router.js#L82-L114
[up-csrf]: https://github.com/imzyb/MiSub/blob/be2f7218c0c7197bffc6f19779d6765b7decbf0f/functions/middleware/cors.js#L99-L103
[up-template-vmess]: https://github.com/imzyb/MiSub/blob/be2f7218c0c7197bffc6f19779d6765b7decbf0f/functions/modules/subscription/template-renderers/render-singbox.js#L63-L74
[up-builtin-vmess]: https://github.com/imzyb/MiSub/blob/be2f7218c0c7197bffc6f19779d6765b7decbf0f/functions/modules/subscription/builtin-singbox-generator.js#L77-L84
[up-update-password]: https://github.com/imzyb/MiSub/blob/be2f7218c0c7197bffc6f19779d6765b7decbf0f/functions/modules/api-handler.js#L705-L724
[up-session-check]: https://github.com/imzyb/MiSub/blob/be2f7218c0c7197bffc6f19779d6765b7decbf0f/functions/modules/auth-middleware.js#L173-L201
[up-session-renew]: https://github.com/imzyb/MiSub/blob/be2f7218c0c7197bffc6f19779d6765b7decbf0f/functions/modules/auth-middleware.js#L213-L231
[up-session-secret-order]: https://github.com/imzyb/MiSub/blob/be2f7218c0c7197bffc6f19779d6765b7decbf0f/functions/modules/auth-middleware.js#L129-L147
