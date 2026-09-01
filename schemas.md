# cmc-proxy 数据流 Schema 参考

本文件对照学习用：完整描述一次请求从 **本地客户端 → cmc-proxy → 上游 API → 返回本地** 各阶段的请求/响应格式与样例。

> 术语约定：
> - **Local Request**：本地客户端（Claude Code / Codex / curl）发到 `127.0.0.1:5411` 的请求
> - **Upstream Request**：cmc-proxy 转发到 `https://api.commandcode.ai/provider` 的请求
> - **Upstream Response**：上游 API 返回给 cmc-proxy 的响应
> - **Local Response**：cmc-proxy 最终返回给本地客户端的响应

---

## 0. 总览：四条转发路径 + 辅助端点

```
路径 A  /v1/chat/completions          OpenAI 格式 ──原样透传──▶ OpenAI 格式          (Codex wire_api=chat / 任意 OpenAI 客户端)
路径 B  /v1/messages                  Anthropic 格式 ──协议转换──▶ OpenAI 格式       (Claude Code, 默认模型走转换)
路径 B′ /v1/messages (Claude 模型)    Anthropic 格式 ──原样透传──▶ Anthropic 格式    (预留 Pro/Provider 直连真实 Claude)
路径 C  /v1/responses                 Responses 格式 ──协议转换──▶ OpenAI 格式       (Codex wire_api=responses)
路径 D  其他 /v1/*                    任意格式 ──原样透传──▶ 同格式                  (通配, 仅注入 Key)
```

辅助端点（不转发上游模型）：

| 端点 | 方法 | 响应 |
|---|---|---|
| `/`、`/health` | GET | `{"ok":true,"service":"cmc-proxy","upstream":"…","port":5411}` |
| `/v1/models` | GET | `{"object":"list","data":[...]}`，按 `blockedModels` 过滤；`?raw=1` 返回全量；上游结果内存缓存 60s |
| `/v1/messages/count_tokens` | POST | `{"input_tokens": N}`，本地估算 = `ceil(JSON.stringify(body).length / 4)`（最小为 1），不转发上游 |
| 其他路径 | 任意 | 404 `{"error":{"message":"Not found: <path>","type":"invalid_request_error"}}` |

> 只有路径 A / B / B′ / C 参与模型决策、失败轮换与会话串行化（所有路径都打 REQ/RES 访问日志，非 model 请求无会话标签）；路径 D 只做 Key 注入与转发。

所有转发路径都会做三件统一的事：
1. **模型决策** `pickModel(requested, isImage)`：请求未带 model → 按请求类型取默认（文本 `defaultModels[0]` / 带图 `defaultVisionModels[0]`）；带了 model → 先查 `modelMap` 显式映射（命中即用，不区分请求类型，置空即关闭），未命中按 `config.resolveModel`（默认 true）目录匹配解析（命中即用，未命中按请求类型回退默认），`resolveModel:false` 时原样向上游请求。目录匹配规则：精确 → 大小写不敏感 → 去 provider 前缀按裸名匹配 → 去 `[*]` 后缀匹配（如 `deepseek-v4-flash[1m]` → `deepseek/deepseek-v4-flash`，视为同模型的不同上下文窗口变体）。之后进入轮换：`switchOnFail` 按请求类型选列表（文本 `defaultModels` / 带图 `defaultVisionModels`），失败 1 次即切换 + `failTTL` 冷却（详见 §7）。
2. **Key 注入**：`buildUpstreamHeaders()` 强制写入 `Authorization: Bearer <apiKey>`（覆盖客户端传的任何值），并保留客户端的 `x-api-key`（若调用方未显式设置同名头）。
3. **客户端断开联动**：`res.on("close")` 会中止上游请求（`AbortController`），打印 `ABT` 行；`CMC_LOGGING_FILE>=1` 时落盘。

另外非流式转换路径与透传路径都会解析上游响应中的 `usage` 输出到访问日志（见 §5）。

### 0.1 各路径的带图（isImage）判定

图片块识别函数 `countImagesDeep()` 深度遍历请求体，识别三种形态：Anthropic `{type:"image", source}`、`{type:"image_url"}`、`{type:"input_image"}`。

| 路径 | `isImage` 判定依据 | 备注 |
|---|---|---|
| A `/v1/chat/completions` | `countImagesDeep(body) > 0` | 请求体原样透传，不做任何图片改写 |
| B `/v1/messages` | 原始请求体 `countImagesDeep(body) > 0`；开启 `cleanHistoryImages` 且本轮无新图时，剥离历史图后**重新判定为文本** | 会决策两次：先用原始判定决定走 B′ 还是 B，再用最终判定决定转换路径的模型 |
| B′ `/v1/messages`（Claude） | 原始请求体 `countImagesDeep(body) > 0` | 仅用于模型决策；轮换时按 `isImage=false` 处理（走 `defaultModels`） |
| C `/v1/responses` | 转换后的 chat messages 含 `image_url` part（`openAIMessagesHaveImages`） | 即 `input_image` 转成 `image_url` 之后判断 |

---

## 1. 路径 A：/v1/chat/completions（纯透传）

除 `model` 名解析与 `Authorization` 注入外，**请求与响应均为原样透传**：Local Request = Upstream Request（仅 model 值可能被映射），Upstream Response = Local Response。

### 1.1 Local Request（= Upstream Request 样例）

```http
POST /v1/chat/completions HTTP/1.1
Host: 127.0.0.1:5411
Content-Type: application/json
Authorization: Bearer sk-local-any-value        # 客户端可随意传, 会被替换
```

```json
{
  "model": "deepseek-v4-flash",                  // 将被映射为 deepseek/deepseek-v4-flash
  "messages": [
    { "role": "system", "content": "You are a coding assistant." },
    { "role": "user", "content": "写一个冒泡排序" }
  ],
  "stream": true,
  "stream_options": { "include_usage": true },   // 流式请求想要 usage 必须带
  "max_tokens": 4096,
  "temperature": 0.2
}
```

> 若客户端不传 `stream_options.include_usage`，上游流式响应将**不返回 usage**，日志里也就没有 `in/out/rt/cr/cw`。

### 1.2 Upstream Request（转发后）

```json
{
  "model": "deepseek/deepseek-v4-flash",         // 唯一的实质变化: model 已映射
  "messages": [ /* 原样 */ ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_tokens": 4096,
  "temperature": 0.2
}
```

### 1.3 Upstream Response（非流式）

```json
{
  "id": "gen_01M0ZDM7N72ZF9GMBHFPE8S690",
  "object": "chat.completion",
  "created": 1787760878,
  "model": "deepseek/deepseek-v4-flash",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hi there! 👋",
      "reasoning": "The user just said hi...",   // DeepSeek 系会把思考内容放在这里(非标准字段, 透传)
      "refusal": null
    },
    "logprobs": null,
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 84,
    "completion_tokens": 32,
    "total_tokens": 116,
    "prompt_tokens_details": { "cached_tokens": 0, "audio_tokens": 0, "video_tokens": 0 },
    "completion_tokens_details": { "reasoning_tokens": 22, "image_tokens": 0 },
    "cache_creation_input_tokens": 0
  }
}
```

### 1.4 Local Response = Upstream Response（逐 chunk 原样透传）

非流式即上面 JSON 原文；流式则为标准 OpenAI SSE（`data: {...}\n\n` 分隔，末尾 `data: [DONE]`），usage 在最后一个 chunk 中，见 §4.1。

上游非 2xx 时原样透传状态码与错误 body；网络层错误（含首字节超时）由 cmc-proxy 返回 502：

```json
{ "error": { "message": "上游请求失败: fetch failed", "type": "api_error" } }
```

> 本路径**不做**任何图片改写（`cleanHistoryImages` / `toolResultImages` 都不生效），图片块随请求体原样上行；`isImage` 仅用于模型决策与轮换列表选择。

---

## 2. 路径 B：/v1/messages（Anthropic → OpenAI 转换）

Claude Code 发送 Anthropic 格式请求；GOAT 订阅无 Claude 模型，cmc-proxy 将请求转换为 OpenAI chat/completions 发给上游，再把上游响应转回 Anthropic 格式。

### 2.1 Local Request（Claude Code 发的 Anthropic messages 请求）

```http
POST /v1/messages HTTP/1.1
Host: 127.0.0.1:5411
Content-Type: application/json
anthropic-version: 2023-06-01
x-api-key: sk-ant-local-any-value
User-Agent: claude-cli/2.0.0
```

```json
{
  "model": "claude-sonnet-4-5",                  // 会被映射为 deepseek/deepseek-v4-flash
  "max_tokens": 4096,
  "stream": true,
  "system": "You are a helpful coding assistant.",
  "messages": [
    { "role": "user", "content": "帮我看看这个报错" },
    { "role": "assistant",
      "content": [
        { "type": "text", "text": "我先搜一下日志。" },
        { "type": "tool_use", "id": "toolu_01", "name": "grep",
          "input": { "pattern": "error", "path": "/src" } }
      ] },
    { "role": "user",
      "content": [
        { "type": "tool_result", "tool_use_id": "toolu_01",
          "content": "src/main.js:12: TypeError" }
      ] }
  ],
  "tools": [
    { "name": "grep", "description": "搜索文件",
      "input_schema": { "type": "object",
        "properties": { "pattern": { "type": "string" } },
        "required": ["pattern"] } }
  ],
  "tool_choice": { "type": "auto" }
}
```

### 2.2 Upstream Request（anthropicToOpenAIRequest 转换后）

```json
{
  "model": "deepseek/deepseek-v4-flash",          // pickModel 决策结果 (modelMap/目录解析/默认)
  "messages": [
    { "role": "system", "content": "You are a helpful coding assistant." },
    { "role": "user", "content": "帮我看看这个报错" },
    { "role": "assistant",                         // tool_use → tool_calls
      "content": "我先搜一下日志。",
      "tool_calls": [{
        "id": "toolu_01",
        "type": "function",
        "function": { "name": "grep", "arguments": "{\"pattern\":\"error\",\"path\":\"/src\"}" }
      }] },
    { "role": "tool",                              // tool_result 拆成独立 tool 消息
      "tool_call_id": "toolu_01",
      "content": "src/main.js:12: TypeError" }
  ],
  "stream": true,
  "stream_options": { "include_usage": true },     // 流式自动注入, 保证能拿到 usage
  "max_tokens": 4096,
  "tools": [{
    "type": "function",
    "function": {
      "name": "grep",
      "description": "搜索文件",
      "parameters": { "type": "object",
        "properties": { "pattern": { "type": "string" } },
        "required": ["pattern"] }
    }
  }]
}
```

**关键映射规则**：

| Anthropic（Local） | OpenAI（Upstream） |
|---|---|
| 顶层 `system`（字符串或块数组） | `messages[0]` 的 `role:"system"`（块数组按 `anthropicBlocksToParts` 1:1 映射为 part 数组，**不折叠成字符串**——折叠会让结构随轮次翻转，破坏前缀缓存） |
| `messages` 里的 `role:"system"` 条目 | **默认整条剥离**（`stripSystemReminders`，Claude Code 2.1.251+ 注入的 `<total_tokens>` 配额计数/任务催促，每轮被回溯改写是缓存失效元凶）；`false` 时提取纯文本保留为 `role:"system"` |
| user 文本 content | `role:"user"`，字符串或 `[{type:"text",text}]` 块数组 |
| user 的 `tool_result` 块 | 拆成独立 `role:"tool"` + `tool_call_id` 消息（同一条 user 消息混合文本会拆开），内容为 `toolResultToText()`：文本拼接、非文本块折叠为 `[<type>]` 占位符 |
| `tool_result` 内嵌的 `image` 块 | **不放进 tool 消息**（上游 tool 消息带图实测 400，vision 模型同样拒绝）。抽出到同轮末尾的 user 消息注入：`[{type:"text",text:"[tool_result <id> 附带的图片]"},{type:"image_url",...}]`；`config.toolResultImages=false` 时改为丢弃（留在 tool 消息里折叠为 `[image]`） |
| user 的 `image` 块（base64/url） | `[{type:"image_url",image_url:{url:"data:<media_type>;base64,<data>"}}]` 或 `{url}` 直传 |
| assistant 文本 | `role:"assistant"` 的 `content`（多个 text 块拼接为字符串；不携带 `cache_control`） |
| assistant 的 `tool_use` 块 | `tool_calls[]`，`arguments` 为 `JSON.stringify(input \|\| {})` |
| `tools[]`（name/description/input_schema） | `tools[]`（`type:"function"`, `function:{name,description,parameters}`） |
| `tool_choice:{type:"tool",name}` / `"auto"` / `"any"` / `"none"` | `{type:"function",function:{name}}` / `"auto"` / `"required"` / `"none"`；顶层字符串 `"auto"`/`"none"` 直通 |
| `max_tokens` | 保留，但**钳制到 ≥16**（部分上游模型要求，Claude Code /model 探测会发 max_tokens=1） |
| `temperature` / `top_p` / `stop_sequences` | `temperature` / `top_p` / `stop` |
| `stream:true` | 自动加 `stream_options:{include_usage:true}` |
| `cache_control`（system/消息块上的 ephemeral 标记） | 透传为 content part 的 `cache_control`（`cacheControlPassthrough`，默认开） |
| 文本中的 `<total_tokens>N tokens left</total_tokens>` | `stabilizeVolatileText()` 就近取整到百万（`14977212` → `15000000`） |
| 会话标识（Claude Code 会话 UUID） | `cacheAffinity` 开启时注入顶层 `user`（>64 字符时截断为 `cc-<前56字符>`） |

> **进入本路径的条件**：`pickModel()` 决策出的模型**不是** Claude 系（`isClaudeModel()` = `/^claude(-|$)/`）。决策与轮换顺序见 §0 与 §7。

### 2.2.1 历史图片清理（cleanHistoryImages）

`config.cleanHistoryImages: true` 且本轮（最后一条 user 消息）无新图时，在转换**之前**把最后一条 user 消息之前的所有图片块**原位替换**为占位文本：

```jsonc
// 客户端请求（历史中的第 2 条 user 消息带图，本轮第 3 条 user 消息无图）
{ "role": "user", "content": [
    { "type": "text", "text": "看看这张截图" },
    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBORw0…" } }
] }
```
```jsonc
// stripHistoryImages() 之后（原块位置替换，结构与条数不变）
{ "role": "user", "content": [
    { "type": "text", "text": "看看这张截图" },
    { "type": "text", "text": "[历史图片已清理]" }      // 原 image 块: type 改 text, 删除 source
] }
```

- 同时处理 `tool_result` 内嵌的 image 块：替换为 `{type:"text", text:"[历史图片已清理]"}`
- 替换**确定性**：同一段历史每轮剥出逐字节一致的结果，不破坏前缀缓存
- 代价：历史图片内容对模型不可见（视觉轮次看到的图，后续文本轮次不再可见）
- **已知限制**：文本链路用 `[历史图片已清理]`，而 `tool_result` 折叠用的是 `[image]`（§2.2 表格）。带图轮次的图在下一轮变成占位文本时，该条消息内容必然与上一轮不同 → RES 行触发一次 `pfx~N` 分叉
- 仅 `/v1/messages` 转换链路生效；`/v1/chat/completions`、`/v1/responses` 不清理

**带图请求路由与轮换**（上游 `/chat/completions` 的 A/B/C 三条链路共用；B′ 直连 `/messages` 时按文本列表 `defaultModels` 轮换）：请求按类型分为文本/带图两种。`config.switchOnFail`（支持布尔或 `{text, image}` 对象，单布尔统一取值）为 true 时，失败 1 次即切换 + TTL 冷却（`config.failTTL`）轮换：文本请求按 `defaultModels` 轮换，带图请求按 `defaultVisionModels` 轮换（图片不支持的报错是 400，因此带图请求 400 也轮换），失败模型在 TTL 内冷却跳过，全部模型在冷却期时直接返回上游失败结果。**冷却只对回退到默认的模型生效**：用户显式指定模型（`modelMap` / 目录解析命中，未落到回退点）失败不冷却，下次请求仍从它开始（不去猜测其能力）；只有未带 model 或指定模型解析失败回退到 `defaultForType` 的模型失败才进入 TTL 冷却，默认列表内后续候选照常冷却。switchOnFail=false 时不轮换，失败原样返回。REQ 行的 `img=N(新M)` 标记显示请求体中检测到的图片块数，其中 `新M` 为最后一条 user 消息（当前轮）中的新图数（仅本路径计算）。

### 2.3 Upstream Response（OpenAI 非流式）

```json
{
  "id": "gen_01M0ZDKWT2HF0MQQFSWVV2KGYQ",
  "object": "chat.completion",
  "created": 1787760872,
  "model": "deepseek/deepseek-v4-flash",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hi! How can I help you",
      "tool_calls": null
    },
    "logprobs": null,
    "finish_reason": "length"
  }],
  "usage": {
    "prompt_tokens": 84,
    "completion_tokens": 32,
    "total_tokens": 116,
    "prompt_tokens_details": { "cached_tokens": 0 },
    "completion_tokens_details": { "reasoning_tokens": 22 }
  }
}
```

### 2.4 Local Response（openAIToAnthropic 转换后）

```json
{
  "id": "gen_01M0ZDKWT2HF0MQQFSWVV2KGYQ",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-5",                     // 回给客户端的是它请求时的模型名
  "content": [ { "type": "text", "text": "Hi! How can I help you" } ],
  "stop_reason": "max_tokens",                      // 映射: length → max_tokens
  "stop_sequence": null,
  "usage": {
    "input_tokens": 84,                           // 净输入 = prompt_tokens - cached_tokens (本例 cached=0 故不变)
    "output_tokens": 32,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  }
}
```

**响应映射规则**（含工具调用时）：

| OpenAI（Upstream） | Anthropic（Local） |
|---|---|
| `message.content` | `content:[{type:"text", text}]` |
| `message.tool_calls[]` | `content:[{type:"tool_use", id, name, input:JSON.parse(arguments)}]` |
| `finish_reason:"tool_calls"` | `stop_reason:"tool_use"` |
| `finish_reason:"length"` | `stop_reason:"max_tokens"` |
| `finish_reason:"stop"/"end_turn"` | `stop_reason:"end_turn"` |
| `usage.prompt_tokens` | `usage.input_tokens`（**净输入** = in > cr ? in − cr : in，即仅当总输入大于缓存命中才减，与日志 in=in-cr 一致） |
| `usage.completion_tokens` | `usage.output_tokens` |
| `prompt_tokens_details.cached_tokens` | `usage.cache_read_input_tokens` |
| `prompt_tokens_details.cache_creation_input_tokens` | `usage.cache_creation_input_tokens` |

### 2.5 流式：Upstream SSE → Local Anthropic SSE（StreamConverter）

上游 OpenAI 流式 chunk（§4.1）逐块喂给 `StreamConverter`，转成如下 Anthropic SSE 事件序列（每行 `event:` 字段名即 Anthropic 协议事件名）：

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream

event: message_start
data: {"type":"message_start","message":{"id":"gen_xxx","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":84,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi! How can I help"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" you"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":84,"output_tokens":32,"cache_read_input_tokens":0}}

event: message_stop
data: {"type":"message_stop"}
```

工具调用时，上游 `delta.tool_calls[]` 会转成额外的事件（每个工具占一个块 index，arguments 按 `input_json_delta` 增量下发）：

```http
event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"grep","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"pattern\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"error\"}"}}
```

**流式实现要点**（`StreamConverter`）：

- 块索引 `nextBlockIndex` **统一自增**（文本块与工具块共用），修复旧版"文本固定 index 0 + 工具从 0 开始"的冲突
- `message_start.usage.input_tokens` 为**本地估算值**（`estimateInputTokens(body)`）；`message_delta.usage` 带上真实的净输入，是最后能修正客户端用量的机会（Claude Code 按 `input_tokens + cache_read_input_tokens` 统计）
- 上游非 2xx 时**不做转换**：直接 `up.text()` 原样透传上游状态码与错误 body（OpenAI 格式）
- 上游流中途中断：已发出的字节不可撤回，只补 `content_block_stop` / `message_delta` / `message_stop` 收尾并打印 `上游 messages 流中断`
- `CMC_DEBUG=1` 时每个上游 chunk 打到 stderr，前缀 `[DBG-UP-messages]`

---

## 3. 路径 C：/v1/responses（Responses → OpenAI 转换）

Codex（`wire_api="responses"`）发送 Responses 协议请求；上游只有 chat/completions，同样做双向转换。

### 3.1 Local Request（Codex 发的 Responses 请求）

```http
POST /v1/responses HTTP/1.1
Host: 127.0.0.1:5411
Content-Type: application/json
Authorization: Bearer sk-local-any-value
User-Agent: codex-tui/0.147.0
```

> **注意**：真实 Codex（≥0.147）把 `function_call` / `function_call_output` 作为**顶层 input item** 发送，而不是嵌在 role 消息 content 里。旧版只识别嵌套形态、顶层条目全部被静默丢弃，模型每轮都看不到自己已发起的工具调用与结果 —— 即"Codex 工具带不上"的根因。下面两种形态都支持。

```json
{
  "model": "deepseek-v4-flash",                    // 映射为 deepseek/deepseek-v4-flash
  "instructions": "You are a coding assistant.",
  "input": [
    { "role": "developer", "content": [{ "type": "input_text", "text": "Be concise." }] },
    { "role": "user", "content": [{ "type": "input_text", "text": "看一下这个 bug" }] },
    { "role": "assistant",
      "content": [
        { "type": "output_text", "text": "我先查日志。" },
        { "type": "function_call", "call_id": "call_01", "name": "grep",
          "arguments": "{\"pattern\":\"bug\"}" }
      ] },
    { "type": "function_call", "call_id": "call_01", "name": "grep",       // ← 顶层形态（真实 Codex）
      "arguments": "{\"pattern\":\"bug\"}" },
    { "type": "function_call_output", "call_id": "call_01", "output": "main.js:3: bug" },
    { "type": "custom_tool_call", "call_id": "call_02", "name": "apply_patch", "input": "*** Begin Patch\n…" },
    { "type": "custom_tool_call_output", "call_id": "call_02", "output": "Success." },
    { "type": "additional_tools", "tools": [ { "type": "function", "name": "lazy_tool", "parameters": {} } ] }
  ],
  "tools": [
    { "type": "function", "name": "grep", "description": "搜索文件",
      "parameters": { "type": "object", "properties": {} } },
    { "type": "custom", "name": "apply_patch", "description": "打补丁 (freeform)" },   // freeform 工具
    { "type": "tool_search" },                                                        // nameless 延迟工具发现
    { "type": "namespace", "tools": [ { "type": "function", "name": "mcp_tool", "parameters": {} } ] }
  ],
  "max_output_tokens": 4096,
  "stream": true
}
```

### 3.2 Upstream Request（responsesToChatRequest 转换后）

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [
    { "role": "system", "content": "You are a coding assistant." },              // instructions → 第一条 system
    { "role": "system", "content": "Be concise." },                             // developer 条目 → 独立的第二条 system (不合并)
    { "role": "user", "content": "看一下这个 bug" },
    { "role": "assistant", "content": "我先查日志。",
      "tool_calls": [{ "id": "call_01", "type": "function",
        "function": { "name": "grep", "arguments": "{\"pattern\":\"bug\"}" } }] },
    { "role": "tool", "tool_call_id": "call_01", "content": "main.js:3: bug" }   // function_call_output → tool
  ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_tokens": 4096,
  "tools": [
    { "type": "function", "function": { "name": "grep", "description": "搜索文件", "parameters": {} } },
    { "type": "function", "function": {
        "name": "apply_patch", "description": "",
        "parameters": { "type": "object",
          "properties": { "input": { "type": "string", "description": "The full raw text input for this tool (for patch tools: the complete patch text)." } },
          "required": ["input"] } } },                                          // {type:"custom"} → 单参数 function
    { "type": "function", "function": { "name": "tool_search", "parameters": { … } } },
    { "type": "function", "function": { "name": "mcp_tool", … } }               // namespace 组展开
  ]
}
```

> 上面样例对应 §3.1 的完整请求（省略了 `custom_tool_call` / `tool_search_*` 等历史条目转换出的 `tool_calls` / `tool` 消息，规则见下表）。

**关键映射规则（消息与 input item）**：

| Responses（Local） | OpenAI（Upstream） |
|---|---|
| 顶层 `instructions` | 第一条 `role:"system"` |
| `input` 为字符串 | 一条 `role:"user"` |
| 数组内的裸字符串 | 一条 `role:"user"` |
| user `input_text` | `role:"user"`（单文本 part 折叠为字符串；含图片时为 part 数组） |
| user `input_image` | `{type:"image_url", image_url:{url: image_url \|\| source.url}}`（也是 §0.1 里 `isImage` 的判定依据） |
| user `function_call_output`（嵌套形态） | 拆成 `role:"tool"` + `tool_call_id`（`call_id \|\| id`） |
| assistant `output_text` / `input_text` | `role:"assistant"` 的 `content` |
| assistant 内嵌的 `function_call` | `tool_calls[]` |
| **顶层** `function_call` | 合并进紧邻的前一条 assistant 消息的 `tool_calls[]`（连续多个调用自然聚成一条） |
| **顶层** `function_call_output` | `role:"tool"` + `tool_call_id` |
| `custom_tool_call`（freeform 工具调用历史） | `tool_calls[]`，`arguments` 统一包成 `{"input": "<原文>"}`（与发给模型时的参数形态一致，前缀稳定） |
| `custom_tool_call_output` | `role:"tool"` + `tool_call_id` |
| `tool_search_call` | `tool_calls[]`，名为 `tool_search`、`arguments` 原样序列化 |
| `tool_search_output` | `role:"tool"`，内容为匹配到的工具定义 JSON 逐行拼接（无匹配时为 `(no tools matched)`）——中途无法再追加 `tools` 参数，改为文本化给模型阅读 |
| `role:"developer"` / `"system"` | `role:"system"`（与 `instructions` **各自独立成条**，不合并） |
| `reasoning` | **跳过**（自定义模型无对应概念） |
| `additional_tools` 条目 | 收集其 `tools[]`，合并进请求 `tools` 并按名去重 |
| `item_reference`、`local_shell_call`、`computer_call` 等保留类型 | 跳过并打印一次性告警（`跳过不支持的 Responses input item 类型: X`） |
| `max_output_tokens` | `max_tokens`（钳制 ≥16） |
| `parallel_tool_calls` | 原样透传（仅 `true`/`false`） |
| `prompt_cache_key` | `cacheAffinity` 开启时透传为 `prompt_cache_key`，长度 ≤64 时同步写入 `user` |
| `stream:true` | 自动加 `stream_options:{include_usage:true}` |

**关键映射规则（工具定义）**：

| Responses `tools[]` 形态 | OpenAI（Upstream） |
|---|---|
| `{type:"function"}` 或嵌套 `{type:"function", function:{…}}` | `{type:"function", function:{name,description,parameters}}`（无 name 跳过并告警） |
| `{type:"custom", name}`（freeform / apply_patch grammar） | 转成单参数 function：`{type:"function", function:{name, parameters:{type:"object", properties:{input:{type:"string"}}, required:["input"]}}}`。回传时还原为 `custom_tool_call`（codex 的 apply_patch handler 只接受 Custom payload，收到 `function_call` 直接报 "unsupported payload"） |
| `{type:"tool_search"}`（nameless 延迟工具发现） | 转成同名 function `tool_search`（无 `parameters` 时用默认 `{query, limit}`）；codex 对名为 `tool_search` 的 FunctionCall 走本地执行器，打通 deferred 工具加载 |
| `{type:"web_search"}`（nameless） | **静默跳过**（中转链路无服务端执行环境），打印一次性告警 |
| `{type:"namespace", tools:[…]}`（工具组） | 展开为独立工具逐个转换 |
| `tool_choice:{type:"function",name}` | `{type:"function",function:{name}}`；`"auto"` / `"required"` / `"none"` 直通 |

> 工具去重按 `addedToolNames`：顶层定义优先，历史中 `additional_tools` 内联的附加定义同名只取一次。`customToolNames`（本请求中转成 function 的 freeform 工具名集合）会一路带到响应转换，用于还原 `custom_tool_call`。

### 3.3 Upstream Response

与 §2.3 相同（OpenAI chat.completion 格式），不再重复。

### 3.4 Local Response（chatResponseToResponses 转换后，非流式）

```json
{
  "id": "resp_mtaanxykzl6q8j",
  "object": "response",
  "created_at": 1787760872,
  "model": "deepseek-v4-flash",                    // 回给 Codex 的是它请求的模型名
  "status": "completed",
  "output": [
    { "type": "message", "id": "msg_mtaanxykgfd0rn", "status": "completed",
      "role": "assistant",
      "content": [{ "type": "output_text", "text": "Hi! How can I help you today?", "annotations": [] }] },
    { "type": "function_call", "id": "fc_xxx", "status": "completed",
      "call_id": "call_01", "name": "grep", "arguments": "{\"pattern\":\"bug\"}" }
  ],
  "usage": {
    "input_tokens": 84,                             // 注意: Responses 侧是总输入(未扣缓存), 缓存量在 details 里
    "output_tokens": 35,
    "total_tokens": 119,
    "input_tokens_details": { "cached_tokens": 0 },
    "output_tokens_details": { "reasoning_tokens": 24 }
  },
  "output_text": "Hi! How can I help you today?"
}
```

**响应映射**（`chatMessageToResponsesOutput` / `chatUsageToResponses`）：

| OpenAI（Upstream） | Responses（Local） |
|---|---|
| `message.content` | `output:[{type:"message", id, status:"completed", role:"assistant", content:[{type:"output_text", text, annotations:[]}]}]` |
| `message.tool_calls[]`（普通工具） | `output:[{type:"function_call", id, status:"completed", call_id, name, arguments}]` |
| `message.tool_calls[]`（命中 `customToolNames`） | `output:[{type:"custom_tool_call", id, status:"completed", call_id, name, input:"<补丁原文>"}]` |
| `usage` | `input_tokens`（**总输入**）、`output_tokens`、`total_tokens`、`input_tokens_details.cached_tokens`、`output_tokens_details.reasoning_tokens` |

> **freeform 工具参数还原** `customInputFromArguments()`：兼容三种模型输出形态 —— `{"input":"…"}` JSON、纯 JSON 字符串、裸补丁文本；并兜底处理模型在 JSON 字符串里直接输出真实换行（严格 JSON 非法）的情况（正则提取 + 反转义）。
> **与 Anthropic 路径的差异**：Responses 的 `input_tokens` 是**总输入**（缓存命中量只在 `input_tokens_details.cached_tokens`），而 Anthropic 路径的 `input_tokens` 是**净输入**（已扣缓存）——这是两条链路各自的协议口径，访问日志统一按净输入显示 `in:`。

上游非 2xx 时不做转换，原样透传上游状态码与错误 body；网络层错误返回 502 `{"error":{"message":"上游请求失败: …","type":"api_error"}}`。

### 3.5 流式：Upstream SSE → Local Responses SSE（ResponsesStreamConverter）

事件序列（`data:` 格式，无 `event:` 行）：

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream

data: {"type":"response.created","response":{"id":"resp_xxx","object":"response","created_at":1787760872,"model":"deepseek-v4-flash","status":"in_progress","output":[]}}

data: {"type":"response.in_progress","response":{...同上...}}

data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_xxx","type":"message","status":"in_progress","role":"assistant","content":[]}}

data: {"type":"response.content_part.added","item_id":"msg_xxx","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}

data: {"type":"response.output_text.delta","item_id":"msg_xxx","output_index":0,"content_index":0,"delta":"Hi! How can"}

data: {"type":"response.output_text.delta","item_id":"msg_xxx","output_index":0,"content_index":0,"delta":" I help"}

data: {"type":"response.output_text.done","item_id":"msg_xxx","output_index":0,"content_index":0,"text":"Hi! How can I help"}

data: {"type":"response.content_part.done","item_id":"msg_xxx","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hi! How can I help","annotations":[]}}

data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_xxx","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hi! How can I help","annotations":[]}]}}

data: {"type":"response.completed","response":{"id":"resp_xxx","object":"response","created_at":1787760872,"model":"deepseek-v4-flash","status":"completed","output":[{"id":"msg_xxx","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hi! How can I help","annotations":[]}]}],"usage":{"input_tokens":84,"output_tokens":35,"total_tokens":119}}}
```

工具调用时插入（`delta.tool_calls[]` 驱动）：

```http
data: {"type":"response.output_item.added","output_index":1,"item":{"id":"fc_xxx","type":"function_call","status":"in_progress","call_id":"call_01","name":"grep","arguments":""}}

data: {"type":"response.function_call_arguments.delta","item_id":"fc_xxx","output_index":1,"delta":"{\"pattern\":"}

data: {"type":"response.function_call_arguments.delta","item_id":"fc_xxx","output_index":1,"delta":"\"bug\"}"}

data: {"type":"response.function_call_arguments.done","item_id":"fc_xxx","output_index":1,"arguments":"{\"pattern\":\"bug\"}"}

data: {"type":"response.output_item.done","output_index":1,"item":{"id":"fc_xxx","type":"function_call","status":"completed","call_id":"call_01","name":"grep","arguments":"{\"pattern\":\"bug\"}"}}
```

`finish_reason:"length"` 时，结尾事件为 `response.incomplete` 而非 `response.completed`。

**流式实现要点**（`ResponsesStreamConverter`）：

- **freeform（custom）工具不流式下发 `input`**：模型产出的是 `{"input": …}` 的 JSON 片段，直接转发会污染 codex 的流式补丁解析器（它期望纯补丁文本）。因此 custom 工具只发 `output_item.added`，参数统一在 `output_item.done` 里用 `customInputFromArguments()` 补全（也不发 `function_call_arguments.delta` / `.done`）
- 文本与工具 item 的 `output_index` 按 `resp.output` 长度自增分配
- 上游非 2xx 不转换，原样透传；上游流中断只补 done 事件收尾
- `CMC_DEBUG=1` 时上游 chunk 打到 stderr，前缀 `[DBG-UP-responses]`

---

## 4. 流式 SSE 原始格式

### 4.1 上游 OpenAI 流式 chunk（路径 A/B/C 的 Upstream Response）

`data: {json}\n\n` 分隔；文本内容增量、工具参数增量、结尾 usage chunk 三态：

```http
data: {"id":"gen_xxx","object":"chat.completion.chunk","created":1787760738,"model":"deepseek/deepseek-v4-flash","choices":[{"index":0,"delta":{"content":"Hi"},"logprobs":null,"finish_reason":null}]}

data: {"id":"gen_xxx","object":"chat.completion.chunk","created":1787760738,"model":"deepseek/deepseek-v4-flash","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_01","type":"function","function":{"name":"grep","arguments":"{\"pa"}}]},"logprobs":null,"finish_reason":null}]}

data: {"id":"gen_xxx","object":"chat.completion.chunk","created":1787760738,"model":"deepseek/deepseek-v4-flash","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":85,"completion_tokens":27,"total_tokens":112,"prompt_tokens_details":{"cached_tokens":0,"audio_tokens":0,"video_tokens":0},"completion_tokens_details":{"reasoning_tokens":24,"image_tokens":0},"cache_creation_input_tokens":0}}

data: [DONE]
```

> usage chunk 的 `choices` 为空或 `delta` 为空但带 `finish_reason`，`reasoning_tokens` 表示 DeepSeek 思考量（已包含在 `completion_tokens` 内）。

### 4.2 上游 Anthropic SSE（路径 B′ 直连透传时）

`event:` 行 + `data:` 行格式，事件名：`message_start / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop`。usage 出现在 `message_start`（input_tokens 估算或上游值）与 `message_delta`（output_tokens 累计）。

---

## 5. usage 字段对照（贯穿四个阶段）

| 阶段 | 字段 |
|---|---|
| Upstream Response（OpenAI） | `prompt_tokens`、`completion_tokens`、`total_tokens`、`prompt_tokens_details.cached_tokens`、`completion_tokens_details.reasoning_tokens`、`cache_creation_input_tokens` |
| Local Response（Anthropic） | `input_tokens`（净输入 = 总输入 − 缓存命中）、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` |
| Local Response（Responses） | `input_tokens`（**总输入**，未扣缓存）、`output_tokens`、`total_tokens`、`input_tokens_details.cached_tokens`、`output_tokens_details.reasoning_tokens` |
| 访问日志（RES 行） | `in`（**净输入** = 总输入 − 缓存命中）、`out`、`rt`（reasoning，已含在 out 内）、`cr`（缓存读）、`cw`（缓存写） |

解析逻辑见 `normalizeUsage()`：`in = in > cr ? in - cr : in`（仅当 in > cr 才减，异常数据保留原值），`rt` 取自 `completion_tokens_details.reasoning_tokens`（Responses 侧取 `output_tokens_details.reasoning_tokens`），`cr` 依次尝试 `prompt_tokens_details.cached_tokens` → `input_tokens_details.cached_tokens` → `cache_read_input_tokens`，`cw` 依次尝试顶层 `cache_creation_input_tokens` → `prompt_tokens_details.cache_creation_input_tokens`。

---

## 6. 调试技巧

- 启动时设 `CMC_DEBUG=1`：流式转换路径会把**上游原始流**逐 chunk 打印到 stderr（`[DBG-UP-messages]` / `[DBG-UP-responses]` 前缀，每条截 300 字符），可直接对照本文件的 Upstream Response 样例。
- 启动时设 `CMC_DEBUG_PAYLOAD=1`：打印**本地请求**的完整 headers、`bodyKeys` 与 body 原文（超 8000B 截断），用于排查会话标识头（`x-claude-code-session-id` / `session-id` / `thread-id`）与请求体形态。
- `CMC_LOGGING_FILE=2`：只在 RES 行出现 `pfx~` 分叉标记时把 **client / upstream 双 body** 落盘到 `fulllog.log`（`1` = 仅严重事件，`3` = 全部模型类请求），对照两份 body 即可定位是客户端改写还是转换层改写。
- `curl http://127.0.0.1:5411/v1/models` 查看可用模型；`?raw=1` 看全量（含被 `blockedModels` 屏蔽的）。
- 日志 `RES` 行带 `in/out/rt/cr/cw` 即上游成功返回 usage；若缺失，先确认流式请求是否带了 `stream_options.include_usage`（转换路径会自动注入，直连 `/v1/chat/completions` 的客户端需自行带上）。

---

## 7. 失败、轮换与错误形状

### 7.1 轮换判定（`upstreamFetchRotate`）

```
switchOnFail(按请求类型: text / image)?
├─ false → 单次请求不轮换; 失败原样返回 (回退到默认的模型记入 failTTL 冷却表,
│          用户显式指定的模型不记入; 成功清除)
└─ true  → 候选序列 = [pickModel 决策出的模型] + 类型列表(defaultModels / defaultVisionModels) 去重
           逐个尝试:
             用户显式指定模型 (isFallback=false 且 i===0)
             └─ 不检查冷却, 永远先试; 失败不 markModelFail, 直接轮换
             冷却中(modelInCooldown) → 跳过, 打印 "模型 X 冷却中, 跳过"
             2xx                    → 成功, 清除冷却, 结束
             非 2xx                 → markModelFail (进入冷却) [回退/默认候选]
                  ├─ 带图且 400                → 轮换下一个
                  ├─ 403/404/408/429/5xx       → 轮换下一个
                  └─ 其他 (401/413/422...)     → 不轮换, 原样透传
             网络层错误/首字节超时             → markModelFail, 轮换下一个
             客户端断开 (clientAbort)          → 立即终止整个循环
           全部试完 → 透传最后一次上游响应 (或抛最后一次错误 → 502)
           全部在冷却期 → 不发请求, 直接 502
```

**冷却范围**（`isFallback`）：只有回退到默认的模型（未带 model，或指定模型解析失败落到
`defaultForType`）失败才 `markModelFail` 进入 TTL 冷却；用户显式指定的模型（`modelMap` /
目录解析命中）失败不冷却，下次请求仍从它开始 —— 不去猜测用户指定模型的能力（如纯文本模型
收到带图请求）。默认列表里的后续候选（轮换到的 index ≥ 1）无论何种情况都照常冷却（方案 A）。

轮换日志示例（`TAGW` = 黄色 `[cmc-proxy]` 前缀，带会话标签）：

```
[cmc-proxy] S3#1 上游 403 (deepseek/deepseek-v4-flash), 轮换 → deepseek/deepseek-v4-flash-vision-exp (1/5)
[cmc-proxy] S3#1 上游 400 (deepseek/deepseek-v4-flash), 带图轮换 → xiaomi/mimo-v2.5 (1/3)
[cmc-proxy] S3#1 模型 deepseek/deepseek-v4-flash 冷却中, 跳过
```

### 7.2 错误响应形状

| 场景 | 状态码 | body |
|---|---|---|
| 上游非 2xx（且未轮换成功） | 上游原状态码 | **上游原始错误 body**（透传，非流式/流式错误分支都走原样透传；未做错误格式转换） |
| 上游网络层错误 / 首字节超时 / 全部候选冷却 | `502` | `/v1/messages`：`{"type":"error","error":{"type":"api_error","message":"上游请求失败: <msg>"}}`；`/v1/chat/completions` 与 `/v1/responses`：`{"error":{"message":"上游请求失败: <msg>","type":"api_error"}}` |
| 上游 2xx 但响应 JSON 解析失败 | `502` | 同上结构，`message` 为 `上游响应解析失败: <msg>` |
| cmc-proxy 内部异常（兜底 catch） | `502` | `{"type":"error","error":{"type":"api_error","message":"cmc-proxy 内部错误: <msg>"}}` |
| 路径不存在 | `404` | `{"error":{"message":"Not found: <path>","type":"invalid_request_error"}}` |
| 客户端中途断开 | — | 不写响应（socket 已死），只打印 `ABT` 行：`[cmc-proxy]S3#1 ABT POST /v1/messages 客户端断开 (已等待 12.3s, 未收到完整响应)`；`CMC_LOGGING_FILE>=1` 时落盘 |

### 7.3 其他运行时行为

- **会话串行化**：同会话上游请求串行发送（`serializeSessionRequests`，默认开）。排队中的请求在 REQ 行标 `REQ*`，RES 行在 `qwait > 0.5s` 时显示排队时长。客户端断开会立即出队。
- **首字节超时**：`firstByteTimeout`（默认 120000ms，`0` 关闭）内上游未返回响应头即中止，计为失败并进入轮换。
- **会话归因**：`x-claude-code-session-id` → `session-id`（兼容 `session_id`）→ `thread-id` → `src:port + ua`。仅 `/v1/messages`、`/v1/chat/completions`、`/v1/responses` 计入会话编号（日志标签 `S{n}#{m}`）。
- **通配路径 `/v1/*`**：不参与模型决策、轮换、会话串行化与 usage 统计，只注入 Key 并转发（含 `redirect: follow`；GET/HEAD 不带 body）。
