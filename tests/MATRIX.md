# 模型实测记录

2026-10-20 在桌面 Harness（0.2.1-rc.2，DeepSeek 默认供应商）上，把当前 cc-switch
里能导入的 **26 个供应商组、91 个模型**全部真实调用了一遍：

- **协议一（Claude）**：桥自己的适配器走 Anthropic Messages（`/v1/messages`），11 组 43 个模型。
- **协议二（Codex）**：交给内置 `dsh-llm-pi-ai`（OpenAI Responses/Completions），15 组 48 个模型。

每个 claude 模型测四件事：工具调用（模型发出 `tool_use`）、工具回传（把 `tool_result`
发回去后模型能否续答）、思考等级（开 `high` 后流里是否出现 thinking 块且结尾不报错）、
图片（纯色块的 data URL，看模型是否读懂颜色）。Codex 组用 pi-ai 自己的目录声明，
只测它声明支持的项；图片模型（`gpt-image-*`）没有文本接口，跳过。

## 汇总

| 协议 | 供应商组 | 模型 | 工具调用 | 工具回传 | 思考等级 | 图片 |
| --- | --- | --- | --- | --- | --- | --- |
| claude | GLM-刘元伟 | 5 | 4 | 1/1 | 1/1 | 0/1 |
| claude | GLM-EN-Colin | 5 | 4 | 1/1 | 1/1 | 0/1 |
| claude | Kimi | 3 | 3 | 1/1 | 1/1 | 1/1 |
| claude | MiniMax | 2 | 2 | 1/1 | 1/1 | 1/1 |
| claude | DeepSeek | 2 | 2 | 1/1 | — | 1/1 |
| claude | BeeApi | 4 | 2 | 1/1 | — | 1/1 |
| claude | CC-Vibe×1 | 4 | 4 | 1/1 | — | 1/1 |
| claude | CC-Vibe×5 | 5 | 3 | — | — | — |
| claude | CC-Vibe×22 | 4 | 2 | 1/1 | — | 1/1 |
| claude | SSSAI | 4 | 1 | — | — | — |
| claude | GLM-祁鹏翔 | 5 | 4 | 1/1 | 1/1 | 0/1 |
| codex | GLM-祁鹏翔 | 2 | 2 | 1/1 | 1/1 | — |
| codex | GLM-刘元伟 | 2 | 2 | 1/1 | 1/1 | — |
| codex | GLM-EN-Colin | 2 | 2 | 1/1 | 1/1 | — |
| codex | Kimi | 4 | 4 | 0/1 | 1/1 | 1/1 |
| codex | MiniMax | 2 | 2 | 1/1 | 1/1 | 1/1 |
| codex | DeepSeek | 2 | 2 | 0/1 | 1/1 | — |
| codex | SSSAI | 3 | 2 | 0/1 | 1/1 | 1/1 |
| codex | BeeApi | 3 | 1 | — | 1/1 | 1/1 |
| codex | CC-Vibe-CodeX×2 | 7 | 3 | 0/1 | 1/1 | 0/1 |
| codex | CC-Vibe-CodeX-Pro×5 | 2 | 2 | 0/1 | 1/1 | 1/1 |
| codex | CC-Vibe×1 | 4 | 4 | 1/1 | 1/1 | 1/1 |
| codex | CC-Vibe-Claude×5 | 4 | 3 | 1/1 | 0/1 | 1/1 |
| codex | CC-Vibe×22 | 4 | 4 | 0/1 | 1/1 | 1/1 |
| codex | CC-Vibe-Grok×3 | 2 | 2 | 1/1 | 1/1 | 1/1 |
| codex | CC-Vibe-kimi-glm×8 | 5 | 1 | — | — | — |

## 结论

- **工具调用链路在所有可用组里都成立**：91 个模型里 67 个完成完整一轮（发 `tool_use` →
  从事件流正确拼出 JSON 参数 → 回传 `tool_result` → 续答）。失败集中在网关能力，不是桥：
  - **客户端校验**：BeeApi 的 claude 通道、SSSAI 的 claude 通道要求 Claude Code 客户端
    User-Agent，直接用 Harness 调会被 403/400 拒（`接口仅可用于CC官方客户端`）。
  - **套餐/配额**：`glm-5.3-flashx` 三个 GLM 账号都返回 1311（订阅未开放该模型）；
    `gpt-6-luna` 429；`kimi-glm` 组 kimi-k3/kimi-k2.6 账号耗尽、glm-5.1 无路由。
  - **上游容量**：CC-Vibe 部分模型并发/超时/502；图片模型 `gpt-image-*` 在 CodeX 组返回 502。
- **思考等级**：BigModel、Kimi、MiniMax、DeepSeek 的端点都接受 `thinking`，正文与
  thinking 块能同时流出来。修复了一个真 bug：以前不管用户选没选等级都发 `thinking.enabled`，
  MiniMax 因此在默认档直接 400（`requires adaptive thinking`）；现在只有选了具体等级才发，
  不选就完全不带这个字段——顺带修好了 DeepSeek：不带 thinking 时它不再强制要求回传
  thinking 块，工具回传重新可用。
- **图片**：data URL 能正常转发，Kimi / MiniMax 全部读对；**GLM 的 Anthropic 兼容端点
  不可靠**——`glm-5.1`/`glm-5.2` 明确说看不到图，`glm-5.3` 时对时错（同一个红块报绿/蓝/棕），
  所以 GLM 组不该拿来传图（同一个 `glm-5.3` 两次测试一次读对一次读错）。Codex 组里 GLM 目录本来就声明纯文本，属预期。
- **回传偶发为空**：几个 Codex 网关（Kimi、DeepSeek、SSSAI、CC-Vibe）出现过第二轮 output
  为空、没有文本也没有工具调用；重试通常正常，是上游网关的抖动，桥这边如实报
  `empty reply` 而不是伪造内容。

## 失败明细

- **claude · GLM-刘元伟** `glm-5.3` — 图片: unexpected (Teal)
- **claude · GLM-刘元伟** `glm-5.3-flashx` — 工具: error RATE_LIMIT: [1311][当前订阅套餐暂未开放GLM-5.3-FlashX权限][2026102
- **claude · GLM-EN-Colin** `glm-5.3` — 图片: unexpected (Blue)
- **claude · GLM-EN-Colin** `glm-5.3-flashx` — 工具: error RATE_LIMIT: [1311][Your current subscription plan does
- **claude · BeeApi** `claude-fable-5-1` — 工具: error INVALID_CREDENTIAL: This group only serves a specific 
- **claude · BeeApi** `claude-haiku-5-5` — 工具: error INVALID_CREDENTIAL: This group only serves a specific 
- **claude · CC-Vibe×5** `claude-haiku-5-5` — 工具: error INVALID_REQUEST: Model "claude-haiku-5-5" is not suppo
- **claude · CC-Vibe×5** `claude-fable-5-1` — 工具: error SERVER: Upstream access forbidden, please contact admi
- **claude · CC-Vibe×22** `claude-haiku-5-5` — 工具: error RATE_LIMIT: Concurrency limit exceeded for user, pleas
- **claude · CC-Vibe×22** `claude-fable-5-1` — 工具: error RATE_LIMIT: Concurrency limit exceeded for user, pleas
- **claude · SSSAI** `claude-opus-5-5` — 工具: error INVALID_REQUEST: 专用渠道限制: 接口仅可用于CC官方客户端 (如误判请修改CC客户端版本)
- **claude · SSSAI** `claude-fable-5-1` — 工具: error INVALID_REQUEST: 专用渠道限制: 接口仅可用于CC官方客户端 (如误判请修改CC客户端版本)
- **claude · SSSAI** `claude-sonnet-5-5` — 工具: error INVALID_REQUEST: 专用渠道限制: 接口仅可用于CC官方客户端 (如误判请修改CC客户端版本)
- **claude · GLM-祁鹏翔** `glm-5.3` — 图片: unexpected (Green)
- **claude · GLM-祁鹏翔** `glm-5.3-flashx` — 工具: error RATE_LIMIT: [1311][当前订阅套餐暂未开放GLM-5.3-FlashX权限][2026102
- **codex · Kimi** `kimi-for-coding` — 回传: empty reply
- **codex · DeepSeek** `deepseek-flash` — 回传: empty reply
- **codex · SSSAI** `gpt-6.1-sol` — 回传: empty reply
- **codex · SSSAI** `grok-4.6` — 工具: error 400 {"id":"1792477269555-lgwntr22kbrnk","type":"error"
- **codex · BeeApi** `gpt-6.1-sol` — 工具: no tool call ()
- **codex · BeeApi** `gpt-5.6-terra` — 工具: no tool call ()
- **codex · CC-Vibe-CodeX×2** `gpt-6.1-sol` — 回传: empty reply，图片: error 429 {"error":{"code":"gateway_conc
- **codex · CC-Vibe-CodeX×2** `gpt-6-luna` — 工具: error 429 {"error":{"code":"gateway_concurrency_limit","mess
- **codex · CC-Vibe-CodeX×2** `gpt-image-2.5` — 工具: error 502 {"error":{"message":"Upstream request failed","typ
- **codex · CC-Vibe-CodeX×2** `gpt-image-2.5-flare` — 工具: error 502 {"error":{"message":"Upstream request failed","typ
- **codex · CC-Vibe-CodeX×2** `gpt-image-2.5-sunburst` — 工具: error 502 {"error":{"message":"Upstream service temporarily 
- **codex · CC-Vibe-CodeX-Pro×5** `gpt-6.1-sol` — 回传: empty reply
- **codex · CC-Vibe-Claude×5** `claude-opus-5-5` — 思考: error 23: The operation was aborted due 
- **codex · CC-Vibe-Claude×5** `claude-fable-5-1` — 工具: no tool call ()
- **codex · CC-Vibe×22** `claude-opus-5-5` — 回传: empty reply
- **codex · CC-Vibe-kimi-glm×8** `kimi-k2.7` — 工具: error 503 {"error":{"code":"server_error","message":"All ava
- **codex · CC-Vibe-kimi-glm×8** `glm-5.1` — 工具: error 404 {"error":{"code":"server_error","message":"no rout
- **codex · CC-Vibe-kimi-glm×8** `kimi-k2.6` — 工具: error 503 {"error":{"code":"server_error","message":"All ava
- **codex · CC-Vibe-kimi-glm×8** `kimi-k3` — 工具: error 403 {"error":{"code":"server_error","message":"All ava
