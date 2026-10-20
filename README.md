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
are skipped and logged. Codex/pi/opencode rows use other wire formats and are not bridged.

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

## Status file

`~/.dsh/dsh-cc-switch-bridge.status.json` — written after each successful sync: which routes and models
the host process actually holds. First place to look when a provider is missing from the picker.

## After editing this plugin

The profile installs it as a link, but the running host keeps the old module loaded: toggle the
plugin off and on in Settings → Plugins (or restart the app).

## Checks

`node tests/smoke.mjs` — SSE decoding, error mapping, tool-call repair, max_tokens clamping, model
labels, and a read of the real cc-switch database.

## Limits

- Anthropic-compatible endpoints only; other cc-switch apps' wire formats are not converted.
- No image blocks are sent; images in history become a text placeholder.
- The bridge never writes to cc-switch, so the "current provider" in cc-switch and the model chosen
  in Harness are independent.
