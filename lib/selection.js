/**
 * Which cc-switch tool groups the user chose to import.
 *
 * Kept in the plugin's own state file rather than the Loader config: the choice changes at runtime
 * from the settings page, and a state file lets the bridge re-sync without re-mounting the plugin.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_APPS = Object.freeze(['claude', 'claude-desktop'])

export function statePath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-cc-switch-bridge.json')
}

/** Keeps only non-empty, lower-case, de-duplicated app types. */
export function normalizeApps(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const app = item.trim().toLowerCase()
    if (app !== '' && !out.includes(app)) out.push(app)
  }
  return out
}

/** Credential refs this bridge wrote, so a later sync can drop the ones it no longer needs. */
function readRefs(parsed) {
  return Array.isArray(parsed?.credentials) ? parsed.credentials.filter((item) => typeof item === 'string') : []
}

/** Route ids in the user's drag order; unknown ids keep their original relative position. */
export function readOrder(parsed) {
  return Array.isArray(parsed?.order) ? parsed.order.filter((item) => typeof item === 'string') : []
}

/** Stable sort by the saved order: listed routes first (in that order), the rest after, unchanged. */
export function reorder(items, order) {
  if (!Array.isArray(order) || order.length === 0) return items
  const rank = new Map(order.map((route, index) => [route, index]))
  return items
    .map((item, index) => ({ item, index, rank: rank.get(item.route) }))
    .sort((left, right) => (left.rank ?? Infinity) - (right.rank ?? Infinity) || left.index - right.index)
    .map(({ item }) => item)
}

/** @returns {Promise<{ apps: string[], refs: string[], order: string[], path: string, stored: boolean }>} */
export async function readSelection() {
  const path = statePath()
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    // An empty array is a real choice ("import nothing"), so only a missing list falls back.
    if (Array.isArray(parsed?.apps)) {
      return { apps: normalizeApps(parsed.apps), refs: readRefs(parsed), order: readOrder(parsed), path, stored: true }
    }
  } catch {}
  return { apps: [...DEFAULT_APPS], refs: [], order: [], path, stored: false }
}

export async function writeSelection(apps, refs = [], order = []) {
  const path = statePath()
  const normalized = normalizeApps(apps)
  await mkdir(dirname(path), { recursive: true })
  const managed = refs.filter((item) => typeof item === 'string' && item !== '')
  const ordered = order.filter((item) => typeof item === 'string' && item !== '')
  await writeFile(path, `${JSON.stringify({ apps: normalized, credentials: managed, order: ordered }, null, 2)}\n`)
  return normalized
}
