import { describe, expect, test } from 'vitest'

import { parseRelayEnvelope, serializeRelayError } from '../../src/shared/relay-protocol.js'

describe('relay protocol', () => {
  test('parses relay envelopes with optional workspace scope context', () => {
    expect(
      parseRelayEnvelope(
        JSON.stringify({
          channel: 'mobile_events',
          from: 'phone-1',
          payload: { subscription_id: 'sub-1' },
          relay_context: { workspace_ids: ['workspace-1', '', 42, 'workspace-2'] },
          request_id: 'sub-1',
          to: 'desktop-1',
          type: 'subscribe_mobile_events',
        })
      )
    ).toEqual({
      channel: 'mobile_events',
      from: 'phone-1',
      payload: { subscription_id: 'sub-1' },
      relay_context: { workspace_ids: ['workspace-1', 'workspace-2'] },
      request_id: 'sub-1',
      to: 'desktop-1',
      type: 'subscribe_mobile_events',
    })
  })

  test('rejects malformed relay envelopes before routing', () => {
    expect(() => parseRelayEnvelope('{}')).toThrow(/payload is required/)
    expect(() => parseRelayEnvelope('[]')).toThrow(/expected object/)
    expect(() =>
      parseRelayEnvelope(
        JSON.stringify({ channel: 'runtime', from: 'phone-1', payload: {}, to: '' })
      )
    ).toThrow(/is required/)
  })

  test('serializes relay errors without leaking unrelated fields', () => {
    expect(
      JSON.parse(
        serializeRelayError({
          channel: 'runtime',
          code: 'desktop_offline',
          desktopId: 'desktop-1',
          message: 'Desktop is offline',
          requestId: 'req-1',
          to: 'phone-1',
        })
      )
    ).toEqual({
      channel: 'runtime',
      from: 'relay',
      payload: {
        code: 'desktop_offline',
        desktop_id: 'desktop-1',
        message: 'Desktop is offline',
      },
      request_id: 'req-1',
      to: 'phone-1',
      type: 'relay_error',
    })
  })
})
