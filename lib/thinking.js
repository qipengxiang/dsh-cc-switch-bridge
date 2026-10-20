/**
 * Thinking levels: which ones a model offers, and what each one sends.
 *
 * The levels are not invented here — cc-switch already declares them per model, and the bridge
 * mirrors that declaration so the Harness menu matches what cc-switch shows: `none` there is
 * `off` here, everything else keeps its name.
 *
 * The wire only understands a budget, so a level is spelled as `budget_tokens`. A few upstreams
 * cannot carry it at all, see `replaysWithoutThinking`.
 */

/** Selectable levels in escalation order, with the thinking budget each one asks for. */
const LEVELS = Object.freeze({
  off: 0,
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16_384,
  xhigh: 24_576,
  max: 32_000,
})

// Anthropic wants `max_tokens` above the budget, so a thinking request reserves headroom.
const THINKING_HEADROOM = 2048
const MIN_BUDGET = 1024

/** cc-switch and the Harness spell the disabled level differently. */
export function normalizeLevel(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
  if (text === '' || text === 'none' || text === 'off' || text === 'disabled' || text === 'false') return 'off'
  return Object.hasOwn(LEVELS, text) ? text : undefined
}

/** Declared level names -> the ordered, known subset. */
export function levelIds(names) {
  const out = []
  for (const name of names ?? []) {
    const id = normalizeLevel(name)
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** The `reasoning.efforts` a model descriptor carries; names match the Harness convention. */
export function reasoningEfforts(ids) {
  return ids.map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }))
}

/**
 * @param {string|undefined} effort
 * @param {number|undefined} maxTokensCap the model's own output cap, when the bridge knows it
 * @returns {{ thinking?: object, maxTokensFloor?: number }}
 */
export function thinkingRequest(effort, maxTokensCap) {
  const level = normalizeLevel(effort)
  if (level === undefined) return {}
  if (level === 'off') return { thinking: { type: 'disabled' } }
  let budget = LEVELS[level]
  if (typeof maxTokensCap === 'number' && maxTokensCap > 0 && budget >= maxTokensCap) {
    budget = Math.max(MIN_BUDGET, Math.floor(maxTokensCap / 2))
  }
  return { thinking: { type: 'enabled', budget_tokens: budget }, maxTokensFloor: budget + THINKING_HEADROOM }
}

/**
 * Whether the upstream tolerates a replayed turn whose thinking blocks are missing. The Harness
 * never hands those blocks back, so an upstream that demands them breaks every tool loop:
 * DeepSeek answers `400 content[].thinking must be passed back`, CC-Vibe wants adaptive thinking
 * instead of a budget, and SSSAI only accepts the Claude Code client. Those keep no effort menu.
 */
export function replaysWithoutThinking(baseURL) {
  let host
  try {
    host = new URL(baseURL).hostname
  } catch {
    return false
  }
  return !['deepseek.com', 'cc-vibe.com', 'sssaiapi.com', 'beeapi.dev'].some(
    (blocked) => host === blocked || host.endsWith(`.${blocked}`),
  )
}
