# cmc-proxy — commandcode GOAT 订阅本地反代网关

![version](https://img.shields.io/badge/version-v1.3.0-blue)
![stars](https://img.shields.io/github/stars/cwf818/cmc-proxy)
![issues](https://img.shields.io/github/issues/cwf818/cmc-proxy)

把 commandcode 的 Provider API 反代到本机 `127.0.0.1:5411`，让本地 **Claude Code** 和 **Codex** 直接接入你的 GOAT 订阅。大部分其他 Agent （Pi，zcode等）本身可以直连，无需此代理。当然加一层可以更智能些，比如图片请求可以**自动路由**,或上游失败时**自动切换**，还可以看到一些token用量、缓存命中的统计——我喜欢看 tps，快慢自知容易心里踏实。

- **极简**单文件 `proxy.js`，零第三方依赖，无需安装 npm 包，仅需 Node.js ≥ 18（内置 `fetch`/`ReadableStream`），`node proxy.js` 即可启动（都知道要反代了，想必`node` 早就配备了）。
- **代码安全**，不含任何后门或远程调用，所有请求仅在本机转发到 commandcode 上游；基本上是 AI 代写，使用前可以让 AI 再审查一遍。本身 AI 写一个不难，难的是如何避坑以及设计实用功能，github 找了一圈没找到合适的，所以自己让 AI 帮忙写了一个。遇到的坑包括：CC改历史、变换版本后缀、Codex只支持Responses、鬼知道什么时候配置了记忆生成导致token额外消耗等。反正这里暂时解决了。
- 同时提供 **OpenAI 兼容**（`/v1/chat/completions`）、**Anthropic 兼容**（`/v1/messages`，供 Claude Code）与 **Responses 兼容**（`/v1/responses`，供 Codex）三类端点；看上去 `opencode-go` 套餐也可以拿来改一下 `EndPoint`(`upstream` 和 `apikey`) 直接用，可能需要适应性修改，目前停了 ocgo 套餐，不去折腾了。
- **协议转换**：GOAT 订阅不含任何 Claude 模型，Claude Code 请求自动 `Anthropic → OpenAI` 转换；Codex 的 Responses 请求自动 `Responses → Chat Completions` 转换（上游只有 chat/completions）；流式 + 工具调用全链路支持
- **统一模型决策** `pickModel`：`modelMap` 显式映射 → 上游模型目录解析（`resolveModel`）→ 按请求类型回退默认（文本 `defaultModels[0]` / 带图 `defaultVisionModels[0]`）
- **失败轮换** `switchOnFail`（支持布尔或 `{text, image}`）：失败 1 次即切换 + `failTTL` 冷却（**只对回退到默认的模型生效**，用户显式指定模型失败不冷却、下次仍从它开始）；文本请求按 `defaultModels`、带图请求按 `defaultVisionModels` 轮换（带图请求 400 也轮换，图片不支持的报错就是 400）
- **多模态**：`tool_result` 内嵌图片抽出注入同轮 user 消息透传；`cleanHistoryImages` 可在本轮无新图时清理历史图片，让请求安全回流纯文本模型；REQ 行 `img=N(新M)` 标记 + 会话标签 `@` 前缀
- **前缀缓存优化**：注入提醒剥离、易变计数器取整、`cache_control` 透传、会话缓存亲和——同会话 Claude Code / Codex 的上游前缀缓存可稳定在 95%+；RES 行内置前缀分叉探测（`pfx~` 标记）可定位缓存失效来源
- **Codex 新协议全兼容**：`custom`（apply_patch freeform）/ `tool_search`（延迟工具发现）/ `namespace` 工具组 / 顶层 `function_call` 历史等新形态全链路支持
- **会话级访问日志**：按 `x-claude-code-session-id` / `session-id` / `thread-id` 稳定归因，两行日志（REQ/RES）配对 + 缓存命中率 / 生成速度 / 前缀分叉 / 累计用量统计
- 支持流式 SSE 透传、token 用量上报、模型列表过滤、分级请求落盘（环境变量 `CMC_LOGGING_FILE`）

## 文件说明

```
cmc-proxy/
├── proxy.js        # 主程序（反代 + 协议转换，单文件）
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

   命令行参数：`node proxy.js [--port 5411] [--host 127.0.0.1] [--config config.json]`
   （`--config` 支持绝对路径，或相对 proxy.js 所在目录的相对路径）

4. 验证：`curl http://127.0.0.1:5411/health` 应返回 `{"ok":true,...}`。

启动后打印 banner 与配置摘要，可据此确认生效的模型与开关：

```
==========================================================
  cmc-proxy 已启动
  监听地址   : http://127.0.0.1:5411
  上游端点   : https://api.commandcode.ai/provider
  默认模型   : deepseek/deepseek-v4-flash(默认) → deepseek/deepseek-v4-flash-vision-exp → …
  视觉模型   : xiaomi/mimo-v2.5(默认) → z-ai/glm-5.3-flash → Qwen/Qwen3.8-27B
  失败轮换   : 对象 {text:true, image:true} (失败1次即切换 + 30s 冷却)
  历史图清理 : 开启 (无新图请求时剥离历史图, 回流请求指定模型)
  tool结果图 : 保留 (注入 user 消息透传)
----------------------------------------------------------
  Claude Code 接入:  export ANTHROPIC_BASE_URL=http://localhost:5411
  Codex 接入:        base_url = http://localhost:5411/v1  (wire_api = responses)
==========================================================
[17:00:12.334] 刷新上游模型列表成功: 62 条 (17:00:12.334)
```

## Claude Code 接入

Claude Code 走 Anthropic 协议。设置环境变量后启动 `claude`：

```bash
# Windows (PowerShell)
$env:ANTHROPIC_BASE_URL="http://localhost:5411"
$env:ANTHROPIC_AUTH_TOKEN="sk-local-any-value"
# 不设置 ANTHROPIC_MODEL 时使用默认模型（defaultModels[0]）
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

| 模型 ID                                            | 视觉                    | 说明                                            |
| -------------------------------------------------- | ----------------------- | ----------------------------------------------- |
| `deepseek/deepseek-v4-flash`                       | ❌ 纯文本（带图必 400） | **默认模型**，DeepSeek V4 Flash，速度快性价比高 |
| `deepseek/deepseek-v4-flash-vision-exp`            | ✅                      | DeepSeek V4 Flash Vision（实验版，支持视觉）    |
| `deepseek/deepseek-v4-pro`                         | 未实测                  | DeepSeek V4 Pro                                 |
| `z-ai/glm-5.3-flash`                               | ✅                      | 智谱 GLM-5.3 Flash                              |
| `Qwen/Qwen3.8-27B`                                 | ✅                      | 阿里 Qwen 3.8 27B                               |
| `xiaomi/mimo-v2.5`                                 | ✅                      | 小米 MiMo V2.5                                  |
| `gpt-5.6-sol`                                      | 未实测                  | GPT 编码/智能体能力强，Codex 系                 |
| `moonshotai/Kimi-K2.7-Code` / `moonshotai/Kimi-K3` | 未实测                  | Kimi 编码系                                     |
| `zai-org/GLM-5.3` / `zai-org/GLM-5.2`              | 未实测                  | 智谱 GLM                                        |
| `Qwen/Qwen3.8-Max` / `Qwen/Qwen3.7-Flash`          | 未实测                  | 阿里 Qwen                                       |
| `MiniMaxAI/MiniMax-M3`                             | 未实测                  | MiniMax                                         |
| `xai/grok-4.6`                                     | 未实测                  | Grok                                            |
| `xiaomi/mimo-v2.5-pro`                             | 未实测                  | 小米，限时高折扣                                |
| `tencent/hy3-paid`                                 | 未实测                  | 腾讯                                            |

- 完整列表：`curl http://127.0.0.1:5411/v1/models`（已过滤 `blockedModels`，`?raw=1` 看全量）。上游模型目录 60s 缓存，启动时会预热并打印 `刷新上游模型列表成功: N 条`。
- 换模型：文本请求改 `config.json` 的 `defaultModels`（数组，第一个为文本默认模型），带图请求改 `defaultVisionModels`；或在 `modelMap` 里把特定模型名映射到目标模型后重启。
- GOAT 按订阅额度计费，模型实际可用性以上游返回为准。
- 图片 token 成本实测：`deepseek-v4-flash-vision-exp` 一张 1920×1080 ≈ 370 prompt tokens（非分辨率线性）。

### 模型决策（pickModel）

所有转发路径共用同一个决策函数，顺序固定：

```
请求带 model?
├─ 没带 → 按请求类型取默认: 文本 defaultModels[0], 带图 defaultVisionModels[0]
└─ 带了 → modelMap 显式映射 (命中即用, 不区分请求类型, 优先级最高, 置空即关闭)
   └─ 未命中 → config.resolveModel (默认 true)
      ├─ true  → resolveModel(): 上游模型目录匹配, 命中即用; 未命中按请求类型回退默认
      └─ false → 原样向上游请求 (不解析不回退)
```

> 带图判定（`isImage`）按路径不同：
>
> | 路径                   | `isImage` 判定                                                                                                              |
> | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
> | `/v1/messages`         | 原始请求体含图片块（`countImagesDeep(body) > 0`）；开启 `cleanHistoryImages` 且本轮无新图时，历史图剥离后**重新判定为文本** |
> | `/v1/chat/completions` | 请求体含图片块（`image_url` / `input_image` / Anthropic `image` 块）                                                        |
> | `/v1/responses`        | 转换后的 chat messages 含 `image_url` part                                                                                  |
>
> `/v1/messages` 会决策两次：先按原始请求体判断是否需要直连上游 `/messages`（Claude 模型），再在历史图片清理之后按最终请求类型重新决策转换路径用的模型。

`defaultVisionModels` 为空时，带图请求回退到 `defaultModels[0]`。

### 失败轮换（switchOnFail）

`config.json` 的 `switchOnFail` 是轮换**总闸**，支持三种写法：

```json
{ "switchOnFail": true }                              // 文本/带图统一开启
{ "switchOnFail": false }                             // 关闭（默认）：失败原样返回
{ "switchOnFail": { "text": true, "image": true } }    // 分别控制
```

开启后的精确语义（`proxy.js` 的 `upstreamFetchRotate`）：

1. **轮换列表按请求类型**：文本请求 → `defaultModels`，带图请求 → `defaultVisionModels`。去重后候选只剩 1 个时（典型情况：该类型列表只有 1 个模型，且首个候选就是它）不轮换；banner 在两个列表都不足 2 个时会显示"不适用 (列表仅一个模型, 不轮换)"。
2. **候选序列**：`pickModel` 决策出的模型（尊重客户端显式意图，含 `blockedModels` 中的模型）作为**首个候选**，随后按类型列表顺序补全并去重。每次尝试都会重写请求体里的 `model` 字段——上游实际收到的模型跟着变。
3. **失败 1 次即切换**：不再区分"首个模型/后续模型"，失败立刻换下一个候选。
4. **TTL 冷却（只对回退到默认的模型生效）**：失败模型进入冷却（`config.failTTL`，默认 30000ms），冷却期内**跨请求**也跳过该模型并打印 `模型 X 冷却中, 跳过`；成功即清除冷却。`failTTL: 0` 关闭冷却。**用户显式指定的模型（经 `modelMap` / 目录解析命中，未落到回退点）不冷却**——不去猜测用户指定模型的能力（如纯文本模型收到带图请求），失败即轮换，下次请求仍从它开始；只有**未带 model 或指定模型解析失败、回退到 `defaultForType` 的模型**（`defaultModels[0]` / `defaultVisionModels[0]`）失败才进入冷却。默认列表里的后续候选（轮换到的 index ≥ 1）无论何种情况都照常冷却。
5. **哪些失败才轮换**：`403 / 404 / 408 / 429 / 500 / 502 / 503 / 504` 与网络层错误（含首字节超时）。`400 / 401 / 413 / 422` 等（请求体非法、key 无效、body 超限）换任何模型结果都一样，不轮换、直接透传，避免一个失败放大成 N 个——**唯一例外：带图请求的 400 也轮换**（图片不支持的报错就是 400）。注意**任何**非 2xx 都会记入冷却表（用户显式指定模型除外），不轮换的那几类也会让该模型冷却一个 TTL。
6. **成功即停**：任一候选返回 2xx 即用该响应继续原有流程（流式转换/透传），并把 RES 行的 `model=` 更新为实际生效的模型。
7. **全部试完**：把**最后一次**尝试的上游响应（状态码 + body）或错误透传给客户端，客户端看到的是真实收尾结果；轮换过程打印 `上游 <status> (<model>), 轮换 → <next> (i/N)`。
8. **全部在冷却期**：不再发起请求，直接把冷却错误交给调用方（502 收尾）。
9. **客户端断开立即终止**：不再重试，也不计失败。
10. **边界**：轮换只覆盖**响应头阶段**的失败（拿到响应头之后、向客户端写任何字节之前，重试是安全的）；**中途断流不可重试**（字节已发出）。重试期间全程持有该会话串行锁，同会话后续请求会排队。
11. **没有活动模型指针**：默认模型恒为 `defaultModels[0]` / `defaultVisionModels[0]`，一次成功的轮换**不会**改变后续请求的默认模型；跨请求规避已死模型只靠 TTL 冷却。

**代价须知**：最坏耗时 ≈ 候选数 × 各自的首字节超时（`firstByteTimeout`，默认 120s），5 个模型的配置最坏可拖数分钟。通常配较小的 `firstByteTimeout`（如 15~30s）使用。

> 钉死单模型的语义请只保留 `defaultModels` 中的一个模型。旧配置中的 `defaultModel` 字段仍兼容（视为单元素列表），`imageCapableModels` 自动迁移为 `defaultVisionModels`。
> `switchOnFail: false` 时单次请求不轮换，但回退到默认的模型失败仍会记入冷却表（`onRequestFail`），成功清除；用户显式指定的模型不记入。

### 模型匹配规则

客户端请求的模型名按以下顺序解析（`proxy.js` 的 `pickModel` / `resolveModel`）：

1. **显式映射表** `modelMap`：`claude-*`、`gpt-5.x-codex` 等已内置映射，命中即用、不区分请求类型。
2. **上游模型目录匹配**（`resolveModel`，需 `config.resolveModel !== false`），按序尝试：
   1. 精确匹配；
   2. 大小写不敏感匹配；
   3. **去 provider 前缀按裸名匹配**（`deepseek-v4-flash` → `deepseek/deepseek-v4-flash`、`qwen3.8-max` → `Qwen/Qwen3.8-Max`）；
   4. **去 `[*]` 后缀匹配**（`deepseek-v4-flash[1m]` → `deepseek/deepseek-v4-flash`，视为同模型的不同上下文窗口变体）。
3. **无任何匹配** → 按请求类型回退默认（文本 `defaultModels[0]` / 带图 `defaultVisionModels[0]`）。

因此本地客户端（尤其 Claude Code）可以直接用**不带前缀**的模型名，例如 `/model` 输入 `deepseek-v4-flash`、`kimi-k2.7-code` 等，都会被自动映射。

### 多模态（图片）支持

上游**不支持在 `tool` 消息里带图**（实测 400，vision 模型同样拒绝），也不支持纯文本模型处理图片。cmc-proxy 的处理：

| 开关（config.json）  | 默认    | 作用                                                                                                                                                                                                                                                                         |
| -------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolResultImages`   | `true`  | `tool_result` 内嵌的图片块抽出，注入**同轮末尾的 user 消息**：先插一条文本 part `[tool_result <id> 附带的图片]`，再接 `image_url` part。`false` 时丢弃（折叠为 `[image]` 占位符）                                                                                            |
| `cleanHistoryImages` | `false` | 仅 `/v1/messages` 转换链路：本轮（最后一条 user 消息）**无新图**时，把该消息之前所有图片块（含 `tool_result` 内嵌）**原位替换**为占位文本 `[历史图片已清理]`。历史里的图上游同样 400，剥离后请求可安全回流纯文本模型，带图路由随之只看新图——会话不再被历史图片钉死在视觉模型 |

- 替换是**确定性**的：同一段历史每轮剥出逐字节一致的结果，不破坏前缀缓存（代价是历史图片内容对模型不可见）。
- 纯文本路径（无图请求）逐字节保持旧行为，`toolResultImages=false` 时文本也完全不变。
- 日志侧：REQ 行显示 `img=N(新M)`——`N` 为请求体中的图片块总数，`新M` 为最后一条 user 消息（本轮）中的新图数；本轮有新图时会话标签加 `@` 前缀（`@S3#3`）。
- **已知限制**：文本链路的历史图占位符是 `[历史图片已清理]`，而 `tool_result` 折叠用的占位符是 `[image]`。带图轮次的图在下一轮变成占位文本时，tool 消息内容与上一轮不同（`[image]` → `[历史图片已清理]`）、其后的 user 消息里注入的真图也消失，RES 行会触发一次 `pfx~N` 分叉（缓存断一次）。统一两处占位符只能让 tool 消息跨轮字节一致（分叉点后移一条消息），**消除不了这次缓存断**——真图从上下文消失是剥离历史图的固有代价。

## 配置项速查

| 键                         | 默认                                  | 说明                                                                                                                              |
| -------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `port`                     | `5411`                                | 监听端口（可用 `--port` 覆盖）                                                                                                    |
| `host`                     | `127.0.0.1`                           | 监听地址（可用 `--host` 覆盖）                                                                                                    |
| `upstream`                 | `https://api.commandcode.ai/provider` | 上游地址（尾部 `/` 自动去除）                                                                                                     |
| `apiKey`                   | —                                     | **必填**。GOAT API Key；环境变量 `CMDC_API_KEY` 优先                                                                              |
| `switchOnFail`             | `false`                               | 轮换总闸：`true` / `false` / `{text, image}`（单布尔统一取值）                                                                    |
| `failTTL`                  | `30000`                               | 失败模型冷却毫秒数，`0` = 不冷却                                                                                                  |
| `defaultModels`            | `["deepseek/deepseek-v4-flash"]`      | 文本请求轮换列表，第一个为文本默认模型（旧 `defaultModel` 视为单元素）                                                            |
| `defaultVisionModels`      | `[]`                                  | 带图请求轮换列表，第一个为视觉默认模型（旧 `imageCapableModels` 自动迁移）；为空时带图请求回退 `defaultModels[0]`                 |
| `modelMap`                 | `{}`                                  | 显式模型映射（key = 客户端请求名，value = 上游模型名），优先级最高，置空即关闭                                                    |
| `resolveModel`             | `true`                                | `modelMap` 未命中时是否做目录解析 + 回退默认；`false` = 原样向上游请求                                                            |
| `modelCatalog`             | 未配置（无默认）                      | 模型参数数据文件路径（相对 `proxy.js` 目录），仅显式配置时加载；存在且解析成功时用于计算单次请求的额度，文件缺失/解析失败静默跳过 |
| `blockedModels`            | `[]`                                  | 从 `/v1/models` 列表隐藏（避免客户端误选）；**转发时不拦截**，命中只打印一次性告警                                                |
| `cleanHistoryImages`       | `false`                               | 本轮无新图时把历史图片块替换为 `[历史图片已清理]`（见「多模态」）                                                                 |
| `toolResultImages`         | `true`                                | `tool_result` 内嵌图片保留并注入后续 user 消息；`false` 折叠为 `[image]`                                                          |
| `serializeSessionRequests` | `true`                                | 同会话上游请求串行化                                                                                                              |
| `firstByteTimeout`         | `120000`                              | 上游响应头超时 ms，`0` 关闭                                                                                                       |
| `stripSystemReminders`     | `true`                                | 剥离 `messages` 里注入的 `system` 提醒                                                                                            |
| `stabilizeCounters`        | `true`                                | `<total_tokens>` 计数就近取整到百万                                                                                               |
| `cacheControlPassthrough`  | `true`                                | Anthropic `cache_control` → OpenAI content part                                                                                   |
| `cacheAffinity`            | `true`                                | 按会话注入 `user` / `prompt_cache_key`                                                                                            |

> 配置模板见 `config.example.json`（键序与 `config.json` 对齐，参数前带 `_xxx说明` 注释键）。

## 环境变量

| 变量                | 默认   | 作用                                                                                                                          |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `CMDC_API_KEY`      | 未设置 | 优先于 `config.json` 的 `apiKey`                                                                                              |
| `CMC_LOGGING_FILE`  | `0`    | 请求落盘分级（写入 `fulllog.log`，见「缓存优化」表）：`0`/未设置 关闭；`1` 严重事件；`2` 1 + 前缀分叉请求；`3` 全部模型类请求 |
| `CMC_STATS_EVERY`   | `10`   | 每 N 个请求打印一次 TOD/ALL 累计统计                                                                                          |
| `CMC_DEBUG`         | 未设置 | 设为 `1`：把上游原始流逐 chunk 打到 stderr（`[DBG-UP-messages]` / `[DBG-UP-responses]`，每条截 300 字符）                     |
| `CMC_DEBUG_PAYLOAD` | 未设置 | 设为 `1`：打印本地请求的完整 headers、`bodyKeys` 与 body 原文（超 8000B 截断）                                                |
| `NO_COLOR`          | 未设置 | 设置后日志无色（输出非 TTY 时也自动无色）                                                                                     |

## 缓存优化（前缀缓存友好转换）

DeepSeek 等上游的前缀缓存要求**同会话请求的消息前缀逐字节一致**。反代在转换层做了以下保障，默认全部开启：

| 开关（config.json）            | 默认     | 作用                                                                                                                                                                                                                                                               |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stripSystemReminders`         | `true`   | 整条剥离 Claude Code 2.1.251+ 注入到 `messages` 里的 `role:"system"` 提醒（`<total_tokens>` 配额计数、任务工具催促）——数值随轮次回溯改写，是前缀缓存失效的元凶。仅提示性内容，不影响编码能力，CC 下一轮会重新注入；顶层 `system`（系统提示词 + CLAUDE.md）原样保留 |
| `stabilizeCounters`            | `true`   | 文本中 `<total_tokens>N tokens left</total_tokens>` 计数就近取整到 100 万（`14977212` → `15000000`），使回溯改写前后字节一致；作为剥离的兜底（防计数出现在其他位置）                                                                                               |
| `cacheControlPassthrough`      | `true`   | Anthropic `cache_control` 标记透传为 OpenAI content part（对支持显式缓存的后端生效，已验证不影响本上游的缓存键）                                                                                                                                                   |
| `cacheAffinity`                | `true`   | 按会话注入稳定 `user` / `prompt_cache_key`（Claude Code 取会话 UUID，Codex 透传其自带值），便于上游按会话做缓存路由                                                                                                                                                |
| `CMC_LOGGING_FILE`（环境变量） | 未设置   | 请求落盘分级：`0`/未设置 关闭；`1` 严重事件（上游失败/超时、客户端中途断开）；`2` 1 + 前缀分叉时落盘该请求（client/upstream 双 body）；`3` 全部模型类请求。写入 `fulllog.log`，分叉/失败条目带标注；日志会持续增长，注意清理                                       |
| `serializeSessionRequests`     | `true`   | 同会话上游请求**串行发送**：CC 的会话标题探测请求（4KB，自动起名）与主请求毫秒级并发到达时，中转侧出现过主请求长时间无响应头悬挂；串行化规避并发，排队中的请求若客户端断开会立即出队                                                                               |
| `firstByteTimeout`             | `120000` | 上游超过该毫秒数未返回响应头时主动中止并返回 502（`0` 关闭）。替代 undici 隐性的 300s 黑盒超时，悬挂请求 2 分钟内可见明确错误                                                                                                                                      |

配套的**前缀分叉探测**：RES 行在检测到与该会话上一次请求相比前缀发生变化时输出红色标记——`pfx~N`（第 N 条消息变化，索引含 system）、`pfx~tools`（工具定义变化）、`pfx~params`（顶层参数变化，附字段名）、`pfx<N`（历史变短，压缩）；纯追加（健康）不输出。同时打印分叉内容预览（旧/新 JSON 各起一行，便于对齐比较；总预算 140 字符——分叉点在 120 字符内则头部截断，分叉点在 120 之外则头 59 字符 + `…` + 自分叉点前 10 字符起的 80 字符定位子串（前 10 + 后 70，三段合计恰为 140）；分叉起点至行尾以橙色高亮，其余红色），可直接看出客户端改写了什么。分叉基线按 `tools` 哈希分桶（最多 4 桶），主请求与并发小探测请求互不污染。前缀纯追加时同会话缓存应稳定在 95%+；若出现 `pfx~` 标记即该位置之后本轮必然后缀缓存失效。

## 原理

```
Claude Code ──Anthropic /v1/messages───────▶ cmc-proxy:5411
Codex ──────Responses /v1/responses───────▶  │
OpenAI 客户端 ──chat /v1/chat/completions──▶ │  模型决策 + 协议转换 + Key 注入 + 失败轮换
                                              ▼
                              https://api.commandcode.ai/provider/v1/*
```

| 端点                        | 方法 | 行为                                                                                                                                                                                                                                 |
| --------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/`、`/health`              | GET  | 健康检查，返回 `{ok, service, upstream, port}`                                                                                                                                                                                       |
| `/v1/models`                | GET  | 上游模型列表（按 `blockedModels` 过滤，`?raw=1` 看全量），60s 缓存                                                                                                                                                                   |
| `/v1/messages/count_tokens` | POST | 本地估算 `input_tokens`（`ceil(JSON长度/4)`，最小为 1），不转发上游                                                                                                                                                                  |
| `/v1/messages`              | POST | 模型判定为 **Claude 系**（`claude-*`）→ 原样透传上游 `/messages`（预留 Pro/Provider 直连真实 Claude）；否则 → **Anthropic → OpenAI 转换**后发上游 `/chat/completions`，响应转回 Anthropic（含 `tool_use` / `input_json_delta` 事件） |
| `/v1/chat/completions`      | POST | 原样透传上游 `/chat/completions`，仅做模型决策与 Key 注入                                                                                                                                                                            |
| `/v1/responses`             | POST | **Responses → Chat Completions** 转换后发上游，响应转回 Responses SSE 事件（`response.created` → `output_text.delta` / `function_call_arguments.delta` → `response.completed`），含工具调用                                          |
| 其他 `/v1/*`                | 任意 | 通配原样透传（注入 Key，`redirect: follow`）。**不参与模型决策、轮换与会话串行化**                                                                                                                                                   |
| 其他路径                    | 任意 | 404 `{error:{message:"Not found: …", type:"invalid_request_error"}}`                                                                                                                                                                 |

各阶段数据格式与样例见 [`schemas.md`](schemas.md)。

## 访问日志

每个请求打印**两行日志**：`REQ` 行记录本地客户端发来的请求，`RES` 行记录外部上游返回的结果，便于对照感知请求与返回。时间后跟 **`S会话#请求` 标签**（如 `S1#10` = 1 号会话的第 10 个请求），按稳定会话标识区分本地 agent 进程并自增分配；REQ 与 RES 两行标签相同即同一请求的请求与响应。**标签按请求轮换取色**，同一请求两行同色以便配对，相邻请求颜色轮转更易区分；`REQ` 字样恒为青色：

```
[20:15:55.877] S3#1 REQ POST /v1/messages model=deepseek-v4-flash src=127.0.0.1:54321 ua=claude-cli/2.0.0 stream=1 body=186.5KB
[20:15:58.232] S3#1 200 POST /v1/messages model=deepseek/deepseek-v4-flash took=2.35s out=1736B in:1234 out:567 rt:480 cr:890 cw:0 ch:87% credit=0.013500 ts:241.3/s
[20:15:58.822]@S3#2 REQ POST /v1/messages model=mimo-v2.5 src=127.0.0.1:54321 ua=claude-cli/2.0.0 stream=1 img=2(新1) body=321.4KB
[20:16:00.510]@S3#2 200 POST /v1/messages took=1.69s out=567B qwait:1.2s in:987 out:45 cr:0 cw:0 ch:40% !credit=0.031250 gap:10 ts:26.6/s
[20:16:30.000] S5#7 REQ* POST /v1/chat/completions model=gpt-5.6-sol src=127.0.0.1:48721 ua=codex/1.0.0 stream=0 body=88B
[20:17:30.000] S5#7 502 POST /v1/chat/completions took=60.01s out=112B pfx~3
```

字段说明：

| 字段                         | 含义                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REQ` / `RES`                | 本地请求到达 / 外部返回完成。`REQ*`（红色 `*`）表示该请求到达时同会话已有在途请求，正在串行队列中等待发送上游                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `S会话#请求`                 | 标签 = **会话编号 + 请求编号**（如 `S1#10`）。会话编号**优先按 `x-claude-code-session-id`**（Claude Code 每个会话唯一的 UUID）→ **`session-id`**（Codex 0.147+ 每请求携带，兼容旧版 `session_id` 下划线头名）→ **`thread-id`**（Codex 对话线程，`codex resume` 后不变）→ 回退 `src:端口 + ua` 近似区分，同一会话跨 TCP 重连不换号；请求编号为会话内自增的请求计数器，两行编号相同即同一请求的请求行与响应行，用于在并发/交错日志中配对 REQ 与 RES。仅 model 类请求（`/v1/messages`、`/v1/chat/completions`、`/v1/responses`）计入会话，非 model 请求（健康检查等）无标签。**本轮带新图时标签前加 `@`**（如 `@S3#2`，紧贴时间戳不空格） |
| `status` / `method` / `path` | HTTP 状态码、方法与路径（`RES` 行含状态码）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src`                        | 客户端 IP:源端口（仅 `REQ` 行；端口用于区分同 ua 的不同进程/连接）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ua`                         | 客户端 User-Agent（`claude-cli/*` 即 Claude Code，`codex/*` 即 Codex）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `model`                      | 仅 `REQ` 行显示**本地请求的模型名**（如 `deepseek-v4-flash`）；`RES` 行只在**实际转发的模型名与本地名不同**时显示转发名（如 `deepseek/deepseek-v4-flash`），字符串相同时省略 —— 两行对照即知映射关系；轮换发生时显示最终生效的模型。**按模型名字符串哈希着色**：同模型恒同色、不同模型尽量异色，扫日志时可按颜色快速归类模型                                                                                                                                                                                                                                                                                                           |
| `stream`                     | 是否为流式请求（1 流式 / 0 非流式，仅 `REQ` 行）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `img`                        | 请求体中检测到的图片块数（Anthropic `image` 块 + OpenAI `image_url` / `input_image` part），仅 `REQ` 行。`/v1/messages` 链路额外显示 `新M` —— 最后一条 user 消息（本轮）中的新图数，如 `img=2(新1)`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `body`                       | 请求体大小（仅 `REQ` 行；用于区分两条请求是否完全相同：工具循环的请求体会递增，客户端重试的请求体一致）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `took`                       | 上游耗时：从**真正发往上游**起算到响应完成（排队等待不计入，与 provider 侧 API 耗时对齐，仅 `RES` 行）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `qwait:`                     | 排队等待时长：同会话串行化时在本请求之前等待的时间，超过 0.5s 才显示；`took + qwait ≈ 总耗时`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `out`                        | 响应输出字节数（仅 `RES` 行，含 `res.end()` 直写的 body）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `in:` / `out:`               | 输入 / 输出 tokens。**`in:` 为净输入**（已扣除缓存命中部分，即按原价计费的量；流式与非流式、转换与透传路径均解析；上游未返回时不显示）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `rt:`                        | 思考 tokens（`reasoning_tokens`，DeepSeek 系常见，已包含在 `out:` 中，仅上游返回时出现）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `cr:` / `cw:`                | 缓存读取（`cached_tokens`） / 缓存写入（`cache_creation_input_tokens`） tokens，命中缓存可大幅省钱。`in:` + `cr:` = 总输入                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `credit:` / `!credit:`       | **单次请求额度消耗**（黄色；高峰窗口内为红色 `!credit:`），**位于 `ch:` 之后**：成本按模型目录 `priceUsdPerMTok` 牌价计算（USD），额度 = 成本 × `plan.credits` ÷ 模型 `monthlyCredits`。`!` 前缀表示当前 UTC 时刻处于该模型 `offPeak.windows` 高峰窗口（已按 `peakUsdPerMTok` 覆盖 input/output 牌价）。6 位小数；仅当配置 `modelCatalog` 且模型已收录、本次解析到 usage 时输出                                                                                                                                                                                                                                                        |
| `gap:`                       | **低缓存间隔**：仅当本次缓存命中率 `cr ÷ (in + cr)` < 50% 时输出，值为本次与**该会话最近一次**低缓存命中请求的**请求序号差**（会话内序号只对有 usage 的请求递增）。会话内**首次**低缓存只记录基准、不输出 `gap`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pfx~`                       | **前缀分叉标记**（红色，详见「缓存优化」章节）：`pfx~N` 该会话上一次请求的第 N 条消息与本次不同（索引含 system，`pfx~1` 即首条 user 消息）、`pfx~tools` 工具定义变化、`pfx~params` 顶层参数变化（附字段名）、`pfx<N` 历史变短（压缩）。分叉处之后本轮必然无法命中前缀缓存；纯追加（健康）不输出，同时会单独打印多行分叉内容预览（分叉段橙色高亮）                                                                                                                                                                                                                                                                                      |
| `ch:` / `ts:`                | 会话累计缓存命中率与滚动生成速度（见「用量统计」），仅在本次解析到 usage 时追加                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ABT`                        | 客户端中途断开时单独打印的告警行：`[cmc-proxy]S3#1 ABT POST /v1/messages 客户端断开 (已等待 12.3s, 未收到完整响应)`。断开会联动中止上游请求，同时按 `CMC_LOGGING_FILE>=1` 落盘                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

> 流式请求上游默认不返回 usage，需请求体带 `stream_options: {"include_usage": true}` —— Claude Code / Codex 转换路径已自动带上；直接调用 `/v1/chat/completions` 的客户端需自行加该参数才能在日志中看到用量。

### 用量统计

**1. 滚动统计（每次请求输出）**

每次请求解析到 usage（即 `RES` 行输出了 `in:/out:/rt:/cr:/cw:`）时，在行末追加 `ch`（**会话累计**缓存命中率）+ `ts`（最近 1 / 10 / 50 次请求的滚动速度）。无 usage 的请求（如健康检查、未返回用量的透传）不追加：

```
[20:16:30.000] S3#1 200 POST /v1/messages took=2.35s out=1736B in:1234 out:567 rt:480 cr:890 cw:0 ch:87% ts:33/s,40/s,50/s
```

- `ch:` 为**会话累计**命中率（该会话所有有 usage 请求的 `cr ÷ (in + cr)`，最多带 1 位小数，如 `ch:98.7%`），单值输出——同会话正常工作时应稳定在 95%+；若长期偏低，结合 `pfx~` 标记定位前缀分叉来源
- `ts:` 值个数随历史请求数变化：**1 次显示 1 值 → 2–10 次显示 2 值 → ≥11 次显示 3 值**（第 1 个 = 最近 1 次，第 2 个 = 最近 10 次，第 3 个 = 最近 50 次，仅计入有 usage 的请求）
- `gap:` 出现在 `ch` 之前：仅当**本次**缓存命中率 < 50% 时输出，值为与同会话最近一次低缓存命中请求的序号差（首次低缓存只记录基准、不输出）

| 字段  | 含义                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gap` | 两次 `cachehit < 50%` 请求的**序号差**（会话内、仅计有 usage 的请求），如 `gap:10` 表示距上一次低缓存命中间隔了 10 次有效请求。红色高亮，便于快速定位低缓存频率 |
| `ch`  | 会话累计缓存命中率 = `cr ÷ (in + cr)`，**波段色**：<60 红 / 60–79 橙 / 80–89 黄 / 90–94 绿 / ≥95 亮绿                                                           |
| `ts`  | 生成速度（(输出+思考) tokens/s，滚动窗口），**波段色**：<20 红 / 20–39 橙 / 40–59 黄 / 60–79 绿 / ≥80 亮绿                                                      |

> 波段色按逗号分段：逗号跟随其后的数值一起着色（如 `ts:33/s`、`,40/s`、`,50/s` 各自独立着色）。

**2. TOD / ALL 累计（每 10 个请求打印）**

```
[20:16:30.000] STATS TOD req:25 in:56.3K out:12.4K rt:9.1K cr:98.7K cw:0 ch:63% credit:8.420000 cost:$7.2200 avg:0.336800 ts:210.1/s
[20:16:30.000] STATS ALL req:25 in:56.3K out:12.4K rt:9.1K cr:98.7K cw:0 ch:63% credit:8.420000 cost:$7.2200 avg:0.336800 ts:210.1/s
```

| 行    | 范围                 | 说明                                |
| ----- | -------------------- | ----------------------------------- |
| `TOD` | 当天累计（按自然日） | 跨天自动先打印上日汇总              |
| `ALL` | 进程启动以来累计     | **当天启动时与 TOD 一致，自动省略** |

- `in:`/`out:`/`rt:`/`cr:`/`cw:` 含义与 RES 行相同；数字超 1K/1M 自动缩写
- `credit:` 累计额度消耗（黄色，6 位小数），`cost:` 累计成本（USD），`avg:` 单次请求平均额度 = `credit ÷ req`（6 位小数）；均位于 `ch:` 之后
- 额度计算口径：成本 = 按模型目录 `priceUsdPerMTok` 牌价直接算；额度 = 成本 × `plan.credits` ÷ 模型 `monthlyCredits`。未配置 `modelCatalog` / 模型未收录 / `monthlyCredits` 缺失时不累计（无该字段）
- 打印频率可用环境变量 `CMC_STATS_EVERY` 调整（默认 10）
- 统计为内存态，进程重启后清零

## 常见问题

**端口被占用**

```powershell
Get-NetTCPConnection -LocalPort 5411 -State Listen | Stop-Process
```

或改 `config.json` 的 `port`。

**请求报 `MODEL_NOT_IN_PLAN`** — 该模型 GOAT 订阅不可用（`403`）。此错误会进入轮换（开启 `switchOnFail` 时当场换下一个模型）并让该模型冷却 `failTTL`；也可以手动调整 `defaultModels` / `defaultVisionModels` 或把该模型从 `blockedModels` 里排除。

**带图请求被 400（`This model does not support image`）** — 说明当前模型是纯文本模型（如 `deepseek-v4-flash`）。配置 `defaultVisionModels` 并开启 `switchOnFail.image`，带图请求会按视觉列表轮换（带图的 400 也会轮换）。历史图片会把会话一直钉在视觉模型上——先剥后送可用 `cleanHistoryImages: true`。

**想用真正的 Claude 模型** — 需要升级 Pro/Provider 计划；升级后在 `modelMap` 中把 `claude-*` 映射为真实 Claude 模型名（如 `claude-sonnet-4-6`）即可直连上游 `/messages`（`isClaudeModel()` 判定）。

**一条回复被拆成两截（同一消息出现两个圆点）** — Claude Code 里 assistant 回复显示为「头 1-3 个字符 + 剩余全文」两段、各带一个圆点，拼起来正好是完整句子。原因是 `StreamConverter` 文本块路径用 `!textBlock` 判断「文本块是否已建」，而首个内容 chunk 建立的文本块索引是 `0`（合法值）——`!0` 为真导致第 2 个内容 chunk 误建第二个文本块，把一条消息拆成两个 text content block（工具块路径用的是 `=== undefined`，无此问题）。判断块是否已建必须用 `== null`（配合 `null` 哨兵）而非 `!x`。此 bug 已随新核心修复；若仍复现，确认运行的是修复后的 `proxy.js` / `release/proxy.js` 并已重启进程。

**流式输出卡住** — 检查网络到 `api.commandcode.ai` 的连通性；可设 `CMC_DEBUG=1` 启动查看上游原始流（`[DBG-UP-*]`），或调小 `firstByteTimeout` 让悬挂请求更快失败。

**缓存命中率低** — 看 `RES` 行的 `pfx~` 标记与分叉预览：`pfx~1`/`pfx~2` 等早期消息分叉说明客户端在改写历史（升级 Claude Code 版本后常见）；`pfx~tools` 工具定义变化；无标记但 `cr` 仍低则多为上游/中转侧行为。可设 `CMC_LOGGING_FILE=2` 落盘分叉请求对照排查（`3` 为全部请求）；相关开关见「缓存优化」章节。

## 安全提醒

`config.json` 中的 `apiKey` 是你的订阅凭据，**不要提交到公开仓库**。建议：

```gitignore
config.json
proxy.log
fulllog.log
```

服务默认只监听 `127.0.0.1`，如需局域网共享请改 `config.json` 的 `host` 为 `0.0.0.0` 并自行加鉴权。
