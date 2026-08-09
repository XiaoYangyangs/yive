import type { IncomingMessage, Server } from 'node:http'

import type { WebSocket as WsSocket } from 'ws'
import { WebSocketServer } from 'ws'

import type { MobileConversationInvalidation, MobileEventsServerMessage } from '../shared/types.js'
import { getLocalRequestRejection } from './local-request-guard.js'
import { buildMobileSnapshot, MOBILE_HEARTBEAT_INTERVAL_MS } from './mobile-snapshot.js'
import type { RuntimeStore } from './runtime-store.js'
import {
  hasMobileWorkspaceAccess,
  type MobileAccessContext,
  readCookie,
  readMobileRelayAccessContext,
} from './ui-auth-helpers.js'

const MOBILE_EVENTS_PATH = '/ws/mobile/events'
const MOBILE_SNAPSHOT_BROADCAST_DEBOUNCE_MS = 100

const rejectUpgrade = (
  socket: Parameters<Server['on']>[1] extends (...args: infer T) => void ? T[1] : never,
  status: string
) => {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`)
  socket.destroy()
}

const isMobileEventsPath = (pathname: string) => pathname === MOBILE_EVENTS_PATH

export const createMobileEventsWebSocketServer = (server: Server, store: RuntimeStore) => {
  const wss = new WebSocketServer({ noServer: true })
  const sockets = new Map<WsSocket, { access: MobileAccessContext; request: IncomingMessage }>()
  let broadcastTimer: NodeJS.Timeout | undefined

  const validateUpgradeSession = (request: IncomingMessage): MobileAccessContext | null => {
    const cookieHeader = Array.isArray(request.headers.cookie)
      ? request.headers.cookie.join('; ')
      : request.headers.cookie
    const mobileToken = readCookie(cookieHeader, 'hive_mobile_token')
    if (store.validateMobileToken(mobileToken)) {
      return { kind: 'mobile-token', ...readMobileRelayAccessContext(request) }
    }
    const uiToken = readCookie(cookieHeader, 'hive_ui_token')
    return store.validateUiToken(uiToken)
      ? { kind: 'ui-cookie', ...readMobileRelayAccessContext(request) }
      : null
  }

  const sendSnapshot = (ws: WsSocket, request: IncomingMessage, access: MobileAccessContext) => {
    if (ws.readyState !== ws.OPEN) return
    const message: MobileEventsServerMessage = {
      snapshot: buildMobileSnapshot(request, store, access),
      type: 'mobile-snapshot',
    }
    ws.send(JSON.stringify(message))
  }

  const sendHeartbeat = (ws: WsSocket) => {
    if (ws.readyState !== ws.OPEN) return
    const message: MobileEventsServerMessage = {
      generated_at: Date.now(),
      type: 'mobile-heartbeat',
    }
    ws.send(JSON.stringify(message))
  }

  const broadcastSnapshot = () => {
    for (const [ws, { access, request }] of sockets) sendSnapshot(ws, request, access)
  }

  const broadcastConversationInvalidation = (event: MobileConversationInvalidation) => {
    const message = JSON.stringify(event)
    for (const [ws, { access }] of sockets) {
      if (ws.readyState !== ws.OPEN || !hasMobileWorkspaceAccess(access, event.workspace_id))
        continue
      ws.send(message)
    }
  }

  const handleRuntimeChange = (event?: MobileConversationInvalidation) => {
    if (event) {
      broadcastConversationInvalidation(event)
      return
    }
    if (broadcastTimer !== undefined) return
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined
      broadcastSnapshot()
    }, MOBILE_SNAPSHOT_BROADCAST_DEBOUNCE_MS)
    broadcastTimer.unref?.()
  }

  const disposeRuntimeChangeListener = store.registerRuntimeChangeListener(handleRuntimeChange)

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!isMobileEventsPath(url.pathname)) return
    if (getLocalRequestRejection(request)) {
      rejectUpgrade(socket, '403 Forbidden')
      return
    }
    const access = validateUpgradeSession(request)
    if (!access) {
      rejectUpgrade(socket, '401 Unauthorized')
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.set(ws, { access, request })
      const heartbeat = setInterval(() => {
        sendHeartbeat(ws)
      }, MOBILE_HEARTBEAT_INTERVAL_MS)
      heartbeat.unref?.()
      ws.on('close', () => {
        clearInterval(heartbeat)
        sockets.delete(ws)
      })
      setImmediate(() => {
        sendSnapshot(ws, request, access)
        sendHeartbeat(ws)
      })
    })
  })

  return {
    close: () => {
      disposeRuntimeChangeListener()
      if (broadcastTimer !== undefined) clearTimeout(broadcastTimer)
      broadcastTimer = undefined
      for (const socket of sockets.keys()) socket.close()
      sockets.clear()
      wss.close()
    },
  }
}

export { MOBILE_EVENTS_PATH }
