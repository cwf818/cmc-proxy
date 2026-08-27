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
├── config.json     # 配置：端口、API Key、模型映射（gitignore，不入库）
├── config.example.json  # 配置模板
├── build.js        # 构建脚本：导出 release 版本
├── start.bat       # Windows 启动脚本
├── start.sh        # macOS/Linux 启动脚本
├── schemas.md      # 四阶段数据格式与样例参考（Local/Upstream 请求与响应）
├── release/        # build 产物（gitignore，由 build.js 生成）
└── README.md
```

## 构建 Release

`release/` 目录是构建产物（已 gitignore），由 `build.js` 生成，不要手动编辑：

```bash
node build.js                  # 导出到 release/，版本号自动取 git tag/commit
node build.js --version v1.0.1 # 指定版本号
node build.js --out dist       # 自定义输出目录
```

产物包含 `proxy.js`、`config.example.json`、`start.bat`、`start.sh`、`README.md` 与 `VERSION.txt`（版本 / 构建时间 / git commit / 文件校验和）。**不含 `config.json`**（含私有 apiKey）。拿到 release 后：

1. 复制 `config.example.json` 为 `config.json`；
2. 填入你的 apiKey，按需调整端口 / 模型映射；
3. `start.bat`（Windows）或 `./start.sh`（macOS/Linux）启动。

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
# 不设置 ANTHROPIC_MODEL 时使用默认模型 deepseek/deepseek-v4-flash
claude

# macOS / Linux
export ANTHROPIC_BASE_URL=http://localhost:5411
export ANTHROPIC_AUTH_TOKEN=sk-local-any-value
claude
```

> `ANTHROPIC_AUTH_TOKEN` 填任意值即可，反代会替换成真实 Key。
> 也可以在 Claude Code 里用 `/model` 选择反代 `/v1/models` 返回的模型，或直接输入**不带前缀**的模型名（如 `deepseek-v4-flash`、`qwen3.8-max`），反代会自动匹配到对应的上游模型。

## Codex 接入

Codex CLI（≥ 0.84）只支持 Responses API（`wire_api = "chat"` 已移除）。编辑 `~/.codex/config.toml`：

```toml
model_provider = "cmdc-goat"
model = "deepseek-v4-flash"

[model_providers.cmdc-goat]
name = "CommandCode GOAT"
base_url = "http://localhost:5411/v1"
wire_api = "responses"
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
export OPENAI_MODEL=deepseek-v4-flash
```

> `base_url` 需要带 `/v1` 后缀。Codex 会请求 `POST /v1/responses`；cmc-proxy 内置 **Responses ↔ Chat Completions 协议转换**（因为 commandcode 上游只提供 chat/completions 端点），流式与工具调用均支持。

## 模型说明

GOAT 订阅**不包含 Claude 全系**（Sonnet 需 Pro、Opus 需 Provider），也不含 GPT-5.5 及以下。实测可用的模型（2026-08）：

| 模型 ID | 说明 |
|---|---|
| `deepseek/deepseek-v4-flash` | **默认模型**，DeepSeek V4，速度快性价比高 |
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro |
| `gpt-5.6-sol` | GPT 编码/智能体能力强，Codex 系 |
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

### 模型匹配规则

客户端请求的模型名会依次按以下规则解析（`proxy.js` 的 `resolveModel` helper）：

1. **显式映射表** `modelMap`：`claude-*`、`gpt-5.x-codex` 等已内置映射。
2. **上游模型目录匹配**：精确匹配 → 大小写不敏感匹配 → **无前缀名匹配**（如 `deepseek-v4-flash` → `deepseek/deepseek-v4-flash`、`qwen3.8-max` → `Qwen/Qwen3.8-Max`）。
3. **无任何匹配** → fallback 到 `defaultModel`（`deepseek/deepseek-v4-flash`）。

因此本地客户端（尤其 Claude Code）可以直接用**不带前缀**的模型名，例如 `/model` 输入 `deepseek-v4-flash`、`kimi-k2.7-code` 等，都会被自动映射。

## 原理

```
Claude Code ──Anthropic /v1/messages──▶ cmc-proxy:5411
Codex ──────Responses /v1/responses──▶  │
OpenAI 客户端 ──chat /v1/chat/completions──▶ │  协议转换 + 模型映射 + Key 注入
                                              ▼
                              https://api.commandcode.ai/provider/v1/*
```

- `/v1/messages` 收到 `claude-*` 模型名 → 转换请求为 OpenAI 格式 → 请求上游 `/chat/completions`（用映射后的模型）→ 把流式/非流式响应转回 Anthropic SSE / JSON，包含 `tool_use` / `input_json_delta` 工具事件。
- 收到非 Claude 模型名 → 直接透传上游 `/messages`（预留 Pro/Provider 升级后使用真实 Claude 模型）。
- `/v1/responses`（Codex `wire_api="responses"`）→ 转换 Responses 请求为 chat/completions → 上游响应转回 Responses SSE 事件（`response.created` → `output_text.delta` / `function_call_arguments.delta` → `response.completed`），含工具调用。
- `/v1/chat/completions`、`/v1/models`、`/v1/*` 其他路径 → 原样透传，仅注入 Key 与模型映射。

## 访问日志

每个请求打印**两行日志**：`REQ` 行记录本地客户端发来的请求，`RES` 行记录外部上游返回的结果，便于对照感知请求与返回：

```
[20:15:55.877] REQ POST /v1/messages src=127.0.0.1 ua=claude-cli/2.0.0 model=deepseek-v4-flash→deepseek/deepseek-v4-flash stream=1 body=186.5KB
[20:15:58.232] RES 200 POST /v1/messages model=deepseek-v4-flash→deepseek/deepseek-v4-flash took=2.35s out=1736B in:1234 out:567 rt:480 cr:890 cw:0 ts:241.3/s
[20:15:58.822] REQ POST /v1/chat/completions src=127.0.0.1 ua=codex/1.0.0 model=gpt-5.6-sol stream=0 body=88B
[20:16:00.510] RES 200 POST /v1/chat/completions model=gpt-5.6-sol took=1.69s out=567B in:987 out:45 cr:0 cw:0 ts:26.6/s
```

字段说明：

| 字段 | 含义 |
|---|---|
| `REQ` / `RES` | 本地请求到达 / 外部返回完成 |
| `status` / `method` / `path` | HTTP 状态码、方法与路径（`RES` 行含状态码） |
| `src` | 客户端 IP（仅 `REQ` 行） |
| `ua` | 客户端 User-Agent（`claude-cli/*` 即 Claude Code，`codex/*` 即 Codex） |
| `model` | 请求模型 → 实际转发的上游模型（`→` 表示发生了模型映射） |
| `stream` | 是否为流式请求（1 流式 / 0 非流式，仅 `REQ` 行） |
| `body` | 请求体大小（仅 `REQ` 行；用于区分两条请求是否完全相同：工具循环的请求体会递增，客户端重试的请求体一致） |
| `took` | 总耗时（含上游推理时间，仅 `RES` 行） |
| `out` | 响应输出字节数（仅 `RES` 行） |
| `in:` / `out:` | 输入 / 输出 tokens。**`in:` 为净输入**（已扣除缓存命中部分，即按原价计费的量；流式与非流式、转换与透传路径均解析；上游未返回时缺省） |
| `rt:` | 思考 tokens（`reasoning_tokens`，DeepSeek 系常见，已包含在 `out:` 中，仅上游返回时出现） |
| `cr:` / `cw:` | 缓存读取（`cached_tokens`） / 缓存写入（`cache_creation_input_tokens`） tokens，命中缓存可大幅省钱。`in:` + `cr:` = 总输入 |
| `ts:` | 生成速度：`输出 tokens ÷ 总耗时`（含上游推理；仅 `RES` 行、上游返回 usage 且耗时 ≥200ms 时出现）。按速度**波段着色**：<20 红 / 20–39 橙 / 40–59 黄 / 60–79 绿 / ≥80 亮绿 |

> 流式请求上游默认不返回 usage，需请求体带 `stream_options: {"include_usage": true}` —— Claude Code / Codex 转换路径已自动带上；直接调用 `/v1/chat/completions` 的客户端需自行加该参数才能在日志中看到用量。

### 用量统计（STATS 三行）

每 **10 个请求**打印三行汇总（跨天自动先打印上日汇总；频率可用环境变量 `CMC_STATS_EVERY` 调整）：

```
[20:16:30.000] STATS Ten   req:10 in:2.3K out:1.2K rt:900 cr:19.8K cw:0 ch:90% ts:241.3/s
[20:16:30.000] STATS Today req:25 in:56.3K out:12.4K rt:9.1K cr:98.7K cw:0 ch:63% ts:210.1/s
[20:16:30.000] STATS Total req:25 in:56.3K out:12.4K rt:9.1K cr:98.7K cw:0 ch:63% ts:210.1/s
```

| 行 | 范围 |
|---|---|
| `Ten` | 最近 10 个请求（滚动窗口） |
| `Today` | 当天累计（按自然日） |
| `Total` | 进程启动以来累计 |

| 字段 | 含义 |
|---|---|
| `req` | 累计请求数 |
| `in` / `out` | 累计净输入 / 输出 tokens（数字超 1K/1M 自动缩写） |
| `rt` | 累计思考 tokens（已含在 out 内） |
| `cr` / `cw` | 累计缓存读取 / 写入 tokens |
| `ch` | 平均缓存命中率 = `cr ÷ (in + cr)`，**波段色**：<60 红 / 60–79 橙 / 80–89 黄 / 90–94 绿 / 95–97 亮绿 / ≥98 亮青 |
| `ts` | 平均生成速度（tokens/s），**波段色**与 RES 行 `ts:` 相同（<20 红 / 20–39 橙 / 40–59 黄 / 60–79 绿 / ≥80 亮绿） |

> 统计为内存态，进程重启后清零。

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
