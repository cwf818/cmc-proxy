#!/usr/bin/env node
/**
 * goat-prices — 抓取 commandcode.ai GOAT 计划价格, 规范化为可查询 JSON 并提供计费入口
 * =====================================================================================
 * 独立模块, 与 proxy.js 无耦合 (零第三方依赖, Node.js >= 18); 主程序可 require 本模块
 * 读取价格文件计算 API 调用费用 (loadPrices / findModel / calcCost, 见文末导出)。
 * 输出格式与字段定义见 goat-prices.schema.md (schema: cmc-proxy/goat-prices@2)。
 *
 * 数据源 (Next.js SSR, 直接 fetch 解析, 无需浏览器):
 *   1. RSC payload (self.__next_f.push 内嵌 JSON) —— 主数据源, 含:
 *      - 每模型完整目录: slug/id/vendor/contextWindow/各价格/评分/releaseDate
 *      - tiers: 上下文分段价格 (band), 含 cacheRead/cacheWrite 每档
 *      - timeOfDay: off-peak 计价 (含 cacheRead 峰值)
 *      - deal: 折扣 (discountPercent)
 *   2. 页面表格 (HTML <table>) —— 补充 credits (Monthly credits) 与 quotas (限额)
 *      (模型名单元格的 info tooltip 为点击渲染, 静态 HTML 不含更多信息, 已弃用)
 *
 * 用法:
 *   node goat-prices.js                                  抓取并写 goat-prices.json, 打印摘要
 *   node goat-prices.js --out p.json / --no-save         自定义输出 / 只打印
 *   node goat-prices.js --cost "GLM-5.3 Flash" 1e6 5e5 8e5
 *       按 <模型> <input> <output> [cacheRead] [cacheWrite] (token 数) 计算一次调用的费用
 */

const fs = require("fs");
const PAGE_URL = "https://commandcode.ai/docs/plans/goat";
const SCHEMA = "cmc-proxy/goat-prices@2";
// 计划常量取自页面文案 ($10/月, $70 credits, 7x 乘数), 页面调整时更新
const PLAN = { name: "GOAT", monthlyUsd: 10, credits: 70, multiplier: 7 };

// ---------------------------------------------------------------- HTML 工具 --

function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—" };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (_, n) => named[n.toLowerCase()] ?? `&${n};`);
}

function cellText(html) {
  return decodeEntities(
    html.replace(/<svg[\s\S]*?<\/svg>/gi, "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")
  ).replace(/\s+/g, " ").trim();
}

/** 从 HTML 解析全部表格 -> [{ header: [...], rows: [[...]] }] */
function parseTables(html) {
  return [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map(([, t]) => {
    const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(
      ([, r]) => [...r.matchAll(/<t([dh])[^>]*>([\s\S]*?)<\/t\1>/gi)].map(([, , c]) => cellText(c))
    );
    const header = rows.length && rows[0].some((c) => c) ? rows.shift() : [];
    return { header, rows: rows.filter((r) => r.some((c) => c)) };
  });
}

// ---------------------------------------------------------------- RSC 解析 (主数据源) --

/**
 * 从 RSC payload 提取全部模型记录并解码为干净对象。
 * RSC 内模型对象形如 {\"slug\":...,\"tiers\":[...]}, 键/值被多层反斜杠转义。
 * 提取策略: 定位 \”name\":\” 起点, 以花括号配平取整个对象, 逐层去转义后 JSON.parse。
 */
function extractRscModels(html) {
  const needle = '\\"name\\":\\"';
  const models = [];
  let i = 0, guard = 0;
  while ((i = html.indexOf(needle, i)) >= 0 && guard++ < 500) {
    const name = html.slice(i + needle.length).split('\\"')[0];
    const seg = html.slice(i, i + 2000);
    if (!seg.includes("tiers")) { i += needle.length; continue; }
    const objStart = html.lastIndexOf("{", i);
    let depth = 0, end = -1;
    for (let k = objStart; k < html.length; k++) {
      if (html[k] === "{") depth++;
      else if (html[k] === "}") { depth--; if (depth === 0) { end = k + 1; break; } }
    }
    const raw = html.slice(objStart, end);
    if (!models.some((m) => m.name === name)) models.push({ name, raw });
    i = end;
  }
  // 逐层去转义 + JSON.parse
  const decoded = [];
  for (const m of models) {
    let s = m.raw, out = null;
    for (let layer = 0; layer < 4; layer++) {
      try { out = JSON.parse(s); break; } catch {}
      const s1 = s.replace(/\\\\/g, "\\");
      try { out = JSON.parse(s1); break; } catch {}
      s = s1.replace(/\\"/g, '"');
    }
    if (out && out.name) decoded.push(out);
  }
  return decoded;
}

// ---------------------------------------------------------------- 表格补充 (credits/quotas) --

const num = (s) => {
  const v = parseFloat(String(s).replace(/[$,]/g, ""));
  return Number.isFinite(v) ? v : null;
};

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

/** 从表格行补充模型的 credits / quotas (按模型名匹配, 名做归一化) */
function mergeTableExtras(models, header, row) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9.]+/g, "");
  const headerNorm = header.map(norm);
  const get = (title) => {
    const i = headerNorm.indexOf(norm(title));
    return i >= 0 ? row[i] || "" : "";
  };
  // 模型名单元格: 去脚注/徽章后按名匹配 (RSC 的 name)
  let cellName = get("Model");
  if (/\bFree$/i.test(cellName)) cellName = cellName.replace(/\s*Free$/i, "");
  const model = models.find((m) => norm(m.name) === norm(cellName) || norm(m.slug) === norm(cellName));
  if (!model) return;
  if (get("Monthly credits")) {
    const c = parsePriceCell(get("Monthly credits"));
    if (c && c.price != null) model.monthlyCredits = c.price;
  }
  if (get("Requests / 5 hours")) {
    model.quotas = {
      per5h: num(get("Requests / 5 hours")),
      perWeek: num(get("Requests / week")),
      perMonth: num(get("Requests / month")),
    };
  }
}

// ---------------------------------------------------------------- 模型记录规范化 --

/** 把 RSC 模型对象规范化为 schema@2 的 ModelRecord */
function normalizeRscModel(m) {
  // 有效单价: 有 timeOfDay 取 offPeak, 否则取平铺价 (tiers 单档或顶层 inputCost)
  const hasToD = m.timeOfDay && typeof m.timeOfDay === "object" && m.timeOfDay.offPeak;
  const base = hasToD ? m.timeOfDay.offPeak : m;
  const priceUsdPerMTok = {
    input: base.input ?? m.inputCost ?? null,
    output: base.output ?? m.outputCost ?? null,
    cacheRead: base.cacheRead ?? m.cacheReadCost ?? null,
    cacheWrite: m.cacheWriteCost && m.cacheWriteCost !== "$undefined" ? m.cacheWriteCost : null,
  };
  // listPrice: deal 折扣下的原价 (deal.discountPercent 或 tiers listRates)
  let listPriceUsdPerMTok = null;
  if (m.deal && typeof m.deal === "object" && m.deal.discountPercent) {
    listPriceUsdPerMTok = {};
    for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
      const p = priceUsdPerMTok[k];
      listPriceUsdPerMTok[k] = p != null ? p / (1 - m.deal.discountPercent / 100) : null;
    }
  } else if (m.tiers && m.tiers[0] && m.tiers[0].listRates && typeof m.tiers[0].listRates === "object") {
    listPriceUsdPerMTok = {
      input: m.tiers[0].listRates.input ?? null,
      output: m.tiers[0].listRates.output ?? null,
      cacheRead: m.tiers[0].listRates.cacheRead ?? null,
      cacheWrite: m.tiers[0].listRates.cacheWrite ?? null,
    };
  }
  // tiers: 上下文分段 (band)
  const tiers = Array.isArray(m.tiers) && m.tiers.length > 1
    ? m.tiers.map((t) => ({
        label: t.label || "Standard",
        context: t.context || null,
        priceUsdPerMTok: {
          input: t.rates?.input ?? null,
          output: t.rates?.output ?? null,
          cacheRead: t.rates?.cacheRead ?? null,
          cacheWrite: t.rates?.cacheWrite ?? null,
        },
      }))
    : null;
  // offPeak
  let offPeak = null;
  if (hasToD) {
    offPeak = {
      schedule: `${m.timeOfDay.offPeakHoursPerDay}h/day`,
      peakUsdPerMTok: {
        input: m.timeOfDay.peak?.input ?? null,
        output: m.timeOfDay.peak?.output ?? null,
        cacheRead: m.timeOfDay.peak?.cacheRead ?? null,
      },
      windows: m.timeOfDay.windows || null,
    };
  }
  // deal
  let deal = null;
  if (m.deal && typeof m.deal === "object") {
    deal = {
      label: m.deal.label || null,
      discountPercent: m.deal.discountPercent ?? null,
      note: m.deal.note || null,
    };
  }
  return {
    name: m.name,
    slug: m.slug,
    vendor: m.vendor || null,
    id: m.id || null,
    contextTokens: m.contextWindow ?? null,
    intelligence: m.intelligenceIndex ?? null,
    codingIndex: m.codingIndex ?? null,
    tokPerS: m.outputTokensPerSec ?? null,
    reasoning: m.reasoning ?? null,
    vision: m.vision ?? null,
    priceUsdPerMTok,
    listPriceUsdPerMTok,
    tiers,
    discountPct: deal && deal.label === "Free" ? null : deal ? deal.discountPercent : null,
    isFree: (m.inputCost === 0 && m.outputCost === 0 && m.cacheReadCost === 0) || (deal && deal.label === "Free"),
    offPeak,
    deal,
    monthlyCredits: null, // 由表格补充
    quotas: null, // 由表格补充
    caps: null,
    releaseDate: m.releaseDate || null,
  };
}

// ---------------------------------------------------------------- 主流程 --

async function fetchPrices() {
  const res = await fetch(PAGE_URL, { headers: { "user-agent": "Mozilla/5.0 (goat-prices script)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();

  // 主数据源: RSC 模型目录
  const rscModels = extractRscModels(html);
  if (!rscModels.length) throw new Error("RSC payload 中未解析到模型 (页面结构可能已变化)");
  const models = rscModels.map(normalizeRscModel);

  // 补充: 表格 credits/quotas
  for (const { header, rows } of parseTables(html)) {
    if (!header.length) continue;
    const sig = header.map((h) => h.toLowerCase()).join("|");
    if (!/requests \/ 5 hours|monthly credits/.test(sig)) continue;
    for (const row of rows) mergeTableExtras(models, header, row);
  }

  return {
    schema: SCHEMA,
    fetchedAt: new Date().toISOString(),
    source: PAGE_URL,
    plan: PLAN,
    models,
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

/** 按显示名或 slug 查模型 (显示名先归一化再精确匹配) */
function findModel(prices, nameOrSlug) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9.]+/g, "");
  const n = norm(nameOrSlug);
  return prices.index.get(n) || prices.data.models.find((m) => norm(m.name) === n) || null;
}

/**
 * 计算一次调用的费用 (USD, 按页面牌价; credits 与 USD 1:1)
 * 长上下文请求若模型有 tiers (band), 按请求上下文长度选择档位;
 * 否则用平铺单价。
 * @param model findModel 的结果
 * @param usage { input, output, cacheRead, cacheWrite, contextTokens? }
 * @returns { totalUsd, breakdown } | null (模型未收录/无牌价时对应项按 0 计并置 rated=false)
 */
function calcCost(model, usage = {}) {
  if (!model) return null;
  const ctx = usage.contextTokens ?? null;
  const rateKey = (k) => {
    if (ctx != null && model.tiers && model.tiers.length > 1) {
      // 选档: 取 context 阈值能包住 ctx 的最后一档; context 形如 "≤ 272K" / "> 272K"
      const usable = model.tiers.filter((t) => {
        const c = t.context || "";
        const m = /([<>≤≥])\s*([\d.]+)\s*([KM])?/.exec(c);
        if (!m) return false;
        const bound = parseFloat(m[2]) * (m[3] === "M" ? 1e6 : m[3] === "K" ? 1e3 : 1);
        return m[1] === "<" ? ctx < bound : m[1] === "≤" ? ctx <= bound : m[1] === ">" ? ctx > bound : ctx >= bound;
      });
      return usable.length ? usable[usable.length - 1].priceUsdPerMTok[k] : null;
    }
    return model.priceUsdPerMTok[k];
  };
  const breakdown = {};
  let totalUsd = 0;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    const tokens = usage[key] || 0;
    const rate = rateKey(key);
    const usd = rate != null ? (tokens / 1e6) * rate : 0;
    breakdown[key] = { tokens, rateUsdPerMTok: rate, usd, rated: rate != null };
    totalUsd += usd;
  }
  return { totalUsd, breakdown };
}

// ---------------------------------------------------------------- CLI --

function printSummary(data) {
  console.log(`GOAT 计划: $${data.plan.monthlyUsd}/月 = ${data.plan.credits} credits (x${data.plan.multiplier})`);
  const banded = data.models.filter((m) => m.tiers && m.tiers.length > 1).length;
  const offPeak = data.models.filter((m) => m.offPeak).length;
  console.log(`模型 ${data.models.length} 个 (band ${banded} 个, off-peak ${offPeak} 个), 抓取于 ${data.fetchedAt}\n`);
  const rows = data.models.map((m) => [
    m.name,
    m.priceUsdPerMTok.input ?? "-",
    m.priceUsdPerMTok.output ?? "-",
    m.priceUsdPerMTok.cacheRead ?? "-",
    m.monthlyCredits ?? "-",
    m.tiers ? m.tiers.length + "档" : "",
  ]);
  const header = ["Model", "In$/M", "Out$/M", "CacheR$/M", "Credits", "Band"];
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
    const [name, input, output, cacheRead, cacheWrite, ctx] = args.slice(costIdx + 1);
    const file = args.includes("--out") ? args[args.indexOf("--out") + 1] : "goat-prices.json";
    const prices = loadPrices(file);
    const model = findModel(prices, name);
    const cost = calcCost(model, {
      input: +input, output: +output, cacheRead: +cacheRead || 0, cacheWrite: +cacheWrite || 0, contextTokens: +ctx || null,
    });
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
  module.exports = { SCHEMA, fetchPrices, loadPrices, findModel, calcCost };
}
