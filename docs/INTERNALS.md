# 实现细节

这份文档面向**改这个插件的人**。只想用的话看 [README](../README.md) 就够了。

---

## 1. 为什么包裹 `resolve()` 一个点就够了

`sandboxPolicy.resolve()` 是沙箱策略的**唯一出口**。在 DSH 0.2.2-rc.1 的 `app.asar` 里逐包扫
「接收者是 `sandboxPolicy` 的 `.resolve()` 调用点」，共命中 **17 个包**：

```
fs-sandbox · tool-fs · tool-bash · tool-pwsh · bash-sandbox · pwsh-sandbox
terminal-bash · ptc-runtime-node · tool-executor-ptc · tool-str-replace-editor
worktree · liveshare · experimental-forge-session · experimental-client-ui-forge
workflow-ptc · plugin-manager · action-cards
```

另有 `sandbox-policy` 自己在每轮 prompt 的 `sandbox:policy` 段里调 `this.resolve()`，同在范围内。

包裹之后：

- 官方 `write` / `edit` / `bash` 自动认新路径（都读这个服务）
- prompt 里的 `sandbox:policy` 段跟着变——官方就是 `renderPolicyContext(this.resolve({session}))`
- 会话级 mode 切换（`sandbox/mode` 事件）、`defaultMode`、`workspaceRoot` 全部保留，插件只追加
  `additionalWritableRoots`

这也是为什么**官方工具认附属路径**——图 `docs/diagrams` 里那张 2026-11-06 的方案图当时判定
「不改官方实现」和「官方工具立即生效」不可兼得，那个判断对**替换服务**成立，对**包裹方法**不成立。

### 为什么不用替代服务

`SandboxPolicyService` 继承 cordis `Service`，**构造时即自我注册**（`ctx.reflect.provide(...)`）。
再 `new` 一个会与官方行冲突；`reflect.set()` 又拒绝跨 fiber 调用。替代方案必须 `disabled: true`
掉官方 `sandbox-policy` 行，那就是改部署。

所以在**已注册实例上原地包裹**，是唯一既不改部署、又能覆盖全部消费方的做法。

### 三条需求的对应

| 需求 | 实现 |
| --- | --- |
| 不改官方实现 | 官方五个沙箱行（`sandbox` / `sandbox-policy` / `bash-sandbox` / `pwsh-sandbox` / `fs-sandbox`）全部保留原样，只包裹已注册实例的**一个方法**，卸载时精确还原 |
| 增删附属路径 | `sub_workspace` 的五个动作（面板走同一套 HTTP 桥），状态存 `$DSH_HOME/sub-workspace/affiliates.json` |
| 立即生效 | 官方每个工具**每次调用**都调 `resolve()`（无缓存），下一次调用立刻看到新路径 |

---

## 2. 工作区标识：用 cwd，不用 workspaceId

附属路径按 `session.header.cwd`（不可变目录路径）索引。

原因：工作区可以重命名、甚至被删除后重新注册，但目录不变。用 cwd 做键，改名不会丢附属路径。
这也让「历史会话」天然生效——它的 cwd 一直没变过。

---

## 3. cordis Proxy 陷阱（「追加路径不立即生效」的根因）

**症状**：面板里加了一条附属路径，`/api/sub-workspace/list` 能看到，但 `write` 工具仍被拒，
prompt 里的 `sandbox:policy` 段也从不出现 `Additional writable directories`。

**根因**：cordis 的 `ctx.get()` 返回 **Proxy**，而 Proxy 的 `get` **不幂等**——每次取方法都返回
新的 `createShadowMethod` 包装，所以 `proxy.resolve === 任何值` **永远为 false**。

旧代码在同一个 Proxy 上既写入装饰、又用恒假的身份比较判断是否要还原：

```js
service.resolve = decorated          // 写：能到原始实例 ✅
if (service.resolve === decorated)   // 读：永远 false ❌
  { restore() }                      // 所以 undo 永远不执行
```

连锁后果：首次装饰生效 → 热重载时 undo 静默空转 → 装饰器和标记残留 → 重新装饰被
`already decorated` 拒绝 → 实例**永久停在第一次激活时那个写死的 store 闭包**上。

于是 store 文件里明明有新路径（`/list` 走的是另一个 store 实例），但装饰器永远读旧的。

**修复**：用 `Symbol.for('cordis.original')` 解包到原始实例再读写，让身份比较重新有意义。
undo 按原样 `delete`（而不是把继承来的函数重新赋成 own property），实现精确还原。

**判据**（可直接复核，`~/.dsh/profiles/desktop/node_modules/@deepseek-ai/cordis/lib/index.js`，4.0.5）：

- 第 123-158 行是 `createTraceable`
- 第 127 行对 `symbols.original` 直接返回 `target`（原始实例）
- 第 140-143 行对任何函数值返回 `createShadowMethod(...)` 包装
- `symbols.original` 在第 38 行定义为 `Symbol.for("cordis.original")`

所以「每次取 `resolve` 都拿到新的函数对象」是设计使然，不是偶发。

配套的还有 store 的**限流 mtime 刷新**（默认 1000ms）：装饰侧和 HTTP 路由侧各持一个
`AffiliateStore`，靠文件 mtime 检测外部改动。这样即使有多个 store 实例、或用户直接手改
`affiliates.json`，热路径也能跟上（最多滞后 1 秒）。限流是为了让 `resolve()` 稳态下不产生额外 syscall。

---

## 4. 行类型判据：为什么不能靠 label 文本

**症状**：新建会话的默认标题撞上某个目录名时，**会话行也被挂上「附属」按钮**（实测 76 个会话行里 17 个中招）。

**根因**：侧栏把工作区行、**文件夹行**、会话行、会话分组行混在同一棵树里，每行都是
`div.bw-row[role="treeitem"]`，而且**工作区行和文件夹行的 class 完全一样**（都只有 `bw-row`）。
旧实现拿行的 label 文本去撞工作区标题/目录名，于是撞上就误判。

**修复**：两条结构性判据，**必须至少满足一条**：

1. React fiber 往上 8 跳内有 `type.name === 'WorkspaceRow'`，读它的 `memoizedProps.workspace`
   （只有这个组件带 `workspace` prop，读到就是结论性的）；
2. 形状四件套：`.bw-chevron` + `.bw-row-icon` + `.bw-row-label` + `.bw-row-actions` 全在。
   `.bw-row-actions` 是区分工作区行和文件夹行的关键——`FolderRow` 渲染到 count 就停了，没有 actions 槽。
   同时先按 class 排除 `.bw-session-row` / `.bw-sgroup-row` / `.bw-overflow-row`。

**两者都没有就不装饰**——不装饰是安全答案，装饰错工作区等于给了用户错误的写权限。

### 目录来源（按可信度从高到低）

1. `data-row-key="workspace:<id>"` —— **官方侧栏**的属性。`dsh-better-workspace` 自绘的行
   **没有**它：真实页面上 115 个 `.bw-row` 里带 `data-row-key` 的是 **0 个**
   （`probe-rows.mjs` 的 `officialRows: 0`）。保留它是作为官方侧栏的**回退路径**，不是主路径。
2. fiber props 里的 `path` / `workspaceId`，拿去和 `/api/sub-workspace/list` 公布的目录表对。
3. 只有行类型已被证明之后，才允许用 label 文本兜底，且该 label 必须**唯一**对应一个工作区。
   两个工作区同名（`/a/kafka` 和 `/b/kafka`）时宁可一个都不装饰。

---

## 5. 「附属」按钮是怎么挂上去的

侧栏由 `dsh-better-workspace` 自绘，没给插件留插槽——只能从外部观察 DOM。

**不走右键菜单。** 早期版本试过「监听 `contextmenu`、把条目追加进宿主 `[role="menu"]`」，
后来废弃，原因见 `client.js` 第 513-521 行：

> The host's right-click menu is a React portal that rebuilds its children, so an injected
> menu item can be dropped mid-interaction. A node we append to the row (and re-append on
> rebuild) has no such problem, and it also works when the menu markup differs.

现在是在每个工作区行末尾 append 一个属于本插件的 `<button>`：

```js
const button = document.createElement('button')
button.setAttribute('data-subworkspace-trigger', '1')
button.textContent = '附属'
button.className = TRIGGER_CLASS        // 'sws-trigger'，样式全在注入的样式表里
button.addEventListener('click', ...)   // 用按钮的 rect 定位面板
row.appendChild(button)                 // ← 行尾追加，不是菜单项
```

按钮上的 `contextmenu` 监听只做 `preventDefault()` + `stopPropagation()`，免得点右键时弹出宿主行菜单。
**这是 `client.js` 里唯一一处 `contextmenu`**，文件里也没有任何 `[role="menu"]` 相关代码
（`grep 'role="menu"' lib/client.js` 结果 0）。

### React 重建后补回来

行是 React 画的，列表一变就整棵重建，append 的节点会被丢掉。所以：
`new MutationObserver(schedule)` 观察 `document` 的 `childList + subtree`（不是 `body`：
激活时侧栏可能还没挂载，React 还可能换掉 body 的子树），回调里 `requestAnimationFrame` 排一次
`decorateRows()`；`decorateRows` 本身幂等（行上已有 trigger 就跳过）。

另有**有界轮询**兜底：观察器在初始挂载那次并不可靠（侧栏还空时触发过一次就再没动静），
所以从 `tick()` 开始每 250ms 试一次，最多 40 次，一旦出现第一个 trigger 就停。

---

## 6. 样式护栏：三条规则，都来自真实 bug

面板和按钮的样式**全部**来自宿主真实设计令牌，没有硬编码颜色。三条规则写在
`test/client.test.mjs` 里，防的就是下面这些坑：

1. **样式表里不许出现 DSH 中不存在的令牌。** 旧面板写了 `var(--dsw-alias-bg-elevated, #fff)`，
   而该令牌在 DSH 里根本不存在，于是永远回退成白色；文字用的是真实令牌（深色主题下近白），
   结果**白底白字**。
2. **任何 `var(--token, fallback)` 的 fallback 不许是颜色字面量。** 同上：fallback 一旦生效就等于
   写死了颜色，另一个主题下必然错。
3. **「附属」按钮的样式必须来自 `.sws-trigger` 这条 CSS 类，不许有 inline 颜色/边框/透明度。**
   内联值不知道主题存在，换主题时不会跟着变。

面板表面照抄宿主菜单材质（`_material_1w4el_21` / `_media_bgejw_80`）：半透明填充 +
`backdrop-filter` + prominent 阴影 + 16px 圆角 + 发丝边框。

---

## 7. 安全边界

**附属路径是物理目录、且不接受软链。** 校验规则与官方 `additionalRoot()` 一致：

- 必须**已存在**
- 必须是**目录**
- `realpath` 解出的路径必须**等于**你写的路径

`~/...` 先展开，再走完全相同的检查链，所以 `~/link` 和 `/Users/you/link` 会被同一条规则拒绝，
并提示真实的物理路径。`~` 只有出现在**开头**才展开；`/a/~/b` 里的 `~` 是普通字符。
`~user` 明确报错而不是猜——那需要查系统用户库。

**相对路径**相对**当前配置的工作区目录**解析，不相对进程 cwd。`validateRoot(path, base)` /
`removalCandidates(path, base)` 的 `base` 就是该工作区目录：工具侧取
`exec.agent.session.header.cwd`，HTTP 侧取请求的绝对 `workspace` 键，`check` 取 `?workspace=` /
`?session=`。无 `base` 的相对路径仍被拒绝（`must be absolute`），这样旧调用方不会因宿主恰好从某个
目录启动而意外授予权限；`scripts/verify/routes-check.mjs` 的回归护栏就是这条。相对路径解析成
绝对路径后走**完全相同**的检查链，所以软链、缺失、文件三类禁令对相对写法一视同仁。

---

## 8. 测试

```bash
node --test test/*.test.mjs   # 83 项
```

| 文件 | 项数 | 覆盖内容 |
| --- | --- | --- |
| `test/sub-workspace.test.mjs` | 24 | 路径校验（含 `~` 展开边界）、存储、装饰语义 |
| `test/routes.test.mjs` | 24 | HTTP 桥行为与拒绝路径、`~` 写法端到端 |
| `test/client.test.mjs` | 18 | 行类型判据、行内按钮注入与重建恢复、面板、样式令牌护栏 |
| `test/live-decoration.test.mjs` | 7 | **真实 cordis** + 独立 fiber consumer：装饰可见性、立即生效、undo 精确还原、降级、Proxy 标记、mtime 刷新、`/check` 按工作区解析 |
| `test/boot-safety.test.mjs` | 6 | 启动安全：坏数据/缺服务的降级 |
| `test/apply.test.mjs` | 4 | 激活装配、端到端、卸载还原 |

`live-decoration.test.mjs` 是第 3 节那个 bug 的回归护栏：真实 cordis + 独立 fiber 的 consumer，
断言装饰对别的 fiber 可见、`store.add()` 后**下一次** resolve 立刻生效、undo 精确还原、
拿不到 `cordis.original` 时仍降级工作、装饰 Proxy 时标记落在原始实例上、手改 `affiliates.json`
能被热路径跟上、`/check` 解的是该工作区的策略而不是无 session 的部署级策略。

### 端到端验证

单元测试是进程内的；`scripts/verify/` 在**真实运行中的 DSH + 真实浏览器**上验证，包括
「侧栏工作区行上真的出现了按钮」这种只能在真实 DOM 里确认的事：

```bash
node scripts/verify/run-all.mjs                              # 5 个检查
node scripts/verify/run-all.mjs --only api,routes,sandbox    # 不需要浏览器，约 0.4 秒
```

`cdp` / `inject` 需要 Chrome 带 `--remote-debugging-port=9334`，各约 24 秒。详见
[`scripts/verify/README.md`](../scripts/verify/README.md)。

---

## 9. 文件结构

```
lib/
  index.js      宿主激活：装饰 + 注册工具 + 挂路由
  decorate.js   核心：包裹 resolve()，幂等 + 精确还原
  store.js      状态：按 cwd 索引，原子写，mtime 限流刷新
  paths.js      校验：物理目录、拒软链、~/ 展开
  tool.js       sub_workspace 工具（5 个动作）
  routes.js     宿主 HTTP 桥（/api/sub-workspace/*）
  client.js     浏览器侧：行内「附属」按钮 + 管理面板
scripts/
  install.sh    幂等安装（只写文件，不跑 pnpm；支持 --dry-run）
  verify/       真实 DSH + 真实浏览器的验证套件
    run-all.mjs       总跑批：api / routes / sandbox / cdp / inject
    api-check.mjs     宿主 list/check 路由、401 鉴权、bundle 是否下发
    routes-check.mjs  路由契约（进程内 fixture，不碰真实 store）
    sandbox-check.mjs 装饰语义：附属路径真的并入 policy
    dom-check.mjs     真实侧栏 DOM：行数 / trigger 覆盖 / 面板
    inject-check.mjs  干净环境执行本地 client.js 源码
    lib/              env / cdp / api / dom 共享库
    shots/            面板外观取证 + 行类型验收 + 诊断探针
test/           83 项单元测试
```

`scripts/verify/shots/` 里那三个 `probe-*.mjs` 是**诊断探针**，不下断言、不写文件，只把页面现状
打印出来；不是检查项，`run-all.mjs` 也不会调用。
