/**
 * Renders the settings page outside the browser with a stub React.
 *
 * Catches the class of bug that blanks the page in the real app: a hook called only on some
 * renders (React throws "Rendered more hooks than during the previous render") or a render path
 * that reads a field the host snapshot does not have. Run: node tests/client-render.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let captured
let hookStates = []
let hookIndex = 0
let renders = 0

const React = {
  createElement(type, props, ...children) {
    // React puts the children in props.children; the page's components read them that way.
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  useState(initial) {
    const slot = hookIndex
    hookIndex += 1
    const value = slot < hookStates.length ? hookStates[slot] : initial
    return [value, () => {}]
  },
  useEffect() {},
}

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
new Function('window', 'require', source)(globalThis.window, (name) => {
  if (name === 'react') return React
  throw new Error(`unexpected import: ${name}`)
})

assert.equal(captured?.id, 'dsh-cc-switch-bridge', 'the client module registers under the bundle id')
const client = captured.factory((name) => React)
let registered
client.apply({
  slots: {
    inject(_name, callback) {
      callback()
    },
    register(meta, Component) {
      registered = { meta, Component }
    },
  },
})
assert.equal(registered?.meta?.name, 'settings.section')
assert.equal(typeof registered.Component, 'function')

const render = (states) => {
  hookStates = states
  hookIndex = 0
  renders += 1
  const tree = registered.Component()
  return { tree, hooks: hookIndex }
}

const loading = render([])
assert.equal(loading.hooks, 5, 'every render must call all five hooks')
assert.equal(loading.tree.type, 'div')

const snapshot = {
  at: new Date().toISOString(),
  groups: [
    { appType: 'claude', label: 'Claude Code', count: 11, formats: ['anthropic'], importable: true },
    { appType: 'codex', label: 'Codex', count: 15, formats: ['unknown'], importable: true },
    { appType: 'pi', label: 'Pi', count: 15, formats: ['unknown'], importable: false },
  ],
  selected: ['claude', 'codex'],
  bridged: [
    { route: 'ccswitch-a', name: 'Kimi', thinking: true, models: ['kimi-for-coding'], levels: { 'kimi-for-coding': ['high'] } },
    { route: 'ccswitch-b', name: 'GLM', thinking: false, models: ['glm-5.3'] },
  ],
  codex: [{ route: 'ccswitch-codex-1', name: 'GLM · codex', api: 'openai-responses', models: ['glm-5.3'] }],
  skipped: [],
  errors: [],
}

const loaded = render([snapshot, undefined, false, undefined, undefined])
assert.equal(loaded.hooks, 5, 'the loaded render must call the same hooks as the loading one')

const texts = []
const walk = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') return texts.push(String(node))
  if (Array.isArray(node)) return node.forEach(walk)
  if (node && typeof node.type === 'function') return walk(node.type(node.props))
  if (node && node.props && node.props.children !== undefined) walk(node.props.children)
}
walk(loaded.tree)
const flat = texts.join('|')
if (process.env.DEBUG_PAGE) console.log(flat)
for (const needle of ['导入来源', 'Claude Code', 'Codex', '暂不支持', '已桥接', '已交给 pi-ai']) {
  assert.ok(flat.includes(needle), `the page renders ${needle}`)
}
assert.equal(renders, 2)
console.log('ok   settings page renders loading and loaded states with a stable hook count')
