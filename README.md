# RAG-tool

把 **RAGFlow 知识库**接进支持 MCP 协议的 AI 客户端（DeepSeek Harness / OpenCode / Codex / Claude Desktop 等），
并提供按会话勾选知识库的界面。

```
AI 客户端  ──stdio MCP──▶  ragflow-mcp/server.cjs  ──REST──▶  RAGFlow
                                    ▲
                          dsh-ragflow-settings
                       （DSH 插件：全局默认 + 会话级勾选）
```

---

## 为什么需要这个桥接

RAGFlow 从 **v0.26** 起才提供内置 MCP 端点（`POST /api/v1/mcp`）。在 **v0.25.x** 上该端点不存在
（实测无认证 / 假 Key / GET 三种情况全部返回 404）。

`ragflow-mcp/server.cjs` 用 **零依赖**（仅 Node 内置模块）的 stdio MCP 服务器填补这个缺口：
它对客户端表现为标准 MCP server，对内调用 RAGFlow 的 REST 接口。

**兼容性**：Node.js ≥ 18（用到内置 fetch 之外的模块均可）。已在 Node 24 实测。
服务端已在 **RAGFlow v0.25.0-63-gfb95136f3** 验证。

---

## 一、ragflow-mcp —— 独立可用，不依赖 DSH

这才是移植到其他客户端的主体。任意支持 MCP 的客户端都能接。

### 配置

**OpenCode / Codex / Claude Desktop（stdio 形式）**

```json
{
  "mcpServers": {
    "ragflow": {
      "command": "node",
      "args": ["/absolute/path/to/ragflow-mcp/server.cjs"]
    }
  }
}
```

Windows 路径记得转义：`"D:\\tools\\ragflow-mcp\\server.cjs"`

### API Key 解析顺序

桥接**不需要**在配置里写 Key，它按以下顺序查找：

1. 进程环境变量 `RAGFLOW_API_KEY`
2. `server.cjs` 同目录或 `~/.dsh/` 下的 `ragflow-key.txt`（纯文本，内容就是 Key）
3. Windows 用户注册表 `HKCU\Environment` 下的 `RAGFLOW_API_KEY`

**为什么需要多源**：多数 MCP 客户端启动子进程时会清洗环境变量
（DSH 的 `scrubbedParentEnv()` 会剥掉所有 `DSH_*` 以及匹配 `KEY|PASSWORD|SECRET|TOKEN` 的变量），
只读 `process.env` 会导致 401。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RAGFLOW_BASE_URL` | `http://localhost:8060` | RAGFlow 服务地址（含端口，不含尾斜杠） |
| `RAGFLOW_API_KEY` | — | 也可通过 key 文件或注册表提供 |

### 暴露的工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `ragflow_retrieval` | `question`（必填）, `dataset_ids`, `document_ids`, `page`, `page_size`, `similarity_threshold`, `vector_similarity_weight` | 语义检索，返回带 `citation_id` / `source_file` / `score` / `chunk_text` 的片段 |
| `ragflow_list_datasets` | `page`, `page_size` | 列出可访问的知识库 |

`dataset_ids` 省略时的行为：优先用 DSH 插件写入的全局选择，其次检索全部可访问知识库。

> **注意**：RAGFlow v0.25 要求 `dataset_ids` 非空（空数组会返回 `code 102`）。
> 桥接已内置该兼容处理——省略时自动列出全部数据集再检索。

---

## 二、dsh-ragflow-settings —— DeepSeek Harness 专用插件

只对 DSH 有意义，其他客户端不需要。

- **插件页卡片**：设置全局默认勾选哪些知识库
- **输入框工具栏按钮**：在权限选择器旁，按会话勾选知识库

### 安装

```powershell
# 1. 建 junction（不要用复制！见下方 DLP 说明）
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dsh-ragflow-settings" "<本仓库>\dsh-ragflow-settings"

# 2. 在 profiles\desktop\package.json 的 dependencies 加：
#    "@local/dsh-ragflow-settings": "file:<绝对路径>/dsh-ragflow-settings"
#    并在 dsh.profile.bundles 末尾追加 "@local/dsh-ragflow-settings"
```

⚠️ **DLP 陷阱**：某些企业环境的 DLP 会对 `C:\Users\<你>\.dsh\` 下的文件做透明加密。
若插件目录是**复制**进去的，Electron 进程会读到密文（`%TSD-Header-###%` 开头），导致：

```
skipping profile bundle "@local/dsh-ragflow-settings": SyntaxError: Unexpected token '%'
```

这是**静默降级**——DSH 照常启动，只是插件不加载。用 junction 指向其他盘符可绕开。

### 状态文件

| 文件 | 内容 |
|---|---|
| `~/.dsh/ragflow-settings.json` | 全局默认：`{"datasetIds":[...]}` |
| `~/.dsh/ragflow-session-selection.json` | 会话级：`{"sessions":{"<sessionId>":[...]}}` |

**回退语义**：会话未设置 → 继承全局默认；全局也没有 → 检索全部；会话勾选为空数组 → 该会话不检索。

### 已知限制

会话级按钮的选择**不会自动传导给模型**。`dsh-mcp-client` 启动子进程时会剥除 `DSH_*`
环境变量，桥接进程拿不到 sessionId，无法知道当前是哪个会话在检索。

实际流程：按钮写文件 → 模型读文件 → 调用时显式传 `dataset_ids`。
要做到完全自动，需另写原生工具插件（`ctx.tools.register`），它能直接拿到 agent 上下文。

---

## 三、在 DSH 里挂载桥接

在 `~/.dsh/cordis.patch.yml` 末尾追加。
**必须用 `insert:`**——该层的 `- id: xxx` 只能改写**已存在**的条目，新增会报 `entry not found`。

```yaml
- insert:
    - id: mcp-ragflow
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ragflow
        transport: stdio
        command: node
        args:
          - '<本仓库绝对路径>/ragflow-mcp/server.cjs'
        env:
          RAGFLOW_BASE_URL: 'http://localhost:8060'
        toolCallTimeoutMs: 60000
        failOnStartupError: false
```

依赖：`@deepseek-ai/dsh-mcp-client@0.2.2-rc.1`（需与 DSH 运行时版本一致）。
注意 npm 的 `latest` 标签指向过期的 `0.0.1-rc.1`，安装时必须钉死版本号。

---

## 四、更多文档

- [RAGFlow接入-恢复说明.md](./RAGFlow接入-恢复说明.md) —— 完整恢复步骤、自检清单、卸载方法

---

## License

MIT
