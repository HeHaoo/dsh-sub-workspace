# dsh-sub-workspace

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**工作区**加「附属路径」：
在会话自己的工作区目录之外，额外允许写几个目录。**按工作区隔离**，改完**下一次工具调用就生效**。

## 为什么需要

DSH 的 `workspace-write` 沙箱只允许写会话的 cwd。官方另有 `additionalWritableRoots`，
但那是**部署级**的——一配就所有工作区共享。

前后端分属两个仓库时（`my-web-app` + `my-api-service`）这个粒度太粗。本插件把它变成**工作区级**。

## 安装

### 方式一：在 Harness Desktop 里装（推荐）

**插件** → **添加插件**，输入框接受三种来源：

| 填什么 | 例子 |
| --- | --- |
| npm 包名 | `dsh-sub-workspace` |
| Git 仓库地址 | `https://github.com/HeHaoo/dsh-sub-workspace.git` |
| 本地目录 | `/opt/src/dsh-sub-workspace`（Windows：`D:\\src\\dsh-sub-workspace`） |

装完**重启 DSH**。

### 方式二：本地克隆 + 脚本

```bash
git clone https://github.com/HeHaoo/dsh-sub-workspace.git
cd dsh-sub-workspace
./scripts/install.sh --dry-run   # 先看它要做什么，不写任何文件
./scripts/install.sh             # 建软链 + 把包名加进 profile 的 bundles
```

然后**重启 DSH**。脚本幂等、只写文件、不跑 pnpm；`--profile web` 可换 profile，
`--help` 看全部参数。

## 使用

**① 点「附属」按钮** —— 侧栏每个工作区行末尾会多出一个小按钮，点开就是管理面板：
列出当前的附属路径（可移除）、输入框添加。

路径可以写绝对路径，也可以写家目录：

| 写法 | 结果 |
| --- | --- |
| 绝对路径 | 直接用（Windows 写 `D:\\src\\other-repo`） |
| `~/src/other-repo`、`~` | 展开成你的 home |
| `~someuser/...` | **不支持**，明确报错（不猜） |

**② 直接跟模型说** —— 「把 ~/dev/my-api-service 加到这个工作区的附属路径」，模型会调
`sub_workspace` 工具：`list` / `add` / `remove` / `set` / `check`。

改完**下一次工具调用即刻生效**，不用重启、不用重开会话。

## 路径规则

- 必须是**已存在**的**目录**
- 不接受软链：`realpath` 解出的路径必须等于你写的路径（防止 grant 被重定向）
- `~` 先展开，再走完全相同的检查链——所以软链禁令对两种写法一视同仁

校验在写入前完成。官方在强制路径时遇到坏条目会抛错、导致**所有**写入失败；本插件不让坏条目进入热路径。

作用域是**工作区**不是会话：同一目录下的所有会话共享同一份附属路径。

## 已知限制

1. 只在 `workspace-write` 下生效（`read-only` 本来啥都不许写，`danger-full-access` 本来无限制）。
2. 依赖 `tools` / `sandboxPolicy` / `workspaceRegistry` 三个服务；缺一个插件会**保持未激活**
   （不是挂载失败，`apply()` 压根不跑）。侧栏一个按钮都没有时先查这个。
3. 跨进程的 store 变更最多滞后约 **1 秒**（装饰侧和 HTTP 侧各持一个 store 实例，靠 mtime 限流刷新）。
   面板和工具在进程内改是**即时**的；只有你手改 `affiliates.json` 时才有这点延迟。
4. 改插件代码：**宿主半必须重启**（`decorate.js` / `index.js` / `store.js` / `routes.js`），
   浏览器半 `client.js` 刷新页面即可（宿主按磁盘内容下发）。

## 测试

```bash
node --test test/*.test.mjs    # 83 项
```

真实 DSH + 真实浏览器上的端到端验证（可选，需要 DSH 和 Chrome）：

```bash
node scripts/verify/run-all.mjs                              # 5 个检查
node scripts/verify/run-all.mjs --only api,routes,sandbox    # 不需要浏览器，约 0.4 秒
```

端口默认 52524，用 `--port` / `DSH_PORT` 覆盖；CDP 默认 9334，用 `--cdp-port` 覆盖。
没有调试端口时脚本以退出码 2（SKIP）结束并说明前置条件，不会假装通过。

## 文件结构

```
lib/
  index.js      宿主激活：装饰 + 注册工具 + 挂路由
  decorate.js   核心：包裹 sandboxPolicy.resolve()
  store.js      状态：按 cwd 索引，原子写
  paths.js      校验：物理目录、拒软链、~/ 展开
  tool.js       sub_workspace 工具
  routes.js     宿主 HTTP 桥（/api/sub-workspace/*）
  client.js     浏览器侧：行内「附属」按钮 + 管理面板
scripts/
  install.sh    幂等安装
  verify/       真实 DSH + 真实浏览器的验证套件
test/           83 项单元测试
```

## 深入

实现细节、踩过的坑、以及**为什么这么设计**都在 **[docs/INTERNALS.md](./docs/INTERNALS.md)**：

- 为什么包裹 `resolve()` 一个点就能覆盖全部 17 个消费方，以及为什么不能替换服务
- 为什么按 cwd 而不是 workspaceId 索引
- cordis Proxy 的 `get` 不幂等——「追加路径不立即生效」那个 bug 的根因
- 行类型判据：为什么不能靠 label 文本认工作区行
- 三条样式护栏：为什么禁止幻影令牌和硬编码颜色

## License

MIT
