/**
 * Self-check for the bridge codec and the cc-switch reader. Run: node tests/smoke.mjs
 * Asserts only; no test framework.
 */
import assert from 'node:assert/strict'
import { decodeStream, encodeRequest, projectMessages } from '../lib/anthropic.js'
import { loadProviders, splitModelLabel } from '../lib/source.js'
import { levelIds, reasoningEfforts, replaysWithoutThinking } from '../lib/thinking.js'

let failures = 0
async function check(name, run) {
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}\n     ${error?.message ?? error}`)
  }
}

const sse = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":100,"output_tokens":1}}}',
  '',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi "}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"there"}}',
  'data: {"type":"content_block_stop","index":1}',
  '',
  'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"a.txt\\"}"}}',
  'data: {"type":"content_block_stop","index":2}',
  '',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}',
  'data: {"type":"message_stop"}',
  '',
].join('\n')

async function decode(text) {
  const chunks = []
  for await (const chunk of decodeStream(new Response(text).body)) chunks.push(chunk)
  return chunks
}

await check('SSE stream maps to Harness chunks', async () => {
  const chunks = await decode(sse)
  const starts = chunks.filter((chunk) => chunk.type === 'block-start')
  assert.deepEqual(
    starts.map((chunk) => [chunk.index, chunk.blockType]),
    [
      [0, 'reasoning'],
      [1, 'text'],
      [2, 'tool-call'],
    ],
  )
  assert.equal(
    chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk.text)
      .join(''),
    'hi there',
  )
  const reasoning = chunks.find((chunk) => chunk.type === 'reasoning-delta')
  assert.equal(reasoning.text, 'plan')
  const toolEnd = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.equal(toolEnd.block.id, 'toolu_1')
  assert.equal(toolEnd.block.name, 'Read')
  assert.equal(toolEnd.block.arguments, '{"path":"a.txt"}')
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.deepEqual(usage.usage, {
    inputTokens: 12,
    outputTokens: 42,
    totalTokens: 154,
    cacheReadTokens: 100,
  })
  const finish = chunks.at(-1)
  assert.deepEqual(finish, { type: 'finish', reason: { kind: 'tool-calls' } })
})

await check('malformed SSE payload is skipped, not fatal', async () => {
  const chunks = await decode('data: not json\n\ndata: {"type":"message_stop"}\n\n')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

await check('upstream error event throws a coded failure', async () => {
  await assert.rejects(decode('data: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n'), (error) => {
    assert.equal(error.code, 'SERVER')
    assert.equal(error.failure.message, 'busy')
    return true
  })
})

await check('unanswered tool calls are dropped before sending', async () => {
  const { system, messages } = projectMessages({
    system: 'sys',
    messages: [
      { role: 'system', content: 'extra' },
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool-call', id: 'c1', name: 'Read', arguments: '{"p":"a"}' },
          { type: 'tool-call', id: 'c2', name: 'Gone', arguments: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'c1', content: 'file body' },
    ],
  })
  assert.equal(system, 'sys\n\nextra')
  assert.equal(messages.length, 3)
  assert.deepEqual(messages[0], { role: 'user', content: [{ type: 'text', text: 'hello' }] })
  assert.deepEqual(messages[1].content, [
    { type: 'text', text: 'ok' },
    { type: 'tool_use', id: 'c1', name: 'Read', input: { p: 'a' } },
  ])
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'file body' }],
  })
})

await check('request body clamps max_tokens and projects tools', async () => {
  const body = encodeRequest(
    {
      maxTokens: 100_000,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Read', description: 'read a file', parameters: { type: 'object', properties: {} } }],
    },
    { modelId: 'glm-5.3', maxTokens: 4096 },
  )
  assert.equal(body.model, 'glm-5.3')
  assert.equal(body.max_tokens, 4096)
  assert.equal(body.stream, true)
  assert.deepEqual(body.tools, [
    { name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: {} } },
  ])
})

await check('model labels keep the id and read the context window', async () => {
  assert.deepEqual(splitModelLabel('deepseek-flash[1M]'), { id: 'deepseek-flash', window: 1_048_576 })
  assert.deepEqual(splitModelLabel('glm-5.3'), { id: 'glm-5.3', window: undefined })
})

await check('real cc-switch database yields usable providers', async () => {
  const loaded = await loadProviders({})
  console.log(`     db=${loaded.dbPath} providers=${loaded.providers.length} skipped=${loaded.skipped.length}`)
  if (loaded.providers.length === 0) {
    console.log('     (no cc-switch install on this machine — skipping the content checks)')
    return
  }
  const routes = new Set()
  for (const provider of loaded.providers) {
    assert.match(provider.route, /^ccswitch-/)
    assert.ok(!routes.has(provider.route), `duplicate route ${provider.route}`)
    routes.add(provider.route)
    assert.match(provider.baseURL, /^https?:\/\//)
    assert.ok(provider.headers.authorization || provider.headers['x-api-key'], `${provider.route} has no credential`)
    assert.ok(provider.models.length > 0, `${provider.route} has no models`)
    const ids = new Set()
    for (const model of provider.models) {
      assert.ok(model.id, `${provider.route} has an empty model id`)
      assert.ok(!ids.has(model.id), `${provider.route} repeats model ${model.id}`)
      ids.add(model.id)
    }
  }
  const sample = loaded.providers[0]
  console.log(`     sample: ${sample.displayName} -> ${sample.baseURL} [${sample.models.map((m) => m.id).join(', ')}]`)
})

await check('thinking effort reaches the request body within the provider limits', async () => {
  const target = { modelId: 'glm-5.3', baseURL: 'https://open.bigmodel.cn/api/anthropic', headers: {}, thinking: true }
  const base = { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], temperature: 0.3, maxTokens: 512 }
  const high = encodeRequest({ ...base, reasoningEffort: 'high' }, target)
  assert.deepEqual(high.thinking, { type: 'enabled', budget_tokens: 16_384 })
  assert.ok(high.max_tokens > 16_384, `max_tokens ${high.max_tokens} must exceed the budget`)
  assert.equal(high.temperature, undefined, 'temperature must be dropped while thinking')
  assert.deepEqual(encodeRequest({ ...base, reasoningEffort: 'off' }, target).thinking, { type: 'disabled' })
  // A model with a small output cap gets a budget under that cap instead of an impossible one.
  const capped = encodeRequest({ ...base, reasoningEffort: 'max' }, { ...target, maxTokens: 8192 })
  assert.equal(capped.thinking.budget_tokens, 4096)
  assert.ok(capped.max_tokens > capped.thinking.budget_tokens)
  // No thinking-capable host: the body stays exactly as before.
  const plain = encodeRequest({ ...base, reasoningEffort: 'high' }, { ...target, thinking: false })
  assert.equal(plain.thinking, undefined)
  assert.equal(plain.temperature, 0.3)
  assert.equal(plain.max_tokens, 512)
})

await check('levels come from cc-switch, not from a ladder of our own', async () => {
  assert.deepEqual(levelIds(['low', 'high', 'max']), ['low', 'high', 'max'])
  assert.deepEqual(levelIds(['none', 'low', 'medium', 'high', 'xhigh', 'max']), ['off', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(levelIds(['high', 'high', 'bogus']), ['high'])
  assert.deepEqual(reasoningEfforts(['off', 'low', 'xhigh']).map((effort) => effort.name), ['Off', 'Low', 'Xhigh'])
})

await check('upstreams that demand their thinking blocks back get no menu', async () => {
  assert.ok(replaysWithoutThinking('https://open.bigmodel.cn/api/anthropic'))
  assert.ok(replaysWithoutThinking('https://api.kimi.com/coding/'))
  assert.ok(replaysWithoutThinking('https://api.minimax.cn/anthropic'))
  // DeepSeek answers 400 content[].thinking must be passed back; CC-Vibe wants adaptive thinking.
  assert.ok(!replaysWithoutThinking('https://api.deepseek.com/anthropic'))
  assert.ok(!replaysWithoutThinking('https://cc-vibe.com/anthropic'))
  assert.ok(!replaysWithoutThinking('not a url'))
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
