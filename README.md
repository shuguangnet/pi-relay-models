# pi-relay-models

一键拉取中转站（OpenAI 兼容 API）的模型列表与上下文大小，并可注册为 [pi coding agent](https://pi.dev) 的 provider。

One-click fetch the model list & context window sizes from an OpenAI-compatible relay (New API / One API / OpenRouter-style), and register them as a pi provider.

## 功能 / Features

- `/relay-models` — 拉取中转站全部模型，表格展示上下文窗口、输出上限、推理能力、价格
- `/relay-setup` — （重新）配置 Base URL 与 API Key
- `/relay-models --no-register` — 只拉取展示，不注册 provider
- `relay_models` 工具 — 注册给 LLM，直接询问"中转站有哪些模型"即可调用
- 拉取成功后自动 `registerProvider`，`/model` 选择器中直接选用中转站全部模型

### 上下文大小来源

中转站的 `/v1/models` 通常只返回模型 id，不带上文窗口。本扩展按以下优先级补全：

1. 中转站自带 `context_length` / `context_window`（OpenRouter 类站点）
2. [models.dev](https://models.dev) 数据库匹配（精确 → 规范化 → 去 vendor 前缀 → 最长前缀模糊），本地缓存 7 天
3. 标记为"未知"

同时带出：输出上限、是否推理模型、输入模态、每百万 token 价格（与 pi 计价单位一致）。

## 安装 / Install

```bash
pi install git:github.com/shuguangnet/pi-relay-models@v1.0.0
```

或作为本地扩展：

```bash
mkdir -p ~/.pi/agent/extensions
curl -o ~/.pi/agent/extensions/relay-models.ts \
  https://raw.githubusercontent.com/shuguangnet/pi-relay-models/main/extensions/relay-models.ts
```

## 使用 / Usage

```text
/relay-setup     # 首次使用：输入中转站 Base URL（如 https://api.example.com/v1）与 API Key
/relay-models    # 拉取并展示；首次无配置会自动进入 setup
/model           # 选择 "中转站 (host)" provider 下的任意模型
```

配置保存在 `~/.pi/agent/models.json` 同级的 `~/.pi/agent/relay-models.json`（权限 0600）。

## 截图示例

```text
中转站 https://api.example.com/v1 — 97 个模型（/relay-models 重新拉取）

模型                                     上下文      输出  推理  来源
------------------------------------------------------------------------
gpt-5.6-luna                              1.1M      128K  ✓    models.dev
deepseek/deepseek-v4-flash                  1M      384K  ✓    models.dev
gemini-3.6-flash                            1M       66K  ✓    models.dev
claude-opus-4-5                           200K       64K  ✓    models.dev
```

## License

MIT
