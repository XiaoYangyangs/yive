import { describe, expect, test, vi } from 'vitest'

import {
  describeSessionSaveResult,
  waitForSessionSaveResult,
} from '../../web/src/session-save-polling.js'

describe('session-save-polling', () => {
  test('keeps polling until the save reaches a terminal state', async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({
        failure_reason: null,
        session_id: null,
        state: 'waiting',
        unchanged: true,
      })
      .mockResolvedValueOnce({
        failure_reason: null,
        session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        state: 'saved',
        unchanged: false,
      })

    const result = await waitForSessionSaveResult(
      {
        failure_reason: null,
        session_id: null,
        state: 'waiting',
        unchanged: true,
      },
      refresh,
      { pollIntervalMs: 5 }
    )

    expect(result.state).toBe('saved')
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  test('aborts waiting when the signal cancels', async () => {
    const controller = new AbortController()
    const refresh = vi.fn().mockResolvedValue({
      failure_reason: null,
      session_id: null,
      state: 'waiting',
      unchanged: true,
    })
    const pending = waitForSessionSaveResult(
      {
        failure_reason: null,
        session_id: null,
        state: 'waiting',
        unchanged: true,
      },
      refresh,
      { pollIntervalMs: 20, signal: controller.signal }
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('describes terminal session save outcomes consistently', () => {
    expect(
      describeSessionSaveResult(
        {
          failure_reason: null,
          session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          state: 'saved',
          unchanged: false,
        },
        {
          missingSessionId: 'missing',
          saved: (id) => `saved:${id}`,
          unchanged: (id) => `unchanged:${id}`,
          unresolved: 'unresolved',
          verificationFailed: 'failed',
        }
      )
    ).toEqual({ kind: 'success', message: 'saved:aaaaaaaa' })
  })
})
