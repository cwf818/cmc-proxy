#!/usr/bin/env node
/**
 * cmc-proxy — commandcode GOAT 订阅本地反代网关
 * ===============================================
 * 把 commandcode Provider API 反代到本机，供 Claude Code / Codex 使用：
 *   - /v1/chat/completions  ->  https://api.commandcode.ai/provider/v1/chat/completions  (OpenAI 格式)
 *   - /v1/messages          ->  https://api.commandcode.ai/provider/v1/messages          (Anthropic 格式, 仅 Claude 模型)
 *   - /v1/messages (转换模式)->  https://api.commandcode.ai/provider/v1/chat/completions  (Anthropic -> OpenAI 协议转换)
 *   - /v1/models            ->  上游模型列表 (按配置过滤)
 *
 * 零第三方依赖, 仅需 Node.js >= 18 (内置 fetch / ReadableStream)。
 *
 * 启动:  node proxy.js [--port 5411] [--config config.json]
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// 配置加载
// ---------------------------------------------------------------------------
const ROOT = __dirname;
const configPath = path.join(ROOT, "config.json");

function loadConfig() {
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
  return {
    port: 5411,
    host: "127.0.0.1",
    upstream: "https://api.commandcode.ai/provider",
    apiKey: "",
    defaultModel: "gpt-5.6-sol",
    modelMap: {},
    blockedModels: [],
  };
}

const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const config = loadConfig();
const PORT = parseInt(argVal("--port", config.port || 5411), 10);
const HOST = argVal("--host", config.host || "127.0.0.1");
const UPSTREAM = (config.upstream || "https://api.commandcode.ai/provider").replace(/\/+$/, "");
const API_KEY = process.env.CMDC_API_KEY || config.apiKey || "";

if (!API_KEY) {
  console.error(TAGE, "错误: 未配置 apiKey。请在 config.json 中填入你的 commandcode API key，");
  console.error(TAGE, "       或通过环境变量 CMDC_API_KEY 传入。");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 模型解析
// ---------------------------------------------------------------------------
const modelMap = config.modelMap || {};
const DEFAULT_MODEL = config.defaultModel || "deepseek/deepseek-v4-flash";

/**
 * 模型解析 helper:
 *   1. modelMap 显式映射优先
 *   2. 上游模型目录匹配: 精确 / 去前缀(无前缀名) / 大小写不敏感
 *      例: deepseek-v4-flash -> deepseek/deepseek-v4-flash, qwen3.8-max -> Qwen/Qwen3.8-Max
 *   3. 无任何匹配 -> fallback 到默认模型 (defaultModel)
 */
function resolveModel(requested) {
  if (!requested) return DEFAULT_MODEL;

  // 1. 显式映射表
  if (modelMap[requested]) return modelMap[requested];

  // 2. 上游模型目录匹配
  const models = upstreamModelsCache.list;
  if (models.length) {
    const reqLower = requested.toLowerCase();
    const bareLower = requested.replace(/^[^/]*\//, "").toLowerCase(); // 去掉 provider 前缀
    for (const m of models) {
      const id = m.id;
      if (id === requested) return id; // 精确
      const idLower = id.toLowerCase();
      if (idLower === reqLower) return id; // 大小写不敏感精确
      if (idLower.endsWith("/" + bareLower)) return id; // 无前缀名匹配带前缀模型
    }
  }

  // 3. 无匹配 -> 默认模型 (GOAT 无 Claude 模型, claude-* 也会落到这里)
  return DEFAULT_MODEL;
}

/** 判断某模型是否需要走 Anthropic /messages 端点 (Claude 系) */
function isClaudeModel(model) {
  return /^claude(-|$)/.test(model);
}

// ---------------------------------------------------------------------------
// 上游模型列表缓存 (供 /v1/models 使用, 启动时异步刷新)
// ---------------------------------------------------------------------------
let upstreamModelsCache = { list: [], fetchedAt: 0 };

async function refreshModels(force) {
  const now = Date.now();
  if (!force && upstreamModelsCache.list.length && now - upstreamModelsCache.fetchedAt < 60_000) {
    return upstreamModelsCache.list;
  }
  try {
    const r = await fetch(`${UPSTREAM}/v1/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (!r.ok) throw new Error(`upstream models HTTP ${r.status}`);
    const j = await r.json();
    upstreamModelsCache = { list: j.data || [], fetchedAt: now };
  } catch (e) {
    console.warn(TAGW, "刷新上游模型列表失败:", e.message);
  }
  return upstreamModelsCache.list;
}

const blockedSet = new Set(config.blockedModels || []);

function filterModels(models) {
  if (!blockedSet.size) return models;
  return models.filter((m) => !blockedSet.has(m.id));
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function estimateTokens(obj) {
  try {
    return Math.max(1, Math.ceil(JSON.stringify(obj).length / 4));
  } catch {
    return 1;
  }
}

/** 估算 Anthropic/Responses 请求的输入 tokens (用于 message_start.usage.input_tokens) */
function estimateInputTokens(body) {
  try {
    let n = 0;
    const count = (s) => {
      n += Math.ceil((typeof s === "string" ? s : JSON.stringify(s || {})).length / 4);
    };
    if (body.system) count(body.system);
    if (body.instructions) count(body.instructions);
    for (const m of body.messages || []) count(m.content);
    if (body.input) count(body.input);
    if (body.tools && body.tools.length) count(body.tools);
    return Math.max(1, n);
  } catch {
    return 1;
  }
}

/**
 * 从上游 usage 对象中提取日志关心的字段 (同时兼容 OpenAI 与 Anthropic 两种格式):
 *   input / output / reasoning(rt) / cacheRead(cr) / cacheWrite(cw)
 * 注: input 返回"净输入"(总输入 - 缓存命中), 缓存命中量由 cacheRead 单独展示,
 *     两者之和才是上游返回的总输入 tokens。
 */
function normalizeUsage(u) {
  if (!u) return null;
  const pd = u.prompt_tokens_details || {};
  const cd = u.completion_tokens_details || {};
  const out = {};
  if (u.prompt_tokens != null) out.input = u.prompt_tokens; // OpenAI
  if (u.input_tokens != null) out.input = u.input_tokens; // Anthropic
  if (u.completion_tokens != null) out.output = u.completion_tokens; // OpenAI
  if (u.output_tokens != null) out.output = u.output_tokens; // Anthropic
  if (pd.cached_tokens !== undefined) out.cacheRead = pd.cached_tokens; // OpenAI
  if (u.cache_read_input_tokens !== undefined) out.cacheRead = u.cache_read_input_tokens; // Anthropic
  if (u.cache_creation_input_tokens !== undefined) out.cacheWrite = u.cache_creation_input_tokens;
  if (cd.reasoning_tokens !== undefined) out.reasoning = cd.reasoning_tokens; // OpenAI (DeepSeek 思考量)
  // in = in - cr: 扣掉缓存命中的部分, 剩余才是按原价计费的输入
  if (out.input != null && out.cacheRead != null) out.input = Math.max(0, out.input - out.cacheRead);
  return out;
}

function mapStopReason(openaiReason) {
  switch (openaiReason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "function_call":
      return "tool_use";
    case "stop":
    case "end_turn":
    default:
      return "end_turn";
  }
}

// ---------------------------------------------------------------------------
// Anthropic -> OpenAI 请求转换
// ---------------------------------------------------------------------------
function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b.type === "text") return b.text;
        if (b.type === "tool_result") {
          const c = b.content;
          if (typeof c === "string") return c;
          if (Array.isArray(c)) return c.map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("");
          return JSON.stringify(c);
        }
        return "";
      })
      .join("");
  }
  return "";
}

/** 把 Anthropic content blocks 转为 OpenAI content (字符串或块数组) */
function anthropicContentToOpenAI(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const parts = [];
  for (const b of content) {
    if (b.type === "text") {
      if (b.text) parts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      // 上游只接受文本和图像
      const src = b.source;
      if (src && src.type === "base64" && src.media_type && src.data) {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${src.media_type};base64,${src.data}` },
        });
      } else if (src && src.type === "url" && src.url) {
        parts.push({ type: "image_url", image_url: { url: src.url } });
      }
    }
    // 其他块(如 tool_result 已在上层处理) 忽略
  }
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts.length ? parts : null;
}

function anthropicMessageToOpenAI(msg) {
  const role = msg.role;
  if (role === "user") {
    // 检查是否含 tool_result 块
    if (Array.isArray(msg.content)) {
      const toolResults = msg.content.filter((b) => b.type === "tool_result");
      if (toolResults.length) {
        // 一条 user 消息里混了 tool_result 和文本: 拆开 (OpenAI 要求 tool 消息独立)
        const out = [];
        for (const b of msg.content) {
          if (b.type === "tool_result") {
            const c = extractTextFromContent(b.content);
            out.push({
              role: "tool",
              tool_call_id: b.tool_use_id,
              content: typeof c === "string" && c.length ? c : JSON.stringify(c),
            });
          } else if (b.type === "text" && b.text) {
            const last = out[out.length - 1];
            if (last && last.role === "user") {
              last.content += "\n" + b.text;
            } else {
              out.push({ role: "user", content: b.text });
            }
          }
        }
        return out;
      }
    }
    return { role: "user", content: anthropicContentToOpenAI(msg.content) };
  }
  if (role === "assistant") {
    const text = extractTextFromContent(msg.content);
    const toolUses = Array.isArray(msg.content)
      ? msg.content.filter((b) => b.type === "tool_use")
      : [];
    const omsg = { role: "assistant" };
    if (text) omsg.content = text;
    if (toolUses.length) {
      omsg.tool_calls = toolUses.map((tu) => ({
        id: tu.id,
        type: "function",
        function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
      }));
    }
    return omsg;
  }
  // system 等其他 role 直接透传
  return { role, content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) };
}

function anthropicToOpenAIRequest(body) {
  const mapped = resolveModel(body.model);
  const messages = [];
  // 顶层 system
  if (body.system) {
    const sysText = extractTextFromContent(body.system);
    if (sysText) messages.push({ role: "system", content: sysText });
  }
  // 逐条转换 (user 消息可能展开为多条)
  for (const m of body.messages || []) {
    const converted = anthropicMessageToOpenAI(m);
    if (Array.isArray(converted)) messages.push(...converted);
    else if (converted) messages.push(converted);
  }
  const req = {
    model: mapped,
    messages,
    stream: !!body.stream,
  };
  // 部分上游模型 (如 gpt-5.6-sol) 要求 max_tokens >= 16; Claude Code 的 /model
  // 探测请求会发 max_tokens=1, 需钳制到最小值避免 400
  if (body.max_tokens != null) req.max_tokens = Math.max(16, body.max_tokens);
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (body.tools && Array.isArray(body.tools) && body.tools.length) {
    req.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
  }
  if (body.tool_choice && typeof body.tool_choice === "object" && body.tool_choice.type === "tool") {
    req.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
  } else if (body.tool_choice === "auto") {
    req.tool_choice = "auto";
  }
  if (body.stream) req.stream_options = { include_usage: true };
  return req;
}

// ---------------------------------------------------------------------------
// OpenAI -> Anthropic 响应转换 (非流式)
// ---------------------------------------------------------------------------
function openAIToAnthropic(obj, requestedModel) {
  const choice = obj.choices && obj.choices[0] ? obj.choices[0] : {};
  const msg = choice.message || {};
  const contentBlocks = [];
  if (msg.content) contentBlocks.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {
      input = { raw: tc.function.arguments };
    }
    contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }
  const u = obj.usage || {};
  const pd = u.prompt_tokens_details || {};
  return {
    id: obj.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: requestedModel || obj.model,
    content: contentBlocks,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      // input_tokens 为净输入 (总输入 - 缓存命中), 与日志 in=in-cr 保持一致; 命中量由 cache_read_input_tokens 单独返回
      input_tokens: Math.max(0, (u.prompt_tokens ?? 0) - (pd.cached_tokens ?? 0)),
      output_tokens: u.completion_tokens ?? 0,
      ...(pd.cached_tokens !== undefined ? { cache_read_input_tokens: pd.cached_tokens } : {}),
      ...(pd.cache_creation_input_tokens !== undefined ? { cache_creation_input_tokens: pd.cache_creation_input_tokens } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI SSE 流 -> Anthropic SSE 流 转换
// ---------------------------------------------------------------------------
class StreamConverter {
  constructor(requestedModel, estimateInputTokens = 0) {
    this.requestedModel = requestedModel;
    this.estimateInputTokens = estimateInputTokens; // message_start 用的估算输入 tokens
    this.started = false; // 是否已发 message_start
    this.contentIndex = 0; // 内容块索引
    this.toolState = {}; // index -> {id, name, buffer, startSent}
    this.activeBlocks = []; // 已开始的块索引
    this.finished = false;
    this.stopReason = "end_turn";
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.cacheRead = undefined; // cache_read_input_tokens
    this.cacheCreation = undefined; // cache_creation_input_tokens
    this.rawUsage = null; // 最后一次完整 usage 对象 (供日志输出)
    this.pending = "";
  }

  /** 从 OpenAI chunk 中提取 usage (chat/completions 流式的 usage 在末尾 chunk) */
  updateUsageFromChunk(json) {
    if (!json.usage) return;
    this.rawUsage = json.usage;
    const u = json.usage;
    const pd = u.prompt_tokens_details || {};
    // input_tokens 存净输入 (总输入 - 缓存命中), 与日志 in=in-cr 及非流式 openAIToAnthropic 保持一致
    if (u.prompt_tokens != null) this.usage.input_tokens = Math.max(0, u.prompt_tokens - (pd.cached_tokens ?? 0));
    if (u.completion_tokens != null) this.usage.output_tokens = u.completion_tokens;
    if (pd.cached_tokens !== undefined) this.cacheRead = pd.cached_tokens;
    if (pd.cache_creation_input_tokens !== undefined) this.cacheCreation = pd.cache_creation_input_tokens;
  }

  usageObject(includeInput) {
    const obj = {};
    if (includeInput) obj.input_tokens = this.usage.input_tokens || this.estimateInputTokens || 0;
    obj.output_tokens = this.usage.output_tokens || 0;
    if (this.cacheRead !== undefined) obj.cache_read_input_tokens = this.cacheRead;
    if (this.cacheCreation !== undefined) obj.cache_creation_input_tokens = this.cacheCreation;
    return obj;
  }

  /** 写入原始 SSE 文本, 返回要发给客户端的 Anthropic SSE 文本 */
  push(rawText) {
    this.pending += rawText;
    const events = [];
    let idx;
    while ((idx = this.pending.indexOf("\n\n")) >= 0) {
      const rawEvent = this.pending.slice(0, idx);
      this.pending = this.pending.slice(idx + 2);
      const parsed = parseSSEEvent(rawEvent);
      if (parsed && parsed.data) {
        try {
          const json = JSON.parse(parsed.data);
          this.handleChunk(json, events);
        } catch {
          /* 忽略坏 chunk */
        }
      }
    }
    return events.join("");
  }

  handleChunk(json, events) {
    // 任何携带 usage 的 chunk 都提取 (OpenAI 流式的 usage 在末尾 finish chunk 中)
    this.updateUsageFromChunk(json);
    // usage-only chunk (stream_options include_usage)
    if (!json.choices || !json.choices.length) {
      return;
    }
    const choice = json.choices[0];
    const delta = choice.delta || {};

    if (!this.started) {
      this.started = true;
      events.push(
        sse(
          "message_start",
          JSON.stringify({
            type: "message_start",
            message: {
              id: json.id || `msg_${Date.now()}`,
              type: "message",
              role: "assistant",
              model: this.requestedModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: this.usageObject(true),
            },
          })
        )
      );
    }

    // 文本增量
    if (delta.content) {
      if (this.activeBlocks.indexOf(0) < 0) {
        this.activeBlocks.push(0);
        events.push(
          sse(
            "content_block_start",
            JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            })
          )
        );
      }
      events.push(
        sse(
          "content_block_delta",
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: delta.content },
          })
        )
      );
    }

    // 工具调用增量
    for (const tc of delta.tool_calls || []) {
      const st = this.toolState[tc.index] || (this.toolState[tc.index] = { buffer: "", startSent: false });
      if (tc.id) st.id = tc.id;
      if (tc.function) {
        if (tc.function.name) st.name = tc.function.name;
        if (tc.function.arguments) st.buffer += tc.function.arguments;
      }
      if (!st.startSent) {
        st.startSent = true;
        const blockIndex = this.nextIndex();
        st.blockIndex = blockIndex;
        this.activeBlocks.push(blockIndex);
        events.push(
          sse(
            "content_block_start",
            JSON.stringify({
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: st.id || `toolu_${Date.now()}_${tc.index}`,
                name: st.name || "function",
                input: {},
              },
            })
          )
        );
      }
      if (tc.function && tc.function.arguments) {
        events.push(
          sse(
            "content_block_delta",
            JSON.stringify({
              type: "content_block_delta",
              index: st.blockIndex,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments },
            })
          )
        );
      }
    }

    // 结束 (finish_reason 出现)
    if (choice.finish_reason && !this.finished) {
      this.finished = true;
      this.stopReason = mapStopReason(choice.finish_reason);
    }
  }

  nextIndex() {
    return this.contentIndex++;
  }

  /** 流结束时调用, 返回收尾 SSE */
  finish() {
    if (!this.started) {
      // 上游直接结束且未发任何块: 补一个空消息
      this.started = true;
      let out =
        sse(
          "message_start",
          JSON.stringify({
            type: "message_start",
            message: {
              id: `msg_${Date.now()}`,
              type: "message",
              role: "assistant",
              model: this.requestedModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })
        ) + "\n";
      for (const bi of this.activeBlocks) out += sse("content_block_stop", JSON.stringify({ type: "content_block_stop", index: bi }));
      out += sse(
        "message_delta",
        JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: this.stopReason, stop_sequence: null },
          usage: this.usageObject(false),
        })
      );
      out += sse("message_stop", JSON.stringify({ type: "message_stop" }));
      return out;
    }
    let out = "";
    for (const bi of this.activeBlocks) {
      out += sse("content_block_stop", JSON.stringify({ type: "content_block_stop", index: bi }));
    }
    out += sse(
      "message_delta",
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: this.stopReason, stop_sequence: null },
        usage: this.usageObject(false),
      })
    );
    out += sse("message_stop", JSON.stringify({ type: "message_stop" }));
    return out;
  }
}

// ---------------------------------------------------------------------------
// Responses API (Codex wire_api="responses") -> Chat Completions 请求转换
// ---------------------------------------------------------------------------
function makeResponsesId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 提取 Responses content blocks 的文本 */
function responsesContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b.type === "input_text" || b.type === "output_text") return b.text || "";
        if (b.type === "function_call_output") return typeof b.output === "string" ? b.output : JSON.stringify(b.output ?? "");
        return "";
      })
      .join("");
  }
  return "";
}

/** 把 Responses 的 input 数组转换为 chat messages */
function responsesInputToChatMessages(input) {
  const messages = [];
  // input 可以是字符串
  if (typeof input === "string") {
    if (input) messages.push({ role: "user", content: input });
    return messages;
  }
  const push = (m) => {
    const last = messages[messages.length - 1];
    if (last && last.role === m.role && last.role !== "assistant" && typeof last.content === "string" && typeof m.content === "string") {
      last.content += "\n" + m.content;
    } else {
      messages.push(m);
    }
  };

  for (const item of input || []) {
    const role = item.role;
    const blocks = Array.isArray(item.content) ? item.content : [];
    if (role === "user") {
      const toolOutputs = blocks.filter((b) => b.type === "function_call_output");
      if (toolOutputs.length) {
        for (const b of toolOutputs) {
          push({
            role: "tool",
            tool_call_id: b.call_id || b.id || "",
            content: typeof b.output === "string" ? b.output : JSON.stringify(b.output ?? ""),
          });
        }
        const texts = blocks.filter((b) => b.type === "input_text").map((b) => b.text).join("");
        if (texts) push({ role: "user", content: texts });
      } else {
        push({ role: "user", content: responsesContentToText(blocks) });
      }
    } else if (role === "assistant") {
      const text = responsesContentToText(blocks.filter((b) => b.type === "output_text" || b.type === "input_text"));
      const fnCalls = blocks.filter((b) => b.type === "function_call");
      const m = { role: "assistant" };
      if (text) m.content = text;
      if (fnCalls.length) {
        m.tool_calls = fnCalls.map((fc) => ({
          id: fc.call_id || fc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: "function",
          function: {
            name: fc.name || "unknown",
            arguments: typeof fc.arguments === "string" ? fc.arguments : JSON.stringify(fc.arguments ?? {}),
          },
        }));
      }
      push(m);
    } else if (role === "developer" || role === "system") {
      push({ role: "system", content: responsesContentToText(blocks) });
    }
    // reasoning 等其他 item 忽略
  }
  return messages;
}

/** 把 Responses 请求体转换为 chat/completions 请求体 */
function responsesToChatRequest(body) {
  const mapped = resolveModel(body.model);
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  messages.push(...responsesInputToChatMessages(body.input));
  const req = { model: mapped, messages, stream: !!body.stream };
  // 钳制 max_output_tokens 到最小 16 (部分上游模型要求, 如 gpt-5.6-sol)
  if (body.max_output_tokens != null) req.max_tokens = Math.max(16, body.max_output_tokens);
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.tools && Array.isArray(body.tools) && body.tools.length) {
    // 兼容两种 tool 结构: Responses 平铺 {type,name,description,parameters}
    // 与 chat 嵌套 {type,function:{name,description,parameters}}; 无 name 的跳过
    req.tools = body.tools
      .map((t) => {
        const fn = t.function && typeof t.function === "object" ? t.function : t;
        return {
          type: "function",
          function: {
            name: fn.name,
            description: fn.description || "",
            parameters: fn.parameters || { type: "object", properties: {} },
          },
        };
      })
      .filter((t) => {
        if (!t.function.name) {
          console.warn(TAGW, "跳过无 name 的工具:", JSON.stringify(t.function).slice(0, 120));
          return false;
        }
        return true;
      });
  }
  if (body.tool_choice && typeof body.tool_choice === "object" && body.tool_choice.type === "function") {
    const choiceName = body.tool_choice.name || (body.tool_choice.function && body.tool_choice.function.name);
    if (choiceName) req.tool_choice = { type: "function", function: { name: choiceName } };
  } else if (body.tool_choice === "auto" || body.tool_choice === "required" || body.tool_choice === "none") {
    req.tool_choice = body.tool_choice;
  }
  if (body.stream) req.stream_options = { include_usage: true };
  return req;
}

// ---------------------------------------------------------------------------
// Chat Completions -> Responses 响应转换
// ---------------------------------------------------------------------------
function chatMessageToResponsesOutput(msg) {
  const output = [];
  if (msg.content) {
    output.push({
      type: "message",
      id: makeResponsesId("msg"),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: msg.content, annotations: [] }],
    });
  }
  for (const tc of msg.tool_calls || []) {
    output.push({
      type: "function_call",
      id: makeResponsesId("fc"),
      status: "completed",
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments || "{}",
    });
  }
  return output;
}

/** 非流式: chat.completion -> response 对象 */
function chatResponseToResponses(obj, requestedModel) {
  const choice = obj.choices && obj.choices[0] ? obj.choices[0] : {};
  const msg = choice.message || {};
  const output = chatMessageToResponsesOutput(msg);
  const u = obj.usage || {};
  return {
    id: makeResponsesId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: requestedModel || obj.model,
    status: "completed",
    output,
    usage: {
      input_tokens: u.prompt_tokens ?? 0,
      output_tokens: u.completion_tokens ?? 0,
      total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
    },
    output_text: msg.content || "",
  };
}

function sseResponses(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** 流式: chat SSE chunks -> Responses SSE 事件序列 */
class ResponsesStreamConverter {
  constructor(requestedModel, estimateInputTokens = 0) {
    this.requestedModel = requestedModel;
    this.resp = {
      id: makeResponsesId("resp"),
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: requestedModel,
      status: "in_progress",
      output: [],
    };
    this.usage = { input_tokens: estimateInputTokens || 0, output_tokens: 0, total_tokens: 0 };
    this.started = false;
    this.msgItem = null;
    this.msgText = "";
    this.msgStarted = false;
    this.msgOutputIndex = -1;
    this.toolStates = {}; // index -> {callId, name, argsBuf, item, outputIndex}
    this.finished = false;
    this.stopReason = "completed";
    this.pending = "";
    this.rawUsage = null; // 最后一次完整 usage 对象 (供日志输出)
  }

  push(rawText) {
    this.pending += rawText;
    const events = [];
    let idx;
    while ((idx = this.pending.indexOf("\n\n")) >= 0) {
      const rawEvent = this.pending.slice(0, idx);
      this.pending = this.pending.slice(idx + 2);
      const parsed = parseSSEEvent(rawEvent);
      if (parsed && parsed.data) {
        try {
          this.handleChunk(JSON.parse(parsed.data), events);
        } catch {
          /* 忽略坏 chunk */
        }
      }
    }
    return events.join("");
  }

  handleChunk(json, events) {
    if (json.usage) {
      this.rawUsage = json.usage;
      const u = json.usage;
      this.usage = {
        input_tokens: u.prompt_tokens ?? this.usage.input_tokens,
        output_tokens: u.completion_tokens ?? this.usage.output_tokens,
        total_tokens: u.total_tokens ?? (u.prompt_tokens ?? this.usage.input_tokens) + (u.completion_tokens ?? this.usage.output_tokens),
      };
    }
    if (!json.choices || !json.choices.length) return;
    const choice = json.choices[0];
    const delta = choice.delta || {};

    if (!this.started) {
      this.started = true;
      events.push(sseResponses({ type: "response.created", response: { ...this.resp, status: "in_progress" } }));
      events.push(sseResponses({ type: "response.in_progress", response: { ...this.resp, status: "in_progress" } }));
    }

    // 文本增量
    if (delta.content) {
      if (!this.msgStarted) {
        this.msgStarted = true;
        this.msgItem = { id: makeResponsesId("msg"), type: "message", status: "in_progress", role: "assistant", content: [] };
        this.msgOutputIndex = this.resp.output.length;
        events.push(sseResponses({ type: "response.output_item.added", output_index: this.msgOutputIndex, item: { ...this.msgItem } }));
        events.push(sseResponses({
          type: "response.content_part.added",
          item_id: this.msgItem.id,
          output_index: this.msgOutputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }));
      }
      this.msgText += delta.content;
      events.push(sseResponses({
        type: "response.output_text.delta",
        item_id: this.msgItem.id,
        output_index: this.msgOutputIndex,
        content_index: 0,
        delta: delta.content,
      }));
    }

    // 工具调用增量
    for (const tc of delta.tool_calls || []) {
      let st = this.toolStates[tc.index];
      if (!st) {
        st = this.toolStates[tc.index] = { callId: tc.id, name: "", argsBuf: "", item: null, outputIndex: -1 };
      }
      if (tc.id) st.callId = tc.id;
      if (tc.function) {
        if (tc.function.name) st.name = tc.function.name;
        if (tc.function.arguments) st.argsBuf += tc.function.arguments;
      }
      if (!st.item) {
        st.item = { id: makeResponsesId("fc"), type: "function_call", status: "in_progress", call_id: st.callId || `call_${Date.now()}`, name: st.name || "function", arguments: "" };
        st.outputIndex = this.resp.output.length;
        events.push(sseResponses({ type: "response.output_item.added", output_index: st.outputIndex, item: { ...st.item } }));
      }
      if (tc.function && tc.function.arguments) {
        events.push(sseResponses({
          type: "response.function_call_arguments.delta",
          item_id: st.item.id,
          output_index: st.outputIndex,
          delta: tc.function.arguments,
        }));
      }
    }

    if (choice.finish_reason && !this.finished) {
      this.finished = true;
      this.stopReason = choice.finish_reason === "length" ? "incomplete" : "completed";
    }
  }

  /** 流结束: 补全 done 事件与终止事件 */
  finish() {
    let out = "";
    const push = (d) => { out += sseResponses(d); };

    if (!this.started) {
      this.started = true;
      push({ type: "response.created", response: { ...this.resp, status: "in_progress" } });
      push({ type: "response.in_progress", response: { ...this.resp, status: "in_progress" } });
    }

    if (this.msgStarted) {
      push({ type: "response.output_text.done", item_id: this.msgItem.id, output_index: this.msgOutputIndex, content_index: 0, text: this.msgText });
      push({
        type: "response.content_part.done",
        item_id: this.msgItem.id,
        output_index: this.msgOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: this.msgText, annotations: [] },
      });
      const doneItem = { ...this.msgItem, status: "completed", content: [{ type: "output_text", text: this.msgText, annotations: [] }] };
      push({ type: "response.output_item.done", output_index: this.msgOutputIndex, item: doneItem });
      this.resp.output.push(doneItem);
    }

    for (const st of Object.values(this.toolStates)) {
      if (!st.item) continue;
      push({ type: "response.function_call_arguments.done", item_id: st.item.id, output_index: st.outputIndex, arguments: st.argsBuf });
      const doneItem = {
        ...st.item,
        status: "completed",
        call_id: st.callId || st.item.call_id,
        name: st.name || st.item.name,
        arguments: st.argsBuf,
      };
      push({ type: "response.output_item.done", output_index: st.outputIndex, item: doneItem });
      this.resp.output.push(doneItem);
    }

    const finalResp = {
      ...this.resp,
      status: this.stopReason === "incomplete" ? "incomplete" : "completed",
      output: this.resp.output,
      usage: this.usage,
    };
    push({ type: this.stopReason === "incomplete" ? "response.incomplete" : "response.completed", response: finalResp });
    return out;
  }
}

/** 解析单个 SSE 原始事件文本 (不含末尾空行) */
function parseSSEEvent(raw) {
  let event = "message";
  const dataLines = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    else if (line.startsWith(":")) continue;
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join("\n") };
}

function sse(event, data) {
  return `event: ${event}\ndata: ${data}\n\n`;
}

// ---------------------------------------------------------------------------
// 请求处理
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(Buffer.concat(chunks).toString("utf8"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** 组装转发到上游的 headers */
function buildUpstreamHeaders(req, extra) {
  const h = { ...extra };
  // 认证注入 (替换任何客户端传入的 Authorization / x-api-key)
  h["Authorization"] = `Bearer ${API_KEY}`;
  const ah = req.headers["x-api-key"];
  if (ah && !h["x-api-key"]) h["x-api-key"] = ah;
  return h;
}

/**
 * 通用透传: 把上游响应(含流式)转发给客户端。
 * opts.collectUsage 存在时, 顺带从响应中提取 usage 对象 (流式扫描 SSE 事件, 非流式解析 JSON),
 * 不改变转发语义, 仅用于访问日志输出。
 */
async function passThrough(res, upstreamResp, opts) {
  const collectUsage = opts && opts.collectUsage;
  const hdrs = upstreamResp.headers || {};
  // Node fetch 的 headers 是 Headers 实例 (支持 .get), 也可能是普通对象, 兼容两者
  const ctype = typeof hdrs.get === "function" ? hdrs.get("content-type") : hdrs["content-type"];
  const isSse = (ctype || "").includes("text/event-stream");
  let acc = "";
  let sseBuf = "";
  res.writeHead(upstreamResp.status, upstreamResp.statusText || "", upstreamResp.headers);
  if (upstreamResp.body) {
    for await (const chunk of upstreamResp.body) {
      res.write(chunk);
      if (collectUsage) {
        if (isSse) {
          // 按 \n\n 切出完整 SSE 事件, 命中 usage 键时解析 (跨 chunk 截断的事件丢弃, usage 事件一般完整)
          sseBuf += Buffer.from(chunk).toString("utf8");
          let idx;
          while ((idx = sseBuf.indexOf("\n\n")) >= 0) {
            const evt = sseBuf.slice(0, idx);
            sseBuf = sseBuf.slice(idx + 2);
            const parsed = parseSSEEvent(evt);
            if (parsed && parsed.data && parsed.data.indexOf('"usage"') >= 0) {
              try {
                collectUsage(JSON.parse(parsed.data).usage);
              } catch {
                /* 忽略坏事件 */
              }
            }
          }
        } else {
          acc += Buffer.from(chunk).toString("utf8");
        }
      }
    }
    if (collectUsage && !isSse && acc) {
      try {
        const j = JSON.parse(acc);
        if (j.usage) collectUsage(j.usage);
      } catch {
        /* 非 JSON 响应 (如错误页) 忽略 */
      }
    }
  }
  res.end();
}

// ---------------------------------------------------------------------------
// 访问日志 (带 ANSI 颜色, 非 TTY/重定向时自动无色)
// ---------------------------------------------------------------------------
const C = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `${code}${s}${C.reset}` : String(s));
const cRed = paint(C.red);
const cGreen = paint(C.green);
const cYellow = paint(C.yellow);
const cCyan = paint(C.cyan);
const cDim = paint(C.dim);
const cBlue = paint(C.blue);

/** 按 HTTP 状态码着色: 2xx 绿 / 4xx 黄 / 5xx 红 */
function cStatus(code) {
  const s = String(code);
  if (code >= 500) return cRed(s);
  if (code >= 400) return cYellow(s);
  if (code >= 300) return cCyan(s);
  return cGreen(s);
}

// 日志标签 (前缀着色)
const TAGW = cYellow("[cmc-proxy]");
const TAGE = cRed("[cmc-proxy]");
const TAGD = cDim("[cmc-proxy]");
const TAGI = cBlue("[cmc-proxy]");

function logTs(ms) {
  const d = new Date(ms);
  return `${d.toLocaleTimeString("zh-CN", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // ---- 访问日志基础设施 (一次请求两行: REQ 本地请求 / RES 外部返回) ----
  const startAt = Date.now();
  const srcIp = req.socket.remoteAddress || "-";
  req._cmdc = { model: null, mapped: null, stream: null, reqLogged: false, usage: null };
  let outBytes = 0;
  const uaShort = () => (req.headers["user-agent"] || "-").slice(0, 48);
  const modelPart = () => {
    const c = req._cmdc;
    if (!c || !c.model) return "";
    return ` model=${c.model}${c.mapped && c.mapped !== c.model ? "→" + c.mapped : ""}`;
  };
  const streamPart = () => {
    const c = req._cmdc;
    return c && c.stream != null ? ` stream=${c.stream ? 1 : 0}` : "";
  };
  const logReq = () => {
    if (req._cmdc.reqLogged) return;
    req._cmdc.reqLogged = true;
    console.log(`${cDim(`[${logTs(startAt)}]`)} ${cCyan("REQ")} ${req.method} ${pathname} src=${srcIp} ua=${uaShort()}${cYellow(modelPart())}${streamPart()}`);
  };
  {
    const origWrite = res.write.bind(res);
    res.write = (...args) => {
      const b = args[0];
      if (b) {
        if (Buffer.isBuffer(b)) outBytes += b.length;
        else if (typeof b === "string") outBytes += Buffer.byteLength(b);
        else if (b instanceof Uint8Array) outBytes += b.byteLength;
      }
      return origWrite(...args);
    };
    // 非流式路径直接 res.end(body) 不经 write, 补一个 end 计数让 out= 字节数准确
    const origEnd = res.end.bind(res);
    res.end = (...args) => {
      const b = args[0];
      if (b && (typeof b === "string" || Buffer.isBuffer(b))) {
        outBytes += Buffer.isBuffer(b) ? b.length : Buffer.byteLength(b);
      }
      return origEnd(...args);
    };
  }
  res.on("finish", () => {
    const ms = Date.now() - startAt;
    const took = ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : ms + "ms";
    // usage 摘要: in / out / rt(思考) / cr(缓存读) / cw(缓存写)
    const u = req._cmdc && req._cmdc.usage;
    let usageStr = "";
    if (u) {
      const parts = [];
      if (u.input != null) parts.push(`in:${u.input}`);
      if (u.output != null) parts.push(`out:${u.output}`);
      if (u.reasoning != null) parts.push(`rt:${u.reasoning}`);
      if (u.cacheRead != null) parts.push(`cr:${u.cacheRead}`);
      if (u.cacheWrite != null) parts.push(`cw:${u.cacheWrite}`);
      if (parts.length) usageStr = ` ${cGreen(parts.join(" "))}`;
    }
    console.log(`${cDim(`[${logTs(Date.now())}]`)} ${cStatus(res.statusCode)} ${req.method} ${pathname}${cYellow(modelPart())} ${cDim(`took=${took} out=${outBytes}B`)}${usageStr}`);
  });

  try {
    // 非模型类 body 路径 (GET 等): 立即打印本地请求日志
    const isModelBodyPath = pathname === "/v1/messages" || pathname === "/v1/chat/completions" || pathname === "/v1/responses";
    if (!isModelBodyPath) logReq();

    // 健康检查
    if (pathname === "/health" || pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "cmc-proxy", upstream: UPSTREAM, port: PORT }));
      return;
    }

    // ---- /v1/models ----
    if (pathname === "/v1/models" && req.method === "GET") {
      const raw = url.searchParams.get("raw") === "1";
      const list = await refreshModels(false);
      const out = raw ? list : filterModels(list);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: out }));
      return;
    }

    // ---- /v1/messages/count_tokens ----
    if (pathname === "/v1/messages/count_tokens" && req.method === "POST") {
      const bodyRaw = await readBody(req);
      let body = {};
      try {
        body = JSON.parse(bodyRaw || "{}");
      } catch {}
      const tokens = estimateTokens(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ input_tokens: tokens }));
      return;
    }

    // ---- /v1/messages (Anthropic 格式) ----
    if (pathname === "/v1/messages" && req.method === "POST") {
      const bodyRaw = await readBody(req);
      const body = JSON.parse(bodyRaw || "{}");
      const requested = body.model || DEFAULT_MODEL;
      const mapped = resolveModel(requested);
      const useAnthropicEndpoint = isClaudeModel(mapped);
      const isStream = !!body.stream;
      req._cmdc = { model: requested, mapped, stream: isStream };
      logReq();

      if (useAnthropicEndpoint) {
        // Claude 模型 -> 直接走上游 /messages
        body.model = mapped;
        const up = await fetch(`${UPSTREAM}/v1/messages`, {
          method: "POST",
          headers: buildUpstreamHeaders(req, {
            "Content-Type": "application/json",
            "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
          }),
          body: JSON.stringify(body),
        });
        await passThrough(res, up, { collectUsage: (u) => { req._cmdc.usage = normalizeUsage(u); } });
        return;
      }

      // 非 Claude 模型 -> Anthropic -> OpenAI 协议转换
      const oaiReq = anthropicToOpenAIRequest(body);
      const up = await fetch(`${UPSTREAM}/v1/chat/completions`, {
        method: "POST",
        headers: buildUpstreamHeaders(req, { "Content-Type": "application/json" }),
        body: JSON.stringify(oaiReq),
      });

      if (!isStream) {
        // 非流式: 整体转换
        const text = await up.text();
        if (!up.ok) {
          res.writeHead(up.status, { "Content-Type": up.headers.get("content-type") || "application/json" });
          res.end(text);
          return;
        }
        try {
          const oai = JSON.parse(text);
          req._cmdc.usage = normalizeUsage(oai.usage);
          const anthropic = openAIToAnthropic(oai, requested);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(anthropic));
        } catch (e) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "上游响应解析失败: " + e.message } }));
        }
        return;
      }

      // 流式: 逐 chunk 转换 SSE
      if (!up.ok) {
        const text = await up.text();
        res.writeHead(up.status, { "Content-Type": "application/json" });
        res.end(text);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const conv = new StreamConverter(requested, estimateInputTokens(body));
      try {
        for await (const chunk of up.body) {
          // undici 流式 chunk 是 Uint8Array, 必须经 Buffer.from 才能正确 utf8 解码
          const raw = Buffer.from(chunk).toString("utf8");
          if (process.env.CMC_DEBUG) process.stderr.write("[DBG-UP] " + raw.replace(/\n/g, "\\n").slice(0, 300) + "\n");
          const outText = conv.push(raw);
          if (outText) res.write(outText);
        }
      } catch (e) {
        console.warn(TAGW, "上游流中断:", e.message);
      }
      try {
        const tail = conv.finish();
        if (tail) res.write(tail);
      } catch (e) {
        console.warn(TAGW, "收尾 SSE 失败:", e.message);
      }
      req._cmdc.usage = normalizeUsage(conv.rawUsage);
      res.end();
      return;
    }

    // ---- /v1/chat/completions (OpenAI 格式) ----
    if (pathname === "/v1/chat/completions" && req.method === "POST") {
      const bodyRaw = await readBody(req);
      const body = JSON.parse(bodyRaw || "{}");
      const requested = body.model || DEFAULT_MODEL;
      if (body.model) body.model = resolveModel(body.model);
      req._cmdc = { model: requested, mapped: body.model, stream: !!body.stream };
      logReq();
      const up = await fetch(`${UPSTREAM}/v1/chat/completions`, {
        method: "POST",
        headers: buildUpstreamHeaders(req, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      await passThrough(res, up, { collectUsage: (u) => { req._cmdc.usage = normalizeUsage(u); } });
      return;
    }

    // ---- /v1/responses (Codex wire_api="responses") ----
    // Codex 新版只支持 Responses API; commandcode 上游仅提供 chat/completions,
    // 因此在此做 Responses <-> Chat Completions 协议转换。
    if (pathname === "/v1/responses" && req.method === "POST") {
      const bodyRaw = await readBody(req);
      const body = JSON.parse(bodyRaw || "{}");
      const requested = body.model || DEFAULT_MODEL;
      const mapped = resolveModel(requested);
      const isStream = !!body.stream;
      req._cmdc = { model: requested, mapped, stream: isStream };
      logReq();

      const chatReq = responsesToChatRequest(body);
      const up = await fetch(`${UPSTREAM}/v1/chat/completions`, {
        method: "POST",
        headers: buildUpstreamHeaders(req, { "Content-Type": "application/json" }),
        body: JSON.stringify(chatReq),
      });

      if (!isStream) {
        const text = await up.text();
        if (!up.ok) {
          res.writeHead(up.status, { "Content-Type": up.headers.get("content-type") || "application/json" });
          res.end(text);
          return;
        }
        try {
          const oai = JSON.parse(text);
          req._cmdc.usage = normalizeUsage(oai.usage);
          const respObj = chatResponseToResponses(oai, requested);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(respObj));
        } catch (e) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "上游响应解析失败: " + e.message, type: "api_error" } }));
        }
        return;
      }

      if (!up.ok) {
        const text = await up.text();
        res.writeHead(up.status, { "Content-Type": "application/json" });
        res.end(text);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const conv = new ResponsesStreamConverter(requested, estimateInputTokens(body));
      try {
        for await (const chunk of up.body) {
          const raw = Buffer.from(chunk).toString("utf8");
          const outText = conv.push(raw);
          if (outText) res.write(outText);
        }
      } catch (e) {
        console.warn(TAGW, "上游 responses 流中断:", e.message);
      }
      try {
        const tail = conv.finish();
        if (tail) res.write(tail);
      } catch (e) {
        console.warn(TAGW, "responses 收尾失败:", e.message);
      }
      req._cmdc.usage = normalizeUsage(conv.rawUsage);
      res.end();
      return;
    }

    // ---- 其他 /v1/* 通配透传 ----
    if (pathname.startsWith("/v1/")) {
      const upstreamPath = pathname;
      const headers = buildUpstreamHeaders(req, { "Content-Type": req.headers["content-type"] || "application/json" });
      const method = req.method;
      const init = { method, headers, redirect: "follow" };
      if (method !== "GET" && method !== "HEAD") {
        init.body = await readBody(req);
      }
      const up = await fetch(`${UPSTREAM}${upstreamPath}${url.search}`, init);
      await passThrough(res, up);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Not found: ${pathname}`, type: "invalid_request_error" } }));
  } catch (e) {
    console.error(TAGE, "处理请求出错:", e.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "api_error", message: "cmc-proxy 内部错误: " + e.message },
      })
    );
  }
});

server.listen(PORT, HOST, () => {
  const line = cBlue("=".repeat(58));
  console.log(line);
  console.log(cBlue("  cmc-proxy 已启动"));
  console.log(cBlue(`  监听地址   : http://${HOST}:${PORT}`));
  console.log(cBlue(`  上游端点   : ${UPSTREAM}`));
  console.log(cBlue(`  默认模型   : ${DEFAULT_MODEL}`));
  console.log(cBlue("-".repeat(58)));
  console.log(cBlue("  Claude Code 接入:  export ANTHROPIC_BASE_URL=http://localhost:" + PORT));
  console.log(cBlue("  Codex 接入:        base_url = http://localhost:" + PORT + "/v1  (wire_api = responses)"));
  console.log(line);
  // 启动时预热模型列表
  refreshModels(true);
});
