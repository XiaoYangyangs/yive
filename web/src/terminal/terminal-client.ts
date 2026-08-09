type TerminalControlServerMessage =
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number | null }
  | {
      type: 'restore'
      cols?: number
      outputBytes?: number
      restoredAt?: number
      request_id?: string
      rows?: number
      sizeOwner?: TerminalSizeOwner
      snapshot: string
    }
  | {
      type: 'size_owner_changed'
      cols?: number
      mode: TerminalViewerMode
      ownerClientId: string | null
      rows?: number
    }
  | { type: 'takeover_denied'; reason: string }
  | { type: 'takeover_granted'; cols: number; previousSize?: TerminalSize; rows: number }

type TerminalViewerMode = 'active' | 'passive' | 'takeover'
type TerminalSize = { cols: number; rows: number }
type TerminalSizeOwner = null | {
  acquiredAt: number
  clientId: string
  expiresAt?: number
  mode: 'desktop' | 'mobile_takeover'
  previousSize?: TerminalSize
  restoreOnRelease: boolean
}
export type TerminalOwnershipState = {
  cols?: number
  mode: TerminalViewerMode
  ownedByThisClient: boolean
  ownerClientId: string | null
  rows?: number
}

import { createBrowserId } from '../browser-id.js'

const TAKEOVER_HEARTBEAT_INTERVAL_MS = 15_000
const RESTORE_TIMEOUT_MS = 8_000
const MOBILE_TAKEOVER_RESTORE_SCROLLBACK = 20

interface TerminalClientOptions {
  connectionParams?: Record<string, number | string | undefined> | undefined
  initialSize?:
    | {
        cols: number
        pixelHeight?: number
        pixelWidth?: number
        rows: number
      }
    | undefined
  onError: (message: string) => void
  onExit: (code: number | null) => void
  onDisconnect?: (() => void) | undefined
  onOutput: (chunk: string, acknowledge: (bytes: number) => void) => void
  onOwnershipChange?: ((state: TerminalOwnershipState) => void) | undefined
  onRestoreProgress?: ((state: 'complete' | 'pending') => void) | undefined
  onRestore: (
    snapshot: string,
    meta: {
      outputBytes?: number
      restoredAt?: number
      size?: { cols: number; rows: number }
    },
    complete: () => void
  ) => void
  onTakeoverDenied?: ((reason: string) => void) | undefined
  onTakeoverGranted?: ((size: TerminalSize, previousSize?: TerminalSize) => void) | undefined
  propagateResize?: boolean | undefined
  runId: string
  viewerMode?: TerminalViewerMode | undefined
}

export interface TerminalClient {
  dispose: () => void
  reclaimTakeover: (cols: number, rows: number) => void
  releaseTakeover: () => void
  requestTakeover: (cols: number, rows: number, options?: { restoreOnRelease?: boolean }) => void
  resize: (cols: number, rows: number, pixelWidth?: number, pixelHeight?: number) => void
  sendBinaryInput: (chunk: string) => void
  sendInput: (chunk: string) => void
}

export interface TerminalConnectionPreload {
  dispose: () => void
}

interface PreloadedTerminalConnection {
  clientId: string
  controlSocket: WebSocket
  ioSocket: WebSocket
  pendingOutputAckBytes: number
}

const preloadedTerminalConnections = new Map<string, PreloadedTerminalConnection>()

const normalizeWebSocketBasePath = (value: number | string | undefined): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().replace(/^\/+|\/+$/gu, '')
  return trimmed ? `/${trimmed}` : ''
}

const toWebSocketUrl = (path: string, params: Record<string, number | string | undefined> = {}) => {
  const basePath = normalizeWebSocketBasePath(params.websocket_base_path)
  const url = new URL(`${basePath}${path}`, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [key, value] of Object.entries(params)) {
    if (key === 'websocket_base_path') continue
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

const getTerminalConnectionKey = (
  runId: string,
  mode: TerminalViewerMode,
  connectionParams: Record<string, number | string | undefined> | undefined
) =>
  JSON.stringify([
    runId,
    mode,
    Object.entries(connectionParams ?? {})
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  ])

const createTerminalSockets = ({
  clientId,
  connectionParams,
  initialSize,
  mode,
  runId,
}: {
  clientId: string
  connectionParams?: Record<string, number | string | undefined> | undefined
  initialSize?:
    | { cols: number; pixelHeight?: number; pixelWidth?: number; rows: number }
    | undefined
  mode: TerminalViewerMode
  runId: string
}) => {
  const socketParams = {
    ...connectionParams,
    ...initialSize,
    clientId,
    defer_restore: mode === 'takeover' ? '1' : undefined,
    mode,
    passive: mode === 'passive' ? '1' : undefined,
  }
  const ioSocket = new WebSocket(toWebSocketUrl(`/ws/terminal/${runId}/io`, socketParams))
  const controlSocket = new WebSocket(toWebSocketUrl(`/ws/terminal/${runId}/control`, socketParams))
  ioSocket.binaryType = 'arraybuffer'
  controlSocket.binaryType = 'arraybuffer'
  return { controlSocket, ioSocket }
}

export const preloadTerminalConnection = ({
  connectionParams,
  runId,
  viewerMode = 'takeover',
}: {
  connectionParams?: Record<string, number | string | undefined> | undefined
  runId: string
  viewerMode?: TerminalViewerMode | undefined
}): TerminalConnectionPreload => {
  const key = getTerminalConnectionKey(runId, viewerMode, connectionParams)
  const existing = preloadedTerminalConnections.get(key)
  if (existing) {
    return {
      dispose: () => {
        if (preloadedTerminalConnections.get(key) !== existing) return
        preloadedTerminalConnections.delete(key)
        existing.ioSocket.close()
        existing.controlSocket.close()
      },
    }
  }

  const clientId = createBrowserId('terminal-client')
  const { controlSocket, ioSocket } = createTerminalSockets({
    clientId,
    connectionParams,
    mode: viewerMode,
    runId,
  })
  const connection: PreloadedTerminalConnection = {
    clientId,
    controlSocket,
    ioSocket,
    pendingOutputAckBytes: 0,
  }
  preloadedTerminalConnections.set(key, connection)
  const disposeConnection = () => {
    if (preloadedTerminalConnections.get(key) !== connection) return
    preloadedTerminalConnections.delete(key)
    ioSocket.close()
    controlSocket.close()
  }
  controlSocket.onmessage = () => {}
  controlSocket.onopen = () => {
    if (connection.pendingOutputAckBytes <= 0) return
    controlSocket.send(
      JSON.stringify({ type: 'output_ack', bytes: connection.pendingOutputAckBytes })
    )
    connection.pendingOutputAckBytes = 0
  }
  ioSocket.onmessage = (event) => {
    const bytes = getWebSocketDataByteLength(event.data)
    if (controlSocket.readyState === controlSocket.OPEN) {
      controlSocket.send(JSON.stringify({ type: 'output_ack', bytes }))
    } else {
      connection.pendingOutputAckBytes += bytes
    }
  }
  controlSocket.onclose = disposeConnection
  controlSocket.onerror = disposeConnection
  ioSocket.onclose = disposeConnection
  ioSocket.onerror = disposeConnection

  return {
    dispose: disposeConnection,
  }
}

const decodeBlobText = (data: Blob): Promise<string> => {
  if (typeof data.text === 'function') return data.text()
  if (typeof data.arrayBuffer === 'function') {
    return data.arrayBuffer().then((buffer) => new TextDecoder().decode(buffer))
  }
  if (typeof Response !== 'undefined') return new Response(data).text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Failed to decode Blob'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsText(data)
  })
}

const isBlobLike = (data: MessageEvent['data']): data is Blob =>
  typeof data === 'object' &&
  data !== null &&
  (typeof (data as Blob).text === 'function' ||
    typeof (data as Blob).arrayBuffer === 'function' ||
    (typeof (data as Blob).size === 'number' && typeof (data as Blob).type === 'string'))

const isArrayBufferLike = (data: MessageEvent['data']): data is ArrayBuffer =>
  typeof data === 'object' &&
  data !== null &&
  ((typeof (data as ArrayBuffer).byteLength === 'number' &&
    typeof (data as ArrayBuffer).slice === 'function') ||
    Object.prototype.toString.call(data) === '[object ArrayBuffer]')

const getWebSocketDataByteLength = (data: MessageEvent['data']): number => {
  if (typeof data === 'string') return new TextEncoder().encode(data).byteLength
  if (isBlobLike(data)) return data.size
  if (data instanceof ArrayBuffer || isArrayBufferLike(data)) return data.byteLength
  if (ArrayBuffer.isView(data)) return data.byteLength
  return new TextEncoder().encode(String(data)).byteLength
}

const decodeWebSocketText = (data: MessageEvent['data']): Promise<string> | string => {
  if (typeof data === 'string') return data
  if (isBlobLike(data)) return decodeBlobText(data)
  if (data instanceof ArrayBuffer || isArrayBufferLike(data)) {
    return new TextDecoder().decode(new Uint8Array(data as ArrayBuffer))
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data)
  }
  return String(data)
}

export const createTerminalClient = ({
  connectionParams: extraConnectionParams,
  initialSize,
  onError,
  onExit,
  onDisconnect,
  onOutput,
  onOwnershipChange,
  onRestore,
  onRestoreProgress,
  onTakeoverDenied,
  onTakeoverGranted,
  propagateResize = true,
  runId,
  viewerMode,
}: TerminalClientOptions): TerminalClient => {
  const mode = viewerMode ?? (propagateResize ? 'active' : 'passive')
  const connectionKey = getTerminalConnectionKey(runId, mode, extraConnectionParams)
  const preloadedConnection = preloadedTerminalConnections.get(connectionKey)
  if (preloadedConnection) preloadedTerminalConnections.delete(connectionKey)
  const clientId = preloadedConnection?.clientId ?? createBrowserId('terminal-client')
  const sockets =
    preloadedConnection ??
    createTerminalSockets({
      clientId,
      connectionParams: extraConnectionParams,
      initialSize,
      mode,
      runId,
    })
  const { controlSocket, ioSocket } = sockets
  let restored = false
  let restoreGeneration = 0
  let pendingRestoreRequestId: string | null = null
  const pendingOutput: Array<{ chunk: string; acknowledge: (bytes: number) => void }> = []
  let pendingResize: {
    cols: number
    rows: number
    pixelWidth?: number
    pixelHeight?: number
  } | null = null
  let lastSentPtySizeKey: string | null = null
  let pendingTakeover: {
    cols: number
    restoreOnRelease: boolean
    rows: number
  } | null = null
  let takeoverHeartbeatTimer: ReturnType<typeof window.setInterval> | undefined
  let restoreTimeoutTimer: ReturnType<typeof window.setTimeout> | undefined
  let disposed = false
  let disconnectNotified = false

  const clearRestoreTimeout = () => {
    if (restoreTimeoutTimer === undefined) return
    window.clearTimeout(restoreTimeoutTimer)
    restoreTimeoutTimer = undefined
  }

  const startRestoreTimeout = () => {
    clearRestoreTimeout()
    restoreTimeoutTimer = window.setTimeout(() => {
      restoreTimeoutTimer = undefined
      if (disposed || restored) return
      onError('等待终端历史恢复超时，远程终端代理可能没有返回数据。')
    }, RESTORE_TIMEOUT_MS)
  }

  const sendTakeoverHeartbeat = () => {
    if (controlSocket.readyState !== controlSocket.OPEN) return
    controlSocket.send(JSON.stringify({ type: 'takeover_heartbeat' }))
  }

  const stopTakeoverHeartbeat = () => {
    if (takeoverHeartbeatTimer === undefined) return
    window.clearInterval(takeoverHeartbeatTimer)
    takeoverHeartbeatTimer = undefined
  }

  const startTakeoverHeartbeat = () => {
    stopTakeoverHeartbeat()
    sendTakeoverHeartbeat()
    takeoverHeartbeatTimer = window.setInterval(
      sendTakeoverHeartbeat,
      TAKEOVER_HEARTBEAT_INTERVAL_MS
    )
  }

  const notifyDisconnect = (event?: Event) => {
    if (disposed || disconnectNotified) return
    stopTakeoverHeartbeat()
    disconnectNotified = true
    if (typeof CloseEvent !== 'undefined' && event instanceof CloseEvent && event.reason.trim()) {
      onError(event.reason.trim())
    }
    onDisconnect?.()
  }

  const sendResize = () => {
    if (!propagateResize) {
      pendingResize = null
      return
    }
    if (!pendingResize || controlSocket.readyState !== controlSocket.OPEN) return
    const ptySizeKey = `${pendingResize.cols}:${pendingResize.rows}`
    if (ptySizeKey === lastSentPtySizeKey) {
      pendingResize = null
      return
    }
    lastSentPtySizeKey = ptySizeKey
    controlSocket.send(JSON.stringify({ type: 'resize', ...pendingResize }))
    pendingResize = null
  }
  const sendTakeoverRequest = () => {
    if (!pendingTakeover || controlSocket.readyState !== controlSocket.OPEN) return
    if (mode === 'takeover' && !restored) return
    controlSocket.send(
      JSON.stringify({
        type: 'takeover_request',
        cols: pendingTakeover.cols,
        restore_on_release: pendingTakeover.restoreOnRelease,
        rows: pendingTakeover.rows,
      })
    )
    pendingTakeover = null
  }
  const requestFreshRestore = () => {
    if (mode !== 'takeover' || controlSocket.readyState !== controlSocket.OPEN) return
    const size = initialSize
    if (!size) return
    pendingRestoreRequestId = createBrowserId('terminal-restore')
    controlSocket.send(
      JSON.stringify({
        type: 'restore_request',
        cols: size.cols,
        request_id: pendingRestoreRequestId,
        rows: size.rows,
        scrollback: MOBILE_TAKEOVER_RESTORE_SCROLLBACK,
      })
    )
  }
  const notifyOwnership = (
    state:
      | { cols?: number; mode: TerminalViewerMode; ownerClientId: string | null; rows?: number }
      | TerminalSizeOwner
      | undefined
  ) => {
    if (!state) {
      onOwnershipChange?.({
        mode: 'active',
        ownedByThisClient: false,
        ownerClientId: null,
      })
      return
    }
    if ('clientId' in state) {
      onOwnershipChange?.({
        mode: state.mode === 'mobile_takeover' ? 'takeover' : 'active',
        ownedByThisClient: state.clientId === clientId,
        ownerClientId: state.clientId,
        ...(state.previousSize
          ? { cols: state.previousSize.cols, rows: state.previousSize.rows }
          : {}),
      })
      return
    }
    onOwnershipChange?.({
      ...state,
      ownedByThisClient: state.ownerClientId === clientId,
    })
    if (state.mode !== 'takeover' || state.ownerClientId !== clientId) stopTakeoverHeartbeat()
  }

  const handleTerminalOutput = (chunk: string, acknowledge: (bytes: number) => void) => {
    if (disposed) return
    if (!restored) {
      pendingOutput.push({ chunk, acknowledge })
      return
    }
    onOutput(chunk, acknowledge)
  }

  const handleTerminalControlMessage = (rawMessage: string) => {
    if (disposed) return
    const message = JSON.parse(rawMessage) as TerminalControlServerMessage
    if (message.type === 'exit') {
      clearRestoreTimeout()
      onExit(message.code)
    }
    if (message.type === 'error') {
      clearRestoreTimeout()
      onError(message.message)
    }
    if (message.type === 'size_owner_changed') notifyOwnership(message)
    if (message.type === 'takeover_denied') {
      clearRestoreTimeout()
      onTakeoverDenied?.(message.reason)
    }
    if (message.type === 'takeover_granted') {
      startTakeoverHeartbeat()
      notifyOwnership({
        cols: message.cols,
        mode: 'takeover',
        ownerClientId: clientId,
        rows: message.rows,
      })
      onTakeoverGranted?.({ cols: message.cols, rows: message.rows }, message.previousSize)
    }
    if (message.type === 'restore') {
      if (mode === 'takeover' && message.request_id !== pendingRestoreRequestId) return
      clearRestoreTimeout()
      const generation = restoreGeneration + 1
      restoreGeneration = generation
      restored = false
      const cols = message.cols
      const rows = message.rows
      const size =
        Number.isInteger(cols) && Number.isInteger(rows)
          ? { cols: cols as number, rows: rows as number }
          : undefined
      notifyOwnership(message.sizeOwner)
      onRestoreProgress?.('pending')
      onRestore(
        message.snapshot,
        { outputBytes: message.outputBytes, restoredAt: message.restoredAt, size },
        () => {
          if (disposed || generation !== restoreGeneration) return
          restored = true
          if (controlSocket.readyState === controlSocket.OPEN) {
            controlSocket.send(JSON.stringify({ type: 'restore_complete' }))
          }
          for (const output of pendingOutput.splice(0)) {
            onOutput(output.chunk, output.acknowledge)
          }
          sendTakeoverRequest()
          onRestoreProgress?.('complete')
        }
      )
    }
  }

  ioSocket.onmessage = (event) => {
    const acknowledge = (bytes: number) => {
      if (controlSocket.readyState !== controlSocket.OPEN) return
      controlSocket.send(JSON.stringify({ type: 'output_ack', bytes }))
    }
    const decoded = decodeWebSocketText(event.data)
    if (typeof decoded === 'string') {
      handleTerminalOutput(decoded, acknowledge)
      return
    }
    void decoded
      .then((chunk) => handleTerminalOutput(chunk, acknowledge))
      .catch((error: unknown) => {
        if (disposed) return
        onError(error instanceof Error ? error.message : 'Failed to decode terminal output')
      })
  }
  ioSocket.onclose = notifyDisconnect
  ioSocket.onerror = notifyDisconnect
  const initializeOpenControl = () => {
    if (preloadedConnection && preloadedConnection.pendingOutputAckBytes > 0) {
      controlSocket.send(
        JSON.stringify({
          type: 'output_ack',
          bytes: preloadedConnection.pendingOutputAckBytes,
        })
      )
      preloadedConnection.pendingOutputAckBytes = 0
    }
    startRestoreTimeout()
    requestFreshRestore()
    sendResize()
    sendTakeoverRequest()
  }
  controlSocket.onopen = initializeOpenControl
  controlSocket.onmessage = (event) => {
    const decoded = decodeWebSocketText(event.data)
    if (typeof decoded === 'string') {
      try {
        handleTerminalControlMessage(decoded)
      } catch (error: unknown) {
        if (disposed) return
        clearRestoreTimeout()
        onError(
          error instanceof Error ? error.message : 'Failed to decode terminal control message'
        )
      }
      return
    }
    void decoded.then(handleTerminalControlMessage).catch((error: unknown) => {
      if (disposed) return
      clearRestoreTimeout()
      onError(error instanceof Error ? error.message : 'Failed to decode terminal control message')
    })
  }
  controlSocket.onclose = notifyDisconnect
  controlSocket.onerror = notifyDisconnect

  if (controlSocket.readyState === controlSocket.OPEN) initializeOpenControl()
  return {
    dispose() {
      disposed = true
      clearRestoreTimeout()
      if (viewerMode === 'takeover' && controlSocket.readyState === controlSocket.OPEN) {
        controlSocket.send(JSON.stringify({ type: 'takeover_release' }))
      }
      stopTakeoverHeartbeat()
      ioSocket.close()
      controlSocket.close()
    },
    reclaimTakeover(cols, rows) {
      if (controlSocket.readyState !== controlSocket.OPEN) return
      controlSocket.send(JSON.stringify({ type: 'takeover_reclaim', cols, rows }))
    },
    releaseTakeover() {
      if (controlSocket.readyState !== controlSocket.OPEN) return
      stopTakeoverHeartbeat()
      controlSocket.send(JSON.stringify({ type: 'takeover_release' }))
    },
    requestTakeover(cols, rows, options = {}) {
      pendingTakeover = { cols, restoreOnRelease: options.restoreOnRelease ?? true, rows }
      sendTakeoverRequest()
    },
    resize(cols, rows, pixelWidth, pixelHeight) {
      pendingResize = { cols, rows }
      if (pixelWidth !== undefined) pendingResize.pixelWidth = pixelWidth
      if (pixelHeight !== undefined) pendingResize.pixelHeight = pixelHeight
      sendResize()
    },
    sendBinaryInput(chunk) {
      if (ioSocket.readyState !== ioSocket.OPEN) return
      const bytes = new Uint8Array(chunk.length)
      for (let index = 0; index < chunk.length; index++) {
        bytes[index] = chunk.charCodeAt(index) & 0xff
      }
      ioSocket.send(bytes)
    },
    sendInput(chunk) {
      if (ioSocket.readyState !== ioSocket.OPEN) return
      ioSocket.send(chunk)
    },
  }
}
