/**
 * cc-switch -> DeepSeek Harness model bridge.
 *
 * Every Anthropic-compatible provider saved in the local cc-switch app becomes one Harness
 * provider route, so its models show up in the model picker and switch like any built-in model.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { CcSwitchAdapter } from './lib/adapter.js'
import { loadProviders } from './lib/source.js'

export const name = 'dsh-cc-switch-bridge'
export const inject = ['llm']

const RESYNC_INTERVAL_MS = 60_000
const ACCESS_THROTTLE_MS = 5_000

// What the last successful sync exposed — the only way to see inside the host process.
const STATUS_PATH = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-cc-switch-bridge.status.json')

async function writeStatus(loaded) {
  const status = {
    at: new Date().toISOString(),
    db: loaded.dbPath,
    providers: loaded.providers.map((provider) => ({
      route: provider.route,
      name: provider.displayName,
      thinking: provider.thinking,
      models: provider.models.map((model) => model.id),
      levels: Object.fromEntries(provider.models.filter((model) => model.levels).map((model) => [model.id, model.levels])),
    })),
  }
  await mkdir(dirname(STATUS_PATH), { recursive: true })
  await writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`)
}

export function apply(ctx, config = {}) {
  let providers = new Map()
  let registration
  let disposed = false
  let syncing
  let lastSync = 0

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

  async function sync() {
    if (disposed) return
    if (syncing) return syncing
    syncing = (async () => {
      try {
        const loaded = await loadProviders(config)
        for (const message of loaded.errors) log('warn', message)
        if (disposed) return
        if (loaded.providers.length === 0) {
          log('warn', `no usable cc-switch provider in ${loaded.dbPath}`)
          return
        }
        providers = new Map(loaded.providers.map((provider) => [provider.route, provider]))
        const routes = loaded.providers.map((provider) => provider.route)
        if (registration) {
          registration.replace(routes)
        } else {
          registration = ctx.llm.registerAdapter(routes, adapter)
          log('info', `bridged ${routes.length} cc-switch provider(s)`)
        }
        void writeStatus(loaded).catch(() => {})
      } catch (error) {
        log('warn', `cc-switch sync failed: ${error?.message ?? error}`)
      } finally {
        syncing = undefined
      }
    })()
    return syncing
  }

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
