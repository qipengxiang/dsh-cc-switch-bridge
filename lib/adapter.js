/**
 * Duck-typed Harness LLM adapter: one provider route per cc-switch provider, so the model
 * picker shows one group per provider. Nothing here imports @deepseek-ai/dsh-llm — the
 * Harness contract is structural and the bridge must survive dsh upgrades.
 */
import { BridgeError, errorForException } from './errors.js'
import { encodeRequest, decodeStream, decodeMessage, readErrorBody } from './anthropic.js'
import { reasoningEfforts } from './thinking.js'
// Flat on purpose: the Harness uses an adapter's policy verbatim, without normalizing nesting.
const RETRY_POLICY = Object.freeze({
  initialDelayMs: 800,
  maxDelayMs: 12_000,
  jitterRatio: 0.1,
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
})

function messagesURL(baseURL) {
  return /\/v1$/i.test(baseURL) ? `${baseURL}/messages` : `${baseURL}/v1/messages`
}

export class CcSwitchAdapter {
  #providers
  #onAccess

  /** @param {() => Map<string, object>} providers @param {() => void} [onAccess] */
  constructor(providers, onAccess) {
    this.#providers = providers
    this.#onAccess = onAccess
  }

  #record(provider) {
    this.#onAccess?.()
    return this.#providers().get(provider)
  }

  providerInfo(provider) {
    const record = this.#providers().get(provider)
    return { id: provider, name: record?.displayName ?? provider }
  }

  providerRetryPolicy() {
    return RETRY_POLICY
  }

  imageRequestPricing() {
    return undefined
  }

  imageRequestTarget() {
    return undefined
  }

  listModels(provider) {
    const record = this.#record(provider)
    if (!record) return []
    return record.models.map((model) => ({
      provider,
      id: model.id,
      name: model.name || model.id,
    }))
  }

  resolveModel(provider, model) {
    const record = this.#providers().get(provider)
    const known = record?.models.find((candidate) => candidate.id === model)
    const levels = known?.levels ?? []
    return {
      provider,
      id: model,
      name: known?.name || known?.id || model,
      inputModalities: ['text'],
      ...(known?.contextWindow ? { context: { contextWindow: known.contextWindow } } : {}),
      ...(known?.defaultMaxTokens ? { defaultMaxTokens: known.defaultMaxTokens } : {}),
      // The picker only offers an effort menu when a model declares its levels.
      ...(levels.length > 0
        ? {
            reasoning: {
              efforts: reasoningEfforts(levels),
              ...(known.defaultLevel ? { defaultEffort: known.defaultLevel } : {}),
            },
          }
        : {}),
    }
  }

  #target(provider, model) {
    const record = this.#providers().get(provider)
    if (!record) throw new BridgeError(`cc-switch provider ${provider} is gone; reopen the model picker`, 'INVALID_REQUEST')
    const known = record.models.find((candidate) => candidate.id === model)
    return {
      modelId: model,
      baseURL: record.baseURL,
      headers: record.headers,
      maxTokens: known?.defaultMaxTokens,
      thinking: record.thinking,
    }
  }

  async prepareCall(provider, model) {
    const target = this.#target(provider, model)
    return {
      model: this.resolveModel(provider, model),
      stream: (options) => this.#send(options, target),
    }
  }

  stream(options) {
    return this.#send(options, this.#target(options.provider, options.model))
  }

  async *#send(options, target) {
    try {
      const body = encodeRequest(options, target)
      const response = await fetch(messagesURL(target.baseURL), {
        method: 'POST',
        headers: { ...target.headers, accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: options.signal,
      })
      if (!response.ok) throw await readErrorBody(response)
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json') && response.body) {
        yield* decodeMessage(await response.json())
        return
      }
      if (!response.body) throw new BridgeError('upstream returned an empty body', 'SERVER')
      yield* decodeStream(response.body, { signal: options.signal })
    } catch (error) {
      throw errorForException(error)
    }
  }
}
