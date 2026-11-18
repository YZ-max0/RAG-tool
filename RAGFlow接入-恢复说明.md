# RAGFlow 知识库接入 · 部署与恢复说明

> 源码：本仓库（`ragflow-mcp/`、`dsh-ragflow-settings/`）
> 用途：新机器部署、DSH 升级/重装后恢复知识库能力。
> 文中 `<本仓库>` 指你 clone 下来的目录绝对路径；`<DSH_HOME>` 默认 `~/.dsh`。

---

## 〇、前提条件

| 项 | 要求 | 说明 |
|---|---|---|
| RAGFlow | v0.25.x（已验证 v0.25.0-63-gfb95136f3） | v0.26+ 有官方 `/api/v1/mcp` 端点，可直接用官方，不必用本桥接 |
| Node.js | ≥ 18（MCP 桥接）；≥ 22.19（DSH 插件） | 桥接零依赖，只用 Node 内置模块 |
| DeepSeek Harness | 0.2.2-rc.3（仅方案 B 需要） | 宿主工具用 `ctx.tools.register` / `exec.agent.id`，属 0.2.2 运行时契约 |
| API Key | RAGFlow 的 `RAGFLOW_API_KEY` | 权限需覆盖目标知识库 |

**关键前提**：v0.25 的 RAGFlow **没有** `/api/v1/mcp` 端点（实测无认证 / 假 Key / GET 三态全 404），
所以 v0.25 必须靠 `ragflow-mcp/server.cjs` 这个桥接。

---

## 一、两种接法，先选一种

| 方案 | 适用 | 会话级勾选 | 工具名 |
|---|---|---|---|
| **A. MCP 桥接** | OpenCode / Codex / Claude Desktop 等任意 MCP 客户端 | ❌ 只能全局 | `mcp__ragflow__*`（由客户端加前缀） |
| **B. DSH 宿主插件** | DeepSeek Harness | ✅ 真正按会话隔离 | `ragflow_retrieval` / `ragflow_list_datasets` |

> ⚠️ **两者不能同时启用**：方案 B 的宿主工具与 MCP 工具同名，
> 同时挂会冲突。切到 B 时请把 `mcp-ragflow` 那条设为 `disabled: true`。

---

## 二、方案 A：MCP 桥接（独立可用）

### 配置

```json
{
  "mcpServers": {
    "ragflow": {
      "command": "node",
      "args": ["<本仓库>/ragflow-mcp/server.cjs"]
    }
  }
}
```

Windows 路径写成 `"<本仓库>\\ragflow-mcp\\server.cjs"`（JSON 里反斜杠要转义）。

### API Key 解析顺序

桥接**不需要**在配置里写 Key，它按此顺序找：

1. 进程环境变量 `RAGFLOW_API_KEY`
2. `server.cjs` 同目录或 `<DSH_HOME>/` 下的 `ragflow-key.txt`（纯文本，内容即 Key）
3. Windows 用户注册表 `HKCU\Environment`

**为什么要多源**：多数客户端启动子进程时会清洗环境变量（DSH 的 `scrubbedParentEnv()`
会剥掉所有 `DSH_*` 以及匹配 `KEY|PASSWORD|SECRET|TOKEN` 的变量），只读
`process.env` 会导致 401。

设置用户级环境变量：

```powershell
[Environment]::SetEnvironmentVariable('RAGFLOW_API_KEY','ragflow-xxxx','User')
```

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RAGFLOW_BASE_URL` | `http://localhost:8060` | 服务地址，不含尾斜杠 |
| `RAGFLOW_API_KEY` | — | 也可由 key 文件或注册表提供 |

### 暴露的工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `ragflow_retrieval` | `question`（必填）、`dataset_ids`、`document_ids`、`page`、`page_size`、`similarity_threshold`、`vector_similarity_weight` | 语义检索，返回带 `citation_id` / `source_file` / `score` / `chunk_text` 的片段 |
| `ragflow_list_datasets` | `page`、`page_size` | 列出可访问知识库 |

> RAGFlow v0.25 要求 `dataset_ids` 非空（空数组返回 `code 102`）。
> 桥接已内置兼容：省略时自动列出全部数据集再检索。

---

## 三、方案 B：DSH 宿主插件

### 3.1 为什么必须是宿主工具

会话级勾选要知道「是哪个会话在问」。MCP 桥接做不到，三层原因：

1. 一个 DSH Host 只 spawn **一个** stdio 子进程，所有会话共用；
2. `dsh-mcp-client` 的 `buildChildEnv()` 用 `scrubbedParentEnv()`，**丢弃 `DSH_*`**，子进程拿不到 `DSH_SESSION_ID`；
3. 会话 id 不在 MCP 协议调用参数里。

宿主工具的 `execute(args, exec)` 直接带 `exec.agent.id`（`SessionId`，形如 `session-<uuid>`），
正是会话选择文件的键。所以 `dsh-ragflow-settings` 同时是「设置 UI」和「检索工具」的提供者。

### 3.2 检索范围优先级

工具省略 `dataset_ids` 时：

1. **显式参数** `dataset_ids` —— 覆盖一切
2. **本会话选择** —— 该 Session 有条目就用它（**空数组 = 不检索**，不退回全局）
3. **全局默认** —— 插件页卡片保存的 `datasetIds`
4. **全部可访问** —— 以上都没有时

返回值里 `dataset_source`（`argument`/`session`/`global`/`all`）标明本次用了哪条规则，
`dataset_ids` 是实际检索的 id。每层都会与「当前 Key 可访问的数据集」求交集。

### 3.3 安装四步

**① 建 junction（不要复制！）**

```powershell
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dsh-ragflow-settings" "<本仓库>\dsh-ragflow-settings"
```

⚠️ 部分企业 DLP 会对 `C:\Users\<你>\.dsh\` 下文件透明加密。若插件目录是**复制**进去的，
Electron 读到的是密文（`%TSD-Header-###%` 开头）：

```
skipping profile bundle "@local/dsh-ragflow-settings": SyntaxError: Unexpected token '%'
```

这是**静默降级**：DSH 照常启动，只是插件不加载。junction 指向其他盘符可绕开。
不要用 `Copy-Item`，也不要 `npm install` 本地包（pnpm 会复制而非链接）。

**② 改 `<DSH_HOME>/profiles/desktop/package.json`**

`dependencies` 加：

```json
"@local/dsh-ragflow-settings": "file:<本仓库>/dsh-ragflow-settings"
```

`dsh.profile.bundles` 末尾追加：

```json
"@local/dsh-ragflow-settings"
```

⚠️ `@local/...` 的依赖值**必须是 `file:` 协议**（该包 `private: true`，不在 npm 上），
写成版本号会让 pnpm 去 registry 找，必然 404。

**③ 在 `<DSH_HOME>/cordis.patch.yml` 禁用 MCP 那一条**

若你之前挂了 `mcp-ragflow`，加 `disabled: true`：

```yaml
- insert:
    - id: mcp-ragflow
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: true          # ← 方案 B 下必须为 true，避免与宿主工具重名
      config:
        serverName: ragflow
        transport: stdio
        command: node
        args:
          - '<本仓库>/ragflow-mcp/server.cjs'
        env:
          RAGFLOW_BASE_URL: 'http://localhost:8060'
        toolCallTimeoutMs: 60000
        failOnStartupError: false
```

> 注意：本层 patch 的 `- id: xxx` 只能改写**已存在**的条目，新增必须用 `insert:`。

**④ 重启 DSH**

包清单、bundle、工具注册都只在启动时读取。**改代码也要重启**；
但会话勾选的**内容不需要**，每次工具调用实时读文件。

### 3.4 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/ragflow-settings/state` | 可访问数据集 + 全局默认选择 |
| POST | `/ragflow-settings/selection` | 保存全局默认选择 |
| GET | `/ragflow-settings/session?sessionId=` | 该会话的选择、是否继承、有效 id |
| POST | `/ragflow-settings/session` | 保存该会话的选择（空数组 = 不检索） |

---

## 四、状态文件

| 文件 | 内容 |
|---|---|
| `<DSH_HOME>/ragflow-settings.json` | 全局默认：`{"datasetIds":[...]}` |
| `<DSH_HOME>/ragflow-session-selection.json` | 会话级：`{"sessions":{"<sessionId>":[...]}}` |

**回退语义**：会话未设置 → 继承全局默认；全局也没有 → 检索全部可访问库；
会话勾选为空数组 `[]` → 该会话不检索（这是真实选择，不退回全局）。

写入用临时文件 + rename；会话文件的读-改-写有串行锁，避免并发 POST 互相覆盖。

---

## 五、部署后自检

**① 桥接能独立跑通**（方案 A / B 都建议先验这一步）

```powershell
node -e "const{spawn}=require('child_process');const p=spawn(process.execPath,['<本仓库>/ragflow-mcp/server.cjs'],{stdio:['pipe','pipe','pipe']});let o='';p.stdout.on('data',d=>o+=d);p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'t',version:'1'}}})+String.fromCharCode(10));setTimeout(()=>{p.kill();console.log(o)||process.exit(0)},1500)"
```

判据：输出含 `"name":"ragflow"`。

**② 插件包能组合**（方案 B）

```powershell
# desktop 被 Electron 独占，不能直接 dump，另建临时 profile
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.dsh\profiles\rgtest" | Out-Null
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\rgtest\node_modules" "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
# 用编辑器把 desktop 的 package.json 内容写进 rgtest（不要 Copy-Item，见 DLP 说明）
dsh --profile rgtest --dump-config 2>&1 | Select-String 'skipping|not found|ragflow'
```

判据：**没有** `skipping` / `not found`；能看到 `id: ragflow-settings`。

**③ 重启后看两处**（方案 B）

- 工具列表出现 `ragflow_retrieval`、`ragflow_list_datasets`（**无** `mcp__` 前缀）
- 输入框工具栏（权限选择器旁）出现书本图标按钮

**④ 端到端检索**

问一句「上下料规则怎么配」，应返回带 `source_file` 的片段，
且返回体的 `dataset_source` 显示本次用的规则。

---

## 六、卸载

**方案 A**：从客户端配置里删掉 `ragflow` 那条即可，无残留。

**方案 B**：

```powershell
# 1. 移除 junction
cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dsh-ragflow-settings"

# 2. 从 cordis.patch.yml 删除 mcp-ragflow 那段 insert
#    （保留 plugin-manager 那条，该文件不能为空，否则启动失败）

# 3. 从 profiles\desktop\package.json 删除 dependencies 与 bundles 里的 @local/dsh-ragflow-settings

# 4. 可选：删除两个状态 json
```

源码目录可保留，供外部客户端继续使用。

---

## 七、示例知识库

| dataset_id | 名称 | 块数 |
|---|---|---|
| `e6567a92d8e911f1937961098168577a` | LDS-上下料-SOUL细节补充 | 47 |
| `c2d3cbe0d8c311f1937961098168577a` | LDS-上下料规则 | 9 |
| `b2f85832d6a511f1937961098168577a` | LDS-定时任务 | 5 |
| `7a0202c08a6b11f18abb934b203a2e28` | LDS-用户与权限 | 16 |

这是参考部署里的库，你自己的会不同。新增知识库无需改配置，列表和按钮自动读到。
