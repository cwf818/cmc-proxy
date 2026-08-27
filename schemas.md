# cmc-proxy 数据流 Schema 参考

本文件对照学习用：完整描述一次请求从 **本地客户端 → cmc-proxy → 上游 API → 返回本地** 各阶段的请求/响应格式与样例。

> 术语约定：
> - **Local Request**：本地客户端（Claude Code / Codex / curl）发到 `127.0.0.1:5411` 的请求
> - **Upstream Request**：cmc-proxy 转发到 `https://api.commandcode.ai/provider` 的请求
> - **Upstream Response**：上游 API 返回给 cmc-proxy 的响应
> - **Local Response**：cmc-proxy 最终返回给本地客户端的响应

---

## 0. 总览：四条路径

```
路径 A  /v1/chat/completions          OpenAI 格式 ──原样透传──▶ OpenAI 格式          (Codex wire_api=chat / 任意 OpenAI 客户端)
路径 B  /v1/messages                  Anthropic 格式 ──协议转换──▶ OpenAI 格式       (Claude Code, 默认模型走转换)
路径 B′ /v1/messages (Claude 模型)    Anthropic 格式 ──原样透传──▶ Anthropic 格式    (预留 Pro/Provider 直连真实 Claude)
路径 C  /v1/responses                 Responses 格式 ──协议转换──▶ OpenAI 格式       (Codex wire_api=responses)
```

所有路径都会做两件统一的事：
1. **模型映射**：`body.model` 经 `resolveModel()` 解析（显式映射表 → 上游目录匹配 → fallback 默认 `deepseek/deepseek-v4-flash`）
2. **Key 注入**：`buildUpstreamHeaders()` 强制写入 `Authorization: Bearer <apiKey>`（覆盖客户端传的任何值），并保留客户端的 `x-api-key`

另外非流式转换路径与透传路径都会解析上游响应中的 `usage` 输出到访问日志（见 §5）。

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
  "model": "deepseek/deepseek-v4-flash",          // resolveModel 映射结果
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
| 顶层 `system`（字符串或块数组） | `messages[0]` 的 `role:"system"` |
| user 文本 content | `role:"user"`，字符串或 `[{type:"text",text}]` 块数组 |
| user 的 `tool_result` 块 | 拆成独立 `role:"tool"` + `tool_call_id` 消息（同一条 user 消息混合文本会拆开） |
| user 的 `image` 块（base64/url） | `[{type:"image_url",image_url:{url:"data:...;base64,..."}}]` |
| assistant 文本 | `role:"assistant"` 的 `content` |
| assistant 的 `tool_use` 块 | `tool_calls[]`，`arguments` 为 `JSON.stringify(input)` |
| `tools[]`（name/description/input_schema） | `tools[]`（type:"function", function:{name,description,parameters}） |
| `tool_choice:{type:"tool",name}` | `tool_choice:{type:"function",function:{name}}` |
| `max_tokens` | 保留，但**钳制到 ≥16**（部分上游模型要求，Claude Code /model 探测会发 max_tokens=1） |
| `stream:true` | 自动加 `stream_options:{include_usage:true}` |

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
| `usage.prompt_tokens` | `usage.input_tokens`（**净输入** = max(0, prompt_tokens − cached_tokens)，与日志 in=in-cr 一致） |
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
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":32,"cache_read_input_tokens":0}}

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
    { "role": "user",
      "content": [{ "type": "function_call_output", "call_id": "call_01", "output": "main.js:3: bug" }] }
  ],
  "tools": [
    { "type": "function", "name": "grep", "description": "搜索文件",
      "parameters": { "type": "object", "properties": {} } }
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
    { "role": "system", "content": "You are a coding assistant. Be concise." },  // instructions + developer 合并为 system
    { "role": "user", "content": "看一下这个 bug" },
    { "role": "assistant", "content": "我先查日志。",
      "tool_calls": [{ "id": "call_01", "type": "function",
        "function": { "name": "grep", "arguments": "{\"pattern\":\"bug\"}" } }] },
    { "role": "tool", "tool_call_id": "call_01", "content": "main.js:3: bug" }   // function_call_output → tool
  ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_tokens": 4096,
  "tools": [{ "type": "function", "function": { "name": "grep", "description": "搜索文件", "parameters": {} } }]
}
```

**关键映射规则**：

| Responses（Local） | OpenAI（Upstream） |
|---|---|
| 顶层 `instructions` | 第一条 `role:"system"` |
| `input` 为字符串 | 一条 `role:"user"` |
| user `input_text` | `role:"user"` |
| user `function_call_output` | 拆成 `role:"tool"` + `tool_call_id`（call_id） |
| assistant `output_text` / `input_text` | `role:"assistant"` 的 `content` |
| assistant `function_call` | `tool_calls[]` |
| `role:"developer"` / `"system"` | `role:"system"` |
| `max_output_tokens` | `max_tokens`（钳制 ≥16） |
| tools 平铺 `{type,name,description,parameters}` 或嵌套 `{type,function}` | 统一为 `{type:"function", function:{...}}`（无 name 的跳过并告警） |
| `tool_choice:{type:"function",name}` | `{type:"function",function:{name}}`；`"auto"/"required"/"none"` 直通 |

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
  "usage": { "input_tokens": 84, "output_tokens": 35, "total_tokens": 119 },
  "output_text": "Hi! How can I help you today?"
}
```

**响应映射**：`message.content` → `output:[{type:"message", content:[{type:"output_text"}]}]`；`message.tool_calls[]` → `output:[{type:"function_call", call_id, name, arguments}]`；usage 只保留 `input_tokens/output_tokens/total_tokens`。

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
| Local Response（Responses） | `input_tokens`、`output_tokens`、`total_tokens` |
| 访问日志（RES 行） | `in`（**净输入** = 总输入 − 缓存命中）、`out`、`rt`（reasoning，已含在 out 内）、`cr`（缓存读）、`cw`（缓存写） |

解析逻辑见 `normalizeUsage()`：`in = in - cr`（防负），`rt` 取自 `completion_tokens_details.reasoning_tokens`。

---

## 6. 调试技巧

- 启动时设 `CMC_DEBUG=1`：流式转换路径会把**上游原始流**逐 chunk 打印到 stderr（`[DBG-UP]` 前缀），可直接对照本文件的 Upstream Response 样例。
- `curl http://127.0.0.1:5411/v1/models` 查看可用模型；`?raw=1` 看全量（含被屏蔽的）。
- 日志 `RES` 行带 `in/out/rt/cr/cw` 即上游成功返回 usage；若缺失，先确认流式请求是否带了 `stream_options.include_usage`。
