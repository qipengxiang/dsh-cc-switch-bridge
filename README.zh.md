# cc-switch bridge

[English](README.md)

已安装插件 `dsh-cc-switch-bridge`：把本机 [cc-switch](https://github.com/farion1231/cc-switch)
中保存的每个 Anthropic 兼容供应商，变成 DeepSeek Harness 里的一个 provider 路由，于是它们的模型
会出现在模型选择器里，像内置模型一样直接切换。

## 读取什么

`~/.cc-switch/cc-switch.db`（只读），`providers` 表中 `app_type` 为 `claude` / `claude-desktop`
的行。每一行取：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`，
模型 id 来自 `meta.stackModels` 与 `ANTHROPIC_*MODEL` 环境变量键（`model[1M]` 这类标签会保留 id
并给出上下文窗口），行名作为分组标题。每 60 秒以及每次打开模型选择器都会重新读取，因此在
cc-switch 里的改动无需重启 Harness 即可生效。

`meta.apiFormat` 不是 `anthropic` 的行，以及缺少 base URL / 凭据 / 模型的行会被跳过并记日志。
codex / pi / opencode 行用的是别的协议，不做桥接。

## 注册什么

每个供应商注册一条 `ctx.llm.registerAdapter()` 路由（`ccswitch-<cc-switch id 前 8 位>`），
说 Anthropic Messages 协议（`/v1/messages`，SSE 或普通 JSON），并把回包翻译成 Harness 的流式
分片：正文、推理/思考、工具调用、用量、结束原因。发送前会修复工具调用与结果的配对，因为一个
没有结果的工具调用会让上游拒绝整个会话。

## 思考等级

等级不是插件自己定的梯子：cc-switch 已经逐模型声明了等级，Harness 的菜单照搬这份声明，两边
给出的选项因此一致。

- `codex` 行带 `modelCatalog.models[].reasoningLevels`（以及 `defaultReasoningLevel`），
  这正是 cc-switch 为 Codex 供应商显示的等级。
- `pi` 行带 `thinkingLevelMap`，其中值为 `null` 表示不提供该等级。
- 同名供应商的行优先；同一模型 id 在其他供应商下的声明，只用来补齐前者没说的部分。

cc-switch 的 `none` 在这里是 `off`。声明了默认等级的，Harness 的默认值也跟着一样，所以 Kimi
起手就是 `high`，MiniMax 起手是 `off`，与 cc-switch 完全一致。没有任何声明的模型（例如
`glm-5.3-flashx`）不会出现菜单，这也与 cc-switch 一致。

线路上只认预算，所以每个等级发 `thinking: {type: 'enabled', budget_tokens}`（`off` 发
`{type: 'disabled'}`）：minimal 1024、low 2048、medium 8192、high 16384、xhigh 24576、
max 32000 —— 当模型自身的输出上限更小时会自动减半。`max_tokens` 会抬到预算之上并丢弃
`temperature`，这两条都是 Anthropic 的硬性规则。

有四家上游无论 cc-switch 怎么声明都不给菜单：Harness 不会把思考块上的签名交还，重放的回合里
就没有这些块。

| 域名 | 原因 |
| --- | --- |
| `deepseek.com` | 400 `content[].thinking in the thinking mode must be passed back` |
| `cc-vibe.com` | 只接受 `thinking: {type: 'adaptive'}`，不是预算 |
| `sssaiapi.com` | 拒绝一切非 Claude Code 官方客户端 |
| `beeapi.dev` | 参数被接受，但不下发思考块，且 `off` 会 503 |

要拉黑或放行某个域名，只需改 `lib/thinking.js` 里的这一行；插件配置 `thinking: false`
可以整体关掉所有等级菜单。

## 状态文件

`~/.dsh/dsh-cc-switch-bridge.status.json` —— 每次同步成功后写入：宿主进程实际持有的路由与模型。
选择器里看不到某个供应商时，先看这里。

## 改完这个插件之后

profile 是以链接方式安装它的，但运行中的宿主仍持有旧模块：到「设置 → 插件」里把插件关掉再
打开（或重启应用）。

## 自检

`node tests/smoke.mjs` —— SSE 解码、错误映射、工具调用修复、`max_tokens` 截断、模型标签，
以及一次对真实 cc-switch 数据库的读取。

## 限制

- 只支持 Anthropic 兼容端点；cc-switch 里其他应用的协议不做转换。
- 不发送图片块；历史里的图片会变成一段占位文字。
- 插件从不写回 cc-switch，因此 cc-switch 里的「当前供应商」和 Harness 里选择的模型相互独立。
