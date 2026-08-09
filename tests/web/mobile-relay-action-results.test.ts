import { describe, expect, test } from 'vitest'

import {
  readRelayActionResult,
  readRelayConfirmationNonce,
  readRelayRunId,
  readRelayTeamResult,
} from '../../web/src/mobile/mobile-relay-action-results.js'

describe('mobile relay action result parsing', () => {
  test('reads run ids from relay action result objects', () => {
    expect(readRelayRunId({ result: { run_id: 'run-1' } }, 'missing run')).toBe('run-1')
    expect(() => readRelayRunId({ result: {} }, 'missing run')).toThrow('missing run')
    expect(() => readRelayRunId({ ok: true }, 'missing run')).toThrow('missing run')
  })

  test('reads optional native action result metadata', () => {
    expect(readRelayActionResult({ result: { input: 'ctrl_v' } })).toEqual({ input: 'ctrl_v' })
    expect(
      readRelayActionResult({
        result: {
          fallback_reason: 'native_clipboard_unavailable',
          input: 'server_attachment_prompt',
        },
      })
    ).toEqual({
      fallback_reason: 'native_clipboard_unavailable',
      input: 'server_attachment_prompt',
    })
    expect(readRelayActionResult({ ok: true })).toEqual({})
  })

  test('reads team action result with the legacy empty fallback', () => {
    expect(
      readRelayTeamResult({ result: { dispatch_id: 'dispatch-1', forwarded: false } })
    ).toEqual({
      dispatch_id: 'dispatch-1',
      forwarded: false,
    })
    expect(readRelayTeamResult({ ok: true })).toEqual({ dispatch_id: null })
  })

  test('requires confirmation nonces for dangerous relay actions', () => {
    expect(readRelayConfirmationNonce({ nonce: 'confirm-1' })).toBe('confirm-1')
    expect(() => readRelayConfirmationNonce({ nonce: '' })).toThrow(
      'Relay confirmation did not return a nonce'
    )
    expect(() => readRelayConfirmationNonce({ ok: true })).toThrow(
      'Relay confirmation did not return a nonce'
    )
  })
})
