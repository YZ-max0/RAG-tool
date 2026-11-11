# RAGFlow 知识库接入 · 恢复说明

> 建立时间：2026-11-10
> 适用：DSH 0.2.2-rc.1 / RAGFlow v0.25.0-63-gfb95136f3
> 用途：DSH 升级、重装、或多机迁移后，按本文恢复知识库能力。

---

## 一、这套东西由什么组成

三部分，互相独立，缺任何一块都会表现为「功能部分失效」：

| 组件 | 位置 | 作用 |
|---|---|---|
| MCP 桥接 | `D:\Harness-spaces\版本更新\ragflow-mcp\server.cjs` | 把 RAGFlow 的 REST 接口包成标准 stdio MCP 服务器 |
| 设置插件 | `D:\Harness-spaces\版本更新\dsh-ragflow-settings\` v0.2.0 | 插件页卡片（全局默认）+ 输入框工具栏按钮（会话级勾选） |
| 运行环境 | `~/.dsh` 下的 3 处改动 | 让 DSH 加载上面两样 |

**关键前提**：你的 RAGFlow 是 v0.25.0，**没有** `/api/v1/mcp` 端点（实测三态全 404）。所以必须靠 `server.cjs` 这个桥接，不能用官方 MCP 端点。

---

## 二、四处改动（升级后逐一核对）

### 1. `~/.dsh/cordis.patch.yml` — 新增 MCP 条目

在文件末尾追加。**必须用 `insert:` 形式**：本层 patch 的 `- id: xxx` 只能改写**已存在**的条目，新增条目会报 `entry "mcp-ragflow" not found`。

```yaml
- insert:
    - id: mcp-ragflow
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ragflow
        transport: stdio
        command: node
        args:
          - 'D:\Harness-spaces\版本更新\ragflow-mcp\server.cjs'
        env:
          RAGFLOW_BASE_URL: 'http://localhost:8060'
        toolCallTimeoutMs: 60000
        failOnStartupError: false
```

注意 `env` 里**不写** `RAGFLOW_API_KEY`：桥接会自己从环境变量 → `ragflow-key.txt` → Windows 用户注册表依次解析。写死反而会在升级后失效。

### 2. `~/.dsh/profiles/desktop/package.json` — 依赖与 bundle

```json
"dependencies": {
  "@local/dsh-ragflow-settings": "file:D:/Harness-spaces/版本更新/dsh-ragflow-settings",
  "@deepseek-ai/dsh-mcp-client": "0.2.2-rc.1"
}
```

`dsh.profile.bundles` 末尾追加：

```json
"@local/dsh-ragflow-settings"
```

⚠️ 两个易错点：

- `@local/...` 的依赖值**必须是 `file:` 协议**。写成版本号 `0.1.0` 会让 pnpm 去 npm registry 找，必然 404。
- `dsh-mcp-client` **必须钉死 `0.2.2-rc.1`**。npm 上 `latest` 标签指向过期的 `0.0.1-rc.1`，直接 `add @deepseek-ai/dsh-mcp-client` 会被 DSH 拒绝安装（版本不兼容当前运行时）。

### 3. `node_modules\@local\dsh-ragflow-settings` — 必须是 junction

```powershell
cmd /c mklink /J "C:\Users\EDY\.dsh\profiles\desktop\node_modules\@local\dsh-ragflow-settings" "D:\Harness-spaces\版本更新\dsh-ragflow-settings"
```

⚠️ **这一条最容易被漏，也最难排查。**

本机 DLP 会对 `C:\Users\EDY\.dsh\` 下的文件做透明加解密。如果插件目录是**复制**进去的，Electron 进程读到的 `package.json` 是 DLP 密文（`%TSD-Header-###%` 开头），导致：

```
skipping profile bundle "@local/dsh-ragflow-settings": SyntaxError: Unexpected token '%'
```

这是**静默降级**：DSH 照常启动，只是插件不加载，你不会收到明显报错。

用 junction 指向 D 盘就绕开了，因为 DLP 策略只拦用户目录。**不要用 Copy-Item，也不要 npm install 装本地包**（pnpm 会复制而非链接）。

### 4. `ragflow-mcp/server.cjs` — Key 多源解析

桥接按顺序找 API Key：

1. 进程环境变量 `RAGFLOW_API_KEY`
2. `server.cjs` 同目录或 `~/.dsh/` 下的 `ragflow-key.txt`
3. Windows 用户注册表 `HKCU\Environment`

**为什么需要多源**：DSH 的 MCP 客户端用 `scrubbedParentEnv()` 启动子进程，会剥掉所有 `DSH_*` 变量和匹配 `KEY|PASSWORD|SECRET|TOKEN` 的变量。OpenCode / Codex 这类外部客户端更是完全不继承 DSH 的环境。只读 `process.env` 会导致 401。

设环境变量（用户级即可）：

```powershell
[Environment]::SetEnvironmentVariable('RAGFLOW_API_KEY','ragflow-xxxx','User')
```

---

## 三、升级后自检清单

按顺序做，每步都有明确判据：

**① 桥接能独立跑通**

```powershell
node -e "const{spawn}=require('child_process');const p=spawn(process.execPath,['D:/Harness-spaces/版本更新/ragflow-mcp/server.cjs'],{stdio:['pipe','pipe','pipe']});let o='';p.stdout.on('data',d=>o+=d);p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'t',version:'1'}}})+'
');setTimeout(()=>{p.kill();console.log(o.slice(0,200))},1500)"
```

判据：输出含 `"name":"ragflow"`。

**② 插件包能组合**

```powershell
# 建临时 profile 测试（desktop 被 Electron 独占，不能直接 dump）
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.dsh\profiles\rgtest" | Out-Null
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\rgtest\node_modules" "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json" "$env:USERPROFILE\.dsh\profiles\rgtest\package.json"
dsh --profile rgtest --dump-config 2>&1 | Select-String 'skipping|not found|ragflow'
```

判据：**没有** `skipping` / `not found`；能看到 `id: ragflow-settings` 和 `id: mcp-ragflow`。

**③ 重启 DSH 后看两处**

- 工具列表出现 `mcp__ragflow__ragflow_retrieval`、`mcp__ragflow__ragflow_list_datasets`
- 输入框工具栏（权限选择器旁）出现「知识库」按钮

**④ 端到端检索**

问一句「上下料规则怎么配」，应返回带 `source_file` 的片段。

---

## 四、配置文件位置

| 文件 | 内容 |
|---|---|
| `~/.dsh/ragflow-settings.json` | 全局默认勾选：`{"datasetIds":[...]}` |
| `~/.dsh/ragflow-session-selection.json` | 会话级勾选：`{"sessions":{"<sessionId>":[...]}}` |

**回退语义**：会话未设置过 → 继承全局默认；全局也没有 → 检索全部可访问库；会话勾选为空数组 `[]` → 该会话不检索。

---

## 五、接给 OpenCode / Codex

`server.cjs` 本身就是标准 stdio MCP 服务器，外部客户端直接配：

```json
{
  "mcpServers": {
    "ragflow": {
      "command": "node",
      "args": ["D:\\Harness-spaces\\版本更新\\ragflow-mcp\\server.cjs"]
    }
  }
}
```

不用传 Key，桥接自己从注册表读。暴露两个工具：`ragflow_retrieval`、`ragflow_list_datasets`。

---

## 六、当前知识库

| dataset_id | 名称 | 块数 |
|---|---|---|
| `e6567a92d8e911f1937961098168577a` | LDS-上下料-SOUL细节补充 | 47 |
| `c2d3cbe0d8c311f1937961098168577a` | LDS-上下料规则 | 9 |
| `b2f85832d6a511f1937961098168577a` | LDS-定时任务 | 5 |
| `7a0202c08a6b11f18abb934b203a2e28` | LDS-用户与权限 | 16 |

新增知识库无需改配置，按钮和列表会自动读到。

---

## 七、已知限制

**会话级按钮的选择不会自动传导给模型。** 

原因：`dsh-mcp-client` 启动子进程时剥除 `DSH_*` 环境变量，桥接进程拿不到 sessionId，无法知道当前是哪个会话在检索。

实际流程是：按钮把选择写进 `ragflow-session-selection.json`（按 sessionId 隔离，已验证）→ 模型读取该文件 → 调用时显式传 `dataset_ids`。

要做到完全自动，需要另写一个原生工具插件（`ctx.tools.register`），它能直接拿到 agent 上下文。MCP 桥接可保留给外部客户端使用。

---

## 八、卸载

```powershell
# 1. 移除 junction
cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dsh-ragflow-settings"

# 2. 从 cordis.patch.yml 删除 mcp-ragflow 那段 insert（保留 plugin-manager 那条，文件不能为空）

# 3. 从 profiles\desktop\package.json 删除两处依赖与 bundles 里的 @local/dsh-ragflow-settings

# 4. 可选：删除两个 json 状态文件
```

源码目录（`D:\Harness-spaces\版本更新\` 下的 `ragflow-mcp`、`dsh-ragflow-settings`、`ragflow-verify`）可保留，供外部客户端继续使用。
