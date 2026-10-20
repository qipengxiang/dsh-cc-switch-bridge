/**
 * Anthropic Messages codec: Harness request messages -> /v1/messages body, and the
 * response (SSE or plain JSON) -> Harness StreamChunk sequence.
 *
 * Deliberately import-free: the Harness adapter contract is structural, so nothing here
 * depends on a specific @deepseek-ai/dsh-llm release.
 */
import { BridgeError, errorForStatus } from './errors.js'
import { thinkingRequest } from './thinking.js'

const DEFAULT_MAX_TOKENS = 8192

// ---------------------------------------------------------------------------
// request encoding
// ---------------------------------------------------------------------------

function blocksOf(content) {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : []
  if (Array.isArray(content)) return content.filter((block) => block && typeof block === 'object')
  if (content && typeof content === 'object') return [content]
  return []
}

function textOf(content) {
  if (typeof content === 'string') return content
  return blocksOf(content)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n')
}

function toolCallId(block) {
  return block.toolCallId ?? block.tool_call_id ?? block.callId ?? block.id
}

function toolResultId(message) {
  return message.toolCallId ?? message.tool_call_id ?? message.callId ?? message.source?.callId
}

function parseArguments(value) {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Drops tool results with no matching call and tool calls with no matching result. */
function repairToolPairing(entries) {
  const callIds = new Set()
  const resultIds = new Set()
  for (const entry of entries) {
    for (const block of entry.blocks) {
      if (block.type === 'tool-call' && block.id) callIds.add(block.id)
      if (block.type === 'tool-result' && block.id) resultIds.add(block.id)
    }
  }
  const repaired = []
  for (const entry of entries) {
    const blocks = entry.blocks.filter((block) => {
      if (block.type === 'tool-call') return Boolean(block.id && block.name && resultIds.has(block.id))
      if (block.type === 'tool-result') return Boolean(block.id && callIds.has(block.id))
      return true
    })
    if (blocks.length === 0) continue
    repaired.push({ role: entry.role, blocks })
  }
  return repaired
}

function toWireBlocks(role, blocks) {
  const out = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text !== '') out.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool-call') {
      out.push({ type: 'tool_use', id: block.id, name: block.name, input: parseArguments(block.arguments) })
    } else if (block.type === 'tool-result') {
      const body = textOf(block.content ?? block.output ?? block.text ?? '')
      out.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: body === '' ? '(no output)' : body,
        ...(block.isError ? { is_error: true } : {}),
      })
    } else if (block.type === 'image') {
      const image = toImageBlock(block)
      if (image) out.push(image)
      else out.push({ type: 'text', text: '[image omitted by the cc-switch bridge]' })
    }
    // reasoning blocks are not replayed: Anthropic requires signatures we do not keep.
  }
  // Anthropic expects the results of a parallel tool turn before any new user text.
  if (role === 'user') return [...out.filter((block) => block.type === 'tool_result'), ...out.filter((block) => block.type !== 'tool_result')]
  return out
}

function toImageBlock(block) {
  const url = block.attachment?.url ?? block.url
  if (typeof url !== 'string') return undefined
  const match = url.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i)
  if (!match) return undefined
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
}

/**
 * @param {{ messages?: object[], system?: string }} options
 * @returns {{ system: string, messages: object[] }}
 */
export function projectMessages(options) {
  const systemParts = []
  if (typeof options.system === 'string' && options.system.trim()) systemParts.push(options.system)
  const entries = []
  for (const message of options.messages ?? []) {
    if (!message || typeof message !== 'object') continue
    const role = message.role
    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content)
      if (text.trim()) systemParts.push(text)
      continue
    }
    if (role === 'tool') {
      const id = toolResultId(message)
      if (!id) continue
      entries.push({ role: 'user', blocks: [{ type: 'tool-result', id, content: message.content }] })
      continue
    }
    if (role !== 'user' && role !== 'assistant') continue
    const blocks = blocksOf(message.content).filter((block) => typeof block.type === 'string')
    if (blocks.length === 0) continue
    entries.push({ role, blocks })
  }

  const repaired = repairToolPairing(entries)
  const wire = []
  for (const entry of repaired) {
    const blocks = toWireBlocks(entry.role, entry.blocks)
    if (blocks.length === 0) continue
    const previous = wire[wire.length - 1]
    if (previous && previous.role === entry.role) previous.content.push(...blocks)
    else wire.push({ role: entry.role, content: blocks })
  }
  if (wire.length > 0 && wire[0].role === 'assistant') wire.unshift({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] })
  return { system: systemParts.join('\n\n'), messages: wire }
}

export function projectTools(tools) {
  if (!Array.isArray(tools)) return []
  const projected = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || tool.name === '') continue
    projected.push({
      name: tool.name,
      ...(typeof tool.description === 'string' && tool.description ? { description: tool.description } : {}),
      input_schema:
        tool.parameters && typeof tool.parameters === 'object'
          ? tool.parameters
          : { type: 'object', properties: {}, additionalProperties: true },
    })
  }
  return projected
}

export function encodeRequest(options, target) {
  const { system, messages } = projectMessages(options)
  const tools = projectTools(options.tools)
  // No effort means no thinking field at all: some upstreams (MiniMax adaptive models) reject
  // an explicit `disabled`, and omitting it already means off everywhere else.
  const reasoning = target.thinking && options.reasoningEffort ? thinkingRequest(options.reasoningEffort, target.maxTokens) : {}
  const thinking = reasoning.thinking
  const maxTokens = Math.max(clampMaxTokens(options.maxTokens, target), reasoning.maxTokensFloor ?? 0)
  const body = {
    model: target.modelId,
    max_tokens: maxTokens,
    stream: true,
    messages,
  }
  if (system) body.system = system
  if (tools.length > 0) body.tools = tools
  if (thinking) body.thinking = thinking
  // Anthropic accepts temperature 1 only while thinking is on, so the bridge drops it.
  if (thinking?.type !== 'enabled' && typeof options.temperature === 'number' && Number.isFinite(options.temperature)) {
    body.temperature = options.temperature
  }
  const stop = Array.isArray(options.stop) ? options.stop.filter((item) => typeof item === 'string' && item !== '') : []
  if (stop.length > 0) body.stop_sequences = stop
  return body
}

export function clampMaxTokens(requested, target) {
  const limit = typeof target.maxTokens === 'number' && target.maxTokens > 0 ? target.maxTokens : undefined
  const desired = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : undefined
  const base = desired ?? limit ?? DEFAULT_MAX_TOKENS
  return limit ? Math.min(base, limit) : base
}

// ---------------------------------------------------------------------------
// response decoding
// ---------------------------------------------------------------------------

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function buildUsage(raw) {
  if (!raw) return undefined
  const input = num(raw.input_tokens) ?? 0
  const output = num(raw.output_tokens) ?? 0
  const cacheRead = num(raw.cache_read_input_tokens) ?? 0
  const cacheWrite = num(raw.cache_creation_input_tokens) ?? 0
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return undefined
  const usage = { inputTokens: input, outputTokens: output, totalTokens: input + cacheRead + cacheWrite + output }
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite
  return usage
}

const ERROR_CODES = {
  overloaded_error: 'SERVER',
  rate_limit_error: 'RATE_LIMIT',
  authentication_error: 'INVALID_CREDENTIAL',
  permission_error: 'INVALID_CREDENTIAL',
  not_found_error: 'INVALID_REQUEST',
  invalid_request_error: 'INVALID_REQUEST',
  request_too_large: 'CONTEXT_WINDOW_EXCEEDED',
  billing_error: 'QUOTA',
  api_error: 'SERVER',
  timeout_error: 'TIMEOUT',
}

export function errorForEvent(error) {
  const message = typeof error?.message === 'string' && error.message ? error.message : 'upstream stream error'
  const code = ERROR_CODES[error?.type] ?? 'SERVER'
  return new BridgeError(message, code)
}

function finishReason(stopReason) {
  if (stopReason === 'tool_use') return { kind: 'tool-calls' }
  if (stopReason === 'max_tokens' || stopReason === 'length') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

function createState() {
  return { blocks: new Map(), order: 0, rawUsage: undefined, stopReason: undefined, done: false }
}

function openBlock(state, anthropicIndex, block) {
  if (state.blocks.has(anthropicIndex)) return state.blocks.get(anthropicIndex)
  const type = block?.type
  let blockType
  if (type === 'tool_use' || type === 'server_tool_use') blockType = 'tool-call'
  else if (type === 'thinking' || type === 'redacted_thinking') blockType = 'reasoning'
  else if (type === 'text') blockType = 'text'
  else return undefined
  const slot = {
    index: state.order++,
    blockType,
    id: blockType === 'tool-call' ? (typeof block.id === 'string' && block.id ? block.id : `toolu_${state.order}`) : undefined,
    name: blockType === 'tool-call' ? block.name : undefined,
    text: typeof block.text === 'string' ? block.text : typeof block.thinking === 'string' ? block.thinking : '',
    arguments: '',
    started: false,
    closed: false,
  }
  state.blocks.set(anthropicIndex, slot)
  return slot
}

function finalBlock(slot) {
  if (slot.blockType === 'tool-call') {
    return { type: 'tool-call', id: slot.id, name: slot.name ?? '', arguments: slot.arguments || '{}' }
  }
  if (slot.blockType === 'reasoning') return { type: 'reasoning', text: slot.text }
  return { type: 'text', text: slot.text }
}

function handleEvent(state, data) {
  const out = []
  switch (data?.type) {
    case 'message_start': {
      if (data.message?.usage) state.rawUsage = { ...state.rawUsage, ...data.message.usage }
      return out
    }
    case 'content_block_start': {
      const slot = openBlock(state, data.index ?? state.order, data.content_block ?? {})
      if (!slot) return out
      slot.started = true
      out.push({ type: 'block-start', index: slot.index, blockType: slot.blockType })
      if (slot.blockType === 'tool-call' && data.content_block?.input && typeof data.content_block.input === 'object') {
        const initial = data.content_block.input
        if (Object.keys(initial).length > 0) {
          const json = JSON.stringify(initial)
          slot.arguments += json
          out.push({ type: 'tool-call-delta', index: slot.index, id: slot.id, argumentsDelta: json })
        }
      }
      if (slot.blockType === 'text' && slot.text !== '') {
        out.push({ type: 'text-delta', index: slot.index, text: slot.text })
      }
      if (slot.blockType === 'reasoning' && slot.text !== '') {
        out.push({ type: 'reasoning-delta', index: slot.index, text: slot.text })
      }
      return out
    }
    case 'content_block_delta': {
      const slot = state.blocks.get(data.index)
      if (!slot) return out
      const delta = data.delta ?? {}
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        slot.text += delta.text
        out.push({ type: 'text-delta', index: slot.index, text: delta.text })
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        slot.text += delta.thinking
        out.push({ type: 'reasoning-delta', index: slot.index, text: delta.thinking })
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        slot.arguments += delta.partial_json
        out.push({ type: 'tool-call-delta', index: slot.index, id: slot.id, argumentsDelta: delta.partial_json })
      }
      return out
    }
    case 'content_block_stop': {
      const slot = state.blocks.get(data.index)
      if (!slot || slot.closed) return out
      slot.closed = true
      out.push({ type: 'block-end', index: slot.index, block: finalBlock(slot) })
      return out
    }
    case 'message_delta': {
      if (typeof data.delta?.stop_reason === 'string') state.stopReason = data.delta.stop_reason
      if (data.usage) state.rawUsage = { ...state.rawUsage, ...data.usage }
      return out
    }
    case 'message_stop':
      state.done = true
      return out
    case 'error':
      throw errorForEvent(data.error)
    default:
      return out
  }
}

function* finalize(state) {
  const slots = [...state.blocks.values()].sort((a, b) => a.index - b.index)
  for (const slot of slots) {
    if (slot.closed) continue
    slot.closed = true
    yield { type: 'block-end', index: slot.index, block: finalBlock(slot) }
  }
  const usage = buildUsage(state.rawUsage)
  if (usage) yield { type: 'usage', usage }
  yield { type: 'finish', reason: finishReason(state.stopReason) }
}

/** Decodes a `text/event-stream` body into Harness stream chunks. */
export async function* decodeStream(body, options = {}) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const state = createState()
  let buffer = ''
  const flush = (line) => {
    if (line === '' || line.startsWith(':')) return []
    const data = line.startsWith('data:') ? line.slice(5).trim() : undefined
    if (data === undefined) return []
    if (data === '[DONE]') return []
    let payload
    try {
      payload = JSON.parse(data)
    } catch {
      return []
    }
    return handleEvent(state, payload)
  }
  try {
    for (;;) {
      if (options.signal?.aborted) {
        const aborted = new BridgeError('request aborted', 'ABORTED')
        throw aborted
      }
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        const chunks = flush(line)
        for (const chunk of chunks) yield chunk
      }
    }
    buffer += decoder.decode()
    const tail = flush(buffer.replace(/\r$/, ''))
    for (const chunk of tail) yield chunk
  } finally {
    try {
      await reader.cancel()
    } catch {}
  }
  yield* finalize(state)
}

/** Decodes a non-streaming `application/json` messages response into chunks. */
export function* decodeMessage(json) {
  const state = createState()
  const content = Array.isArray(json?.content) ? json.content : []
  let anthropicIndex = 0
  for (const block of content) {
    const slot = openBlock(state, anthropicIndex++, block)
    if (!slot) continue
    if (slot.blockType === 'tool-call') slot.arguments = JSON.stringify(block.input ?? {})
    yield { type: 'block-start', index: slot.index, blockType: slot.blockType }
    if (slot.blockType === 'tool-call') {
      yield { type: 'tool-call-delta', index: slot.index, id: slot.id, argumentsDelta: slot.arguments }
    } else if (slot.text !== '') {
      const chunk = { index: slot.index, text: slot.text }
      yield slot.blockType === 'reasoning'
        ? { type: 'reasoning-delta', ...chunk }
        : { type: 'text-delta', ...chunk }
    }
    slot.closed = true
    yield { type: 'block-end', index: slot.index, block: finalBlock(slot) }
  }
  state.rawUsage = json?.usage
  state.stopReason = json?.stop_reason
  yield* finalize(state)
}

export async function readErrorBody(response) {
  let text = ''
  try {
    text = await response.text()
  } catch {}
  let message = text.trim()
  try {
    const parsed = JSON.parse(text)
    const upstream = parsed?.error?.message ?? parsed?.message ?? parsed?.error?.type
    if (typeof upstream === 'string' && upstream.trim()) message = upstream.trim()
  } catch {}
  if (!message) message = `upstream responded ${response.status} ${response.statusText}`.trim()
  return errorForStatus(response.status, message)
}
