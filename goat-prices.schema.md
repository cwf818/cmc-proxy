# goat-prices.json Schema 参考 (cmc-proxy/goat-prices@1)

由独立工具 `goat-prices.js` 抓取并生成（与 proxy.js 无运行时耦合），
供主程序或任何脚本读取，计算 GOAT 计划下各模型的 API 调用费用。

- 数据来源：<https://commandcode.ai/docs/plans/goat>（Next.js SSR，价格表内嵌 HTML，直接 fetch 解析，无需浏览器）
- 重新生成：`node goat-prices.js`（覆盖写 `goat-prices.json`）
- **时效性**：页面价格随时可能调整，`fetchedAt` 超过若干周的文件应重新抓取；计费结果仅供观测，非账单依据
- 金额单位：**USD per Million tokens**（$/MTok）；credits 与 USD 按 1:1 消耗（$10/月 = 70 credits，7x 乘数已含在页面牌价换算里）

## 顶层结构

```jsonc
{
  "schema": "cmc-proxy/goat-prices@1",     // 格式版本, 变更时不兼容
  "fetchedAt": "2026-09-01T12:49:50.923Z", // 抓取时间 (ISO 8601)
  "source": "https://commandcode.ai/docs/plans/goat",
  "plan": {                                 // 计划常量 (取自页面文案)
    "name": "GOAT",
    "monthlyUsd": 10,                       // 月费
    "credits": 70,                          // 月度 credits 总额
    "multiplier": 7                         // 充值倍数 ($10 -> $70)
  },
  "models": [ /* ModelRecord[], 见下 */ ]
}
```

## ModelRecord

| 字段                  | 类型              | 说明                                                                 |
| --------------------- | ----------------- | -------------------------------------------------------------------- |
| `name`                | `string`          | 页面显示名（已剥离脚注句 / `-50%` 折扣徽章 / `Free` 徽章）            |
| `slug`                | `string`          | 归一化匹配键：小写、去 `(latest)`/`(exp)`、非 `[a-z0-9.+]` 折为 `-` |
| `contextTokens`       | `number\|null`    | 上下文窗口（token 数，`1M`→`1000000`）                               |
| `intelligence`        | `number\|null`    | 页面智能评分（未评分 → `null`）                                      |
| `tokPerS`             | `number\|null`    | 页面标注生成速度（无 → `null`）                                      |
| `priceUsdPerMTok`     | `object`          | **有效单价**：`{input, output, cacheRead, cacheWrite}`，无牌价为 `null`；Free 模型为 `0` |
| `listPriceUsdPerMTok` | `object\|null`    | 划线原价（仅折扣模型有；与 `discountPct` 对应）                      |
| `discountPct`         | `number\|null`    | 有限折扣（如 `-50%` 徽章 → `50`）                                    |
| `isFree`              | `boolean`         | Free 模型（如 Laguna S 2.1，牌价全 0）                               |
| `offPeak`             | `object\|null`    | 错峰计价：`{schedule, peakUsdPerMTok:{input,output}, windows}`；`priceUsdPerMTok` 中存的是错峰价 |
| `monthlyCredits`      | `number\|null`    | 该模型月度 credits 上限（仅在单价表出现的模型有值）                  |
| `quotas`              | `object\|null`    | 限额：`{per5h, perWeek, perMonth}`（次/周期）                        |
| `footnotes`           | `number[]`        | 价格单元格上的脚注引用（`$0.66+1` → `[1]`）                          |
| `caps`                | `string\|null`    | 总表 Caps 列原文（如 `"+1"` 脚注引用）                               |

## 模型匹配规则

请求里的 model 名与记录的对应关系：

1. 优先 `slug` 精确匹配（把请求 model 名按 slug 同样规则归一化后比较，`toSlug()` 已导出）；
2. `slug` 是启发式生成（源自页面显示名），**不保证**与上游 API 的 model id 完全一致——接入主程序前应先与 `/v1/models` 实际返回比对，必要时在消费侧维护别名表。

## 计费入口（goat-prices.js 导出）

```js
const { loadPrices, findModel, calcCost } = require("./goat-prices.js");
const prices = loadPrices("goat-prices.json");            // -> { data, index: Map<slug, ModelRecord> }
const model = findModel(prices, "GLM-5.3 Flash");         // 显示名或 slug; 未收录返回 null
const cost = calcCost(model, {                            // usage 单位: token
  input: 1_000_000, output: 500_000, cacheRead: 8_000_000, cacheWrite: 0,
});
// cost.totalUsd  -> 0.424 (cacheWrite 无牌价按 0 计, breakdown 中 rated=false)
```

CLI 同能力：`node goat-prices.js --cost "GLM-5.3 Flash" 1e6 5e5 8e5`
（参数：`<模型> <input> <output> [cacheRead] [cacheWrite]`，token 数）。

## 生成端已知噪音（解析已处理）

| 页面现象                                          | 处理方式                                   |
| ------------------------------------------------- | ------------------------------------------ |
| 模型名拼接 off-peak 脚注句                        | 拆入 `offPeak` 字段，名字还原              |
| `-50%` / `Free` 徽章拼在名后                      | 拆入 `discountPct` / `isFree`              |
| 划线原价+折后价合并单元格（`$0.80$0.30`）         | 原价 → `listPriceUsdPerMTok`，折后 → 有效价 |
| 上标脚注引用（`$0.66+1`）                         | 记入 `footnotes`，数值取 `$` 后金额        |
| 总表表头带排序箭头（`Model↕`）                    | 列名归一化匹配                             |
