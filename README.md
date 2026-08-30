# cmc-proxy — commandcode GOAT 订阅本地反代网关

![version](https://img.shields.io/badge/version-v1.1.0-blue)
![stars](https://img.shields.io/github/stars/cwf818/cmc-proxy)
![issues](https://img.shields.io/github/issues/cwf818/cmc-proxy)

把 commandcode 的 Provider API 反代到本机 `127.0.0.1:5411`，让本地 **Claude Code** 和 **Codex** 直接接入你的 GOAT 订阅。

- 零第三方依赖，仅需 Node.js ≥ 18（内置 `fetch`/`ReadableStream`）
- 同时提供 **OpenAI 兼容**（`/v1/chat/completions`，供 Codex）与 **Anthropic 兼容**（`/v1/messages`，供 Claude Code）端点
- 内置 **Anthropic ↔ OpenAI 协议转换**：GOAT 订阅不含任何 Claude 模型，Claude Code 的请求会自动转换格式并映射到你配置的模型上（默认 `deepseek/deepseek-v4-flash`），流式 + 工具调用全链路支持
- 内置 **多模型轮换 fallback**：`defaultModels` 数组按序轮换，首个模型连续失败 3 次自动切换下一个，后续模型失败 1 次即切换（不重试），全部轮完循环回第一个；计数按模型归属（显式请求其他模型的失败不计入轮换）；可用 `fallback` 开关关闭
- **前缀缓存优化**：注入提醒剥离、易变计数器取整、`cache_control` 透传、会话缓存亲和——同会话 Claude Code / Codex 的上游前缀缓存可稳定在 95%+；RES 行内置前缀分叉探测（`pfx~` 标记）可定位缓存失效来源
- **Codex 新协议全兼容**：`custom`（apply_patch freeform）/ `tool_search`（延迟工具发现）/ `namespace` 工具组 / 顶层 `function_call` 历史等新形态全链路支持
- 支持流式 SSE 透传、token 用量上报、模型列表过滤、分级请求落盘（环境变量 `CMC_LOGGING_FILE`）

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
# 不设置 ANTHROPIC_MODEL 时使用默认模型（defaultModels 首个，出错自动轮换）
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
| `deepseek/deepseek-v4-flash` | **默认模型**，DeepSeek V4 Flash，速度快性价比高 |
| `deepseek/deepseek-v4-flash-vision-exp` | DeepSeek V4 Flash Vision（实验版，支持视觉） |
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro |
| `z-ai/glm-5.3-flash` | 智谱 GLM-5.3 Flash |
| `Qwen/Qwen3.8-27B` | 阿里 Qwen 3.8 27B |
| `xiaomi/mimo-v2.5` | 小米 MiMo V2.5 |
| `gpt-5.6-sol` | GPT 编码/智能体能力强，Codex 系 |
| `moonshotai/Kimi-K2.7-Code` / `moonshotai/Kimi-K3` | Kimi 编码系 |
| `zai-org/GLM-5.3` / `zai-org/GLM-5.2` | 智谱 GLM |
| `Qwen/Qwen3.8-Max` / `Qwen/Qwen3.7-Flash` | 阿里 Qwen |
| `MiniMaxAI/MiniMax-M3` | MiniMax |
| `xai/grok-4.6` | Grok |
| `xiaomi/mimo-v2.5-pro` | 小米，限时高折扣 |
| `tencent/hy3-paid` | 腾讯 |

- 完整列表：`curl http://127.0.0.1:5411/v1/models`（已过滤 GOAT 不可用模型，`?raw=1` 看全量）。
- 换模型：改 `config.json` 的 `defaultModels`（数组，第一个为默认模型），或在 `modelMap` 里把特定模型名映射到目标模型后重启。
- GOAT 按订阅额度计费，模型实际可用性以上游返回为准。

### 多模型轮换（fallback）

`config.json` 的 `defaultModels` 是**数组**，第一个模型作为默认模型：

```json
{
  "fallback": true,
  "defaultModels": [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-flash-vision-exp",
    "z-ai/glm-5.3-flash",
    "Qwen/Qwen3.8-27B",
    "xiaomi/mimo-v2.5"
  ]
}
```

轮换规则（全局生效，跨请求累计，**计数按模型归属**）：

1. **首个模型**（`defaultModels[0]`）是默认模型；连续失败 **3 次**后切换到下一个。
2. **后续 fallback 模型不重试**：失败 **1 次**即切换到下一个。
3. **循环进行**：列表全部轮完后回到第一个模型，重新累计。
4. **按模型归属计数**：客户端显式请求其他模型（如 `blockedModels` 中被上游 403 的模型）的失败**不会**记到当前默认模型头上触发无谓轮换；成功清零同理仅对当前默认模型生效。

"失败"指上游返回非 2xx（如 `MODEL_NOT_IN_PLAN`、5xx、429）或网络层错误；切换仅影响**下一次**请求使用的默认模型，当前失败请求仍按原样返回错误给客户端。切换时会打印日志：

```
[cmc-proxy] 模型 deepseek/deepseek-v4-flash 连续失败 3 次, 默认模型切换 → deepseek/deepseek-v4-flash-vision-exp
```

`fallback: false` 时关闭轮换，始终使用 `defaultModels[0]`。旧配置中的 `defaultModel` 字段仍兼容（视为单元素列表）。

### 模型匹配规则

客户端请求的模型名会依次按以下规则解析（`proxy.js` 的 `resolveModel` helper）：

1. **显式映射表** `modelMap`：`claude-*`、`gpt-5.x-codex` 等已内置映射。
2. **上游模型目录匹配**：精确匹配 → 大小写不敏感匹配 → **无前缀名匹配**（如 `deepseek-v4-flash` → `deepseek/deepseek-v4-flash`、`qwen3.8-max` → `Qwen/Qwen3.8-Max`）。
3. **无任何匹配** → fallback 到 `defaultModels` 当前活动模型（默认是第一个）。

因此本地客户端（尤其 Claude Code）可以直接用**不带前缀**的模型名，例如 `/model` 输入 `deepseek-v4-flash`、`kimi-k2.7-code` 等，都会被自动映射。

## 缓存优化（前缀缓存友好转换）

DeepSeek 等上游的前缀缓存要求**同会话请求的消息前缀逐字节一致**。反代在转换层做了以下保障，默认全部开启：

| 开关（config.json） | 默认 | 作用 |
|---|---|---|
| `stripSystemReminders` | `true` | 整条剥离 Claude Code 2.1.251+ 注入到 `messages` 里的 `role:"system"` 提醒（`<total_tokens>` 配额计数、任务工具催促）——数值随轮次回溯改写，是前缀缓存失效的元凶。仅提示性内容，不影响编码能力，CC 下一轮会重新注入；顶层 `system`（系统提示词 + CLAUDE.md）原样保留 |
| `stabilizeCounters` | `true` | 文本中 `<total_tokens>N tokens left</total_tokens>` 计数就近取整到 100 万（`14977212` → `15000000`），使回溯改写前后字节一致；作为剥离的兜底（防计数出现在其他位置） |
| `cacheControlPassthrough` | `true` | Anthropic `cache_control` 标记透传为 OpenAI content part（对支持显式缓存的后端生效，已验证不影响本上游的缓存键） |
| `cacheAffinity` | `true` | 按会话注入稳定 `user` / `prompt_cache_key`（Claude Code 取会话 UUID，Codex 透传其自带值），便于上游按会话做缓存路由 |
| `CMC_LOGGING_FILE`（环境变量） | 未设置 | 请求落盘分级：`0`/未设置 关闭；`1` 严重事件（上游失败/超时、客户端中途断开）；`2` 1 + 前缀分叉时落盘该请求（client/upstream 双 body）；`3` 全部模型类请求。写入 `fulllog.log`，分叉/失败条目带标注；日志会持续增长，注意清理 |
| `serializeSessionRequests` | `true` | 同会话上游请求**串行发送**：CC 的会话标题探测请求（4KB，自动起名）与主请求毫秒级并发到达时，中转侧出现过主请求长时间无响应头悬挂；串行化规避并发，排队中的请求若客户端断开会立即出队 |
| `firstByteTimeout` | `120000` | 上游超过该毫秒数未返回响应头时主动中止并返回 502（`0` 关闭）。替代 undici 隐性的 300s 黑盒超时，悬挂请求 2 分钟内可见明确错误 |

配套的**前缀分叉探测**：RES 行在检测到与该会话上一次请求相比前缀发生变化时输出红色标记——`pfx~N`（第 N 条消息变化，索引含 system）、`pfx~tools`（工具定义变化）、`pfx~params`（顶层参数变化，附字段名）、`pfx<N`（历史变短，压缩）；纯追加（健康）不输出。同时打印一行分叉内容预览（新旧 JSON 各截 110 字符），可直接看出客户端改写了什么。前缀纯追加时同会话缓存应稳定在 95%+；若出现 `pfx~` 标记即该位置之后本轮必然后缀缓存失效。

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

每个请求打印**两行日志**：`REQ` 行记录本地客户端发来的请求，`RES` 行记录外部上游返回的结果，便于对照感知请求与返回。时间后跟 **`S会话#请求` 标签**（如 `S1#10` = 1 号会话的第 10 个请求），按稳定会话标识区分本地 agent 进程并自增分配；REQ 与 RES 两行标签相同即同一请求的请求与响应。**标签按请求轮换取色**，同一请求两行同色以便配对，相邻请求颜色轮转更易区分；`REQ` 字样恒为青色：

```
[20:15:55.877] S3#1 REQ POST /v1/messages model=deepseek-v4-flash src=127.0.0.1:54321 ua=claude-cli/2.0.0 stream=1 body=186.5KB
[20:15:58.232] S3#1 200 POST /v1/messages model=deepseek/deepseek-v4-flash took=2.35s out=1736B in:1234 out:567 rt:480 cr:890 cw:0 ch:87% ts:241.3/s
[20:15:58.822] S5#7 REQ POST /v1/chat/completions model=gpt-5.6-sol src=127.0.0.1:48721 ua=codex/1.0.0 stream=0 body=88B
[20:16:00.510] S5#7 200 POST /v1/chat/completions took=1.69s out=567B in:987 out:45 cr:0 cw:0 gap:10 ch:40% ts:26.6/s
```

字段说明：

| 字段 | 含义 |
|---|---|
| `REQ` / `RES` | 本地请求到达 / 外部返回完成。`REQ*`（红色 `*`）表示该请求到达时同会话已有在途请求，正在串行队列中等待发送上游 |
| `S会话#请求` | 标签 = **会话编号 + 请求编号**（如 `S1#10`）。会话编号**优先按 `x-claude-code-session-id`**（Claude Code 每个会话唯一的 UUID）→ **`session-id`**（Codex 0.147+ 每请求携带，兼容旧版 `session_id` 下划线头名）→ **`thread-id`**（Codex 对话线程，`codex resume` 后不变）→ 回退 `src:端口 + ua` 近似区分，同一会话跨 TCP 重连不换号；请求编号为会话内自增的请求计数器，两行编号相同即同一请求的请求行与响应行，用于在并发/交错日志中配对 REQ 与 RES。仅 model 类请求（`/v1/messages`、`/v1/chat/completions`、`/v1/responses`）计入会话，非 model 请求（健康检查等）无标签 |
| `status` / `method` / `path` | HTTP 状态码、方法与路径（`RES` 行含状态码） |
| `src` | 客户端 IP:源端口（仅 `REQ` 行；端口用于区分同 ua 的不同进程/连接） |
| `ua` | 客户端 User-Agent（`claude-cli/*` 即 Claude Code，`codex/*` 即 Codex） |
| `model` | 仅 `REQ` 行显示**本地请求的模型名**（如 `deepseek-v4-flash`）；`RES` 行只在**实际转发的模型名与本地名不同**时显示转发名（如 `deepseek/deepseek-v4-flash`），字符串相同时省略 —— 两行对照即知映射关系。**按模型名字符串哈希着色**：同模型恒同色、不同模型尽量异色，扫日志时可按颜色快速归类模型 |
| `stream` | 是否为流式请求（1 流式 / 0 非流式，仅 `REQ` 行） |
| `body` | 请求体大小（仅 `REQ` 行；用于区分两条请求是否完全相同：工具循环的请求体会递增，客户端重试的请求体一致） |
| `took` | 上游耗时：从**真正发往上游**起算到响应完成（排队等待不计入，与 provider 侧 API 耗时对齐，仅 `RES` 行） |
| `qwait:` | 排队等待时长：同会话串行化时在本请求之前等待的时间，超过 0.5s 才显示；`took + qwait ≈ 总耗时` |
| `out` | 响应输出字节数（仅 `RES` 行） |
| `in:` / `out:` | 输入 / 输出 tokens。**`in:` 为净输入**（已扣除缓存命中部分，即按原价计费的量；流式与非流式、转换与透传路径均解析；上游未返回时缺省） |
| `rt:` | 思考 tokens（`reasoning_tokens`，DeepSeek 系常见，已包含在 `out:` 中，仅上游返回时出现） |
| `cr:` / `cw:` | 缓存读取（`cached_tokens`） / 缓存写入（`cache_creation_input_tokens`） tokens，命中缓存可大幅省钱。`in:` + `cr:` = 总输入 |
| `gap:` | **低缓存间隔**：仅当本次缓存命中率 `cr ÷ (in + cr)` < 50% 时输出，值为本次与**该会话最近一次**低缓存命中请求的**请求序号差**（会话内序号只对有 usage 的请求递增）。会话内**首次**低缓存只记录基准、不输出 `gap` |
| `pfx~` | **前缀分叉标记**（红色，详见「缓存优化」章节）：`pfx~N` 该会话上一次请求的第 N 条消息与本次不同（索引含 system，`pfx~1` 即首条 user 消息）、`pfx~tools` 工具定义变化、`pfx~params` 顶层参数变化（附字段名）、`pfx<N` 历史变短（压缩）。分叉处之后本轮必然无法命中前缀缓存；纯追加（健康）不输出，同时会单独打印一行分叉内容预览 |
| `ts:` | 生成速度：`(输出 + 思考) tokens ÷ 总耗时`（含上游推理；仅 `RES` 行、上游返回 usage 且耗时 ≥200ms 时出现）。按速度**波段着色**：<20 红 / 20–39 橙 / 40–59 黄 / 60–79 绿 / ≥80 亮绿 |

> 流式请求上游默认不返回 usage，需请求体带 `stream_options: {"include_usage": true}` —— Claude Code / Codex 转换路径已自动带上；直接调用 `/v1/chat/completions` 的客户端需自行加该参数才能在日志中看到用量。

### 用量统计

**1. 滚动统计（每次请求输出）**

每次请求完成时，在 `RES` 行末尾追加：`ch`（**会话累计**缓存命中率）+ `ts`（最近 1 / 10 / 50 次请求的滚动速度）。**仅在本次请求为 200 且解析到 usage（输出 `in:/out:/rt:/cr:/cw:`）时追加**，无 usage 的请求（如健康检查、未返回用量的透传）不显示：

```
[20:16:30.000]#3 200 POST /v1/messages took=2.35s out=1736B in:1234 out:567 rt:480 cr:890 cw:0 gap:10 ch:87% ts:33/s,40/s,50/s
```

- `ch:` 为**会话累计**命中率（该会话所有有 usage 请求的 `cr ÷ (in + cr)`），单值输出——同会话正常工作时应稳定在 95%+；若长期偏低，结合 `pfx~` 标记定位前缀分叉来源
- `ts:` 值个数随历史请求数变化：**1 次显示 1 值 → 2–10 次显示 2 值 → ≥11 次显示 3 值**（第 1 个 = 最近 1 次，第 2 个 = 最近 10 次，第 3 个 = 最近 50 次，仅计入有 usage 的请求）
- `gap:` 出现在 `ch` 之前：仅当**本次**缓存命中率 < 50% 时输出，值为与同会话最近一次低缓存命中请求的序号差（首次低缓存只记录基准、不输出）

| 字段 | 含义 |
|---|---|
| `gap` | 两次 `cachehit < 50%` 请求的**序号差**（会话内、仅计有 usage 的请求），如 `gap:10` 表示距上一次低缓存命中间隔了 10 次有效请求。红色高亮，便于快速定位低缓存频率 |
| `ch` | 会话累计缓存命中率 = `cr ÷ (in + cr)`，**波段色**：<60 红 / 60–79 橙 / 80–89 黄 / 90–94 绿 / ≥95 亮绿 |
| `pfx~` | 前缀分叉标记（红色，见「缓存优化」章节） |
| `ts` | 生成速度（(输出+思考) tokens/s，滚动窗口），**波段色**：<20 红 / 20–39 橙 / 40–59 黄 / 60–79 绿 / ≥80 亮绿 |

> 波段色按逗号分段：逗号跟随其后的数值一起着色（如 `ts:33/s`、`,40/s`、`,50/s` 各自独立着色）。

**2. TOD / ALL 累计（每 10 个请求打印）**

```
[20:16:30.000] STATS TOD req:25 in:56.3K out:12.4K rt:9.1K cr:98.7K cw:0 ch:63% ts:210.1/s
[20:16:30.000] STATS ALL req:25 in:56.3K out:12.4K rt:9.1K cr:98.7K cw:0 ch:63% ts:210.1/s
```

| 行 | 范围 | 说明 |
|---|---|---|
| `TOD` | 当天累计（按自然日） | 跨天自动先打印上日汇总 |
| `ALL` | 进程启动以来累计 | **当天启动时与 TOD 一致，自动省略** |

- 字段含义与 RES 行统计相同；数字超 1K/1M 自动缩写
- 打印频率可用环境变量 `CMC_STATS_EVERY` 调整（默认 10）
- 统计为内存态，进程重启后清零

## 常见问题

**端口被占用**
```powershell
Get-NetTCPConnection -LocalPort 5411 -State Listen | Stop-Process
```
或改 `config.json` 的 `port`。

**请求报 `MODEL_NOT_IN_PLAN`** — 该模型 GOAT 订阅不可用。此错误会计入轮换失败次数，连续达阈值后自动切换到 `defaultModels` 中的下一个模型；也可以手动调整 `defaultModels` 或 `modelMap` 映射到可用模型。

**想用真正的 Claude 模型** — 需要升级 Pro/Provider 计划；升级后在 `modelMap` 中把 `claude-*` 映射为真实 Claude 模型名（如 `claude-sonnet-4-6`）即可直连上游 `/messages`。

**流式输出卡住** — 检查网络到 `api.commandcode.ai` 的连通性；可设 `CMC_DEBUG=1` 启动查看上游原始流。

**缓存命中率低** — 看 `RES` 行的 `pfx~` 标记与分叉预览：`pfx~1`/`pfx~2` 等早期消息分叉说明客户端在改写历史（升级 Claude Code 版本后常见）；`pfx~tools` 工具定义变化；无标记但 `cr` 仍低则多为上游/中转侧行为。可设 `CMC_LOGGING_FILE=2` 落盘分叉请求对照排查（`3` 为全部请求）；相关开关见「缓存优化」章节。

## 安全提醒

`config.json` 中的 `apiKey` 是你的订阅凭据，**不要提交到公开仓库**。建议：

```gitignore
config.json
proxy.log
fulllog.log
```

服务默认只监听 `127.0.0.1`，如需局域网共享请改 `config.json` 的 `host` 为 `0.0.0.0` 并自行加鉴权。
