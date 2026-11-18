# @local/dsh-ragflow-settings

两件事：在 DSH「插件」页放一张「RAGFlow 知识库」卡片，以及**在宿主里注册真正能按会话检索的工具**。

- 卡片：勾选全局默认知识库，落到 `<DSH_HOME>/ragflow-settings.json`。
- 输入框右侧的知识库按钮：勾选**本会话**检索哪些知识库，落到
  `<DSH_HOME>/ragflow-session-selection.json`，改完立即生效、无需重启。
- 工具：`ragflow_list_datasets` / `ragflow_retrieval`，由宿主直接调 RAGFlow REST。

## 为什么不再走 MCP

会话级勾选必须知道「是哪个会话在问」。MCP 桥接做不到：

1. 一个 Host 只 spawn 一个 stdio 子进程，所有会话共用；
2. `@deepseek-ai/dsh-mcp-client` 的 `buildChildEnv()` 走 `scrubbedParentEnv()`，
   **会丢弃父进程的 `DSH_*` 变量**，子进程拿不到 `DSH_SESSION_ID`；
3. 于是桥接只能读全局文件，会话文件写完没人读。

宿主工具不一样：`execute(args, exec)` 的 `exec.agent.id` 就是调用方 Session id
（`SessionId`，形如 `session-<uuid>`），这正是会话选择文件的键。

因此本包现在同时是「设置 UI」和「检索工具」的提供者。旧的
`ragflow-mcp/server.cjs` 保留，供自己 spawn 桥接的第三方 MCP 客户端
（Codex / Claude Desktop 等）使用；本机 Harness 已在
`~/.dsh/cordis.patch.yml` 里把 `mcp-ragflow` 这一行 `disabled: true`。

## 结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | `dsh.bundle.patch` + `dsh.client`（platform web，inject 设置页与 store） |
| `cordis.patch.yml` | 插入 `ragflow-settings` 一行 |
| `lib/index.js` | 宿主半边：4 条路由 + 2 个工具 |
| `lib/client.js` | 浏览器半边：设置页卡片 + 输入框旁边的会话选择器 |
| `locale/zh.json` / `en.json` | 插件管理器读到的标题与描述 |

宿主半边 `inject = ['webServer', 'tools']`。

## 检索范围优先级

`ragflow_retrieval` 省略 `dataset_ids` 时，按此顺序决定检索范围：

1. **显式参数** `dataset_ids` —— 调用方指定，覆盖一切；
2. **本会话选择** —— 该 Session 在文件里有条目就用它（**空数组是真实选择：什么都不检索**）；
3. **全局默认** —— 设置页卡片保存的 `datasetIds`；
4. **全部可访问** —— 以上都没有时。

返回值里的 `dataset_source` 就是本次实际用到的规则
（`argument` / `session` / `global` / `all`），`dataset_ids` 是实际检索的 id 列表。
任何一层拿到的 id 都会先与「当前 API Key 可访问的数据集」求交集，未知 id 被丢弃。

## 路由

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/ragflow-settings/state` | 可访问数据集 + 全局默认选择 |
| POST | `/ragflow-settings/selection` | 保存全局默认选择 |
| GET | `/ragflow-settings/session?sessionId=` | 该会话的选择、是否继承、有效 id |
| POST | `/ragflow-settings/session` | 保存该会话的选择（空数组 = 什么都不检索） |

写盘用临时文件 + rename；会话文件的读-改-写有串行锁，避免并发 POST 互相覆盖。

## 安装

包目录需出现在 profile 的 `node_modules` 与 `dsh.profile.bundles` 中：

1. 建 junction（**不要复制**，原因见下方踩坑记录）：
   ```powershell
   cmd /c mklink /J "<DSH_PROFILE_DIR>\node_modules\@local\dsh-ragflow-settings" "<本仓库>\dsh-ragflow-settings"
   ```
2. 在 `<DSH_PROFILE_DIR>/package.json` 的 `dependencies` 加
   `"@local/dsh-ragflow-settings": "file:<包路径>"`，
   在 `dsh.profile.bundles` 末尾加 `"@local/dsh-ragflow-settings"`
3. 重启 DSH（包清单、bundle、以及工具注册只在启动时读取）

改 `lib/client.js` 需要重启 Host 才会被重新打包下发；改 `lib/index.js`
同样需要重启（工具在 `apply()` 里注册）。

## 凭据来源

`RAGFLOW_API_KEY` 优先取进程环境变量；取不到时回退读取 Windows 用户环境
（`HKCU\Environment`），因为早于该变量设置的 DSH 进程不会继承它。

## 踩坑记录

1. **本机端点 DLP 会加密 PowerShell / 普通 node 写出的文件**：`%TSD-Header-###%`
   头，Electron 进程读到乱码，`JSON.parse` 直接抛错。安装文件与配置文件都必须由
   Harness 进程写出，否则重启后宿主读到的是乱码。
2. **不要用 `Copy-Item` 复制 `package.json` 到 profile**：即便源文件是明文，
   复制出的目标文件也可能被 DLP 加密，表现为 profile 启动即
   `SyntaxError: Unexpected token '%'`。
3. **MCP 子进程拿不到会话身份**：见上文「为什么不再走 MCP」。
4. `dsh --profile desktop --dump-config` 被拒（desktop 由 Electron 独占管理），
   要验证组合树得另建一个临时 profile。
