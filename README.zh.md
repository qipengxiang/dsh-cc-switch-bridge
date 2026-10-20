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
codex 行改由内置 pi-ai 适配器导入（见“设置页面”）；其他工具分组各有各的存储格式，见
“为什么有些分组没接”。

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

## 设置页面

设置 → **cc-switch-bridge** 会列出你 cc-switch 里实际配置过的工具分组（Claude Code、Claude Code Desktop、
Codex 等），勾选哪几个就导入哪几个。改选择后立即重新同步，不用重启，模型选择器随之变化。

| 分组 | 导入方式 |
| --- | --- |
| Claude Code / Claude Code Desktop / 任何 Anthropic 格式分组 | 走 bridge 自己的适配器，一个供应商一条路由 |
| Codex | 交给内置的 `dsh-llm-pi-ai` 适配器：每条 cc-switch Codex 行一个供应商，`api` 取自该行的 `wire_api`（`openai-responses` / `openai-completions`），base URL 和模型目录直接来自该行 |
| pi / openclaw / opencode | 存储的是各家自己的配置结构，桥还没写对应的解析器，暂列为不可导入 |
| gemini | 本机这一行是空配置，没有内容可导入 |

Codex 这条路线不需要手工配置：开启时把一条 `codex` 条目写进桌面 profile patch 里的 `dsh-llm-pi-ai`
插件配置（`settingsNs: codex`），并把每行的 key 存到凭据库的 `CCSWITCH_CODEX_<行名>`；关闭时既移除路由，
也删除 bridge 写进去的这些密钥。

页面本身是本包提供的浏览器半部（`client.js`），通过 `/dsh-cc-switch/state` 与宿主通信
（GET 取快照，POST `{apps, order}` 提交选择与顺序）。页面下半部分会列出实际生效的
「已桥接」与「已交给 pi-ai」两份清单，方便核对导入结果。

### 为什么有些分组没接

这不是“模型不行”，也不是协议不支持——是 cc-switch 给每个工具存了不同的配置结构，桥目前只写了
`claude` / `claude-desktop`（`env.ANTHROPIC_*`）和 `codex`（TOML）两种解析器：

| 分组 | cc-switch 里实际存的 | 状态 |
| --- | --- | --- |
| `pi` | `baseUrl` / `api` / `models[]` / `thinkingLevelMap`，就是 pi-ai 自己的 provider 结构 | 字段几乎一一对应，尚未实现 |
| `openclaw` | `baseUrl` / `api` / `models[]`，同样是 pi-ai 风格 | 尚未实现 |
| `opencode` | AI SDK 的 `{npm, options, models}`（`@ai-sdk/openai-compatible` / `@ai-sdk/anthropic`） | 需要一张 `npm → api` 映射，尚未实现 |
| `gemini` | `{"env":{},"config":{}}`（本机这条是空的） | 没有可导入的配置，接不了 |

前三种接上以后同样走 pi-ai 那条路，不需要改 Harness 本身。

## 排序

「已桥接」和「已交给 pi-ai」里的行可以直接拖动排序，保存下来的顺序（状态文件里的 `order`）
就是路由的注册顺序，也就是模型选择器里的分组顺序。DeepSeek 的 account/official 两组由选择器
自己固定在最前，不受这里影响。

## 状态文件

`~/.dsh/dsh-cc-switch-bridge.status.json` —— 每次同步成功后写入：宿主进程实际持有的路由与模型。
选择器里看不到某个供应商时，先看这里。

## 改完这个插件之后

profile 是以链接方式安装它的，但运行中的宿主仍持有旧模块：到「设置 → 插件」里把插件关掉再
打开（或重启应用）。

## 自检

`node tests/smoke.mjs` —— SSE 解码、错误映射、工具调用修复、`max_tokens` 截断、模型标签、
排序，以及一次对真实 cc-switch 数据库的读取。
`node tests/client-render.mjs` —— 用桩 React 把设置页渲染一遍，专抓「hook 顺序错导致页面空白」
这类问题。

## 测试记录

`tests/MATRIX.md` —— 当前能导入的 26 个供应商组、91 个模型全部实测过一遍：工具调用、工具回传、
思考等级、图片。简单说：除客户端校验/配额/上游容量问题外，工具调用全线可用；GLM 的 Anthropic
端点读图不可靠；错误一律按原样报出。

## 限制

- 桥自己的适配器只处理 Anthropic 兼容端点；Codex 分组通过 pi-ai 配置交给内置适配器。
  pi / openclaw / opencode 的存储格式尚未解析，gemini 那行本身没有配置。
- 部分中转按 User-Agent 白名单限制客户端（`client_not_allowed`、`仅可用于CC官方客户端`）。
  桥不伪造客户端身份；如果 cc-switch 条目里带了 `ANTHROPIC_CUSTOM_HEADERS`（每行 `Name: value`，
  与 Claude Code 的写法一致），这些头会原样带上。
- data URL 形式的图片原样转发；其他形式的附件引用会变成一段占位文字。
- 插件从不写回 cc-switch，因此 cc-switch 里的「当前供应商」和 Harness 里选择的模型相互独立。
