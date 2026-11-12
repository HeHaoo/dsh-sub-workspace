# 验证脚本（scripts/verify）

在**真实运行中的 DSH + 真实浏览器页面**上验证 `dsh-sub-workspace` 插件的一组脚本。

这套工具最早是从开发期散落在 `/tmp/vfy2` 的 28 个一次性脚本合并、去重、去密钥硬化而来，
之后又按验收需要补了外观取证与行过滤器检查。当前共 **15 个 `.mjs`**，按职责分五类
（4 个共享库 + 6 个顶层脚本 + 5 个 `shots/` 脚本）：

| 层 | 数量 | 成员 |
| --- | --- | --- |
| 共享库（`lib/`） | 4 | `env` `cdp` `api` `dom` —— 被其余所有脚本 `import`，自身不做断言 |
| 断言脚本（顶层） | 5 | `api-check` `routes-check` `sandbox-check` `dom-check` `inject-check` |
| 跑批脚本（顶层） | 1 | `run-all` —— 依次跑上面 5 个并汇总 |
| 断言/取证脚本（`shots/`） | 2 | `verify-row-filter`（行过滤器验收）、`capture`（外观取证 + 截图） |
| 诊断探针（`shots/`） | 3 | `probe-rows` `probe-identity` `probe-page-state` |

> **断言脚本和诊断探针不是一回事。** 断言脚本输出 `PASS`/`FAIL` 并以退出码表达结论
> （`0`/`1`/`2`）；探针只把页面**测量结果打印出来**（JSON），供人判读，正常情况恒为
> `0`，只有前置条件缺失才 `2`，**永远不会**因为"发现坏东西"而 `1`。别把探针塞进 CI 门禁。
>
> `run-all.mjs` **只跑顶层那 5 个断言脚本**，不包含 `shots/` 下任何一个 —— 外观取证要写
> 截图、行过滤器验收要注入两份源码，都更适合手工/按需执行。

原来那 28 个脚本里绝大多数是"同一段 cookie 生成 + 同一段 CDP 连接"的复制粘贴，如今这些样板
只存在于 `lib/env.mjs` 和 `lib/cdp.mjs`，其余脚本一律 `import`。

### `/tmp/vfy2` 的 28 个 → 这一批脚本

| 原脚本 | 去向 |
| --- | --- |
| `mkurl` `cookie.txt` | 内联进 `lib/env.mjs`（`authCookie`），cookie 不再落盘 |
| `cdp` `cdp2` `cdp3` `dom` `diag` `trace` `race` `why` `probe_inside` `fullcheck` | `dom-check.mjs` + `lib/cdp.mjs` + `lib/dom.mjs` |
| `e2e` `addui` | `dom-check.mjs`（`--open-panel` 覆盖面板交互） |
| `clean_verify` `inject_test` `match` | `inject-check.mjs` |
| `check` `check2` `verify` `state` `probe` `probe2` `probe3` `getbundle` | `api-check.mjs` + `lib/api.mjs` |
| `unit` `tooltest` | `routes-check.mjs` |
| `verify_sandbox` `setnow` | `sandbox-check.mjs` |
| （迁移时新增，原来没有） | `run-all.mjs` 汇总；`lib/dom.mjs` 选择器集中；事件 mark 机制；bundle/源码一致性比对 |

### 迁移之后新增的（不来自 `/tmp/vfy2`）

| 文件 | 为什么加 | 详见 |
| --- | --- | --- |
| `shots/capture.mjs` | 面板是半透明的，"实际画成什么样"只能靠解码截图判断 | 本文「外观取证」 |
| `shots/verify-row-filter.mjs` | 修 bug 后需要一个能复现旧 bug、并能证明新过滤器正确的验收脚本 | `shots/README.md` |
| `shots/probe-*.mjs`（3 个） | 上一条的证据来源：行结构 / React fiber 身份 / tab 状态 | `shots/README.md` |

## 快速开始

```bash
# 全部检查（推荐；离线可跑的会先跑）
node scripts/verify/run-all.mjs

# 只跑不需要浏览器的部分
node scripts/verify/run-all.mjs --only api,routes,sandbox

# 单个脚本
node scripts/verify/api-check.mjs
```

### 端口：先确认 DSH 到底在哪个端口

`lib/env.mjs` 的解析顺序是 **`--port` 参数 → `DSH_PORT` → `PORT` → 默认 `52524`**
（实测：四个来源分别解析为对应端口，默认值确实是 `52524`）。

**但 `52524` 只是"没配置时的默认值"，不是"DSH 一定在这个端口"。** DSH 每次启动的端口可能
不同，所以**先看地址栏**：本机这次跑在 `55736`，此时不带参数的 `api-check` 会直接报
`[precondition] DSH is not reachable at http://127.0.0.1:52524` 并以退出码 `2` 结束
（这是设计如此：连不上就算 SKIP，不算失败）。

```bash
# 知道端口就用 --port（最明确）
node scripts/verify/run-all.mjs --port 55736

# 或者导出一次，后续命令都不用再带
export DSH_PORT=55736
node scripts/verify/run-all.mjs
```

耗时（本机实测，DSH 在 55736、Chrome 调试端口开着）：

| 脚本 | 耗时 | 依赖 |
| --- | --- | --- |
| `api-check` | ~0.1–0.4 s | DSH |
| `routes-check` | ~0.1–0.9 s | DSH + `lib/` |
| `sandbox-check` | ~0.2–1.5 s | DSH + `lib/` |
| `dom-check` | ~24 s | DSH + Chrome 调试端口 |
| `inject-check` | ~24 s | DSH + Chrome 调试端口 |
| `verify-row-filter` / `capture` | 各 ~25 s | DSH + Chrome 调试端口 |

（`dom-check` / `inject-check` 的大部分时间花在导航后等 SPA 挂载，默认 `--mount-wait 15000`。）

> **不要并发跑这些脚本。** 它们共享**同一个**调试标签页（CDP 的 `page` target），会互相注入/
> 删除对方的源码和 DOM 节点。实测同一个 `capture.mjs` 三开时，其中一个会以
> `the panel opens with the injected source — {"stage":"no-populated-panel"}` 失败。
> 这是**并发导致的假失败**，不是插件 bug：串行重跑即通过。`run-all.mjs` 本身就是串行的。

## 前提条件

| 条件 | 影响的脚本 | 说明 |
| --- | --- | --- |
| DSH Web 在跑 | 全部 | **端口要先确认**：默认 `52524`，用 `--port` 或 `DSH_PORT`/`PORT` 覆盖 |
| 能读认证 secret | 全部（`routes --skip-live`、`sandbox --skip-live` 除外） | 见下方「认证」 |
| `lib/` 源码可读 | `routes-check`、`sandbox-check`、`inject-check`、`verify-row-filter`、`capture` | 直接 import/读取发布的模块，不是复制品 |
| Chrome 带调试端口 | `dom-check`、`inject-check`、`shots/` 全部 5 个 | 见下方「启动 Chrome」 |

### 认证

**脚本里没有任何硬编码 secret。** 签名密钥按以下顺序解析：

1. 环境变量 `DSH_AUTH_SECRET`；
2. `${DSH_HOME:-~/.dsh}/.credentials.yaml` 里
   `records['client-connection/browser-session'].payload.secret`（用约 30 行缩进扫描解析，
   不引入 YAML 依赖）。

拿到 secret 后用 HMAC-SHA256 现场签一个 `dsh-auth-<hash>=v1.<payload>.<sig>` cookie，和
DSH Web 自己下发的那枚完全同构。**secret 和 cookie 的值从不打印**，日志里只出现 cookie 名。

手动覆盖：

```bash
# 环境变量优先于文件（--port 记得按实际端口写）
DSH_AUTH_SECRET=<secret> node scripts/verify/api-check.mjs --port 55736

# 换一个凭证目录
export DSH_PORT=55736
DSH_HOME=/some/other/.dsh node scripts/verify/api-check.mjs
```

如果拿到 401，最常见的原因是 DSH 重启换了 secret 而 `DSH_AUTH_SECRET` 还是旧值：
脚本会直接提示这一点（`auth hint`）。

### 启动 Chrome（`dom-check`、`inject-check` 和 `shots/` 全部需要）

```bash
# macOS，用一个独立 user-data-dir，不要碰你日常的 Chrome 配置
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9334 \
  --user-data-dir=/tmp/dsh-verify-chrome \
  --no-first-run
```

然后在那个 Chrome 里打开 `http://127.0.0.1:<DSH 实际端口>/` 并完成 DSH 的登录，留下至少一个
page target。CDP 端口解析顺序是 `--cdp-port` → `DSH_CDP_PORT` → `CDP_PORT` → 默认 `9334`。

两个端口是**独立**的：`--port` 管 DSH Web，`--cdp-port` 管 Chrome 调试端口，互不影响。
只想跑一次验证、不想留窗口时，可以加 `--headless=new`（脚本本身不关心有头无头）：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9334 --user-data-dir=/tmp/dsh-verify-chrome \
  --no-first-run --headless=new "http://127.0.0.1:55736/"
```

调试端口没开时脚本**不会假装通过**：`dom-check`、`inject-check` 以退出码 `2`（SKIP）结束，
并打印一句可执行的前置条件说明；`shots/` 下的脚本同样以 `2` 退出。

## 脚本清单

### `run-all.mjs` — 总跑批

依次跑下面 5 个检查（各自独立子进程，互不拖垮），汇总成一行结论。退出码：
`0` 全过、`1` 有失败、`2` 有前置条件缺失（没失败，但也没证明成功）。

各脚本的断言条数（本机实测，DSH 在 55736、Chrome 调试端口开着）：

| 脚本 | 断言数 | 其中 skip |
| --- | --- | --- |
| `api-check` | 12 | 0 |
| `routes-check` | 24 | 0（`--skip-live` 时 21 + 1 skip） |
| `sandbox-check` | 14 | 0（`--skip-live` 时 13 + 1 skip） |
| `dom-check` | 9 | 0（`--samples 1` 时 7 passed + 1 skip，竞态采样被跳过） |
| `inject-check` | 13 | 0 |
| （不在 run-all 内）`verify-row-filter` | 11 | 0 |
| （不在 run-all 内）`capture` | 25 | 0 |

```bash
node scripts/verify/run-all.mjs [--port N] [--cdp-port N] [--only a,b] [--skip c] [--verbose]
```

### `api-check.mjs` — 宿主路由（只读）

最便宜、永远安全的验证：证明运行中的 DSH 暴露了插件的认证 API 且形状正确。

- `GET /api/sub-workspace/list` → 200 + 合法 JSON + `workspaces[]` + `storePath` + `registry`；
- `workspaces` 带 `id`/`title`（说明 registry 映射真的通了，不是空列表）；
- 去掉 cookie 必须 401；
- 未知 `/api/*` 不能被插件路由吞掉；
- `GET /api/sub-workspace/check?path=…` 对不存在的目录明确判 `writable:false`；
- 宿主确实在提供本插件的浏览器 bundle 并从里面找到 `data-subworkspace-trigger`。

**不写任何东西。** 合并自 `check.mjs`、`check2.mjs`、`verify.mjs`、`state.mjs`、`probe*.mjs`、
`getbundle.mjs`、`fullcheck.mjs` 的宿主部分。

```bash
node scripts/verify/api-check.mjs [--port N] [--json]
```

### `routes-check.mjs` — 路由契约（进程内 + 只读 live 探测）

**唯一**真正驱动 `mutate` 的检查，但用的是 OS 临时目录里的一次性 store，绝不碰
`~/.dsh/sub-workspace/affiliates.json`。

- 直接 import 发布的 `lib/routes.js` / `lib/store.js` / `lib/paths.js`（不复制逻辑）；
- 三个路由都注册上；
- `list` 在空 store 上仍发布 registry 里没有附属路径的工作区；
- `mutate add` 落库到 physical path、重复 add 不产生重复项；
- `mutate` 拒绝不存在的路径、拒绝相对 workspace key、拒绝 symlink（防止授权被重定向）；
- `mutate set` 去重、`set []` 清空；`list` 立刻反映；
- `check` 的路由判定逻辑（模式分支 + 根匹配）；
- live 侧：未认证 401、认证后 200，以及一个**故意非法**的 mutate（空 body）必须 400 且无状态变化。

合并自 `unit.mjs`、`tooltest.mjs` 和早期 `probe.mjs` 的探索。

```bash
node scripts/verify/routes-check.mjs [--skip-live]
```

### `sandbox-check.mjs` — 沙箱策略装饰（进程内 + 只读 live 上下文）

插件承诺的核心：被装饰的 `sandboxPolicy.resolve()` 会带上该工作区的附属路径，于是官方
`write`/`edit`/`bash` 真的放行。这是 `decorate.js + store.js + 官方 policy 对象` 的纯函数，
所以用**发布的模块**驱动一个假 policy service 来断言：

- `workspace-write` 拿到附属路径；官方字段（`mode`、`workspaceRoot`）原样保留；
- 不属于该工作区的 session、没有 session 的 resolve，都拿不到任何附属路径；
- 官方已有的根排在前、重复项折叠；
- `read-only` 和 `danger-full-access` 不被改动；
- policy 形状异常 / store 抛错时**退化成官方 policy**，而不是让每次写入都崩；
- `undo()` 精确还原原来的 `resolve`；二次装饰被拒绝（热重载不会叠加）；
- 装饰的是**同一个实例**，没有替换官方 service。

live 侧只读地读 `session/list`，报告有多少个运行中的会话坐落在一个"已经有附属路径"的工作区
里（也就是"下一次工具调用就会生效"的那批）。

合并自 `verify_sandbox.mjs`、`setnow.mjs` 及 `tooltest.mjs` 背后的策略假设。

```bash
node scripts/verify/sandbox-check.mjs [--skip-live]
```

> **仍需人工确认的一步**：真正"某个写工具在附属路径里成功写了一个文件"需要一次带副作用的
> 工具调用，脚本故意不做（它会在你的工作区里留下文件、且需要模型侧工具通道）。上面的
> 进程内断言证明了策略层；端到端那一步留给手工验证，或在 DSH 会话里让模型执行一次
> `write` 到已配置的附属路径。

### `dom-check.mjs` — 真实页面 DOM

连上调试 Chrome，现场签 cookie、加载 DSH Web UI，报告侧边栏**实际**长什么样：

- 工作区行数（`dsh-better-workspace` 的 `.bw-row[role="treeitem"]`；官方侧边栏的
  `[data-row-key^="workspace:"]` 单独报）；
- 「附属」trigger 数量与覆盖率（哪些行有、哪些没有）；
- 插件注入的 `style[data-plugin]` 是否在；
- 页面是否真的调用了 `/api/sub-workspace/list`；
- 页面异常 / console error——**只统计本次加载产生的**（调试用的 tab 是长寿命的，缓冲区里
  可能还留着上一页的异常，不加区分就会把别人的崩溃算到这次头上）；
- `--samples N` 按时间重采样计数，回答"trigger 先出现又被 React 刷掉"这个竞态问题；
- `--open-panel` 时真的点一下 trigger，断言 `.sws-panel` 打开并列出根路径。

合并自 `cdp.mjs`、`cdp2.mjs`、`cdp3.mjs`、`dom.mjs`、`diag.mjs`、`trace.mjs`、`race.mjs`、
`why.mjs`、`probe_inside.mjs`、`e2e.mjs` 的读半部分、`fullcheck.mjs` 的 DOM 部分。

```bash
node scripts/verify/dom-check.mjs [--cdp-port N] [--samples 6] [--interval 1500] [--open-panel]
```

### `inject-check.mjs` — 干净环境跑本地 client.js

回答"我刚改的 `lib/client.js` 到底能不能用"，不需要重装插件或重启 DSH：

1. 连上调试 Chrome、签 cookie、加载 DSH；
2. 记下已安装插件注入的 trigger 数，然后**只删掉本插件自己的节点**（留一个干净起点，宿主
   的 React 树不动）；
3. 通过 `__ModuleLoader__` shim 在页面里执行**本地源码**，用桩 cordis context 跑 `apply()`；
4. 断言 trigger 重新出现、样式表已注入、插件自己的 list 路由被调用；
5. 跑 effect 的 teardown，断言它把 trigger 和样式表全部清掉（卸载后不留痕）；
6. 把宿主实际下发的 bundle 和本地源码比对——安装陈旧时明确提示"重启 DSH 才会生效"，
   而不是让"新代码能跑"的假象蒙混过去；
7. 结束时 reload 一次页面，把共享 tab 恢复成"已安装插件正常运行"的状态。

合并自 `clean_verify.mjs`、`inject_test.mjs`、`match.mjs`。

```bash
node scripts/verify/inject-check.mjs [--cdp-port N] [--no-reload]
```

## 共享库

| 文件 | 内容 |
| --- | --- |
| `lib/env.mjs` | 端口/secret 解析、cookie 签名、HTTP 请求、`reporter`、统一退出码、`PreconditionError` |
| `lib/cdp.mjs` | CDP WebSocket 客户端：`Runtime.evaluate`、console/异常/网络采集、cookie 注入、导航、事件 mark |
| `lib/api.mjs` | 三个路由的客户端封装 + 从 app shell 里发现本插件 bundle 的真实 URL + `/check` 查询 |
| `lib/dom.mjs` | 选择器常量 + DOM 快照 / trigger 覆盖率 / panel 根路径等只读探针 |

`shots/` 下的脚本各自成篇，不共享 `lib/dom.mjs` 的探针（它们需要更细的行结构/fiber 信息）：
`capture.mjs` 做外观取证，`verify-row-filter.mjs` 做行过滤器验收，三个 `probe-*.mjs` 只做诊断。
详见 [`shots/README.md`](shots/README.md)。

## `shots/` — 需要注入两份源码的检查

`shots/` 下的 5 个脚本都要求 DSH + Chrome 调试端口，但用途分两类（**细节见
[`shots/README.md`](shots/README.md)**）：

| 类型 | 脚本 | 用途 |
| --- | --- | --- |
| 断言 | `verify-row-filter.mjs` | 行过滤器验收：只有工作区行带「附属」，会话行 0 个 |
| 断言 + 写文件 | `capture.mjs` | 面板外观取证 + 输出两张截图 |
| 诊断探针 | `probe-rows` / `probe-identity` / `probe-page-state` | 行结构 / fiber 身份 / tab 健康，只打印证据 |

它们不并入 `run-all.mjs`：`verify-row-filter` 要同时注入"旧源码"和"新源码"做对照，
`capture` 要写截图，都属于按需执行的重检查。

### 外观取证（`capture.mjs`）

面板是**半透明**的，它到底长什么样只存在于屏幕上，不在 CSS 声明里。所以这里不靠读源码判断
外观，而是注入源码、真打开面板、解码截图 PNG 的实际绘制像素，再算 WCAG 对比度。

```bash
node scripts/verify/shots/capture.mjs          # 全套断言 + 写两张截图
```

产出：

| 文件 | 内容 |
| --- | --- |
| `shots/panel-dark.png` | 暗色主题下的面板 |
| `shots/panel-light.png` | 亮色主题下的面板 |

两张图的尺寸**不是固定值**，取决于当次面板的实际大小：`capture.mjs` 以面板
`getBoundingClientRect()` 外扩 28px、再按 `DPR=2` 截取，所以面板内容变多/变少，图片跟着变。
本机最近一次运行是 992×442 @DPR2（历史上曾为 992×478）；不要把这个数字写进任何断言。

`capture.mjs` 共 **25 条断言** = 3 条前置（源码注入成功 / 面板打开 / 无页面异常）
+ **每个主题 11 条**：截图已保存、背景**不是白色**、表面**半透明**（与宿主菜单一致的 alpha）、
文字与**实际绘制像素**的对比度 ≥ 4.5:1、圆角 16px、`backdrop-filter` 是 blur、
有 elevation 阴影、附属行对比度、主按钮对比度、「附属」trigger 透明填充、trigger 8px 圆角。
（本机实测：暗色 11 + 亮色 11 + 3 = 25 passed, 0 failed。）

> **注意归属**：「`var()` 里不许出现幻影令牌 / fallback 里不许有颜色字面量」这条**不是**
> `capture.mjs` 的断言，它在单元测试 `test/client.test.mjs`（用例
> `the panel stylesheet uses only tokens that exist in DSH`）里，不需要浏览器。`capture.mjs`
> 只判断**渲染结果**；令牌来源的正确性由那个单测把关，两者互补、都不重复。

**亮色主题是模拟的**：通过切换宿主自己的 `body[data-ds-dark-theme]` 属性 + `color-scheme`
实现（这与宿主主题开关走的是同一条路径），但没有真去点设置里的主题开关——那会改用户配置。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 全部断言通过 |
| 1 | 至少一条断言失败（真的有问题） |
| 2 | 前置条件缺失（DSH 没跑、Chrome 调试端口没开、凭证读不到）——**不是**"通过" |

`run-all.mjs` 把三者汇总：有失败即 1，否则有 skip 即 2，全过才是 0。

**探针（`shots/probe-*.mjs`）不适用这张表**：它们只打印测量结果，正常恒为 `0`，
仅当前置条件缺失时为 `2`，永远不会输出 `1`。

## 安全约定

- 脚本里**不出现任何 secret 字面量**；secret 只从环境变量或 `~/.dsh/.credentials.yaml` 读。
- secret、cookie 值、HMAC 签名一律不打印，日志里只有 cookie 名和长度。
- `~/.dsh` **只读不写**。`routes-check` / `sandbox-check` 的写操作全部发生在 OS 临时目录
  （`mkdtempSync` 出的 fixture），跑完 `rmSync` 即删；`sandbox-check` 会**只读**地打开 live
  `AffiliateStore` 取附属路径清单（构造函数只 `load()`，实测运行前后 store 文件 mtime 不变）。
- **只有 `routes-check.mjs` 会驱动 `mutate`**，且只针对那个一次性 fixture store；唯一碰 live
  的一次是"空 body 必须 400"的负向用例（不合法输入，无状态变化）。
  `shots/` 下**全部 5 个脚本对宿主只读**（只用 list 路由，从不 mutate）——`verify-row-filter`
  与 `capture` 的"写"只发生在浏览器 DOM 里（注入/清理），不改宿主状态。
- 唯一会**写文件**的脚本是 `shots/capture.mjs`：它覆盖写入 `shots/panel-*.png`。
  跑它之前先知道这一点。
- 自查（在仓库根跑，应当无输出）：

```bash
# 1) 任何形如 secret = "<20+ 字符>" 的赋值
grep -rnE '(secret|SECRET|token|TOKEN)[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_+/-]{16,}' scripts/verify/ || echo 'no hardcoded secret literal'

# 2) 当前这次迁移里被去掉的那个具体密钥（base64url、43 字符）绝不残留
MIGRATED_SECRET="$(node -e "const c=require('node:fs').readFileSync(process.env.HOME+'/.dsh/.credentials.yaml','utf8');const m=/browser-session:[\s\S]*?secret:\s*(\S+)/.exec(c);if(m)process.stdout.write(m[1])")"
grep -rn -- "$MIGRATED_SECRET" scripts/verify/ && echo 'LEAK: migrated secret still present' || echo 'no leak: migrated secret absent'
```
