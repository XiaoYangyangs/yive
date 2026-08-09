import { parseMobileEventsServerMessage } from '../../../src/shared/mobile-events.js'
import type {
  AgentSummary,
  MobileConversationInvalidation,
  MobileSnapshot,
  TeamListItem,
  TerminalRunSummary,
} from '../../../src/shared/types.js'
import { fromAgentRuntimeStatePayload, fromMobileSnapshotWorkerPayload } from '../agent-payload.js'

export type { MobileSnapshot } from '../../../src/shared/types.js'

interface MobileEventsWebSocketLike {
  close: () => void
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onopen: ((event: Event) => void) | null
  readyState: number
}

type MobileEventsWebSocketConstructor = new (url: string) => MobileEventsWebSocketLike

export interface MobileEventsClientOptions {
  onConversationInvalidated?: (invalidation: MobileConversationInvalidation) => void
  onError?: (error: Error) => void
  onHeartbeat?: (generatedAt: number) => void
  onReconnect?: (meta: { attempt: number; nextDelayMs: number }) => void
  onSnapshot: (snapshot: MobileSnapshot) => void
  reconnectDelayMs?: number
  webSocketConstructor?: MobileEventsWebSocketConstructor
}

export interface MobileEventsClient {
  connect: () => void
  dispose: () => void
}

const DEFAULT_RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_DELAY_MS = 30_000
const SOCKET_CONNECTING = 0
const SOCKET_OPEN = 1

export const toMobileEventsWebSocketUrl = () => {
  const url = new URL('/ws/mobile/events', window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export const getMobileSnapshotDashboard = (
  snapshot: MobileSnapshot
): { orchestrator?: AgentSummary; runs: TerminalRunSummary[]; workers: TeamListItem[] } | null => {
  if (!snapshot.active_workspace) return null
  const orchestrator = snapshot.active_workspace.orchestrator
  return {
    ...(orchestrator
      ? {
          orchestrator: {
            ...fromAgentRuntimeStatePayload(orchestrator),
            id: orchestrator.id,
            kind: 'orchestrator',
            name: orchestrator.name,
            workspaceId: snapshot.active_workspace.workspace.id,
          },
        }
      : {}),
    runs: snapshot.active_workspace.terminal_runs,
    workers: snapshot.active_workspace.workers
      .filter((worker) => worker.kind === 'worker')
      .map(fromMobileSnapshotWorkerPayload),
  }
}

export const createMobileEventsClient = ({
  onConversationInvalidated,
  onError,
  onHeartbeat,
  onReconnect,
  onSnapshot,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  webSocketConstructor = WebSocket,
}: MobileEventsClientOptions): MobileEventsClient => {
  let disposed = false
  let reconnectAttempt = 0
  let reconnectTimer: number | undefined
  let socket: MobileEventsWebSocketLike | null = null

  const clearReconnectTimer = () => {
    if (reconnectTimer === undefined) return
    window.clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== undefined) return
    const attempt = reconnectAttempt + 1
    const nextDelayMs = Math.min(reconnectDelayMs * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS)
    reconnectAttempt = attempt
    onReconnect?.({ attempt, nextDelayMs })
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, nextDelayMs)
  }

  const connect = () => {
    if (disposed) return
    if (socket?.readyState === SOCKET_CONNECTING || socket?.readyState === SOCKET_OPEN) return
    clearReconnectTimer()
    const nextSocket = new webSocketConstructor(toMobileEventsWebSocketUrl())
    socket = nextSocket
    nextSocket.onopen = () => {
      reconnectAttempt = 0
    }
    nextSocket.onmessage = (event) => {
      const message = parseMobileEventsServerMessage(String(event.data))
      if (!message) return
      reconnectAttempt = 0
      if (message.type === 'mobile-snapshot') onSnapshot(message.snapshot)
      else if (message.type === 'conversation-invalidated') onConversationInvalidated?.(message)
      else onHeartbeat?.(message.generated_at)
    }
    nextSocket.onerror = () => {
      onError?.(new Error('Mobile events websocket failed'))
    }
    nextSocket.onclose = () => {
      if (socket === nextSocket) socket = null
      scheduleReconnect()
    }
  }

  return {
    connect,
    dispose() {
      disposed = true
      clearReconnectTimer()
      const currentSocket = socket
      socket = null
      if (typeof currentSocket?.close === 'function') currentSocket.close()
    },
  }
}
