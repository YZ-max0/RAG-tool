# @local/dsh-ragflow-settings

在 DSH「插件」页增加一张「RAGFlow 知识库」卡片：勾选要检索的知识库，
勾选结果落到 `<DSH_HOME>/ragflow-settings.json`，由 `ragflow-mcp` 桥接读取，
成为 `ragflow_retrieval` 省略 `dataset_ids` 时的默认检索范围。

## 结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | `dsh.bundle.patch` + `dsh.client`（platform web，inject 设置页与 store） |
| `cordis.patch.yml` | 插入 `ragflow-settings` 一行 |
| `lib/index.js` | 宿主半边：`GET /ragflow-settings/state`、`POST /ragflow-settings/selection` |
| `lib/client.js` | 浏览器半边：注册 `plugins.item` 卡片 |
| `locale/zh.json` / `en.json` | 插件管理器读到的标题与描述 |

## 安装

包目录需出现在 profile 的 `node_modules` 与 `dsh.profile.bundles` 中：

1. 复制到 `<DSH_PROFILE_DIR>/node_modules/@local/dsh-ragflow-settings/`
2. 在 `<DSH_PROFILE_DIR>/package.json` 的 `dependencies` 加
   `"@local/dsh-ragflow-settings": "0.1.0"`，
   在 `dsh.profile.bundles` 末尾加 `"@local/dsh-ragflow-settings"`
3. 重启 DSH（包清单与 bundle 只在启动时读取）

## 配置文件

```json
{
  "datasetIds": ["e6567a92d8e911f1937961098168577a"],
  "updatedAt": "2026-11-10T06:44:43.535Z"
}
```

- 文件缺失、为空数组、或 JSON 不可解析时，`ragflow_retrieval` 退回「全部可访问数据集」。
- 保存时只保留当前 API Key 确实可访问的 dataset id，未知 id 被丢弃。
- 写入使用临时文件 + rename，桥接不会读到写了一半的内容。

## 宿主半边的凭据来源

`RAGFLOW_API_KEY` 优先取进程环境变量；取不到时回退读取 Windows 用户环境
（`HKCU\\Environment`），因为早于该变量设置的 DSH 进程不会继承它。

## 踩坑记录

本机端点 DLP 会把 PowerShell / 普通 node 写出的文件加密成 `%TSD-Header-###%` 头，
只有 Harness 进程自己写出的文件是明文。安装文件与配置文件都必须由 Harness 进程写出，
否则重启后宿主读到的是乱码。
