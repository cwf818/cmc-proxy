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
 * 启动:  node proxy.js [--port 5411] [--config config.json]
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
 *   8. 前缀分叉探测器: RES 行 pfx~N/pfx~tools/pfx<N 标记 + 分叉内容预览, 定位缓存
 *      命中率低的来源。借此确认 Claude Code 2.1.251 注入的 <total_tokens> 配额计数
 *      会随轮次回溯改写, 是 Claude Code 路径缓存失效的元凶 —— 现将计数就近取整到
 *      百万 (14977212 -> 15000000) 使前缀字节稳定, config.stabilizeCounters 可关;
 *      同时修复 messages 内 system 提醒的块数组被 JSON.stringify 成乱码的问题
 *      (改为文本提取, 块数组与拼接字符串两种客户端形态产生相同字节)。
 *   9. stripSystemReminders (默认 true): 整条剥离 history 中注入的 system 提醒
 *      (配额计数/任务催促), 提示性内容不影响编码能力; 请求落盘由环境变量
 *      CMC_LOGGING_FILE 分级控制 (见下方注释), 文件固定为 ROOT/fulllog.log。
 *  10. switchOnFail (默认 false): 轮换总开关, 支持布尔或 {text, image} 对象 (单布尔统一
 *      取值)。true 时失败 1 次即切换 + failTTL 冷却: 按请求类型选列表 (文本 defaultModels /
 *      带图 defaultVisionModels, 带图 400 也轮换), 失败模型 TTL 内冷却跳过, 全部失效时返回
 *      上游失败结果; false 时不轮换, 失败原样返回。模型决策见 pickModel (modelMap 优先 ->
 *      resolveModel 目录解析 -> 按请求类型回退默认)。**冷却只对回退到默认的模型生效**:
 *      用户显式指定的模型 (modelMap/目录解析命中) 失败不冷却、下次请求仍从它开始 —— 不去
 *      猜测用户指定模型的能力; 只有未带 model 或指定模型解析失败回退到 defaultForType 时,
 *      失败才进入 TTL 冷却 (默认列表内后续候选无论何种情况都照常冷却)。
 *  11. modelCatalog (默认 goat-prices.json): 模型参数数据文件路径, 存在且解析成功时作为
 *      模型参数数据源, 计算单次请求的额度 (credit) 消耗。成本按牌价 priceUsdPerMTok 直接
 *      算 USD; 额度 = 成本 × plan.credits ÷ 模型 monthlyCredits。offPeak.windows 高峰窗口
 *      (UTC) 内以 peakUsdPerMTok 覆盖 input/output/cacheRead 牌价; 高峰仅工作日 (周一~周五,
 *      UTC) 生效, 周末整天按错峰价。RES 行输出 cost (橙) 与
 *      credit (黄), 高峰时段 cost/credit 前缀加 ^ (如 ^cost=); REQ/RES 行时间戳在高峰时段
 *      改暗红 (亮度同暗灰, 按本请求实际转发模型判定)。TOD/ALL stats 输出累计 cost / credit / avg。
 *      文件缺失/解析失败静默跳过。
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
const cBrightCyan = paint("\x1b[96m"); // 亮青 (usage cr 缓存命中突出)
const cDimRed = paint("\x1b[2m\x1b[31m"); // 暗红 (dim+红): 高峰时段时间戳着色, 亮度与暗灰 cDim 相当

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
    switchOnFail: false,
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
const STABILIZE_COUNTERS = config.stabilizeCounters !== false; // 易变配额计数器取整, 稳定前缀缓存
const STRIP_SYSTEM_REMINDERS = config.stripSystemReminders !== false; // 剥离 history 中注入的 system 提醒消息
const SERIALIZE_SESSION = config.serializeSessionRequests !== false; // 同会话上游请求串行化
const FIRST_BYTE_TIMEOUT = parseInt(config.firstByteTimeout ?? "120000", 10); // 上游响应头超时 ms (0=关闭; ?? 保证显式 0 不被默认值覆盖)
const TOOL_RESULT_IMAGES = config.toolResultImages !== false; // tool_result 内嵌图片保留 (注入随后的 user 消息透传上游)
const CLEAN_HISTORY_IMAGES = config.cleanHistoryImages === true; // 本轮无新图时清理历史图片, 使请求可回流纯文本模型
const RESOLVE_MODEL = config.resolveModel !== false; // modelMap 未命中时是否目录解析+回退默认 (false=原样向上游请求)

// 模型参数目录 (modelCatalog): 指向价格/额度 JSON 文件的路径, **仅在配置文件中显式指定时
// 才加载** (无默认值)。存在且解析成功时作为模型参数数据源, 用于计算单次请求的额度 (credit)
// 消耗; 文件不存在 / 读取或解析失败时静默跳过 —— 只是没有模型参数数据, 不影响转发与日志。
// 未配置时 modelCatalog 保持 null, 不统计额度。
const MODEL_CATALOG_PATH = config.modelCatalog ? path.resolve(ROOT, config.modelCatalog) : null;
let modelCatalog = null; // { plan, index: Map<slug, model>, norm: Map<去非字母数字小写, model>, byId: Map<id, model> }
try {
  if (MODEL_CATALOG_PATH && fs.existsSync(MODEL_CATALOG_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(MODEL_CATALOG_PATH, "utf8"));
    if (parsed && Array.isArray(parsed.models)) {
      const index = new Map(parsed.models.map((m) => (m && m.slug ? [m.slug, m] : null)).filter(Boolean));
      // 规范化索引: slug 去非字母数字后小写 —— 覆盖上游 id 与显示名派生 slug 的命名差异
      // (如 Qwen3.8-27B vs qwen-3.8-27b)
      const norm = new Map();
      for (const m of index.values()) norm.set(m.slug.replace(/[^a-z0-9]+/g, ""), m);
      // 上游 id 索引 (schema@2+ 新增): 上游转发的模型名就是 id, 精确命中优先于 slug 归一化
      const byId = new Map(parsed.models.map((m) => (m && m.id ? [m.id, m] : null)).filter(Boolean));
      modelCatalog = { plan: parsed.plan || {}, index, norm, byId };
      console.log(`[cmc-proxy] 模型目录已加载: ${MODEL_CATALOG_PATH} (${modelCatalog.index.size} 个模型)`);
    }
  }
} catch (e) {
  console.warn(TAGW, "模型目录加载失败 (静默跳过):", e.message);
}

// 请求落盘分级 (环境变量 CMC_LOGGING_FILE, 未设置或 0 = 关闭):
//   1 = 严重事件落盘 (上游请求失败/超时、客户端中途断开 ABT)
//   2 = 1 + 前缀分叉时落盘该请求 (client/upstream 双 body, 便于定位分叉来源)
//   3 = 全部模型类请求落盘 (原 config.fulllog=true 行为)
// 文件固定为 ROOT/fulllog.log (已在 .gitignore)
const LOG_LEVEL = Math.max(0, parseInt(process.env.CMC_LOGGING_FILE || "0", 10) || 0);
const FULLLOG_PATH = LOG_LEVEL > 0 ? path.join(ROOT, "fulllog.log") : null;
let fulllogChain = Promise.resolve();
function fulllogDump(req, pathname, session, entries, note) {
  if (!FULLLOG_PATH) return;
  const ts = new Date().toISOString();
  const head = `\n[${ts}]#${session ? session.id : "-"} ${req.method} ${pathname} src=${req.socket.remotePort || "-"}${note ? ` [${note}]` : ""}\n`;
  const body = entries
    .filter(([, text]) => text != null)
    .map(([label, text]) => `---- ${label} (${Buffer.byteLength(text)}B) ----\n${text}\n`)
    .join("\n");
  // 串行追加, 保证写入顺序与到达顺序一致
  fulllogChain = fulllogChain
    .then(() => fs.promises.appendFile(FULLLOG_PATH, head + body))
    .catch((e) => console.error(TAGE, "fulllog 写入失败:", e.message));
}
/** 请求落盘判断: 3=全部; 2=仅前缀分叉的请求 */
function shouldDumpRequest(pfxMark) {
  return LOG_LEVEL >= 3 || (LOG_LEVEL >= 2 && !!pfxMark);
}
/** 严重事件落盘 (level>=1): 上游失败/超时、客户端断开等, 附请求双 body 便于定位 */
function logSevere(req, pathname, session, message) {
  if (LOG_LEVEL < 1) return;
  const c = req._cmdc || {};
  fulllogDump(req, pathname, session, [["client", c.rawBody], ["upstream", c.upstreamBody]], message);
}

if (!API_KEY) {
  console.error(TAGE, "错误: 未配置 apiKey。请在 config.json 中填入你的 commandcode API key，");
  console.error(TAGE, "       或通过环境变量 CMDC_API_KEY 传入。");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 模型解析
// ---------------------------------------------------------------------------
const modelMap = config.modelMap || {};

// ---- 多模型轮换列表 ----
// defaultModels: 文本请求轮换列表; defaultVisionModels: 带图请求轮换列表。
// 兼容旧配置: 仅配置 defaultModel 时自动视为单元素数组。
const defaultModels = (Array.isArray(config.defaultModels) && config.defaultModels.length)
  ? config.defaultModels
  : [config.defaultModel || "deepseek/deepseek-v4-flash"];
// 视觉模型列表: 带图请求的轮换范围。旧配置 imageCapableModels 自动迁移。
const defaultVisionModels = (Array.isArray(config.defaultVisionModels) && config.defaultVisionModels.length)
  ? config.defaultVisionModels
  : (Array.isArray(config.imageCapableModels) && config.imageCapableModels.length)
    ? config.imageCapableModels
    : [];

// ---- switchOnFail: 轮换总开关, 支持布尔或 {text, image} ----
// 单布尔值表示 text/image 统一取值。true 时开启"失败 1 次即切换 + TTL 冷却"轮换,
// false 时不轮换 (失败原样返回)。
const switchOnFailRaw = config.switchOnFail;
const SWITCH_ON_FAIL = switchOnFailRaw === true || (switchOnFailRaw && typeof switchOnFailRaw === "object")
  ? (typeof switchOnFailRaw === "object" ? !!(switchOnFailRaw.text ?? switchOnFailRaw.image) : true)
  : false;
const switchOnFailFor = (isImage) => {
  if (switchOnFailRaw === true) return true;
  if (switchOnFailRaw && typeof switchOnFailRaw === "object") {
    const v = isImage ? switchOnFailRaw.image : switchOnFailRaw.text;
    return !!v;
  }
  return false;
};
// 失败模型冷却 (TTL): 模型失败后 TTL 毫秒内跳过该模型, 避免反复打已死模型。
// 0 表示不冷却 (失败即从当次轮换中剔除, 跨请求仍可重试)。
// ?? 保证显式 0 (不冷却) 不被默认值覆盖: 0 是合法配置值, 不能用 || 兜底
const FAIL_TTL = parseInt(config.failTTL ?? "30000", 10);

// 模型失败时间戳 (TTL 冷却): model -> 最近失败时刻; 成功清除
const modelFailAt = new Map();
function markModelFail(model) {
  if (model) modelFailAt.set(model, Date.now());
}
function markModelOk(model) {
  if (model) modelFailAt.delete(model);
}
function modelInCooldown(model) {
  const t = modelFailAt.get(model);
  return !!(t && FAIL_TTL > 0 && Date.now() - t < FAIL_TTL);
}
function cooldownRemainMs(model) {
  const t = modelFailAt.get(model);
  return t && FAIL_TTL > 0 ? Math.max(0, FAIL_TTL - (Date.now() - t)) : 0;
}

/** 当前默认模型: 文本列表第一个 (轮换指针语义已移除, 保持简单) */
function currentDefaultModel() {
  return defaultModels[0];
}

/** 一次请求失败时调用 (非轮换模式下的计数, 现仅保留 TTL 记录) */
function onRequestFail(failedModel) {
  markModelFail(failedModel);
}

/** 一次请求成功时调用 */
function onRequestOk(okModel) {
  markModelOk(okModel);
}

// ---------------------------------------------------------------------------
// 上游模型列表缓存 (供 /v1/models 与模型目录匹配使用, 启动时异步刷新)
// ---------------------------------------------------------------------------
let upstreamModelsCache = { list: [], fetchedAt: 0 };
let upstreamModelsCacheFetched = false; // 首次成功获取后打印条数日志

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
    const list = j.data || [];
    upstreamModelsCache = { list, fetchedAt: now };
    // 首次获取打日志: 成功获取到多少条上游模型信息 (本地时间)
    if (!upstreamModelsCacheFetched) {
      upstreamModelsCacheFetched = true;
      console.log(`[cmc-proxy] 刷新上游模型列表成功: ${list.length} 条 (${logTs(now)})`);
    }
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
 * 模型解析 helper (仅目录匹配, 不包含 modelMap):
 *   1. 上游模型目录匹配, 全局按匹配级别分层按序尝试 (外层条件, 内层遍历目录):
 *      精确 -> 大小写不敏感 -> 去 provider 前缀按裸名 -> 去 [*] 后缀,
 *      任一层命中即用; 例: deepseek-v4-flash -> deepseek/deepseek-v4-flash,
 *      qwen3.8-max -> Qwen/Qwen3.8-Max
 *   2. 无任何匹配 -> 返回 null, 由调用方 (pickModel) 按请求类型回退默认模型
 */
function resolveModel(requested) {
  if (!requested) return null;
  // 上游模型目录匹配 (分层按序: 高级别匹配优先于目录顺序)
  const models = upstreamModelsCache.list;
  if (models.length) {
    const reqLower = requested.toLowerCase();
    const bareLower = requested.replace(/^[^/]*\//, "").toLowerCase(); // 去掉 provider 前缀
    // 去掉 [*] 后缀 (如 [1m]): 视为同模型的不同上下文窗口变体, 用基础名匹配
    const bareNoSuffix = bareLower.replace(/\[[^\]]*\]$/, "");
    for (const m of models) if (m.id === requested) return m.id; // 1. 精确
    for (const m of models) if (m.id.toLowerCase() === reqLower) return m.id; // 2. 大小写不敏感精确
    for (const m of models) if (m.id.toLowerCase().endsWith("/" + bareLower)) return m.id; // 3. 无前缀名匹配带前缀模型
    if (bareNoSuffix && bareNoSuffix !== bareLower) {
      for (const m of models) if (m.id.toLowerCase().endsWith("/" + bareNoSuffix)) return m.id; // 4. 去 [*] 后缀匹配
    }
  }
  return null;
}

/** 请求类型对应的默认模型: 文本 -> defaultModels[0], 带图 -> defaultVisionModels[0] */
function defaultForType(isImage) {
  return isImage && defaultVisionModels.length ? defaultVisionModels[0] : defaultModels[0];
}

/**
 * 最终模型决策 (所有转发路径共用):
 *   1. 请求未带 model -> 按请求类型取默认 (defaultModels[0] / defaultVisionModels[0])
 *   2. 带 model -> modelMap 显式映射, 命中即用 (不区分请求类型, 优先级最高, 置空即关闭)
 *   3. 未命中 modelMap -> 按 config.resolveModel 开关:
 *      true  (默认): 目录匹配解析, 命中即用; 未命中按请求类型回退默认
 *      false        : 原样向上游请求 (不解析不回退)
 */
function pickModel(requested, isImage) {
  return pickModelWithFlag(requested, isImage).model;
}

/**
 * 模型决策 + 是否"回退到默认"标志。isFallback=true 表示最终模型是系统回退选出的
 * (未带 model, 或用户指定模型解析失败落到 defaultForType), 即非用户显式意图。
 * 该标志驱动冷却范围: 只有回退到默认的模型失败才进入 failTTL 冷却 (用户显式指定的
 * 模型不猜测、不冷却, 下次请求仍从它开始)。与 pickModel 唯一区别是附带 isFallback。
 */
function pickModelWithFlag(requested, isImage) {
  if (!requested) return { model: defaultForType(isImage), isFallback: true };
  if (modelMap[requested]) return { model: modelMap[requested], isFallback: false }; // 显式映射优先
  if (!RESOLVE_MODEL) return { model: requested, isFallback: false }; // 解析关闭: 原样
  const resolved = resolveModel(requested);
  return resolved
    ? { model: resolved, isFallback: false }
    : { model: defaultForType(isImage), isFallback: true };
}

/** 当前默认模型 (文本) */
function currentDefaultModel() {
  return defaultModels[0];
}

/** 判断某模型是否需要走 Anthropic /messages 端点 (Claude 系) */
function isClaudeModel(model) {
  return /^claude(-|$)/.test(model);
}

/** OpenAI messages 数组是否含 image_url part (任意角色) */
function openAIMessagesHaveImages(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p && p.type === "image_url"));
}

/** 深度统计请求体里的图片块: Anthropic image 块 + OpenAI image_url / input_image
 *  part。用于 REQ 行 img=N 标记与带图路由判断, 每请求一次 O(节点数) 遍历 */
function countImagesDeep(v) {
  if (Array.isArray(v)) {
    let n = 0;
    for (const x of v) n += countImagesDeep(x);
    return n;
  }
  if (!v || typeof v !== "object") return 0;
  let n = v.type === "image" && v.source ? 1 : v.type === "image_url" || v.type === "input_image" ? 1 : 0;
  for (const k in v) n += countImagesDeep(v[k]);
  return n;
}

// 历史图片清理后的占位文本 (确定性替换, 保证前缀缓存稳定)
const STRIP_IMG_PLACEHOLDER = "[历史图片已清理]";

/** 最后一条 user 消息 (即本轮) 中的图片块数, 无 user 消息返回 0。
 *  Claude Code 每轮重发全量历史, 最后一条 user 消息即当前轮新产生的内容,
 *  其中的图视为新图, 更早消息里的图视为历史图 */
function countLastUserImages(body) {
  const msgs = body.messages;
  if (!Array.isArray(msgs)) return 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === "user") return countImagesDeep(msgs[i]);
  }
  return 0;
}

/** 清理历史图片: 把最后一条 user 消息之前的所有 image 块原位替换为占位文本
 *  (直接 image 块与 tool_result 内嵌 image 块都处理)。上游对历史里的图片同样
 *  400, 剥离后无新图的请求可安全发给纯文本模型, 带图路由随之只看新图 —— 会话
 *  不再被历史图片钉死在视觉模型。替换是确定性的: 同一历史每轮剥出逐字节一致
 *  的结果, 不影响前缀缓存。 */
function stripHistoryImages(body) {
  const msgs = body.messages;
  if (!Array.isArray(msgs)) return;
  let lastUser = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  for (let i = 0; i < lastUser; i++) {
    const m = msgs[i];
    if (!m || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "image" && b.source) {
        b.type = "text";
        b.text = STRIP_IMG_PLACEHOLDER;
        delete b.source;
      } else if (b.type === "tool_result" && Array.isArray(b.content)) {
        for (let j = 0; j < b.content.length; j++) {
          const x = b.content[j];
          if (x && x.type === "image") b.content[j] = { type: "text", text: STRIP_IMG_PLACEHOLDER };
        }
      }
    }
  }
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
      const p = { type: "text", text: stabilizeVolatileText(b.text) };
      if (CC_PASSTHROUGH && b.cache_control) p.cache_control = b.cache_control;
      parts.push(p);
    } else if (b.type === "image") {
      const p = imageSourceToPart(b.source);
      if (p) parts.push(p);
    }
    // 其他块类型 (thinking 等上游无对应概念) 跳过
  }
  return parts;
}

/** Anthropic image source -> OpenAI image_url part; 无效 source 返回 null */
function imageSourceToPart(src) {
  if (src && src.type === "base64" && src.media_type && src.data) {
    return { type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } };
  }
  if (src && src.type === "url" && src.url) {
    return { type: "image_url", image_url: { url: src.url } };
  }
  return null;
}

/** tool_result 块内容 -> tool 消息文本 (非文本块折叠为占位符) */
function toolResultToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((x) => (x && x.type === "text" ? x.text : `[${(x && x.type) || "unknown"}]`))
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

/** tool_result 块内容中的 image 块 -> image_url part 数组。
 *  上游 tool 消息不支持带图 (实测 400 Invalid input, vision 模型同样拒绝),
 *  图片由 anthropicMessageToOpenAI 注入随后的 user 消息转发 */
function toolResultImageParts(content) {
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const x of content) {
    if (x && x.type === "image") {
      const p = imageSourceToPart(x.source);
      if (p) parts.push(p);
    }
  }
  return parts;
}

function anthropicMessageToOpenAI(msg) {
  const role = msg.role;

  if (role === "user") {
    const toolMsgs = [];
    const parts = [];
    const toolImgs = []; // tool_result 抽出的图片 (注入末尾 user 消息)
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === "tool_result") {
          // OpenAI 要求 tool 消息独立成条; tool 消息不能带图 (上游 400), 图片抽出注入 user 消息
          const c = toolResultToText(b.content);
          toolMsgs.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content: typeof c === "string" && c.length ? c : JSON.stringify(c),
          });
          const imgs = TOOL_RESULT_IMAGES ? toolResultImageParts(b.content) : [];
          if (imgs.length) toolImgs.push({ id: b.tool_use_id, imgs });
        } else if (b.type === "text" || b.type === "image") {
          const converted = anthropicBlocksToParts([b]);
          parts.push(...converted);
        }
      }
    } else if (typeof msg.content === "string" && msg.content) {
      parts.push({ type: "text", text: msg.content });
    }
    const out = [...toolMsgs];
    if (parts.length || toolImgs.length) {
      // 图片以带来源标签的 part 追加在同一条 user 消息尾部; 历史回放时块内容不变,
      // 注入结构确定, 不影响前缀缓存
      const userParts = [...parts];
      for (const { id, imgs } of toolImgs) {
        userParts.push({ type: "text", text: id ? `[tool_result ${id} 附带的图片]` : "[tool_result 附带的图片]" });
        userParts.push(...imgs);
      }
      out.push({ role: "user", content: userParts });
    }
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

  // system 等其他 role (Claude Code 2.1.251+ 会往 messages 里注入 system 角色的
  // 上下文提醒, 如 <total_tokens> 配额计数): 默认整条剥离 —— 纯提示性内容, 每轮
  // 变化且被回溯改写, 是前缀缓存杀手; 剥离后模型每轮仍能正常编码, CC 下一轮会
  // 重新注入。config.stripSystemReminders=false 可保留 (保留时提取纯文本)。
  if (role === "system") {
    if (STRIP_SYSTEM_REMINDERS) return null;
    const text = extractReminderText(msg.content);
    if (text) return { role: "system", content: text };
    return null;
  }
  return { role, content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) };
}

/**
 * 易变计数器稳定化: Claude Code 2.1.251 注入的 <total_tokens>N tokens left</total_tokens>
 * 配额计数每轮回溯改写, 是前缀缓存失效的元凶。将数值就近取整到 100 万
 * (14977212 -> 15000000), 回溯改写前后字节一致, 语义仅损失粗粒度精度。
 * 可用 config.stabilizeCounters=false 关闭。
 */
const VOLATILE_COUNTER_RE = /(<total_tokens>)(\d+)( tokens left<\/total_tokens>)/g;
function stabilizeVolatileText(s) {
  if (!STABILIZE_COUNTERS || typeof s !== "string" || s.indexOf("<total_tokens>") < 0) return s;
  return s.replace(VOLATILE_COUNTER_RE, (_, p, num, q) => p + Math.round(parseInt(num, 10) / 1e6) * 1e6 + q);
}

/** system 提醒消息的文本提取: 字符串原样; 块数组取 text 块按 \n\n 拼接 */
function extractReminderText(content) {
  if (typeof content === "string") return stabilizeVolatileText(content);
  if (Array.isArray(content)) {
    const text = content
      .filter((b) => b && b.type === "text" && b.text)
      .map((b) => stabilizeVolatileText(b.text))
      .join("\n\n");
    return text || null;
  }
  return content == null ? null : String(content);
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
  const mapped = body.model; // model 由调用方 (pickModel) 决策后覆盖
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
    this.textBlock = null; // 文本块索引, null=未创建 (0 是合法索引, 判断必须用 == null 而非 !textBlock, 否则第 2 个内容 chunk 会误建新块把消息拆成两截)
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
      if (this.textBlock == null) {
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
  const mapped = body.model; // model 由调用方 (pickModel) 决策后覆盖
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
 * signal: 与客户端断开联动的中止信号 (客户端断开 → 中止上游等待, 不计失败);
 * FIRST_BYTE_TIMEOUT: 上游超过该时长未返回响应头时主动中止 (替代 undici 黑盒 300s)。
 */
function upstreamError(message, opts = {}) {
  return Object.assign(new Error(message), opts);
}

/** 底层单次上游请求: 带客户端断开联动与首字节超时看门狗, 不做任何计数/轮换 */
async function rawUpstreamFetch(url, init, signal) {
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason);
    else signal.addEventListener("abort", () => ac.abort(signal.reason), { once: true });
  }
  const guard = FIRST_BYTE_TIMEOUT > 0
    ? setTimeout(() => ac.abort(upstreamError(`上游 ${Math.round(FIRST_BYTE_TIMEOUT / 1000)}s 未返回响应头`, { firstByteTimeout: true })), FIRST_BYTE_TIMEOUT)
    : null;
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    if (guard) clearTimeout(guard);
  }
}

async function upstreamFetch(url, init, requestedModel, signal, isFallback = true) {
  if (requestedModel && blockedSet.has(requestedModel)) warnBlockedModel(requestedModel);
  let r;
  try {
    r = await rawUpstreamFetch(url, init, signal);
  } catch (e) {
    // 客户端主动断开不算上游失败, 不计轮换; 让调用方按 clientAbort 静默收尾
    if (signal?.aborted && !e.firstByteTimeout) {
      throw upstreamError("客户端已断开, 终止上游请求", { clientAbort: true });
    }
    // 用户显式指定模型失败不冷却 (不去猜测能力); 回退/默认模型照常冷却
    if (isFallback) onRequestFail(requestedModel);
    throw e;
  }
  if (!r.ok) {
    if (isFallback) onRequestFail(requestedModel);
  } else onRequestOk(requestedModel);
  return r;
}

/** switchOnFail 视为"换模型重试有意义"的上游状态码; 400/401/413/422 等换模型无济于事, 不轮换 */
const ROTATE_STATUSES = new Set([403, 404, 408, 429, 500, 502, 503, 504]);

/**
 * 上游请求统一入口 (四个转发路径共用)。
 * 轮换语义 (switchOnFail=true 时):
 *   - 候选列表按请求类型: 文本请求 -> defaultModels, 带图请求 (isImage) -> defaultVisionModels;
 *     客户端显式映射的模型 (firstModel) 始终作为首个候选。
 *   - 失败 1 次即切换下一个候选 (不再有阈值/首个模型的区别)。
 *   - 模型失败后进入 TTL 冷却 (config.failTTL, 默认 30s), 冷却期内跳过该模型。
 *   - 候选全部在冷却期 (失效范围) 时, 不再轮换, 直接透传最后一次上游失败结果。
 * 冷却范围 (hooks.isFallback):
 *   - isFallback=false (用户显式指定模型, 经 modelMap/目录解析命中): 该模型不检查冷却、
 *     失败也不计入冷却 —— 不去猜测用户指定模型的能力, 下次请求仍从它开始。
 *   - isFallback=true (未带 model 或指定模型解析失败回退到默认): 首个候选照常冷却;
 *     默认列表里的后续候选 (index >= 1) 无论哪种情况都照常冷却 (方案 A)。
 * switchOnFail=false: 单次请求不轮换, 与 upstreamFetch 一致 (当次失败原样返回)。
 * hooks.onModel(finalModel): 轮换后回调实际使用的模型, 供 RES 行 model= 展示。
 */
async function upstreamFetchRotate(url, init, firstModel, signal, hooks = {}) {
  const { sessTag, onModel, isImage = false, isFallback = true } = hooks;
  const rotateOn = switchOnFailFor(isImage);
  if (!rotateOn) {
    const r = await upstreamFetch(url, init, firstModel, signal, isFallback);
    if (onModel) onModel(firstModel);
    return r;
  }
  if (firstModel && blockedSet.has(firstModel)) warnBlockedModel(firstModel);
  // 候选序列: 解析后的模型优先 (尊重客户端显式意图), 再按类型列表顺序补全, 去重
  const list = isImage ? defaultVisionModels : defaultModels;
  const candidates = [];
  const seen = new Set();
  const add = (m) => { if (m && !seen.has(m)) { seen.add(m); candidates.push(m); } };
  add(firstModel);
  for (const m of list) add(m);
  const pfx = sessTag ? `${sessTag()} ` : "";
  // 每次尝试按候选模型重写 JSON body 的 model 字段 (轮换不能只换计数名, 上游实际收到的模型必须跟着变)
  const attemptInit = (model) => {
    if (typeof init.body !== "string") return init;
    try {
      const obj = JSON.parse(init.body);
      obj.model = model;
      return { ...init, body: JSON.stringify(obj) };
    } catch {
      return init;
    }
  };
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    // 用户显式指定模型 (i===0 且非回退): 不检查冷却, 永远先试 —— 不去猜测它的能力
    const isUserModel = !isFallback && i === 0;
    // TTL 冷却: 冷却期内的模型跳过 (用户显式指定模型除外)
    if (!isUserModel && modelInCooldown(model)) {
      lastErr = upstreamError(`模型 ${model} 冷却中 (剩 ${Math.ceil(cooldownRemainMs(model) / 1000)}s)`);
      console.warn(TAGW, `${pfx}模型 ${model} 冷却中, 跳过`);
      continue;
    }
    try {
      const r = await rawUpstreamFetch(url, attemptInit(model), signal);
      if (r.ok) {
        markModelOk(model);
        if (onModel) onModel(model);
        return r;
      }
      lastErr = r;
      // 用户显式指定模型失败不冷却 (不去猜测能力), 只轮换; 回退/默认候选照常冷却
      if (!isUserModel) markModelFail(model);
      // 带图请求: 图片不支持的报错就是 400 (This model does not support image), 400 也轮换
      if (isImage && r.status === 400) {
        if (i + 1 < candidates.length) {
          console.warn(TAGW, `${pfx}上游 400 (${model}), 带图轮换 → ${candidates[i + 1]} (${i + 1}/${candidates.length})`);
          try { r.body?.cancel(); } catch { /* 丢弃已失败响应 */ }
          continue;
        }
        if (onModel) onModel(model);
        return r; // 全部候选试完: 透传最后一次上游响应给客户端
      }
      if (!ROTATE_STATUSES.has(r.status)) {
        if (onModel) onModel(model);
        return r; // 400/401/413 等换模型无济于事的失败: 不轮换, 原样透传 (已计冷却)
      }
      if (i + 1 < candidates.length) {
        console.warn(TAGW, `${pfx}上游 ${r.status} (${model}), 轮换 → ${candidates[i + 1]} (${i + 1}/${candidates.length})`);
        try { r.body?.cancel(); } catch { /* 丢弃已失败响应 */ }
        continue;
      }
      if (onModel) onModel(model);
      return r; // 全部候选试完: 透传最后一次上游响应给客户端
    } catch (e) {
      if (e.clientAbort) throw e; // 客户端已断开, 立即终止, 不再重试
      lastErr = e;
      // 用户显式指定模型失败不冷却, 只轮换; 回退/默认候选照常冷却
      if (!isUserModel) markModelFail(model);
      if (i + 1 < candidates.length) {
        console.warn(TAGW, `${pfx}上游请求失败 (${model}): ${e.message}, 轮换 → ${candidates[i + 1]} (${i + 1}/${candidates.length})`);
        continue;
      }
      throw e; // 全部候选试完: 抛最后一次错误, 调用方按 502 收尾
    }
  }
  // 候选全部在冷却期 (失效范围): 返回上游失败结果
  throw lastErr || upstreamError("所有候选模型均在冷却中");
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
  const onDone = opts && opts.onDone;
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
  if (onDone) onDone();
  res.end();
}

/** 转换路径共用的上游流消费 + SSE 转换 + usage 收集 (onDone: 上游流结束/中断后回调, 用于释放会话锁) */
async function pumpConvertedStream(up, conv, res, tag, onDone) {
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
      if (process.env.CMC_DEBUG === "1") process.stderr.write(`[DBG-UP-${tag}] ` + raw.replace(/\n/g, "\\n").slice(0, 300) + "\n");
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
  if (onDone) onDone();
  res.end();
}

// ---------------------------------------------------------------------------
// 用量统计
// ---------------------------------------------------------------------------
// 1) 滚动统计: ch 只输出按会话累计的缓存命中率, ts(速度=(输出+思考)tokens/s)按最近 1 / 10 / 50 次请求滚动统计;
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
const zeroAgg = () => ({ req: 0, in: 0, out: 0, rt: 0, cr: 0, cw: 0, ms: 0, credit: 0, cost: 0 });
const stats = { day: null, today: zeroAgg(), total: zeroAgg(), recent: [] };

// ---- 模型目录: 单次请求成本 / 额度计算 ----
// 成本 (cost): 按数据文件牌价直接计算 USD; 额度 (credit): 成本 × plan.credits / monthlyCredits。
// offPeak 高峰窗口 (UTC) 内以 peakUsdPerMTok 覆盖 input/output/cacheRead 牌价,
// cacheRead 仅当峰值字段存在时覆盖 (schema@1 缺该字段沿用原价); cacheWrite 沿用原价。

/** 按 modelCatalog 匹配模型记录: 请求模型名 -> id/slug/norm (与 goat-prices.js toSlug 同规则) */
function catalogModel(mapped) {
  if (!modelCatalog || !mapped) return null;
  // 1. 上游 id 精确命中 (schema@2+): 上游转发的模型名就是 id (如 deepseek/deepseek-v4-flash-vision-exp)
  if (modelCatalog.byId && modelCatalog.byId.has(mapped)) return modelCatalog.byId.get(mapped);
  // 2. slug / 规范化匹配: 去掉 provider 前缀、[*] 上下文窗口后缀 (如 [1m]) 与 (latest)/(exp)
  //    变体后缀, 再按 slug 规则归一化; 未命中回退到去非字母数字的规范化索引
  //    (覆盖 Qwen3.8-27B vs qwen-3.8-27b 差异)
  const bare = mapped.replace(/^[^/]*\//, "").toLowerCase().replace(/\[[^\]]*\]$/, "");
  const slug = bare
    .replace(/\((?:latest|exp)\)/g, "")
    .replace(/[-.]?-(?:latest|exp)$/, "")
    .replace(/[^a-z0-9.+]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return modelCatalog.index.get(slug) || modelCatalog.norm.get(slug.replace(/[^a-z0-9]+/g, "")) || null;
}

/** 解析 offPeak.windows "01–04 & 06–10 UTC" -> [{a,b},...] (end 包含); 跨午夜区间 b+=24; 解析失败返回 null */
function parseWindows(str) {
  if (!str) return null;
  const re = /(\d{1,2})\s*[–\-—~]\s*(\d{1,2})/g;
  const ranges = [];
  let m;
  while ((m = re.exec(str))) {
    let a = +m[1], b = +m[2];
    if (a > b) b += 24; // 跨午夜区间 (如 22-02) 归一为可比较
    ranges.push({ a, b });
  }
  return ranges.length ? ranges : null;
}

/** 当前 UTC 时刻是否落在某高峰区间内 (高峰仅工作日生效) */
function inPeakWindow(model) {
  const off = model && model.offPeak;
  if (!off || !off.windows) return false;
  const ranges = parseWindows(off.windows);
  if (!ranges) return false;
  const d = new Date();
  // 高峰窗口按 UTC+0 定义, 工作日亦按 UTC 计算 (getUTCDay: 0=周日..6=周六);
  // 周末整天走错峰价, 不在任何高峰区间内。
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false; // 周六 / 周日 -> 非高峰
  const nowH = d.getUTCHours() + d.getUTCMinutes() / 60;
  return ranges.some(({ a, b }) => nowH >= a && nowH <= b); // end 包含
}

/** 时间戳着色函数: 请求所转发模型当前处于高峰窗口 -> 暗红 (与 RES 行 cost/credit 前缀 ^ 同口径,
 *  仅需模型目录收录该模型), 否则暗灰 cDim。未配置目录/未收录 -> 恒暗灰。 */
function peakTsColor(mapped) {
  if (!modelCatalog || !mapped) return cDim;
  const model = catalogModel(mapped);
  return model && inPeakWindow(model) ? cDimRed : cDim;
}

/**
 * 单次请求: 成本 (USD) + 额度 (credit)。
 *  - 无模型目录 / 未收录模型 / 无 usage -> { credit:0, cost:0, peak:false, rated:false }
 *  - monthlyCredits 缺失 (null) -> 成本照算, credit 记为 0, rated=false (不显示)
 *  - peak=true 表示当前 UTC 时刻处于该模型 offPeak 高峰窗口 (且为工作日), 已按峰值牌价
 *    (peakUsdPerMTok 覆盖 input/output/cacheRead) 计费
 *  - cost 为美元成本 (与 credit 不保持固定比例: 不同模型 monthlyCredits 不同)
 */
function calcCredit(usage, mapped) {
  if (!usage || !modelCatalog) return { credit: 0, cost: 0, peak: false, rated: false };
  const model = catalogModel(mapped);
  if (!model || !model.priceUsdPerMTok) return { credit: 0, cost: 0, peak: false, rated: false };
  const peak = inPeakWindow(model);
  const rate = { ...model.priceUsdPerMTok };
  if (peak && model.offPeak && model.offPeak.peakUsdPerMTok) {
    // 高峰覆盖: input/output/cacheRead。cacheRead 仅当峰值字段非 null 时覆盖
    // (schema@1 的 peakUsdPerMTok 只有 input/output, 缺 cacheRead 则沿用原价);
    // cacheWrite 无峰值概念, 沿用原价。
    const p = model.offPeak.peakUsdPerMTok;
    if (p.input != null) rate.input = p.input;
    if (p.output != null) rate.output = p.output;
    if (p.cacheRead != null) rate.cacheRead = p.cacheRead;
  }
  let cost = 0;
  for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
    const tokens = usage[k] || 0;
    const r = rate[k];
    if (r != null) cost += (tokens / 1e6) * r;
  }
  const mc = model.monthlyCredits;
  const credit = mc > 0 ? (cost * (modelCatalog.plan.credits || 0)) / mc : 0;
  return { credit, cost, peak, rated: mc > 0 };
}

/** 最近 n 个请求的聚合 */
function winAgg(n) {
  const slice = stats.recent.slice(-n);
  const agg = { in: 0, out: 0, rt: 0, cr: 0, ms: 0 };
  for (const r of slice) {
    agg.in += r.in;
    agg.out += r.out;
    agg.rt += r.rt;
    agg.cr += r.cr;
    agg.ms += r.ms;
  }
  return agg;
}

/** 速度数字格式化: 整数去 .0 */
const fmtSpeed = (v) => (v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, ""));

/** 百分比格式化: 最多 1 位小数, 整数不带小数点 (99% / 98.7%) */
const fmtPct = (p) => p.toFixed(1).replace(/\.0$/, "") + "%";

/** 生成滚动统计串: "ch:87% ^cost=$0.098 ^credit=0.014 ts:33/s,40/s,50/s"
 *  (ch 为会话累计, cost(橙)/credit(黄)紧跟其后, 高峰时 cost/credit 前缀加 ^ 替代原 peak^ 标记,
 *  ts 为滚动窗口, 各自波段色) */
function movingStatsStr(session, costStr, creditStr) {
  // ch: 按会话累计 (session.in / session.cr), 无会话时退化为当前次
  const chIn = session ? session.in : 0;
  const chCr = session ? session.cr : 0;
  const chTotal = chIn + chCr;
  const chPct = chTotal > 0 ? (chCr / chTotal) * 100 : 0;
  const chStr = cacheSegment("ch:" + (chTotal > 0 ? fmtPct(chPct) : "-"), chPct);
  const n = stats.recent.length;
  const levels = n >= 11 ? [1, 10, 50] : n >= 2 ? [1, 10] : [1];
  const tsParts = levels.map((win, i) => {
    const w = winAgg(win);
    // 生成 tokens = 输出 out + 思考 rt
    const v = w.ms > 0 ? (w.out + w.rt) / (w.ms / 1000) : 0;
    const text = (i === 0 ? "ts:" : ",") + (w.ms > 0 ? fmtSpeed(v) + "/s" : "-");
    return speedSegment(text, v);
  });
  return ` ${chStr}${costStr}${creditStr} ${tsParts.join("")}`;
}

/** 打印 TOD/ALL 统计行 (ch 与 ts 用波段色); cost 为累计成本 (橙), cred 为累计额度 (黄), avg 为单次平均额度 */
function statsLine(label, agg) {
  if (!agg || !agg.req) return;
  const totalIn = agg.in + agg.cr;
  const pct = totalIn > 0 ? (agg.cr / totalIn) * 100 : 0;
  const chStr = cacheSegment("ch:" + (totalIn > 0 ? fmtPct(pct) : "-"), pct);
  // 生成 tokens = 输出 out + 思考 rt
  const v = agg.ms > 0 ? (agg.out + agg.rt) / (agg.ms / 1000) : 0;
  const tsStr = speedSegment("ts:" + (agg.ms > 0 ? fmtSpeed(v) + "/s" : "-"), v);
  // 成本 (cost, 橙) / 额度 (credit, 黄): 均为 6 位小数, cost 在前, avg 为单次平均额度;
  // 插在 ch 之后 (顺序与 RES 行一致)
  const costStr = agg.cost > 0 ? cOrange(` cost:$${agg.cost.toFixed(6)}`) : "";
  const credStr = agg.credit > 0 ? cYellow(` credit:${agg.credit.toFixed(6)}`) : "";
  const avgStr = agg.credit > 0 ? cYellow(` avg:${(agg.credit / agg.req).toFixed(6)}`) : "";
  console.log(
    `${cDim(`[${logTs(Date.now())}]`)} ${cBlue("STATS")} ${label} req:${agg.req} in:${fmtNum(agg.in)} out:${fmtNum(agg.out)} rt:${fmtNum(agg.rt)} cr:${fmtNum(agg.cr)} cw:${fmtNum(agg.cw)} ${chStr}${costStr}${credStr}${avgStr} ${tsStr}`
  );
}

/** 打印 TOD/ALL 两行 (当天启动时 TOD 与 ALL 一致, 省略 ALL) */
function logStats() {
  statsLine("TOD", stats.today);
  const same =
    stats.today.req === stats.total.req &&
    ["in", "out", "rt", "cr", "cw", "ms", "credit", "cost"].every((k) => stats.today[k] === stats.total[k]);
  if (!same) statsLine("ALL", stats.total);
}

/** 记录一条请求: TOD/ALL 全部计入; 滚动窗口仅计入有 usage 的请求 (trackRolling) */
function accumulate(rec, trackRolling) {
  stats.today.req += 1;
  stats.total.req += 1;
  for (const k of ["in", "out", "rt", "cr", "cw", "ms", "credit", "cost"]) {
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
// 基线按 tools 哈希分桶: 主请求与并发小探测请求 (不同 tools) 交替到达时互不污染对比基线
const PFX_BUCKETS_MAX = 4;
function prefixDivergeMark(session, msgs, toolsJson, paramsJson) {
  if (!session) return { mark: "", detail: "" };
  const curMsgsJson = msgs.map((m) => JSON.stringify(m));
  const toolsHash = sha1(toolsJson);
  if (!session.pfx) session.pfx = new Map();
  const buckets = session.pfx;
  const prev = buckets.get(toolsHash);
  buckets.set(toolsHash, { msgs: curMsgsJson, params: paramsJson });
  while (buckets.size > PFX_BUCKETS_MAX) buckets.delete(buckets.keys().next().value);
  if (!prev) return { mark: "", detail: "" }; // 该 tools 组合首次请求, 无基线
  let i = 0;
  const common = Math.min(prev.msgs.length, curMsgsJson.length);
  while (i < common && prev.msgs[i] === curMsgsJson[i]) i++;
  if (i === common) {
    if (curMsgsJson.length < prev.msgs.length) {
      return { mark: `pfx<${curMsgsJson.length}`, detail: "历史变短 (压缩/重写)" };
    }
    // 消息纯追加: 再查 messages 之外的顶层参数 (max_tokens/temperature/tool_choice 等)
    if (prev.params !== paramsJson) {
      let keys = "";
      try {
        const a = JSON.parse(prev.params);
        const b = JSON.parse(paramsJson);
        keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
          .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
          .join(",");
      } catch { keys = "?"; }
      return { mark: "pfx~params", detail: `顶层参数变化: ${keys || "?"}` };
    }
    return { mark: "", detail: "" }; // 纯追加且参数一致, 健康
  }
  const role = (j) => {
    try { const m = JSON.parse(j); return m.role || m.type || "?"; } catch { return "?"; }
  };
  // 分叉内容预览, 总长固定 140 字符, 目标是让分叉点落在预览内可对齐比较:
  //   消息本身不超 140 -> 原样
  //   分叉点在 100 字符内 -> 头部截断 140 + "…" (分叉点后至少留 20 字符上下文)
  //   分叉点在 100 之外 -> 头 49 + "…" + 自分叉点往前 20 字符起、一直取到 140 撑满
  //     (前 20 + 后 70), 49+1+90=140 恰好撑满; 旧/新行分叉点列位一致, 便于对齐
  // 分叉段 (分叉起点至行尾) 以 \x01 起始标记, 打印时标橙; JSON.stringify 会转义
  // 控制符, 预览串中不会出现裸 \x01, 哨兵安全
  const PREVIEW_LEN = 140;
  const LOCATE_HEAD = 49; // 定位路径头部长度, 49 + 1("…") = 50
  const LOCATE_LEAD = 20; // 定位起点自分叉点往前追的字符数 (分叉点前定位窗口)
  const marked = (s, at) => (at < s.length ? s.slice(0, at) + "\x01" + s.slice(at) : s);
  const brief = (j, divAt) => {
    // 超 139 必带省略号: ≤139 原样 (含 140 整串时无尾缀), 否则截断到 140 (140 含尾部 …)
    if (j.length < PREVIEW_LEN) return marked(j, divAt);
    if (divAt < 100) return marked(j.slice(0, PREVIEW_LEN - 1) + "…", divAt);
    // divAt >= 100: 定位窗口 往前20+往后(撑到140), 头 49 + "…" + 定位子串
    const start = Math.max(0, divAt - LOCATE_LEAD); // 定位起点: 前追 20 (不足 20 则从 0)
    const locLen = PREVIEW_LEN - (LOCATE_HEAD + 1); // 定位子串长度 = 140 - 50 = 90
    return marked(j.slice(0, LOCATE_HEAD) + "…" + j.slice(start, start + locLen), LOCATE_HEAD + 1 + (divAt - start));
  };
  const a = prev.msgs[i], b = curMsgsJson[i];
  let d = 0;
  const n = Math.min(a.length, b.length);
  while (d < n && a[d] === b[d]) d++;
  return {
    mark: `pfx~${i}`,
    detail: `消息 ${i} (${role(a)}) 分叉:\n旧 ${brief(a, d)}\n新 ${brief(b, d)}`,
  };
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
//   id              —— 自增会话编号 (与 reqSeq 组成日志标签 S{id}#{reqSeq}, 如 S1#10)
//   reqSeq          —— 请求编号计数器 (每个 model 请求到达时递增, REQ/RES 行成对输出,
//                      如 S1#10 表示 1 号会话的第 10 个请求; 不要求有 usage)
//   seq             —— 请求序号 (仅对解析到 usage 的请求递增, 与 ch 统计同口径)
//   lastLowCacheSeq —— 最近一次 cachehit<50% 的请求序号 (用于计算 gap)
//   in / cr         —— 会话累计净输入 / 缓存读 (仅计有 usage 的请求), 用于输出会话累计 ch
const MODEL_PATHS = ["/v1/messages", "/v1/chat/completions", "/v1/responses"];
const sessions = new Map();
let nextSessionId = 1;
function getSession(key) {
  let s = sessions.get(key);
  if (!s) {
    s = { id: nextSessionId++, reqSeq: 0, pending: 0, seq: 0, lastLowCacheSeq: null, in: 0, cr: 0, pfx: null };
    sessions.set(key, s);
  }
  return s;
}

// 同会话上游请求串行化: CC 的探测请求 (会话标题生成) 与主请求毫秒级并发到达,
// 中转侧曾出现主请求 300s 无响应头悬挂; 同会话改为排队发送规避并发
// (config.serializeSessionRequests, 默认开)。排队中的请求若客户端断开,
// 会经由 abort 信号立即失败出队, 不会占用队列。release 幂等, 可多处调用。
function acquireSessionLock(session) {
  if (!session || !SERIALIZE_SESSION) return Promise.resolve(() => {});
  const prev = session.lock || Promise.resolve();
  let release;
  const gate = new Promise((r) => (release = r));
  session.lock = prev.then(() => gate);
  return prev.then(() => release);
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
// 标签专用色池 (7 色, 与 model 配色解耦): 按**请求**轮转从池中取色 (不按会话哈希),
// 闭包捕获后 REQ/RES 两行同色, 目的仅在呼应配对同一请求的两行日志
const TAG_COLORS = [cMagenta, cCyan, cYellow, cBrightGreen, cOrange, cGreen, cBlue];
let nextTagColor = 0;

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
  // 请求编号: 会话内自增计数器, REQ 行与 RES 行成对输出 (S1#10), 便于两行配对;
  // 非 model 请求无会话, 编号为 null 不输出。
  // 标签颜色按请求轮转取色 (非会话哈希), 闭包捕获保证 REQ/RES 两行同色
  const reqNo = session ? ++session.reqSeq : null;
  const tagColor = session ? TAG_COLORS[nextTagColor++ % TAG_COLORS.length] : null;
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
  // 带图标记: 请求体中检测到的图片块数 (Anthropic image / OpenAI image_url、input_image);
  // imgNew 为最后一条 user 消息 (本轮) 中的新图数, 仅 /v1/messages 链路计算
  const imgPart = () => {
    const c = req._cmdc;
    if (!c || !c.img) return "";
    const newSuffix = c.imgNew != null ? `(新${c.imgNew})` : "";
    return cMagenta(` img=${c.img}${newSuffix}`);
  };
  // 请求体大小 (帮助区分两条请求是否完全相同: 工具循环请求体递增, 重试请求体相同)
  const fmtBytes = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + "KB" : n + "B");
  const bodyPart = () => {
    const bb = req._cmdc.bodyBytes;
    return bb ? ` body=${fmtBytes(bb)}` : "";
  };
  // 会话+请求编号标签: 如 S1#10 = 1 号会话的第 10 个请求; 非 model 请求无会话, 返回空串;
  // 本轮带新图时标签前加 @ (无前导空格), 行拼接处按 @ 决定要不要补空格 ——
  // 无图行 "] S1#2", 带新图行 "]@S1#3" 紧贴时间戳
  let willQueue = false; // 本请求到达时同会话已有在途请求, RES 前的 REQ 行标 *
  const sessTag = () => {
    if (!session) return "";
    const at = req._cmdc && req._cmdc.imgNew ? "@" : "";
    return at + `S${session.id}#${reqNo}`;
  };
  // 会话标签前导空格: @ 开头(带新图)不补, 否则补一个空格 —— REQ/RES 行:
  // 无图 "] S1#2", 带新图 "]@S1#3" 紧贴时间戳
  const tagPad = () => (req._cmdc && req._cmdc.imgNew ? "" : " ");
  const logReq = () => {
    if (req._cmdc.reqLogged) return;
    req._cmdc.reqLogged = true;
    // 标签 S{id}#{req} 按请求轮转取色, REQ 恒为青色; model 提前到 src 之前, 扫日志先看模型
    const tag = sessTag();
    const tsColor = peakTsColor(req._cmdc.mapped); // 高峰暗红时间戳 (按本请求当前已定模型)
    console.log(`${tsColor(`[${logTs(startAt)}]`)}${tag ? `${tagPad()}${tagColor(tag)} ` : " "}${cCyan("REQ") + (willQueue ? cRed("*") : "")} ${req.method} ${pathname}${reqModelPart()} src=${srcIp}:${req.socket.remotePort || "-"} ua=${uaShort()}${streamPart()}${imgPart()}${cDim(bodyPart())}`);
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
  // 客户端断开联动: 断开即中止上游等待 (避免上游悬挂时黑等到 undici 300s 超时),
  // 并保证每个请求都有终态日志 (ABT 行), 不再出现 REQ 之后凭空消失的请求
  const upstreamAbort = new AbortController();
  let resFinished = false;
  res.on("error", () => {});
  res.on("close", () => {
    if (resFinished) return;
    upstreamAbort.abort(upstreamError("客户端断开", { clientAbort: true }));
    const waited = ((Date.now() - startAt) / 1000).toFixed(1);
    logSevere(req, pathname, session, `客户端断开 (已等待 ${waited}s, 未收到完整响应)`);
    console.warn(cRed(`[cmc-proxy]${sessTag()} ABT ${req.method} ${pathname} 客户端断开 (已等待 ${waited}s, 未收到完整响应)`));
  });
  // 上游请求异常收尾: 客户端断开时 socket 已死, 只记日志不写响应 (写必抛)
  const upstreamFail = (e) => {
    const msg = e.clientAbort ? "客户端断开, 放弃上游请求" : `上游请求失败: ${e.message}`;
    logSevere(req, pathname, session, msg);
    if (e.clientAbort) console.warn(cDim(`[cmc-proxy]${sessTag()} ${msg}`));
    else console.warn(TAGW, msg);
  };
  res.on("finish", () => {
    resFinished = true;
    // took 以真正发往上游的时刻起算 (排队等待单列 qwait), 对齐 provider 侧的 API 耗时
    const dispatchAt = req._cmdc && req._cmdc.dispatchAt;
    const ms = dispatchAt ? Date.now() - dispatchAt : Date.now() - startAt;
    const qwaitMs = dispatchAt ? dispatchAt - startAt : 0;
    const qwaitStr = qwaitMs > 500 ? ` ${cMagenta(`qwait:${(qwaitMs / 1000).toFixed(1)}s`)}` : "";
    const took = ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : ms + "ms";
    // usage 摘要: in / out / rt(思考) / cr(缓存读) / cw(缓存写)
    const u = req._cmdc && req._cmdc.usage;
    let usageStr = "";
    const rec = { in: 0, out: 0, rt: 0, cr: 0, cw: 0, ms, credit: 0, cost: 0 };
    rec.ms = ms; // 统计口径与 took 一致: 仅计发往上游之后的耗时 (排队等待单列 qwait)
    if (u) {
      // usage 摘要配色: in/out/cw 青色 (和谐), rt 紫色, cr 亮青突出 (缓存命中量)
      const parts = [];
      if (u.input != null) parts.push(cCyan(`in:${u.input}`));
      if (u.output != null) parts.push(cCyan(`out:${u.output}`));
      if (u.reasoning != null) parts.push(cMagenta(`rt:${u.reasoning}`));
      if (u.cacheRead != null) parts.push(cBrightCyan(`cr:${u.cacheRead}`));
      if (u.cacheWrite != null) parts.push(cCyan(`cw:${u.cacheWrite}`));
      if (parts.length) usageStr = ` ${parts.join(" ")}`;
      rec.in = u.input ?? 0;
      rec.out = u.output ?? 0;
      rec.rt = u.reasoning ?? 0;
      rec.cr = u.cacheRead ?? 0;
      rec.cw = u.cacheWrite ?? 0;
    }
    // 额度 (credit) / 成本 (cost): cost 为美元成本 (按牌价直接算), credit = cost ×
    // plan.credits / monthlyCredits; 高峰窗口内以峰值牌价计 (cacheRead 同被覆盖)。
    // 仅在有 usage 且模型目录收录时输出 (cost 照常输出, credit 另需 rated): cost=$N (橙)
    // credit=N (黄) 均 6 位小数, cost 在前; 高峰时段 cost/credit 前缀加 ^ (替代原 peak^ 标记),
    // 时间戳已同时暗红 (见 peakTsColor), 无需再单列 peak^。
    const cq = calcCredit(u, req._cmdc.mapped);
    rec.credit = cq.credit;
    rec.cost = cq.cost;
    const peakMark = cq.peak ? "^" : ""; // 高峰前缀: ^cost= / ^credit=
    const costStr = cq.cost > 0 ? cOrange(` ${peakMark}cost=$${cq.cost.toFixed(6)}`) : "";
    const creditStr = cq.rated && cq.credit > 0
      ? cYellow(` ${peakMark}credit=${cq.credit.toFixed(6)}`)
      : "";
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
    // 滚动统计仅在 200 且本次请求解析到 usage (输出 in/out/rt/cr/cw) 时追加;
    // peak/cost/credit 传入插在 ch 之后 (仅本次解析到 usage 时)
    const movingStr = usageStr ? movingStatsStr(session, costStr, creditStr) : "";
    // 前缀分叉标记: 仅在检测到分叉/压缩时输出 (纯追加为健康状态, 不输出); 分叉内容预览单独成行
    const pfx = (req._cmdc && req._cmdc.pfx) || { mark: "", detail: "" };
    const pfxMark = pfx.mark ? ` ${cRed(pfx.mark)}` : "";
    if (pfx.detail) {
      // 分叉预览逐行着色: 标记 \x01 之前红色 (与整行一致), 之后为分叉段标橙;
      // 不嵌套在 cRed 内 —— 橙段的复位码会连带复位外层红色
      const colored = useColor
        ? pfx.detail
            .split("\n")
            .map((l) => {
              const k = l.indexOf("\x01");
              return k < 0 ? cRed(l) : cRed(l.slice(0, k)) + cOrange(l.slice(k + 1));
            })
            .join("\n")
        : pfx.detail.replace(/\x01/g, "");
      console.warn(cRed(`[cmc-proxy] ${sessTag()} 前缀分叉: `) + colored);
    }
    const stFn = res.statusCode >= 500 ? cRed : res.statusCode >= 400 ? cYellow : res.statusCode >= 300 ? cCyan : cGreen;
    // 标签 S{id}#{req} 用该请求闭包捕获的颜色 (与 REQ 行同色); 状态码保持原波段色
    const tag = sessTag();
    const tsColor = peakTsColor(req._cmdc.mapped); // 高峰暗红时间戳 (按最终实际转发模型)
    console.log(`${tsColor(`[${logTs(Date.now())}]`)}${tag ? `${tagPad()}${tagColor(tag)} ` : " "}${stFn(`${res.statusCode}`)} ${req.method} ${pathname}${resModelPart()} ${cDim(`took=${took} out=${outBytes}B`)}${qwaitStr}${usageStr}${gapStr}${pfxMark}${movingStr}`);
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
      const isStream = !!body.stream;
      const imgCount = countImagesDeep(body);
      const imgNew = countLastUserImages(body);
      const isImage = imgCount > 0; // 请求类型 (原始请求体判定, 转换后可能因清理历史图变化)
      const requested = body.model || defaultForType(isImage);
      const { model: mapped, isFallback: mappedFallback } = pickModelWithFlag(body.model, isImage);
      const useAnthropicEndpoint = isClaudeModel(mapped);
      req._cmdc = { model: requested, mapped, stream: isStream, img: imgCount, imgNew };
      req._cmdc.bodyBytes = Buffer.byteLength(bodyRaw || "");
      req._cmdc.rawBody = bodyRaw || "";
      willQueue = !!(session && (session.pending || 0) > 0);
      if (session) session.pending = (session.pending || 0) + 1;
      logReq();

      if (useAnthropicEndpoint) {
        // Claude 模型 -> 直接走上游 /messages
        body.model = mapped;
        const upstreamBodyJson = JSON.stringify(body);
        req._cmdc.upstreamBody = upstreamBodyJson;
        if (LOG_LEVEL >= 3) fulllogDump(req, pathname, session, [["client", bodyRaw], ["upstream", upstreamBodyJson]]);
        const releaseUp0 = await acquireSessionLock(session);
        req._cmdc.dispatchAt = Date.now(); // took 从真正发往上游起算, 排队等待单列 qwait
        let upReleased = false;
        const releaseUp = () => {
          if (upReleased) return;
          upReleased = true;
          if (session) session.pending = Math.max(0, (session.pending || 0) - 1);
          releaseUp0();
        };
        req._cmdc.releaseUp = releaseUp;
        let up;
        try {
          up = await upstreamFetchRotate(`${UPSTREAM}/v1/messages`, {
            method: "POST",
            headers: buildUpstreamHeaders(req, {
              "Content-Type": "application/json",
              "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
            }),
            body: JSON.stringify(body),
          }, mapped, upstreamAbort.signal, { sessTag, onModel: (m) => { req._cmdc.mapped = m; }, isFallback: mappedFallback });
        } catch (e) {
          releaseUp();
          upstreamFail(e);
          if (e.clientAbort) return;
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "上游请求失败: " + e.message } }));
          return;
        }
        if (!up.ok) {
          // upstreamFetchRotate 已计失败并可能切换默认模型 (switchOnFail=true 时已就地轮换重试)
          await passThrough(res, up, { onDone: releaseUp });
          return;
        }
        await passThrough(res, up, { collectUsage: (u) => { req._cmdc.usage = normalizeUsage(u); }, onDone: releaseUp });
        return;
      }

      // 非 Claude 模型 -> Anthropic -> OpenAI 协议转换
      // cleanHistoryImages: 本轮无新图时剥离历史图片, 请求可安全走纯文本模型;
      // 路由判断基于转换后的消息, 历史图被剥后自然不触发, 只看新图
      if (CLEAN_HISTORY_IMAGES && !imgNew) stripHistoryImages(body);
      // 用"剥离后的最终请求类型"重新决策模型并覆盖, 转换函数使用
      const finalImage = imgCount > 0 && !(CLEAN_HISTORY_IMAGES && imgNew === 0);
      const finalDecision = pickModelWithFlag(body.model, finalImage);
      body.model = finalDecision.model;
      const oaiReq = anthropicToOpenAIRequest(body, sessionKey);
      // 带图请求: 按请求类型 (text/image) 选择轮换列表; 首个候选是最终决策的模型
      const upstreamBodyJson = JSON.stringify(oaiReq);
      req._cmdc.mapped = oaiReq.model;
      req._cmdc.upstreamBody = upstreamBodyJson;
      const pfx = prefixDivergeMark(session, oaiReq.messages, JSON.stringify(oaiReq.tools || ""), JSON.stringify({ ...oaiReq, messages: undefined }));
      req._cmdc.pfx = pfx;
      if (shouldDumpRequest(pfx.mark)) {
        fulllogDump(req, pathname, session, [["client", bodyRaw], ["upstream", upstreamBodyJson]], pfx.mark ? `前缀分叉 ${pfx.mark}` : undefined);
      }
      const releaseUp0 = await acquireSessionLock(session);
      req._cmdc.dispatchAt = Date.now(); // took 从真正发往上游起算, 排队等待单列 qwait
      let upReleased = false;
      const releaseUp = () => {
        if (upReleased) return;
        upReleased = true;
        if (session) session.pending = Math.max(0, (session.pending || 0) - 1);
        releaseUp0();
      };
      req._cmdc.releaseUp = releaseUp;
      let up;
      try {
        up = await upstreamFetchRotate(`${UPSTREAM}/v1/chat/completions`, {
          method: "POST",
          headers: buildUpstreamHeaders(req, { "Content-Type": "application/json" }),
          body: JSON.stringify(oaiReq),
        }, oaiReq.model, upstreamAbort.signal, { sessTag, onModel: (m) => { req._cmdc.mapped = m; }, isImage: finalImage, isFallback: finalDecision.isFallback });
      } catch (e) {
        releaseUp();
        upstreamFail(e);
        if (e.clientAbort) return;
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "上游请求失败: " + e.message } }));
        return;
      }

      if (!isStream) {
        // 非流式: 整体转换
        const text = await up.text();
        releaseUp();
        if (!up.ok) {
          // upstreamFetchRotate 已计失败并可能切换默认模型 (switchOnFail=true 时已就地轮换重试)
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
        releaseUp();
        res.writeHead(up.status, { "Content-Type": "application/json" });
        res.end(text);
        return;
      }
      const conv = new StreamConverter(requested, estimateInputTokens(body));
      await pumpConvertedStream(up, conv, res, "messages", releaseUp);
      req._cmdc.usage = normalizeUsage(conv.rawUsage);
      return;
    }

    // ---- /v1/chat/completions (OpenAI 格式) ----
    if (pathname === "/v1/chat/completions" && req.method === "POST") {
      const bodyRaw = await readBody(req);
      const body = JSON.parse(bodyRaw || "{}");
      const imgCount = countImagesDeep(body);
      const isImage = imgCount > 0;
      const requested = body.model || defaultForType(isImage);
      const decision = pickModelWithFlag(body.model, isImage);
      body.model = decision.model;
      req._cmdc = { model: requested, mapped: body.model, stream: !!body.stream, img: imgCount };
      req._cmdc.bodyBytes = Buffer.byteLength(bodyRaw || "");
      req._cmdc.rawBody = bodyRaw || "";
      willQueue = !!(session && (session.pending || 0) > 0);
      if (session) session.pending = (session.pending || 0) + 1;
      logReq();
      const upstreamBodyJson = JSON.stringify(body);
      req._cmdc.upstreamBody = upstreamBodyJson;
      if (LOG_LEVEL >= 3) fulllogDump(req, pathname, session, [["client", bodyRaw], ["upstream", upstreamBodyJson]]);
      const releaseUp0 = await acquireSessionLock(session);
        req._cmdc.dispatchAt = Date.now(); // took 从真正发往上游起算, 排队等待单列 qwait
        let upReleased = false;
        const releaseUp = () => {
          if (upReleased) return;
          upReleased = true;
          if (session) session.pending = Math.max(0, (session.pending || 0) - 1);
          releaseUp0();
        };
        req._cmdc.releaseUp = releaseUp;
      let up;
      try {
        up = await upstreamFetchRotate(`${UPSTREAM}/v1/chat/completions`, {
          method: "POST",
          headers: buildUpstreamHeaders(req, { "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        }, body.model, upstreamAbort.signal, { sessTag, onModel: (m) => { req._cmdc.mapped = m; }, isImage, isFallback: decision.isFallback });
      } catch (e) {
        releaseUp();
        upstreamFail(e);
        if (e.clientAbort) return;
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "上游请求失败: " + e.message, type: "api_error" } }));
        return;
      }
      // upstreamFetch 已处理失败/成功计数 (非 2xx 已计失败并可能切换默认模型)
      await passThrough(res, up, { collectUsage: (u) => { req._cmdc.usage = normalizeUsage(u); }, onDone: releaseUp });
      return;
    }

    // ---- /v1/responses (Codex wire_api="responses") ----
    // Codex 新版只支持 Responses API; commandcode 上游仅提供 chat/completions,
    // 因此在此做 Responses <-> Chat Completions 协议转换。
    if (pathname === "/v1/responses" && req.method === "POST") {
      const bodyRaw = await readBody(req);
      const body = JSON.parse(bodyRaw || "{}");
      const isStream = !!body.stream;
      const imgCount = countImagesDeep(body);
      const requested = body.model || defaultForType(imgCount > 0);
      const decision = pickModelWithFlag(body.model, imgCount > 0);
      const mapped = decision.model;
      body.model = mapped; // 转换函数使用
      req._cmdc = { model: requested, mapped, stream: isStream, img: imgCount };
      req._cmdc.bodyBytes = Buffer.byteLength(bodyRaw || "");
      req._cmdc.rawBody = bodyRaw || "";
      willQueue = !!(session && (session.pending || 0) > 0);
      if (session) session.pending = (session.pending || 0) + 1;
      logReq();

      const { chat: chatReq, customToolNames } = responsesToChatRequest(body, sessionKey);
      // 带图请求: 按请求类型 (text/image) 选择轮换列表; 首个候选仍是解析后的模型
      const isImage = openAIMessagesHaveImages(chatReq.messages);
      const upstreamBodyJson = JSON.stringify(chatReq);
      req._cmdc.upstreamBody = upstreamBodyJson;
      const pfx = prefixDivergeMark(session, chatReq.messages, JSON.stringify(chatReq.tools || ""), JSON.stringify({ ...chatReq, messages: undefined }));
      req._cmdc.pfx = pfx;
      if (shouldDumpRequest(pfx.mark)) {
        fulllogDump(req, pathname, session, [["client", bodyRaw], ["upstream", upstreamBodyJson]], pfx.mark ? `前缀分叉 ${pfx.mark}` : undefined);
      }
      const releaseUp0 = await acquireSessionLock(session);
        req._cmdc.dispatchAt = Date.now(); // took 从真正发往上游起算, 排队等待单列 qwait
        let upReleased = false;
        const releaseUp = () => {
          if (upReleased) return;
          upReleased = true;
          if (session) session.pending = Math.max(0, (session.pending || 0) - 1);
          releaseUp0();
        };
        req._cmdc.releaseUp = releaseUp;
      let up;
      try {
        up = await upstreamFetchRotate(`${UPSTREAM}/v1/chat/completions`, {
          method: "POST",
          headers: buildUpstreamHeaders(req, { "Content-Type": "application/json" }),
          body: JSON.stringify(chatReq),
        }, mapped, upstreamAbort.signal, { sessTag, onModel: (m) => { req._cmdc.mapped = m; }, isImage, isFallback: decision.isFallback });
      } catch (e) {
        releaseUp();
        upstreamFail(e);
        if (e.clientAbort) return;
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "上游请求失败: " + e.message, type: "api_error" } }));
        return;
      }

      if (!isStream) {
        const text = await up.text();
        releaseUp();
        if (!up.ok) {
          // upstreamFetchRotate 已计失败并可能切换默认模型 (switchOnFail=true 时已就地轮换重试)
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
        releaseUp();
        res.writeHead(up.status, { "Content-Type": "application/json" });
        res.end(text);
        return;
      }
      const conv = new ResponsesStreamConverter(requested, estimateInputTokens(body), customToolNames);
      await pumpConvertedStream(up, conv, res, "responses", releaseUp);
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
      if (FULLLOG_PATH && init.body != null) fulllogDump(req, pathname, null, [["client", init.body], ["upstream", init.body]]);
      const up = await fetch(`${UPSTREAM}${upstreamPath}${url.search}`, init);
      await passThrough(res, up);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Not found: ${pathname}`, type: "invalid_request_error" } }));
  } catch (e) {
    // 兜底释放会话锁 (正常路径已在各分支释放; release 幂等, 重复调用无副作用)
    if (req._cmdc && req._cmdc.releaseUp) req._cmdc.releaseUp();
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
  const dmList = defaultModels.map((m, i) => (i === 0 ? `${m}(默认)` : m)).join(" → ");
  const vmList = defaultVisionModels.map((m, i) => (i === 0 ? `${m}(默认)` : m)).join(" → ") || "(无)";
  console.log(cBlue(`  默认模型   : ${dmList}`));
  console.log(cBlue(`  视觉模型   : ${vmList}`));
  const sofDesc = switchOnFailRaw && typeof switchOnFailRaw === "object"
    ? `对象 {text:${!!switchOnFailRaw.text}, image:${!!switchOnFailRaw.image}}`
    : SWITCH_ON_FAIL ? "开启" : "关闭";
  console.log(cBlue(`  失败轮换   : ${defaultModels.length < 2 && defaultVisionModels.length < 2 ? "不适用 (列表仅一个模型, 不轮换)" : `${sofDesc} (失败1次即切换 + ${FAIL_TTL / 1000}s 冷却)`}`));
  console.log(cBlue(`  历史图清理 : ${CLEAN_HISTORY_IMAGES ? "开启 (无新图请求时剥离历史图, 回流请求指定模型)" : "关闭 (历史图随上下文保留)"}`));
  console.log(cBlue(`  tool结果图 : ${TOOL_RESULT_IMAGES ? "保留 (注入 user 消息透传)" : "丢弃 (折叠为 [image])"}`));
  console.log(cBlue(`  模型目录   : ${modelCatalog ? `已加载 (${modelCatalog.index.size} 个模型, ${MODEL_CATALOG_PATH})` : (config.modelCatalog ? "未加载 (文件缺失或解析失败)" : "未配置 (不统计额度)")}`));
  console.log(cBlue("-".repeat(58)));
  console.log(cBlue("  Claude Code 接入:  export ANTHROPIC_BASE_URL=http://localhost:" + PORT));
  console.log(cBlue("  Codex 接入:        base_url = http://localhost:" + PORT + "/v1  (wire_api = responses)"));
  console.log(line);
  // 启动时预热模型列表
  refreshModels(true);
});
