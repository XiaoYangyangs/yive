import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'

import { WebSocketServer } from 'ws'

import { normalizeRelayDeviceId, type PairingStore } from './pairing-store.js'
import type { RelayDesktopRuntimeStatus, RelayHub } from './relay-hub.js'

const rejectUpgrade = (
  socket: Parameters<Server['on']>[1] extends (...args: infer T) => void ? T[1] : never,
  status: string
) => {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`)
  socket.destroy()
}

const readRequiredParam = (url: URL, ...names: string[]) => {
  for (const name of names) {
    const value = url.searchParams.get(name)?.trim()
    if (value) return value
  }
  return null
}

const matchTerminalPath = (pathname: string) => {
  const match = /^\/ws\/terminal\/(?<runId>[^/]+)\/(?<stream>io|control)$/.exec(pathname)
  const groups = match?.groups
  if (!groups?.runId || !groups.stream) return null
  return {
    runId: decodeURIComponent(groups.runId),
    stream: groups.stream as 'control' | 'io',
  }
}

const getForwardedTerminalQuery = (url: URL): Record<string, string> => {
  const ignored = new Set([
    'desktop_id',
    'desktopId',
    'device_id',
    'deviceId',
    'pairing_token',
    'server',
    'token',
  ])
  const query: Record<string, string> = {}
  for (const [key, value] of url.searchParams.entries()) {
    if (!ignored.has(key)) query[key] = value
  }
  return query
}

const readDesktopRuntimeStatus = (url: URL): RelayDesktopRuntimeStatus | undefined => {
  const status = url.searchParams.get('runtime_status')
  return status === 'online' || status === 'offline' || status === 'unknown' ? status : undefined
}

const readDesktopFeatures = (url: URL): string[] =>
  (url.searchParams.get('features') ?? '')
    .split(',')
    .map((feature) => feature.trim())
    .filter(Boolean)

export const createRelayWebSocketRouter = (
  server: Server,
  hub: RelayHub,
  pairingStore: PairingStore,
  options: { requireDesktopBinding?: boolean | undefined } = {}
) => {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const terminalMatch = matchTerminalPath(url.pathname)
    if (url.pathname !== '/ws/desktop' && url.pathname !== '/ws/mobile' && !terminalMatch) {
      rejectUpgrade(socket, '404 Not Found')
      return
    }

    const token = readRequiredParam(url, 'pairing_token', 'token')
    const deviceId = normalizeRelayDeviceId(readRequiredParam(url, 'device_id'))
    if (!deviceId) {
      rejectUpgrade(socket, '400 Bad Request')
      return
    }
    const desktopId = normalizeRelayDeviceId(readRequiredParam(url, 'desktop_id'))
    if ((url.pathname === '/ws/mobile' || terminalMatch) && !desktopId) {
      rejectUpgrade(socket, '400 Bad Request')
      return
    }
    const connectionToken = pairingStore.getDeviceToken(token)
    if (
      url.pathname === '/ws/desktop' &&
      (connectionToken?.desktop_id || connectionToken?.device_kind === 'mobile')
    ) {
      rejectUpgrade(socket, '401 Unauthorized')
      return
    }
    if (
      (url.pathname === '/ws/mobile' || terminalMatch) &&
      connectionToken?.device_kind === 'desktop'
    ) {
      rejectUpgrade(socket, '401 Unauthorized')
      return
    }
    if (
      !pairingStore.validateConnectionTokenForDevice({
        ...(desktopId ? { desktopId } : {}),
        deviceId,
        requireDesktopBinding: Boolean(
          options.requireDesktopBinding && (url.pathname === '/ws/mobile' || terminalMatch)
        ),
        token,
      })
    ) {
      rejectUpgrade(socket, '401 Unauthorized')
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      if (url.pathname === '/ws/desktop') {
        hub.attachDesktop(deviceId, ws, {
          features: readDesktopFeatures(url),
          runtimeMessage: url.searchParams.get('runtime_message')?.trim(),
          runtimeStatus: readDesktopRuntimeStatus(url),
        })
        return
      }
      if (!desktopId) {
        ws.close(1008, 'Missing desktop_id')
        return
      }
      if (terminalMatch) {
        hub.attachTerminalProxy({
          desktopId,
          deviceId,
          proxyId: randomUUID(),
          query: getForwardedTerminalQuery(url),
          runId: terminalMatch.runId,
          socket: ws,
          stream: terminalMatch.stream,
        })
        return
      }
      hub.attachMobile(deviceId, desktopId, ws, {
        ...(connectionToken?.workspace_ids ? { workspaceIds: connectionToken.workspace_ids } : {}),
      })
    })
  })

  server.on('close', () => {
    hub.close()
    wss.close()
  })

  return {
    close() {
      hub.close()
      wss.close()
    },
  }
}
