# tools/ — 验证脚本

对插件和 MCP 桥接做黑盒验证的小工具。全部**零依赖**，用 Node 直接跑；
不含任何本机绝对路径，路径都从命令行参数或环境变量来。

> ⚠️ 其中两个 harness 会**写状态文件**（插件从 `DSH_HOME` 解析，缺省 `~/.dsh`）。
> 跑之前先把 `DSH_HOME` 指到临时目录，否则 fixture 会话会落进你真实的
> `ragflow-session-selection.json`。`mount-host.mjs` / `mount-session.mjs` 会拒绝
> 在 `DSH_HOME` 未设置时启动。

```powershell
$env:DSH_HOME = "$env:TEMP\ragflow-harness"
New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
```

需要 `RAGFLOW_BASE_URL` / `RAGFLOW_API_KEY` 的脚本会读进程环境变量。

---

## MCP 桥接（方案 A）

### `mcp-probe.cjs` — 最小 MCP stdio 客户端

完整走一遍 `initialize` → `tools/call`，打印每个工具的返回。

```powershell
node tools/mcp-probe.cjs ragflow-mcp/server.cjs tools/fixtures/calls-baseline.json
```

第二个参数是调用描述 JSON：

```json
{ "calls": [ { "name": "ragflow_retrieval", "arguments": { "question": "…", "page_size": 3 } } ] }
```

附两个 fixture：`calls-baseline.json`（省略 `dataset_ids`，走默认范围）、
`calls-override.json`（显式传 `dataset_ids`）。

### `probe-ragflow.cjs` — REST 连通性

只打 `GET /api/v1/datasets`，用来确认 Key、地址、权限是否可用。

```powershell
node tools/probe-ragflow.cjs
```

判据：输出 `status=200 code=0 count=N`。`keyLen=0` 说明进程没拿到 Key。

---

## DSH 插件（方案 B）

### `mount-host.mjs` — 挂载宿主半边

用最小假 cordis context 把 `lib/index.js` 挂起来，起真 HTTP server，
打印它注册的路由与各路由的响应。

```powershell
node tools/mount-host.mjs "$PWD/dsh-ragflow-settings/lib/index.js"
```

### `mount-session.mjs` — 四条路由全覆盖

比上面更细，额外覆盖：会话继承、覆盖、空数组=不检索、会话隔离、
`sessionId` 校验（缺失 / 空 / 非法字符 / 超长）、坏 JSON、方法守卫、未知 id 过滤。

```powershell
node tools/mount-session.mjs "$PWD/dsh-ragflow-settings/lib/index.js"
```

### `render-client.mjs` / `render-session.mjs` — 浏览器半边

用最小 hooks runtime + `react-dom` stub 在 Node 里跑 `lib/client.js`，
验证模块格式、slot 注册、以及设置页卡片 / 输入框选择器能渲染不抛错。
**不是 React 一致性测试**，只证明注册与渲染逻辑成立。

```powershell
node tools/render-client.mjs "$PWD/dsh-ragflow-settings/lib/client.js" "$PWD/dsh-ragflow-settings/lib/index.js"
node tools/render-session.mjs "$PWD/dsh-ragflow-settings/lib/client.js" "$PWD/dsh-ragflow-settings/lib/index.js"
```

### `check-manifest.cjs` — 复现 Host 的 `dsh.client` 校验

照着 `dsh-client-modules` 的 `normalizeClientDeclaration` / `clientExportOf`
复算一遍，再用 Node 自己的解析器验证 `/client` 与包根能解析到。

```powershell
node tools/check-manifest.cjs "<profile>/node_modules/@local/dsh-ragflow-settings" "<profile>"
```

判据：`CLIENT_EXPORT … exists=true`、`HOST_INJECT` 含 `webServer` 与 `tools`。

注意 `check-manifest.cjs` 的第二段用 `require.resolve` 走 Node 解析器，需要
包名真的出现在 `profileDir/node_modules` 下（junctions 可以）。

### 组合树怎么查（不随仓库提供脚本）

组合 profile 要 import `dsh-app-boot`，而它只存在于 Electron 的 `app.asar`
虚拟文件系统里，普通 `node` 进程 import 不到（实测 `ERR_MODULE_NOT_FOUND`）。
当时能跑通，是因为在 Harness 进程内部执行。所以这一项改用 DSH 自带 CLI：

```powershell
dsh --profile <临时profile> --dump-config | Select-String 'ragflow|skipping|not found'
```

判据：能看到 `id: ragflow-settings`，且没有 `skipping` / `not found`。
`desktop` profile 会被 Electron 独占管理而拒绝 dump，需另建一个临时 profile
（`node_modules` 用 junction 指向 desktop 的，`package.json` 用编辑器写入）。

---

## 没放进来的一次性脚本

工作区里还有一批当时排查用的脚本（`asar-list*.cjs`、`asar-grep.cjs`、
`write-selection.cjs` 等）：它们把 `app.asar` 路径、甚至某个固定的 dataset id
写死在代码里，换个环境就得改，因此没有进仓库。
读 asar 的手法本身可复用，需要时照 `mount-*.mjs` 的参数化风格重写即可。
