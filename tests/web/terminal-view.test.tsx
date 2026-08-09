// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { TerminalView } from '../../web/src/terminal/TerminalView.js'

let latestCustomKeyHandler: ((event: KeyboardEvent) => boolean) | undefined
let latestOnBinaryHandler: ((chunk: string) => void) | undefined
let latestOnDataHandler: ((chunk: string) => void) | undefined
let terminalMouseReport = '\x1b[M !!'
let terminalWrites: string[] = []
let terminalLoadEvents: string[] = []
let terminalBaseY = 0
let terminalBufferType: 'alternate' | 'normal' = 'normal'
let terminalMouseTrackingMode: 'any' | 'drag' | 'none' | 'vt200' | 'x10' = 'none'
let terminalApplicationCursorKeysMode = false
let terminalDisposeCount = 0
let terminalFocusCount = 0
let terminalOpenCount = 0
let terminalResetCount = 0
let terminalResizeCalls: Array<{ cols: number; rows: number }> = []
let terminalScrollLines: number[] = []
let terminalScrollToBottomCount = 0
let terminalViewportY = 0
let terminalWriteCallbacks: Array<() => void> = []
let terminalWriteCompletesImmediately = true
let nextFitSize: { cols: number; rows: number } | null = null
let fitCount = 0
let websocketCloseCount = 0

class MockWebSocket {
  static instances: MockWebSocket[] = []

  readonly OPEN = 1
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  readyState = 0
  sent: Array<string | Uint8Array> = []

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
    terminalLoadEvents.push('websocket')
    queueMicrotask(() => {
      this.readyState = this.OPEN
      this.onopen?.()
    })
  }

  close() {
    this.readyState = 3
    websocketCloseCount += 1
    this.onclose?.(new CloseEvent('close'))
  }

  send(payload: string | Uint8Array) {
    if (this.readyState !== this.OPEN) return
    this.sent.push(payload)
  }
}

const getRestoreRequest = (socket: MockWebSocket | undefined) =>
  socket?.sent
    .map((payload) => JSON.parse(String(payload)) as Record<string, unknown>)
    .find((message) => message.type === 'restore_request')

const sendRequestedRestore = async (
  socket: MockWebSocket | undefined,
  input: { cols?: number; rows?: number; sizeOwner?: Record<string, unknown>; snapshot: string }
) => {
  const request = await waitFor(() => {
    const restoreRequest = getRestoreRequest(socket)
    expect(restoreRequest).toBeDefined()
    return restoreRequest
  })
  socket?.onmessage?.({
    data: JSON.stringify({
      cols: input.cols ?? request?.cols,
      request_id: request?.request_id,
      rows: input.rows ?? request?.rows,
      ...(input.sizeOwner ? { sizeOwner: input.sizeOwner } : {}),
      snapshot: input.snapshot,
      type: 'restore',
    }),
  })
  return request
}

class MockResizeObserver {
  static instances: MockResizeObserver[] = []

  constructor(readonly callback: () => void) {
    MockResizeObserver.instances.push(this)
  }

  disconnect() {}
  observe() {}
  trigger() {
    this.callback()
  }
}

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 132
    rows = 43
    private customWheelHandler: ((event: WheelEvent) => boolean) | undefined
    unicode = { activeVersion: '' }
    get buffer() {
      return {
        active: { baseY: terminalBaseY, type: terminalBufferType, viewportY: terminalViewportY },
      }
    }
    get modes() {
      return {
        applicationCursorKeysMode: terminalApplicationCursorKeysMode,
        mouseTrackingMode: terminalMouseTrackingMode,
      }
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      latestCustomKeyHandler = handler
    }
    attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) {
      this.customWheelHandler = handler
    }
    loadAddon(addon: { activate?: (terminal: unknown) => void; addonName?: string }) {
      terminalLoadEvents.push(addon.addonName ?? 'unknown')
      addon.activate?.(this)
    }
    onBinary(handler: (chunk: string) => void) {
      latestOnBinaryHandler = handler
      return { dispose() {} }
    }
    onData(handler: (chunk: string) => void) {
      latestOnDataHandler = handler
      return { dispose() {} }
    }
    focus() {
      terminalFocusCount += 1
    }
    open(element: HTMLElement) {
      terminalLoadEvents.push('open')
      terminalOpenCount += 1
      const textarea = document.createElement('textarea')
      textarea.className = 'xterm-helper-textarea'
      element.appendChild(textarea)
      let isComposing = false
      let compositionStartLength = 0
      textarea.addEventListener('compositionstart', () => {
        isComposing = true
        compositionStartLength = textarea.value.length
      })
      textarea.addEventListener('compositionend', () => {
        isComposing = false
        setTimeout(() => {
          const text = textarea.value.substring(compositionStartLength)
          if (text) latestOnDataHandler?.(text)
        }, 0)
      })
      textarea.addEventListener('input', () => {
        if (isComposing) return
        if (!textarea.value) return
        latestOnDataHandler?.(textarea.value)
      })
      element.addEventListener('wheel', (event) => {
        if (this.customWheelHandler?.(event) === false) {
          event.preventDefault()
          event.stopPropagation()
        }
      })
      element.addEventListener('mousedown', () => {
        latestOnBinaryHandler?.(terminalMouseReport)
      })
    }
    reset() {
      terminalResetCount += 1
      terminalWrites = []
    }
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
      terminalResizeCalls.push({ cols, rows })
    }
    scrollLines(lines: number) {
      terminalScrollLines.push(lines)
    }
    scrollToBottom() {
      terminalScrollToBottomCount += 1
    }
    write(chunk?: string, callback?: () => void) {
      if (chunk !== undefined) terminalWrites.push(chunk)
      if (!callback) return
      if (terminalWriteCompletesImmediately) callback()
      else terminalWriteCallbacks.push(callback)
    }
    dispose() {
      terminalDisposeCount += 1
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    addonName = 'fit'
    private terminal: { resize: (cols: number, rows: number) => void } | undefined
    activate(terminal: { resize: (cols: number, rows: number) => void }) {
      this.terminal = terminal
    }
    fit() {
      fitCount += 1
      if (nextFitSize) this.terminal?.resize(nextFitSize.cols, nextFitSize.rows)
    }
    dispose() {}
  },
}))

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {
    addonName = 'unicode11'
  },
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    addonName = 'webgl'
    onContextLoss() {}
    dispose() {}
  },
}))

vi.mock('@xterm/addon-clipboard', () => ({
  ClipboardAddon: class {
    addonName = 'clipboard'
  },
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    addonName = 'webLinks'
  },
}))

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  MockWebSocket.instances = []
  MockResizeObserver.instances = []
  latestCustomKeyHandler = undefined
  latestOnBinaryHandler = undefined
  latestOnDataHandler = undefined
  terminalMouseReport = '\x1b[M !!'
  terminalWrites = []
  terminalLoadEvents = []
  terminalApplicationCursorKeysMode = false
  terminalBaseY = 0
  terminalBufferType = 'normal'
  terminalDisposeCount = 0
  terminalFocusCount = 0
  terminalMouseTrackingMode = 'none'
  terminalOpenCount = 0
  terminalResetCount = 0
  terminalResizeCalls = []
  terminalScrollLines = []
  terminalScrollToBottomCount = 0
  terminalViewportY = 0
  terminalWriteCallbacks = []
  terminalWriteCompletesImmediately = true
  nextFitSize = null
  fitCount = 0
  websocketCloseCount = 0
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () {
    if (this.dataset.testZeroSize === 'true') return 0
    return Number(this.dataset.testClientWidth ?? 800)
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () {
    if (this.dataset.testZeroSize === 'true') return 0
    return Number(this.dataset.testClientHeight ?? 420)
  })
})

const addPortalSlot = (runId: string) => {
  const slot = document.createElement('div')
  slot.id = `orch-pty-${runId}`
  document.body.appendChild(slot)
  return slot
}

const addWorkerPortalSlot = (runId: string) => {
  const slot = document.createElement('div')
  slot.id = `worker-pty-${runId}`
  document.body.appendChild(slot)
  return slot
}

const addShellPortalSlot = (runId: string) => {
  const slot = document.createElement('div')
  slot.id = `shell-pty-${runId}`
  document.body.appendChild(slot)
  return slot
}

const binaryInput = (chunk: string) =>
  Uint8Array.from(chunk, (character) => character.charCodeAt(0) & 0xff)

describe('TerminalView', () => {
  test('opens io and control sockets for the provided run id', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-123')

    render(<TerminalView runId="run-123" title="Alice" />)

    await waitFor(() => {
      const urls = MockWebSocket.instances.map((socket) => new URL(socket.url))
      expect(urls.map((url) => url.pathname)).toEqual([
        '/ws/terminal/run-123/io',
        '/ws/terminal/run-123/control',
      ])
      expect(urls[0]?.searchParams.get('clientId')).toBeTruthy()
      expect(urls[1]?.searchParams.get('clientId')).toBe(urls[0]?.searchParams.get('clientId'))
      expect(urls[0]?.searchParams.get('cols')).toBe('132')
      expect(urls[0]?.searchParams.get('rows')).toBe('43')
    })
  })

  test('uses the provided initial size when opening terminal sockets', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addWorkerPortalSlot('run-mobile-size')

    render(
      <TerminalView
        initialSize={{ cols: 72, rows: 14 }}
        runId="run-mobile-size"
        title="Mobile Agent"
      />
    )

    await waitFor(() => {
      const urls = MockWebSocket.instances.map((socket) => new URL(socket.url))
      expect(urls.map((url) => url.pathname)).toEqual([
        '/ws/terminal/run-mobile-size/io',
        '/ws/terminal/run-mobile-size/control',
      ])
      expect(urls[0]?.searchParams.get('cols')).toBe('72')
      expect(urls[0]?.searchParams.get('rows')).toBe('14')
      expect(urls[1]?.searchParams.get('cols')).toBe('72')
      expect(urls[1]?.searchParams.get('rows')).toBe('14')
    })
  })

  test('does not propagate resize events when disabled for mobile terminal views', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
    addWorkerPortalSlot('run-mobile-no-resize')

    render(
      <TerminalView
        initialSize={{ cols: 72, rows: 14 }}
        propagateResize={false}
        runId="run-mobile-no-resize"
        title="Mobile Agent"
      />
    )

    const controlSocket = await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(MockWebSocket.instances[1]?.readyState).toBe(1)
      return MockWebSocket.instances[1]
    })
    await new Promise((resolve) => window.setTimeout(resolve, 150))

    const urls = MockWebSocket.instances.map((socket) => new URL(socket.url))
    expect(urls[0]?.searchParams.get('cols')).toBe('72')
    expect(urls[0]?.searchParams.get('rows')).toBe('14')
    expect(urls[1]?.searchParams.get('cols')).toBe('72')
    expect(urls[1]?.searchParams.get('rows')).toBe('14')

    window.dispatchEvent(new Event('resize'))
    MockResizeObserver.instances[0]?.trigger()
    await new Promise((resolve) => window.setTimeout(resolve, 75))

    expect(
      controlSocket?.sent
        .map((payload) => JSON.parse(String(payload)))
        .filter((message) => message.type === 'resize')
    ).toEqual([])
  })

  test('refits the local mobile terminal without sending resize messages when propagation is disabled', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
    addWorkerPortalSlot('run-mobile-no-fit')

    render(
      <TerminalView
        initialSize={{ cols: 72, rows: 14 }}
        propagateResize={false}
        runId="run-mobile-no-fit"
        title="Mobile Agent"
      />
    )

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(MockResizeObserver.instances).toHaveLength(1)
    })
    const fitBeforeResize = fitCount

    window.dispatchEvent(new Event('resize'))
    MockResizeObserver.instances[0]?.trigger()
    await new Promise((resolve) => window.setTimeout(resolve, 75))

    expect(fitCount).toBeGreaterThan(fitBeforeResize)
    expect(
      MockWebSocket.instances[1]?.sent
        .map((payload) => JSON.parse(String(payload)))
        .filter((message) => message.type === 'resize')
    ).toEqual([])
  })

  test('can mirror the desktop terminal size without fitting or propagating resize', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
    addWorkerPortalSlot('run-mobile-mirror')

    render(
      <TerminalView
        fitToContainer={false}
        propagateResize={false}
        runId="run-mobile-mirror"
        title="Mobile Agent"
      />
    )

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(MockResizeObserver.instances).toHaveLength(1)
    })
    expect(terminalResizeCalls).toContainEqual({ cols: 120, rows: 40 })
    const fitBeforeResize = fitCount
    const controlSocket = MockWebSocket.instances[1]

    window.dispatchEvent(new Event('resize'))
    MockResizeObserver.instances[0]?.trigger()
    await new Promise((resolve) => window.setTimeout(resolve, 75))

    expect(fitCount).toBe(fitBeforeResize)
    expect(
      controlSocket?.sent
        .map((payload) => JSON.parse(String(payload)))
        .filter((message) => message.type === 'resize')
    ).toEqual([])

    controlSocket?.onmessage?.({
      data: JSON.stringify({
        cols: 128,
        rows: 42,
        snapshot: 'desktop-sized-history',
        type: 'restore',
      }),
    })

    expect(terminalResizeCalls).toContainEqual({ cols: 128, rows: 42 })
    expect(terminalWrites).toEqual(['desktop-sized-history'])
  })

  test('hides the desktop terminal while mobile owns the PTY and can reclaim it', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-mobile-owned')

    render(<TerminalView runId="run-mobile-owned" title="Alice" />)

    const controlSocket = await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
      return MockWebSocket.instances[1]
    })

    controlSocket?.onmessage?.({
      data: JSON.stringify({
        cols: 42,
        rows: 14,
        sizeOwner: {
          acquiredAt: Date.now(),
          clientId: 'mobile-client',
          mode: 'mobile_takeover',
          restoreOnRelease: true,
        },
        snapshot: 'mobile-owned-history',
        type: 'restore',
      }),
    })

    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="terminal-mobile-takeover-run-mobile-owned"]')
      ).not.toBeNull()
    })
    expect(
      document.querySelector<HTMLElement>('[data-testid="terminal-run-mobile-owned"]')?.style
        .visibility
    ).toBe('hidden')
    expect(terminalWrites).toContain('mobile-owned-history')

    fireEvent.click(
      document.querySelector(
        '[data-testid="terminal-mobile-takeover-run-mobile-owned"] button'
      ) as HTMLButtonElement
    )

    expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual(
      expect.objectContaining({
        cols: 42,
        rows: 14,
        type: 'takeover_reclaim',
      })
    )
  })

  test('hides an already visible desktop terminal when mobile takeover is announced later', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-late-mobile-takeover')

    render(<TerminalView runId="run-late-mobile-takeover" title="Alice" />)

    const controlSocket = await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
      return MockWebSocket.instances[1]
    })

    controlSocket?.onmessage?.({
      data: JSON.stringify({
        cols: 120,
        rows: 40,
        snapshot: 'desktop-visible-history',
        type: 'restore',
      }),
    })

    await waitFor(() => {
      expect(terminalWrites).toContain('desktop-visible-history')
      expect(
        document.querySelector('[data-testid="terminal-mobile-takeover-run-late-mobile-takeover"]')
      ).toBeNull()
    })

    controlSocket?.onmessage?.({
      data: JSON.stringify({
        cols: 42,
        mode: 'takeover',
        ownerClientId: 'phone-client',
        rows: 16,
        type: 'size_owner_changed',
      }),
    })

    await waitFor(() => {
      expect(document.body.textContent).toContain('手机正在接管终端')
      expect(
        document.querySelector('[data-testid="terminal-mobile-takeover-run-late-mobile-takeover"]')
      ).not.toBeNull()
    })
    expect(
      document.querySelector<HTMLElement>('[data-testid="terminal-run-late-mobile-takeover"]')
        ?.style.visibility
    ).toBe('hidden')
    MockWebSocket.instances[0]?.onmessage?.({ data: 'live-after-mobile-takeover' })
    expect(terminalWrites).toContain('live-after-mobile-takeover')
  })

  test('hides the mobile takeover terminal while desktop owns the PTY and can request takeover again', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-desktop-owned')

    render(<TerminalView runId="run-desktop-owned" title="Alice" viewerMode="takeover" />)

    const controlSocket = await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
      return MockWebSocket.instances[1]
    })

    await sendRequestedRestore(controlSocket, {
      sizeOwner: {
        acquiredAt: Date.now(),
        clientId: 'desktop-client',
        mode: 'desktop',
        restoreOnRelease: true,
      },
      snapshot: 'desktop-owned-history',
    })

    await waitFor(() => {
      expect(document.body.textContent).toContain('电脑正在接管终端')
      expect(document.body.textContent).toContain('手机重新接管')
    })
    expect(
      document.querySelector<HTMLElement>('[data-testid="terminal-run-desktop-owned"]')?.style
        .visibility
    ).toBe('hidden')
    expect(terminalWrites).toContain('desktop-owned-history')
    MockWebSocket.instances[0]?.onmessage?.({ data: 'live-after-desktop-takeover' })
    expect(terminalWrites).toContain('live-after-desktop-takeover')

    fireEvent.click(
      document.querySelector(
        '[data-testid="terminal-mobile-takeover-run-desktop-owned"] button'
      ) as HTMLButtonElement
    )

    expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual(
      expect.objectContaining({
        cols: 132,
        restore_on_release: true,
        rows: 43,
        type: 'takeover_request',
      })
    )
  })

  test('sends a heartbeat after mobile takeover is granted', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-takeover-heartbeat')

    render(
      <TerminalView
        autoTakeover
        runId="run-takeover-heartbeat"
        title="Alice"
        viewerMode="takeover"
      />
    )

    const controlSocket = await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
      return MockWebSocket.instances[1]
    })

    controlSocket?.onmessage?.({
      data: JSON.stringify({
        cols: 42,
        rows: 14,
        type: 'takeover_granted',
      }),
    })

    await waitFor(() => {
      expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual(
        expect.objectContaining({
          type: 'takeover_heartbeat',
        })
      )
    })
  })

  test('fits and propagates resize while mobile takeover owns the terminal', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
    addPortalSlot('run-takeover-fit-resize')

    render(
      <TerminalView
        autoTakeover
        runId="run-takeover-fit-resize"
        title="Mobile Agent"
        viewerMode="takeover"
      />
    )

    const controlSocket = await waitFor(() => {
      const socket = MockWebSocket.instances[1]
      expect(socket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual(
        expect.objectContaining({
          cols: 132,
          rows: 43,
          type: 'restore_request',
        })
      )
      expect(
        socket?.sent
          .map((payload) => JSON.parse(String(payload)))
          .some((message) => message.type === 'takeover_request')
      ).toBe(false)
      return socket
    })

    await sendRequestedRestore(controlSocket, { snapshot: 'phone-sized-history' })
    await waitFor(() => {
      expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual(
        expect.objectContaining({ cols: 132, rows: 43, type: 'takeover_request' })
      )
    })

    nextFitSize = { cols: 72, rows: 26 }
    MockResizeObserver.instances[0]?.trigger()

    await waitFor(() => {
      expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual(
        expect.objectContaining({
          cols: 72,
          rows: 26,
          type: 'resize',
        })
      )
    })
  })

  test('restores a mobile takeover terminal at the requested phone size', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
    nextFitSize = { cols: 72, rows: 26 }
    addPortalSlot('run-takeover-stale-restore')

    render(
      <TerminalView
        autoTakeover
        runId="run-takeover-stale-restore"
        title="Mobile Agent"
        viewerMode="takeover"
      />
    )

    const controlSocket = await waitFor(() => {
      const socket = MockWebSocket.instances[1]
      expect(socket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual(
        expect.objectContaining({
          cols: 72,
          rows: 26,
          type: 'restore_request',
        })
      )
      return socket
    })

    await new Promise((resolve) => window.setTimeout(resolve, 160))
    terminalResizeCalls = []

    await sendRequestedRestore(controlSocket, {
      cols: 72,
      rows: 26,
      snapshot: 'phone-sized-history',
    })

    await waitFor(() => {
      expect(terminalWrites).toContain('phone-sized-history')
    })
    await new Promise((resolve) => window.setTimeout(resolve, 160))

    expect(terminalResizeCalls.at(-1)).toEqual({ cols: 72, rows: 26 })
  })

  test('shows a clear error when terminal takeover is denied', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-takeover-denied')

    render(
      <TerminalView autoTakeover runId="run-takeover-denied" title="Alice" viewerMode="takeover" />
    )

    const controlSocket = await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
      return MockWebSocket.instances[1]
    })

    controlSocket?.onmessage?.({
      data: JSON.stringify({
        reason: 'Another phone already owns this terminal',
        type: 'takeover_denied',
      }),
    })

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        '终端接管失败：Another phone already owns this terminal'
      )
    })
  })

  test('sends the initial fit resize after the control socket opens', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-resize')

    render(<TerminalView runId="run-resize" title="Alice" />)

    await waitFor(() => {
      const controlSocket = MockWebSocket.instances[1]
      expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual(
        expect.objectContaining({
          type: 'resize',
          cols: 132,
          rows: 43,
        })
      )
    })
  })

  test('loads critical addons before connecting sockets and link addon after open', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-staged-addons')

    render(<TerminalView runId="run-staged-addons" title="Alice" />)

    await waitFor(() => {
      expect(terminalLoadEvents).toContain('open')
    })
    const openIndex = terminalLoadEvents.indexOf('open')
    expect(terminalLoadEvents.indexOf('fit')).toBeGreaterThanOrEqual(0)
    expect(terminalLoadEvents.indexOf('fit')).toBeLessThan(openIndex)
    expect(terminalLoadEvents.indexOf('unicode11')).toBeGreaterThanOrEqual(0)
    expect(terminalLoadEvents.indexOf('unicode11')).toBeLessThan(openIndex)
    expect(terminalLoadEvents.indexOf('clipboard')).toBeGreaterThanOrEqual(0)
    expect(terminalLoadEvents.indexOf('clipboard')).toBeLessThan(openIndex)

    await waitFor(() => {
      expect(terminalLoadEvents).toContain('websocket')
    })
    const websocketIndex = terminalLoadEvents.indexOf('websocket')
    expect(terminalLoadEvents.indexOf('clipboard')).toBeLessThan(websocketIndex)

    await waitFor(() => {
      expect(terminalLoadEvents).toContain('webLinks')
    })
    expect(terminalLoadEvents.indexOf('webLinks')).toBeGreaterThan(openIndex)
    expect(terminalLoadEvents).not.toContain('webgl')
  })

  test('resizes again when the terminal container changes size', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
    addPortalSlot('run-observer')

    render(<TerminalView runId="run-observer" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances[1]?.sent.length ?? 0).toBeGreaterThan(0)
    })

    nextFitSize = { cols: 150, rows: 50 }
    const terminal = document.querySelector('[data-testid="terminal-run-observer"]') as HTMLElement
    terminal.dataset.testClientWidth = '960'
    terminal.dataset.testClientHeight = '500'
    const sentBeforeResize = MockWebSocket.instances[1]?.sent.length ?? 0
    MockResizeObserver.instances[0]?.trigger()

    await waitFor(() => {
      expect(MockWebSocket.instances[1]?.sent.length ?? 0).toBeGreaterThan(sentBeforeResize)
    })
  })

  test('does not resend PTY resize when only container pixels change', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
    addPortalSlot('run-pixel-only-resize')

    render(<TerminalView runId="run-pixel-only-resize" title="Alice" />)

    const controlSocket = await waitFor(() => {
      expect(MockWebSocket.instances[1]?.sent.length ?? 0).toBe(1)
      return MockWebSocket.instances[1]
    })

    const terminal = document.querySelector(
      '[data-testid="terminal-run-pixel-only-resize"]'
    ) as HTMLElement
    terminal.dataset.testClientWidth = '960'
    terminal.dataset.testClientHeight = '500'
    MockResizeObserver.instances[0]?.trigger()
    await new Promise((resolve) => window.setTimeout(resolve, 75))

    expect(controlSocket?.sent).toHaveLength(1)
  })

  test('does not resend duplicate resize messages for unchanged visible dimensions', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
    addPortalSlot('run-duplicate-resize')

    render(<TerminalView runId="run-duplicate-resize" title="Alice" />)

    const controlSocket = await waitFor(() => {
      expect(MockWebSocket.instances[1]?.sent.length ?? 0).toBe(1)
      return MockWebSocket.instances[1]
    })

    MockResizeObserver.instances[0]?.trigger()
    window.dispatchEvent(new Event('resize'))
    await new Promise((resolve) => window.setTimeout(resolve, 75))

    expect(controlSocket?.sent).toHaveLength(1)
  })

  test('does not fit or resize the PTY when the visible container has no size', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
    const slot = addPortalSlot('run-zero-size')

    render(<TerminalView runId="run-zero-size" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = slot.querySelector('[data-testid="terminal-run-zero-size"]') as HTMLElement
      expect(node).not.toBeNull()
      return node
    })
    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const controlSocket = MockWebSocket.instances[1]
    await waitFor(() => {
      expect(controlSocket?.sent.length ?? 0).toBeGreaterThan(0)
    })
    const sentBeforeZeroResize = controlSocket?.sent.length ?? 0
    const fitBeforeZeroResize = fitCount

    terminal.dataset.testZeroSize = 'true'
    MockResizeObserver.instances[0]?.trigger()
    window.dispatchEvent(new Event('resize'))
    await new Promise((resolve) => window.setTimeout(resolve, 75))

    expect(fitCount).toBe(fitBeforeZeroResize)
    expect(controlSocket?.sent).toHaveLength(sentBeforeZeroResize)
  })

  test('does not render an inline terminal before a portal slot exists', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)

    render(<TerminalView runId="run-detached" title="Alice" />)

    expect(document.querySelector('[data-testid="terminal-run-detached"]')).toBeNull()
    expect(document.querySelector('section[aria-label="Terminal Alice"]')).toBeNull()
    expect(MockWebSocket.instances).toHaveLength(0)

    const slot = addPortalSlot('run-detached')

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-detached"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    expect(MockWebSocket.instances.map((socket) => new URL(socket.url).pathname)).toEqual([
      '/ws/terminal/run-detached/io',
      '/ws/terminal/run-detached/control',
    ])
  })

  test('observes portal slots without a polling interval when MutationObserver is available', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const setIntervalSpy = vi.spyOn(window, 'setInterval')

    render(<TerminalView runId="run-observed-slot" title="Alice" />)

    expect(setIntervalSpy).not.toHaveBeenCalled()
    setIntervalSpy.mockRestore()
    const slot = addPortalSlot('run-observed-slot')

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-observed-slot"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })
  })

  test('uses the last matching portal slot when duplicate slots exist', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const firstSlot = addWorkerPortalSlot('run-duplicate-slot')
    const secondSlot = addWorkerPortalSlot('run-duplicate-slot')

    render(<TerminalView runId="run-duplicate-slot" title="Alice" />)

    await waitFor(() => {
      expect(firstSlot.querySelector('[data-testid="terminal-run-duplicate-slot"]')).toBeNull()
      expect(secondSlot.querySelector('[data-testid="terminal-run-duplicate-slot"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })
  })

  test('attaches to shell terminal portal slots', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const slot = addShellPortalSlot('run-shell')

    render(<TerminalView runId="run-shell" title="Shell" />)

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-shell"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(new URL(MockWebSocket.instances[0]?.url ?? '').pathname).toBe(
        '/ws/terminal/run-shell/io'
      )
      expect(new URL(MockWebSocket.instances[1]?.url ?? '').pathname).toBe(
        '/ws/terminal/run-shell/control'
      )
    })
  })

  test('keeps the same xterm session alive when the portal slot is recreated', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
    let slot = addPortalSlot('run-stable')

    render(<TerminalView runId="run-stable" title="Alice" />)

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-stable"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(MockResizeObserver.instances).toHaveLength(1)
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances
    const terminal = slot.querySelector('[data-testid="terminal-run-stable"]') as HTMLElement
    nextFitSize = { cols: 150, rows: 50 }
    terminal.dataset.testClientWidth = '960'
    terminal.dataset.testClientHeight = '500'
    const sentBeforeVisibleResize = controlSocket?.sent.length ?? 0
    MockResizeObserver.instances[0]?.trigger()
    await waitFor(() => {
      expect(controlSocket?.sent.length ?? 0).toBeGreaterThan(sentBeforeVisibleResize)
    })

    slot.remove()

    await waitFor(() => {
      expect(document.querySelector('[data-testid="terminal-run-stable"]')).not.toBeNull()
    })
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(websocketCloseCount).toBe(0)
    expect(terminalDisposeCount).toBe(0)
    const sentBeforeHiddenResize = controlSocket?.sent.length ?? 0
    window.dispatchEvent(new Event('resize'))
    MockResizeObserver.instances[0]?.trigger()
    await new Promise((resolve) => window.setTimeout(resolve, 75))
    expect(controlSocket?.sent).toHaveLength(sentBeforeHiddenResize)

    slot = addPortalSlot('run-stable')

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-stable"]')).not.toBeNull()
    })
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(terminalOpenCount).toBe(1)
    expect(terminalDisposeCount).toBe(0)
    const reattachedTerminal = slot.querySelector(
      '[data-testid="terminal-run-stable"]'
    ) as HTMLElement
    nextFitSize = { cols: 160, rows: 55 }
    reattachedTerminal.dataset.testClientWidth = '1040'
    reattachedTerminal.dataset.testClientHeight = '560'
    MockResizeObserver.instances[0]?.trigger()
    await waitFor(() => {
      expect(controlSocket?.sent.length).toBeGreaterThan(sentBeforeHiddenResize)
    })
    const sentBeforeProtocolMessages = controlSocket?.sent.length ?? 0

    controlSocket?.onmessage?.({
      data: JSON.stringify({ type: 'restore', snapshot: 'restored-history' }),
    })
    ioSocket?.onmessage?.({ data: 'live-after-reattach' })
    expect(terminalWrites).toEqual(['restored-history', 'live-after-reattach'])
    const controlMessagesAfterReattach = controlSocket?.sent
      .slice(sentBeforeProtocolMessages)
      .map((payload) => JSON.parse(String(payload)))
    expect(controlMessagesAfterReattach).toEqual([
      { type: 'restore_complete' },
      { type: 'output_ack', bytes: new TextEncoder().encode('live-after-reattach').byteLength },
    ])

    latestOnDataHandler?.('typed-after-reattach')
    expect(ioSocket?.sent).toContain('typed-after-reattach')
    latestCustomKeyHandler?.(
      new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, shiftKey: true })
    )
    expect(ioSocket?.sent).toContain('\u001b[13;2u')
  })

  test('does not reconnect when only the terminal error callback changes', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const slot = addWorkerPortalSlot('run-stable-callback')

    const firstError = vi.fn()
    const secondError = vi.fn()
    const view = render(
      <TerminalView onError={firstError} runId="run-stable-callback" title="Mobile Agent" />
    )

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-stable-callback"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(terminalOpenCount).toBe(1)
    })

    view.rerender(
      <TerminalView onError={secondError} runId="run-stable-callback" title="Mobile Agent" />
    )
    await new Promise((resolve) => window.setTimeout(resolve, 75))

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(terminalOpenCount).toBe(1)
    expect(websocketCloseCount).toBe(0)
    expect(terminalDisposeCount).toBe(0)

    MockWebSocket.instances[1]?.onmessage?.({
      data: JSON.stringify({ type: 'error', message: 'Not found' }),
    })

    expect(firstError).not.toHaveBeenCalled()
    expect(secondError).toHaveBeenCalledWith('Not found')
  })

  test('does not reconnect when connection params are rebuilt with the same values', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const slot = addWorkerPortalSlot('run-stable-params')

    const view = render(
      <TerminalView
        connectionParams={{ desktop_id: 'desktop-a', token: 'token-a' }}
        runId="run-stable-params"
        title="Mobile Agent"
      />
    )

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-stable-params"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(terminalOpenCount).toBe(1)
    })

    view.rerender(
      <TerminalView
        connectionParams={{ token: 'token-a', desktop_id: 'desktop-a' }}
        runId="run-stable-params"
        title="Mobile Agent"
      />
    )
    await new Promise((resolve) => window.setTimeout(resolve, 75))

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(terminalOpenCount).toBe(1)
    expect(websocketCloseCount).toBe(0)
    expect(terminalDisposeCount).toBe(0)
  })

  test('prefixes relay terminal websocket paths with the provided base path', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addWorkerPortalSlot('run-control-relay')

    render(
      <TerminalView
        connectionParams={{
          desktop_id: 'desktop-control',
          token: 'pair-token',
          websocket_base_path: '/control/',
        }}
        runId="run-control-relay"
        title="Control Relay Agent"
      />
    )

    await waitFor(() => {
      const urls = MockWebSocket.instances.map((socket) => new URL(socket.url))
      expect(urls.map((url) => url.pathname)).toEqual([
        '/control/ws/terminal/run-control-relay/io',
        '/control/ws/terminal/run-control-relay/control',
      ])
      expect(urls[0]?.searchParams.get('desktop_id')).toBe('desktop-control')
      expect(urls[0]?.searchParams.get('token')).toBe('pair-token')
      expect(urls[0]?.searchParams.has('websocket_base_path')).toBe(false)
      expect(urls[1]?.searchParams.has('websocket_base_path')).toBe(false)
    })
  })

  test('focuses the terminal helper textarea when the terminal is tapped', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addWorkerPortalSlot('run-mobile-focus')

    render(<TerminalView runId="run-mobile-focus" title="Mobile Agent" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-testid="terminal-run-mobile-focus"]')
      expect(node).not.toBeNull()
      return node
    })

    fireEvent.click(terminal)

    expect(terminalFocusCount).toBe(1)
    expect(document.activeElement).toHaveClass('xterm-helper-textarea')
  })

  test('lets mobile textarea text input flow through xterm and clears stale textarea state', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile Safari/537.36'
    )
    addWorkerPortalSlot('run-mobile-text')

    render(<TerminalView runId="run-mobile-text" title="Mobile Agent" />)

    const textarea = await waitFor(() => {
      const node = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      expect(node).not.toBeNull()
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      return node
    })
    const inputSocket = MockWebSocket.instances[0]

    const textBeforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: 'abc',
      inputType: 'insertText',
    })
    const textAllowed = fireEvent(textarea, textBeforeInput)

    fireEvent(
      textarea,
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'deleteContentBackward',
      })
    )
    fireEvent(
      textarea,
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertLineBreak',
      })
    )

    expect(textAllowed).toBe(false)
    expect(inputSocket?.sent).toEqual(['abc', '\x7f', '\r'])
    expect(textarea).toHaveValue('')
  })

  test('does not turn mobile beforeinput space data into Enter', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile Safari/537.36'
    )
    addWorkerPortalSlot('run-mobile-space')

    render(<TerminalView runId="run-mobile-space" title="Mobile Agent" />)

    const textarea = await waitFor(() => {
      const node = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      expect(node).not.toBeNull()
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      return node
    })
    const inputSocket = MockWebSocket.instances[0]

    const spaceBeforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: ' ',
      inputType: 'insertLineBreak',
    })
    const allowed = fireEvent(textarea, spaceBeforeInput)

    expect(allowed).toBe(false)
    expect(inputSocket?.sent).toEqual([' '])
    expect(textarea).toHaveValue('')
  })

  test('commits Android composition text from the helper textarea when event data is empty', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile Safari/537.36'
    )
    addWorkerPortalSlot('run-mobile-empty-composition-data')

    render(<TerminalView runId="run-mobile-empty-composition-data" title="Mobile Agent" />)

    const textarea = await waitFor(() => {
      const node = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      expect(node).not.toBeNull()
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      return node
    })
    const inputSocket = MockWebSocket.instances[0]

    fireEvent.compositionStart(textarea)
    textarea.value = 'hello'
    fireEvent.compositionEnd(textarea, { data: '' })
    await waitFor(() => {
      expect(inputSocket?.sent).toEqual(['hello'])
    })

    await waitFor(() => {
      expect(textarea).toHaveValue('')
    })
  })

  test('does not send desktop IME preedit text while composition is active', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36'
    )
    addWorkerPortalSlot('run-desktop-ime-preedit')

    render(<TerminalView runId="run-desktop-ime-preedit" title="Desktop Agent" />)

    const textarea = await waitFor(() => {
      const node = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      expect(node).not.toBeNull()
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      return node
    })
    const inputSocket = MockWebSocket.instances[0]

    fireEvent.compositionStart(textarea)
    textarea.value = 'ni'
    fireEvent(
      textarea,
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: 'ni',
        inputType: 'insertCompositionText',
      })
    )
    textarea.value = "ni'hao"
    fireEvent(
      textarea,
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: "'hao",
        inputType: 'insertCompositionText',
      })
    )
    expect(inputSocket?.sent).toEqual([])

    fireEvent.compositionEnd(textarea)
    await waitFor(() => {
      expect(inputSocket?.sent).toEqual(["ni'hao"])
    })
  })

  test('keeps desktop IME preedit blocked even when composition lasts longer than the mobile fallback', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36'
    )
    addWorkerPortalSlot('run-desktop-ime-long-composition')

    render(<TerminalView runId="run-desktop-ime-long-composition" title="Desktop Agent" />)

    const textarea = await waitFor(() => {
      const node = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      expect(node).not.toBeNull()
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      return node
    })
    const inputSocket = MockWebSocket.instances[0]

    vi.useFakeTimers()
    fireEvent.compositionStart(textarea)
    textarea.value = 'ni'
    fireEvent(
      textarea,
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: 'ni',
        inputType: 'insertCompositionText',
      })
    )
    vi.advanceTimersByTime(1500)

    textarea.value = 'nihao'
    fireEvent(
      textarea,
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: 'hao',
        inputType: 'insertCompositionText',
      })
    )

    expect(inputSocket?.sent).toEqual([])

    fireEvent.compositionEnd(textarea)
    await vi.runOnlyPendingTimersAsync()
    expect(inputSocket?.sent).toEqual(['nihao'])
  })

  test('routes Android mobile proxy text input directly to the terminal stream', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile Safari/537.36'
    )
    addWorkerPortalSlot('run-mobile-proxy-text')

    render(<TerminalView runId="run-mobile-proxy-text" title="Mobile Agent" />)

    const proxy = await waitFor(() => {
      const node = document.querySelector<HTMLTextAreaElement>(
        '[data-testid="terminal-mobile-input-proxy-run-mobile-proxy-text"]'
      )
      expect(node).not.toBeNull()
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      return node
    })
    const inputSocket = MockWebSocket.instances[0]

    fireEvent(
      proxy,
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: 'abc',
        inputType: 'insertText',
      })
    )
    fireEvent(
      proxy,
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: '123',
        inputType: 'insertText',
      })
    )

    expect(inputSocket?.sent).toEqual(['abc', '123'])
    expect(proxy).toHaveValue('')
  })

  test('routes Android mobile proxy beforeinput data directly even when the input type is a line break', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile Safari/537.36'
    )
    addWorkerPortalSlot('run-mobile-proxy-space')

    render(<TerminalView runId="run-mobile-proxy-space" title="Mobile Agent" />)

    const proxy = await waitFor(() => {
      const node = document.querySelector<HTMLTextAreaElement>(
        '[data-testid="terminal-mobile-input-proxy-run-mobile-proxy-space"]'
      )
      expect(node).not.toBeNull()
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      return node
    })
    const inputSocket = MockWebSocket.instances[0]

    const allowed = fireEvent(
      proxy,
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: ' ',
        inputType: 'insertLineBreak',
      })
    )

    expect(allowed).toBe(false)
    expect(inputSocket?.sent).toEqual([' '])
    expect(proxy).toHaveValue('')
  })

  test('routes Android mobile proxy composition commits and editing keys to the terminal stream', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile Safari/537.36'
    )
    addWorkerPortalSlot('run-mobile-proxy-composition')

    render(<TerminalView runId="run-mobile-proxy-composition" title="Mobile Agent" />)

    const proxy = await waitFor(() => {
      const node = document.querySelector<HTMLTextAreaElement>(
        '[data-testid="terminal-mobile-input-proxy-run-mobile-proxy-composition"]'
      )
      expect(node).not.toBeNull()
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      return node
    })
    const inputSocket = MockWebSocket.instances[0]

    fireEvent.compositionStart(proxy)
    proxy.value = '你好'
    fireEvent.compositionEnd(proxy)
    await waitFor(() => {
      expect(inputSocket?.sent).toEqual(['你好'])
    })

    fireEvent(
      proxy,
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'deleteContentBackward',
      })
    )
    fireEvent(
      proxy,
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertLineBreak',
      })
    )

    expect(inputSocket?.sent).toEqual(['你好', '\x7f', '\r'])
    expect(proxy).toHaveValue('')
  })

  test('releases stuck Android composition state so later text input can flow through xterm', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile Safari/537.36'
    )
    addWorkerPortalSlot('run-mobile-stuck-composition')

    render(<TerminalView runId="run-mobile-stuck-composition" title="Mobile Agent" />)

    const textarea = await waitFor(() => {
      const node = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      expect(node).not.toBeNull()
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      return node
    })
    const inputSocket = MockWebSocket.instances[0]

    vi.useFakeTimers()
    fireEvent.compositionStart(textarea)
    vi.advanceTimersByTime(1500)
    fireEvent(
      textarea,
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: 'next',
        inputType: 'insertText',
      })
    )

    expect(inputSocket?.sent).toEqual(['next'])
  })

  test('reconnects both terminal sockets when either socket closes unexpectedly', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-reconnect')

    render(<TerminalView runId="run-reconnect" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const firstIoSocket = MockWebSocket.instances[0]
    const firstControlSocket = MockWebSocket.instances[1]

    firstControlSocket?.onmessage?.({
      data: JSON.stringify({ snapshot: 'before-disconnect', type: 'restore' }),
    })
    expect(terminalWrites).toEqual(['before-disconnect'])

    firstIoSocket?.onclose?.()

    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="terminal-connection-status-run-reconnect"]')
      ).not.toBeNull()
    })

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(4)
    })

    const secondIoSocket = MockWebSocket.instances[2]
    const secondControlSocket = MockWebSocket.instances[3]
    secondIoSocket?.onmessage?.({ data: 'live-during-reconnect' })
    secondControlSocket?.onmessage?.({
      data: JSON.stringify({ snapshot: 'after-reconnect', type: 'restore' }),
    })

    expect(terminalWrites).toEqual(['after-reconnect', 'live-during-reconnect'])
    expect(secondControlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual({
      type: 'output_ack',
      bytes: new TextEncoder().encode('live-during-reconnect').byteLength,
    })
    expect(MockWebSocket.instances.slice(2).map((socket) => new URL(socket.url).pathname)).toEqual([
      '/ws/terminal/run-reconnect/io',
      '/ws/terminal/run-reconnect/control',
    ])
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="terminal-connection-status-run-reconnect"]')
      ).toBeNull()
    })
  })

  test('shows websocket close reasons from relay terminal proxy failures', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-relay-close-reason')

    render(<TerminalView runId="run-relay-close-reason" title="Alice" viewerMode="takeover" />)

    const controlSocket = await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
      return MockWebSocket.instances[1]
    })

    controlSocket?.onmessage?.({
      data: JSON.stringify({ snapshot: 'before-close', type: 'restore' }),
    })

    controlSocket?.onclose?.(
      new CloseEvent('close', { code: 1011, reason: 'Desktop peer disconnected' })
    )

    await waitFor(() => {
      expect(document.body.textContent).toContain('Desktop peer disconnected')
    })
  })

  test('decodes relay terminal control and output binary frames', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-relay-blob-frames')

    render(<TerminalView runId="run-relay-blob-frames" title="Alice" viewerMode="takeover" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const ioSocket = MockWebSocket.instances[0]
    const controlSocket = MockWebSocket.instances[1]
    expect(ioSocket?.binaryType).toBe('arraybuffer')
    expect(controlSocket?.binaryType).toBe('arraybuffer')
    const binaryFrame = (text: string) => new TextEncoder().encode(text).buffer

    const restoreRequest = await waitFor(() => {
      const request = getRestoreRequest(controlSocket)
      expect(request).toBeDefined()
      return request
    })
    controlSocket?.onmessage?.({
      data: binaryFrame(
        JSON.stringify({
          request_id: restoreRequest?.request_id,
          snapshot: 'binary-restore',
          type: 'restore',
        })
      ),
    } as never)

    await waitFor(() => {
      expect(terminalWrites).toEqual(['binary-restore'])
    })

    ioSocket?.onmessage?.({ data: binaryFrame('binary-live-output') } as never)

    await waitFor(() => {
      expect(terminalWrites).toEqual(['binary-restore', 'binary-live-output'])
    })
  })

  test('shows a visible error when the terminal restore never arrives', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-restore-timeout')

    render(<TerminalView runId="run-restore-timeout" title="Alice" viewerMode="takeover" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })

    await waitFor(
      () => {
        expect(document.body.textContent).toContain('等待终端历史恢复超时')
      },
      { timeout: 9_000 }
    )
  })

  test('disposes the terminal session when TerminalView unmounts', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const slot = addPortalSlot('run-unmount')

    const view = render(
      <TerminalView autoTakeover runId="run-unmount" title="Alice" viewerMode="takeover" />
    )

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-unmount"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })

    slot.remove()

    await waitFor(() => {
      expect(document.querySelector('[data-terminal-host-run-id="run-unmount"]')).not.toBeNull()
    })

    view.unmount()

    expect(document.querySelector('[data-terminal-host-run-id="run-unmount"]')).toBeNull()
    expect(document.getElementById('hive-terminal-parking-lot')).toBeNull()
    expect(MockWebSocket.instances[1]?.sent).toContain(JSON.stringify({ type: 'takeover_release' }))
    expect(websocketCloseCount).toBe(2)
    expect(terminalDisposeCount).toBe(1)
  })

  test('disposes a parked terminal when no portal slot returns', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const slot = addPortalSlot('run-abandoned')

    render(<TerminalView runId="run-abandoned" title="Alice" />)

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-abandoned"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })

    slot.remove()

    await waitFor(() => {
      expect(document.querySelector('[data-terminal-host-run-id="run-abandoned"]')).not.toBeNull()
    })

    await waitFor(
      () => {
        expect(document.querySelector('[data-terminal-host-run-id="run-abandoned"]')).toBeNull()
        expect(document.getElementById('hive-terminal-parking-lot')).toBeNull()
        expect(websocketCloseCount).toBe(2)
        expect(terminalDisposeCount).toBe(1)
      },
      { timeout: 1500 }
    )
  })

  test('buffers live output until the restore snapshot is written', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-restore-order')

    render(<TerminalView runId="run-restore-order" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances
    ioSocket?.onmessage?.({ data: 'live-after-attach' })

    expect(terminalWrites).toEqual([])

    controlSocket?.onmessage?.({
      data: JSON.stringify({ type: 'restore', snapshot: 'restored-history' }),
    })

    expect(terminalWrites).toEqual(['restored-history', 'live-after-attach'])
    expect(terminalScrollToBottomCount).toBeGreaterThanOrEqual(3)
    expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual({
      type: 'restore_complete',
    })
    expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual({
      type: 'output_ack',
      bytes: new TextEncoder().encode('live-after-attach').byteLength,
    })
  })

  test('flushes live output immediately after an empty restore snapshot', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalWriteCompletesImmediately = false
    addPortalSlot('run-empty-restore')

    render(<TerminalView runId="run-empty-restore" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances

    controlSocket?.onmessage?.({
      data: JSON.stringify({ type: 'restore', snapshot: '' }),
    })
    ioSocket?.onmessage?.({ data: 'live-after-empty-restore' })

    expect(terminalWrites).toEqual(['live-after-empty-restore'])
    expect(terminalWriteCallbacks).toHaveLength(1)
    expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual({
      type: 'restore_complete',
    })
    terminalWriteCallbacks.shift()?.()
    expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual({
      type: 'output_ack',
      bytes: new TextEncoder().encode('live-after-empty-restore').byteLength,
    })
  })

  test('does not interleave live output or acknowledgements while restore is still writing', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalWriteCompletesImmediately = false
    addPortalSlot('run-restore-pending')

    render(<TerminalView runId="run-restore-pending" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances

    controlSocket?.onmessage?.({
      data: JSON.stringify({ type: 'restore', snapshot: 'restored-history' }),
    })
    ioSocket?.onmessage?.({ data: 'live-during-restore' })

    expect(terminalWrites).toEqual(['restored-history'])
    expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).not.toContainEqual({
      type: 'restore_complete',
    })
    expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).not.toContainEqual({
      type: 'output_ack',
      bytes: new TextEncoder().encode('live-during-restore').byteLength,
    })

    terminalWriteCallbacks.shift()?.()

    expect(terminalWrites).toEqual(['restored-history', 'live-during-restore'])
    expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual({
      type: 'restore_complete',
    })
    expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).not.toContainEqual({
      type: 'output_ack',
      bytes: new TextEncoder().encode('live-during-restore').byteLength,
    })

    terminalWriteCallbacks.shift()?.()

    expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual({
      type: 'output_ack',
      bytes: new TextEncoder().encode('live-during-restore').byteLength,
    })
  })

  test('does not force-scroll live output when the viewer is reading scrollback', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-scrollback-sticky')

    render(<TerminalView runId="run-scrollback-sticky" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances

    controlSocket?.onmessage?.({
      data: JSON.stringify({ type: 'restore', snapshot: 'restored-history' }),
    })
    const scrollCountAfterRestore = terminalScrollToBottomCount
    terminalBaseY = 50
    terminalViewportY = 10

    ioSocket?.onmessage?.({ data: 'new-live-output' })

    expect(terminalWrites).toEqual(['restored-history', 'new-live-output'])
    expect(terminalScrollToBottomCount).toBe(scrollCountAfterRestore)
  })

  test('keeps live output sticky when the viewer is near the bottom of scrollback', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-scrollback-bottom-sticky')

    render(<TerminalView runId="run-scrollback-bottom-sticky" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances

    controlSocket?.onmessage?.({
      data: JSON.stringify({ type: 'restore', snapshot: 'restored-history' }),
    })
    const scrollCountAfterRestore = terminalScrollToBottomCount
    terminalBaseY = 50
    terminalViewportY = 49

    ioSocket?.onmessage?.({ data: 'new-live-output' })

    expect(terminalWrites).toEqual(['restored-history', 'new-live-output'])
    expect(terminalScrollToBottomCount).toBe(scrollCountAfterRestore + 1)
  })

  test('replaces terminal contents instead of appending when restore is received again', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-repeat-restore')

    render(<TerminalView runId="run-repeat-restore" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const controlSocket = MockWebSocket.instances[1]

    controlSocket?.onmessage?.({
      data: JSON.stringify({ type: 'restore', snapshot: 'first-history' }),
    })
    controlSocket?.onmessage?.({
      data: JSON.stringify({ type: 'restore', snapshot: 'second-history' }),
    })

    expect(terminalResetCount).toBe(2)
    expect(terminalWrites).toEqual(['second-history'])
    expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toEqual(
      expect.arrayContaining([{ type: 'restore_complete' }, { type: 'restore_complete' }])
    )
  })

  test('resizes the local terminal to the restore snapshot size before writing it', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-sized-restore')

    render(<TerminalView runId="run-sized-restore" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const controlSocket = MockWebSocket.instances[1]

    controlSocket?.onmessage?.({
      data: JSON.stringify({
        cols: 120,
        rows: 40,
        snapshot: 'desktop-sized-history',
        type: 'restore',
      }),
    })

    expect(terminalResizeCalls).toContainEqual({ cols: 120, rows: 40 })
    expect(terminalWrites).toEqual(['desktop-sized-history'])
  })

  test('clamps restored local terminal size to the configured minimum', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-clamped-restore')

    render(
      <TerminalView
        minimumSize={{ cols: 48, rows: 16 }}
        runId="run-clamped-restore"
        title="Mobile Agent"
      />
    )

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const controlSocket = MockWebSocket.instances[1]

    controlSocket?.onmessage?.({
      data: JSON.stringify({
        cols: 4,
        rows: 3,
        snapshot: 'tiny-sized-history',
        type: 'restore',
      }),
    })

    expect(terminalResizeCalls).toContainEqual({ cols: 48, rows: 16 })
    expect(terminalWrites).toEqual(['tiny-sized-history'])
  })

  test('maps Shift+Enter to a modified Enter sequence instead of submit Enter', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-shift-enter')

    render(<TerminalView runId="run-shift-enter" title="Alice" />)

    await waitFor(() => {
      expect(latestCustomKeyHandler).toBeDefined()
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
    })

    const keydownHandled = latestCustomKeyHandler?.(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true })
    )
    const keypressHandled = latestCustomKeyHandler?.(
      new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, shiftKey: true })
    )

    expect(keydownHandled).toBe(false)
    expect(keypressHandled).toBe(false)
    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[13;2u'])
  })

  test('uploads pasted desktop images instead of sending ctrl-v to the PTY', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const fetchCalls: Array<{ body?: string; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push({ body: String(init?.body ?? ''), url })
      if (url === '/api/mobile/files') {
        return new Response(
          JSON.stringify({
            created_at: 1,
            id: 'file-image',
            mime_type: 'image/png',
            name: 'desk.png',
            size: 6,
          }),
          { status: 201 }
        )
      }
      if (url === '/api/mobile/actions') {
        return new Response(JSON.stringify({ ok: true }), { status: 202 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    addPortalSlot('run-paste-image')

    render(<TerminalView runId="run-paste-image" title="Alice" workspaceId="workspace-1" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-paste-image"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { files: [new File(['pixels'], 'desk.png', { type: 'image/png' })] },
    })

    terminal.dispatchEvent(pasteEvent)

    await waitFor(() => {
      expect(fetchCalls.map((call) => call.url)).toEqual([
        '/api/mobile/files',
        '/api/mobile/actions',
      ])
    })
    expect(pasteEvent.defaultPrevented).toBe(true)
    const action = JSON.parse(fetchCalls[1]?.body ?? '{}') as {
      kind?: string
      payload?: {
        attachments?: Array<{ file_id?: string; placeholder?: string }>
        input?: string
      }
      target?: { run_id?: string }
      workspace_id?: string
    }
    expect(action.kind).toBe('terminal_input')
    expect(action.workspace_id).toBe('workspace-1')
    expect(action.target).toEqual({ run_id: 'run-paste-image' })
    expect(action.payload?.attachments).toEqual([
      { file_id: 'file-image', placeholder: '[Image #1]' },
    ])
    expect(action.payload?.input).toContain('Desktop image attachment: desk.png')
    expect(action.payload?.input).toContain('Workspace-relative Artifact')
    expect(action.payload?.input).not.toContain('file_id')
    expect(action.payload?.input).not.toContain('.hive/mobile-attachments.json')
    expect(action.payload?.input).not.toContain('local_path')
    expect(action.payload?.input).not.toContain('desk.png'.repeat(20))
    expect(MockWebSocket.instances[0]?.sent).not.toContain('\x16')
  })

  test('intercepts ctrl-v image clipboard before xterm sends paste bytes to the PTY', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const fetchCalls: Array<{ body?: string; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push({ body: String(init?.body ?? ''), url })
      if (url === '/api/mobile/files') {
        return new Response(
          JSON.stringify({
            created_at: 1,
            id: 'clipboard-image',
            mime_type: 'image/png',
            name: 'clipboard-image.png',
            size: 6,
          }),
          { status: 201 }
        )
      }
      if (url === '/api/mobile/actions') {
        return new Response(JSON.stringify({ ok: true }), { status: 202 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        read: vi.fn(async () => [
          {
            getType: vi.fn(async () => new Blob(['pixels'], { type: 'image/png' })),
            types: ['image/png'],
          },
        ]),
      },
    })
    addPortalSlot('run-ctrl-v-image')

    render(<TerminalView runId="run-ctrl-v-image" title="Alice" workspaceId="workspace-1" />)

    await waitFor(() => {
      expect(latestCustomKeyHandler).toBeDefined()
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
    })
    const event = new KeyboardEvent('keydown', { ctrlKey: true, key: 'v' })
    const handled = latestCustomKeyHandler?.(event)

    expect(handled).toBe(false)
    await waitFor(() => {
      expect(fetchCalls.map((call) => call.url)).toEqual([
        '/api/mobile/files',
        '/api/mobile/actions',
      ])
    })
    const action = JSON.parse(fetchCalls[1]?.body ?? '{}') as {
      payload?: {
        attachments?: Array<{ file_id?: string; placeholder?: string }>
        input?: string
      }
    }
    expect(action.payload?.attachments).toEqual([
      { file_id: 'clipboard-image', placeholder: '[Image #1]' },
    ])
    expect(action.payload?.input).toContain('Desktop image attachment: clipboard-image.png')
    expect(action.payload?.input).toContain('Workspace-relative Artifact')
    expect(action.payload?.input).not.toContain('file_id')
    expect(action.payload?.input).not.toContain('.hive/mobile-attachments.json')
    expect(action.payload?.input).not.toContain('local_path')
    expect(MockWebSocket.instances[0]?.sent).not.toContain('\x16')
  })

  test('falls back to arrow-key wheel input for alternate-screen TUIs without mouse tracking', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-alt')

    render(<TerminalView runId="run-wheel-alt" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-alt"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.wheel(terminal, { deltaY: 120 })
    fireEvent.wheel(terminal, { deltaY: -120 })

    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[B', '\u001b[A'])
  })

  test('passes default terminal binary mouse input through unchanged', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    terminalMouseTrackingMode = 'any'
    addPortalSlot('run-default-mouse-click')

    render(<TerminalView runId="run-default-mouse-click" title="Shell" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-default-mouse-click"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    await waitFor(() => {
      expect(latestOnBinaryHandler).toBeDefined()
    })

    fireEvent.mouseDown(terminal)

    expect(MockWebSocket.instances[0]?.sent).toEqual([binaryInput('\x1b[M !!')])
  })

  test('uses application cursor arrow sequences for alternate-screen wheel fallback', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalApplicationCursorKeysMode = true
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-app-cursor')

    render(<TerminalView runId="run-wheel-app-cursor" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-app-cursor"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.wheel(terminal, { deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: 1 })
    fireEvent.wheel(terminal, { deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: -1 })

    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001bOB', '\u001bOA'])
  })

  test('does not amplify small trackpad wheel deltas into one input per event', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-trackpad')

    render(<TerminalView runId="run-wheel-trackpad" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-trackpad"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    for (let index = 0; index < 5; index++) {
      fireEvent.wheel(terminal, { deltaMode: WheelEvent.DOM_DELTA_PIXEL, deltaY: 10 })
    }
    expect(MockWebSocket.instances[0]?.sent).toEqual([])

    fireEvent.wheel(terminal, { deltaMode: WheelEvent.DOM_DELTA_PIXEL, deltaY: 10 })

    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[B'])
  })

  test('consumes alternate-screen fallback wheel events before page scroll handlers run', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-consume')

    render(<TerminalView runId="run-wheel-consume" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-consume"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })
    let bubbled = false
    terminal.parentElement?.addEventListener('wheel', () => {
      bubbled = true
    })

    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })
    terminal.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(bubbled).toBe(false)
    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[B'])
  })

  test('consumes small alternate-screen trackpad wheel deltas even before emitting input', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-small-consume')

    render(<TerminalView runId="run-wheel-small-consume" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-small-consume"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })
    let bubbled = false
    terminal.parentElement?.addEventListener('wheel', () => {
      bubbled = true
    })

    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: 10,
    })
    terminal.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(bubbled).toBe(false)
    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })

  test('keeps normal scrollback wheel events out of PTY input', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'normal'
    addPortalSlot('run-wheel-normal')

    render(<TerminalView runId="run-wheel-normal" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-normal"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.wheel(terminal, { deltaY: 120 })

    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })

  test('lets mobile touch drags keep native scrollback behavior instead of PTY input', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'normal'
    addPortalSlot('run-touch-scroll')

    render(<TerminalView runId="run-touch-scroll" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-touch-scroll"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    terminal.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientY: 160 } as Touch],
      })
    )
    const move = new TouchEvent('touchmove', {
      bubbles: true,
      cancelable: true,
      touches: [{ clientY: 96 } as Touch],
    })
    terminal.dispatchEvent(move)

    expect(terminalScrollLines).toEqual([3])
    expect(move.defaultPrevented).toBe(false)
    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })

  test('lets mobile touch drags from an outer target keep native scrollback behavior', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'normal'
    addPortalSlot('run-touch-frame-scroll')

    const WrappedTerminal = () => {
      const [target, setTarget] = useState<HTMLDivElement | null>(null)
      return (
        <div data-testid="touch-frame" ref={setTarget}>
          <TerminalView runId="run-touch-frame-scroll" title="Alice" touchScrollTarget={target} />
        </div>
      )
    }

    render(<WrappedTerminal />)

    const frame = await waitFor(() => {
      const node = document.querySelector('[data-testid="touch-frame"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    frame.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientY: 160 } as Touch],
      })
    )
    const move = new TouchEvent('touchmove', {
      bubbles: true,
      cancelable: true,
      touches: [{ clientY: 96 } as Touch],
    })
    frame.dispatchEvent(move)

    expect(terminalScrollLines).toEqual([3])
    expect(move.defaultPrevented).toBe(false)
    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })

  test('continues normal mobile scrollback briefly after touch release without PTY input', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'normal'
    addPortalSlot('run-touch-inertia')

    render(<TerminalView runId="run-touch-inertia" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-touch-inertia"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    vi.useFakeTimers()
    terminal.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientY: 160 } as Touch],
      })
    )
    terminal.dispatchEvent(
      new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [{ clientY: 96 } as Touch],
      })
    )

    expect(terminalScrollLines).toEqual([3])

    terminal.dispatchEvent(new TouchEvent('touchend', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(650)

    expect(terminalScrollLines.length).toBeGreaterThan(1)
    expect(terminalScrollLines.slice(1).every((lines) => lines > 0)).toBe(true)
    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })

  test('continues normal mobile scrollback after a fast drag with a small final touch move', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'normal'
    addPortalSlot('run-touch-inertia-realistic')

    render(<TerminalView runId="run-touch-inertia-realistic" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-touch-inertia-realistic"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    vi.useFakeTimers()
    terminal.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientY: 180 } as Touch],
      })
    )
    for (const clientY of [150, 122, 100, 92, 88]) {
      terminal.dispatchEvent(
        new TouchEvent('touchmove', {
          bubbles: true,
          cancelable: true,
          touches: [{ clientY } as Touch],
        })
      )
    }
    const scrollCountBeforeRelease = terminalScrollLines.length

    terminal.dispatchEvent(new TouchEvent('touchend', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(650)

    expect(terminalScrollLines.length).toBeGreaterThan(scrollCountBeforeRelease)
    expect(terminalScrollLines.slice(scrollCountBeforeRelease).every((lines) => lines > 0)).toBe(
      true
    )
    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })

  test('updates mobile scrollback inertia on a frame-paced cadence', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'normal'
    addPortalSlot('run-touch-inertia-frame-paced')

    render(<TerminalView runId="run-touch-inertia-frame-paced" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-touch-inertia-frame-paced"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    vi.useFakeTimers()
    terminal.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientY: 180 } as Touch],
      })
    )
    terminal.dispatchEvent(
      new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [{ clientY: 90 } as Touch],
      })
    )
    const scrollCountBeforeRelease = terminalScrollLines.length

    terminal.dispatchEvent(new TouchEvent('touchend', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(20)

    expect(terminalScrollLines.length).toBeGreaterThan(scrollCountBeforeRelease)
    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })

  test('caps mobile scrollback inertia cadence when a frame-rate preference is set', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'normal'
    addPortalSlot('run-touch-inertia-60fps')

    render(
      <TerminalView runId="run-touch-inertia-60fps" scrollFrameRatePreference="60" title="Alice" />
    )

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-touch-inertia-60fps"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    vi.useFakeTimers()
    terminal.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientY: 180 } as Touch],
      })
    )
    terminal.dispatchEvent(
      new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [{ clientY: 90 } as Touch],
      })
    )
    const scrollCountBeforeRelease = terminalScrollLines.length

    terminal.dispatchEvent(new TouchEvent('touchend', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(18)

    expect(terminalScrollLines).toHaveLength(scrollCountBeforeRelease)

    await vi.advanceTimersByTimeAsync(18)

    expect(terminalScrollLines.length).toBeGreaterThan(scrollCountBeforeRelease)
    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })

  test('updates the mobile scroll frame-rate preference without reconnecting the terminal', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'normal'
    addPortalSlot('run-touch-inertia-preference-update')

    const { rerender } = render(
      <TerminalView
        runId="run-touch-inertia-preference-update"
        scrollFrameRatePreference="60"
        title="Alice"
      />
    )

    await waitFor(() => {
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(
        document.querySelector('[data-testid="terminal-run-touch-inertia-preference-update"]')
      ).not.toBeNull()
    })
    const websocketCountBeforePreferenceChange = MockWebSocket.instances.length

    rerender(
      <TerminalView
        runId="run-touch-inertia-preference-update"
        scrollFrameRatePreference="120"
        title="Alice"
      />
    )

    expect(MockWebSocket.instances).toHaveLength(websocketCountBeforePreferenceChange)
    expect(terminalDisposeCount).toBe(0)
  })

  test('continues normal mobile scrollback inertia in the downward direction', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'normal'
    addPortalSlot('run-touch-inertia-down')

    render(<TerminalView runId="run-touch-inertia-down" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-touch-inertia-down"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    vi.useFakeTimers()
    terminal.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientY: 96 } as Touch],
      })
    )
    terminal.dispatchEvent(
      new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [{ clientY: 160 } as Touch],
      })
    )

    expect(terminalScrollLines).toEqual([-3])

    terminal.dispatchEvent(new TouchEvent('touchend', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(650)

    expect(terminalScrollLines.length).toBeGreaterThan(1)
    expect(terminalScrollLines.slice(1).every((lines) => lines < 0)).toBe(true)
    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })

  test('cancels mobile scrollback inertia when a new touch starts', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'normal'
    addPortalSlot('run-touch-inertia-cancel')

    render(<TerminalView runId="run-touch-inertia-cancel" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-touch-inertia-cancel"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    vi.useFakeTimers()
    terminal.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientY: 160 } as Touch],
      })
    )
    terminal.dispatchEvent(
      new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [{ clientY: 96 } as Touch],
      })
    )
    terminal.dispatchEvent(new TouchEvent('touchend', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(60)
    expect(terminalScrollLines.length).toBeGreaterThan(1)

    terminal.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientY: 96 } as Touch],
      })
    )
    const scrollCountAfterCancel = terminalScrollLines.length
    await vi.advanceTimersByTimeAsync(650)

    expect(terminalScrollLines).toHaveLength(scrollCountAfterCancel)
  })

  test('does not start mobile scrollback inertia when touch is canceled', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'normal'
    addPortalSlot('run-touch-inertia-touchcancel')

    render(<TerminalView runId="run-touch-inertia-touchcancel" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-touch-inertia-touchcancel"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    vi.useFakeTimers()
    terminal.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientY: 160 } as Touch],
      })
    )
    terminal.dispatchEvent(
      new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [{ clientY: 96 } as Touch],
      })
    )

    expect(terminalScrollLines).toEqual([3])

    terminal.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(650)

    expect(terminalScrollLines).toEqual([3])
  })

  test('maps mobile touch drags to alternate-screen terminal scroll input', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-touch-alt-scroll')

    const WrappedTerminal = () => {
      const [target, setTarget] = useState<HTMLDivElement | null>(null)
      return (
        <div data-testid="touch-alt-frame" ref={setTarget}>
          <TerminalView runId="run-touch-alt-scroll" title="Alice" touchScrollTarget={target} />
        </div>
      )
    }

    render(<WrappedTerminal />)

    const frame = await waitFor(() => {
      const node = document.querySelector('[data-testid="touch-alt-frame"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    frame.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        cancelable: true,
        touches: [{ clientY: 100 } as Touch],
      })
    )
    const move = new TouchEvent('touchmove', {
      bubbles: true,
      cancelable: true,
      touches: [{ clientY: 20 } as Touch],
    })
    frame.dispatchEvent(move)

    expect(terminalScrollLines).toEqual([])
    expect(move.defaultPrevented).toBe(true)
    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[B'])
  })

  test('does not continue sending alternate-screen touch input after touch release', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-touch-alt-no-inertia')

    render(<TerminalView runId="run-touch-alt-no-inertia" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-touch-alt-no-inertia"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    vi.useFakeTimers()
    terminal.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        cancelable: true,
        touches: [{ clientY: 100 } as Touch],
      })
    )
    terminal.dispatchEvent(
      new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [{ clientY: 20 } as Touch],
      })
    )
    terminal.dispatchEvent(new TouchEvent('touchend', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(650)

    expect(terminalScrollLines).toEqual([])
    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[B'])
  })

  test.each([
    'any',
    'drag',
    'vt200',
    'x10',
  ] as const)('does not duplicate xterm %s mouse tracking wheel events', async (mouseTrackingMode) => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    terminalMouseTrackingMode = mouseTrackingMode
    addPortalSlot('run-wheel-mouse')

    render(<TerminalView runId="run-wheel-mouse" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-mouse"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.wheel(terminal, { deltaY: 120 })

    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })
})
