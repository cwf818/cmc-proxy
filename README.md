# cmc-proxy — commandcode GOAT 订阅本地反代网关

把 commandcode 的 Provider API 反代到本机 `127.0.0.1:5411`，让本地 **Claude Code** 和 **Codex** 直接接入你的 GOAT 订阅。

- 零第三方依赖，仅需 Node.js ≥ 18（内置 `fetch`/`ReadableStream`）
- 同时提供 **OpenAI 兼容**（`/v1/chat/completions`，供 Codex）与 **Anthropic 兼容**（`/v1/messages`，供 Claude Code）端点
- 内置 **Anthropic ↔ OpenAI 协议转换**：GOAT 订阅不含任何 Claude 模型，Claude Code 的请求会自动转换格式并映射到你配置的模型上（默认 `gpt-5.6-sol`），流式 + 工具调用全链路支持
- 支持流式 SSE 透传、token 用量上报、模型列表过滤

## 文件说明

```
cmc-proxy/
├── proxy.js        # 主程序（反代 + 协议转换）
├── config.json     # 配置：端口、API Key、模型映射
├── start.bat       # Windows 启动脚本
├── start.sh        # macOS/Linux 启动脚本
└── README.md
```

## 快速开始

1. 确保已安装 Node.js ≥ 18（`node -v` 验证）。
2. 检查 `config.json`：`apiKey` 已填入你的 GOAT API Key；确认端口为 `5411`。
3. 启动：

   ```bash
   # Windows
   start.bat
   # macOS / Linux
   ./start.sh
   # 或直接
   node proxy.js
   ```

4. 验证：`curl http://127.0.0.1:5411/health` 应返回 `{"ok":true,...}`。

## Claude Code 接入

Claude Code 走 Anthropic 协议。设置环境变量后启动 `claude`：

```bash
# Windows (PowerShell)
$env:ANTHROPIC_BASE_URL="http://localhost:5411"
$env:ANTHROPIC_AUTH_TOKEN="sk-local-any-value"
$env:ANTHROPIC_MODEL="gpt-5.6-sol"
claude

# macOS / Linux
export ANTHROPIC_BASE_URL=http://localhost:5411
export ANTHROPIC_AUTH_TOKEN=sk-local-any-value
export ANTHROPIC_MODEL=gpt-5.6-sol
claude
```

> `ANTHROPIC_AUTH_TOKEN` 填任意值即可，反代会替换成真实 Key。
> 也可以在 Claude Code 里用 `/model` 选择反代 `/v1/models` 返回的模型。
> 请求任意 `claude-*` 模型名都会被自动映射到 `defaultModel`（GOAT 无 Claude 模型）。

## Codex 接入

Codex CLI 走 OpenAI 兼容协议，编辑 `~/.codex/config.toml`：

```toml
model_provider = "cmdc-goat"
model = "gpt-5.6-sol"

[model_providers.cmdc-goat]
name = "CommandCode GOAT"
base_url = "http://localhost:5411/v1"
wire_api = "chat"
env_key = "CMD_GOAT_KEY"
```

然后：

```bash
export CMD_GOAT_KEY=sk-local-any-value
codex
```

或使用 OpenAI 兼容环境变量：

```bash
export OPENAI_BASE_URL=http://localhost:5411/v1
export OPENAI_API_KEY=sk-local-any-value
export OPENAI_MODEL=gpt-5.6-sol
```

> 注意 `base_url` 需要带 `/v1` 后缀（Codex 会自动拼接 `/chat/completions`）。

## 模型说明

GOAT 订阅**不包含 Claude 全系**（Sonnet 需 Pro、Opus 需 Provider），也不含 GPT-5.5 及以下。实测可用的模型（2026-08）：

| 模型 ID | 说明 |
|---|---|
| `gpt-5.6-sol` | 默认模型，编码/智能体能力强，Codex 系 |
| `deepseek/deepseek-v4-pro` / `deepseek/deepseek-v4-flash` | DeepSeek V4，性价比高 |
| `moonshotai/Kimi-K2.7-Code` / `moonshotai/Kimi-K3` | Kimi 编码系 |
| `zai-org/GLM-5.2` | 智谱 GLM |
| `Qwen/Qwen3.8-Max` / `Qwen/Qwen3.7-Flash` | 阿里 Qwen |
| `MiniMaxAI/MiniMax-M3` | MiniMax |
| `xai/grok-4.6` | Grok |
| `xiaomi/mimo-v2.5-pro` | 小米，限时高折扣 |
| `tencent/hy3-paid` | 腾讯 |

- 完整列表：`curl http://127.0.0.1:5411/v1/models`（已过滤 GOAT 不可用模型，`?raw=1` 看全量）。
- 换模型：改 `config.json` 的 `defaultModel`，或在 `modelMap` 里把特定模型名映射到目标模型后重启。
- GOAT 按订阅额度计费，模型实际可用性以上游返回为准。

## 原理

```
Claude Code ──Anthropic /v1/messages──▶ cmc-proxy:5411
                                              │  协议转换 + 模型映射 + Key 注入
Codex ──────OpenAI /v1/chat/completions──▶   │
                                              ▼
                              https://api.commandcode.ai/provider/v1/*
```

- `/v1/messages` 收到 `claude-*` 模型名 → 转换请求为 OpenAI 格式 → 请求上游 `/chat/completions`（用映射后的模型）→ 把流式/非流式响应转回 Anthropic SSE / JSON，包含 `tool_use` / `input_json_delta` 工具事件。
- 收到非 Claude 模型名 → 直接透传上游 `/messages`（预留 Pro/Provider 升级后使用真实 Claude 模型）。
- `/v1/chat/completions`、`/v1/models`、`/v1/*` 其他路径 → 原样透传，仅注入 Key 与模型映射。

## 常见问题

**端口被占用**
```powershell
Get-NetTCPConnection -LocalPort 5411 -State Listen | Stop-Process
```
或改 `config.json` 的 `port`。

**请求报 `MODEL_NOT_IN_PLAN`** — 该模型 GOAT 订阅不可用，换 `defaultModel` 或映射到可用模型。

**想用真正的 Claude 模型** — 需要升级 Pro/Provider 计划；升级后在 `modelMap` 中把 `claude-*` 映射为真实 Claude 模型名（如 `claude-sonnet-4-6`）即可直连上游 `/messages`。

**流式输出卡住** — 检查网络到 `api.commandcode.ai` 的连通性；可设 `CMC_DEBUG=1` 启动查看上游原始流。

## 安全提醒

`config.json` 中的 `apiKey` 是你的订阅凭据，**不要提交到公开仓库**。建议：

```gitignore
config.json
proxy.log
```

服务默认只监听 `127.0.0.1`，如需局域网共享请改 `config.json` 的 `host` 为 `0.0.0.0` 并自行加鉴权。
