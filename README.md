# RAG-tool

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)
[![RAGFlow](https://img.shields.io/badge/RAGFlow-v0.25.x-blue)](https://ragflow.io)

把 [RAGFlow](https://ragflow.io) 的知识库接进你的 AI 应用，让模型能检索你自己文档里的内容。

两种用法，装哪个看你的客户端：

| | 方案 A · MCP 桥接 | 方案 B · DSH 插件 |
|---|---|---|
| 适用 | 任何支持 MCP 的客户端 | DeepSeek Harness |
| 装法 | 配一行 JSON | 装插件 + 填表单 |
| 按会话选库 | ❌ 只能全局 | ✅ 每个对话可以不同 |
| 依赖 | 一个 Node 文件，零依赖 | Node ≥ 22.19 + DSH 0.2.2 |
| 起手难度 | 改配置文件 | 点点鼠标 |

---

## 功能

### 语义检索

问一句话，返回你知识库里最相关的片段，带出处和相似度分数：

```json
{
  "query": "入职流程怎么走",
  "dataset_ids": ["<你的库>"],
  "dataset_source": "global",
  "total": 32,
  "returned": 2,
  "results": [
    { "citation_id": 1, "source_file": "handbook.md", "score": 50.29, "chunk_text": "……" },
    { "citation_id": 2, "source_file": "handbook.md", "score": 50.21, "chunk_text": "……" }
  ]
}
```

`score` 是 RAGFlow 原样返回的相似度，**量纲取决于你的 embedding 模型与配置**
（见过 0.3x 也见过 50.x），不要跨部署比较绝对值。

### 按会话选知识库（方案 B）

同一个 DSH 里，A 对话查「运维手册」、B 对话查「产品文档」，互不干扰。

- **插件页**设置全局默认
- **输入框旁边的书本按钮**给当前会话单独指定
- 改完**立即生效**，不用重启

优先级：**显式参数 > 本会话 > 全局默认 > 全部可访问**。
返回值里的 `dataset_source` 会告诉你这次实际用了哪一档。

### 插件页直接配置（方案 B · v0.4.0）

不用碰环境变量，装完在插件页填两格就行：

```
服务地址   http://你的RAGFlow:8060
API Key   粘贴
[测试连接]  →  ✅ 连接成功，可访问 5 个知识库
```

连接没测通之前，知识库勾选区是锁住的，免得对着一堆注定用不了的选项点。

### 对话里直接写库（方案 B · v0.5.0）

不用打开 RAGFlow 网页，直接说「把这段排查结论存进《运维手册》」：

```
> 把刚才的排查结论存进「运维手册」

✔ 已写入 运维手册 / 排查结论.md
  已提交切块，索引完成后可检索
```

三道保险：

- `dataset_id` 必须在 `ragflow_list_datasets` 的返回里，猜错或打错会被拒
- **没有删除接口** —— 写进去的要删，去 RAGFlow 网页删
- 切块是异步的，`indexed: true` 只代表已提交

### 对外暴露的能力

| 类型 | 名称 | 说明 |
|---|---|---|
| 工具 | `ragflow_retrieval` | 语义检索，参数 `question` / `dataset_ids` / `document_ids` / `page` / `page_size` / `similarity_threshold` / `vector_similarity_weight` |
| 工具 | `ragflow_list_datasets` | 列出可访问的知识库 |
| 工具 | `ragflow_add_document` | 把一段文本存进指定知识库并触发切块 |
| 界面 | 插件页卡片 | 连接配置 + 全局默认勾选 |
| 界面 | 输入框旁按钮 | 本会话勾选 |

---

## 快速开始

### 方案 A · MCP 桥接

RAGFlow 从 **v0.26** 才有内置 MCP 端点；**v0.25.x 没有**（`POST /api/v1/mcp` 实测
无认证 / 假 Key / GET 三态全 404）。`ragflow-mcp/server.cjs` 就是补这个缺口的：
对外是标准 MCP server，对内打 RAGFlow 的 REST 接口，**零依赖**，236 行。

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

Windows 记得转义：`"D:\\tools\\ragflow-mcp\\server.cjs"`

不需要在配置里写 Key，桥接按以下顺序自己找：

1. 环境变量 `RAGFLOW_API_KEY`
2. `server.cjs` 同目录或 `~/.dsh/` 下的 `ragflow-key.txt`
3. Windows 注册表 `HKCU\Environment`

**为什么要多源**：多数 MCP 客户端启动子进程时会清洗环境变量
（DSH 的 `scrubbedParentEnv()` 会剥掉 `DSH_*` 以及匹配 `KEY|PASSWORD|SECRET|TOKEN` 的变量），
只读 `process.env` 必然 401。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `RAGFLOW_BASE_URL` | `http://localhost:8060` | 服务地址，不含尾斜杠 |
| `RAGFLOW_API_KEY` | — | 也可由 key 文件或注册表提供 |

> RAGFlow v0.25 要求 `dataset_ids` 非空（空数组返回 `code 102`）。
> 桥接已内置兼容：省略时自动列出全部数据集再检索。

### 方案 B · DSH 插件

```powershell
# 1. 建 junction（不要复制，见下方 DLP 说明）
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dsh-ragflow-settings" "<本仓库>\dsh-ragflow-settings"

# 2. 在 profiles\desktop\package.json 的 dependencies 加：
#    "@local/dsh-ragflow-settings": "file:<绝对路径>/dsh-ragflow-settings"
#    并在 dsh.profile.bundles 末尾追加 "@local/dsh-ragflow-settings"
```

重启 DSH → 打开「插件」页 → 填地址与 API Key → **测试连接** → 勾库 → 保存。

> ⚠️ **DLP 陷阱**：某些企业环境会对 `C:\Users\<你>\.dsh\` 下的文件透明加密。
> 用**复制**装插件目录，Electron 会读到密文（`%TSD-Header-###%` 开头）：
>
> ```
> skipping profile bundle "@local/dsh-ragflow-settings": SyntaxError: Unexpected token '%'
> ```
>
> 这是**静默降级**——DSH 照常启动，只是插件不加载。用 junction 可绕开。

---

## 为什么 DSH 用宿主工具而不是 MCP

会话级勾选必须知道「是哪个会话在问」。MCP 桥接做不到，三层原因：

1. 一个 DSH Host 只 spawn **一个** stdio 子进程，所有会话共用；
2. `@deepseek-ai/dsh-mcp-client` 的 `buildChildEnv()` 用 `scrubbedParentEnv()`，
   **丢弃 `DSH_*`**，子进程拿不到 `DSH_SESSION_ID`；
3. 会话 id 不在 MCP 协议的调用参数里。

宿主工具的 `execute(args, exec)` 直接带 `exec.agent.id`（`SessionId`，形如 `session-<uuid>`），
正是会话选择文件的键。所以方案 B 同时是「设置 UI」和「检索工具」的提供者。

---

## 配置

### Key 存在哪（方案 B）

插件启动时若发现 Host 挂了 `credentials` 服务（`@deepseek-ai/dsh-credentials-local`），
就把 Key 交给它保管，配置文件里只写引用；没有就退化为内联。

| Host 环境 | 存放位置 |
|---|---|
| 有凭据服务 | `ragflow-config.json` 只写 `{"apiKeyRef":"ragflow"}` |
| 无凭据服务 | 内联 `{"apiKey":"…"}` |
| 都没配 | 回落 `RAGFLOW_API_KEY` 环境变量 |

**无论哪种，读配置的接口只返回掩码**（如 `ragf…mHzA`）与来源，从不回传明文。

### 状态文件

| 文件 | 内容 |
|---|---|
| `~/.dsh/ragflow-config.json` | 连接配置（地址 / 超时 / Key 或其引用） |
| `~/.dsh/ragflow-settings.json` | 全局默认：`{"datasetIds":[...]}` |
| `~/.dsh/ragflow-session-selection.json` | 会话级：`{"sessions":{"<sessionId>":[...]}}` |

写入用临时文件 + rename；会话文件的读-改-写有串行锁，避免并发 POST 互相覆盖。

### HTTP 路由（方案 B）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/ragflow-settings/config` | 连接配置（Key 只返回掩码） |
| POST | `/ragflow-settings/config` | 保存地址 / Key / 超时 |
| POST | `/ragflow-settings/test` | 试连一次，不保存 |
| GET | `/ragflow-settings/state` | 可访问数据集 + 全局默认 |
| POST | `/ragflow-settings/selection` | 保存全局默认 |
| GET | `/ragflow-settings/session?sessionId=` | 该会话的选择与有效 id |
| POST | `/ragflow-settings/session` | 保存该会话的选择 |

---

## 项目结构

```
ragflow-mcp/
  server.cjs                 # 方案 A：零依赖 stdio MCP 桥接
dsh-ragflow-settings/        # 方案 B：DSH 插件
  lib/index.js               #   宿主：5 条路由处理器 + 2 个工具
  lib/client.js              #   浏览器：插件页卡片 + 输入框按钮
  locale/{zh,en}.json        #   插件管理器读到的标题
tools/                       # 自检脚本（零依赖）
  mcp-probe.cjs              #   最小 MCP 客户端
  probe-ragflow.cjs          #   REST 连通性
  mount-*.mjs                #   挂载宿主半边测路由
  render-*.mjs               #   在 Node 里跑浏览器半边
  check-manifest.cjs         #   复现 Host 的 dsh.client 校验
```

---

## 兼容性

| 组件 | 要求 |
|---|---|
| `ragflow-mcp/server.cjs` | Node ≥ 18（零依赖，只用内置模块） |
| `dsh-ragflow-settings` | Node ≥ 22.19 + DSH 0.2.2-rc.3 |
| RAGFlow 服务端 | v0.25.x（已在 v0.25.0-63-gfb95136f3 验证） |

> 装了方案 B 就**不要**再启用方案 A 的 `mcp-ragflow` 行 ——
> 两边工具同名（`ragflow_retrieval` / `ragflow_list_datasets`）会冲突。

---

## 常见问题

**检索返回空？**
先跑 `node tools/probe-ragflow.cjs` 确认能连上；再看返回体的 `dataset_source`——
如果是 `session` 且当前会话勾了空库，那就什么都查不到。

**改了代码没生效？**
方案 B 的包清单、bundle、工具注册都只在 Host 启动时读取，**改代码要重启**。
但会话勾选的**内容**不用，每次调用实时读文件。

**RAGFlow 返回 401？**
Key 不对或没传进去。检查插件页是否配置过（页面配置优先于环境变量）。

---

## 文档

- [RAGFlow接入-恢复说明.md](./RAGFlow接入-恢复说明.md) —— 部署、自检清单、卸载
- [dsh-ragflow-settings/README.md](./dsh-ragflow-settings/README.md) —— 插件细节与踩坑
- [dsh-ragflow-settings/交付报告.md](./dsh-ragflow-settings/交付报告.md) —— 验收实证
- [tools/README.md](./tools/README.md) —— 自检脚本用法

---

## License

[MIT](./LICENSE)
