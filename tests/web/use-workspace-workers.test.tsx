// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { useWorkspaceWorkers } from '../../web/src/useWorkspaceWorkers.js'

const json = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
  }) as Response

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

const workerPayload = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
  active_dispatch_id: null,
  conversation_activity: 'idle',
  id,
  kind: 'worker',
  last_observed_at: 1_754_360_000_000,
  last_pty_line: null,
  name,
  process_state: 'running',
  provider: 'codex',
  queue_pause_reason: null,
  queued_dispatch_count: 0,
  ...overrides,
})

describe('useWorkspaceWorkers', () => {
  test('loads worker summaries for every local workspace id, not only the active workspace', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/workspaces/a/team') {
        return json([workerPayload('wa', 'Alice', { conversation_activity: 'busy' })])
      }
      if (url === '/api/ui/workspaces/b/team') {
        return json([workerPayload('wb', 'Bob')])
      }
      throw new Error(`Unexpected fetch ${url}`)
    })

    const { result } = renderHook(() => useWorkspaceWorkers(['a', 'b']))

    await waitFor(() => {
      expect(result.current[0]).toEqual({
        a: [
          {
            activeDispatchId: null,
            conversationActivity: 'busy',
            id: 'wa',
            kind: 'worker',
            lastObservedAt: 1_754_360_000_000,
            name: 'Alice',
            processState: 'running',
            provider: 'codex',
            queuePauseReason: null,
            queuedDispatchCount: 0,
          },
        ],
        b: [
          {
            activeDispatchId: null,
            conversationActivity: 'idle',
            id: 'wb',
            kind: 'worker',
            lastObservedAt: 1_754_360_000_000,
            name: 'Bob',
            processState: 'running',
            provider: 'codex',
            queuePauseReason: null,
            queuedDispatchCount: 0,
          },
        ],
      })
    })
  })

  test('prunes worker summaries when a workspace is removed from the local list', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/workspaces/a/team') {
        return json([workerPayload('wa', 'Alice', { conversation_activity: 'busy' })])
      }
      if (url === '/api/ui/workspaces/b/team') {
        return json([workerPayload('wb', 'Bob')])
      }
      throw new Error(`Unexpected fetch ${url}`)
    })

    const { rerender, result } = renderHook(
      ({ workspaceIds }: { workspaceIds: string[] }) => useWorkspaceWorkers(workspaceIds),
      {
        initialProps: { workspaceIds: ['a', 'b'] },
      }
    )

    await waitFor(() => {
      expect(result.current[0]).toHaveProperty('a')
      expect(result.current[0]).toHaveProperty('b')
    })

    rerender({ workspaceIds: ['b'] })

    await waitFor(() => {
      expect(result.current[0]).toEqual({
        b: [
          {
            activeDispatchId: null,
            conversationActivity: 'idle',
            id: 'wb',
            kind: 'worker',
            lastObservedAt: 1_754_360_000_000,
            name: 'Bob',
            processState: 'running',
            provider: 'codex',
            queuePauseReason: null,
            queuedDispatchCount: 0,
          },
        ],
      })
    })
  })

  test('keeps the same workspace map reference when refreshed worker payloads are unchanged', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue(json([workerPayload('wa', 'Alice')]))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useWorkspaceWorkers(['a']))

    await act(async () => {
      await flushPromises()
    })
    expect(result.current[0]).toHaveProperty('a')
    const firstMap = result.current[0]

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current[0]).toBe(firstMap)
  })

  test('backs off failed refreshes and does not overlap in-flight worker requests', async () => {
    vi.useFakeTimers()
    let resolveFirstFetch: ((response: Response) => void) | undefined
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirstFetch = resolve
          })
      )
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(json([workerPayload('wa', 'Alice')]))
    vi.stubGlobal('fetch', fetchMock)

    renderHook(() => useWorkspaceWorkers(['a']))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(5000)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirstFetch?.(json([]))
      await flushPromises()
    })

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      await flushPromises()
      vi.advanceTimersByTime(500)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
