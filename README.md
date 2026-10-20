# cc-switch bridge

[中文说明](README.zh.md)

Installed plugin `dsh-cc-switch-bridge`: every Anthropic-compatible provider saved in the local
[cc-switch](https://github.com/farion1231/cc-switch) app becomes one provider route in DeepSeek
Harness, so its models appear in the model picker and switch like built-in models.

## What it reads

`~/.cc-switch/cc-switch.db` (read-only), table `providers`, rows with `app_type` `claude` /
`claude-desktop`. From each row: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`,
the model ids from `meta.stackModels` and the `ANTHROPIC_*MODEL` env keys (`model[1M]` labels keep the
id and give the context window), plus the row name as the group title. Rows are re-read every 60s and
on every model-picker open, so edits made in cc-switch show up without restarting Harness.

Rows whose `meta.apiFormat` is anything but `anthropic`, or without a base URL / credential / model,
are skipped and logged. Codex rows are imported through the built-in pi-ai adapter instead (see
Settings page); the other tool groups store their own shapes, see "Why some groups are not imported".

## What it registers

One `ctx.llm.registerAdapter()` route per provider (`ccswitch-<first 8 chars of the cc-switch id>`),
speaking Anthropic Messages (`/v1/messages`, SSE or plain JSON) and translating the reply into
Harness stream chunks: text, reasoning/thinking, tool calls, usage, finish reasons. Tool
call/result pairing is repaired before sending, because one unanswered tool call makes the upstream
reject the whole session.

## Thinking levels

The levels are not the bridge's own ladder: cc-switch already declares them per model, and the
Harness menu mirrors that declaration, so both apps offer the same choices.

- `codex` rows carry `modelCatalog.models[].reasoningLevels` (+ `defaultReasoningLevel`), which is
  what cc-switch shows for a Codex provider.
- `pi` rows carry `thinkingLevelMap`, where a `null` value means the level is not offered.
- The row with the same provider name wins; the same model id under another provider only fills in
  what that row does not say.

`none` in cc-switch is `off` here. A declared default becomes the Harness default too, so Kimi starts
at `high` and MiniMax at `off` exactly as cc-switch has them. A model with no declaration (for
example `glm-5.3-flashx`) gets no menu, matching cc-switch.

The wire only understands a budget, so each level sends `thinking: {type: 'enabled', budget_tokens}`
(off sends `{type: 'disabled'}`): minimal 1024, low 2048, medium 8192, high 16384, xhigh 24576,
max 32000 — halved automatically when the model's own output cap is smaller. `max_tokens` is raised
above the budget and temperature is dropped, both Anthropic rules.

Four upstreams are excluded no matter what cc-switch declares, because the Harness never hands back
the signature that comes with a thinking block, so a replayed turn has none:

| host | why |
| --- | --- |
| `deepseek.com` | 400 `content[].thinking in the thinking mode must be passed back` |
| `cc-vibe.com` | wants `thinking: {type: 'adaptive'}`, not a budget |
| `sssaiapi.com` | rejects every non-Claude-Code client |
| `beeapi.dev` | accepts the parameter, streams no thinking blocks, and answers 503 for `off` |

Listing a host in that exclusion list is the one line to edit in `lib/thinking.js`, and the plugin
config `thinking: false` drops every effort menu.

## Settings page

Settings → **cc-switch-bridge** lists the tool groups your cc-switch actually has configured
(Claude Code, Claude Code Desktop, Codex, …) and imports the ones you tick. Changing the selection
re-syncs immediately — no restart — and the model picker follows.

| Group | How it is imported |
| --- | --- |
| Claude Code / Claude Code Desktop / any Anthropic-format group | the bridge's own adapter, one route per provider |
| Codex | handed to the built-in `dsh-llm-pi-ai` adapter: one provider per cc-switch Codex row, `api` taken from the row's `wire_api` (`openai-responses` / `openai-completions`), base URL and model catalog straight from the row |
| pi / openclaw / opencode | each stores its own app's config structure and the bridge has no parser for it yet, so they are listed as not importable |
| gemini | this machine's row is an empty config, so there is nothing to import |

The Codex handoff needs no manual setup: turning it on writes a `codex` entry into the `dsh-llm-pi-ai`
plugin config in the desktop profile patch (`settingsNs: codex`) and stores each row's key in the
credential store under `CCSWITCH_CODEX_<row>`. Turning it off again removes both the routes and the
secrets the bridge wrote.

The page itself is a browser half (`client.js`) served by this package and talks to the host over
`/dsh-cc-switch/state` (GET snapshot, POST `{apps, order}` for the selection and its order). The lower
half of the page lists what is actually live, as "bridged" and "handed to pi-ai".

### Why some groups are not imported

Not a model problem and not a protocol problem: cc-switch stores one config structure per tool, and the
bridge only parses two of them — `claude` / `claude-desktop` (`env.ANTHROPIC_*`) and `codex` (TOML).

| Group | What cc-switch actually stores | Status |
| --- | --- | --- |
| `pi` | `baseUrl` / `api` / `models[]` / `thinkingLevelMap` — pi-ai's own provider shape | fields map almost 1:1, not implemented yet |
| `openclaw` | `baseUrl` / `api` / `models[]`, also pi-ai-shaped | not implemented yet |
| `opencode` | AI SDK `{npm, options, models}` (`@ai-sdk/openai-compatible` / `@ai-sdk/anthropic`) | needs a small `npm → api` map, not implemented yet |
| `gemini` | `{"env":{},"config":{}}` (empty on this machine) | nothing to import |

The first three would ride the same pi-ai handoff once parsed; no Harness change needed.

## Status file

`~/.dsh/dsh-cc-switch-bridge.status.json` — written after each successful sync: which routes and models
the host process actually holds. First place to look when a provider is missing from the picker.

## Ordering

The bridged and pi-ai rows can be dragged to reorder them; the saved order (`order` in the state
file) is the order the routes are registered in, so it is what the model picker shows. The
DeepSeek account/official groups stay pinned first because the picker does that itself.

## After editing this plugin

The profile installs it as a link, but the running host keeps the old module loaded: toggle the
plugin off and on in Settings → Plugins (or restart the app).

## Checks

`node tests/smoke.mjs` — SSE decoding, error mapping, tool-call repair, max_tokens clamping, model
labels, ordering, and a read of the real cc-switch database.
`node tests/client-render.mjs` — renders the settings page against a stub React, which catches the
hook-order regression that blanks the page inside the app.

## Tested models

`tests/MATRIX.md` — every bridged claude and codex model (26 provider groups, 91 models) called
live: tool call, tool round trip, thinking level, image. The short version: tool calls work
everywhere except gateways that gate on the Claude Code client, GLM's Anthropic endpoint cannot be
trusted with images, and quota/capacity errors are reported verbatim.

## Limits

- The bridge's own adapter only converts Anthropic-compatible groups; Codex groups are handed to the
  built-in pi-ai adapter through its config. pi / openclaw / opencode shapes are not parsed yet, and
  the gemini row has no config at all.
- Some relays whitelist the calling client by User-Agent (`client_not_allowed`, `仅可用于CC官方客户端`).
  The bridge does not guess a client identity; if the cc-switch row carries
  `ANTHROPIC_CUSTOM_HEADERS` ("Name: value" lines, as Claude Code accepts it), those headers are
  forwarded as-is.
- Image blocks are forwarded when the harness hands over a data URL (`data:image/...`); any other
  attachment reference becomes a text placeholder.
- The bridge never writes to cc-switch, so the "current provider" in cc-switch and the model chosen
  in Harness are independent.
