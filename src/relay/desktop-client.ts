import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import WebSocket from 'ws'

import type {
  RelayDesktopRuntimeStatus,
  RelayDesktopSupervisorStatus,
} from '../shared/relay-types.js'
import { parseRelayEnvelope, type RelayEnvelope } from './protocol.js'

export interface RunRelayDesktopClientOptions {
  deviceId: string
  localRequestTimeoutMs?: number | undefined
  localRuntimeUrl?: string
  reconnectDelayMs?: number
  runtimeMessage?: string | undefined
  runtimeStatusIntervalMs?: number | undefined
  runtimeStatus?: RelayDesktopRuntimeStatus | undefined
  serverUrl: string
  signal?: AbortSignal | undefined
  token: string
}

export interface RelayDesktopRuntimeSnapshot {
  runtimeMessage?: string | undefined
  runtimeStatus: RelayDesktopRuntimeStatus
}

export interface RelayDesktopSupervisorSnapshot {
  supervisorPhase?: string | undefined
  supervisorStatus: RelayDesktopSupervisorStatus
  supervisorUpdatedAt?: number | undefined
}

const DEFAULT_RECONNECT_DELAY_MS = 2_000
const DEFAULT_LOCAL_RUNTIME_URL = 'http://127.0.0.1:3001'
const DEFAULT_LOCAL_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_RUNTIME_STATUS_INTERVAL_MS = 10_000
const DEFAULT_DESKTOP_SUPERVISOR_STATUS_FILE = join(
  homedir(),
  '.config',
  'yive',
  'desktop-relay-status.json'
)
const DESKTOP_SUPERVISOR_STALE_MS = 15_000
const SAFE_SUPERVISOR_PHASES = new Set([
  'checked',
  'relay_connect_started',
  'running',
  'runtime_started',
  'stopped',
  'stopping',
])
export const RELAY_DESKTOP_FEATURES = [
  'mobile_confirmations',
  'mobile_events',
  'mobile_file_exchange',
  'terminal_proxy',
] as const
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/u

const formatDelay = (valueMs: number): string => {
  if (valueMs < 1000) return `${valueMs}ms`
  const seconds = valueMs / 1000
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`
}

const serializeDesktopRelayError = (input: {
  channel?: string | undefined
  code: string
  desktopId: string
  message: string
  requestId?: string | undefined
  to: string
}): string => {
  const envelope: RelayEnvelope = {
    type: 'relay_error',
    from: input.desktopId,
    to: input.to,
    channel: input.channel ?? 'relay',
    payload: {
      code: input.code,
      message: input.message,
    },
  }
  if (input.requestId) envelope.request_id = input.requestId
  return JSON.stringify(envelope)
}

class LocalRuntimeRequestError extends Error {
  readonly code: string | undefined
  readonly statusCode: number

  constructor(statusCode: number, code: string | undefined, message: string) {
    super(message)
    this.name = 'LocalRuntimeRequestError'
    this.code = code
    this.statusCode = statusCode
  }
}

export const formatRelayDesktopConnectedMessage = ({
  deviceId,
  runtimeStatus,
  serverUrl,
}: {
  deviceId: string
  runtimeStatus: RelayDesktopRuntimeStatus
  serverUrl: string
}): string => `Yive desktop connected to ${serverUrl} as ${deviceId} (runtime: ${runtimeStatus})`

export const formatRelayDesktopReconnectMessage = ({
  code,
  reason,
  reconnectDelayMs,
  serverUrl,
}: {
  code?: number | undefined
  reason?: Buffer | string | undefined
  reconnectDelayMs: number
  serverUrl: string
}): string => {
  const reasonText =
    typeof reason === 'string'
      ? reason.trim()
      : Buffer.isBuffer(reason)
        ? reason.toString().trim()
        : ''
  const closeText = code ? `closed with ${code}${reasonText ? ` (${reasonText})` : ''}` : 'closed'
  return `Yive desktop relay ${closeText}; reconnecting to ${serverUrl} in ${formatDelay(
    reconnectDelayMs
  )}.`
}

export const normalizeRelayServerUrlForDesktop = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('Relay server URL is required')
  if (URL_SCHEME_PATTERN.test(trimmed)) return trimmed

  const authority = trimmed.split(/[/?#]/u, 1)[0]?.split('@').pop() ?? trimmed
  const host = authority.replace(/:\d+$/u, '').replace(/^\[/u, '').replace(/\]$/u, '')
  const shouldUseHttp =
    host === 'localhost' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(?:1[6-9]|2\d|3[0-1])\./u.test(host) ||
    IPV4_PATTERN.test(host)

  return `${shouldUseHttp ? 'http' : 'https'}://${trimmed}`
}

const trimTrailingSlash = (value: string) => value.replace(/\/+$/u, '')

const resolveRelayDesktopWebSocketUrl = (serverUrl: string, path: string): URL => {
  const base = new URL(normalizeRelayServerUrlForDesktop(serverUrl))
  const basePath = trimTrailingSlash(base.pathname === '/' ? '' : base.pathname)
  const url = new URL(`${basePath}${path}`, base.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}

export const toRelayDesktopWebSocketUrl = ({
  deviceId,
  runtimeMessage,
  runtimeStatus,
  serverUrl,
  token,
}: Pick<
  RunRelayDesktopClientOptions,
  'deviceId' | 'runtimeMessage' | 'runtimeStatus' | 'serverUrl' | 'token'
>) => {
  const url = resolveRelayDesktopWebSocketUrl(serverUrl, '/ws/desktop')
  url.searchParams.set('device_id', deviceId)
  url.searchParams.set('pairing_token', token)
  url.searchParams.set('features', RELAY_DESKTOP_FEATURES.join(','))
  if (runtimeStatus) url.searchParams.set('runtime_status', runtimeStatus)
  if (runtimeMessage) url.searchParams.set('runtime_message', runtimeMessage.slice(0, 200))
  return url.toString()
}

export const openRelayDesktopSocket = ({
  deviceId,
  runtimeMessage,
  runtimeStatus,
  serverUrl,
  token,
}: RunRelayDesktopClientOptions): WebSocket =>
  new WebSocket(
    toRelayDesktopWebSocketUrl({ deviceId, runtimeMessage, runtimeStatus, serverUrl, token })
  )

const fetchLocalRuntime = async (
  localRuntimeUrl: string,
  path: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_LOCAL_REQUEST_TIMEOUT_MS
) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(new URL(path, localRuntimeUrl), {
      ...init,
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Local runtime request timed out: ${path} (${formatDelay(timeoutMs)})`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const readCookieFromSetCookieHeader = (setCookie: string | null, name: string) =>
  setCookie
    ?.split(/,\s*(?=hive_[^=]+=)/u)
    .map((cookie) => cookie.split(';')[0])
    .find((cookie) => cookie?.startsWith(`${name}=`))

const getUiCookie = async (
  localRuntimeUrl: string,
  timeoutMs: number = DEFAULT_LOCAL_REQUEST_TIMEOUT_MS
) => {
  const response = await fetchLocalRuntime(localRuntimeUrl, '/api/ui/session', {}, timeoutMs)
  if (!response.ok) throw new Error(`Local runtime session failed: ${response.status}`)
  const cookie = readCookieFromSetCookieHeader(response.headers.get('set-cookie'), 'hive_ui_token')
  if (!cookie) throw new Error('Local runtime did not issue a UI session cookie')
  return cookie
}

const getMobileCookie = async (
  localRuntimeUrl: string,
  timeoutMs: number = DEFAULT_LOCAL_REQUEST_TIMEOUT_MS
) => {
  const response = await fetchLocalRuntime(localRuntimeUrl, '/api/ui/session', {}, timeoutMs)
  if (!response.ok) throw new Error(`Local runtime session failed: ${response.status}`)
  const cookie = readCookieFromSetCookieHeader(
    response.headers.get('set-cookie'),
    'hive_mobile_token'
  )
  if (!cookie) throw new Error('Local runtime did not issue a mobile session cookie')
  return cookie
}

export const readLocalRuntimeStatus = async (
  localRuntimeUrl: string = DEFAULT_LOCAL_RUNTIME_URL,
  timeoutMs: number = DEFAULT_LOCAL_REQUEST_TIMEOUT_MS
): Promise<RelayDesktopRuntimeSnapshot> => {
  try {
    await getUiCookie(localRuntimeUrl, timeoutMs)
    return { runtimeStatus: 'online' }
  } catch (error) {
    return {
      runtimeMessage: error instanceof Error ? error.message : 'Local runtime is unreachable',
      runtimeStatus: 'offline',
    }
  }
}

const readRecordField = (record: Record<string, unknown>, key: string) => record[key]

const stripJsonBom = (value: string) => (value.charCodeAt(0) === 0xfeff ? value.slice(1) : value)

const sanitizeSupervisorPhase = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const phase = value.trim()
  return SAFE_SUPERVISOR_PHASES.has(phase) ? phase : undefined
}

export const readDesktopSupervisorStatus = (
  statusFile = process.env.YIVE_RELAY_STATUS_FILE || DEFAULT_DESKTOP_SUPERVISOR_STATUS_FILE,
  nowMs = Date.now()
): RelayDesktopSupervisorSnapshot => {
  if (!existsSync(statusFile)) return { supervisorStatus: 'missing' }
  try {
    const parsed = JSON.parse(stripJsonBom(readFileSync(statusFile, 'utf8'))) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { supervisorStatus: 'error' }
    }
    const record = parsed as Record<string, unknown>
    const updatedAtValue = readRecordField(record, 'updated_at')
    const updatedAtMs = typeof updatedAtValue === 'string' ? Date.parse(updatedAtValue) : Number.NaN
    const supervisorUpdatedAt = Number.isNaN(updatedAtMs) ? undefined : updatedAtMs
    const stale =
      supervisorUpdatedAt === undefined ||
      Math.max(0, nowMs - supervisorUpdatedAt) > DESKTOP_SUPERVISOR_STALE_MS
    const supervisorPhase = sanitizeSupervisorPhase(readRecordField(record, 'phase'))
    return {
      ...(supervisorPhase ? { supervisorPhase } : {}),
      supervisorStatus: stale ? 'stale' : 'running',
      ...(supervisorUpdatedAt !== undefined ? { supervisorUpdatedAt } : {}),
    }
  } catch {
    return { supervisorStatus: 'error' }
  }
}

const getRequiredStringPayloadField = (
  payload: unknown,
  field: string,
  requestType: string
): string => {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`Invalid ${requestType} payload: expected object`)
  }
  const value = (payload as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid ${requestType} payload: ${field} is required`)
  }
  return value
}

const getOptionalStringPayloadField = (
  payload: unknown,
  field: string,
  requestType: string
): string | undefined => {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`Invalid ${requestType} payload: expected object`)
  }
  const value = (payload as Record<string, unknown>)[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid ${requestType} payload: ${field} must be a non-empty string`)
  }
  return value
}

interface LocalMobileRelayContext {
  desktopId: string
  mobileDeviceId: string
  workspaceIds?: string[] | undefined
}

const createLocalMobileRelayHeaders = ({
  desktopId,
  mobileDeviceId,
  workspaceIds,
}: LocalMobileRelayContext): Record<string, string> => ({
  'x-yive-relay-desktop-id': desktopId,
  'x-yive-relay-mobile-device-id': mobileDeviceId,
  ...(workspaceIds ? { 'x-yive-mobile-workspace-ids': workspaceIds.join(',') } : {}),
})

const fetchLocalJson = async (
  localRuntimeUrl: string,
  path: string,
  cookie: string,
  timeoutMs?: number | undefined,
  extraHeaders: Record<string, string> = {}
) => {
  const response = await fetchLocalRuntime(
    localRuntimeUrl,
    path,
    { headers: { ...extraHeaders, cookie } },
    timeoutMs
  )
  if (!response.ok) throw new Error(`Local runtime request failed: ${path} (${response.status})`)
  return response.json()
}

const sanitizeMobileFileItem = (item: unknown) => {
  if (typeof item !== 'object' || item === null) return item
  const record = item as Record<string, unknown>
  return {
    ...(typeof record.created_at === 'number' ? { created_at: record.created_at } : {}),
    ...(typeof record.expires_at === 'number' ? { expires_at: record.expires_at } : {}),
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.mime_type === 'string' ? { mime_type: record.mime_type } : {}),
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.size === 'number' ? { size: record.size } : {}),
    ...(record.source === 'uploaded' || record.source === 'workspace'
      ? { source: record.source }
      : {}),
    ...(typeof record.workspace_path === 'string' ? { workspace_path: record.workspace_path } : {}),
  }
}

const postLocalJson = async (
  localRuntimeUrl: string,
  path: string,
  cookie: string,
  body: unknown,
  timeoutMs?: number | undefined,
  extraHeaders: Record<string, string> = {}
) => {
  const response = await fetchLocalRuntime(
    localRuntimeUrl,
    path,
    {
      body: JSON.stringify(body),
      headers: { ...extraHeaders, 'content-type': 'application/json', cookie },
      method: 'POST',
    },
    timeoutMs
  )
  if (!response.ok) {
    let payload: { code?: unknown; error?: unknown } = {}
    try {
      payload = (await response.json()) as { code?: unknown; error?: unknown }
    } catch {
      // Fall back to the transport-level status when the Runtime sent no JSON body.
    }
    throw new LocalRuntimeRequestError(
      response.status,
      typeof payload.code === 'string' ? payload.code : undefined,
      `Local runtime request failed: ${path} (${response.status})`
    )
  }
  return response.json()
}

const deleteLocal = async (
  localRuntimeUrl: string,
  path: string,
  cookie: string,
  timeoutMs?: number | undefined,
  extraHeaders: Record<string, string> = {}
) => {
  const response = await fetchLocalRuntime(
    localRuntimeUrl,
    path,
    {
      headers: { ...extraHeaders, cookie },
      method: 'DELETE',
    },
    timeoutMs
  )
  if (!response.ok) throw new Error(`Local runtime request failed: ${path} (${response.status})`)
}

const parseDownloadName = (response: Response, fallback: string): string => {
  const disposition = response.headers.get('content-disposition') ?? ''
  const match = /filename="([^"]+)"/u.exec(disposition)
  return match?.[1] ?? fallback
}

const getLocalMobileFilePath = (fileId: string, payload?: unknown) => {
  const url = new URL(`/api/mobile/files/${encodeURIComponent(fileId)}`, 'http://127.0.0.1')
  if (typeof payload !== 'object' || payload === null) return `${url.pathname}${url.search}`
  const record = payload as Record<string, unknown>
  const workspaceId = typeof record.workspace_id === 'string' ? record.workspace_id.trim() : ''
  const submissionId = typeof record.submission_id === 'string' ? record.submission_id.trim() : ''
  if (Boolean(workspaceId) !== Boolean(submissionId)) {
    throw new Error('workspace_id and submission_id are required together')
  }
  if (workspaceId && submissionId) {
    url.searchParams.set('workspace_id', workspaceId)
    url.searchParams.set('submission_id', submissionId)
  }
  return `${url.pathname}${url.search}`
}

const downloadLocalMobileFile = async (
  localRuntimeUrl: string,
  fileId: string,
  cookie: string,
  timeoutMs?: number | undefined,
  extraHeaders: Record<string, string> = {},
  payload?: unknown
) => {
  const path = getLocalMobileFilePath(fileId, payload)
  const response = await fetchLocalRuntime(
    localRuntimeUrl,
    path,
    { headers: { ...extraHeaders, cookie } },
    timeoutMs
  )
  if (!response.ok) throw new Error(`Local runtime request failed: ${path} (${response.status})`)
  return {
    content_base64: Buffer.from(await response.arrayBuffer()).toString('base64'),
    mime_type: response.headers.get('content-type') ?? 'application/octet-stream',
    name: parseDownloadName(response, fileId),
  }
}

const toLocalTerminalWebSocketUrl = (
  localRuntimeUrl: string,
  runId: string,
  stream: 'control' | 'io',
  query: Record<string, string>
) => {
  const url = new URL(`/ws/terminal/${encodeURIComponent(runId)}/${stream}`, localRuntimeUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url.toString()
}

const toLocalMobileEventsWebSocketUrl = (localRuntimeUrl: string) => {
  const url = new URL('/ws/mobile/events', localRuntimeUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

const decodeProxyData = (payload: Record<string, unknown>): Buffer | string | null => {
  const data = payload.data
  if (typeof data !== 'string') return null
  return payload.encoding === 'base64' ? Buffer.from(data, 'base64') : data
}

const MAX_TERMINAL_PROXY_PENDING_MESSAGES = 64
const MAX_TERMINAL_PROXY_PENDING_BYTES = 256 * 1024

interface TerminalProxyState {
  pendingBytes: number
  pendingData: Array<Buffer | string>
  socket: WebSocket | null
}

const encodeProxyData = (raw: WebSocket.RawData): { data: string; encoding: 'base64' | 'utf8' } => {
  if (typeof raw === 'string') return { data: raw, encoding: 'utf8' }
  if (Buffer.isBuffer(raw)) return { data: raw.toString('base64'), encoding: 'base64' }
  if (Array.isArray(raw)) return { data: Buffer.concat(raw).toString('base64'), encoding: 'base64' }
  return { data: Buffer.from(raw).toString('base64'), encoding: 'base64' }
}

const formatUnexpectedTerminalProxyResponse = (
  response: { statusCode?: number | undefined; statusMessage?: string | undefined },
  stream: 'control' | 'io'
): string => {
  const status = response.statusCode ? `${response.statusCode}` : 'unknown status'
  const statusMessage = response.statusMessage?.trim()
  return `Local terminal ${stream} websocket upgrade failed: ${status}${
    statusMessage ? ` ${statusMessage}` : ''
  }`
}

const listLocalWorkspaces = async (
  localRuntimeUrl: string,
  localRequestTimeoutMs?: number | undefined
) => {
  const cookie = await getUiCookie(localRuntimeUrl, localRequestTimeoutMs)
  return fetchLocalJson(localRuntimeUrl, '/api/workspaces', cookie, localRequestTimeoutMs)
}

const listLocalAgentsAndRuns = async (
  localRuntimeUrl: string,
  workspaceId: string,
  localRequestTimeoutMs?: number | undefined
) => {
  const cookie = await getUiCookie(localRuntimeUrl, localRequestTimeoutMs)
  const encodedWorkspaceId = encodeURIComponent(workspaceId)
  const [agents, runs] = await Promise.all([
    fetchLocalJson(
      localRuntimeUrl,
      `/api/ui/workspaces/${encodedWorkspaceId}/team`,
      cookie,
      localRequestTimeoutMs
    ),
    fetchLocalJson(
      localRuntimeUrl,
      `/api/ui/workspaces/${encodedWorkspaceId}/runs`,
      cookie,
      localRequestTimeoutMs
    ),
  ])
  return { agents, runs }
}

const listLocalDispatches = async (
  localRuntimeUrl: string,
  workspaceId: string,
  localRequestTimeoutMs?: number | undefined,
  relayContext?: LocalMobileRelayContext | undefined
) => {
  const cookie = await getMobileCookie(localRuntimeUrl, localRequestTimeoutMs)
  return fetchLocalJson(
    localRuntimeUrl,
    `/api/mobile/dispatches?workspace_id=${encodeURIComponent(workspaceId)}`,
    cookie,
    localRequestTimeoutMs,
    relayContext ? createLocalMobileRelayHeaders(relayContext) : {}
  )
}

const getLocalMobileTranscript = async (
  localRuntimeUrl: string,
  payload: unknown,
  localRequestTimeoutMs?: number | undefined,
  relayContext?: LocalMobileRelayContext | undefined
) => {
  const workspaceId = getRequiredStringPayloadField(
    payload,
    'workspace_id',
    'get_mobile_transcript'
  )
  const runId = getRequiredStringPayloadField(payload, 'run_id', 'get_mobile_transcript')
  const cookie = await getMobileCookie(localRuntimeUrl, localRequestTimeoutMs)
  return fetchLocalJson(
    localRuntimeUrl,
    `/api/mobile/transcript?workspace_id=${encodeURIComponent(
      workspaceId
    )}&run_id=${encodeURIComponent(runId)}`,
    cookie,
    localRequestTimeoutMs,
    relayContext ? createLocalMobileRelayHeaders(relayContext) : {}
  )
}

const getLocalMobileConversation = async (
  localRuntimeUrl: string,
  payload: unknown,
  localRequestTimeoutMs?: number | undefined,
  relayContext?: LocalMobileRelayContext | undefined
) => {
  const workspaceId = getRequiredStringPayloadField(
    payload,
    'workspace_id',
    'get_mobile_conversation'
  )
  const agentId = getRequiredStringPayloadField(payload, 'agent_id', 'get_mobile_conversation')
  const cursor = getOptionalStringPayloadField(payload, 'cursor', 'get_mobile_conversation')
  const cookie = await getMobileCookie(localRuntimeUrl, localRequestTimeoutMs)
  return fetchLocalJson(
    localRuntimeUrl,
    `/api/mobile/agents/${encodeURIComponent(agentId)}/conversation?workspace_id=${encodeURIComponent(
      workspaceId
    )}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    cookie,
    localRequestTimeoutMs,
    relayContext ? createLocalMobileRelayHeaders(relayContext) : {}
  )
}

const getLocalMobileConversationHistory = async (
  localRuntimeUrl: string,
  payload: unknown,
  localRequestTimeoutMs?: number,
  relayContext?: LocalMobileRelayContext
) => {
  const workspaceId = getRequiredStringPayloadField(
    payload,
    'workspace_id',
    'get_mobile_conversations'
  )
  const agentId = getRequiredStringPayloadField(payload, 'agent_id', 'get_mobile_conversations')
  const cursor = getOptionalStringPayloadField(payload, 'cursor', 'get_mobile_conversations')
  const cookie = await getMobileCookie(localRuntimeUrl, localRequestTimeoutMs)
  return fetchLocalJson(
    localRuntimeUrl,
    `/api/mobile/agents/${encodeURIComponent(agentId)}/conversations?workspace_id=${encodeURIComponent(workspaceId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    cookie,
    localRequestTimeoutMs,
    relayContext ? createLocalMobileRelayHeaders(relayContext) : {}
  )
}

const getLocalMobileRecordedConversation = async (
  localRuntimeUrl: string,
  payload: unknown,
  localRequestTimeoutMs?: number,
  relayContext?: LocalMobileRelayContext
) => {
  const workspaceId = getRequiredStringPayloadField(
    payload,
    'workspace_id',
    'get_mobile_recorded_conversation'
  )
  const agentId = getRequiredStringPayloadField(
    payload,
    'agent_id',
    'get_mobile_recorded_conversation'
  )
  const conversationId = getRequiredStringPayloadField(
    payload,
    'conversation_id',
    'get_mobile_recorded_conversation'
  )
  const cursor = getOptionalStringPayloadField(
    payload,
    'cursor',
    'get_mobile_recorded_conversation'
  )
  const cookie = await getMobileCookie(localRuntimeUrl, localRequestTimeoutMs)
  return fetchLocalJson(
    localRuntimeUrl,
    `/api/mobile/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}?workspace_id=${encodeURIComponent(workspaceId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    cookie,
    localRequestTimeoutMs,
    relayContext ? createLocalMobileRelayHeaders(relayContext) : {}
  )
}

const runLocalMobileAction = async (
  localRuntimeUrl: string,
  actionBody: unknown,
  localRequestTimeoutMs?: number | undefined,
  relayContext?: LocalMobileRelayContext | undefined
) => {
  const cookie = await getMobileCookie(localRuntimeUrl, localRequestTimeoutMs)
  return postLocalJson(
    localRuntimeUrl,
    '/api/mobile/actions',
    cookie,
    actionBody,
    localRequestTimeoutMs,
    relayContext ? createLocalMobileRelayHeaders(relayContext) : {}
  )
}

const createLocalMobileConfirmation = async (
  localRuntimeUrl: string,
  confirmationBody: unknown,
  localRequestTimeoutMs?: number | undefined,
  relayContext?: LocalMobileRelayContext | undefined
) => {
  const cookie = await getMobileCookie(localRuntimeUrl, localRequestTimeoutMs)
  return postLocalJson(
    localRuntimeUrl,
    '/api/mobile/confirmations',
    cookie,
    confirmationBody,
    localRequestTimeoutMs,
    relayContext ? createLocalMobileRelayHeaders(relayContext) : {}
  )
}

const listLocalMobileFiles = async (
  localRuntimeUrl: string,
  localRequestTimeoutMs?: number | undefined,
  relayContext?: LocalMobileRelayContext | undefined
) => {
  const cookie = await getMobileCookie(localRuntimeUrl, localRequestTimeoutMs)
  const items = await fetchLocalJson(
    localRuntimeUrl,
    '/api/mobile/files',
    cookie,
    localRequestTimeoutMs,
    relayContext ? createLocalMobileRelayHeaders(relayContext) : {}
  )
  return Array.isArray(items) ? items.map(sanitizeMobileFileItem) : items
}

const uploadLocalMobileFile = async (
  localRuntimeUrl: string,
  body: unknown,
  localRequestTimeoutMs?: number | undefined,
  relayContext?: LocalMobileRelayContext | undefined
) => {
  const cookie = await getMobileCookie(localRuntimeUrl, localRequestTimeoutMs)
  return sanitizeMobileFileItem(
    await postLocalJson(
      localRuntimeUrl,
      '/api/mobile/files',
      cookie,
      body,
      localRequestTimeoutMs,
      relayContext ? createLocalMobileRelayHeaders(relayContext) : {}
    )
  )
}

const sendLocalWorkspaceFileToMobile = async (
  localRuntimeUrl: string,
  body: unknown,
  localRequestTimeoutMs?: number | undefined,
  relayContext?: LocalMobileRelayContext | undefined
) => {
  const cookie = await getMobileCookie(localRuntimeUrl, localRequestTimeoutMs)
  return sanitizeMobileFileItem(
    await postLocalJson(
      localRuntimeUrl,
      '/api/mobile/files/from-workspace',
      cookie,
      body,
      localRequestTimeoutMs,
      relayContext ? createLocalMobileRelayHeaders(relayContext) : {}
    )
  )
}

const deleteLocalMobileFile = async (
  localRuntimeUrl: string,
  fileId: string,
  localRequestTimeoutMs?: number | undefined,
  relayContext?: LocalMobileRelayContext | undefined
) => {
  const cookie = await getMobileCookie(localRuntimeUrl, localRequestTimeoutMs)
  await deleteLocal(
    localRuntimeUrl,
    `/api/mobile/files/${encodeURIComponent(fileId)}`,
    cookie,
    localRequestTimeoutMs,
    relayContext ? createLocalMobileRelayHeaders(relayContext) : {}
  )
  return { ok: true }
}

const clearLocalMobileFiles = async (
  localRuntimeUrl: string,
  localRequestTimeoutMs?: number | undefined,
  relayContext?: LocalMobileRelayContext | undefined
) => {
  const cookie = await getMobileCookie(localRuntimeUrl, localRequestTimeoutMs)
  await deleteLocal(
    localRuntimeUrl,
    '/api/mobile/files',
    cookie,
    localRequestTimeoutMs,
    relayContext ? createLocalMobileRelayHeaders(relayContext) : {}
  )
  return { ok: true }
}

const downloadLocalMobileFileForRelay = async (
  localRuntimeUrl: string,
  payload: unknown,
  localRequestTimeoutMs?: number | undefined,
  relayContext?: LocalMobileRelayContext | undefined
) => {
  const fileId = getRequiredStringPayloadField(payload, 'file_id', 'download_mobile_file')
  const cookie = await getMobileCookie(localRuntimeUrl, localRequestTimeoutMs)
  return downloadLocalMobileFile(
    localRuntimeUrl,
    fileId,
    cookie,
    localRequestTimeoutMs,
    relayContext ? createLocalMobileRelayHeaders(relayContext) : {},
    payload
  )
}

const streamLocalMobileFileForRelay = async (
  socket: WebSocket,
  envelope: RelayEnvelope,
  {
    deviceId,
    localRequestTimeoutMs,
    localRuntimeUrl,
    relayContext,
  }: {
    deviceId: string
    localRequestTimeoutMs?: number | undefined
    localRuntimeUrl: string
    relayContext?: LocalMobileRelayContext | undefined
  }
) => {
  const fileId = getRequiredStringPayloadField(envelope.payload, 'file_id', envelope.type)
  const cookie = await getMobileCookie(localRuntimeUrl, localRequestTimeoutMs)
  const path = getLocalMobileFilePath(fileId, envelope.payload)
  const response = await fetchLocalRuntime(
    localRuntimeUrl,
    path,
    {
      headers: {
        ...(relayContext ? createLocalMobileRelayHeaders(relayContext) : {}),
        cookie,
      },
    },
    localRequestTimeoutMs
  )
  if (!response.ok) throw new Error(`Local runtime request failed: ${path} (${response.status})`)
  socket.send(
    JSON.stringify({
      type: 'download_mobile_file_stream_headers',
      request_id: envelope.request_id,
      from: deviceId,
      to: envelope.from,
      channel: envelope.channel,
      payload: {
        mime_type: response.headers.get('content-type') ?? 'application/octet-stream',
        name: parseDownloadName(response, fileId),
        size: Number.parseInt(response.headers.get('content-length') ?? '', 10) || undefined,
      },
    })
  )

  if (!response.body) {
    const content = Buffer.from(await response.arrayBuffer())
    socket.send(
      JSON.stringify({
        type: 'download_mobile_file_stream_chunk',
        request_id: envelope.request_id,
        from: deviceId,
        to: envelope.from,
        channel: envelope.channel,
        payload: { content_base64: content.toString('base64') },
      })
    )
  } else {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      socket.send(
        JSON.stringify({
          type: 'download_mobile_file_stream_chunk',
          request_id: envelope.request_id,
          from: deviceId,
          to: envelope.from,
          channel: envelope.channel,
          payload: {
            content_base64: Buffer.from(value).toString('base64'),
          },
        })
      )
    }
  }

  socket.send(
    JSON.stringify({
      type: 'download_mobile_file_stream_end',
      request_id: envelope.request_id,
      from: deviceId,
      to: envelope.from,
      channel: envelope.channel,
      payload: { ok: true },
    })
  )
}

export const attachRelayDesktopHandlers = (
  socket: WebSocket,
  {
    deviceId,
    localRequestTimeoutMs = DEFAULT_LOCAL_REQUEST_TIMEOUT_MS,
    localRuntimeUrl = DEFAULT_LOCAL_RUNTIME_URL,
    runtimeStatusIntervalMs = DEFAULT_RUNTIME_STATUS_INTERVAL_MS,
  }: Pick<
    RunRelayDesktopClientOptions,
    'deviceId' | 'localRequestTimeoutMs' | 'localRuntimeUrl' | 'runtimeStatusIntervalMs'
  >
) => {
  const terminalProxies = new Map<string, TerminalProxyState>()
  const terminalProxyErrors = new Map<string, string>()
  const mobileEventProxies = new Map<string, WebSocket>()
  const mobileEventProxyErrors = new Map<string, string>()
  let runtimeStatusTimer: NodeJS.Timeout | null = null

  const sendDesktopStatus = async () => {
    const runtime = await readLocalRuntimeStatus(localRuntimeUrl, localRequestTimeoutMs)
    const supervisor = readDesktopSupervisorStatus()
    if (socket.readyState !== socket.OPEN) return
    socket.send(
      JSON.stringify({
        type: 'desktop_status',
        from: deviceId,
        to: 'relay',
        channel: 'relay',
        payload: {
          ...(runtime.runtimeMessage ? { runtime_message: runtime.runtimeMessage } : {}),
          runtime_status: runtime.runtimeStatus,
          ...(supervisor.supervisorPhase ? { supervisor_phase: supervisor.supervisorPhase } : {}),
          supervisor_status: supervisor.supervisorStatus,
          ...(typeof supervisor.supervisorUpdatedAt === 'number'
            ? { supervisor_updated_at: supervisor.supervisorUpdatedAt }
            : {}),
        },
      })
    )
  }

  const startRuntimeStatusHeartbeat = () => {
    if (runtimeStatusTimer || runtimeStatusIntervalMs <= 0) return
    void sendDesktopStatus()
    runtimeStatusTimer = setInterval(() => {
      void sendDesktopStatus()
    }, runtimeStatusIntervalMs)
  }

  const stopRuntimeStatusHeartbeat = () => {
    if (!runtimeStatusTimer) return
    clearInterval(runtimeStatusTimer)
    runtimeStatusTimer = null
  }

  if (socket.readyState === socket.OPEN) startRuntimeStatusHeartbeat()
  else socket.once('open', startRuntimeStatusHeartbeat)

  const notifyTerminalProxyClosed = (proxyId: string, code = 1000, reason = '') => {
    if (socket.readyState !== socket.OPEN) return
    socket.send(
      JSON.stringify({
        type: 'terminal_proxy_close',
        request_id: proxyId,
        from: deviceId,
        to: 'relay',
        channel: 'terminal_proxy',
        payload: {
          code,
          proxy_id: proxyId,
          ...(reason ? { reason: reason.slice(0, 123) } : {}),
        },
      })
    )
  }

  const closeTerminalProxy = (proxyId: string, code = 1000, reason = '') => {
    const state = terminalProxies.get(proxyId)
    terminalProxies.delete(proxyId)
    terminalProxyErrors.delete(proxyId)
    if (!state) return
    state.pendingData = []
    state.pendingBytes = 0
    const proxy = state.socket
    if (proxy && proxy.readyState !== proxy.CLOSED) proxy.close(code, reason.slice(0, 123))
  }

  const flushTerminalProxyData = (proxyId: string, state: TerminalProxyState) => {
    const proxy = state.socket
    if (terminalProxies.get(proxyId) !== state || !proxy || proxy.readyState !== proxy.OPEN) {
      return
    }
    const pendingData = state.pendingData
    state.pendingData = []
    state.pendingBytes = 0
    for (const data of pendingData) proxy.send(data)
  }

  const bufferTerminalProxyData = (
    proxyId: string,
    state: TerminalProxyState,
    data: Buffer | string
  ) => {
    const byteLength = Buffer.byteLength(data)
    if (
      state.pendingData.length >= MAX_TERMINAL_PROXY_PENDING_MESSAGES ||
      state.pendingBytes + byteLength > MAX_TERMINAL_PROXY_PENDING_BYTES
    ) {
      const reason = 'Terminal proxy input buffer exceeded while local runtime was connecting'
      notifyTerminalProxyClosed(proxyId, 1009, reason)
      closeTerminalProxy(proxyId, 1009, reason)
      return
    }
    state.pendingData.push(data)
    state.pendingBytes += byteLength
  }

  const notifyMobileEventsClosed = (
    subscriptionId: string,
    mobileId: string,
    code = 1000,
    reason = ''
  ) => {
    if (socket.readyState !== socket.OPEN) return
    socket.send(
      JSON.stringify({
        type: 'mobile_events_close',
        request_id: subscriptionId,
        from: deviceId,
        to: mobileId,
        channel: 'mobile_events',
        payload: {
          code,
          subscription_id: subscriptionId,
          ...(reason ? { reason: reason.slice(0, 123) } : {}),
        },
      })
    )
  }

  const closeMobileEventsProxy = (subscriptionId: string, code = 1000, reason = ''): boolean => {
    const proxy = mobileEventProxies.get(subscriptionId)
    mobileEventProxies.delete(subscriptionId)
    mobileEventProxyErrors.delete(subscriptionId)
    if (!proxy) return false
    if (proxy.readyState === proxy.OPEN) proxy.close(code, reason.slice(0, 123))
    return true
  }

  socket.on('message', (raw) => {
    void (async () => {
      let envelope: RelayEnvelope
      try {
        envelope = parseRelayEnvelope(raw as Buffer | string)
      } catch (error) {
        socket.send(
          serializeDesktopRelayError({
            code: 'invalid_envelope',
            desktopId: deviceId,
            message: error instanceof Error ? error.message : 'Invalid relay envelope',
            to: deviceId,
          })
        )
        return
      }

      try {
        const relayContext: LocalMobileRelayContext = {
          desktopId: deviceId,
          mobileDeviceId: envelope.from,
          ...(envelope.relay_context?.workspace_ids
            ? { workspaceIds: envelope.relay_context.workspace_ids }
            : {}),
        }

        if (envelope.type === 'terminal_proxy_open') {
          const payload = envelope.payload
          if (typeof payload !== 'object' || payload === null) {
            throw new Error('Invalid terminal proxy payload')
          }
          const record = payload as Record<string, unknown>
          const proxyId = getRequiredStringPayloadField(payload, 'proxy_id', envelope.type)
          const runId = getRequiredStringPayloadField(payload, 'run_id', envelope.type)
          const stream = record.stream
          if (stream !== 'control' && stream !== 'io') {
            throw new Error('Invalid terminal proxy payload: stream is required')
          }
          const query =
            typeof record.query === 'object' && record.query !== null
              ? Object.fromEntries(
                  Object.entries(record.query as Record<string, unknown>).filter(
                    (entry): entry is [string, string] => typeof entry[1] === 'string'
                  )
                )
              : {}
          closeTerminalProxy(proxyId)
          const state: TerminalProxyState = {
            pendingBytes: 0,
            pendingData: [],
            socket: null,
          }
          terminalProxies.set(proxyId, state)
          const cookie = await getUiCookie(localRuntimeUrl, localRequestTimeoutMs).catch(
            (error: unknown) => {
              if (terminalProxies.get(proxyId) === state) {
                closeTerminalProxy(proxyId)
                notifyTerminalProxyClosed(
                  proxyId,
                  1011,
                  error instanceof Error ? error.message : 'Local runtime session failed'
                )
              }
              return null
            }
          )
          if (!cookie) return
          if (terminalProxies.get(proxyId) !== state) return
          const proxy = new WebSocket(
            toLocalTerminalWebSocketUrl(localRuntimeUrl, runId, stream, query),
            { headers: { cookie } }
          )
          state.socket = proxy
          proxy.on('open', () => {
            flushTerminalProxyData(proxyId, state)
          })
          proxy.on('unexpected-response', (_request, response) => {
            if (terminalProxies.get(proxyId) !== state) return
            const reason = formatUnexpectedTerminalProxyResponse(response, stream)
            terminalProxyErrors.set(proxyId, reason)
            notifyTerminalProxyClosed(proxyId, 1011, reason)
            closeTerminalProxy(proxyId, 1011, reason)
          })
          proxy.on('message', (proxyRaw) => {
            if (terminalProxies.get(proxyId) !== state || socket.readyState !== socket.OPEN) {
              return
            }
            const encoded = encodeProxyData(proxyRaw)
            socket.send(
              JSON.stringify({
                type: 'terminal_proxy_data',
                request_id: proxyId,
                from: deviceId,
                to: 'relay',
                channel: 'terminal_proxy',
                payload: { ...encoded, proxy_id: proxyId },
              })
            )
          })
          proxy.on('close', (code, reasonBuffer) => {
            if (terminalProxies.get(proxyId) !== state) return
            terminalProxies.delete(proxyId)
            state.pendingData = []
            state.pendingBytes = 0
            const reason =
              terminalProxyErrors.get(proxyId) ||
              reasonBuffer.toString('utf8') ||
              'Local terminal websocket closed'
            terminalProxyErrors.delete(proxyId)
            notifyTerminalProxyClosed(proxyId, code, reason)
          })
          proxy.on('error', (error) => {
            if (terminalProxies.get(proxyId) !== state) return
            terminalProxyErrors.set(
              proxyId,
              error instanceof Error ? error.message : 'Local terminal websocket failed'
            )
            proxy.close(1011)
          })
          return
        }

        if (envelope.type === 'terminal_proxy_data') {
          const payload = envelope.payload
          if (typeof payload !== 'object' || payload === null) return
          const proxyId = getRequiredStringPayloadField(payload, 'proxy_id', envelope.type)
          const state = terminalProxies.get(proxyId)
          const decoded = decodeProxyData(payload as Record<string, unknown>)
          if (!state || decoded === null) return
          const proxy = state.socket
          if (!proxy || proxy.readyState === proxy.CONNECTING) {
            bufferTerminalProxyData(proxyId, state, decoded)
            return
          }
          if (proxy.readyState === proxy.OPEN) proxy.send(decoded)
          return
        }

        if (envelope.type === 'terminal_proxy_close') {
          const proxyId = getRequiredStringPayloadField(envelope.payload, 'proxy_id', envelope.type)
          closeTerminalProxy(proxyId)
          return
        }

        if (envelope.type === 'subscribe_mobile_events') {
          const subscriptionId =
            envelope.request_id ??
            getRequiredStringPayloadField(envelope.payload, 'subscription_id', envelope.type)
          closeMobileEventsProxy(subscriptionId)
          const cookie = await getMobileCookie(localRuntimeUrl, localRequestTimeoutMs).catch(
            (error: unknown) => {
              notifyMobileEventsClosed(
                subscriptionId,
                envelope.from,
                1011,
                error instanceof Error ? error.message : 'Local runtime session failed'
              )
              return null
            }
          )
          if (!cookie) return
          const proxy = new WebSocket(toLocalMobileEventsWebSocketUrl(localRuntimeUrl), {
            headers: { ...createLocalMobileRelayHeaders(relayContext), cookie },
          })
          mobileEventProxies.set(subscriptionId, proxy)
          proxy.on('message', (proxyRaw) => {
            let payload: unknown
            try {
              payload = JSON.parse(proxyRaw.toString())
            } catch {
              return
            }
            if (socket.readyState !== socket.OPEN) return
            socket.send(
              JSON.stringify({
                type: 'mobile_events_message',
                request_id: subscriptionId,
                from: deviceId,
                to: envelope.from,
                channel: 'mobile_events',
                payload,
              })
            )
          })
          proxy.on('close', (code, reasonBuffer) => {
            if (mobileEventProxies.get(subscriptionId) === proxy) {
              mobileEventProxies.delete(subscriptionId)
            }
            const reason =
              mobileEventProxyErrors.get(subscriptionId) ||
              reasonBuffer.toString('utf8') ||
              'Local mobile events websocket closed'
            mobileEventProxyErrors.delete(subscriptionId)
            notifyMobileEventsClosed(subscriptionId, envelope.from, code, reason)
          })
          proxy.on('error', (error) => {
            mobileEventProxyErrors.set(
              subscriptionId,
              error instanceof Error ? error.message : 'Local mobile events websocket failed'
            )
            proxy.close(1011)
          })
          return
        }

        if (envelope.type === 'unsubscribe_mobile_events') {
          const subscriptionId =
            envelope.request_id ??
            getRequiredStringPayloadField(envelope.payload, 'subscription_id', envelope.type)
          closeMobileEventsProxy(subscriptionId)
          return
        }

        if (envelope.type === 'list_workspaces') {
          const workspaces = await listLocalWorkspaces(localRuntimeUrl, localRequestTimeoutMs)
          socket.send(
            JSON.stringify({
              type: 'list_workspaces_result',
              request_id: envelope.request_id,
              from: deviceId,
              to: envelope.from,
              channel: envelope.channel,
              payload: { workspaces },
            })
          )
          return
        }

        if (envelope.type === 'list_agents_and_runs') {
          const workspaceId = getRequiredStringPayloadField(
            envelope.payload,
            'workspace_id',
            envelope.type
          )
          const { agents, runs } = await listLocalAgentsAndRuns(
            localRuntimeUrl,
            workspaceId,
            localRequestTimeoutMs
          )
          socket.send(
            JSON.stringify({
              type: 'list_agents_and_runs_result',
              request_id: envelope.request_id,
              from: deviceId,
              to: envelope.from,
              channel: envelope.channel,
              payload: { agents, runs, workspace_id: workspaceId },
            })
          )
          return
        }

        if (envelope.type === 'list_dispatches') {
          const workspaceId = getRequiredStringPayloadField(
            envelope.payload,
            'workspace_id',
            envelope.type
          )
          const result = await listLocalDispatches(
            localRuntimeUrl,
            workspaceId,
            localRequestTimeoutMs,
            relayContext
          )
          socket.send(
            JSON.stringify({
              type: 'list_dispatches_result',
              request_id: envelope.request_id,
              from: deviceId,
              to: envelope.from,
              channel: envelope.channel,
              payload: { dispatches: result, workspace_id: workspaceId },
            })
          )
          return
        }

        if (envelope.type === 'mobile_action') {
          const result = await runLocalMobileAction(
            localRuntimeUrl,
            envelope.payload,
            localRequestTimeoutMs,
            relayContext
          )
          socket.send(
            JSON.stringify({
              type: 'mobile_action_result',
              request_id: envelope.request_id,
              from: deviceId,
              to: envelope.from,
              channel: envelope.channel,
              payload: result,
            })
          )
          return
        }

        if (envelope.type === 'get_mobile_transcript') {
          const result = await getLocalMobileTranscript(
            localRuntimeUrl,
            envelope.payload,
            localRequestTimeoutMs,
            relayContext
          )
          socket.send(
            JSON.stringify({
              type: 'get_mobile_transcript_result',
              request_id: envelope.request_id,
              from: deviceId,
              to: envelope.from,
              channel: envelope.channel,
              payload: result,
            })
          )
          return
        }

        if (envelope.type === 'get_mobile_conversation') {
          const result = await getLocalMobileConversation(
            localRuntimeUrl,
            envelope.payload,
            localRequestTimeoutMs,
            relayContext
          )
          socket.send(
            JSON.stringify({
              type: 'get_mobile_conversation_result',
              request_id: envelope.request_id,
              from: deviceId,
              to: envelope.from,
              channel: envelope.channel,
              payload: result,
            })
          )
          return
        }

        if (envelope.type === 'get_mobile_conversations') {
          const result = await getLocalMobileConversationHistory(
            localRuntimeUrl,
            envelope.payload,
            localRequestTimeoutMs,
            relayContext
          )
          socket.send(
            JSON.stringify({
              type: 'get_mobile_conversations_result',
              request_id: envelope.request_id,
              from: deviceId,
              to: envelope.from,
              channel: envelope.channel,
              payload: result,
            })
          )
          return
        }

        if (envelope.type === 'get_mobile_recorded_conversation') {
          const result = await getLocalMobileRecordedConversation(
            localRuntimeUrl,
            envelope.payload,
            localRequestTimeoutMs,
            relayContext
          )
          socket.send(
            JSON.stringify({
              type: 'get_mobile_recorded_conversation_result',
              request_id: envelope.request_id,
              from: deviceId,
              to: envelope.from,
              channel: envelope.channel,
              payload: result,
            })
          )
          return
        }

        if (envelope.type === 'create_mobile_confirmation') {
          const result = await createLocalMobileConfirmation(
            localRuntimeUrl,
            envelope.payload,
            localRequestTimeoutMs,
            relayContext
          )
          socket.send(
            JSON.stringify({
              type: 'create_mobile_confirmation_result',
              request_id: envelope.request_id,
              from: deviceId,
              to: envelope.from,
              channel: envelope.channel,
              payload: result,
            })
          )
          return
        }

        if (envelope.type === 'list_mobile_files') {
          const result = await listLocalMobileFiles(
            localRuntimeUrl,
            localRequestTimeoutMs,
            relayContext
          )
          socket.send(
            JSON.stringify({
              type: 'list_mobile_files_result',
              request_id: envelope.request_id,
              from: deviceId,
              to: envelope.from,
              channel: envelope.channel,
              payload: result,
            })
          )
          return
        }

        if (envelope.type === 'upload_mobile_file') {
          const result = await uploadLocalMobileFile(
            localRuntimeUrl,
            envelope.payload,
            localRequestTimeoutMs,
            relayContext
          )
          socket.send(
            JSON.stringify({
              type: 'upload_mobile_file_result',
              request_id: envelope.request_id,
              from: deviceId,
              to: envelope.from,
              channel: envelope.channel,
              payload: result,
            })
          )
          return
        }

        if (envelope.type === 'send_workspace_file_to_mobile') {
          const result = await sendLocalWorkspaceFileToMobile(
            localRuntimeUrl,
            envelope.payload,
            localRequestTimeoutMs,
            relayContext
          )
          socket.send(
            JSON.stringify({
              type: 'send_workspace_file_to_mobile_result',
              request_id: envelope.request_id,
              from: deviceId,
              to: envelope.from,
              channel: envelope.channel,
              payload: result,
            })
          )
          return
        }

        if (envelope.type === 'download_mobile_file') {
          const result = await downloadLocalMobileFileForRelay(
            localRuntimeUrl,
            envelope.payload,
            localRequestTimeoutMs,
            relayContext
          )
          socket.send(
            JSON.stringify({
              type: 'download_mobile_file_result',
              request_id: envelope.request_id,
              from: deviceId,
              to: envelope.from,
              channel: envelope.channel,
              payload: result,
            })
          )
          return
        }

        if (envelope.type === 'download_mobile_file_stream') {
          await streamLocalMobileFileForRelay(socket, envelope, {
            deviceId,
            localRequestTimeoutMs,
            localRuntimeUrl,
            relayContext,
          })
          return
        }

        if (envelope.type === 'delete_mobile_file') {
          const fileId = getRequiredStringPayloadField(envelope.payload, 'file_id', envelope.type)
          const result = await deleteLocalMobileFile(
            localRuntimeUrl,
            fileId,
            localRequestTimeoutMs,
            relayContext
          )
          socket.send(
            JSON.stringify({
              type: 'delete_mobile_file_result',
              request_id: envelope.request_id,
              from: deviceId,
              to: envelope.from,
              channel: envelope.channel,
              payload: result,
            })
          )
          return
        }

        if (envelope.type === 'clear_mobile_files') {
          const result = await clearLocalMobileFiles(
            localRuntimeUrl,
            localRequestTimeoutMs,
            relayContext
          )
          socket.send(
            JSON.stringify({
              type: 'clear_mobile_files_result',
              request_id: envelope.request_id,
              from: deviceId,
              to: envelope.from,
              channel: envelope.channel,
              payload: result,
            })
          )
          return
        }

        socket.send(
          serializeDesktopRelayError({
            channel: envelope.channel,
            code: 'not_implemented',
            desktopId: deviceId,
            message: `Desktop relay request is not implemented: ${envelope.type}`,
            requestId: envelope.request_id,
            to: envelope.from,
          })
        )
      } catch (error) {
        socket.send(
          serializeDesktopRelayError({
            channel: envelope.channel,
            code:
              error instanceof LocalRuntimeRequestError && error.code
                ? error.code
                : 'local_runtime_error',
            desktopId: deviceId,
            message: error instanceof Error ? error.message : 'Local runtime request failed',
            requestId: envelope.request_id,
            to: envelope.from,
          })
        )
      }
    })()
  })
  socket.on('close', () => {
    stopRuntimeStatusHeartbeat()
    for (const proxyId of Array.from(terminalProxies.keys())) {
      closeTerminalProxy(proxyId, 1000, 'Relay desktop socket closed')
    }
    for (const subscriptionId of Array.from(mobileEventProxies.keys())) {
      closeMobileEventsProxy(subscriptionId, 1000, 'Relay desktop socket closed')
    }
  })
}

export const runRelayDesktopClient = async ({
  deviceId,
  localRequestTimeoutMs = DEFAULT_LOCAL_REQUEST_TIMEOUT_MS,
  localRuntimeUrl = DEFAULT_LOCAL_RUNTIME_URL,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  serverUrl,
  signal,
  token,
}: RunRelayDesktopClientOptions): Promise<void> => {
  let stopped = signal?.aborted ?? false
  const stop = () => {
    stopped = true
  }
  signal?.addEventListener('abort', stop, { once: true })
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    while (!stopped) {
      const runtime = await readLocalRuntimeStatus(localRuntimeUrl, localRequestTimeoutMs)
      const normalizedServerUrl = normalizeRelayServerUrlForDesktop(serverUrl)
      const socket = openRelayDesktopSocket({
        deviceId,
        ...runtime,
        serverUrl: normalizedServerUrl,
        token,
      })
      await new Promise<void>((resolve) => {
        const closeForStop = () => {
          if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
            socket.close(1000, 'Desktop relay client stopped')
          }
        }
        signal?.addEventListener('abort', closeForStop, { once: true })
        socket.on('open', () => {
          console.log(
            formatRelayDesktopConnectedMessage({
              deviceId,
              runtimeStatus: runtime.runtimeStatus,
              serverUrl: normalizedServerUrl,
            })
          )
          if (stopped) closeForStop()
        })
        attachRelayDesktopHandlers(socket, { deviceId, localRequestTimeoutMs, localRuntimeUrl })
        socket.on('close', (code, reason) => {
          signal?.removeEventListener('abort', closeForStop)
          if (!stopped) {
            console.log(
              formatRelayDesktopReconnectMessage({
                code,
                reason,
                reconnectDelayMs,
                serverUrl: normalizedServerUrl,
              })
            )
          }
          resolve()
        })
        socket.on('error', (error) => {
          console.error(error instanceof Error ? error.message : String(error))
        })
        if (stopped) closeForStop()
      })
      if (!stopped) await delay(reconnectDelayMs)
    }
  } finally {
    signal?.removeEventListener('abort', stop)
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}
