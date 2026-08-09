import type { WebSocket } from 'ws'

import type {
  RelayDesktopRuntimeStatus,
  RelayDesktopSupervisorStatus,
  RelayHubSnapshot,
} from '../shared/relay-types.js'
import { parseRelayEnvelope, type RelayEnvelope, serializeRelayError } from './protocol.js'

interface DesktopConnection {
  connectedAt: number
  deviceId: string
  features: string[]
  lastSeenAt: number
  runtimeMessage?: string | undefined
  runtimeStatus: RelayDesktopRuntimeStatus
  runtimeUpdatedAt: number
  socket: WebSocket
  supervisorPhase?: string | undefined
  supervisorStatus?: RelayDesktopSupervisorStatus | undefined
  supervisorUpdatedAt?: number | undefined
}

interface MobileConnection {
  connectedAt: number
  desktopId: string
  deviceId: string
  id: string
  lastSeenAt: number
  socket: WebSocket
  workspaceIds?: string[] | undefined
}

interface TerminalProxyConnection {
  desktopId: string
  deviceId: string
  lastSeenAt: number
  proxyId: string
  socket: WebSocket
  stream: 'control' | 'io'
}

interface HttpFileDownloadRequest {
  desktopId: string
  deviceId: string
  onChunk: (chunk: Buffer) => void
  onEnd: () => void
  onError: (error: Error) => void
  onHeaders: (headers: { mimeType: string; name: string; size?: number | undefined }) => void
  timeout: ReturnType<typeof setTimeout>
}

export type { RelayDesktopRuntimeStatus, RelayHubSnapshot } from '../shared/relay-types.js'

export interface RelayHubOptions {
  heartbeatIntervalMs?: number | undefined
  heartbeatTimeoutMs?: number | undefined
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 75_000
const MAX_RUNTIME_MESSAGE_LENGTH = 160
const BASE64_LIKE_PATTERN = /[A-Za-z0-9+/]{80,}={0,2}/gu
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu
const QUERY_TOKEN_PATTERN = /([?&](?:agent_token|pairing_token|token)=)[^&\s"'<>]+/giu
const TOKEN_ASSIGNMENT_PATTERN =
  /\b(HIVE_AGENT_TOKEN|agent_token|authorization|x-hive-agent-token)\b\s*[:=]\s*["']?[^"'\s,;)]+/giu
const UNIX_PATH_PATTERN = /(^|[\s("'=])\/(?:Users|home|mnt|private|tmp|var|Volumes)\/[^\s"'`<>]+/gu
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\s"'`<>]+/gu
const FORWARDABLE_RELAY_CHANNELS = new Set(['mobile_events', 'runtime', 'team'])
const RETIRED_WORKSPACE_TASK_ENVELOPE_TYPES = new Set([
  'list_workspace_tasks',
  'list_workspace_tasks_result',
  'save_workspace_tasks',
  'save_workspace_tasks_result',
])
const MAX_DESKTOP_FEATURES = 20
const MAX_DESKTOP_FEATURE_LENGTH = 64
const SAFE_SUPERVISOR_PHASES = new Set([
  'checked',
  'relay_connect_started',
  'running',
  'runtime_started',
  'stopped',
  'stopping',
])

const stripControlCharacters = (value: string): string =>
  Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join('')

export const sanitizeRelayRuntimeMessage = (message: string | undefined): string | undefined => {
  const trimmed = message?.trim()
  if (!trimmed) return undefined
  const sanitized = stripControlCharacters(trimmed)
    .replace(TOKEN_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=[redacted]`)
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [redacted]')
    .replace(QUERY_TOKEN_PATTERN, '$1[redacted]')
    .replace(WINDOWS_PATH_PATTERN, '[local path]')
    .replace(UNIX_PATH_PATTERN, '$1[local path]')
    .replace(BASE64_LIKE_PATTERN, '[redacted base64]')
    .trim()
  if (!sanitized) return undefined
  return sanitized.slice(0, MAX_RUNTIME_MESSAGE_LENGTH)
}

const sendJson = (socket: WebSocket, payload: string) => {
  if (socket.readyState === socket.OPEN) socket.send(payload)
}

const isForwardableRelayChannel = (channel: string) => FORWARDABLE_RELAY_CHANNELS.has(channel)
const isRetiredWorkspaceTaskEnvelope = (type: string) =>
  RETIRED_WORKSPACE_TASK_ENVELOPE_TYPES.has(type)
const hasRelayRequestId = (envelope: RelayEnvelope) =>
  typeof envelope.request_id === 'string' && envelope.request_id.trim().length > 0

const sanitizeDesktopFeatures = (features: string[] | undefined): string[] =>
  Array.from(
    new Set(
      (features ?? [])
        .map((feature) => feature.trim())
        .filter(
          (feature) =>
            feature.length > 0 &&
            feature.length <= MAX_DESKTOP_FEATURE_LENGTH &&
            /^[a-z0-9_.:-]+$/iu.test(feature)
        )
    )
  ).slice(0, MAX_DESKTOP_FEATURES)

const sanitizeSupervisorPhase = (phase: unknown): string | undefined => {
  if (typeof phase !== 'string') return undefined
  const sanitized = phase.trim()
  return SAFE_SUPERVISOR_PHASES.has(sanitized) ? sanitized : undefined
}

const parseSupervisorStatus = (value: unknown): RelayDesktopSupervisorStatus | undefined =>
  value === 'running' || value === 'stale' || value === 'missing' || value === 'error'
    ? value
    : undefined

const encodeProxyData = (raw: WebSocket.RawData): { data: string; encoding: 'base64' | 'utf8' } => {
  if (typeof raw === 'string') return { data: raw, encoding: 'utf8' }
  if (Buffer.isBuffer(raw)) return { data: raw.toString('base64'), encoding: 'base64' }
  if (Array.isArray(raw)) return { data: Buffer.concat(raw).toString('base64'), encoding: 'base64' }
  return { data: Buffer.from(raw).toString('base64'), encoding: 'base64' }
}

export class RelayHub {
  private readonly desktops = new Map<string, DesktopConnection>()
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private readonly heartbeatTimeoutMs: number
  private readonly mobiles = new Map<string, MobileConnection>()
  private readonly mobileRequests = new Map<string, MobileConnection>()
  private readonly httpFileDownloads = new Map<string, HttpFileDownloadRequest>()
  private nextHttpFileDownloadId = 0
  private nextMobileConnectionId = 0
  private readonly terminalProxies = new Map<string, TerminalProxyConnection>()

  constructor(options: RelayHubOptions = {}) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
    if (this.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.checkHeartbeats()
      }, this.heartbeatIntervalMs)
      this.heartbeatTimer.unref?.()
    }
  }

  attachDesktop(
    deviceId: string,
    socket: WebSocket,
    runtime: {
      features?: string[] | undefined
      runtimeMessage?: string | undefined
      runtimeStatus?: RelayDesktopRuntimeStatus | undefined
    } = {}
  ) {
    this.replaceExisting(this.desktops.get(deviceId)?.socket)
    const now = Date.now()
    const runtimeMessage = sanitizeRelayRuntimeMessage(runtime.runtimeMessage)
    const connection = {
      connectedAt: now,
      deviceId,
      features: sanitizeDesktopFeatures(runtime.features),
      lastSeenAt: now,
      ...(runtimeMessage ? { runtimeMessage } : {}),
      runtimeStatus: runtime.runtimeStatus ?? 'unknown',
      runtimeUpdatedAt: now,
      socket,
    }
    this.desktops.set(deviceId, connection)

    socket.on('pong', () => {
      connection.lastSeenAt = Date.now()
    })
    socket.on('message', (raw) => {
      this.handleDesktopMessage(connection, raw as Buffer | string)
    })
    socket.on('close', () => {
      if (this.desktops.get(deviceId)?.socket === socket) {
        this.desktops.delete(deviceId)
        this.failHttpFileDownloadsForDesktop(deviceId, 'Desktop peer disconnected')
        this.closeTerminalProxiesForDesktop(deviceId, 1011, 'Desktop peer disconnected')
        this.closeMobilesForDesktop(deviceId, 1011, 'Desktop peer disconnected')
      }
    })
  }

  attachMobile(
    deviceId: string,
    desktopId: string,
    socket: WebSocket,
    options: { workspaceIds?: string[] | undefined } = {}
  ) {
    const now = Date.now()
    const connection = {
      connectedAt: now,
      desktopId,
      deviceId,
      id: `${deviceId}:${++this.nextMobileConnectionId}`,
      lastSeenAt: now,
      socket,
      ...(options.workspaceIds ? { workspaceIds: options.workspaceIds } : {}),
    }
    this.mobiles.set(connection.id, connection)

    socket.on('pong', () => {
      connection.lastSeenAt = Date.now()
    })
    socket.on('message', (raw) => {
      this.handleMobileMessage(connection, raw as Buffer | string)
    })
    socket.on('close', () => {
      if (this.mobiles.get(connection.id)?.socket === socket) {
        this.mobiles.delete(connection.id)
        this.deleteMobileRequestRoutes(connection)
        this.failHttpFileDownloadsForMobile(connection.deviceId, 'Mobile peer disconnected')
      }
    })
  }

  attachTerminalProxy({
    desktopId,
    deviceId,
    proxyId,
    query,
    runId,
    socket,
    stream,
  }: {
    desktopId: string
    deviceId: string
    proxyId: string
    query: Record<string, string>
    runId: string
    socket: WebSocket
    stream: 'control' | 'io'
  }) {
    const desktop = this.desktops.get(desktopId)
    if (!desktop) {
      socket.close(1011, 'Desktop peer is offline')
      return
    }

    const connection: TerminalProxyConnection = {
      desktopId,
      deviceId,
      lastSeenAt: Date.now(),
      proxyId,
      socket,
      stream,
    }
    this.terminalProxies.set(proxyId, connection)
    sendJson(
      desktop.socket,
      JSON.stringify({
        type: 'terminal_proxy_open',
        request_id: proxyId,
        from: 'relay',
        to: desktopId,
        channel: 'terminal_proxy',
        payload: { device_id: deviceId, proxy_id: proxyId, query, run_id: runId, stream },
      })
    )

    socket.on('message', (raw) => {
      connection.lastSeenAt = Date.now()
      const targetDesktop = this.desktops.get(desktopId)
      if (!targetDesktop) {
        socket.close(1011, 'Desktop peer is offline')
        return
      }
      const encoded = encodeProxyData(raw as WebSocket.RawData)
      sendJson(
        targetDesktop.socket,
        JSON.stringify({
          type: 'terminal_proxy_data',
          request_id: proxyId,
          from: 'relay',
          to: desktopId,
          channel: 'terminal_proxy',
          payload: {
            ...encoded,
            proxy_id: proxyId,
          },
        })
      )
    })
    socket.on('pong', () => {
      connection.lastSeenAt = Date.now()
    })
    socket.on('close', () => {
      if (this.terminalProxies.get(proxyId)?.socket === socket) {
        this.terminalProxies.delete(proxyId)
        const targetDesktop = this.desktops.get(desktopId)
        if (targetDesktop) {
          sendJson(
            targetDesktop.socket,
            JSON.stringify({
              type: 'terminal_proxy_close',
              request_id: proxyId,
              from: 'relay',
              to: desktopId,
              channel: 'terminal_proxy',
              payload: { proxy_id: proxyId },
            })
          )
        }
      }
    })
  }

  snapshot(): RelayHubSnapshot {
    return {
      desktopCount: this.desktops.size,
      desktops: Array.from(this.desktops.values()).map((desktop) => ({
        connected_at: desktop.connectedAt,
        device_id: desktop.deviceId,
        ...(desktop.features.length > 0 ? { features: desktop.features } : {}),
        last_seen_at: desktop.lastSeenAt,
        ...(desktop.runtimeMessage ? { runtime_message: desktop.runtimeMessage } : {}),
        runtime_status: desktop.runtimeStatus,
        runtime_updated_at: desktop.runtimeUpdatedAt,
        ...(desktop.supervisorPhase ? { supervisor_phase: desktop.supervisorPhase } : {}),
        ...(desktop.supervisorStatus ? { supervisor_status: desktop.supervisorStatus } : {}),
        ...(typeof desktop.supervisorUpdatedAt === 'number'
          ? { supervisor_updated_at: desktop.supervisorUpdatedAt }
          : {}),
      })),
      mobileCount: this.mobiles.size,
      mobiles: Array.from(this.mobiles.values()).map((mobile) => ({
        connected_at: mobile.connectedAt,
        desktop_id: mobile.desktopId,
        device_id: mobile.deviceId,
        last_seen_at: mobile.lastSeenAt,
      })),
      terminalProxyCount: this.terminalProxies.size,
    }
  }

  settingsSnapshot() {
    return {
      heartbeat_interval_ms: this.heartbeatIntervalMs,
      heartbeat_timeout_ms: this.heartbeatTimeoutMs,
    }
  }

  streamMobileFileDownload({
    desktopId,
    deviceId,
    fileId,
    chatAttachment,
    onChunk,
    onEnd,
    onHeaders,
    timeoutMs = 10 * 60 * 1000,
    workspaceIds,
  }: {
    desktopId: string
    deviceId: string
    fileId: string
    chatAttachment?: { submissionId: string; workspaceId: string } | undefined
    onChunk: (chunk: Buffer) => void
    onEnd: () => void
    onHeaders: (headers: { mimeType: string; name: string; size?: number | undefined }) => void
    timeoutMs?: number | undefined
    workspaceIds?: string[] | undefined
  }): Promise<void> {
    const desktop = this.desktops.get(desktopId)
    if (!desktop) throw new Error('Desktop peer is offline')
    if (desktop.runtimeStatus === 'offline') {
      throw new Error(desktop.runtimeMessage ?? 'Desktop runtime unavailable')
    }

    const requestId = `http-file-${Date.now()}-${++this.nextHttpFileDownloadId}`
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timeout)
        this.httpFileDownloads.delete(requestId)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const timeout = setTimeout(() => {
        fail(new Error('Relay file download timed out'))
      }, timeoutMs)
      timeout.unref?.()

      this.httpFileDownloads.set(requestId, {
        desktopId,
        deviceId,
        onChunk,
        onEnd: () => {
          if (settled) return
          settled = true
          cleanup()
          onEnd()
          resolve()
        },
        onError: fail,
        onHeaders,
        timeout,
      })

      sendJson(
        desktop.socket,
        JSON.stringify({
          type: 'download_mobile_file_stream',
          request_id: requestId,
          from: deviceId,
          to: desktopId,
          channel: 'runtime',
          ...(workspaceIds ? { relay_context: { workspace_ids: workspaceIds } } : {}),
          payload: {
            file_id: fileId,
            ...(chatAttachment
              ? {
                  submission_id: chatAttachment.submissionId,
                  workspace_id: chatAttachment.workspaceId,
                }
              : {}),
          },
        })
      )
    })
  }

  close() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    for (const desktop of this.desktops.values()) desktop.socket.close()
    for (const mobile of this.mobiles.values()) mobile.socket.close()
    for (const proxy of this.terminalProxies.values()) proxy.socket.close()
    this.desktops.clear()
    this.mobiles.clear()
    this.mobileRequests.clear()
    for (const request of this.httpFileDownloads.values()) {
      clearTimeout(request.timeout)
      request.onError(new Error('Relay server closed'))
    }
    this.httpFileDownloads.clear()
    this.terminalProxies.clear()
  }

  disconnectDevice(deviceId: string, code = 4001, reason = 'Relay device token revoked') {
    const desktop = this.desktops.get(deviceId)
    if (desktop) {
      this.desktops.delete(deviceId)
      this.failHttpFileDownloadsForDesktop(deviceId, reason)
      this.closeSocket(desktop.socket, code, reason)
      this.closeTerminalProxiesForDesktop(deviceId, code, reason)
      for (const mobile of Array.from(this.mobiles.values())) {
        if (mobile.desktopId !== deviceId) continue
        this.mobiles.delete(mobile.id)
        this.deleteMobileRequestRoutes(mobile)
        this.closeSocket(mobile.socket, code, reason)
      }
    }

    for (const mobile of Array.from(this.mobiles.values())) {
      if (mobile.deviceId !== deviceId) continue
      this.mobiles.delete(mobile.id)
      this.deleteMobileRequestRoutes(mobile)
      this.failHttpFileDownloadsForMobile(mobile.deviceId, reason)
      this.closeSocket(mobile.socket, code, reason)
    }

    for (const proxy of Array.from(this.terminalProxies.values())) {
      if (proxy.deviceId !== deviceId && proxy.desktopId !== deviceId) continue
      this.terminalProxies.delete(proxy.proxyId)
      this.closeSocket(proxy.socket, code, reason)
      const targetDesktop = this.desktops.get(proxy.desktopId)
      if (targetDesktop) {
        sendJson(
          targetDesktop.socket,
          JSON.stringify({
            type: 'terminal_proxy_close',
            request_id: proxy.proxyId,
            from: 'relay',
            to: proxy.desktopId,
            channel: 'terminal_proxy',
            payload: { code, proxy_id: proxy.proxyId, reason },
          })
        )
      }
    }
  }

  private replaceExisting(socket: WebSocket | undefined) {
    if (socket && socket.readyState === socket.OPEN)
      socket.close(4000, 'Replaced by new relay peer')
  }

  private closeSocket(socket: WebSocket, code: number, reason: string) {
    if (socket.readyState === socket.OPEN) socket.close(code, reason.slice(0, 123))
  }

  private deleteMobileRequestRoutes(connection: MobileConnection) {
    for (const [requestId, mobile] of Array.from(this.mobileRequests.entries())) {
      if (mobile === connection) this.mobileRequests.delete(requestId)
    }
  }

  private findMobileConnection(deviceId: string, desktopId: string): MobileConnection | undefined {
    return Array.from(this.mobiles.values())
      .reverse()
      .find((mobile) => mobile.deviceId === deviceId && mobile.desktopId === desktopId)
  }

  private checkHeartbeats(now = Date.now()) {
    for (const desktop of Array.from(this.desktops.values())) {
      if (now - desktop.lastSeenAt > this.heartbeatTimeoutMs) {
        this.disconnectDevice(desktop.deviceId, 4002, 'Relay heartbeat timed out')
        continue
      }
      this.pingSocket(desktop.socket)
    }

    for (const mobile of Array.from(this.mobiles.values())) {
      if (now - mobile.lastSeenAt > this.heartbeatTimeoutMs) {
        this.disconnectDevice(mobile.deviceId, 4002, 'Relay heartbeat timed out')
        continue
      }
      this.pingSocket(mobile.socket)
    }

    for (const proxy of Array.from(this.terminalProxies.values())) {
      if (now - proxy.lastSeenAt > this.heartbeatTimeoutMs) {
        this.terminalProxies.delete(proxy.proxyId)
        this.closeSocket(proxy.socket, 4002, 'Relay heartbeat timed out')
        continue
      }
      this.pingSocket(proxy.socket)
    }
  }

  private pingSocket(socket: WebSocket) {
    if (socket.readyState !== socket.OPEN) return
    try {
      socket.ping()
    } catch {
      this.closeSocket(socket, 4002, 'Relay heartbeat failed')
    }
  }

  private failHttpFileDownloadsForDesktop(desktopId: string, message: string) {
    for (const [requestId, request] of Array.from(this.httpFileDownloads.entries())) {
      if (request.desktopId !== desktopId) continue
      this.httpFileDownloads.delete(requestId)
      clearTimeout(request.timeout)
      request.onError(new Error(message))
    }
  }

  private failHttpFileDownloadsForMobile(deviceId: string, message: string) {
    for (const [requestId, request] of Array.from(this.httpFileDownloads.entries())) {
      if (request.deviceId !== deviceId) continue
      this.httpFileDownloads.delete(requestId)
      clearTimeout(request.timeout)
      request.onError(new Error(message))
    }
  }

  private handleDesktopMessage(connection: DesktopConnection, raw: Buffer | string) {
    connection.lastSeenAt = Date.now()
    let envelope: RelayEnvelope
    try {
      envelope = parseRelayEnvelope(raw)
    } catch (error) {
      sendJson(
        connection.socket,
        serializeRelayError({
          code: 'invalid_envelope',
          message: error instanceof Error ? error.message : 'Invalid relay envelope',
          to: connection.deviceId,
        })
      )
      return
    }

    if (envelope.from !== connection.deviceId) {
      sendJson(
        connection.socket,
        serializeRelayError({
          channel: envelope.channel,
          code: 'from_mismatch',
          message: 'Envelope from does not match desktop connection device id',
          requestId: envelope.request_id,
          to: connection.deviceId,
        })
      )
      return
    }

    if (envelope.type === 'desktop_status') {
      this.updateDesktopStatus(connection, envelope.payload)
      return
    }

    if (envelope.channel === 'terminal_proxy') {
      this.handleDesktopTerminalProxyMessage(connection, envelope)
      return
    }

    if (envelope.request_id && this.handleDesktopHttpFileDownloadMessage(connection, envelope)) {
      return
    }

    if (!isForwardableRelayChannel(envelope.channel)) {
      sendJson(
        connection.socket,
        serializeRelayError({
          channel: envelope.channel,
          code: 'unknown_channel',
          message: `Relay channel is not supported: ${envelope.channel}`,
          requestId: envelope.request_id,
          to: connection.deviceId,
        })
      )
      return
    }

    if (!hasRelayRequestId(envelope)) {
      sendJson(
        connection.socket,
        serializeRelayError({
          channel: envelope.channel,
          code: 'missing_request_id',
          message: 'Relay envelope request_id is required',
          to: connection.deviceId,
        })
      )
      return
    }

    if (isRetiredWorkspaceTaskEnvelope(envelope.type)) {
      sendJson(
        connection.socket,
        serializeRelayError({
          channel: envelope.channel,
          code: 'not_implemented',
          message: `Relay request is not implemented: ${envelope.type}`,
          requestId: envelope.request_id,
          to: connection.deviceId,
        })
      )
      return
    }

    const mobile =
      envelope.request_id && this.mobileRequests.get(envelope.request_id)
        ? this.mobileRequests.get(envelope.request_id)
        : this.findMobileConnection(envelope.to, connection.deviceId)
    if (!mobile || mobile.desktopId !== connection.deviceId) {
      sendJson(
        connection.socket,
        serializeRelayError({
          channel: envelope.channel,
          code: 'mobile_offline',
          message: 'Mobile peer is offline or not paired with this desktop',
          requestId: envelope.request_id,
          to: connection.deviceId,
        })
      )
      return
    }

    sendJson(mobile.socket, JSON.stringify(envelope))
    if (
      envelope.request_id &&
      (envelope.channel !== 'mobile_events' || envelope.type === 'mobile_events_close')
    ) {
      this.mobileRequests.delete(envelope.request_id)
    }
  }

  private handleDesktopHttpFileDownloadMessage(
    connection: DesktopConnection,
    envelope: RelayEnvelope
  ): boolean {
    const requestId = envelope.request_id
    if (!requestId) return false
    const request = this.httpFileDownloads.get(requestId)
    if (!request) return false
    if (request.desktopId !== connection.deviceId) {
      request.onError(new Error('Relay file download desktop mismatch'))
      return true
    }
    const payload = envelope.payload
    if (envelope.type === 'relay_error') {
      const payloadRecord = payload as Record<string, unknown>
      const message =
        typeof payload === 'object' && payload !== null && typeof payloadRecord.message === 'string'
          ? payloadRecord.message
          : 'Relay file download failed'
      request.onError(new Error(message))
      return true
    }
    if (typeof payload !== 'object' || payload === null) {
      request.onError(new Error('Invalid relay file download response'))
      return true
    }
    const record = payload as Record<string, unknown>
    if (envelope.type === 'download_mobile_file_stream_headers') {
      const mimeType =
        typeof record.mime_type === 'string' && record.mime_type.trim()
          ? record.mime_type
          : 'application/octet-stream'
      const name = typeof record.name === 'string' && record.name.trim() ? record.name : 'download'
      const size =
        typeof record.size === 'number' && Number.isFinite(record.size)
          ? Math.max(0, Math.floor(record.size))
          : undefined
      request.onHeaders({
        mimeType,
        name,
        ...(size !== undefined ? { size } : {}),
      })
      return true
    }
    if (envelope.type === 'download_mobile_file_stream_chunk') {
      if (typeof record.content_base64 !== 'string') {
        request.onError(new Error('Invalid relay file download chunk'))
        return true
      }
      request.onChunk(Buffer.from(record.content_base64, 'base64'))
      return true
    }
    if (envelope.type === 'download_mobile_file_stream_end') {
      request.onEnd()
      return true
    }
    return true
  }

  private updateDesktopStatus(connection: DesktopConnection, payload: unknown) {
    if (typeof payload !== 'object' || payload === null) return
    const record = payload as Record<string, unknown>
    const status = record.runtime_status
    if (status !== 'online' && status !== 'offline' && status !== 'unknown') return
    connection.runtimeStatus = status
    connection.runtimeMessage =
      typeof record.runtime_message === 'string'
        ? sanitizeRelayRuntimeMessage(record.runtime_message)
        : undefined
    connection.supervisorStatus = parseSupervisorStatus(record.supervisor_status)
    connection.supervisorPhase = sanitizeSupervisorPhase(record.supervisor_phase)
    connection.supervisorUpdatedAt =
      typeof record.supervisor_updated_at === 'number' &&
      Number.isFinite(record.supervisor_updated_at) &&
      record.supervisor_updated_at > 0
        ? record.supervisor_updated_at
        : undefined
    connection.runtimeUpdatedAt = Date.now()
  }

  private handleMobileMessage(connection: MobileConnection, raw: Buffer | string) {
    connection.lastSeenAt = Date.now()
    let envelope: RelayEnvelope
    try {
      envelope = parseRelayEnvelope(raw)
    } catch (error) {
      sendJson(
        connection.socket,
        serializeRelayError({
          code: 'invalid_envelope',
          message: error instanceof Error ? error.message : 'Invalid relay envelope',
          to: connection.deviceId,
        })
      )
      return
    }

    if (envelope.from !== connection.deviceId) {
      sendJson(
        connection.socket,
        serializeRelayError({
          channel: envelope.channel,
          code: 'from_mismatch',
          message: 'Envelope from does not match mobile connection device id',
          requestId: envelope.request_id,
          to: connection.deviceId,
        })
      )
      return
    }

    if (!isForwardableRelayChannel(envelope.channel)) {
      sendJson(
        connection.socket,
        serializeRelayError({
          channel: envelope.channel,
          code: 'unknown_channel',
          desktopId: connection.desktopId,
          message: `Relay channel is not supported: ${envelope.channel}`,
          requestId: envelope.request_id,
          to: connection.deviceId,
        })
      )
      return
    }

    if (!hasRelayRequestId(envelope)) {
      sendJson(
        connection.socket,
        serializeRelayError({
          channel: envelope.channel,
          code: 'missing_request_id',
          desktopId: connection.desktopId,
          message: 'Relay envelope request_id is required',
          to: connection.deviceId,
        })
      )
      return
    }

    if (isRetiredWorkspaceTaskEnvelope(envelope.type)) {
      sendJson(
        connection.socket,
        serializeRelayError({
          channel: envelope.channel,
          code: 'not_implemented',
          desktopId: connection.desktopId,
          message: `Relay request is not implemented: ${envelope.type}`,
          requestId: envelope.request_id,
          to: connection.deviceId,
        })
      )
      return
    }

    const desktop = this.desktops.get(connection.desktopId)
    if (!desktop || envelope.to !== connection.desktopId) {
      sendJson(
        connection.socket,
        serializeRelayError({
          channel: envelope.channel,
          code: 'desktop_offline',
          desktopId: connection.desktopId,
          message: 'Desktop peer is offline',
          requestId: envelope.request_id,
          to: connection.deviceId,
        })
      )
      return
    }

    if (envelope.channel === 'runtime' && desktop.runtimeStatus === 'offline') {
      sendJson(
        connection.socket,
        serializeRelayError({
          channel: envelope.channel,
          code: 'desktop_runtime_unavailable',
          desktopId: connection.desktopId,
          message: desktop.runtimeMessage ?? 'Desktop runtime unavailable',
          requestId: envelope.request_id,
          to: connection.deviceId,
        })
      )
      return
    }

    const requestId = envelope.request_id
    if (!requestId) return
    this.mobileRequests.set(requestId, connection)
    sendJson(desktop.socket, JSON.stringify(envelope))
  }

  private handleDesktopTerminalProxyMessage(
    connection: DesktopConnection,
    envelope: RelayEnvelope
  ) {
    const payload = envelope.payload
    if (typeof payload !== 'object' || payload === null) return
    const proxyId = (payload as Record<string, unknown>).proxy_id
    if (typeof proxyId !== 'string') return
    const proxy = this.terminalProxies.get(proxyId)
    if (!proxy || proxy.desktopId !== connection.deviceId) return

    if (envelope.type === 'terminal_proxy_data') {
      const data = (payload as Record<string, unknown>).data
      const encoding = (payload as Record<string, unknown>).encoding
      if (typeof data !== 'string') return
      if (encoding === 'base64') {
        if (proxy.socket.readyState === proxy.socket.OPEN)
          proxy.socket.send(Buffer.from(data, 'base64'))
        return
      }
      if (proxy.socket.readyState === proxy.socket.OPEN) proxy.socket.send(data)
      return
    }

    if (envelope.type === 'terminal_proxy_close') {
      const code = (payload as Record<string, unknown>).code
      const reason = (payload as Record<string, unknown>).reason
      if (proxy.socket.readyState === proxy.socket.OPEN) {
        proxy.socket.close(
          typeof code === 'number' && Number.isInteger(code) ? code : 1000,
          typeof reason === 'string' ? reason.slice(0, 123) : undefined
        )
      }
      this.terminalProxies.delete(proxyId)
    }
  }

  private closeTerminalProxiesForDesktop(desktopId: string, code: number, reason: string) {
    for (const proxy of Array.from(this.terminalProxies.values())) {
      if (proxy.desktopId !== desktopId) continue
      this.terminalProxies.delete(proxy.proxyId)
      if (proxy.socket.readyState === proxy.socket.OPEN) proxy.socket.close(code, reason)
    }
  }

  private closeMobilesForDesktop(desktopId: string, code: number, reason: string) {
    for (const mobile of Array.from(this.mobiles.values())) {
      if (mobile.desktopId !== desktopId) continue
      this.mobiles.delete(mobile.id)
      this.deleteMobileRequestRoutes(mobile)
      this.closeSocket(mobile.socket, code, reason)
    }
  }
}
