// @vitest-environment jsdom

import { createServer } from 'node:http'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import WebSocket from 'ws'

import { createPtyOutputBus } from '../../src/server/pty-output-bus.js'
import type { RuntimeStore } from '../../src/server/runtime-store.js'
import { createTerminalWebSocketServer } from '../../src/server/terminal-ws-server.js'
import {
  createTerminalClient,
  preloadTerminalConnection,
} from '../../web/src/terminal/terminal-client.js'

class MockWebSocket {
  static instances: MockWebSocket[] = []

  readonly OPEN = 1
  binaryType = ''
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  readyState = 0
  sent: string[] = []

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
  }

  close() {
    this.readyState = 3
    this.onclose?.(new CloseEvent('close'))
  }

  open() {
    this.readyState = this.OPEN
    this.onopen?.()
  }

  receive(data: string) {
    this.onmessage?.({ data })
  }

  send(payload: string) {
    if (this.readyState === this.OPEN) this.sent.push(payload)
  }
}

const connectionParams = {
  desktop_id: 'desktop-windows',
  device_id: 'phone-1',
  server: 'https://relay.example.com',
  token: 'mobile-token',
}

const waitFor = async (assertion: () => void, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw lastError
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', MockWebSocket)
  MockWebSocket.instances = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('terminal client connection preload', () => {
  test('reuses a ready connection but requests a fresh phone-sized restore', () => {
    const preload = preloadTerminalConnection({
      connectionParams,
      runId: 'run-preloaded',
      viewerMode: 'takeover',
    })
    expect(MockWebSocket.instances).toHaveLength(2)
    const [ioSocket, controlSocket] = MockWebSocket.instances
    expect(ioSocket?.url).toContain('defer_restore=1')
    expect(controlSocket?.url).toContain('defer_restore=1')
    ioSocket?.open()
    controlSocket?.open()
    controlSocket?.receive(
      JSON.stringify({
        cols: 120,
        rows: 40,
        snapshot: 'recent terminal restore',
        type: 'restore',
      })
    )

    expect(controlSocket?.sent).toEqual([])
    const onRestore = vi.fn((_snapshot, _meta, complete: () => void) => complete())
    const client = createTerminalClient({
      connectionParams,
      initialSize: { cols: 48, rows: 24 },
      onError: vi.fn(),
      onExit: vi.fn(),
      onOutput: vi.fn(),
      onRestore,
      runId: 'run-preloaded',
      viewerMode: 'takeover',
    })

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(onRestore).not.toHaveBeenCalled()
    const restoreRequest = JSON.parse(controlSocket?.sent.at(-1) ?? '{}')
    expect(restoreRequest).toEqual({
      cols: 48,
      request_id: expect.any(String),
      rows: 24,
      scrollback: 20,
      type: 'restore_request',
    })

    controlSocket?.receive(
      JSON.stringify({
        cols: 48,
        request_id: restoreRequest.request_id,
        rows: 24,
        snapshot: 'phone restore',
        type: 'restore',
      })
    )
    expect(onRestore).toHaveBeenCalledWith(
      'phone restore',
      { outputBytes: undefined, restoredAt: undefined, size: { cols: 48, rows: 24 } },
      expect.any(Function)
    )
    controlSocket?.receive(
      JSON.stringify({
        cols: 120,
        request_id: 'stale-restore-request',
        rows: 40,
        snapshot: 'stale desktop restore',
        type: 'restore',
      })
    )
    expect(onRestore).toHaveBeenCalledTimes(1)

    client.dispose()
    preload.dispose()
  })

  test('acknowledges but discards output received before the fresh restore request', () => {
    const preload = preloadTerminalConnection({
      connectionParams,
      runId: 'run-live-preload',
      viewerMode: 'takeover',
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances
    ioSocket?.open()
    controlSocket?.open()
    controlSocket?.receive(JSON.stringify({ snapshot: 'cached restore', type: 'restore' }))
    ioSocket?.receive('live while browsing agents')

    expect(controlSocket?.sent.map((payload) => JSON.parse(payload))).toEqual([
      { bytes: 26, type: 'output_ack' },
    ])
    const events: string[] = []
    const client = createTerminalClient({
      connectionParams,
      initialSize: { cols: 80, rows: 24 },
      onError: vi.fn(),
      onExit: vi.fn(),
      onOutput: (chunk) => events.push(`output:${chunk}`),
      onRestore: (snapshot, _meta, complete) => {
        events.push(`restore:${snapshot}`)
        complete()
      },
      runId: 'run-live-preload',
      viewerMode: 'takeover',
    })

    expect(events).toEqual([])
    expect(controlSocket?.sent.map((payload) => JSON.parse(payload))).toEqual([
      { bytes: 26, type: 'output_ack' },
      {
        cols: 80,
        request_id: expect.any(String),
        rows: 24,
        scrollback: 20,
        type: 'restore_request',
      },
    ])

    const requestId = JSON.parse(controlSocket?.sent.at(-1) ?? '{}').request_id
    controlSocket?.receive(
      JSON.stringify({ request_id: requestId, snapshot: 'fresh restore', type: 'restore' })
    )
    expect(events).toEqual(['restore:fresh restore'])

    client.dispose()
    preload.dispose()
  })

  test('keeps the warmed connection without retaining large pre-click output', () => {
    const preload = preloadTerminalConnection({
      connectionParams,
      runId: 'run-overflowing-preload',
      viewerMode: 'takeover',
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances
    ioSocket?.open()
    controlSocket?.open()
    ioSocket?.receive('x'.repeat(300_000))

    expect(ioSocket?.readyState).toBe(1)
    expect(controlSocket?.readyState).toBe(1)
    const onOutput = vi.fn()
    const client = createTerminalClient({
      connectionParams,
      initialSize: { cols: 48, rows: 24 },
      onError: vi.fn(),
      onExit: vi.fn(),
      onOutput,
      onRestore: vi.fn(),
      runId: 'run-overflowing-preload',
      viewerMode: 'takeover',
    })
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(onOutput).not.toHaveBeenCalled()

    client.dispose()
    preload.dispose()
  })

  test('ignores a large automatic restore received before the connection is claimed', () => {
    const preload = preloadTerminalConnection({
      connectionParams,
      runId: 'run-control-overflow',
      viewerMode: 'takeover',
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances
    ioSocket?.open()
    controlSocket?.open()
    controlSocket?.receive(JSON.stringify({ snapshot: 'x'.repeat(300_000), type: 'restore' }))

    expect(ioSocket?.readyState).toBe(1)
    expect(controlSocket?.readyState).toBe(1)
    const onRestore = vi.fn()
    const client = createTerminalClient({
      connectionParams,
      initialSize: { cols: 48, rows: 24 },
      onError: vi.fn(),
      onExit: vi.fn(),
      onOutput: vi.fn(),
      onRestore,
      runId: 'run-control-overflow',
      viewerMode: 'takeover',
    })
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(onRestore).not.toHaveBeenCalled()

    client.dispose()
    preload.dispose()
  })

  test('flushes output acknowledgements queued before the control socket opens', () => {
    const preload = preloadTerminalConnection({
      connectionParams,
      runId: 'run-pending-preload-ack',
      viewerMode: 'takeover',
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances
    ioSocket?.open()
    ioSocket?.receive('early live output')

    const client = createTerminalClient({
      connectionParams,
      onError: vi.fn(),
      onExit: vi.fn(),
      onOutput: vi.fn(),
      onRestore: vi.fn(),
      runId: 'run-pending-preload-ack',
      viewerMode: 'takeover',
    })
    controlSocket?.open()

    expect(controlSocket?.sent.map((payload) => JSON.parse(payload))).toEqual([
      { bytes: 17, type: 'output_ack' },
    ])

    client.dispose()
    preload.dispose()
  })

  test('discards both preloaded sockets when either side closes', () => {
    const preload = preloadTerminalConnection({
      connectionParams,
      runId: 'run-closed-preload',
      viewerMode: 'takeover',
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances
    ioSocket?.close()

    expect(controlSocket?.readyState).toBe(3)
    const client = createTerminalClient({
      connectionParams,
      onError: vi.fn(),
      onExit: vi.fn(),
      onOutput: vi.fn(),
      onRestore: vi.fn(),
      runId: 'run-closed-preload',
      viewerMode: 'takeover',
    })
    expect(MockWebSocket.instances).toHaveLength(4)

    client.dispose()
    preload.dispose()
  })

  test('preloads and claims a terminal connection across the real websocket boundary', async () => {
    const outputBus = createPtyOutputBus()
    const pauseTerminalRun = vi.fn()
    const resizeAgentRun = vi.fn()
    const resumeTerminalRun = vi.fn()
    const writeRunInput = vi.fn()
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: 'real restore snapshot',
        runId: 'run-real-preload',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun,
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun,
      resumeTerminalRun,
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput,
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    const terminalServer = createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const serverPort = address.port
    const sockets: WebSocket[] = []

    class BrowserTestWebSocket extends WebSocket {
      constructor(address: string | URL) {
        const target = new URL(String(address))
        target.protocol = 'ws:'
        target.hostname = '127.0.0.1'
        target.port = String(serverPort)
        super(target)
        sockets.push(this)
      }
    }

    vi.stubGlobal('WebSocket', BrowserTestWebSocket)
    const preload = preloadTerminalConnection({
      runId: 'run-real-preload',
      viewerMode: 'takeover',
    })

    try {
      await waitFor(() => {
        expect(sockets).toHaveLength(2)
        expect(sockets.every((socket) => socket.readyState === WebSocket.OPEN)).toBe(true)
      })
      outputBus.publish('run-real-preload', 'x'.repeat(120 * 1024))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(pauseTerminalRun).not.toHaveBeenCalled()
      expect(resumeTerminalRun).not.toHaveBeenCalled()
      expect(resizeAgentRun).not.toHaveBeenCalled()
      expect(writeRunInput).not.toHaveBeenCalled()

      const events: string[] = []
      const client = createTerminalClient({
        initialSize: { cols: 40, rows: 12 },
        onError: vi.fn(),
        onExit: vi.fn(),
        onOutput: (chunk) => events.push(`output:${chunk.length}`),
        onRestore: (snapshot, _meta, complete) => {
          events.push(`restore:${snapshot.includes('real restore snapshot')}`)
          complete()
        },
        runId: 'run-real-preload',
        viewerMode: 'takeover',
      })

      await waitFor(() => expect(events).toEqual(['restore:true']))
      expect(sockets).toHaveLength(2)
      client.requestTakeover(40, 12)
      await waitFor(() => expect(resizeAgentRun).toHaveBeenCalledWith('run-real-preload', 40, 12))
      client.dispose()
    } finally {
      preload.dispose()
      for (const socket of sockets) socket.close()
      terminalServer.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
