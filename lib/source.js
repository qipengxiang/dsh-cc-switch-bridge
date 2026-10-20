/**
 * Reads the providers that the local cc-switch app (https://github.com/farion1231/cc-switch)
 * saved in its SQLite database and turns them into descriptor objects the Harness adapter
 * can answer for.
 *
 * cc-switch stores every provider row as (id, app_type, name, settings_config JSON, meta JSON).
 * Rows whose meta.apiFormat is "anthropic" are Anthropic Messages endpoints: a base URL plus a
 * bearer token, which is exactly what this bridge speaks.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

import { levelIds, normalizeLevel, replaysWithoutThinking } from './thinking.js'

const CLI_CANDIDATES = ['/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3', '/usr/local/bin/sqlite3']
const ANTHROPIC_VERSION = '2023-06-01'
// Only these app types store Anthropic Messages endpoints; codex/pi/opencode rows use other wire formats.
const DEFAULT_APP_TYPES = ['claude', 'claude-desktop']

export function defaultDbPath() {
  return path.join(os.homedir(), '.cc-switch', 'cc-switch.db')
}

function readCliPath() {
  if (process.env.CC_SWITCH_SQLITE3) return process.env.CC_SWITCH_SQLITE3
  for (const candidate of CLI_CANDIDATES) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return 'sqlite3'
}

function runSqliteCli(dbPath, sql) {
  return new Promise((resolve, reject) => {
    execFile(
      readCliPath(),
      ['-readonly', '-json', dbPath, sql],
      { maxBuffer: 32 * 1024 * 1024, timeout: 20000 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
  })
}

async function queryViaNodeSqlite(dbPath, sql) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return JSON.stringify(db.prepare(sql).all())
  } finally {
    db.close()
  }
}

async function queryRows(dbPath, sql) {
  let nodeError
  try {
    return JSON.parse(await queryViaNodeSqlite(dbPath, sql))
  } catch (error) {
    nodeError = error
  }
  try {
    const text = await runSqliteCli(dbPath, sql)
    return text.trim() === '' ? [] : JSON.parse(text)
  } catch (error) {
    const detail = [nodeError?.message, error?.message].filter(Boolean).join(' | ')
    throw new Error(`cannot read ${dbPath}: ${detail}`)
  }
}

const PROVIDER_SQL = `
  SELECT id, app_type, name, settings_config, meta, provider_type, is_current, website_url
  FROM providers
  ORDER BY app_type, sort_index, name
`

function parseJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback
  if (typeof text === 'object') return text
  try {
    return JSON.parse(String(text))
  } catch {
    return fallback
  }
}

/** Walks a settings blob looking for a URL / secret under a bounded set of key names. */
function deepFind(tree, matcher, depth = 0) {
  if (!tree || typeof tree !== 'object' || depth > 4) return undefined
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'string' && matcher(key, value)) return value
  }
  for (const value of Object.values(tree)) {
    if (value && typeof value === 'object') {
      const found = deepFind(value, matcher, depth + 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

const LOOKS_LIKE_URL = (key, value) => /base_?url$/i.test(key) && /^https?:\/\//i.test(value)
const LOOKS_LIKE_SECRET = (key, value) =>
  /(auth_?token|api_?key|access_?token|secret)$/i.test(key) && value.length > 3

function readEndpoint(row) {
  const config = parseJson(row.settings_config, {})
  const env = config?.env && typeof config.env === 'object' ? config.env : {}
  let baseURL = env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_URL || env.ANTHROPIC_BASE_API
  let token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY
  let apiKey = env.ANTHROPIC_API_KEY
  if (!baseURL) baseURL = deepFind(config, LOOKS_LIKE_URL)
  if (!token && !apiKey) {
    const secret = deepFind(config, LOOKS_LIKE_SECRET)
    token = secret
    apiKey = secret
  }
  return { config, env, baseURL: normalizeBaseURL(baseURL), token, apiKey }
}

function normalizeBaseURL(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!/^https?:\/\//i.test(trimmed)) return undefined
  return trimmed.replace(/\/+$/, '')
}

/** "deepseek-flash[1M]" -> { id: "deepseek-flash", window: 1048576 } */
export function splitModelLabel(raw) {
  const full = String(raw ?? '').trim()
  if (full === '') return { id: '', window: undefined }
  const match = full.match(/^(.*?)\s*\[([^\]]+)\]\s*$/)
  if (!match) return { id: full, window: undefined }
  return { id: match[1].trim(), window: parseWindow(match[2]) }
}

export function parseWindow(text) {
  const match = String(text ?? '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const unit = (match[2] ?? '').toLowerCase()
  const scale = unit === 'k' ? 1024 : unit === 'm' ? 1024 * 1024 : 1
  return Math.round(amount * scale)
}

function envWindow(env) {
  for (const key of ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW']) {
    const parsed = parseWindow(env[key])
    if (parsed) return parsed
  }
  return undefined
}

function stripLabel(raw) {
  return splitModelLabel(raw).id
}

/**
 * Builds the model list for one provider. `meta.stackModels` (written by newer cc-switch
 * versions) wins; otherwise the ANTHROPIC_*MODEL environment variables are folded in.
 */
function buildModels({ config, env, meta }) {
  const fallbackWindow = envWindow(env)
  const byId = new Map()
  const push = (raw, options = {}) => {
    const label = splitModelLabel(raw)
    const id = options.id ?? label.id
    if (!id) return
    const known = byId.get(id)
    const contextWindow = options.window ?? label.window ?? fallbackWindow
    if (known) {
      if (options.name && options.name !== known.name) known.name = options.name
      if (!known.contextWindow && contextWindow) known.contextWindow = contextWindow
      return
    }
    byId.set(id, {
      id,
      name: options.name ?? label.id,
      ...(contextWindow ? { contextWindow } : {}),
      ...(typeof options.defaultMaxTokens === 'number' ? { defaultMaxTokens: options.defaultMaxTokens } : {}),
    })
  }

  const stackModels = Array.isArray(meta?.stackModels) ? meta.stackModels : []
  for (const entry of stackModels) {
    if (typeof entry === 'string') push(entry)
    else if (entry && typeof entry === 'object') {
      push(entry.model ?? entry.id, {
        name: entry.displayName ?? entry.name,
        window: entry.oneM ? 1024 * 1024 : undefined,
      })
    }
  }

  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.trim() === '') continue
    if (!/^ANTHROPIC_[A-Z0-9_]*MODEL$/.test(key)) continue
    const displayName = env[`${key}_NAME`]
    push(value, { name: typeof displayName === 'string' && displayName.trim() ? displayName.trim() : undefined })
  }

  // Some rows keep the model only inside the nested config; use the row name as a last resort.
  if (byId.size === 0) {
    const nested = deepFind(config, (key, value) => /(^|_)model$/i.test(key) && stripLabel(value) !== '')
    if (nested) push(nested)
  }

  return [...byId.values()]
}

function makeHeaders({ token, apiKey }) {
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  }
  if (typeof apiKey === 'string' && apiKey.trim() && apiKey !== token) headers['x-api-key'] = apiKey.trim()
  else if (typeof token === 'string' && token.trim()) headers.authorization = `Bearer ${token.trim()}`
  return headers
}

function routeIdFor(row, taken) {
  const compact = String(row.id ?? '').replace(/[^a-zA-Z0-9]/g, '')
  let base = `ccswitch-${compact.slice(0, 8) || compact || 'provider'}`
  let candidate = base
  let index = 2
  while (taken.has(candidate)) candidate = `${base}-${index++}`
  taken.add(candidate)
  return candidate
}

function providerLabel(row, appType) {
  const name = String(row.name ?? '').trim() || 'cc-switch provider'
  return appType === 'claude' ? name : `${name} · ${appType}`
}

/**
 * Model capabilities cc-switch declares for its other apps: `codex` rows carry a modelCatalog
 * naming the levels the Codex CLI offers, `pi` rows carry pi's thinkingLevelMap. The bridge speaks
 * neither protocol, but those declarations are the user's own settings, so the Harness menu
 * mirrors them instead of inventing a ladder.
 *
 * Keyed by provider name first: the same model id shows up under several cc-switch providers that
 * declare different levels, and the provider being mirrored is the one that decides.
 *
 * @returns {{ byProvider: Map<string, Map<string, object>>, byModel: Map<string, object> }}
 */
function readCapabilities(rows) {
  const byProvider = new Map()
  const byModel = new Map()
  const absorb = (providerName, id, levels, extra = {}) => {
    const modelKey = typeof id === 'string' ? id.trim() : ''
    const name = typeof providerName === 'string' ? providerName.trim() : ''
    if (modelKey === '' || levels.length === 0) return
    const entry = { levels }
    if (extra.defaultLevel) entry.defaultLevel = extra.defaultLevel
    if (extra.contextWindow) entry.contextWindow = extra.contextWindow
    if (extra.maxTokens) entry.maxTokens = extra.maxTokens
    if (name !== '') {
      const models = byProvider.get(name) ?? new Map()
      if (!models.has(modelKey)) models.set(modelKey, entry)
      byProvider.set(name, models)
    }
    if (!byModel.has(modelKey)) byModel.set(modelKey, entry)
  }

  for (const row of rows) {
    const appType = String(row.app_type ?? '')
    if (appType !== 'codex' && appType !== 'pi') continue
    const config = parseJson(row.settings_config, {})
    if (appType === 'codex') {
      for (const model of Array.isArray(config?.modelCatalog?.models) ? config.modelCatalog.models : []) {
        absorb(row.name, model?.model ?? model?.id, levelIds(model?.reasoningLevels), {
          defaultLevel: normalizeLevel(model?.defaultReasoningLevel),
          contextWindow: typeof model?.contextWindow === 'number' ? model.contextWindow : undefined,
        })
      }
      continue
    }
    for (const model of Array.isArray(config?.models) ? config.models : []) {
      if (model?.reasoning !== true) continue
      const map = model?.thinkingLevelMap
      if (!map || typeof map !== 'object') continue
      // pi writes a null wire value for a level the model cannot take.
      const offered = Object.entries(map)
        .filter(([, wire]) => wire !== null)
        .map(([level]) => level)
      absorb(row.name, model?.id, levelIds(offered), {
        contextWindow: typeof model?.contextWindow === 'number' ? model.contextWindow : undefined,
        maxTokens: typeof model?.maxTokens === 'number' ? model.maxTokens : undefined,
      })
    }
  }
  return { byProvider, byModel }
}

/**
 * @param {{ dbPath?: string, appTypes?: string[], thinking?: boolean }} [config]
 * @returns {Promise<{ providers: object[], skipped: object[], errors: string[], dbPath: string, mtimeMs: number }>}
 */
export async function loadProviders(config = {}) {
  const dbPath = config.dbPath ? String(config.dbPath) : defaultDbPath()
  const appTypes = Array.isArray(config.appTypes) && config.appTypes.length > 0 ? config.appTypes : DEFAULT_APP_TYPES
  let stat
  try {
    stat = fs.statSync(dbPath)
  } catch (error) {
    return {
      providers: [],
      skipped: [],
      errors: [`cc-switch database not found at ${dbPath} (${error.code ?? error.message})`],
      dbPath,
      mtimeMs: 0,
    }
  }

  const rows = await queryRows(dbPath, PROVIDER_SQL)
  const capabilities = readCapabilities(rows)
  const providers = []
  const skipped = []
  const errors = []
  const taken = new Set()

  for (const row of rows) {
    const appType = String(row.app_type ?? '')
    if (!appTypes.includes(appType)) continue
    const meta = parseJson(row.meta, {})
    const apiFormat = typeof meta?.apiFormat === 'string' ? meta.apiFormat : ''
    const { config: settingsConfig, env, baseURL, token, apiKey } = readEndpoint(row)
    if (apiFormat && apiFormat !== 'anthropic') {
      skipped.push({ provider: row.name, reason: `apiFormat ${apiFormat}` })
      continue
    }
    if (!baseURL) {
      skipped.push({ provider: row.name, reason: 'no base URL' })
      continue
    }
    if (!token && !apiKey) {
      skipped.push({ provider: row.name, reason: 'no credential' })
      continue
    }
    const models = buildModels({ config: settingsConfig, env, meta })
    if (models.length === 0) {
      skipped.push({ provider: row.name, reason: 'no model' })
      continue
    }
    const thinking = config.thinking !== false && replaysWithoutThinking(baseURL)
    const providerName = String(row.name ?? '').trim()
    for (const model of models) {
      const declared = capabilities.byProvider.get(providerName)?.get(model.id) ?? capabilities.byModel.get(model.id)
      if (!declared) continue
      if (!model.contextWindow && declared.contextWindow) model.contextWindow = declared.contextWindow
      if (!model.defaultMaxTokens && declared.maxTokens) model.defaultMaxTokens = declared.maxTokens
      // A level menu only appears where cc-switch declares levels and the upstream can take them.
      if (!thinking || declared.levels.length === 0) continue
      model.levels = declared.levels
      if (declared.defaultLevel && declared.levels.includes(declared.defaultLevel)) model.defaultLevel = declared.defaultLevel
    }
    const route = routeIdFor(row, taken)
    providers.push({
      route,
      provider: route,
      appType,
      providerId: String(row.id ?? ''),
      displayName: providerLabel(row, appType),
      sourceName: String(row.name ?? ''),
      baseURL,
      headers: makeHeaders({ token, apiKey }),
      models,
      thinking: thinking && models.some((model) => model.levels),
      isCurrent: Boolean(row.is_current),
    })
  }

  return { providers, skipped, errors, dbPath, mtimeMs: stat.mtimeMs }
}
