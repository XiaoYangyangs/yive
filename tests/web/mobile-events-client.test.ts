// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest'
import type { MobileSnapshot } from '../../web/src/mobile/mobile-events-client.js'
import {
  createMobileEventsClient,
  getMobileSnapshotDashboard,
  toMobileEventsWebSocketUrl,
} from '../../web/src/mobile/mobile-events-client.js'

class MockMobileEventsWebSocket {
  static instances: MockMobileEventsWebSocket[] = []

  onclose: ((event: CloseEvent | Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  readyState = 0

  constructor(readonly url: string) {
    MockMobileEventsWebSocket.instances.push(this)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.(new Event('close'))
  }

  open(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  receive(payload: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }))
  }
}

afterEach(() => {
  MockMobileEventsWebSocket.instances = []
  vi.useRealTimers()
})

describe('mobile events client', () => {
  test('keeps the persisted Orchestrator identity in the dashboard projection', () => {
    const snapshot = {
      active_workspace: {
        orchestrator: {
          active_dispatch_id: null,
          active_run_id: null,
          conversation_activity: 'idle',
          id: 'workspace-1:orchestrator',
          kind: 'orchestrator',
          last_observed_at: 1,
          last_pty_line: null,
          name: 'Lead Agent',
          process_state: 'running',
          queue_pause_reason: null,
          queued_dispatch_count: 0,
        },
        workspace: { id: 'workspace-1' },
        terminal_runs: [],
        workers: [],
      },
    } as MobileSnapshot

    expect(getMobileSnapshotDashboard(snapshot)).toMatchObject({
      orchestrator: {
        id: 'workspace-1:orchestrator',
        kind: 'orchestrator',
        name: 'Lead Agent',
      },
    })
  })

  test('builds the mobile events websocket URL from the current page', () => {
    window.history.pushState({}, '', '/mobile?relay=1')

    expect(toMobileEventsWebSocketUrl()).toBe('ws://localhost:3000/ws/mobile/events')
  })

  test('delivers snapshot and heartbeat messages', () => {
    const onSnapshot = vi.fn()
    const onHeartbeat = vi.fn()
    const onConversationInvalidated = vi.fn()
    const client = createMobileEventsClient({
      onConversationInvalidated,
      onHeartbeat,
      onSnapshot,
      webSocketConstructor: MockMobileEventsWebSocket,
    })

    client.connect()
    const socket = MockMobileEventsWebSocket.instances[0]
    if (!socket) throw new Error('Expected websocket')
    socket.receive({
      snapshot: {
        active_workspace: null,
        active_workspace_id: 'workspace-1',
        connection: {},
        generated_at: 1,
        workspaces: [{ id: 'workspace-1' }],
      },
      type: 'mobile-snapshot',
    })
    socket.receive({ generated_at: 2, type: 'mobile-heartbeat' })
    socket.receive({
      activity_state: 'busy',
      agent_id: 'agent-1',
      conversation_id: 'conversation-1',
      cursor: 3,
      type: 'conversation-invalidated',
      workspace_id: 'workspace-1',
    })
    socket.receive({ type: 'unknown' })

    expect(onSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ active_workspace_id: 'workspace-1' })
    )
    expect(onHeartbeat).toHaveBeenCalledWith(2)
    expect(onConversationInvalidated).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: 'conversation-1', cursor: 3 })
    )
  })

  test('reconnects with bounded backoff after the mobile events socket closes', async () => {
    vi.useFakeTimers()
    const onReconnect = vi.fn()
    const client = createMobileEventsClient({
      onReconnect,
      onSnapshot: vi.fn(),
      reconnectDelayMs: 25,
      webSocketConstructor: MockMobileEventsWebSocket,
    })

    client.connect()
    expect(MockMobileEventsWebSocket.instances).toHaveLength(1)
    MockMobileEventsWebSocket.instances[0]?.close()
    expect(onReconnect).toHaveBeenCalledWith({ attempt: 1, nextDelayMs: 25 })

    await vi.advanceTimersByTimeAsync(24)
    expect(MockMobileEventsWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(MockMobileEventsWebSocket.instances).toHaveLength(2)
    MockMobileEventsWebSocket.instances[1]?.close()
    expect(onReconnect).toHaveBeenLastCalledWith({ attempt: 2, nextDelayMs: 50 })
  })

  test('resets reconnect backoff after the mobile events socket reopens', async () => {
    vi.useFakeTimers()
    const onReconnect = vi.fn()
    const client = createMobileEventsClient({
      onReconnect,
      onSnapshot: vi.fn(),
      reconnectDelayMs: 25,
      webSocketConstructor: MockMobileEventsWebSocket,
    })

    client.connect()
    expect(MockMobileEventsWebSocket.instances).toHaveLength(1)
    MockMobileEventsWebSocket.instances[0]?.close()
    expect(onReconnect).toHaveBeenLastCalledWith({ attempt: 1, nextDelayMs: 25 })

    await vi.advanceTimersByTimeAsync(25)
    expect(MockMobileEventsWebSocket.instances).toHaveLength(2)
    MockMobileEventsWebSocket.instances[1]?.open()
    MockMobileEventsWebSocket.instances[1]?.close()

    expect(onReconnect).toHaveBeenLastCalledWith({ attempt: 1, nextDelayMs: 25 })
  })

  test('dispose closes the socket and prevents reconnects', async () => {
    vi.useFakeTimers()
    const client = createMobileEventsClient({
      onSnapshot: vi.fn(),
      reconnectDelayMs: 25,
      webSocketConstructor: MockMobileEventsWebSocket,
    })

    client.connect()
    expect(MockMobileEventsWebSocket.instances).toHaveLength(1)
    client.dispose()

    await vi.advanceTimersByTimeAsync(25)
    expect(MockMobileEventsWebSocket.instances).toHaveLength(1)
  })
})
