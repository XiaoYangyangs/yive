import type { AgentStopResultPayload } from '../../../src/shared/types.js'
import type { MobileTeamActionResult } from '../api.js'

export interface RelayMobileActionResult {
  fallback_reason?: string
  input?: 'ctrl_v' | 'server_attachment_prompt' | string
}

const readRelayResultObject = (response: unknown): Record<string, unknown> | null => {
  if (
    typeof response === 'object' &&
    response !== null &&
    'result' in response &&
    typeof response.result === 'object' &&
    response.result !== null
  ) {
    return response.result as Record<string, unknown>
  }
  return null
}

export const readRelayRunId = (response: unknown, fallback: string): string => {
  const result = readRelayResultObject(response)
  if (typeof result?.run_id === 'string') return result.run_id
  throw new Error(fallback)
}

export const readRelayActionResult = (response: unknown): RelayMobileActionResult => {
  return readRelayResultObject(response) ?? {}
}

export const readRelayTeamResult = (response: unknown): MobileTeamActionResult => {
  return (readRelayResultObject(response) as MobileTeamActionResult | null) ?? { dispatch_id: null }
}

export const readRelayAgentStopResult = (
  response: unknown,
  requestedMode: AgentStopResultPayload['mode'] = 'safe'
): AgentStopResultPayload => {
  const result = readRelayResultObject(response)
  if (
    (result?.mode === 'safe' || result?.mode === 'checkpoint' || result?.mode === 'force') &&
    (result.state === 'checkpoint_required' ||
      result.state === 'failed' ||
      result.state === 'stopped') &&
    typeof result.run_id === 'string' &&
    (result.session_id === null || typeof result.session_id === 'string') &&
    (result.reason === null || typeof result.reason === 'string')
  ) {
    return result as unknown as AgentStopResultPayload
  }
  if (typeof result?.run_id === 'string') {
    return {
      mode: requestedMode,
      reason: null,
      run_id: result.run_id,
      session_id: null,
      state: 'stopped',
    }
  }
  throw new Error('Relay stop action did not return a valid result')
}

export const readRelayConfirmationNonce = (response: unknown): string => {
  if (
    typeof response === 'object' &&
    response !== null &&
    'nonce' in response &&
    typeof response.nonce === 'string' &&
    response.nonce.length > 0
  ) {
    return response.nonce
  }
  throw new Error('Relay confirmation did not return a nonce')
}
