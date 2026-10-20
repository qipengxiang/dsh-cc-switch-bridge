/**
 * Live matrix test over every bridged model, using the real cc-switch database and keys.
 *
 *   node tests/matrix.mjs [claude|codex]
 *
 * Every model gets one tool-call request (conversation + function calling). Once per provider
 * the first model that supports them also gets a tool round trip, a thinking request at its
 * highest declared level, and a picture. Results go to tests/matrix-report.json.
 */
import { writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { loadProviders, readProviderRows } from '../lib/source.js'
import { codexProviders } from '../lib/codex.js'
import { CcSwitchAdapter } from '../lib/adapter.js'

const TIMEOUT = 120_000
const TOOL = {
  name: 'lookup_weather',
  description: 'Look up the current weather for a city.',
  parameters: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] },
}
const ASK_TOOL = 'Call lookup_weather for Paris. Do not answer in text.'
const TOOL_RESULT = 'sunny, 24C'
const ASK_THINK = 'A bat and a ball cost 1.10 in total. The bat costs 1.00 more than the ball. How much is the ball?'
const ASK_IMAGE = 'What color is this square? Answer with one word.'
const IMAGE = redSquare(32)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function crc32(buffer) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let crc = -1
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A red square, so a vision model can answer 'red' without guessing. */
function redSquare(size) {
  const stride = size * 3 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      raw[y * stride + 1 + x * 3] = 220
      raw[y * stride + 2 + x * 3] = 30
      raw[y * stride + 3 + x * 3] = 30
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

async function pool(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      try {
        results[index] = await worker(items[index], index)
      } catch (error) {
        results[index] = { error: String(error?.message ?? error) }
      }
    }
  })
  await Promise.all(runners)
  return results
}

function short(value, limit = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function failure(error) {
  const code = error?.code ? `${error.code}: ` : ''
  return `${code}${short(error?.message ?? error)}`
}

// ---------------------------------------------------------------------------
// Anthropic path (through the bridge's own adapter)
// ---------------------------------------------------------------------------

function collect(chunks) {
  let text = ''
  let reasoning = ''
  const calls = []
  let finish
  let usage
  for (const chunk of chunks) {
    if (chunk.type === 'text-delta') text += chunk.text ?? ''
    else if (chunk.type === 'reasoning-delta') reasoning += chunk.text ?? ''
    else if (chunk.type === 'tool-call-delta') {
      const slot = (calls[chunk.index] ??= { id: '', name: '', arguments: '' })
      if (chunk.id) slot.id = chunk.id
      if (chunk.name) slot.name = chunk.name
      slot.arguments += chunk.argumentsDelta ?? ''
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
      // The name only exists on the assembled block, not on the deltas.
      const slot = (calls[chunk.index] ??= { id: '', name: '', arguments: '' })
      Object.assign(slot, { id: chunk.block.id ?? slot.id, name: chunk.block.name ?? slot.name, arguments: chunk.block.arguments ?? slot.arguments })
    } else if (chunk.type === 'finish') finish = chunk.reason
    else if (chunk.type === 'usage') usage = chunk.usage
  }
  return { text, reasoning, calls, finish, usage }
}

async function toolScenario(run) {
  // Providers vary run to run: Kimi sometimes prints the tool call as XML text instead of emitting
  // a tool_use block. One retry separates that flake from a real failure.
  let result = await run()
  if (result.calls.length === 0) result = await run()
  return result
}

async function anthropicRun(adapter, provider, model, options) {
  const chunks = []
  for await (const chunk of adapter.stream({ provider, model, maxTokens: 1024, signal: AbortSignal.timeout(TIMEOUT), ...options })) {
    chunks.push(chunk)
  }
  return collect(chunks)
}

async function claudeExtras(adapter, provider, model, row) {
  const info = adapter.resolveModel(provider.route, model.id)
  const efforts = info.reasoning?.efforts ?? []
  const effort = efforts.filter((item) => item.id !== 'off').at(-1)
  if (efforts.length > 0 && provider.thinking && effort) {
    row.thinkingLevel = effort.id
    try {
      const result = await anthropicRun(adapter, provider.route, model.id, {
        messages: [{ role: 'user', content: ASK_THINK }],
        reasoningEffort: effort.id,
      })
      row.thinking = result.finish === 'error' ? 'finish error' : 'ok'
      row.thinkingReasoning = result.reasoning.length
      row.thinkingAnswer = short(result.text)
    } catch (error) {
      row.thinking = `error ${failure(error)}`
    }
  } else if (efforts.length > 0) {
    row.thinking = 'skipped (this host may not accept thinking)'
  }
  try {
    const result = await anthropicRun(adapter, provider.route, model.id, {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: ASK_IMAGE },
          { type: 'image', attachment: { url: `data:image/png;base64,${IMAGE}` } },
        ],
      }],
    })
    row.image = /red/i.test(result.text) ? 'ok' : `unexpected (${short(result.text)})`
  } catch (error) {
    row.image = `error ${failure(error)}`
  }
}

// ---------------------------------------------------------------------------
// Codex path (what pi-ai puts on the wire for an openai-responses/completions provider)
// ---------------------------------------------------------------------------

function responsesInput(history) {
  return history.map((item) => {
    if (item.role) {
      const content = [{ type: 'input_text', text: item.text }]
      if (item.image) content.push({ type: 'input_image', image_url: `data:image/png;base64,${item.image}` })
      return { role: item.role, content }
    }
    return item
  })
}

async function codexRun(provider, model, scenario) {
  const entry = provider.entry
  const responses = entry.api === 'openai-responses'
  const url = `${entry.baseURL}${responses ? '/responses' : '/chat/completions'}`
  const history = scenario.history
  const body = responses
    ? { model: model.id, store: false, max_output_tokens: 1024, input: responsesInput(history) }
    : {
        model: model.id,
        max_tokens: 1024,
        messages: history.map((item) =>
          item.role
            ? { role: item.role, content: item.image ? [{ type: 'text', text: item.text }, { type: 'image_url', image_url: { url: `data:image/png;base64,${item.image}` } }] : item.text }
            : item,
        ),
      }
  if (scenario.tools) {
    body.tools = responses
      ? [{ type: 'function', name: TOOL.name, description: TOOL.description, parameters: TOOL.parameters }]
      : [{ type: 'function', function: TOOL }]
  }
  if (scenario.effort) {
    if (responses) body.reasoning = { effort: scenario.effort }
    else body.reasoning_effort = scenario.effort
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!response.ok) throw new Error(`${response.status} ${short(await response.text())}`)
  const json = await response.json()
  if (responses) {
    const output = Array.isArray(json.output) ? json.output : []
    const text = output
      .filter((item) => item.type === 'message')
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .filter((item) => item.type === 'output_text')
      .map((item) => item.text)
      .join('')
    const calls = output
      .filter((item) => item.type === 'function_call')
      .map((item) => ({ id: item.call_id, name: item.name, arguments: item.arguments }))
    return { text, reasoning: '', calls, finish: json.status }
  }
  const message = json.choices?.[0]?.message ?? {}
  const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map((part) => part.text ?? '').join('') : ''
  const calls = (message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function?.name, arguments: call.function?.arguments }))
  return { text, reasoning: message.reasoning_content ?? '', calls, finish: json.choices?.[0]?.finish_reason }
}

async function codexExtras(provider, model, row) {
  const efforts = model.reasoningEfforts && typeof model.reasoningEfforts === 'object' ? model.reasoningEfforts : {}
  const keys = Object.keys(efforts).filter((key) => key !== 'off' && efforts[key] !== null)
  const effort = keys.at(-1)
  if (effort) {
    row.thinkingLevel = effort
    try {
      const result = await codexRun(provider, model, { history: [{ role: 'user', text: ASK_THINK }], effort })
      row.thinking = 'ok'
      row.thinkingReasoning = result.reasoning.length
      row.thinkingAnswer = short(result.text)
    } catch (error) {
      row.thinking = `error ${failure(error)}`
    }
  }
  if (Array.isArray(model.input) && model.input.includes('image')) {
    try {
      const result = await codexRun(provider, model, { history: [{ role: 'user', text: ASK_IMAGE, image: IMAGE }] })
      row.image = /red/i.test(result.text) ? 'ok' : `unexpected (${short(result.text)})`
    } catch (error) {
      row.image = `error ${failure(error)}`
    }
  } else {
    row.image = 'text-only model'
  }
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

function toolFollowUp(run) {
  // Second turn: replay the call and hand back a result, expecting prose.
  return async (provider, model, call) => run(provider, model, {
    tools: [TOOL],
    history: [
      { role: 'user', text: ASK_TOOL },
      { type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments },
      { type: 'function_call_output', call_id: call.id, output: TOOL_RESULT },
    ],
  })
}

function summarize(provider, rows) {
  const passed = rows.filter((row) => row.tools === 'ok').length
  return `${provider.displayName ?? provider.route}: ${passed}/${rows.length}`
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const family = process.argv[2]
const filter = process.argv[3] // provider name substring, keeps smoke runs cheap
function provider__match(name) {
  return String(name ?? '').includes(filter)
}

const rows = []
const started = Date.now()

if (!family || family === 'claude') {
  const loaded = await loadProviders({ appTypes: ['claude', 'claude-desktop'] })
  const records = new Map(loaded.providers.map((provider) => [provider.route, provider]))
  const adapter = new CcSwitchAdapter(() => records)

  for (const provider of loaded.providers.filter((item) => !filter || provider__match(item.displayName ?? item.name ?? item.id))) {
    const results = await pool(provider.models, 3, async (model) => {
      const row = { family: 'claude', provider: provider.displayName ?? provider.route, route: provider.route, model: model.id }
      const begin = Date.now()
      if (process.env.MATRIX_ONLY === 'extras') {
        await claudeExtras(adapter, provider, model, row)
        return row
      }
      let call
      try {
        const first = await toolScenario(() => anthropicRun(adapter, provider.route, model.id, {
          tools: [TOOL],
          messages: [{ role: 'user', content: ASK_TOOL }],
        }))
        call = first.calls.find(Boolean)
        row.tools = call ? 'ok' : `no tool call (${short(first.text)})`
        row.ms = Date.now() - begin
      } catch (error) {
        row.tools = `error ${failure(error)}`
        row.ms = Date.now() - begin
        return row
      }
      if (provider.models[0] === model) await claudeExtras(adapter, provider, model, row)
      // Tool round trip, once per provider on the first model that managed a call.
      if (provider.models[0] === model && call) {
        try {
          const second = await anthropicRun(adapter, provider.route, model.id, {
            tools: [TOOL],
            messages: [
              { role: 'user', content: ASK_TOOL },
              { role: 'assistant', content: [{ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments || '{}' }] },
              { role: 'tool', toolCallId: call.id, content: TOOL_RESULT },
            ],
          })
          row.followUp = second.text.trim() ? 'ok' : 'empty reply'
          row.followUpText = short(second.text)
        } catch (error) {
          row.followUp = `error ${failure(error)}`
        }
      }
      return row
    })
    rows.push(...results)
  }
}

if (!family || family === 'codex') {
  const providerRows = await readProviderRows({})
  const projected = codexProviders(providerRows)
  for (const provider of projected.filter((item) => !filter || item.name.includes(filter))) {
    const results = await pool(provider.entry.models, 3, async (model) => {
      const row = { family: 'codex', provider: provider.name, route: provider.route, model: model.id }
      const begin = Date.now()
      if (process.env.MATRIX_ONLY === 'extras') {
        await codexExtras(provider, model, row)
        return row
      }
      let call
      try {
        const first = await toolScenario(() => codexRun(provider, model, { tools: [TOOL], history: [{ role: 'user', text: ASK_TOOL }] }))
        call = first.calls.find(Boolean)
        row.tools = call ? 'ok' : `no tool call (${short(first.text)})`
        row.ms = Date.now() - begin
      } catch (error) {
        row.tools = `error ${failure(error)}`
        row.ms = Date.now() - begin
        return row
      }
      if (provider.entry.models[0] === model) await codexExtras(provider, model, row)
      if (provider.entry.models[0] === model && call) {
        try {
          const second = await codexRun(provider, model, {
            tools: [TOOL],
            history: [
              { role: 'user', text: ASK_TOOL },
              { type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments },
              { type: 'function_call_output', call_id: call.id, output: TOOL_RESULT },
            ],
          })
          row.followUp = second.text.trim() ? 'ok' : 'empty reply'
          row.followUpText = short(second.text)
        } catch (error) {
          row.followUp = `error ${failure(error)}`
        }
      }
      return row
    })
    rows.push(...results)
  }
}

await writeFile(new URL(process.env.MATRIX_ONLY === 'extras' ? './matrix-extras.json' : './matrix-report.json', import.meta.url), `${JSON.stringify({ at: new Date().toISOString(), rows }, null, 2)}\n`)

const groups = new Map()
for (const row of rows) {
  const key = `${row.family}:${row.provider}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(row)
}
for (const [key, group] of groups) {
  const extras = process.env.MATRIX_ONLY === 'extras'
  const ok = extras
    ? group.filter((row) => (row.thinking === undefined || row.thinking === 'ok') && (row.image === undefined || row.image === 'ok' || row.image === 'text-only model')).length
    : group.filter((row) => row.tools === 'ok').length
  console.log(`${ok === group.length ? 'PASS' : ok > 0 ? 'PART' : 'FAIL'} ${key} ${ok}/${group.length}`)
  for (const row of group) {
    const extra = [
      row.tools !== 'ok' && row.tools,
      row.followUp && `follow-up ${row.followUp}`,
      row.thinking && `thinking ${row.thinking}${row.thinkingLevel ? `@${row.thinkingLevel}` : ''}`,
      row.image && `image ${row.image}`,
    ].filter(Boolean).join(' | ')
    if (extra) console.log(`  - ${row.model}: ${extra}`)
  }
}
console.log(`\n${rows.length} models in ${Math.round((Date.now() - started) / 1000)}s → tests/matrix-report.json`)
