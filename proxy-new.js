#!/usr/bin/env node
/**
 * cmc-proxy (new core) — commandcode GOAT 订阅本地反代网关
 * =========================================================
 * 把 commandcode Provider API 反代到本机, 供 Claude Code / Codex 使用:
 *   - /v1/chat/completions  ->  https://api.commandcode.ai/provider/v1/chat/completions  (OpenAI 格式, 纯透传)
 *   - /v1/messages          ->  https://api.commandcode.ai/provider/v1/messages          (Anthropic 格式, 仅 Claude 模型)
 *   - /v1/messages (转换模式)->  https://api.commandcode.ai/provider/v1/chat/completions  (Anthropic -> OpenAI 协议转换)
 *   - /v1/responses         ->  https://api.commandcode.ai/provider/v1/chat/completions  (Responses -> OpenAI 协议转换)
 *   - /v1/models            ->  上游模型列表 (按配置过滤)
 *
 * 零第三方依赖, 仅需 Node.js >= 18 (内置 fetch / ReadableStream)。
 *
 * 启动:  node proxy-new.js [--port 5411] [--config config.json]
 *
 * 相对旧版核心的修复 (输入/输出契约不变, config.json 兼容):
 *   1. /v1/responses 工具历史丢失 (Codex 工具"带不上"的根因):
 *      真实 Codex (wire_api="responses") 将 function_call / function_call_output 作为
 *      *顶层 input item* 发送; 旧版只识别嵌在 role 消息 content 里的形态, 导致模型每轮
 *      都看不到自己已发起的工具调用与工具结果, 表现为重复调用/无视工具。新版完整支持:
 *      顶层 function_call(合并进前一条 assistant 消息)、function_call_output(-> role:"tool")、
 *      reasoning(跳过)、local_shell_call 等(跳过并告警), 同时保留旧版嵌套形态兼容。
 *   2. 缓存命中率间歇掉底:
 *      - 请求前缀逐字节稳定: Anthropic content block 与 OpenAI content part 1:1 映射,
 *        不再做会随轮次改变结构的字符串/数组折叠, 转换纯函数化;
 *      - cache_control 透传: Claude Code 在 system/消息块上携带的 ephemeral 标记映射为
 *        OpenAI content part 的 cache_control (实测 commandcode 上游接受且不影响缓存键,
 *        对支持显式缓存的后端则生效); 可用 config.cacheControlPassthrough=false 关闭;
 *      - 缓存亲和: 按会话注入稳定 user / prompt_cache_key (实测上游接受), 便于上游
 *        按会话做缓存路由; 可用 config.cacheAffinity=false 关闭。
 *   3. 流式转换块索引冲突修复: 旧版文本块固定占 index 0, 工具块从 0 开始分配,
 *      文本+工具混合输出时两个块共用 index 0; 新版统一自增分配。
 *   4. Responses 响应 usage 补全 input_tokens_details.cached_tokens /
 *      output_tokens_details.reasoning_tokens, Codex 侧缓存/思考量可见。
 *   5. 会话跟踪升级: Codex 优先读 session-id (兼容旧版 session_id) / thread-id 请求头
 *      作为会话标识, 同一 codex 会话跨 TCP 重连不再分裂编号, 与缓存亲和使用同一稳定标识;
 *      curl 等无会话头客户端仍回退 src:port + ua。
 *   6. Codex 0.150+ 新工具形态支持 (修复 apply_patch 死循环 / 延迟工具失效):
 *      - {"type":"custom"} freeform 工具 (apply_patch grammar) -> 转成 {"input": "<原文>"}
 *        单参数 function 供模型调用, 回传时还原为 custom_tool_call (codex 的 apply_patch
 *        handler 只接受 Custom payload, 收到 function_call 直接报错导致补丁反复失败);
 *      - {"type":"tool_search"} (nameless 延迟工具发现) -> 转成同名 function, codex 对
 *        FunctionCall 名为 tool_search 的调用走本地执行器, 打通 deferred 工具加载;
 *      - {"type":"web_search"} (nameless) 静默跳过 (链路无服务端执行环境);
 *      - {"type":"namespace"} 工具组展开为独立工具;
 *      - 历史条目 custom_tool_call / custom_tool_call_output / tool_search_call /
 *        tool_search_output 双向映射, 修复 freeform 工具调用历史丢失。
 *   7. 轮换计数按模型归属: 客户端显式请求其他模型 (如 blockedModels 中的 gpt-5.6-luna
 *      被上游 403) 的失败不再记到当前默认模型头上触发无谓轮换; blocked 模型转发时
 *      打印一次性告警; additional_tools 历史条目 (codex 内联的附加工具定义) 合并进
 *      请求 tools 并按名去重。
 */
"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// 访问日志颜色 (先于一切日志使用, 非 TTY/重定向时自动无色)
// ---------------------------------------------------------------------------
const C = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `${code}${s}${C.reset}` : String(s));
const cRed = paint(C.red);
const cGreen = paint(C.green);
const cYellow = paint(C.yellow);
const cCyan = paint(C.cyan);
const cMagenta = paint(C.magenta);
const cDim = paint(C.dim);
const cBlue = paint(C.blue);
const cOrange = paint("\x1b[38;5;208m"); // 256 色橙
const cBrightGreen = paint("\x1b[92m"); // 亮绿

// 日志标签 (前缀着色)
const TAGW = cYellow("[cmc-proxy]");
const TAGE = cRed("[cmc-proxy]");
const TAGI = cBlue("[cmc-proxy]");

// ---------------------------------------------------------------------------
// 配置加载 (与旧版完全兼容; 新增可选项见文件头注释)
// ---------------------------------------------------------------------------
const ROOT = __dirname;
const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
// --config 支持相对 (相对 proxy 脚本目录) 与绝对路径, 默认同目录 config.json
const configPath = path.resolve(ROOT, argVal("--config", "config.json"));

function loadConfig() {
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
  return {
    port: 5411,
    host: "127.0.0.1",
    upstream: "https://api.commandcode.ai/provider",
    apiKey: "",
    fallback: true,
    defaultModels: ["deepseek/deepseek-v4-flash"],
    modelMap: {},
    blockedModels: [],
  };
}

const config = loadConfig();
const PORT = parseInt(argVal("--port", config.port || 5411), 10);
const HOST = argVal("--host", config.host || "127.0.0.1");
const UPSTREAM = (config.upstream || "https://api.commandcode.ai/provider").replace(/\/+$/, "");
const API_KEY = process.env.CMDC_API_KEY || config.apiKey || "";

// 缓存优化开关 (可选配置, 默认开启; 关闭后回退为最朴素的转换行为)
const CC_PASSTHROUGH = config.cacheControlPassthrough !== false; // Anthropic cache_control -> OpenAI content part
const CACHE_AFFINITY = config.cacheAffinity !== false; // 按会话注入 user / prompt_cache_key

if (!API_KEY) {
  console.error(TAGE, "错误: 未配置 apiKey。请在 config.json 中填入你的 commandcode API key，");
  console.error(TAGE, "       或通过环境变量 CMDC_API_KEY 传入。");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 模型解析
// ---------------------------------------------------------------------------
const modelMap = config.modelMap || {};

// ---- 多模型轮换 (defaultModels, 数组格式) ----
// 第一个模型作为默认模型; 出错达阈值后逐个 fallback, 后续模型不重试(失败 1 次即切换), 循环进行。
// 兼容旧配置: 仅配置 defaultModel 时自动视为单元素数组。
const defaultModels = (Array.isArray(config.defaultModels) && config.defaultModels.length)
  ? config.defaultModels
  : [config.defaultModel || "deepseek/deepseek-v4-flash"];

// fallback 开关: 默认开启; 关闭时永远使用 defaultModels[0], 不做任何切换
const FALLBACK_ENABLED = config.fallback !== false;

// 轮换状态 (全局, 跨请求): 当前活动模型下标 + 失败计数
let activeModelIdx = 0;
let activeModelFails = 0;
const FIRST_FAIL_LIMIT = 3; // 第一个(默认)模型: 连续失败 3 次后切换
const OTHER_FAIL_LIMIT = 1; // fallback 模型: 失败 1 次即切换, 不重试

/** 当前应使用的默认模型 (初始为列表第一个) */
function currentDefaultModel() {
  return defaultModels[activeModelIdx % defaultModels.length];
}

/** 一次请求失败时调用: 达到阈值则切到下一个模型并返回 true (列表轮完回到第一个, 循环进行)。
 *  仅统计当前默认模型自身的失败: 客户端显式请求其他模型 (如 blockedModels 中的
 *  gpt-5.6-luna 被上游 403) 时, 失败不记到默认模型头上, 避免触发无谓轮换 */
function onRequestFail(failedModel) {
  if (!FALLBACK_ENABLED || defaultModels.length < 2) return false;
  if (failedModel && failedModel !== defaultModels[activeModelIdx]) return false;
  const limit = activeModelIdx === 0 ? FIRST_FAIL_LIMIT : OTHER_FAIL_LIMIT;
  activeModelFails += 1;
  if (activeModelFails < limit) return false;
  const from = defaultModels[activeModelIdx];
  activeModelIdx = (activeModelIdx + 1) % defaultModels.length;
  activeModelFails = 0;
  const to = defaultModels[activeModelIdx];
  console.warn(TAGW, `模型 ${from} 连续失败 ${limit} 次, 默认模型切换 → ${to}${activeModelIdx === 0 ? " (已循环回到第一个)" : ""}`);
  return true;
}

/** 一次请求成功时调用: 清零当前模型失败计数 (仅当成功的就是当前默认模型) */
function onRequestOk(okModel) {
  if (okModel && okModel !== defaultModels[activeModelIdx]) return;
  activeModelFails = 0;
}

// ---------------------------------------------------------------------------
// 上游模型列表缓存 (供 /v1/models 与模型目录匹配使用, 启动时异步刷新)
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

/**
 * 模型解析 helper:
 *   1. modelMap 显式映射优先
 *   2. 上游模型目录匹配: 精确 / 去前缀(无前缀名) / 大小写不敏感
 *      例: deepseek-v4-flash -> deepseek/deepseek-v4-flash, qwen3.8-max -> Qwen/Qwen3.8-Max
 *   3. 无任何匹配 -> fallback 到当前默认模型 (defaultModels 轮换指针)
 */
function resolveModel(requested) {
  if (!requested) return currentDefaultModel();

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

  // 3. 无匹配 -> 当前默认模型 (GOAT 无 Claude 模型, claude-* 也会落到这里)
  return currentDefaultModel();
}

/** 判断某模型是否需要走 Anthropic /messages 端点 (Claude 系) */
function isClaudeModel(model) {
  return /^claude(-|$)/.test(model);
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
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
 * 从上游 usage 对象中提取日志关心的字段 (兼容 OpenAI / Anthropic / Responses 三种格式):
 *   input / output / reasoning(rt) / cacheRead(cr) / cacheWrite(cw)
 * 注: input 返回"净输入"(总输入 - 缓存命中), 缓存命中量由 cacheRead 单独展示,
 *     两者之和才是上游返回的总输入 tokens。
 */
function normalizeUsage(u) {
  if (!u) return null;
  const pd = u.prompt_tokens_details || {};
  const cd = u.completion_tokens_details || {};
  const itd = u.input_tokens_details || {}; // Responses 格式
  const otd = u.output_tokens_details || {};
  const out = {};
  if (u.prompt_tokens != null) out.input = u.prompt_tokens; // OpenAI chat
  if (u.input_tokens != null) out.input = u.input_tokens; // Anthropic / Responses
  if (u.completion_tokens != null) out.output = u.completion_tokens; // OpenAI chat
  if (u.output_tokens != null) out.output = u.output_tokens; // Anthropic / Responses
  if (pd.cached_tokens !== undefined) out.cacheRead = pd.cached_tokens; // OpenAI chat
  else if (itd.cached_tokens !== undefined) out.cacheRead = itd.cached_tokens; // Responses
  else if (u.cache_read_input_tokens !== undefined) out.cacheRead = u.cache_read_input_tokens; // Anthropic
  if (u.cache_creation_input_tokens !== undefined) out.cacheWrite = u.cache_creation_input_tokens; // 上游扩展/Anthropic
  else if (pd.cache_creation_input_tokens !== undefined) out.cacheWrite = pd.cache_creation_input_tokens;
  if (cd.reasoning_tokens !== undefined) out.reasoning = cd.reasoning_tokens; // OpenAI chat (DeepSeek 思考量)
  else if (otd.reasoning_tokens !== undefined) out.reasoning = otd.reasoning_tokens; // Responses
  // in = in - cr: 扣掉缓存命中的部分, 剩余才是按原价计费的输入; 仅当 in > cr 才减 (避免异常数据把 in 归零)
  if (out.input != null && out.cacheRead != null) {
    out.input = out.input > out.cacheRead ? out.input - out.cacheRead : out.input;
  }
  return out;
}

function mapStopReason(openaiReason) {
  switch (openaiReason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
    case "end_turn":
    default:
      return "end_turn";
  }
}

// ---------------------------------------------------------------------------
// SSE 基础
// ---------------------------------------------------------------------------
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

function sseResponses(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function makeResponsesId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Anthropic -> OpenAI 请求转换 (前缀逐字节稳定 + cache_control 透传)
// ---------------------------------------------------------------------------
/**
 * content block -> OpenAI content part 的 1:1 映射。
 * 稳定性关键: Anthropic 块数组一律输出 part 数组(不做"单文本折叠成字符串"),
 * 这样 cache_control 标记位置随轮次移动时, 历史消息的 JSON 结构不会在字符串/数组间翻转,
 * 上游看到的请求前缀保持逐字节稳定 —— 这是前缀缓存命中的前提。
 */
function anthropicBlocksToParts(blocks) {
  const parts = [];
  for (const b of blocks) {
    if (b.type === "text" && b.text) {
      const p = { type: "text", text: b.text };
      if (CC_PASSTHROUGH && b.cache_control) p.cache_control = b.cache_control;
      parts.push(p);
    } else if (b.type === "image") {
      const src = b.source;
      if (src && src.type === "base64" && src.media_type && src.data) {
        parts.push({ type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } });
      } else if (src && src.type === "url" && src.url) {
        parts.push({ type: "image_url", image_url: { url: src.url } });
      }
    }
    // 其他块类型 (thinking 等上游无对应概念) 跳过
  }
  return parts;
}

/** tool_result 块内容 -> tool 消息文本 */
function toolResultToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((x) => (x.type === "text" ? x.text : `[${x.type}]`))
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

function anthropicMessageToOpenAI(msg) {
  const role = msg.role;

  if (role === "user") {
    const toolMsgs = [];
    const parts = [];
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === "tool_result") {
          // OpenAI 要求 tool 消息独立成条
          const c = toolResultToText(b.content);
          toolMsgs.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content: typeof c === "string" && c.length ? c : JSON.stringify(c),
          });
        } else if (b.type === "text" || b.type === "image") {
          const converted = anthropicBlocksToParts([b]);
          parts.push(...converted);
        }
      }
    } else if (typeof msg.content === "string" && msg.content) {
      parts.push({ type: "text", text: msg.content });
    }
    const out = [...toolMsgs];
    if (parts.length) out.push({ role: "user", content: parts });
    return out;
  }

  if (role === "assistant") {
    // 文本折叠为字符串 + tool_use -> tool_calls。assistant 文本不携带 cache_control
    // (Claude Code 的标记只出现在 system/tools/最近的 user 消息上), 折叠不影响前缀稳定性。
    let text = "";
    const toolCalls = [];
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === "text" && b.text) text += b.text;
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
          });
        }
      }
    }
    const omsg = { role: "assistant" };
    if (text) omsg.content = text;
    if (toolCalls.length) omsg.tool_calls = toolCalls;
    return omsg;
  }

  // system 等其他 role 直接透传
  return { role, content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) };
}

/** 缓存亲和 user 字段: 仅取稳定的会话标识 (Claude Code 会话 UUID), 无则不注入 */
function affinityUser(sessionKey) {
  if (!CACHE_AFFINITY || !sessionKey) return undefined;
  if (sessionKey.startsWith("cc:")) {
    const id = sessionKey.slice(3);
    return id.length && id.length <= 64 ? id : `cc-${id.slice(0, 56)}`;
  }
  return undefined; // src:port|ua 形式的 key 含每次连接都变的端口, 注入反而破坏稳定性
}

function anthropicToOpenAIRequest(body, sessionKey) {
  const mapped = resolveModel(body.model);
  const messages = [];
  // 顶层 system: 块数组 1:1 映射为 part 数组 (保结构稳定 + cache_control 透传)
  if (body.system != null) {
    if (typeof body.system === "string") {
      if (body.system) messages.push({ role: "system", content: body.system });
    } else if (Array.isArray(body.system)) {
      const parts = anthropicBlocksToParts(body.system);
      if (parts.length) messages.push({ role: "system", content: parts });
    }
  }
  // 逐条转换 (user 消息可能展开为多条: tool_result 拆独立 tool 消息)
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
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) req.stop = body.stop_sequences;
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
  const tc = body.tool_choice;
  if (tc && typeof tc === "object") {
    if (tc.type === "tool" && tc.name) req.tool_choice = { type: "function", function: { name: tc.name } };
    else if (tc.type === "auto") req.tool_choice = "auto";
    else if (tc.type === "any") req.tool_choice = "required";
    else if (tc.type === "none") req.tool_choice = "none";
  } else if (tc === "auto" || tc === "none") {
    req.tool_choice = tc;
  }
  if (body.stream) req.stream_options = { include_usage: true };
  const user = affinityUser(sessionKey);
  if (user) req.user = user;
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
  const pt = u.prompt_tokens ?? 0;
  const ct = pd.cached_tokens ?? 0;
  const usage = {
    // input_tokens 为净输入 (仅当 in > cr 才减, 避免异常数据归零), 与日志 in=in-cr 保持一致
    input_tokens: pt > ct ? pt - ct : pt,
    output_tokens: u.completion_tokens ?? 0,
  };
  const cr = pd.cached_tokens ?? u.cache_read_input_tokens;
  const cw = u.cache_creation_input_tokens ?? pd.cache_creation_input_tokens;
  if (cr !== undefined) usage.cache_read_input_tokens = cr;
  if (cw !== undefined) usage.cache_creation_input_tokens = cw;
  return {
    id: obj.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: requestedModel || obj.model,
    content: contentBlocks,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage,
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
    this.nextBlockIndex = 0; // 统一自增的块索引 (文本与工具共用, 修复旧版 index 冲突)
    this.toolState = {}; // 上游 tool_call index -> {id, name, buffer, blockIndex}
    this.activeBlocks = []; // 已开始的块索引
    this.finished = false;
    this.stopReason = "end_turn";
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.cacheRead = undefined; // cache_read_input_tokens
    this.cacheCreation = undefined; // cache_creation_input_tokens
    this.rawUsage = null; // 最后一次完整 usage 对象 (供日志输出)
    this.localToolSeq = 0;
    this.pending = "";
  }

  /** 从 OpenAI chunk 中提取 usage (chat/completions 流式的 usage 在末尾 chunk) */
  updateUsageFromChunk(json) {
    if (!json.usage) return;
    this.rawUsage = json.usage;
    const u = json.usage;
    const pd = u.prompt_tokens_details || {};
    // input_tokens 存净输入 (仅当 in > cr 才减, 避免异常数据归零), 与日志 in=in-cr 及非流式 openAIToAnthropic 保持一致
    if (u.prompt_tokens != null) {
      const ct = pd.cached_tokens ?? 0;
      this.usage.input_tokens = u.prompt_tokens > ct ? u.prompt_tokens - ct : u.prompt_tokens;
    }
    if (u.completion_tokens != null) this.usage.output_tokens = u.completion_tokens;
    if (pd.cached_tokens !== undefined) this.cacheRead = pd.cached_tokens;
    const cw = u.cache_creation_input_tokens ?? pd.cache_creation_input_tokens;
    if (cw !== undefined) this.cacheCreation = cw;
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
      if (!this.textBlock) {
        this.textBlock = this.nextBlockIndex++;
        this.activeBlocks.push(this.textBlock);
        events.push(
          sse(
            "content_block_start",
            JSON.stringify({
              type: "content_block_start",
              index: this.textBlock,
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
            index: this.textBlock,
            delta: { type: "text_delta", text: delta.content },
          })
        )
      );
    }

    // 工具调用增量
    for (const tc of delta.tool_calls || []) {
      const st = this.toolState[tc.index] || (this.toolState[tc.index] = { buffer: "" });
      if (tc.id) st.id = tc.id;
      if (tc.function) {
        if (tc.function.name) st.name = tc.function.name;
        if (tc.function.arguments) st.buffer += tc.function.arguments;
      }
      if (st.blockIndex === undefined) {
        st.blockIndex = this.nextBlockIndex++;
        this.activeBlocks.push(st.blockIndex);
        events.push(
          sse(
            "content_block_start",
            JSON.stringify({
              type: "content_block_start",
              index: st.blockIndex,
              content_block: {
                type: "tool_use",
                id: st.id || `toolu_local_${this.localToolSeq++}`,
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
        // 带 input_tokens(净输入): 上游 usage 在流末尾返回, message_delta 是最后能修正客户端用量的机会
        // (Claude Code 按 input_tokens + cache_read_input_tokens 统计, 若此处不带净输入会与 message_start 的估算值重复计算缓存)
        usage: this.usageObject(true),
      })
    );
    out += sse("message_stop", JSON.stringify({ type: "message_stop" }));
    return out;
  }
}

// ---------------------------------------------------------------------------
// Responses API (Codex wire_api="responses") -> Chat Completions 请求转换
// ---------------------------------------------------------------------------
/**
 * Responses input item 形态 (真实 Codex 全部为顶层 item, role 消息只是其中一类):
 *   {type:"message", role, content:[...]}        普通消息
 *   {type:"function_call", call_id, name, arguments}          模型发起的工具调用 (历史回放)
 *   {type:"function_call_output", call_id, output}            工具执行结果
 *   {type:"reasoning", ...}                        思考条目 (自定义模型无此概念, 跳过)
 *   {type:"local_shell_call"|"local_shell_call_output"|...}   保留类型, 跳过并告警
 * 旧版只识别嵌在 user 消息 content 里的 function_call_output, 顶层条目全部被静默丢弃,
 * 模型看不到工具调用历史 —— 即"Codex 工具带不上"的根因。
 */
const skippedItemTypesWarned = new Set();

function warnSkippedItemType(type) {
  if (skippedItemTypesWarned.has(type)) return;
  skippedItemTypesWarned.add(type);
  console.warn(TAGW, `跳过不支持的 Responses input item 类型: ${type} (历史中该条目不会转发给上游)`);
}

const skippedToolTypesWarned = new Set();

function warnSkippedToolType(type) {
  if (skippedToolTypesWarned.has(type)) return;
  skippedToolTypesWarned.add(type);
  console.warn(TAGW, `跳过无法转换的工具类型: ${type} (该工具在此链路不可用)`);
}

/** 追加一条工具调用: 合并进紧邻的前一条 assistant 消息 (连续多个调用自然聚成一条 tool_calls),
 *  与 chat/completions "assistant(tool_calls) -> tool 结果" 的消息序对齐 */
function pushToolCallToMessages(messages, call) {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") {
    (last.tool_calls = last.tool_calls || []).push(call);
  } else {
    messages.push({ role: "assistant", tool_calls: [call] });
  }
}

function stringifyMaybeJSON(v) {
  return typeof v === "string" ? v : JSON.stringify(v ?? "");
}

function responsesUserBlocksToParts(blocks) {
  const parts = [];
  for (const b of blocks) {
    if (b.type === "input_text" && b.text) {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "input_image") {
      const url = b.image_url || (b.source && b.source.url);
      if (url) parts.push({ type: "image_url", image_url: { url } });
    }
  }
  return parts;
}

function responsesInputToChatMessages(input) {
  const messages = [];
  // codex 0.150 alpha 会把附加工具定义 (deferred 工具加载结果等) 以 additional_tools
  // 条目内联在对话历史中, 收集后合并进请求 tools (见 responsesToChatRequest)
  const additionalTools = [];
  // input 可以是字符串
  if (typeof input === "string") {
    if (input) messages.push({ role: "user", content: input });
    return { messages, additionalTools };
  }
  if (!Array.isArray(input)) return { messages, additionalTools };

  for (const item of input) {
    if (!item || typeof item !== "object") {
      // 数组内的裸字符串 (少见但合法): 视为一条 user 消息
      if (typeof item === "string" && item) messages.push({ role: "user", content: item });
      continue;
    }
    const type = item.type || (item.role ? "message" : "");

    if (type === "additional_tools" && Array.isArray(item.tools)) {
      additionalTools.push(...item.tools);
      continue;
    }

    if (type === "message" || (!type && item.role)) {
      const role = item.role;
      const blocks = Array.isArray(item.content) ? item.content : [];
      if (role === "user") {
        // 兼容旧版形态: function_call_output 嵌在 user 消息 content 里
        const nestedOutputs = blocks.filter((b) => b.type === "function_call_output");
        for (const b of nestedOutputs) {
          messages.push({
            role: "tool",
            tool_call_id: b.call_id || b.id || "",
            content: stringifyMaybeJSON(b.output),
          });
        }
        const parts = responsesUserBlocksToParts(blocks.filter((b) => b.type !== "function_call_output"));
        if (parts.length) {
          // 单文本折叠成字符串 (结构确定, 不随轮次变化)
          messages.push({
            role: "user",
            content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
          });
        } else if (!nestedOutputs.length && typeof item.content === "string" && item.content) {
          messages.push({ role: "user", content: item.content });
        }
      } else if (role === "assistant") {
        const text = blocks
          .filter((b) => b.type === "output_text" || b.type === "input_text")
          .map((b) => b.text || "")
          .join("");
        const m = { role: "assistant" };
        if (text) m.content = text;
        messages.push(m);
      } else if (role === "developer" || role === "system") {
        const text = blocks
          .filter((b) => b.type === "input_text" || b.type === "output_text")
          .map((b) => b.text || "")
          .join("");
        if (text) messages.push({ role: "system", content: text });
      }
      continue;
    }

    if (type === "function_call") {
      // 顶层工具调用: 合并进紧邻的前一条 assistant 消息
      pushToolCallToMessages(messages, {
        id: item.call_id || item.id || `call_local_${messages.length}`,
        type: "function",
        function: {
          name: item.name || "unknown",
          arguments: stringifyMaybeJSON(item.arguments ?? {}),
        },
      });
      continue;
    }

    if (type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || item.id || "",
        content: stringifyMaybeJSON(item.output),
      });
      continue;
    }

    if (type === "custom_tool_call") {
      // freeform 工具调用历史: input 为原文 (如补丁文本), 统一包成 {"input": ...} 与
      // 我们发给模型时的参数形态保持一致 (前缀稳定)
      pushToolCallToMessages(messages, {
        id: item.call_id || item.id || `call_local_${messages.length}`,
        type: "function",
        function: {
          name: item.name || "unknown",
          arguments: JSON.stringify({ input: typeof item.input === "string" ? item.input : stringifyMaybeJSON(item.input ?? "") }),
        },
      });
      continue;
    }

    if (type === "custom_tool_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || item.id || "",
        content: stringifyMaybeJSON(item.output),
      });
      continue;
    }

    if (type === "tool_search_call") {
      // codex 本地执行的延迟工具发现调用 (arguments 为对象)
      pushToolCallToMessages(messages, {
        id: item.call_id || item.id || `call_local_${messages.length}`,
        type: "function",
        function: { name: "tool_search", arguments: stringifyMaybeJSON(item.arguments ?? {}) },
      });
      continue;
    }

    if (type === "tool_search_output") {
      // 加载到的 deferred 工具定义 -> 文本化给模型阅读 (中途无法再追加 tools 参数)
      const tools = Array.isArray(item.tools) ? item.tools : [];
      const text = tools
        .map((t) => (t && typeof t === "object" ? JSON.stringify(t) : String(t)))
        .join("\n");
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || item.id || "",
        content: text || "(no tools matched)",
      });
      continue;
    }

    if (type === "reasoning") continue; // 思考条目: 自定义模型无对应概念, 跳过

    if (type === "item_reference") {
      warnSkippedItemType(type);
      continue;
    }

    if (type) warnSkippedItemType(type); // local_shell_call / computer_call 等保留类型
  }
  return { messages, additionalTools };
}

/** 把 Responses 请求体转换为 chat/completions 请求体 */
function responsesToChatRequest(body, sessionKey) {
  const mapped = resolveModel(body.model);
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  const { messages: inputMessages, additionalTools } = responsesInputToChatMessages(body.input);
  messages.push(...inputMessages);
  const req = { model: mapped, messages, stream: !!body.stream };
  // 钳制 max_output_tokens 到最小 16 (部分上游模型要求, 如 gpt-5.6-sol)
  if (body.max_output_tokens != null) req.max_tokens = Math.max(16, body.max_output_tokens);
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (body.parallel_tool_calls === true || body.parallel_tool_calls === false) {
    req.parallel_tool_calls = body.parallel_tool_calls;
  }
  // 本请求中被转为 function 的 freeform(custom) 工具名集合, 回传时还原 custom_tool_call
  const customToolNames = new Set();
  const addedToolNames = new Set();
  const chatTools = [];
  const convertTool = (t) => {
      if (!t || typeof t !== "object") return;
      if (t.type === "custom" && t.name) {
        // freeform/custom 工具 (如 apply_patch grammar): chat/completions 无对应概念,
        // 统一转成 {"input": "<原文>"} 单参数 function, 回传时还原 custom_tool_call
        // (codex 的 apply_patch handler 只接受 Custom payload, 收到 function_call 直接报错)
        customToolNames.add(t.name);
        if (addedToolNames.has(t.name)) return; // 按名去重: 顶层定义优先
        addedToolNames.add(t.name);
        chatTools.push({
          type: "function",
          function: {
            name: t.name,
            description: t.description || "",
            parameters: {
              type: "object",
              properties: {
                input: { type: "string", description: "The full raw text input for this tool (for patch tools: the complete patch text)." },
              },
              required: ["input"],
            },
          },
        });
        return;
      }
      if (t.type === "tool_search") {
        // nameless 延迟工具发现工具: codex 对 FunctionCall 名为 tool_search 的调用走本地
        // 执行器, 转成同名 function 即可打通 deferred 工具加载
        if (addedToolNames.has("tool_search")) return;
        addedToolNames.add("tool_search");
        chatTools.push({
          type: "function",
          function: {
            name: "tool_search",
            description: t.description || "",
            parameters: (t.parameters && typeof t.parameters === "object")
              ? t.parameters
              : { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
          },
        });
        return;
      }
      if (t.type === "web_search") {
        // nameless 服务端搜索工具: 中转链路无 OpenAI 服务端执行环境, 静默跳过
        warnSkippedToolType("web_search");
        return;
      }
      if (t.type === "namespace" && Array.isArray(t.tools)) {
        // 工具组 (如按 MCP server 分组): 展开为独立工具
        for (const nt of t.tools) convertTool(nt);
        return;
      }
      const fn = t.function && typeof t.function === "object" ? t.function : t;
      if (!fn.name) {
        warnSkippedToolType(t.type || "unknown");
        return;
      }
      if (addedToolNames.has(fn.name)) return;
      addedToolNames.add(fn.name);
      chatTools.push({
        type: "function",
        function: {
          name: fn.name,
          description: fn.description || "",
          parameters: fn.parameters || { type: "object", properties: {} },
        },
      });
  };
  if (body.tools && Array.isArray(body.tools) && body.tools.length) {
    for (const t of body.tools) convertTool(t);
  }
  // 历史中内联的附加工具定义 (additional_tools 条目): 合并进 tools, 按名去重
  for (const t of additionalTools) convertTool(t);
  if (chatTools.length) req.tools = chatTools;
  if (body.tool_choice && typeof body.tool_choice === "object" && body.tool_choice.type === "function") {
    const choiceName = body.tool_choice.name || (body.tool_choice.function && body.tool_choice.function.name);
    if (choiceName) req.tool_choice = { type: "function", function: { name: choiceName } };
  } else if (body.tool_choice === "auto" || body.tool_choice === "required" || body.tool_choice === "none") {
    req.tool_choice = body.tool_choice;
  }
  if (body.stream) req.stream_options = { include_usage: true };
  // 缓存亲和: Codex 自带 conversation 级 prompt_cache_key, 直接透传并同步到 user
  if (CACHE_AFFINITY && typeof body.prompt_cache_key === "string" && body.prompt_cache_key) {
    req.prompt_cache_key = body.prompt_cache_key;
    if (body.prompt_cache_key.length <= 64) req.user = body.prompt_cache_key;
  }
  return { chat: req, customToolNames };
}

// ---------------------------------------------------------------------------
// Chat Completions -> Responses 响应转换
// ---------------------------------------------------------------------------
function chatUsageToResponses(u) {
  const pd = (u && u.prompt_tokens_details) || {};
  const cd = (u && u.completion_tokens_details) || {};
  const input = (u && u.prompt_tokens) ?? 0;
  const output = (u && u.completion_tokens) ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: (u && u.total_tokens) ?? input + output,
    input_tokens_details: { cached_tokens: pd.cached_tokens ?? 0 },
    output_tokens_details: { reasoning_tokens: cd.reasoning_tokens ?? 0 },
  };
}

/** 从模型发出的 function arguments 中提取 freeform 工具的原文 input:
 *  兼容 {"input": "..."} JSON、纯 JSON 字符串、裸补丁文本三种形态;
 *  并兜底处理模型在 JSON 字符串里直接输出真实换行 (严格 JSON 非法) 的情况 */
function customInputFromArguments(args) {
  if (typeof args !== "string") return JSON.stringify(args ?? "");
  const t = args.trim();
  try {
    const parsed = JSON.parse(t);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* 落到宽松解析 */ }
  const m = t.match(/^\{\s*"input"\s*:\s*"([\s\S]*)"\s*\}$/);
  if (m) {
    return m[1]
      .replace(/\\n/g, "\n")
      .replace(/\r/g, "")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return args;
}

function chatMessageToResponsesOutput(msg, customToolNames) {
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
    if (customToolNames && customToolNames.has(tc.function.name)) {
      // freeform 工具: 还原为 custom_tool_call (codex 的 apply_patch handler 只接受
      // ToolPayload::Custom, 收到 function_call 直接报 "unsupported payload")
      output.push({
        type: "custom_tool_call",
        id: makeResponsesId("ctc"),
        status: "completed",
        call_id: tc.id,
        name: tc.function.name,
        input: customInputFromArguments(tc.function.arguments),
      });
    } else {
      output.push({
        type: "function_call",
        id: makeResponsesId("fc"),
        status: "completed",
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments || "{}",
      });
    }
  }
  return output;
}

/** 非流式: chat.completion -> response 对象 */
function chatResponseToResponses(obj, requestedModel, customToolNames) {
  const choice = obj.choices && obj.choices[0] ? obj.choices[0] : {};
  const msg = choice.message || {};
  const output = chatMessageToResponsesOutput(msg, customToolNames);
  return {
    id: makeResponsesId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: requestedModel || obj.model,
    status: "completed",
    output,
    usage: chatUsageToResponses(obj.usage),
    output_text: msg.content || "",
  };
}

/** 流式: chat SSE chunks -> Responses SSE 事件序列 */
class ResponsesStreamConverter {
  constructor(requestedModel, estimateInputTokens = 0, customToolNames = null) {
    this.requestedModel = requestedModel;
    this.customToolNames = customToolNames; // 本请求中转为 function 的 freeform 工具名
    this.resp = {
      id: makeResponsesId("resp"),
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: requestedModel,
      status: "in_progress",
      output: [],
    };
    this.usage = {
      input_tokens: estimateInputTokens || 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    };
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
      const merged = chatUsageToResponses({
        ...u,
        prompt_tokens: u.prompt_tokens ?? this.usage.input_tokens,
        completion_tokens: u.completion_tokens ?? this.usage.output_tokens,
      });
      this.usage = merged;
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
        st.isCustom = !!(this.customToolNames && st.name && this.customToolNames.has(st.name));
        st.item = st.isCustom
          ? { id: makeResponsesId("ctc"), type: "custom_tool_call", status: "in_progress", call_id: st.callId || `call_${Date.now()}`, name: st.name || "function", input: "" }
          : { id: makeResponsesId("fc"), type: "function_call", status: "in_progress", call_id: st.callId || `call_${Date.now()}`, name: st.name || "function", arguments: "" };
        st.outputIndex = this.resp.output.length;
        events.push(sseResponses({ type: "response.output_item.added", output_index: st.outputIndex, item: { ...st.item } }));
      }
      if (tc.function && tc.function.arguments) {
        // custom 工具不流式下发 input: 模型产出的是 {"input": ...} JSON 片段, 直接转发
        // 会污染 codex 的流式补丁解析器 (它期望纯补丁文本), 统一在 output_item.done 补全
        if (!st.isCustom) {
          events.push(sseResponses({
            type: "response.function_call_arguments.delta",
            item_id: st.item.id,
            output_index: st.outputIndex,
            delta: tc.function.arguments,
          }));
        }
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
      const doneItem = st.isCustom
        ? {
            ...st.item,
            status: "completed",
            call_id: st.callId || st.item.call_id,
            name: st.name || st.item.name,
            input: customInputFromArguments(st.argsBuf),
          }
        : {
            ...st.item,
            status: "completed",
            call_id: st.callId || st.item.call_id,
            name: st.name || st.item.name,
            arguments: st.argsBuf,
          };
      if (!st.isCustom) {
        push({ type: "response.function_call_arguments.done", item_id: st.item.id, output_index: st.outputIndex, arguments: st.argsBuf });
      }
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
 * 发起上游请求并统一处理模型轮换计数 (计数按模型归属, 见 onRequestFail/onRequestOk):
 *   - fetch 网络层抛错 / 上游返回非 2xx → onRequestFail(requestedModel)
 *   - 上游 2xx → onRequestOk(requestedModel)
 * 调用方无需重复计数; 网络抛错时原样向上抛, 由调用方返回 502。
 */
async function upstreamFetch(url, init, requestedModel) {
  if (requestedModel && blockedSet.has(requestedModel)) warnBlockedModel(requestedModel);
  let r;
  try {
    r = await fetch(url, init);
  } catch (e) {
    onRequestFail(requestedModel);
    throw e;
  }
  if (!r.ok) onRequestFail(requestedModel);
  else onRequestOk(requestedModel);
  return r;
}

const blockedModelWarned = new Set();
function warnBlockedModel(model) {
  if (blockedModelWarned.has(model)) return;
  blockedModelWarned.add(model);
  console.warn(TAGW, `模型 ${model} 在 config.blockedModels 中 (订阅计划不可用), 仍按原样转发, 上游可能返回 403; 如需改走其他模型可在 config.modelMap 中映射`);
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

/** 转换路径共用的上游流消费 + SSE 转换 + usage 收集 */
async function pumpConvertedStream(up, conv, res, tag) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  try {
    for await (const chunk of up.body) {
      // undici 流式 chunk 是 Uint8Array, 必须经 Buffer.from 才能正确 utf8 解码
      const raw = Buffer.from(chunk).toString("utf8");
      if (process.env.CMC_DEBUG) process.stderr.write(`[DBG-UP-${tag}] ` + raw.replace(/\n/g, "\\n").slice(0, 300) + "\n");
      const outText = conv.push(raw);
      if (outText) res.write(outText);
    }
  } catch (e) {
    console.warn(TAGW, `上游 ${tag} 流中断:`, e.message);
  }
  try {
    const tail = conv.finish();
    if (tail) res.write(tail);
  } catch (e) {
    console.warn(TAGW, `${tag} 收尾 SSE 失败:`, e.message);
  }
  res.end();
}

// ---------------------------------------------------------------------------
// 用量统计
// ---------------------------------------------------------------------------
// 1) 滚动统计: ch 只输出按会话累计的缓存命中率, ts(速度)仍按最近 1 / 10 / 50 次请求滚动统计;
//    每次请求完成时输出, ts 值个数按历史请求数: 1 次显示 1 值 / 2-10 次显示 2 值 / >=11 次显示 3 值
// 2) 当前次 ch 不直接输出, 仅在 <50% 时输出 gap (与上次低命中请求的序号差)
// 2) TOD/ALL: 按天累计与进程累计, 每 STATS_EVERY 个请求打印 (环境变量 CMC_STATS_EVERY 可调, 默认 10),
//    跨天打印上日汇总; 当天启动时 TOD 与 ALL 一致, 省略 ALL
const STATS_EVERY = parseInt(process.env.CMC_STATS_EVERY || "10", 10);
const RECENT_N = 50;
const dayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fmtNum = (n) =>
  n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n);
const zeroAgg = () => ({ req: 0, in: 0, out: 0, rt: 0, cr: 0, cw: 0, ms: 0 });
const stats = { day: null, today: zeroAgg(), total: zeroAgg(), recent: [] };

/** 最近 n 个请求的聚合 */
function winAgg(n) {
  const slice = stats.recent.slice(-n);
  const agg = { in: 0, out: 0, cr: 0, ms: 0 };
  for (const r of slice) {
    agg.in += r.in;
    agg.out += r.out;
    agg.cr += r.cr;
    agg.ms += r.ms;
  }
  return agg;
}

/** 速度数字格式化: 整数去 .0 */
const fmtSpeed = (v) => (v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, ""));

/** 生成滚动统计串: "ch:87% ts:33/s,40/s,50/s" (ch 为会话累计, ts 为滚动窗口, 各自波段色) */
function movingStatsStr(session) {
  // ch: 按会话累计 (session.in / session.cr), 无会话时退化为当前次
  const chIn = session ? session.in : 0;
  const chCr = session ? session.cr : 0;
  const chTotal = chIn + chCr;
  const chPct = chTotal > 0 ? Math.round((chCr / chTotal) * 100) : 0;
  const chStr = cacheSegment("ch:" + (chTotal > 0 ? chPct + "%" : "-"), chPct);
  const n = stats.recent.length;
  const levels = n >= 11 ? [1, 10, 50] : n >= 2 ? [1, 10] : [1];
  const tsParts = levels.map((win, i) => {
    const w = winAgg(win);
    const v = w.ms > 0 ? w.out / (w.ms / 1000) : 0;
    const text = (i === 0 ? "ts:" : ",") + (w.ms > 0 ? fmtSpeed(v) + "/s" : "-");
    return speedSegment(text, v);
  });
  return ` ${chStr} ${tsParts.join("")}`;
}

/** 打印 TOD/ALL 统计行 (ch 与 ts 用波段色) */
function statsLine(label, agg) {
  if (!agg || !agg.req) return;
  const totalIn = agg.in + agg.cr;
  const pct = totalIn > 0 ? Math.round((agg.cr / totalIn) * 100) : 0;
  const chStr = cacheSegment("ch:" + (totalIn > 0 ? pct + "%" : "-"), pct);
  const v = agg.ms > 0 ? agg.out / (agg.ms / 1000) : 0;
  const tsStr = speedSegment("ts:" + (agg.ms > 0 ? fmtSpeed(v) + "/s" : "-"), v);
  console.log(
    `${cDim(`[${logTs(Date.now())}]`)} ${cBlue("STATS")} ${label} req:${agg.req} in:${fmtNum(agg.in)} out:${fmtNum(agg.out)} rt:${fmtNum(agg.rt)} cr:${fmtNum(agg.cr)} cw:${fmtNum(agg.cw)} ${chStr} ${tsStr}`
  );
}

/** 打印 TOD/ALL 两行 (当天启动时 TOD 与 ALL 一致, 省略 ALL) */
function logStats() {
  statsLine("TOD", stats.today);
  const same =
    stats.today.req === stats.total.req &&
    ["in", "out", "rt", "cr", "cw", "ms"].every((k) => stats.today[k] === stats.total[k]);
  if (!same) statsLine("ALL", stats.total);
}

/** 记录一条请求: TOD/ALL 全部计入; 滚动窗口仅计入有 usage 的请求 (trackRolling) */
function accumulate(rec, trackRolling) {
  stats.today.req += 1;
  stats.total.req += 1;
  for (const k of ["in", "out", "rt", "cr", "cw", "ms"]) {
    stats.today[k] += rec[k];
    stats.total[k] += rec[k];
  }
  if (trackRolling) {
    stats.recent.push(rec);
    if (stats.recent.length > RECENT_N) stats.recent.shift();
  }
}

// ---------------------------------------------------------------------------
// 请求前缀分叉检测 (定位缓存命中率低的来源)
// ---------------------------------------------------------------------------
// 对转换后的上游请求逐条消息做哈希, 与该会话上一次请求对比:
//   - 纯追加 (上次的全部消息与本次一致) -> 健康, 不输出
//   - 在第 i 条消息处分叉 -> RES 行输出红色 pfx~i (该位置之后本轮必然无法命中前缀缓存)
//   - system/tools 变化   -> pfx~tools
//   - 历史变短 (压缩/重写) -> pfx<本次条数
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
function prefixDivergeMark(session, msgs, toolsJson) {
  if (!session) return "";
  const cur = { tools: sha1(toolsJson), msgs: msgs.map((m) => sha1(JSON.stringify(m))) };
  const prev = session.pfx;
  session.pfx = cur;
  if (!prev) return ""; // 首次请求, 无基线
  if (prev.tools !== cur.tools) return "pfx~tools";
  let i = 0;
  const common = Math.min(prev.msgs.length, cur.msgs.length);
  while (i < common && prev.msgs[i] === cur.msgs[i]) i++;
  if (i === common) {
    if (cur.msgs.length >= prev.msgs.length) return ""; // 纯追加, 健康
    return `pfx<${cur.msgs.length}`; // 历史变短 (压缩)
  }
  return `pfx~${i}`;
}

// ---------------------------------------------------------------------------
// 会话跟踪 (按本地 agent 进程区分, 自增编号)
// ---------------------------------------------------------------------------
// 会话 key 优先级 (稳定标识优先, 端口回退仅作最后兜底):
//   1) x-claude-code-session-id —— Claude Code 每会话唯一 UUID, 跨连接稳定
//   2) session-id (兼容旧版 session_id 下划线头名) —— Codex v0.147+ 每请求携带,
//      进程生命周期内稳定的 UUID; 同一 codex 会话跨 TCP 重连不会分裂
//   3) thread-id —— Codex 对话线程标识, codex resume 恢复后仍保持不变
//   4) src:port + ua —— curl 等无会话头的客户端, 靠 TCP 源端口近似区分
// 每个会话维护:
//   id              —— 自增会话编号 (日志时间后显示 #id, 如 [08:28:48.943]#22)
//   seq             —— 请求序号 (仅对解析到 usage 的请求递增, 与 ch 统计同口径)
//   lastLowCacheSeq —— 最近一次 cachehit<50% 的请求序号 (用于计算 gap)
//   in / cr         —— 会话累计净输入 / 缓存读 (仅计有 usage 的请求), 用于输出会话累计 ch
const MODEL_PATHS = ["/v1/messages", "/v1/chat/completions", "/v1/responses"];
const sessions = new Map();
let nextSessionId = 1;
function getSession(key) {
  let s = sessions.get(key);
  if (!s) {
    s = { id: nextSessionId++, seq: 0, lastLowCacheSeq: null, in: 0, cr: 0, pfx: null };
    sessions.set(key, s);
  }
  return s;
}

function logTs(ms) {
  const d = new Date(ms);
  return `${d.toLocaleTimeString("zh-CN", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** 字符串哈希 (djb2 变体), 用于 model 名 -> 颜色映射 */
function hashCode(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}
/** model 块颜色: 按模型字符串哈希到一组高辨识度颜色 —— 同模型恒同色, 不同模型尽量异色 */
const MODEL_COLORS = [cCyan, cMagenta, cYellow, cGreen, cBlue, cOrange, cBrightGreen];
const modelColor = (name) => MODEL_COLORS[hashCode(name) % MODEL_COLORS.length];

/** 按 HTTP 状态码着色: 2xx 绿 / 4xx 黄 / 5xx 红 */
function cStatus(code) {
  const s = String(code);
  if (code >= 500) return cRed(s);
  if (code >= 400) return cYellow(s);
  if (code >= 300) return cCyan(s);
  return cGreen(s);
}

/** 速度波段色: <20 红 / 20-39 橙 / 40-59 黄 / 60-79 绿 / >=80 亮绿 (text 为整段含前缀/逗号, v 为数值) */
function speedSegment(text, v) {
  if (v >= 80) return cBrightGreen(text);
  if (v >= 60) return cGreen(text);
  if (v >= 40) return cYellow(text);
  if (v >= 20) return cOrange(text);
  return cRed(text);
}

/** 缓存命中率波段色(5档): <60 红 / 60-79 橙 / 80-89 黄 / 90-94 绿 / >=95 亮绿 (text 为整段含前缀/逗号, pct 为数值) */
function cacheSegment(text, pct) {
  if (pct >= 95) return cBrightGreen(text);
  if (pct >= 90) return cGreen(text);
  if (pct >= 80) return cYellow(text);
  if (pct >= 60) return cOrange(text);
  return cRed(text);
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
  req._cmdc = { model: null, mapped: null, stream: null, reqLogged: false, usage: null, bodyBytes: 0 };
  // 会话归属: 仅 model 类请求计入会话, 自增编号。会话 key 按稳定标识优先级判定,
  // 见上方 MODEL_PATHS 附近的注释; Codex 的 session-id/thread-id 与其请求体
  // prompt_cache_key 同源, 会话编号因此与缓存亲和使用同一稳定标识
  const ccSessionId = req.headers["x-claude-code-session-id"];
  const cxCodexSession = req.headers["session-id"] || req.headers["session_id"]; // 兼容旧版下划线头名
  const cxThreadId = req.headers["thread-id"];
  const sessionKey = ccSessionId
    ? `cc:${ccSessionId}`
    : cxCodexSession
      ? `cx:${cxCodexSession}`
      : cxThreadId
        ? `cx:thread:${cxThreadId}`
        : `${srcIp}:${req.socket.remotePort || "-"}|${req.headers["user-agent"] || "-"}`;
  // 注意: 放在闭包变量而非 req._cmdc —— 路由分支会重建 req._cmdc, 直接赋值会丢失 session
  const session = MODEL_PATHS.includes(pathname) ? getSession(sessionKey) : null;
  let outBytes = 0;
  const uaShort = () => (req.headers["user-agent"] || "-").slice(0, 48);
  // REQ 行: 只显示本地请求的模型名 (前半), 映射关系留给 RES 行对照; 颜色按模型名哈希
  const reqModelPart = () => {
    const c = req._cmdc;
    return c && c.model ? modelColor(c.model)(` model=${c.model}`) : "";
  };
  // RES 行: 只显示实际转发的模型名 (后半); 与本地请求名完全相同(字符串相等)时省略; 颜色按模型名哈希
  const resModelPart = () => {
    const c = req._cmdc;
    if (!c || !c.mapped || c.mapped === c.model) return "";
    return modelColor(c.mapped)(` model=${c.mapped}`);
  };
  const streamPart = () => {
    const c = req._cmdc;
    return c && c.stream != null ? ` stream=${c.stream ? 1 : 0}` : "";
  };
  // 请求体大小 (帮助区分两条请求是否完全相同: 工具循环请求体递增, 重试请求体相同)
  const fmtBytes = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + "KB" : n + "B");
  const bodyPart = () => {
    const bb = req._cmdc.bodyBytes;
    return bb ? ` body=${fmtBytes(bb)}` : "";
  };
  // 会话编号标签: 非 model 请求无会话, 返回空串
  const sessTag = () => {
    return session ? `#${session.id}` : "";
  };
  const logReq = () => {
    if (req._cmdc.reqLogged) return;
    req._cmdc.reqLogged = true;
    console.log(`${cDim(`[${logTs(startAt)}]${sessTag()}`)} ${cCyan("REQ")} ${req.method} ${pathname} src=${srcIp}:${req.socket.remotePort || "-"} ua=${uaShort()}${reqModelPart()}${streamPart()}${cDim(bodyPart())}`);
    // CMC_DEBUG_PAYLOAD=1: 打印本地请求完整请求头与 body 原文 (排查会话标识等)
    if (process.env.CMC_DEBUG_PAYLOAD === "1") {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
      console.log(`[payload] ${req.method} ${pathname} headers=${JSON.stringify(headers)}`);
      const raw = req._cmdc.rawBody || "";
      try {
        const keys = Object.keys(JSON.parse(raw));
        console.log(`[payload] bodyKeys=${keys.join(",")}`);
      } catch { /* 非 JSON 则跳过 */ }
      const MAX = 8000;
      console.log(`[payload] body(${Buffer.byteLength(raw)}B)=${raw.length > MAX ? raw.slice(0, MAX) + `...[截断 显示${MAX}B/共${raw.length}B]` : raw}`);
    }
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
    const rec = { in: 0, out: 0, rt: 0, cr: 0, cw: 0, ms };
    if (u) {
      const parts = [];
      if (u.input != null) parts.push(`in:${u.input}`);
      if (u.output != null) parts.push(`out:${u.output}`);
      if (u.reasoning != null) parts.push(`rt:${u.reasoning}`);
      if (u.cacheRead != null) parts.push(`cr:${u.cacheRead}`);
      if (u.cacheWrite != null) parts.push(`cw:${u.cacheWrite}`);
      if (parts.length) usageStr = ` ${parts.join(" ")}`;
      rec.in = u.input ?? 0;
      rec.out = u.output ?? 0;
      rec.rt = u.reasoning ?? 0;
      rec.cr = u.cacheRead ?? 0;
      rec.cw = u.cacheWrite ?? 0;
    }
    // 跨天: 先打印上日 TOD/ALL 汇总, 重置当天
    const day = dayKey();
    if (stats.day !== day) {
      logStats();
      stats.day = day;
      stats.today = zeroAgg();
    }
    accumulate(rec, !!usageStr);
    // 会话请求序号: 仅对有 usage 的请求递增 (与 ch 统计同口径)。
    // 会话累计 in/cr 用于 ch 输出; 当前次 cachehit<50% 时计算与最近一次低缓存命中请求的
    // 序号差 gap, 输出在 ch 前 (首次低缓存只记录基准, 不输出 gap)
    let gapStr = "";
    if (usageStr && session) {
      session.seq += 1;
      session.in += rec.in;
      session.cr += rec.cr;
      const totalIn = rec.in + rec.cr;
      const pct = totalIn > 0 ? Math.round((rec.cr / totalIn) * 100) : 0;
      if (pct < 50) {
        if (session.lastLowCacheSeq != null) gapStr = ` ${cRed(`gap:${session.seq - session.lastLowCacheSeq}`)}`;
        session.lastLowCacheSeq = session.seq;
      }
    }
    // 滚动统计仅在 200 且本次请求解析到 usage (输出 in/out/rt/cr/cw) 时追加
    const movingStr = usageStr ? movingStatsStr(session) : "";
    // 前缀分叉标记: 仅在检测到分叉/压缩时输出 (纯追加为健康状态, 不输出)
    const pfxMark = req._cmdc && req._cmdc.pfxMark ? ` ${cRed(req._cmdc.pfxMark)}` : "";
    console.log(`${cDim(`[${logTs(Date.now())}]${sessTag()}`)} ${cStatus(res.statusCode)} ${req.method} ${pathname}${resModelPart()} ${cDim(`took=${took} out=${outBytes}B`)}${usageStr}${gapStr}${pfxMark}${movingStr}`);
    if (stats.total.req % STATS_EVERY === 0) logStats();
  });

  try {
    // 非模型类 body 路径 (GET 等): 立即打印本地请求日志
    const isModelBodyPath = MODEL_PATHS.includes(pathname);
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
      const requested = body.model || currentDefaultModel();
      const mapped = resolveModel(requested);
      const useAnthropicEndpoint = isClaudeModel(mapped);
      const isStream = !!body.stream;
      req._cmdc = { model: requested, mapped, stream: isStream };
      req._cmdc.bodyBytes = Buffer.byteLength(bodyRaw || "");
      req._cmdc.rawBody = bodyRaw || "";
      logReq();

      if (useAnthropicEndpoint) {
        // Claude 模型 -> 直接走上游 /messages
        body.model = mapped;
        let up;
        try {
          up = await upstreamFetch(`${UPSTREAM}/v1/messages`, {
            method: "POST",
            headers: buildUpstreamHeaders(req, {
              "Content-Type": "application/json",
              "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
            }),
            body: JSON.stringify(body),
          }, mapped);
        } catch (e) {
          console.warn(TAGW, `上游请求失败 (${mapped}): ${e.message}`);
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "上游请求失败: " + e.message } }));
          return;
        }
        if (!up.ok) {
          // upstreamFetch 已计失败并可能切换默认模型
          await passThrough(res, up);
          return;
        }
        await passThrough(res, up, { collectUsage: (u) => { req._cmdc.usage = normalizeUsage(u); } });
        return;
      }

      // 非 Claude 模型 -> Anthropic -> OpenAI 协议转换
      const oaiReq = anthropicToOpenAIRequest(body, sessionKey);
      req._cmdc.pfxMark = prefixDivergeMark(session, oaiReq.messages, JSON.stringify(oaiReq.tools || ""));
      let up;
      try {
        up = await upstreamFetch(`${UPSTREAM}/v1/chat/completions`, {
          method: "POST",
          headers: buildUpstreamHeaders(req, { "Content-Type": "application/json" }),
          body: JSON.stringify(oaiReq),
        }, mapped);
      } catch (e) {
        console.warn(TAGW, `上游请求失败 (${mapped}): ${e.message}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "上游请求失败: " + e.message } }));
        return;
      }

      if (!isStream) {
        // 非流式: 整体转换
        const text = await up.text();
        if (!up.ok) {
          // upstreamFetch 已计失败并可能切换默认模型
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
      const conv = new StreamConverter(requested, estimateInputTokens(body));
      await pumpConvertedStream(up, conv, res, "messages");
      req._cmdc.usage = normalizeUsage(conv.rawUsage);
      return;
    }

    // ---- /v1/chat/completions (OpenAI 格式) ----
    if (pathname === "/v1/chat/completions" && req.method === "POST") {
      const bodyRaw = await readBody(req);
      const body = JSON.parse(bodyRaw || "{}");
      const requested = body.model || currentDefaultModel();
      if (body.model) body.model = resolveModel(body.model);
      req._cmdc = { model: requested, mapped: body.model, stream: !!body.stream };
      req._cmdc.bodyBytes = Buffer.byteLength(bodyRaw || "");
      req._cmdc.rawBody = bodyRaw || "";
      logReq();
      let up;
      try {
        up = await upstreamFetch(`${UPSTREAM}/v1/chat/completions`, {
          method: "POST",
          headers: buildUpstreamHeaders(req, { "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        }, body.model);
      } catch (e) {
        console.warn(TAGW, `上游请求失败 (${body.model}): ${e.message}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "上游请求失败: " + e.message, type: "api_error" } }));
        return;
      }
      // upstreamFetch 已处理失败/成功计数 (非 2xx 已计失败并可能切换默认模型)
      await passThrough(res, up, { collectUsage: (u) => { req._cmdc.usage = normalizeUsage(u); } });
      return;
    }

    // ---- /v1/responses (Codex wire_api="responses") ----
    // Codex 新版只支持 Responses API; commandcode 上游仅提供 chat/completions,
    // 因此在此做 Responses <-> Chat Completions 协议转换。
    if (pathname === "/v1/responses" && req.method === "POST") {
      const bodyRaw = await readBody(req);
      const body = JSON.parse(bodyRaw || "{}");
      const requested = body.model || currentDefaultModel();
      const mapped = resolveModel(requested);
      const isStream = !!body.stream;
      req._cmdc = { model: requested, mapped, stream: isStream };
      req._cmdc.bodyBytes = Buffer.byteLength(bodyRaw || "");
      req._cmdc.rawBody = bodyRaw || "";
      logReq();

      const { chat: chatReq, customToolNames } = responsesToChatRequest(body, sessionKey);
      req._cmdc.pfxMark = prefixDivergeMark(session, chatReq.messages, JSON.stringify(chatReq.tools || ""));
      let up;
      try {
        up = await upstreamFetch(`${UPSTREAM}/v1/chat/completions`, {
          method: "POST",
          headers: buildUpstreamHeaders(req, { "Content-Type": "application/json" }),
          body: JSON.stringify(chatReq),
        }, mapped);
      } catch (e) {
        console.warn(TAGW, `上游请求失败 (${mapped}): ${e.message}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "上游请求失败: " + e.message, type: "api_error" } }));
        return;
      }

      if (!isStream) {
        const text = await up.text();
        if (!up.ok) {
          // upstreamFetch 已计失败并可能切换默认模型
          res.writeHead(up.status, { "Content-Type": up.headers.get("content-type") || "application/json" });
          res.end(text);
          return;
        }
        try {
          const oai = JSON.parse(text);
          req._cmdc.usage = normalizeUsage(oai.usage);
          const respObj = chatResponseToResponses(oai, requested, customToolNames);
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
      const conv = new ResponsesStreamConverter(requested, estimateInputTokens(body), customToolNames);
      await pumpConvertedStream(up, conv, res, "responses");
      req._cmdc.usage = normalizeUsage(conv.rawUsage);
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
  console.log(cBlue(`  默认模型   : ${currentDefaultModel()}  (轮换列表: ${defaultModels.join(" → ")})`));
  console.log(cBlue(`  模型回退   : ${FALLBACK_ENABLED ? `开启 (首个模型失败 ${FIRST_FAIL_LIMIT} 次后逐一切换, 后续模型失败 ${OTHER_FAIL_LIMIT} 次即切换, 循环)` : "关闭 (始终使用第一个模型)"}`));
  console.log(cBlue("-".repeat(58)));
  console.log(cBlue("  Claude Code 接入:  export ANTHROPIC_BASE_URL=http://localhost:" + PORT));
  console.log(cBlue("  Codex 接入:        base_url = http://localhost:" + PORT + "/v1  (wire_api = responses)"));
  console.log(line);
  // 启动时预热模型列表
  refreshModels(true);
});
