/**
 * cc-switch -> DeepSeek Harness model bridge.
 *
 * Every Anthropic-compatible provider saved in the local cc-switch app becomes one Harness
 * provider route, so its models show up in the model picker and switch like any built-in model.
 * Which cc-switch tool groups feed the picker is chosen on the plugin's settings page; Codex rows
 * are handed to the built-in pi-ai adapter instead, because the bridge only speaks Anthropic.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { CcSwitchAdapter } from './lib/adapter.js'
import { codexProviders } from './lib/codex.js'
import { DEFAULT_APPS, reorder, readSelection, writeSelection } from './lib/selection.js'
import { listToolGroups, loadProviders, readProviderRows } from './lib/source.js'

export const name = 'dsh-cc-switch-bridge'
export const inject = ['llm']

const RESYNC_INTERVAL_MS = 60_000
const ACCESS_THROTTLE_MS = 5_000
// No trailing slash: the carrier matches `path === prefix || path.startsWith(prefix + '/')`.
const ROUTE_PREFIX = '/dsh-cc-switch'
const CODEX_ROUTE_PREFIX = 'ccswitch-codex-'

// What the last successful sync exposed — the only way to see inside the host process.
const STATUS_PATH = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-cc-switch-bridge.status.json')

/** Stable JSON so two configs can be compared without caring about key order. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function sendJSON(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJSON(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_048_576) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function apply(ctx, config = {}) {
  let providers = new Map()
  let registration
  let disposed = false
  let syncing
  let lastSync = 0
  const credentialRefs = new Map()
  const state = {
    at: undefined,
    dbPath: undefined,
    groups: [],
    selected: [...DEFAULT_APPS],
    bridged: [],
    skipped: [],
    codex: [],
    errors: [],
  }

  const log = (level, message) => {
    const logger = ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
    else if (level !== 'info') console.warn(`dsh-cc-switch-bridge: ${message}`)
  }

  const adapter = new CcSwitchAdapter(
    () => providers,
    () => {
      const now = Date.now()
      if (now - lastSync < ACCESS_THROTTLE_MS) return
      lastSync = now
      void sync()
    },
  )

  async function writeStatus() {
    const status = {
      at: state.at,
      db: state.dbPath,
      selected: state.selected,
      groups: state.groups,
      providers: state.bridged,
      codex: state.codex,
      hostRoutes: ctx.llm.listProviders().map((provider) => provider.id),
      skipped: state.skipped,
      errors: state.errors,
    }
    await mkdir(dirname(STATUS_PATH), { recursive: true })
    await writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`)
  }

  /** Hands selected Codex rows to the built-in pi-ai adapter by editing its profile row. */
  async function syncCodex(wanted, rows, knownRefs = [], order = []) {
    const editor = ctx.get('configEditor')
    if (!editor || typeof editor.edit !== 'function') return { routes: [], note: 'configEditor unavailable' }
    const entry = editor.entries().find((candidate) => {
      const packageName = String(candidate?.name ?? candidate?.options?.name ?? '')
      return packageName.includes('llm-pi-ai')
    })
    if (!entry) return { routes: [], note: 'the built-in pi-ai adapter is not installed' }

    const current = editor.configuration().find((item) => item.entry?.id === entry.id)?.override ?? {}
    const existing = current.providers && typeof current.providers === 'object' ? current.providers : {}
    const next = {}
    for (const [key, value] of Object.entries(existing)) {
      if (!key.startsWith(CODEX_ROUTE_PREFIX)) next[key] = value
    }
    const projected = wanted.includes('codex') ? reorder(codexProviders(rows), order) : []
    const routes = []
    for (const provider of projected) {
      next[provider.route] = provider.entry
      routes.push({
        route: provider.route,
        name: provider.entry.displayName ?? provider.name,
        api: provider.entry.api,
        models: provider.entry.models.map((model) => model.id),
      })
    }

    // The pi-ai row keeps the reference, so a dropped route would leave its secret behind.
    const credentials = ctx.get('credentials')
    const refs = projected.map((provider) => provider.entry.apiKeyEnv)
    for (const ref of knownRefs) {
      if (refs.includes(ref) || !credentials || typeof credentials.unset !== 'function') continue
      try {
        await credentials.unset(ref)
        credentialRefs.delete(ref)
      } catch (error) {
        log('warn', `cannot drop the credential ${ref}: ${error?.message ?? error}`)
      }
    }

    for (const provider of projected) {
      const ref = provider.entry.apiKeyEnv
      if (!credentials || credentialRefs.get(ref) === provider.apiKey) continue
      try {
        await credentials.set(ref, provider.apiKey)
        credentialRefs.set(ref, provider.apiKey)
      } catch (error) {
        log('warn', `cannot store the credential for ${provider.name}: ${error?.message ?? error}`)
      }
    }

    if (stable(existing) !== stable(next)) {
      await editor.edit(entry, (now) => ({ ...now, providers: next }))
    }
    return { routes, refs }
  }

  function snapshot() {
    return {
      at: state.at,
      dbPath: state.dbPath,
      groups: state.groups,
      selected: state.selected,
      bridged: state.bridged,
      codex: state.codex,
      skipped: state.skipped,
      errors: state.errors,
    }
  }

  async function sync() {
    if (disposed) return
    if (syncing) return syncing
    syncing = (async () => {
      try {
        const selection = await readSelection()
        state.selected = selection.apps
        state.errors = []
        try {
          // Only groups this bridge can actually import: Anthropic-compatible rows, or Codex rows
          // that the built-in pi-ai adapter takes over.
          state.groups = (await listToolGroups(config)).map((group) => ({
            ...group,
            importable: group.appType === 'codex' || group.formats.includes('anthropic'),
          }))
        } catch (error) {
          state.errors.push(`cannot list cc-switch tool groups: ${error?.message ?? error}`)
        }
        const known = new Set(state.groups.filter((group) => group.importable).map((group) => group.appType))
        const wanted = selection.apps.filter((app) => known.size === 0 || known.has(app))

        const loaded =
          wanted.length === 0
            ? { providers: [], skipped: [], errors: [], dbPath: state.dbPath }
            : await loadProviders({ ...config, appTypes: wanted })
        for (const message of loaded.errors) log('warn', message)
        state.dbPath = loaded.dbPath
        const ordered = reorder(loaded.providers, selection.order)
        providers = new Map(ordered.map((provider) => [provider.route, provider]))
        const routes = ordered.map((provider) => provider.route)
        if (routes.length > 0) {
          if (registration) registration.replace(routes)
          else registration = ctx.llm.registerAdapter(routes, adapter)
        } else if (registration) {
          try {
            registration()
          } catch {}
          registration = undefined
        }
        state.bridged = ordered.map((provider) => ({
          route: provider.route,
          name: provider.displayName,
          thinking: provider.thinking,
          models: provider.models.map((model) => model.id),
          levels: Object.fromEntries(provider.models.filter((model) => model.levels).map((model) => [model.id, model.levels])),
        }))
        state.skipped = loaded.skipped

        const rows = wanted.includes('codex')
          ? (await readProviderRows(config)).filter((row) => String(row.app_type ?? '') === 'codex')
          : []
        const result = await syncCodex(wanted, rows, selection.refs, selection.order)
        state.codex = result.routes
        if (Array.isArray(result.refs)) await writeSelection(selection.apps, result.refs, selection.order)
        if (result.note) state.errors.push(`Codex group: ${result.note}`)

        state.at = new Date().toISOString()
        void writeStatus().catch(() => {})
        log('info', `synced ${routes.length} provider route(s), ${state.codex.length} Codex route(s)`)
      } catch (error) {
        log('warn', `cc-switch sync failed: ${error?.message ?? error}`)
        state.errors.push(String(error?.message ?? error))
      } finally {
        syncing = undefined
      }
    })()
    return syncing
  }

  function route(req, res) {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://dsh.invalid')
      const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, '') || 'state'
      try {
        if (action === 'state' && (req.method === 'GET' || req.method === 'HEAD')) return sendJSON(res, 200, snapshot())
        if (action === 'state' && req.method === 'POST') {
          const body = await readJSON(req)
          const known = new Set(state.groups.filter((group) => group.importable).map((group) => group.appType))
          const apps = Array.isArray(body?.apps) ? body.apps.filter((app) => typeof app === 'string' && known.has(app)) : []
          const order = Array.isArray(body?.order) ? body.order.filter((route) => typeof route === 'string' && route !== '') : []
          // Keep the managed credential refs: only the sync knows which ones survive.
          await writeSelection(apps, (await readSelection()).refs, order)
          await sync()
          return sendJSON(res, 200, snapshot())
        }
        if (action === 'sync' && req.method === 'POST') {
          await sync()
          return sendJSON(res, 200, snapshot())
        }
        return sendJSON(res, 404, { error: `unknown action ${action}` })
      } catch (error) {
        return sendJSON(res, 500, { error: String(error?.message ?? error) })
      }
    })()
  }

  // `webServer` may activate after this plugin, so wait for it instead of reading it once.
  ctx.inject(['webServer'], (scope) => {
    const off = scope.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: route })
    return () => {
      try {
        off()
      } catch {}
    }
  })

  ctx.effect(() => {
    void sync()
    const timer = setInterval(() => void sync(), RESYNC_INTERVAL_MS)
    timer.unref?.()
    return () => {
      disposed = true
      clearInterval(timer)
      try {
        registration?.()
      } catch {}
    }
  })
}
