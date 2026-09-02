# goat-prices.json Schema 参考 (cmc-proxy/goat-prices@2)

由独立工具 `goat-prices.js` 抓取并生成（与 proxy.js 无运行时耦合），
供主程序或任何脚本读取，计算 GOAT 计划下各模型的 API 调用费用。

- 数据来源：<https://commandcode.ai/docs/plans/goat>（Next.js SSR）
- **主数据源 = RSC payload**：页面内嵌的 `self.__next_f.push` JSON 串含完整模型目录，
  每模型有平铺价、`tiers`（上下文分段 band，含 cacheRead/cacheWrite）、
  `timeOfDay`（off-peak 峰值，含 cacheRead）、`deal`（折扣）等结构化字段。
  比解析 HTML 表格更全、更可靠（表格模型名旁的 info tooltip 是点击渲染，静态 HTML 不含）。
- **表格仅作补充**：`Monthly credits`（月度 credits）与限额表（Requests per 5h/week/month）。
- 重新生成：`node goat-prices.js`（覆盖写 `goat-prices.json`）
- **时效性**：页面价格随时可能调整，`fetchedAt` 超过若干周的文件应重新抓取；计费结果仅供观测，非账单依据
- 金额单位：**USD per Million tokens**（$/MTok）；credits 与 USD 按 1:1 消耗（$10/月 = 70 credits，7x 乘数已含在页面牌价换算里）

## 顶层结构

```jsonc
{
  "schema": "cmc-proxy/goat-prices@2",      // 格式版本, 变更时不兼容
  "fetchedAt": "2026-09-02T01:36:48.943Z", // 抓取时间 (ISO 8601)
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

| 字段                  | 类型                 | 说明                                                                 |
| --------------------- | -------------------- | -------------------------------------------------------------------- |
| `name`                | `string`             | 页面显示名                                                            |
| `slug`                | `string`             | 归一化匹配键（RSC 提供，稳定）                                        |
| `id`                  | `string\|null`       | 模型 API id（如 `gpt-5.6-luna` / `deepseek/deepseek-v4-pro`）         |
| `vendor`              | `string\|null`       | 厂商                                                                  |
| `contextTokens`       | `number\|null`       | 上下文窗口（token 数）                                                |
| `intelligence`        | `number\|null`       | 智能评分（`intelligenceIndex`）                                       |
| `codingIndex`         | `number\|null`       | 编码评分                                                              |
| `tokPerS`             | `number\|null`       | 生成速度（`outputTokensPerSec`）                                      |
| `reasoning` / `vision`| `boolean\|null`      | 能力标记                                                              |
| `priceUsdPerMTok`     | `object`             | **有效单价**：`{input, output, cacheRead, cacheWrite}`；off-peak 模型为错峰价；无牌价为 `null`；Free 模型为 `0` |
| `listPriceUsdPerMTok` | `object\|null`       | 划线原价（折扣模型有）                                                |
| `tiers`               | `object[]\|null`     | **上下文分段价格（band）**：`[{label, context, priceUsdPerMTok:{...}}]`；无分段为 `null` |
| `discountPct`         | `number\|null`       | 有限折扣（如 `50` = -50%）                                            |
| `isFree`              | `boolean`            | Free 模型                                                            |
| `offPeak`             | `object\|null`       | 错峰计价：`{schedule, peakUsdPerMTok:{input,output,cacheRead}, windows}`；`priceUsdPerMTok` 为错峰价 |
| `deal`                | `object\|null`       | 折扣详情：`{label, discountPercent, note}`                            |
| `monthlyCredits`      | `number\|null`       | 该模型月度 credits 上限（表格补充）                                   |
| `quotas`              | `object\|null`       | 限额：`{per5h, perWeek, perMonth}`（表格补充）                        |
| `releaseDate`         | `string\|null`       | 发布日期                                                              |

## 模型匹配规则

请求里的 model 名与记录的对应关系：

1. 优先 `slug` 精确匹配（RSC 的 slug 是稳定 id，如 `gpt-5-6-luna`）；
2. 其次按 `name` 归一化匹配（去符号转小写，如 `DeepSeek V4 Pro (latest)` → `deepseek-v4-pro-latest`）；
3. **接入主程序前建议与 `/v1/models` 实际返回比对**，必要时在消费侧维护别名表。

## 计费入口（goat-prices.js 导出）

```js
const { loadPrices, findModel, calcCost } = require("./goat-prices.js");
const prices = loadPrices("goat-prices.json");            // -> { data, index: Map<slug, ModelRecord> }
const model = findModel(prices, "GPT-5.6 Luna");          // 显示名或 slug; 未收录返回 null
// band 分段: 传 contextTokens 自动选档 (≤272K 用 Standard, >272K 用 Long context)
const cost = calcCost(model, {
  input: 1_000_000, output: 500_000, cacheRead: 8_000_000, contextTokens: 300_000,
});
// cost.totalUsd / cost.breakdown.{input,output,cacheRead,cacheWrite}
```

CLI 同能力：`node goat-prices.js --cost "GPT-5.6 Luna" 1e6 5e5 8e5 0 300000`
（参数：`<模型> <input> <output> [cacheRead] [cacheWrite] [contextTokens]`，token 数；传 contextTokens 走 band 选档）。

## 已知限制

| 限制                                  | 说明                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `minPlanName` 不等于价格              | RSC 里 `minPlanName` 只标识模型归属的基准计划（Go/Pro/Max/GOAT），价格本身与计划一致；GOAT 页按 GOAT 计划展示，价即当前牌价         |
| RSC 含全部计划模型                     | 62 个模型含未在 GOAT 表的 Claude 系列/GPT-5.6 Terra 等（其他计划）。GOAT 计划实际可用模型以页面表格为准（43 个）；RSC 多出的模型 credits/quotas 为 null |
| 脚注/上标                               | 表格 `+1`/`+2` 上标含义（如 off-peak 的档位说明）已由 RSC 的结构化字段覆盖（timeOfDay/tiers），不再记录原始脚注编号                 |
