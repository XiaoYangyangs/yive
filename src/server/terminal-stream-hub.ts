import type WebSocket from 'ws'

import type { RuntimeStore } from './runtime-store.js'
import { createTerminalOutputFlow } from './terminal-flow-control.js'
import type { TerminalSizeOwner, TerminalViewerMode } from './terminal-protocol.js'
import {
  parseTerminalControlMessage,
  serializeTerminalError,
  serializeTerminalExit,
  serializeTerminalRestore,
  serializeTerminalSizeOwnerChanged,
  serializeTerminalTakeoverDenied,
  serializeTerminalTakeoverGranted,
} from './terminal-protocol.js'
import { type TerminalMirrorSize, TerminalStateMirror } from './terminal-state-mirror.js'

interface ViewerState {
  backpressured: boolean
  backpressureGeneration: number
  backpressureTimer: ReturnType<typeof setTimeout> | null
  clientId: string
  controlSocket: WebSocket | null
  deferredOutputBytes: number
  flowState: ReturnType<typeof createTerminalOutputFlow> | null
  ioSocket: WebSocket | null
  mode: TerminalViewerMode
  outputDeferred: boolean
  pendingOutput: string[]
  restoreGeneration: number
  restoreRequested: boolean
}

interface RunState {
  canonicalMirror: TerminalStateMirror
  canonicalSize?: TerminalMirrorSize
  desktopOwnerClientId: string | null
  exited: boolean
  exitInterval: ReturnType<typeof setInterval> | null
  outputUnsubscribe: (() => void) | null
  outputBytes: number
  sizeOwner: TerminalSizeOwner
  takeoverLeaseInterval: ReturnType<typeof setInterval> | null
  viewers: Map<string, ViewerState>
}

const normalizeTerminalInput = (
  raw: ArrayBuffer | Buffer | Buffer[],
  isBinary: boolean
): Buffer | string => {
  const bytes = Buffer.isBuffer(raw)
    ? raw
    : Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.from(raw)
  return isBinary ? Buffer.from(bytes) : bytes.toString()
}

export interface TerminalStreamHub {
  attachControl: (
    runId: string,
    clientId: string,
    socket: WebSocket,
    initialSize?: TerminalMirrorSize,
    mode?: TerminalViewerMode | boolean,
    deferRestore?: boolean
  ) => void
  attachIo: (
    runId: string,
    clientId: string,
    socket: WebSocket,
    initialSize?: TerminalMirrorSize,
    mode?: TerminalViewerMode,
    deferOutput?: boolean
  ) => void
  close: () => void
}

export interface TerminalStreamHubOptions {
  takeoverLeaseCheckMs?: number
  takeoverLeaseMs?: number
}

const DEFAULT_TAKEOVER_LEASE_CHECK_MS = 5_000
const DEFAULT_TAKEOVER_LEASE_MS = 45_000
const MOBILE_TAKEOVER_RESTORE_SCROLLBACK = 50
const MOBILE_TAKEOVER_REHYDRATE_CHARS = 80_000
const MOBILE_TAKEOVER_REHYDRATE_LINES = 50
const DEFERRED_OUTPUT_HIGH_WATER_BYTES = 256 * 1024
const VIEWER_BACKPRESSURE_GRACE_MS = 250

const tailOutputLines = (value: string, lineLimit: number): string => {
  const lines = value.split(/\r?\n/u)
  const lineTail = lines.length <= lineLimit ? value : lines.slice(-lineLimit).join('\n')
  if (lineTail.length <= MOBILE_TAKEOVER_REHYDRATE_CHARS) return lineTail
  return lineTail.slice(-MOBILE_TAKEOVER_REHYDRATE_CHARS)
}

const getOutputByteLength = (value: string): number => Buffer.byteLength(value)

export const createTerminalStreamHub = (
  store: RuntimeStore,
  {
    takeoverLeaseCheckMs = DEFAULT_TAKEOVER_LEASE_CHECK_MS,
    takeoverLeaseMs = DEFAULT_TAKEOVER_LEASE_MS,
  }: TerminalStreamHubOptions = {}
): TerminalStreamHub => {
  const runStates = new Map<string, RunState>()

  const resetRestoreBarrier = (viewer: ViewerState, outputDeferred: boolean) => {
    viewer.deferredOutputBytes = 0
    viewer.outputDeferred = outputDeferred
    viewer.pendingOutput = []
    viewer.restoreGeneration += 1
    viewer.restoreRequested = false
  }

  const cleanupRun = (runId: string) => {
    const state = runStates.get(runId)
    if (!state?.exited || state.viewers.size > 0) return
    state.outputUnsubscribe?.()
    state.canonicalMirror.dispose()
    if (state.exitInterval) clearInterval(state.exitInterval)
    if (state.takeoverLeaseInterval) clearInterval(state.takeoverLeaseInterval)
    runStates.delete(runId)
  }

  const clearViewerBackpressureTimer = (viewer: ViewerState) => {
    if (!viewer.backpressureTimer) return
    clearTimeout(viewer.backpressureTimer)
    viewer.backpressureTimer = null
  }

  const getOrCreateViewer = (state: RunState, clientId: string) => {
    let viewer = state.viewers.get(clientId)
    if (!viewer) {
      viewer = {
        backpressured: false,
        backpressureGeneration: 0,
        backpressureTimer: null,
        clientId,
        controlSocket: null,
        deferredOutputBytes: 0,
        flowState: null,
        ioSocket: null,
        mode: 'active',
        outputDeferred: true,
        pendingOutput: [],
        restoreGeneration: 0,
        restoreRequested: false,
      }
      state.viewers.set(clientId, viewer)
    }
    return viewer
  }

  const getOrCreateState = (runId: string, mode: TerminalViewerMode = 'active') => {
    let state = runStates.get(runId)
    if (!state) {
      state = {
        canonicalMirror: new TerminalStateMirror(),
        desktopOwnerClientId: null,
        exited: false,
        exitInterval: null,
        outputUnsubscribe: null,
        outputBytes: 0,
        sizeOwner: null,
        takeoverLeaseInterval: null,
        viewers: new Map(),
      }
      runStates.set(runId, state)
      const nextState = state
      try {
        const liveRun = store.getLiveRun(runId)
        const output =
          mode === 'takeover'
            ? tailOutputLines(liveRun.output, MOBILE_TAKEOVER_REHYDRATE_LINES)
            : liveRun.output
        nextState.outputBytes = getOutputByteLength(liveRun.output)
        if (output.length > 0) nextState.canonicalMirror.write(output)
      } catch {
        // The upgrade path rejects missing runs. This keeps hub cleanup tolerant
        // if a run exits between validation and subscription.
      }
      nextState.outputUnsubscribe = store.getPtyOutputBus().subscribe(runId, (chunk) => {
        nextState.outputBytes += getOutputByteLength(chunk)
        nextState.canonicalMirror.write(chunk)
        for (const viewer of nextState.viewers.values()) {
          if (!viewer.outputDeferred) {
            viewer.flowState?.enqueue(chunk)
            continue
          }
          if (!viewer.restoreRequested) continue
          viewer.pendingOutput.push(chunk)
          viewer.deferredOutputBytes += getOutputByteLength(chunk)
          if (viewer.deferredOutputBytes >= DEFERRED_OUTPUT_HIGH_WATER_BYTES) {
            disconnectStalledViewer(viewer)
          }
        }
      })
    }
    return state
  }

  const setCanonicalSize = (runId: string, state: RunState, size?: TerminalMirrorSize) => {
    if (!size) return
    if (!state.canonicalSize) {
      state.canonicalMirror.dispose()
      state.canonicalMirror = new TerminalStateMirror(size)
      try {
        const liveRun = store.getLiveRun(runId)
        if (liveRun.output.length > 0) state.canonicalMirror.write(liveRun.output)
      } catch {
        // Keep the live mirror usable if the run exits during rehydration.
      }
      state.canonicalSize = size
      return
    }
    state.canonicalSize = size
    state.canonicalMirror.resize(size.cols, size.rows)
  }

  const buildRestoreSnapshot = async (
    runId: string,
    state: RunState,
    mode: TerminalViewerMode,
    restoreSize?: TerminalMirrorSize
  ) => {
    if (mode === 'takeover') {
      try {
        const liveRun = store.getLiveRun(runId)
        const size = state.canonicalSize ?? state.canonicalMirror.getSize()
        state.canonicalMirror.dispose()
        state.canonicalMirror = new TerminalStateMirror(size)
        state.canonicalMirror.write(
          tailOutputLines(liveRun.output, MOBILE_TAKEOVER_REHYDRATE_LINES)
        )
        state.outputBytes = getOutputByteLength(liveRun.output)
      } catch {
        // Keep the current mirror if the live run exits while the mobile viewer attaches.
      }
    }
    if (mode === 'passive' && restoreSize) {
      const currentSize = state.canonicalMirror.getSize()
      const shouldRehydrateForViewer =
        restoreSize.cols > currentSize.cols || restoreSize.rows > currentSize.rows
      if (shouldRehydrateForViewer) {
        try {
          const liveRun = store.getLiveRun(runId)
          const viewerMirror = new TerminalStateMirror(restoreSize)
          if (liveRun.output.length > 0) viewerMirror.write(liveRun.output)
          const snapshot = await viewerMirror.getSnapshot()
          viewerMirror.dispose()
          return {
            outputBytes: state.outputBytes,
            restoredAt: Date.now(),
            size: restoreSize,
            snapshot,
          }
        } catch {
          // Fall back to the canonical mirror below if live output is unavailable.
        }
      }
    }
    const snapshot = await state.canonicalMirror.getSnapshot(
      mode === 'takeover' ? { scrollback: MOBILE_TAKEOVER_RESTORE_SCROLLBACK } : {}
    )
    return {
      outputBytes: state.outputBytes,
      restoredAt: Date.now(),
      size: state.canonicalMirror.getSize(),
      snapshot,
    }
  }

  const buildRequestedRestoreSnapshot = async (
    runId: string,
    size: TerminalMirrorSize,
    scrollback: number
  ) => {
    const liveRun = store.getLiveRun(runId)
    const viewerMirror = new TerminalStateMirror(size)
    try {
      viewerMirror.write(tailOutputLines(liveRun.output, scrollback + size.rows))
      return {
        outputBytes: getOutputByteLength(liveRun.output),
        restoredAt: Date.now(),
        size,
        snapshot: await viewerMirror.getSnapshot({ scrollback }),
      }
    } finally {
      viewerMirror.dispose()
    }
  }

  const sendControl = (viewer: ViewerState, payload: string) => {
    const controlSocket = viewer.controlSocket
    if (controlSocket && controlSocket.readyState === controlSocket.OPEN)
      controlSocket.send(payload)
  }

  const disconnectStalledViewer = (viewer: ViewerState) => {
    viewer.backpressured = false
    viewer.backpressureGeneration += 1
    clearViewerBackpressureTimer(viewer)
    const flowState = viewer.flowState
    viewer.flowState = null
    resetRestoreBarrier(viewer, false)
    flowState?.close()
    viewer.ioSocket?.close()
    viewer.controlSocket?.close()
  }

  const flushDeferredOutput = (viewer: ViewerState) => {
    if (viewer.outputDeferred || !viewer.flowState || viewer.pendingOutput.length === 0) return
    const output = viewer.pendingOutput.join('')
    viewer.pendingOutput = []
    viewer.deferredOutputBytes = 0
    viewer.flowState.enqueue(output)
  }

  const broadcastSizeOwnerChanged = (state: RunState) => {
    const size = state.canonicalSize ?? state.canonicalMirror.getSize()
    const mode = state.sizeOwner?.mode === 'mobile_takeover' ? 'takeover' : 'active'
    const payload = serializeTerminalSizeOwnerChanged(mode, state.sizeOwner?.clientId ?? null, size)
    for (const viewer of state.viewers.values()) sendControl(viewer, payload)
  }

  const resizeRun = (runId: string, state: RunState, size: TerminalMirrorSize) => {
    store.resizeAgentRun(runId, size.cols, size.rows)
    setCanonicalSize(runId, state, size)
  }

  const viewerOwnsTerminal = (state: RunState, clientId: string) => {
    return state.sizeOwner?.clientId === clientId
  }

  const clearTakeoverLease = (state: RunState) => {
    if (!state.takeoverLeaseInterval) return
    clearInterval(state.takeoverLeaseInterval)
    state.takeoverLeaseInterval = null
  }

  const releaseTakeover = (runId: string, state: RunState, clientId: string): unknown | null => {
    const owner = state.sizeOwner
    if (!owner || owner.mode !== 'mobile_takeover' || owner.clientId !== clientId) return null
    const previousDesktop = state.desktopOwnerClientId
      ? state.viewers.get(state.desktopOwnerClientId)
      : undefined
    const nextDesktop =
      previousDesktop?.mode === 'active' &&
      (previousDesktop.controlSocket !== null || previousDesktop.ioSocket !== null)
        ? previousDesktop
        : [...state.viewers.values()].find(
            (viewer) =>
              viewer.mode === 'active' &&
              (viewer.controlSocket !== null || viewer.ioSocket !== null)
          )
    state.desktopOwnerClientId = nextDesktop?.clientId ?? null
    state.sizeOwner = nextDesktop
      ? {
          acquiredAt: Date.now(),
          clientId: nextDesktop.clientId,
          mode: 'desktop',
          restoreOnRelease: false,
        }
      : null
    clearTakeoverLease(state)
    broadcastSizeOwnerChanged(state)
    if (owner.restoreOnRelease && owner.previousSize) {
      try {
        resizeRun(runId, state, owner.previousSize)
        broadcastSizeOwnerChanged(state)
      } catch (error) {
        return error
      }
    }
    return null
  }

  const renewTakeoverLease = (state: RunState, clientId: string): boolean => {
    const owner = state.sizeOwner
    if (!owner || owner.mode !== 'mobile_takeover' || owner.clientId !== clientId) return false
    owner.expiresAt = Date.now() + takeoverLeaseMs
    return true
  }

  const startTakeoverLeaseWatcher = (runId: string, state: RunState) => {
    if (state.takeoverLeaseInterval) return
    state.takeoverLeaseInterval = setInterval(() => {
      const owner = state.sizeOwner
      if (!owner || owner.mode !== 'mobile_takeover') return
      if (typeof owner.expiresAt !== 'number' || owner.expiresAt > Date.now()) return
      releaseTakeover(runId, state, owner.clientId)
    }, takeoverLeaseCheckMs)
  }

  const reclaimTakeover = (
    runId: string,
    state: RunState,
    clientId: string,
    size: TerminalMirrorSize
  ) => {
    resizeRun(runId, state, size)
    state.desktopOwnerClientId = clientId
    state.sizeOwner = {
      acquiredAt: Date.now(),
      clientId,
      mode: 'desktop',
      restoreOnRelease: false,
    }
    clearTakeoverLease(state)
    broadcastSizeOwnerChanged(state)
  }

  const transferDesktopOwnership = (state: RunState, disconnectedClientId: string) => {
    const owner = state.sizeOwner
    if (!owner || owner.mode !== 'desktop' || owner.clientId !== disconnectedClientId) return
    const replacement = [...state.viewers.values()].find(
      (viewer) =>
        viewer.clientId !== disconnectedClientId &&
        viewer.mode === 'active' &&
        (viewer.controlSocket !== null || viewer.ioSocket !== null)
    )
    state.sizeOwner = replacement
      ? {
          acquiredAt: Date.now(),
          clientId: replacement.clientId,
          mode: 'desktop',
          restoreOnRelease: false,
        }
      : null
    state.desktopOwnerClientId = replacement?.clientId ?? null
    broadcastSizeOwnerChanged(state)
  }

  const cleanupViewer = (runId: string, state: RunState, clientId: string) => {
    const viewer = state.viewers.get(clientId)
    if (!viewer || viewer.controlSocket || viewer.ioSocket) return
    releaseTakeover(runId, state, clientId)
    state.viewers.delete(clientId)
    transferDesktopOwnership(state, clientId)
    cleanupRun(runId)
  }

  const startExitWatcher = (runId: string, state: RunState) => {
    if (state.exitInterval) return
    state.exitInterval = setInterval(() => {
      try {
        const run = store.getLiveRun(runId)
        if (run.status !== 'exited' && run.status !== 'error') return
        state.exited = true
        state.outputUnsubscribe?.()
        state.outputUnsubscribe = null
        const payload = serializeTerminalExit(run.exitCode)
        for (const viewer of state.viewers.values()) {
          const controlSocket = viewer.controlSocket
          if (controlSocket && controlSocket.readyState === controlSocket.OPEN)
            controlSocket.send(payload)
        }
        if (state.exitInterval) clearInterval(state.exitInterval)
        state.exitInterval = null
        cleanupRun(runId)
      } catch {
        if (state.exitInterval) clearInterval(state.exitInterval)
        state.exitInterval = null
      }
    }, 25)
  }

  return {
    attachControl(
      runId,
      clientId,
      socket,
      initialSize,
      modeOrPassive: TerminalViewerMode | boolean = 'active',
      deferRestore = false
    ) {
      const mode =
        typeof modeOrPassive === 'boolean' ? (modeOrPassive ? 'passive' : 'active') : modeOrPassive
      const state = getOrCreateState(runId, mode)
      const viewer = getOrCreateViewer(state, clientId)
      const previousControlSocket = viewer.controlSocket
      viewer.mode = mode
      viewer.controlSocket = socket
      if (previousControlSocket && previousControlSocket !== socket) previousControlSocket.close()
      startExitWatcher(runId, state)
      if (mode === 'active' && state.sizeOwner?.mode !== 'mobile_takeover') {
        setCanonicalSize(runId, state, initialSize)
        if (!state.sizeOwner) {
          state.desktopOwnerClientId = clientId
          state.sizeOwner = {
            acquiredAt: Date.now(),
            clientId,
            mode: 'desktop',
            restoreOnRelease: false,
          }
        }
      }
      if (!deferRestore) {
        resetRestoreBarrier(viewer, true)
        viewer.restoreRequested = true
        const restoreGeneration = viewer.restoreGeneration
        void buildRestoreSnapshot(runId, state, mode, initialSize)
          .then(({ outputBytes, restoredAt, size, snapshot }) => {
            if (
              socket.readyState !== socket.OPEN ||
              viewer.controlSocket !== socket ||
              viewer.restoreGeneration !== restoreGeneration
            )
              return
            socket.send(
              serializeTerminalRestore(snapshot, size, state.sizeOwner, {
                outputBytes,
                restoredAt,
              })
            )
          })
          .catch(() => {
            if (
              socket.readyState !== socket.OPEN ||
              viewer.controlSocket !== socket ||
              viewer.restoreGeneration !== restoreGeneration
            )
              return
            socket.send(serializeTerminalRestore(''))
          })
      }
      socket.on('message', (raw) => {
        if (viewer.controlSocket !== socket) return
        try {
          const message = parseTerminalControlMessage(raw as Buffer | string)
          if (message.type === 'output_ack') viewer.flowState?.ack(message.bytes)
          if (message.type === 'restore_request') {
            resetRestoreBarrier(viewer, true)
            viewer.restoreRequested = true
            const restoreGeneration = viewer.restoreGeneration
            void buildRequestedRestoreSnapshot(
              runId,
              { cols: message.cols, rows: message.rows },
              message.scrollback
            )
              .then(({ outputBytes, restoredAt, size, snapshot }) => {
                if (
                  socket.readyState !== socket.OPEN ||
                  viewer.controlSocket !== socket ||
                  viewer.restoreGeneration !== restoreGeneration
                )
                  return
                socket.send(
                  serializeTerminalRestore(snapshot, size, state.sizeOwner, {
                    outputBytes,
                    requestId: message.requestId,
                    restoredAt,
                  })
                )
              })
              .catch(() => {
                if (
                  socket.readyState !== socket.OPEN ||
                  viewer.controlSocket !== socket ||
                  viewer.restoreGeneration !== restoreGeneration
                )
                  return
                socket.send(
                  serializeTerminalRestore('', undefined, state.sizeOwner, {
                    requestId: message.requestId,
                  })
                )
              })
          }
          if (message.type === 'resize') {
            if (viewerOwnsTerminal(state, clientId)) {
              resizeRun(runId, state, { cols: message.cols, rows: message.rows })
            }
          }
          if (message.type === 'takeover_reclaim') {
            if (mode === 'active') {
              reclaimTakeover(runId, state, clientId, { cols: message.cols, rows: message.rows })
            }
          }
          if (message.type === 'takeover_heartbeat') {
            renewTakeoverLease(state, clientId)
          }
          if (message.type === 'takeover_request') {
            if (mode !== 'takeover') {
              socket.send(
                serializeTerminalTakeoverDenied('Viewer is not connected in takeover mode')
              )
              return
            }
            const owner = state.sizeOwner
            if (owner?.mode === 'mobile_takeover' && owner.clientId !== clientId) {
              socket.send(
                serializeTerminalTakeoverDenied('Terminal size is owned by another viewer')
              )
              return
            }
            const previousSize = state.canonicalSize ?? state.canonicalMirror.getSize()
            resizeRun(runId, state, { cols: message.cols, rows: message.rows })
            state.sizeOwner = {
              acquiredAt: Date.now(),
              clientId,
              expiresAt: Date.now() + takeoverLeaseMs,
              mode: 'mobile_takeover',
              previousSize,
              restoreOnRelease: message.restoreOnRelease,
            }
            startTakeoverLeaseWatcher(runId, state)
            socket.send(serializeTerminalTakeoverGranted(message.cols, message.rows, previousSize))
            broadcastSizeOwnerChanged(state)
          }
          if (message.type === 'takeover_release') {
            const releaseError = releaseTakeover(runId, state, clientId)
            if (releaseError) throw releaseError
          }
          if (message.type === 'stop') store.stopAgentRun(runId)
          if (message.type === 'restore_complete') {
            viewer.outputDeferred = false
            viewer.restoreRequested = false
            flushDeferredOutput(viewer)
            return
          }
        } catch (error) {
          socket.send(
            serializeTerminalError(
              error instanceof Error ? error.message : 'Invalid control message'
            )
          )
        }
      })
      socket.on('close', () => {
        if (viewer.controlSocket !== socket) return
        releaseTakeover(runId, state, clientId)
        viewer.controlSocket = null
        resetRestoreBarrier(viewer, false)
        cleanupViewer(runId, state, clientId)
      })
    },
    attachIo(runId, clientId, socket, _initialSize, mode = 'active', deferOutput = false) {
      const state = getOrCreateState(runId, mode)
      const viewer = getOrCreateViewer(state, clientId)
      const previousIoSocket = viewer.ioSocket
      viewer.mode = mode
      viewer.ioSocket = socket
      viewer.outputDeferred = viewer.outputDeferred || deferOutput
      viewer.flowState?.close()
      viewer.flowState = createTerminalOutputFlow(socket, {
        onBackpressureChange(backpressured) {
          if (!backpressured) {
            viewer.backpressured = false
            viewer.backpressureGeneration += 1
            clearViewerBackpressureTimer(viewer)
            return
          }
          if (viewer.ioSocket !== socket || viewer.backpressureTimer) return
          viewer.backpressured = true
          viewer.backpressureGeneration += 1
          const backpressureGeneration = viewer.backpressureGeneration
          viewer.backpressureTimer = setTimeout(() => {
            viewer.backpressureTimer = null
            setImmediate(() => {
              if (
                viewer.backpressured &&
                viewer.backpressureGeneration === backpressureGeneration &&
                viewer.ioSocket === socket
              )
                disconnectStalledViewer(viewer)
            })
          }, VIEWER_BACKPRESSURE_GRACE_MS)
          viewer.backpressureTimer.unref?.()
        },
      })
      if (previousIoSocket && previousIoSocket !== socket) previousIoSocket.close()
      flushDeferredOutput(viewer)
      socket.on('message', (raw, isBinary) => {
        if (viewer.ioSocket !== socket) return
        if (!viewerOwnsTerminal(state, clientId)) return
        try {
          store.writeRunInput(runId, normalizeTerminalInput(raw, isBinary))
        } catch (error) {
          socket.send(
            serializeTerminalError(error instanceof Error ? error.message : 'Terminal input failed')
          )
          socket.close()
        }
      })
      socket.on('close', () => {
        if (viewer.ioSocket !== socket) return
        viewer.ioSocket = null
        viewer.backpressured = false
        viewer.backpressureGeneration += 1
        clearViewerBackpressureTimer(viewer)
        viewer.flowState?.close()
        viewer.flowState = null
        resetRestoreBarrier(viewer, false)
        cleanupViewer(runId, state, clientId)
      })
    },
    close() {
      for (const [runId, state] of runStates) {
        state.outputUnsubscribe?.()
        state.canonicalMirror.dispose()
        if (state.exitInterval) clearInterval(state.exitInterval)
        if (state.takeoverLeaseInterval) clearInterval(state.takeoverLeaseInterval)
        for (const viewer of state.viewers.values()) {
          viewer.backpressured = false
          viewer.backpressureGeneration += 1
          clearViewerBackpressureTimer(viewer)
          viewer.flowState?.close()
          viewer.ioSocket?.close()
          viewer.controlSocket?.close()
        }
        runStates.delete(runId)
      }
    },
  }
}
