import type { AgentSessionSaveState } from '../../src/shared/types.js'

export interface SessionSaveResultLike {
  failure_reason: string | null
  session_id: string | null
  state: AgentSessionSaveState
  unchanged: boolean
}

export interface SessionSavePresentation {
  kind: 'error' | 'success' | 'warning'
  message: string
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export const describeSessionSaveResult = (
  result: SessionSaveResultLike,
  labels: {
    missingSessionId: string
    saved: (sessionId: string) => string
    unchanged: (sessionId: string) => string
    unresolved: string
    verificationFailed: string
  }
): SessionSavePresentation | null => {
  if (result.state === 'waiting') return null
  if (result.state === 'unresolved') {
    return { kind: 'warning', message: labels.unresolved }
  }
  if (result.state === 'failed') {
    return {
      kind: 'error',
      message: result.failure_reason ?? labels.verificationFailed,
    }
  }
  if (!result.session_id) {
    return { kind: 'error', message: labels.missingSessionId }
  }
  return {
    kind: 'success',
    message: result.unchanged
      ? labels.unchanged(result.session_id.slice(0, 8))
      : labels.saved(result.session_id.slice(0, 8)),
  }
}

export const waitForSessionSaveResult = async <T extends SessionSaveResultLike>(
  initial: T,
  refresh: () => Promise<T>,
  options: {
    onTick?: (value: T) => void
    pollIntervalMs?: number
    signal?: AbortSignal
  } = {}
): Promise<T> => {
  let result = initial
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  while (result.state === 'waiting') {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    await wait(pollIntervalMs, options.signal)
    result = await refresh()
    options.onTick?.(result)
  }
  return result
}
