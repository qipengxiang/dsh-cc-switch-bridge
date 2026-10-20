/**
 * Codex rows -> provider entries for the Harness's built-in pi-ai adapter.
 *
 * The bridge itself only speaks Anthropic Messages, so a Codex provider is handed to the existing
 * `@deepseek-ai/dsh-llm-pi-ai` plugin instead: its Config gets one provider per cc-switch codex row,
 * and its own OpenAI implementations do the talking. cc-switch already stores everything that needs
 * (base_url + wire_api in the Codex TOML, the key under auth, and a modelCatalog with reasoning
 * levels), so nothing is guessed here.
 */

function parseJson(text, fallback) {
  if (text && typeof text === 'object') return text
  try {
    return JSON.parse(String(text ?? ''))
  } catch {
    return fallback
  }
}

/** Reads one `key = "value"` line out of the Codex TOML profile. */
function tomlValue(toml, key) {
  const match = String(toml ?? '').match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))
  return match ? match[1].trim() : undefined
}

function slugOf(row) {
  const compact = String(row.id ?? '').replace(/[^a-zA-Z0-9]/g, '')
  return compact.slice(0, 8) || 'provider'
}

/** pi-ai wants a level -> wire spelling dict; `none` is cc-switch for off, which travels as null. */
function reasoningEffortsOf(levels, defaultLevel) {
  if (!Array.isArray(levels) || levels.length === 0) return false
  const efforts = {}
  for (const level of levels) {
    if (typeof level !== 'string') continue
    const id = level.trim().toLowerCase()
    if (id === '' || id === 'off') continue
    if (id === 'none') efforts.off = null
    else efforts[id] = id
  }
  if (Object.keys(efforts).length === 0) return false
  if (typeof defaultLevel === 'string' && defaultLevel.trim() && defaultLevel.trim() !== 'none') {
    const id = defaultLevel.trim().toLowerCase()
    if (id in efforts && id !== 'off') efforts[id] = id
  }
  return efforts
}

function modelsOf(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : []
  const out = []
  for (const model of models) {
    const id = typeof model?.model === 'string' ? model.model : typeof model?.id === 'string' ? model.id : ''
    if (id === '') continue
    const input = Array.isArray(model.inputModalities)
      ? model.inputModalities.filter((item) => item === 'text' || item === 'image')
      : []
    out.push({
      id,
      ...(typeof model.displayName === 'string' && model.displayName ? { name: model.displayName } : {}),
      ...(Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
      ...(input.length > 0 ? { input } : {}),
      reasoningEfforts: reasoningEffortsOf(model.reasoningLevels, model.defaultReasoningLevel),
    })
  }
  return out
}

/**
 * @param {object[]} rows raw `providers` rows (id, app_type, name, settings_config)
 * @returns {{ route: string, name: string, apiKey: string, entry: object, errors: string[] }[]}
 */
export function codexProviders(rows) {
  const out = []
  const taken = new Set()
  for (const row of rows) {
    const name = String(row.name ?? '').trim() || 'codex provider'
    const config = parseJson(row.settings_config, {})
    const toml = typeof config?.config === 'string' ? config.config : ''
    const baseURL = (tomlValue(toml, 'base_url') ?? '').replace(/\/+$/, '')
    const wire = tomlValue(toml, 'wire_api') ?? ''
    const auth = config?.auth && typeof config.auth === 'object' ? config.auth : {}
    const apiKey = Object.values(auth).find((value) => typeof value === 'string' && value.trim().length > 8)
    if (!/^https?:\/\//i.test(baseURL) || typeof apiKey !== 'string') continue
    const models = modelsOf(config?.modelCatalog)
    if (models.length === 0) continue

    let route = `ccswitch-codex-${slugOf(row)}`
    let index = 2
    while (taken.has(route)) route = `ccswitch-codex-${slugOf(row)}-${index++}`
    taken.add(route)
    out.push({
      route,
      name,
      apiKey: apiKey.trim(),
      entry: {
        // The credential service addresses a secret by environment-variable name; the bridge stores
        // the cc-switch key under this ref so no secret is written into the profile config.
        apiKeyEnv: route.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
        displayName: `${name} · codex`,
        api: wire === 'responses' ? 'openai-responses' : 'openai-completions',
        baseURL,
        models,
      },
    })
  }
  return out
}
