#!/usr/bin/env node
/**
 * goat-prices — 抓取 commandcode.ai GOAT 计划价格页, 规范化为可查询 JSON 并提供计费入口
 * =====================================================================================
 * 独立模块, 与 proxy.js 无耦合 (零第三方依赖, Node.js >= 18); 主程序可 require 本模块
 * 读取价格文件计算 API 调用费用 (loadPrices / findModel / calcCost, 见文末导出)。
 * 输出格式与字段定义见 goat-prices.schema.md (schema: cmc-proxy/goat-prices@1)。
 *
 * 用法:
 *   node goat-prices.js                                  抓取并写 goat-prices.json, 打印摘要
 *   node goat-prices.js --out p.json / --no-save         自定义输出 / 只打印
 *   node goat-prices.js --cost "GLM-5.3 Flash" 1e6 5e5 8e5
 *       按 <模型> <input> <output> [cacheRead] [cacheWrite] (token 数) 计算一次调用的费用
 *
 * 页面 (https://commandcode.ai/docs/plans/goat) 为 Next.js SSR, 4 张表直接内嵌 HTML:
 *   表1 模型总表 (Model/Context/Intelligence/Tok/s/Input/Output/Cache read/Cache write/Caps)
 *   表2 每模型限额 (Model/Requests per 5h/week/month)
 *   表3+4 模型单价 · 上下两段 (Model/Input/Output/Cache Read/Cache Write/Monthly credits)
 * 单元格文本噪音在规范化阶段处理:
 *   - 模型名可能拼接 off-peak 脚注句 (Off-peak shown ... · peak $a / $b ...) -> offPeak 字段
 *   - 折扣徽章 (-50%) / Free 徽章拼在名后               -> discountPct / isFree
 *   - 划线原价+折后价合并 ("$0.80$0.30")                 -> listPriceUsdPerMTok + priceUsdPerMTok
 *   - 上标脚注引用 ("$0.66+1")                           -> footnotes: [1]
 */

const fs = require("fs");
const PAGE_URL = "https://commandcode.ai/docs/plans/goat";
const SCHEMA = "cmc-proxy/goat-prices@1";
// 计划常量取自页面文案 ($10/月, $70 credits, 7x 乘数), 页面调整时更新
const PLAN = { name: "GOAT", monthlyUsd: 10, credits: 70, multiplier: 7 };

// ---------------------------------------------------------------- HTML 解析 --

/** HTML 实体解码 (常用命名实体 + 数字实体) */
function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—" };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (_, n) => named[n.toLowerCase()] ?? `&${n};`);
}

/** 单元格取文本: 去 svg/button 等嵌套标签后剥离剩余标签 */
function cellText(html) {
  return decodeEntities(
    html.replace(/<svg[\s\S]*?<\/svg>/gi, "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")
  ).replace(/\s+/g, " ").trim();
}

/** 从 HTML 中解析全部表格 -> [{ header: [...], rows: [[...]] }] */
function parseTables(html) {
  return [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map(([, t]) => {
    const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(
      ([, r]) => [...r.matchAll(/<t([dh])[^>]*>([\s\S]*?)<\/t\1>/gi)].map(([, , c]) => cellText(c))
    );
    const header = rows.length && rows[0].some((c) => c) ? rows.shift() : [];
    return { header, rows: rows.filter((r) => r.some((c) => c)) };
  });
}

// ---------------------------------------------------------------- 单元格取值 --

/** "1M"/"262K"/"1.1M"/"—" -> token 数 | null */
function parseTokens(s) {
  const m = /^([\d.]+)\s*([MK])?$/i.exec(s.trim());
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6 }[(m[2] || "").toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

/** 价格单元格 "$0.15" / "$0.66+1" / "$0.80$0.30+1" / "Free" / "-"
 *  -> { price, list, footnotes } | null (list 为划线原价, 折扣行才有) */
function parsePriceCell(s) {
  if (/^free/i.test(s)) return { price: 0, list: null, footnotes: [] };
  const footnotes = [...s.matchAll(/\+(\d)\b/g)].map((m) => +m[1]);
  const amounts = [...s.matchAll(/\$([\d.]+)/g)].map((m) => parseFloat(m[1]));
  if (!amounts.length) return null;
  return amounts.length >= 2
    ? { price: amounts[1], list: amounts[0], footnotes }
    : { price: amounts[0], list: null, footnotes };
}

/** 模型名单元格 -> { name, slug, discountPct, isFree, offPeak }
 *  offPeak 脚注句: "Off-peak shown (17h/day) · peak $0.44 / $1.32 01–04 & 06–10 UTC" */
function parseModelName(cell) {
  let s = cell;
  let offPeak = null;
  const om = /Off-peak shown \(([^)]*)\) · peak \$([\d.]+) \/ \$([\d.]+)\s*(.*)$/.exec(s);
  if (om) {
    offPeak = {
      schedule: om[1].trim(),
      peakUsdPerMTok: { input: parseFloat(om[2]), output: parseFloat(om[3]) },
      windows: om[4].trim(),
    };
    s = s.slice(0, om.index);
  }
  let isFree = false;
  if (/Free$/i.test(s)) { isFree = true; s = s.replace(/\s*Free$/i, ""); }
  let discountPct = null;
  const dm = /-(\d+)%$/.exec(s);
  if (dm) { discountPct = +dm[1]; s = s.slice(0, dm.index); }
  const name = s.replace(/\s+/g, " ").trim();
  const slug = name
    .toLowerCase()
    .replace(/\((?:latest|exp)\)/g, "")
    .replace(/[^a-z0-9.+]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return { name, slug, discountPct, isFree, offPeak };
}

/** 归一化查询键 (供 findModel 用): 与 slug 同规则 */
function toSlug(name) {
  return parseModelName(name).slug;
}

// ---------------------------------------------------------------- 表格 -> 模型记录 --

function blankModel(parsed) {
  return {
    name: parsed.name,
    slug: parsed.slug,
    contextTokens: null,
    intelligence: null,
    tokPerS: null,
    priceUsdPerMTok: { input: null, output: null, cacheRead: null, cacheWrite: null },
    listPriceUsdPerMTok: null,
    discountPct: parsed.discountPct,
    isFree: parsed.isFree,
    offPeak: parsed.offPeak,
    monthlyCredits: null,
    quotas: null,
    footnotes: [],
    caps: null,
  };
}

const num = (s) => {
  const v = parseFloat(String(s).replace(/[$,]/g, ""));
  return Number.isFinite(v) ? v : null;
};

/** 把某行数据并入模型记录 (同模型可能出现在总表/单价表/限额表, 按 slug 合并) */
function mergeRow(models, kind, header, row) {
  // 列名匹配做归一化 (去非字母数字): 总表表头带排序箭头 "Model↕", 精确等值会失配
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const headerNorm = header.map(norm);
  const get = (title) => {
    const i = headerNorm.indexOf(norm(title));
    return i >= 0 ? row[i] || "" : "";
  };
  const parsed = parseModelName(get("Model"));
  if (!parsed.name) return;
  if (!models.has(parsed.slug)) models.set(parsed.slug, blankModel(parsed));
  const m = models.get(parsed.slug);
  if (kind === "quota") {
    m.quotas = {
      per5h: num(get("Requests / 5 hours")),
      perWeek: num(get("Requests / week")),
      perMonth: num(get("Requests / month")),
    };
    return;
  }
  // overview 与 pricing 表共享 Input/Output/Cache read/Cache write 列
  for (const [key, titles] of [
    ["input", ["Input"]],
    ["output", ["Output"]],
    ["cacheRead", ["Cache read", "Cache Read"]],
    ["cacheWrite", ["Cache write", "Cache Write"]],
  ]) {
    const p = parsePriceCell(get(titles[0]));
    if (p) {
      m.priceUsdPerMTok[key] = p.price;
      if (p.list != null) {
        m.listPriceUsdPerMTok = m.listPriceUsdPerMTok || { input: null, output: null, cacheRead: null, cacheWrite: null };
        m.listPriceUsdPerMTok[key] = p.list;
      }
      m.footnotes = [...new Set([...m.footnotes, ...p.footnotes])];
    }
  }
  if (kind === "overview") {
    m.contextTokens = parseTokens(get("Context")) ?? m.contextTokens;
    m.intelligence = num(get("Intelligence")) ?? m.intelligence;
    m.tokPerS = num(get("Tok/s")) ?? m.tokPerS;
    m.caps = get("Caps") || m.caps;
  } else {
    // credits 列同样存在划线原价+折后价合并 ("$70$35"), 取折后值
    const c = parsePriceCell(get("Monthly credits"));
    if (c) m.monthlyCredits = c.price;
  }
}

// ---------------------------------------------------------------- 主流程 --

async function fetchPrices() {
  const res = await fetch(PAGE_URL, { headers: { "user-agent": "Mozilla/5.0 (goat-prices script)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();
  const tables = parseTables(html);
  if (!tables.length) throw new Error("页面中未解析到表格 (页面结构可能已变化)");

  const models = new Map();
  for (const { header, rows } of tables) {
    const sig = header.map((h) => h.toLowerCase()).join("|");
    const kind = sig.includes("requests / 5 hours") ? "quota"
      : sig.includes("context") && sig.includes("caps") ? "overview"
      : sig.includes("input") && sig.includes("monthly credits") ? "pricing"
      : null;
    if (!kind) continue;
    for (const row of rows) mergeRow(models, kind, header, row);
  }
  return {
    schema: SCHEMA,
    fetchedAt: new Date().toISOString(),
    source: PAGE_URL,
    plan: PLAN,
    models: [...models.values()],
  };
}

// ---------------------------------------------------------------- 计费入口 (供主程序 require) --

/** 读取价格文件 -> { data, index } ; index: slug -> model (O(1) 查询) */
function loadPrices(file = "goat-prices.json") {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.schema !== SCHEMA) throw new Error(`价格文件 schema 不兼容: ${data.schema} (期望 ${SCHEMA})`);
  const index = new Map(data.models.map((m) => [m.slug, m]));
  return { data, index };
}

/** 按显示名或 slug 查模型 (显示名先按 slug 规则归一化, 再精确匹配) */
function findModel(prices, nameOrSlug) {
  return prices.index.get(toSlug(nameOrSlug)) || null;
}

/**
 * 计算一次调用的费用 (USD, 按页面牌价; credits 与 USD 1:1)
 * @param model findModel 的结果
 * @param usage token 用量 { input, output, cacheRead, cacheWrite }, 缺省 0
 * @returns { totalUsd, breakdown } | null (模型未收录/无牌价时对应项按 0 计并置 rated=false)
 */
function calcCost(model, usage = {}) {
  if (!model) return null;
  const breakdown = {};
  let totalUsd = 0;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    const tokens = usage[key] || 0;
    const rate = model.priceUsdPerMTok[key];
    const usd = rate != null ? (tokens / 1e6) * rate : 0;
    breakdown[key] = { tokens, rateUsdPerMTok: rate, usd, rated: rate != null };
    totalUsd += usd;
  }
  return { totalUsd, breakdown };
}

// ---------------------------------------------------------------- CLI --

function printSummary(data) {
  console.log(`GOAT 计划: $${data.plan.monthlyUsd}/月 = ${data.plan.credits} credits (x${data.plan.multiplier})`);
  console.log(`模型 ${data.models.length} 个, 抓取于 ${data.fetchedAt}\n`);
  const rows = data.models.map((m) => [
    m.name + (m.discountPct ? ` (-${m.discountPct}%)` : "") + (m.isFree ? " [Free]" : ""),
    m.priceUsdPerMTok.input ?? "-", m.priceUsdPerMTok.output ?? "-",
    m.priceUsdPerMTok.cacheRead ?? "-", m.monthlyCredits ?? "-",
  ]);
  const header = ["Model", "In$/M", "Out$/M", "CacheR$/M", "Credits"];
  const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join("  ");
  console.log(line(header));
  console.log(w.map((x) => "-".repeat(x)).join("  "));
  for (const r of rows) console.log(line(r));
}

async function main() {
  const args = process.argv.slice(2);
  const costIdx = args.indexOf("--cost");
  if (costIdx >= 0) {
    const [name, input, output, cacheRead, cacheWrite] = args.slice(costIdx + 1);
    const { data } = loadPrices(args.includes("--out") ? args[args.indexOf("--out") + 1] : "goat-prices.json");
    const model = findModel({ index: new Map(data.models.map((m) => [m.slug, m])) }, name);
    const cost = calcCost(model, { input: +input, output: +output, cacheRead: +cacheRead || 0, cacheWrite: +cacheWrite || 0 });
    if (!model) { console.error(`未收录模型: ${name}`); process.exit(1); }
    console.log(`${model.name}: $${cost.totalUsd.toFixed(4)} (credits 同值)`);
    for (const [k, v] of Object.entries(cost.breakdown)) {
      console.log(`  ${k.padEnd(10)} ${String(v.tokens).padStart(12)} tok x $${v.rateUsdPerMTok}/M = $${v.usd.toFixed(4)}${v.rated ? "" : "  (无牌价, 未计)"}`);
    }
    return;
  }
  const outPath = args.includes("--out") ? args[args.indexOf("--out") + 1] : "goat-prices.json";
  const save = !args.includes("--no-save");
  const data = await fetchPrices();
  printSummary(data);
  if (save) {
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`\n已写入 ${outPath} (schema ${SCHEMA})`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
} else {
  module.exports = { SCHEMA, fetchPrices, loadPrices, findModel, calcCost, toSlug };
}
