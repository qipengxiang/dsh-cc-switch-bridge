/** Error type that keeps a Harness-compatible failure snapshot without importing dsh-llm. */
export class BridgeError extends Error {
  constructor(message, code = 'UNKNOWN', extra = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.failure = { message, code, ...extra }
  }
}

const CONTEXT_PATTERN = /context.{0,24}(length|window|limit)|too many tokens|maximum context/i

export function statusCodeFor(status) {
  if (status === 401 || status === 403) return 'INVALID_CREDENTIAL'
  if (status === 402) return 'QUOTA'
  if (status === 408) return 'TIMEOUT'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return 'INVALID_REQUEST'
}

export function errorForStatus(status, message, extra = {}) {
  const code = CONTEXT_PATTERN.test(message) ? 'CONTEXT_WINDOW_EXCEEDED' : statusCodeFor(status)
  return new BridgeError(message, code, { status, ...extra })
}

export function errorForException(error, extra = {}) {
  if (error instanceof BridgeError) return error
  if (error?.name === 'AbortError') {
    const aborted = new BridgeError('request aborted', 'ABORTED', extra)
    aborted.aborted = true
    return aborted
  }
  const message = error?.message ? String(error.message) : String(error)
  return new BridgeError(message, 'TRANSPORT', extra)
}
