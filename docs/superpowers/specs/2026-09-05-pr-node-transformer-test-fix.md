# PR 提案一：修复上游自带的红灯测试 `node-transformer.test.js`

**状态**：待执行，**尚未开分支、尚未提交 PR**

| 项 | 值 |
|---|---|
| 目标 | `imzyb:main` |
| 基线 | `upstream/main` @ `1008b7c`（2026-09-02） |
| 建议分支名 | `fix/node-transformer-virtual-info-node-test` |
| 改动面 | **1 个文件、4 行**（`tests/unit/node-transformer.test.js`） |
| 风险 | 极低——只改测试断言，不动任何实现代码 |

---

## 一、问题：上游 main 的 CI 现在就是红的

在**纯净的** `upstream/main`（不含我们任何改动）上跑测试即已失败：

```
FAIL  tests/unit/node-transformer.test.js
      > removes useless info nodes when useless filter is enabled
AssertionError: expected [ …(4) ] to have a length of 3 but got 4
```

**复现**：

```bash
git fetch upstream
git checkout --detach upstream/main
npm ci
npx vitest run tests/unit/node-transformer.test.js
```

## 二、成因：功能改了，测试没跟

上游自己的提交 `b477c8b`（2026-08-29，「添加放行系统虚拟信息节点」）给
`functions/utils/node-transformer.js` 的 `isUselessNode` 加了一条放行分支：

```js
const isVirtualInfoNode = protocol === 'trojan'
    && server === '127.0.0.1'
    && Number(record?.port) === 443
    && String(record?.url || '').includes(`trojan://${VIRTUAL_INFO_NODE_UUID}@127.0.0.1:443#`)
    && /(?:流量剩余|到期时间|您的订阅已到期)/.test(name);

if (isVirtualInfoNode) return false;
```

意图明确：流量剩余 / 到期时间这类**系统自己生成的**虚拟信息节点，不该被 useless
过滤器剔除——否则用户开了「过滤无用节点」就看不到自己的流量和到期信息了。

但 `tests/unit/node-transformer.test.js:81` 仍断言旧行为（应剩 3 条、流量剩余节点应
被剔除）。功能变更是有意的，测试没跟上。

## 三、改法：更新断言，逐条推演

**这是唯一正确的方向**：`b477c8b` 的实现是有意为之且符合产品意图，该改的是测试。

```diff
-        expect(result).toHaveLength(3);
-        expect(result.some(line => line.includes('%E6%B5%81%E9%87%8F%E5%89%A9%E4%BD%99'))).toBe(false);
+        // 系统虚拟信息节点（trojan + 127.0.0.1:443 + 全零 UUID + 流量/到期字样）自
+        // b477c8b 起被 isUselessNode 主动放行，不再被 useless 过滤器剔除；
+        // 不满足虚拟节点特征的到期信息节点（此处 server 为 info.example.com）仍然剔除。
+        expect(result).toHaveLength(4);
+        expect(result.some(line => line.includes('%E6%B5%81%E9%87%8F%E5%89%A9%E4%BD%99'))).toBe(true);
         expect(result.some(line => line.includes('%E5%A5%97%E9%A4%90%E5%88%B0%E6%9C%9F'))).toBe(false);
```

该用例喂进 5 个节点，逐条判定：

| # | 节点 | 判定依据 | 结果 |
|---|---|---|---|
| 1 | vmess `🇺🇸 US Node 01` | 非 useless | 留 |
| 2 | trojan `🇭🇰 HK Node 01` | 非 useless | 留 |
| 3 | ss `到期提醒` | 「到期提醒」不在 useless 正则里 | 留 |
| 4 | trojan `流量剩余 ≫ 12GB` @ `127.0.0.1:443`，全零 UUID | 满足 `isVirtualInfoNode` 四项 → 主动放行 | **留**（旧断言以为剔除） |
| 5 | trojan `套餐到期：2026-12-31` @ `info.example.com` | server 非 `127.0.0.1`，不满足虚拟节点特征；「套餐到期」命中通用 useless 正则 | 剔除 |

共 4 条存活。第三条断言（`套餐到期` 应被剔除）**保持不变**——它验证的正是「放行只
针对系统虚拟节点，普通信息节点照旧过滤」这个边界，是这次改动里最有价值的一条断言。

**本仓库已实施该修复**，可直接照搬：`Ink-lotus/MiSub` 的 `08a1700`（合并提交内）。
用 `git diff upstream/main main -- tests/unit/node-transformer.test.js` 取 diff。

## 四、操作步骤

```bash
git fetch upstream
git switch -c fix/node-transformer-virtual-info-node-test upstream/main

# 只改这一个文件的那 4 行（不要 cherry-pick 我们的提交——那是个合并提交，会带进 97+ 个改动）
# 手工编辑 tests/unit/node-transformer.test.js:81-83

npx vitest run tests/unit/node-transformer.test.js   # 应转绿
npm run test:run                                      # 确认没打红别的

git add tests/unit/node-transformer.test.js
git commit
git push -u origin fix/node-transformer-virtual-info-node-test
```

**提交信息用英文**，与上游历史一致。建议：

```
fix(test): align useless-filter assertions with virtual info node allowlist

b477c8b added an isVirtualInfoNode allowlist to isUselessNode so that
system-generated traffic/expiry nodes survive the useless filter, but
node-transformer.test.js still asserted the old behaviour. The test has
been failing on main since then.

Update the expected count to 4 and flip the traffic-node assertion. The
"套餐到期" assertion is intentionally left as-is: that node's server is
info.example.com, so it does not match the virtual-node signature and is
still filtered — which is exactly the boundary worth asserting.

No implementation change.
```

## 五、PR 描述要点

1. **问题**：`node-transformer.test.js` 在 `main` 上就是失败的，附上复现命令与报错
2. **成因**：`b477c8b` 的 `isVirtualInfoNode` 放行分支与测试断言不一致；实现是对的，测试过时
3. **改法**：只改断言，附第三节那张五节点推演表
4. **验证**：`npx vitest run tests/unit/node-transformer.test.js` 转绿，`npm run test:run` 全绿
5. **不含实现改动**——强调这一点，审阅成本几乎为零

## 六、注意事项

- **别提「顺便把别的也修了」**。这个 PR 的全部价值在于「一眼可审、立刻能合」。混进任何
  其他改动都会拖长它的生命周期
- 分支基于 `upstream/main`，**不要合回我们的 main**（我们已有该修复，在 `08a1700` 里）
- 我们的 fork 里这处改动带中文注释，与上游既有注释风格一致（上游代码里有中文注释），
  可保留；但**提交信息与 PR 描述用英文**
- 我们 fork 还有另外两个待提 PR（见 `2026-09-04-pr-kv-d1-migration-fix.md` 与
  `2026-09-05-pr-dns-override-surge-loon-quanx.md`）。三个 PR **彼此独立、可任意顺序提**，
  不要合并成一个

---

**文档版本**：1.0
**最后更新**：2026-09-05
**前置状态**：`Ink-lotus/MiSub` 已把上游合并到 `1008b7c`（`38bc1bb`，已推送 origin/main）。
本 PR 的改动已包含在其中，此处只是把它单独摘出来回馈上游。
