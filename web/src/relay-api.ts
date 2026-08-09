import { parseMobileEventsServerMessage } from '../../src/shared/mobile-events.js'
import type { RelayEnvelope, RelayErrorPayload } from '../../src/shared/relay-protocol.js'
import type {
  RelayAccountLoginResult,
  RelayAgentsAndRuns,
  RelayClaimedDeviceToken,
  RelayDesktopDevice,
  RelayDeviceSnapshot,
  RelayDeviceTokenSummary,
  RelayHealthSnapshot,
  RelayMobileDevice,
  RelayMobileFileUpload,
  RelayPairingToken,
} from '../../src/shared/relay-types.js'
import type {
  ArtifactReference,
  MobileConversationInvalidation,
  MobileSnapshot,
  TeamListItemPayload,
  WorkspaceSummary,
} from '../../src/shared/types.js'
import type {
  MobileDispatchItem,
  MobileFileDownload,
  MobileFileDownloadProgressHandler,
  MobileFileExchangeItem,
  MobileTranscript,
} from './api.js'
import { readResponseBlobWithProgress } from './api.js'
import { createBrowserId } from './browser-id.js'

export const SUPPORTED_RELAY_HTTP_PROTOCOL_VERSION = 2

export type { RelayEnvelope, RelayErrorPayload } from '../../src/shared/relay-protocol.js'
export type {
  RelayAccountLoginResult,
  RelayAgentsAndRuns,
  RelayClaimedDeviceToken,
  RelayDesktopDevice,
  RelayDesktopRuntimeStatus,
  RelayDesktopSupervisorStatus,
  RelayDeviceSnapshot,
  RelayDeviceTokenSummary,
  RelayHealthSnapshot,
  RelayMobileDevice,
  RelayMobileFileUpload,
  RelayPairingToken,
} from '../../src/shared/relay-types.js'

export class RelayRuntimeError extends Error {
  readonly code: string
  readonly desktopId: string | undefined

  constructor(payload: RelayErrorPayload) {
    super(payload.message)
    this.name = 'RelayRuntimeError'
    this.code = payload.code
    this.desktopId = payload.desktop_id
  }
}

interface RelayMobileFileDownloadPayload {
  content_base64: string
  mime_type: string
  name: string
}

export interface RelayMobileClientOptions {
  connectTimeoutMs?: number
  desktopId: string
  deviceId?: string
  mobileEventsReconnectDelayMs?: number
  requestTimeoutMs?: number
  serverUrl?: string | undefined
  token: string
  webSocketConstructor?: RelayWebSocketConstructor
}

export interface RelayMobileEventsSubscription {
  dispose: () => void
}

export interface RelayMobileEventsReconnectMeta {
  attempt: number
  nextDelayMs: number
}

export interface RelayMobileEventsSubscriptionOptions {
  onClose?: (message: string, meta?: RelayMobileEventsReconnectMeta) => void
  onConversationInvalidated?: (invalidation: MobileConversationInvalidation) => void
  onError?: (error: Error) => void
  onHeartbeat?: (generatedAt: number) => void
  onSnapshot: (snapshot: MobileSnapshot) => void
}

export const isRelayHttpProtocolSupported = (health: RelayHealthSnapshot): boolean =>
  typeof health.protocol_version !== 'number' ||
  health.protocol_version <= SUPPORTED_RELAY_HTTP_PROTOCOL_VERSION

type RelayWebSocketEventMap = {
  close: CloseEvent | Event
  error: Event
  message: MessageEvent
  open: Event
}

interface RelayWebSocketLike {
  addEventListener<K extends keyof RelayWebSocketEventMap>(
    type: K,
    listener: (event: RelayWebSocketEventMap[K]) => void
  ): void
  close(): void
  readyState: number
  removeEventListener<K extends keyof RelayWebSocketEventMap>(
    type: K,
    listener: (event: RelayWebSocketEventMap[K]) => void
  ): void
  send(data: string): void
}

export interface RelayWebSocketConstructor {
  new (url: string): RelayWebSocketLike
  OPEN: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_MOBILE_EVENTS_RECONNECT_DELAY_MS = 1_000
const MAX_MOBILE_EVENTS_RECONNECT_DELAY_MS = 30_000

const getBrowserOrigin = () =>
  typeof window === 'undefined' ? 'http://127.0.0.1' : window.location.origin

const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/u

export const normalizeRelayServerUrl = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
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

const resolveRelayHttpUrl = (serverUrl: string | undefined, path: string): string => {
  const normalizedServerUrl = normalizeRelayServerUrl(serverUrl)
  if (!normalizedServerUrl) return path
  return `${trimTrailingSlash(normalizedServerUrl)}${path}`
}

const resolveRelayWebSocketUrl = (serverUrl: string | undefined, path: string): URL => {
  const normalizedServerUrl = normalizeRelayServerUrl(serverUrl)
  const base = new URL(normalizedServerUrl || getBrowserOrigin())
  const basePath = trimTrailingSlash(base.pathname === '/' ? '' : base.pathname)
  const url = new URL(`${basePath}${path}`, base.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}

const relayNoStoreRequest = (init: RequestInit = {}): RequestInit => ({
  ...init,
  cache: 'no-store',
})

const relayFetch = async (
  input: string,
  init: RequestInit,
  label: string,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<Response> => {
  const abortController = new AbortController()
  const timeout = setTimeout(() => {
    abortController.abort()
  }, timeoutMs)
  try {
    return await Promise.race([
      fetch(input, { ...init, signal: abortController.signal }),
      new Promise<Response>((_resolve, reject) => {
        abortController.signal.addEventListener(
          'abort',
          () => reject(new Error(`Relay HTTP request timed out: ${label}`)),
          { once: true }
        )
      }),
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('Relay HTTP request timed out:')) throw error
    throw new Error(`Relay HTTP request failed: ${label}: ${message}`)
  } finally {
    clearTimeout(timeout)
  }
}

const relayTokenHeaders = (token: string) => ({ authorization: `Bearer ${token}` })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseRelayDesktopDevice = (value: unknown): RelayDesktopDevice => {
  if (!isRecord(value) || typeof value.device_id !== 'string' || value.device_id.trim() === '') {
    throw new Error('Invalid relay devices response: desktop device_id is required')
  }
  const runtimeStatus = value.runtime_status
  if (
    runtimeStatus !== undefined &&
    runtimeStatus !== 'online' &&
    runtimeStatus !== 'offline' &&
    runtimeStatus !== 'unknown'
  ) {
    throw new Error('Invalid relay devices response: desktop runtime_status is invalid')
  }
  const supervisorStatus = value.supervisor_status
  if (
    supervisorStatus !== undefined &&
    supervisorStatus !== 'running' &&
    supervisorStatus !== 'stale' &&
    supervisorStatus !== 'missing' &&
    supervisorStatus !== 'error'
  ) {
    throw new Error('Invalid relay devices response: desktop supervisor_status is invalid')
  }
  return {
    ...(typeof value.connected_at === 'number' ? { connected_at: value.connected_at } : {}),
    device_id: value.device_id,
    ...(Array.isArray(value.features)
      ? {
          features: value.features.filter(
            (feature): feature is string => typeof feature === 'string'
          ),
        }
      : {}),
    ...(typeof value.last_seen_at === 'number' ? { last_seen_at: value.last_seen_at } : {}),
    ...(typeof value.runtime_message === 'string' && value.runtime_message.trim()
      ? { runtime_message: value.runtime_message.trim() }
      : {}),
    ...(runtimeStatus ? { runtime_status: runtimeStatus } : {}),
    ...(typeof value.runtime_updated_at === 'number'
      ? { runtime_updated_at: value.runtime_updated_at }
      : {}),
    ...(typeof value.supervisor_phase === 'string' && value.supervisor_phase.trim()
      ? { supervisor_phase: value.supervisor_phase.trim() }
      : {}),
    ...(supervisorStatus ? { supervisor_status: supervisorStatus } : {}),
    ...(typeof value.supervisor_updated_at === 'number'
      ? { supervisor_updated_at: value.supervisor_updated_at }
      : {}),
  }
}

const parseRelayMobileDevice = (value: unknown): RelayMobileDevice => {
  if (
    !isRecord(value) ||
    typeof value.desktop_id !== 'string' ||
    value.desktop_id.trim() === '' ||
    typeof value.device_id !== 'string' ||
    value.device_id.trim() === ''
  ) {
    throw new Error('Invalid relay devices response: mobile desktop_id and device_id are required')
  }
  return {
    ...(typeof value.connected_at === 'number' ? { connected_at: value.connected_at } : {}),
    desktop_id: value.desktop_id,
    device_id: value.device_id,
    ...(typeof value.last_seen_at === 'number' ? { last_seen_at: value.last_seen_at } : {}),
  }
}

const parseRelayDeviceSnapshot = (value: unknown): RelayDeviceSnapshot => {
  if (!isRecord(value) || !Array.isArray(value.desktops) || !Array.isArray(value.mobiles)) {
    throw new Error('Invalid relay devices response: desktops and mobiles must be arrays')
  }
  return {
    desktops: value.desktops.map(parseRelayDesktopDevice),
    mobiles: value.mobiles.map(parseRelayMobileDevice),
  }
}

const parseRelayHealthSnapshot = (value: unknown): RelayHealthSnapshot => {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    value.service !== 'hive-relay' ||
    typeof value.desktop_count !== 'number' ||
    typeof value.mobile_count !== 'number'
  ) {
    throw new Error(
      'Invalid relay health response: ok=true, service=hive-relay, desktop_count, and mobile_count are required'
    )
  }
  return {
    desktop_count: value.desktop_count,
    ...(isRecord(value.deployment) && typeof value.deployment.public_url_configured === 'boolean'
      ? {
          deployment: {
            public_url_configured: value.deployment.public_url_configured,
          },
        }
      : {}),
    ...(Array.isArray(value.features)
      ? {
          features: value.features.filter(
            (feature): feature is string => typeof feature === 'string'
          ),
        }
      : {}),
    ...(typeof value.heartbeat_interval_ms === 'number'
      ? { heartbeat_interval_ms: value.heartbeat_interval_ms }
      : {}),
    ...(typeof value.heartbeat_timeout_ms === 'number'
      ? { heartbeat_timeout_ms: value.heartbeat_timeout_ms }
      : {}),
    mobile_count: value.mobile_count,
    ok: true,
    ...(isRecord(value.pairing_store) &&
    typeof value.pairing_store.device_token_count === 'number' &&
    typeof value.pairing_store.issued_token_count === 'number' &&
    typeof value.pairing_store.persistent === 'boolean'
      ? {
          pairing_store: {
            ...(typeof value.pairing_store.admin_token_default === 'boolean'
              ? { admin_token_default: value.pairing_store.admin_token_default }
              : {}),
            device_token_count: value.pairing_store.device_token_count,
            issued_token_count: value.pairing_store.issued_token_count,
            persistent: value.pairing_store.persistent,
            ...(typeof value.pairing_store.require_desktop_binding === 'boolean'
              ? { require_desktop_binding: value.pairing_store.require_desktop_binding }
              : {}),
          },
        }
      : {}),
    ...(typeof value.protocol_version === 'number'
      ? { protocol_version: value.protocol_version }
      : {}),
    service: value.service,
    ...(typeof value.started_at === 'number' ? { started_at: value.started_at } : {}),
    ...(isRecord(value.static) && typeof value.static.mobile_app_available === 'boolean'
      ? { static: { mobile_app_available: value.static.mobile_app_available } }
      : {}),
    ...(typeof value.terminal_proxy_count === 'number'
      ? { terminal_proxy_count: value.terminal_proxy_count }
      : {}),
    ...(typeof value.uptime_ms === 'number' ? { uptime_ms: value.uptime_ms } : {}),
    ...(typeof value.version === 'string' && value.version.trim()
      ? { version: value.version.trim() }
      : {}),
  }
}

const parseRelayClaimedDeviceToken = (value: unknown): RelayClaimedDeviceToken => {
  if (
    !isRecord(value) ||
    typeof value.device_id !== 'string' ||
    value.device_id.trim() === '' ||
    typeof value.token !== 'string' ||
    value.token.trim() === ''
  ) {
    throw new Error('Invalid relay pairing response: device_id and token are required')
  }
  return {
    ...(typeof value.desktop_id === 'string' && value.desktop_id.trim()
      ? { desktop_id: value.desktop_id }
      : {}),
    device_id: value.device_id,
    ...(value.device_kind === 'desktop' || value.device_kind === 'mobile'
      ? { device_kind: value.device_kind }
      : {}),
    token: value.token,
    ...(Array.isArray(value.workspace_ids) &&
    value.workspace_ids.every((item) => typeof item === 'string')
      ? { workspace_ids: value.workspace_ids }
      : {}),
  }
}

const parseRelayAccountLoginResult = (value: unknown): RelayAccountLoginResult => {
  if (
    !isRecord(value) ||
    typeof value.desktop_id !== 'string' ||
    value.desktop_id.trim() === '' ||
    typeof value.device_id !== 'string' ||
    value.device_id.trim() === '' ||
    typeof value.token !== 'string' ||
    value.token.trim() === ''
  ) {
    throw new Error(
      'Invalid relay account login response: desktop_id, device_id, and token are required'
    )
  }
  return {
    desktop_id: value.desktop_id,
    device_id: value.device_id,
    ...(value.device_kind === 'desktop' || value.device_kind === 'mobile'
      ? { device_kind: value.device_kind }
      : {}),
    token: value.token,
    ...(Array.isArray(value.workspace_ids) &&
    value.workspace_ids.every((item) => typeof item === 'string')
      ? { workspace_ids: value.workspace_ids }
      : {}),
  }
}

const parseRelayPairingToken = (value: unknown): RelayPairingToken => {
  if (!isRecord(value) || typeof value.token !== 'string' || value.token.trim() === '') {
    throw new Error('Invalid relay pairing token response: token is required')
  }
  if (value.expires_at !== undefined && typeof value.expires_at !== 'number') {
    throw new Error('Invalid relay pairing token response: expires_at must be a number')
  }
  if (value.ttl_ms !== undefined && typeof value.ttl_ms !== 'number') {
    throw new Error('Invalid relay pairing token response: ttl_ms must be a number')
  }
  return {
    ...(typeof value.expires_at === 'number' ? { expires_at: value.expires_at } : {}),
    token: value.token,
    ...(typeof value.ttl_ms === 'number' ? { ttl_ms: value.ttl_ms } : {}),
  }
}

const parseRelayDeviceTokenSummary = (value: unknown): RelayDeviceTokenSummary => {
  if (
    !isRecord(value) ||
    typeof value.device_id !== 'string' ||
    value.device_id.trim() === '' ||
    typeof value.token_hint !== 'string'
  ) {
    throw new Error('Invalid relay paired devices response: device_id and token_hint are required')
  }
  return {
    ...(typeof value.desktop_id === 'string' && value.desktop_id.trim()
      ? { desktop_id: value.desktop_id }
      : {}),
    device_id: value.device_id,
    ...(value.device_kind === 'desktop' || value.device_kind === 'mobile'
      ? { device_kind: value.device_kind }
      : {}),
    token_hint: value.token_hint,
    ...(Array.isArray(value.workspace_ids) &&
    value.workspace_ids.every((item) => typeof item === 'string')
      ? { workspace_ids: value.workspace_ids }
      : {}),
  }
}

const parseRelayPairedDeviceList = (value: unknown): { devices: RelayDeviceTokenSummary[] } => {
  if (!isRecord(value) || !Array.isArray(value.devices)) {
    throw new Error('Invalid relay paired devices response: devices must be an array')
  }
  return { devices: value.devices.map(parseRelayDeviceTokenSummary) }
}

const parseRelayRevokedDevice = (value: unknown): { device_id: string; revoked: true } => {
  if (
    !isRecord(value) ||
    typeof value.device_id !== 'string' ||
    value.device_id.trim() === '' ||
    value.revoked !== true
  ) {
    throw new Error('Invalid relay revoke response: device_id and revoked=true are required')
  }
  return { device_id: value.device_id, revoked: true }
}

const parseWorkspaceSummary = (value: unknown): WorkspaceSummary => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.trim() === '' ||
    typeof value.name !== 'string' ||
    typeof value.path !== 'string'
  ) {
    throw new Error('Invalid relay workspace response: id, name, and path are required')
  }
  return value as unknown as WorkspaceSummary
}

const parseRelayWorkspaces = (value: unknown): WorkspaceSummary[] => {
  if (!isRecord(value) || !Array.isArray(value.workspaces)) {
    throw new Error('Invalid relay workspace response: workspaces must be an array')
  }
  return value.workspaces.map(parseWorkspaceSummary)
}

const parseRelayAgent = (value: unknown): TeamListItemPayload => {
  if (!isRecord(value)) throw new Error('Invalid relay agent identity')
  const supportedFields = new Set([
    'active_dispatch_id',
    'conversation_activity',
    'conversation_provider',
    'id',
    'kind',
    'last_observed_at',
    'last_pty_line',
    'name',
    'process_state',
    'provider',
    'queue_pause_reason',
    'queued_dispatch_count',
  ])
  const unsupportedField = Object.keys(value).find((field) => !supportedFields.has(field))
  if (unsupportedField) {
    throw new Error(`Invalid relay agent identity: unsupported field ${unsupportedField}`)
  }
  if (
    value.kind !== 'worker' ||
    (value.active_dispatch_id !== null && typeof value.active_dispatch_id !== 'string') ||
    (value.conversation_activity !== 'busy' &&
      value.conversation_activity !== 'idle' &&
      value.conversation_activity !== 'unknown') ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.last_observed_at !== 'number' ||
    (value.process_state !== 'running' &&
      value.process_state !== 'stopped' &&
      value.process_state !== 'crashed') ||
    (value.queue_pause_reason !== null && typeof value.queue_pause_reason !== 'string') ||
    typeof value.queued_dispatch_count !== 'number' ||
    (value.last_pty_line !== null && typeof value.last_pty_line !== 'string') ||
    (value.provider !== null && value.provider !== 'claude' && value.provider !== 'codex') ||
    (value.conversation_provider !== undefined &&
      value.conversation_provider !== null &&
      value.conversation_provider !== 'claude' &&
      value.conversation_provider !== 'codex')
  ) {
    throw new Error('Invalid relay agent identity: Worker kind and fields are required')
  }
  return value as unknown as TeamListItemPayload
}

const parseRelayAgentsAndRuns = (value: unknown): RelayAgentsAndRuns => {
  if (
    !isRecord(value) ||
    typeof value.workspace_id !== 'string' ||
    value.workspace_id.trim() === '' ||
    !Array.isArray(value.agents) ||
    !Array.isArray(value.runs)
  ) {
    throw new Error('Invalid relay agents response: workspace_id, agents, and runs are required')
  }
  return {
    agents: value.agents.map(parseRelayAgent),
    runs: value.runs as RelayAgentsAndRuns['runs'],
    workspace_id: value.workspace_id,
  }
}

const parseRelayDispatchItem = (value: unknown): MobileDispatchItem => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.workspace_id !== 'string' ||
    typeof value.to_agent_id !== 'string' ||
    typeof value.text !== 'string' ||
    typeof value.created_at !== 'number' ||
    (value.state !== 'queued' &&
      value.state !== 'submitted' &&
      value.state !== 'reported' &&
      value.state !== 'cancelled')
  ) {
    throw new Error(
      'Invalid relay dispatch response: id, workspace_id, to_agent_id, text, created_at, and state are required'
    )
  }
  const latestStatus = isRecord(value.latest_status) ? value.latest_status : null
  const parsedLatestStatus =
    latestStatus &&
    Array.isArray(latestStatus.artifacts) &&
    typeof latestStatus.notify === 'boolean' &&
    typeof latestStatus.request_id === 'string' &&
    typeof latestStatus.text === 'string' &&
    typeof latestStatus.updated_at === 'number'
      ? {
          artifacts: latestStatus.artifacts.filter(
            (artifact): artifact is string => typeof artifact === 'string'
          ) as ArtifactReference[],
          notify: latestStatus.notify,
          request_id: latestStatus.request_id,
          text: latestStatus.text,
          updated_at: latestStatus.updated_at,
        }
      : null
  return {
    artifacts: Array.isArray(value.artifacts)
      ? (value.artifacts.filter(
          (artifact): artifact is string => typeof artifact === 'string'
        ) as ArtifactReference[])
      : [],
    created_at: value.created_at,
    delivered_at: typeof value.delivered_at === 'number' ? value.delivered_at : null,
    from_agent_id: typeof value.from_agent_id === 'string' ? value.from_agent_id : null,
    id: value.id,
    ...(parsedLatestStatus ? { latest_status: parsedLatestStatus } : {}),
    reported_at: typeof value.reported_at === 'number' ? value.reported_at : null,
    report_outcome:
      value.report_outcome === 'completed' || value.report_outcome === 'failed'
        ? value.report_outcome
        : null,
    report_text: typeof value.report_text === 'string' ? value.report_text : null,
    state: value.state,
    submitted_at: typeof value.submitted_at === 'number' ? value.submitted_at : null,
    text: value.text,
    to_agent_id: value.to_agent_id,
    workspace_id: value.workspace_id,
  }
}

const parseRelayDispatches = (value: unknown): MobileDispatchItem[] => {
  if (!isRecord(value) || !Array.isArray(value.dispatches)) {
    throw new Error('Invalid relay dispatch response: dispatches must be an array')
  }
  return value.dispatches.map(parseRelayDispatchItem)
}

const parseMobileFileExchangeItem = (value: unknown): MobileFileExchangeItem => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.trim() === '' ||
    typeof value.name !== 'string' ||
    value.name.trim() === '' ||
    typeof value.mime_type !== 'string' ||
    value.mime_type.trim() === '' ||
    typeof value.size !== 'number' ||
    typeof value.created_at !== 'number'
  ) {
    throw new Error(
      'Invalid relay mobile file response: id, name, mime_type, size, and created_at are required'
    )
  }
  if ('local_path' in value && typeof value.local_path !== 'string') {
    throw new Error('Invalid relay mobile file response: local_path must be a string')
  }
  if ('expires_at' in value && typeof value.expires_at !== 'number') {
    throw new Error('Invalid relay mobile file response: expires_at must be a number')
  }
  if ('source' in value && value.source !== 'uploaded' && value.source !== 'workspace') {
    throw new Error('Invalid relay mobile file response: source must be uploaded or workspace')
  }
  if ('workspace_path' in value && typeof value.workspace_path !== 'string') {
    throw new Error('Invalid relay mobile file response: workspace_path must be a string')
  }
  return {
    created_at: value.created_at,
    ...(typeof value.expires_at === 'number' ? { expires_at: value.expires_at } : {}),
    id: value.id,
    mime_type: value.mime_type,
    name: value.name,
    size: value.size,
    ...(value.source === 'uploaded' || value.source === 'workspace'
      ? { source: value.source }
      : {}),
    ...(typeof value.workspace_path === 'string' ? { workspace_path: value.workspace_path } : {}),
  }
}

const parseMobileFileExchangeList = (value: unknown): MobileFileExchangeItem[] => {
  if (!Array.isArray(value)) {
    throw new Error('Invalid relay mobile files response: expected an array')
  }
  return value.map(parseMobileFileExchangeItem)
}

const parseRelayMobileFileDownload = (value: unknown): RelayMobileFileDownloadPayload => {
  if (
    !isRecord(value) ||
    typeof value.content_base64 !== 'string' ||
    typeof value.mime_type !== 'string' ||
    value.mime_type.trim() === '' ||
    typeof value.name !== 'string' ||
    value.name.trim() === ''
  ) {
    throw new Error(
      'Invalid relay mobile file download response: content_base64, mime_type, and name are required'
    )
  }
  return {
    content_base64: value.content_base64,
    mime_type: value.mime_type,
    name: value.name,
  }
}

export const getRelayHealth = async ({
  requestTimeoutMs,
  serverUrl,
}: {
  requestTimeoutMs?: number | undefined
  serverUrl?: string | undefined
} = {}): Promise<RelayHealthSnapshot> => {
  const response = await relayFetch(
    resolveRelayHttpUrl(serverUrl, '/health'),
    relayNoStoreRequest(),
    '/health',
    requestTimeoutMs
  )
  if (!response.ok) throw new Error(`Failed to load relay health: ${response.status}`)
  return parseRelayHealthSnapshot(await response.json())
}

export const listRelayDevices = async ({
  requestTimeoutMs,
  serverUrl,
  token,
}: {
  requestTimeoutMs?: number | undefined
  serverUrl?: string | undefined
  token: string
}): Promise<RelayDeviceSnapshot> => {
  const response = await relayFetch(
    resolveRelayHttpUrl(serverUrl, '/devices'),
    relayNoStoreRequest({
      headers: relayTokenHeaders(token),
    }),
    '/devices',
    requestTimeoutMs
  )
  if (!response.ok) throw new Error(`Failed to load relay devices: ${response.status}`)
  return parseRelayDeviceSnapshot(await response.json())
}

export const claimRelayPairingToken = async ({
  desktopId,
  deviceKind,
  deviceId,
  requestTimeoutMs,
  serverUrl,
  token,
  workspaceIds,
}: {
  desktopId?: string | undefined
  deviceKind?: 'desktop' | 'mobile' | undefined
  deviceId: string
  requestTimeoutMs?: number | undefined
  serverUrl?: string | undefined
  token: string
  workspaceIds?: string[] | undefined
}): Promise<RelayClaimedDeviceToken> => {
  const response = await relayFetch(
    resolveRelayHttpUrl(serverUrl, '/pairings/claim'),
    relayNoStoreRequest({
      body: JSON.stringify({
        ...(desktopId ? { desktop_id: desktopId } : {}),
        device_id: deviceId,
        ...(deviceKind ? { device_kind: deviceKind } : {}),
        token,
        ...(workspaceIds && workspaceIds.length > 0 ? { workspace_ids: workspaceIds } : {}),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
    '/pairings/claim',
    requestTimeoutMs
  )
  if (!response.ok) throw new Error(`Failed to claim relay pairing token: ${response.status}`)
  return parseRelayClaimedDeviceToken(await response.json())
}

export const loginRelayAccount = async ({
  desktopId,
  deviceId,
  password,
  requestTimeoutMs,
  serverUrl,
  username,
  workspaceIds,
}: {
  desktopId?: string | undefined
  deviceId: string
  password: string
  requestTimeoutMs?: number | undefined
  serverUrl?: string | undefined
  username: string
  workspaceIds?: string[] | undefined
}): Promise<RelayAccountLoginResult> => {
  const response = await relayFetch(
    resolveRelayHttpUrl(serverUrl, '/accounts/login'),
    relayNoStoreRequest({
      body: JSON.stringify({
        ...(desktopId ? { desktop_id: desktopId } : {}),
        device_id: deviceId,
        password,
        username,
        ...(workspaceIds && workspaceIds.length > 0 ? { workspace_ids: workspaceIds } : {}),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
    '/accounts/login',
    requestTimeoutMs
  )
  if (!response.ok) throw new Error(`Failed to log in to relay account: ${response.status}`)
  return parseRelayAccountLoginResult(await response.json())
}

const relayAdminHeaders = relayTokenHeaders

export const createRelayPairingToken = async ({
  adminToken,
  requestTimeoutMs,
  serverUrl,
}: {
  adminToken: string
  requestTimeoutMs?: number | undefined
  serverUrl?: string | undefined
}): Promise<RelayPairingToken> => {
  const response = await relayFetch(
    resolveRelayHttpUrl(serverUrl, '/pairings'),
    relayNoStoreRequest({
      headers: relayAdminHeaders(adminToken),
      method: 'POST',
    }),
    '/pairings',
    requestTimeoutMs
  )
  if (!response.ok) throw new Error(`Failed to create relay pairing token: ${response.status}`)
  return parseRelayPairingToken(await response.json())
}

export const listRelayPairedDevices = async ({
  adminToken,
  requestTimeoutMs,
  serverUrl,
}: {
  adminToken: string
  requestTimeoutMs?: number | undefined
  serverUrl?: string | undefined
}): Promise<{ devices: RelayDeviceTokenSummary[] }> => {
  const response = await relayFetch(
    resolveRelayHttpUrl(serverUrl, '/pairings/devices'),
    relayNoStoreRequest({
      headers: relayAdminHeaders(adminToken),
    }),
    '/pairings/devices',
    requestTimeoutMs
  )
  if (!response.ok) throw new Error(`Failed to load relay paired devices: ${response.status}`)
  return parseRelayPairedDeviceList(await response.json())
}

export const revokeRelayPairedDevice = async ({
  adminToken,
  deviceId,
  requestTimeoutMs,
  serverUrl,
}: {
  adminToken: string
  deviceId: string
  requestTimeoutMs?: number | undefined
  serverUrl?: string | undefined
}): Promise<{ device_id: string; revoked: true }> => {
  const response = await relayFetch(
    resolveRelayHttpUrl(serverUrl, `/pairings/devices/${encodeURIComponent(deviceId)}`),
    relayNoStoreRequest({
      headers: relayAdminHeaders(adminToken),
      method: 'DELETE',
    }),
    '/pairings/devices',
    requestTimeoutMs
  )
  if (!response.ok) throw new Error(`Failed to revoke relay paired device: ${response.status}`)
  return parseRelayRevokedDevice(await response.json())
}

export const toRelayMobileWebSocketUrl = ({
  desktopId,
  deviceId,
  serverUrl,
  token,
}: {
  desktopId: string
  deviceId: string
  serverUrl?: string
  token: string
}): string => {
  const url = resolveRelayWebSocketUrl(serverUrl, '/ws/mobile')
  url.searchParams.set('device_id', deviceId)
  url.searchParams.set('desktop_id', desktopId)
  url.searchParams.set('pairing_token', token)
  return url.toString()
}

const parseRelayMessage = (event: MessageEvent): RelayEnvelope => {
  const raw = typeof event.data === 'string' ? event.data : String(event.data)
  return JSON.parse(raw) as RelayEnvelope
}

const getRelayCloseReasonSuffix = (event: CloseEvent | Event): string =>
  'reason' in event && typeof event.reason === 'string' && event.reason.trim()
    ? `: ${event.reason}`
    : ''

const isRelayError = (envelope: RelayEnvelope): envelope is RelayEnvelope<RelayErrorPayload> =>
  envelope.type === 'relay_error'

const createDefaultDeviceId = () => `mobile-web-${createBrowserId('relay')}`

const base64ToBlob = (contentBase64: string, mimeType: string): Blob => {
  const binary = atob(contentBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mimeType })
}

const parseDownloadName = (response: Response, fallback: string): string => {
  const disposition = response.headers.get('content-disposition') ?? ''
  const utf8Match = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      return utf8Match[1]
    }
  }
  const nameMatch = /filename="([^"]+)"/u.exec(disposition)
  return nameMatch?.[1] ?? fallback
}

export class RelayMobileClient {
  private readonly connectTimeoutMs: number
  private readonly desktopId: string
  private readonly deviceId: string
  private readonly mobileEventsReconnectDelayMs: number
  private readonly requestTimeoutMs: number
  private readonly serverUrl: string | undefined
  private readonly socketConstructor: RelayWebSocketConstructor
  private readonly token: string
  private pending = new Map<
    string,
    {
      expectedType: string
      reject: (error: Error) => void
      resolve: (payload: unknown) => void
      timeout: ReturnType<typeof setTimeout>
    }
  >()
  private mobileEventSubscriptions = new Map<
    string,
    {
      onClose?: (message: string, meta?: RelayMobileEventsReconnectMeta) => void
      onConversationInvalidated?: (invalidation: MobileConversationInvalidation) => void
      onError?: (error: Error) => void
      onHeartbeat?: (generatedAt: number) => void
      onSnapshot: (snapshot: MobileSnapshot) => void
    }
  >()
  private connecting: Promise<void> | null = null
  private mobileEventsReconnectAttempt = 0
  private mobileEventsReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private socket: RelayWebSocketLike | null = null

  constructor({
    connectTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    desktopId,
    deviceId = createDefaultDeviceId(),
    mobileEventsReconnectDelayMs = DEFAULT_MOBILE_EVENTS_RECONNECT_DELAY_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    serverUrl,
    token,
    webSocketConstructor = WebSocket,
  }: RelayMobileClientOptions) {
    this.connectTimeoutMs = connectTimeoutMs
    this.desktopId = desktopId
    this.deviceId = deviceId
    this.mobileEventsReconnectDelayMs = mobileEventsReconnectDelayMs
    this.requestTimeoutMs = requestTimeoutMs
    this.serverUrl = normalizeRelayServerUrl(serverUrl)
    this.socketConstructor = webSocketConstructor
    this.token = token
  }

  connect(): Promise<void> {
    if (this.socket?.readyState === this.socketConstructor.OPEN) return Promise.resolve()
    if (this.connecting) return this.connecting

    const socket = new this.socketConstructor(
      toRelayMobileWebSocketUrl({
        desktopId: this.desktopId,
        deviceId: this.deviceId,
        ...(this.serverUrl ? { serverUrl: this.serverUrl } : {}),
        token: this.token,
      })
    )
    this.socket = socket

    this.connecting = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        rejectConnection('Relay mobile socket connection timed out')
        socket.close()
      }, this.connectTimeoutMs)
      const cleanup = () => {
        clearTimeout(timeout)
        socket.removeEventListener('close', handleCloseBeforeOpen)
        socket.removeEventListener('open', handleOpen)
        socket.removeEventListener('error', handleError)
      }
      const rejectConnection = (message: string) => {
        cleanup()
        this.connecting = null
        if (this.socket === socket) this.socket = null
        reject(new Error(message))
      }
      const handleCloseBeforeOpen = (event: CloseEvent | Event) => {
        rejectConnection(
          `Relay mobile socket closed before connecting${getRelayCloseReasonSuffix(event)}`
        )
      }
      const handleOpen = () => {
        cleanup()
        this.connecting = null
        this.resetMobileEventsReconnectAttempt()
        socket.addEventListener('message', this.handleMessage)
        socket.addEventListener('close', this.handleClose)
        resolve()
      }
      const handleError = () => {
        rejectConnection('Relay mobile socket failed to connect')
      }
      socket.addEventListener('close', handleCloseBeforeOpen)
      socket.addEventListener('open', handleOpen)
      socket.addEventListener('error', handleError)
    })
    return this.connecting
  }

  close(): void {
    const socket = this.socket
    if (socket) {
      socket.removeEventListener('message', this.handleMessage)
      socket.removeEventListener('close', this.handleClose)
      socket.close()
    }
    this.socket = null
    this.connecting = null
    this.clearMobileEventsReconnectTimer()
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(`Relay request cancelled: ${requestId}`))
    }
    this.pending.clear()
    for (const subscription of this.mobileEventSubscriptions.values()) {
      subscription.onClose?.('Relay mobile socket closed')
    }
    this.mobileEventSubscriptions.clear()
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    return parseRelayWorkspaces(await this.request('list_workspaces', {}))
  }

  async listAgentsAndRuns(workspaceId: string): Promise<RelayAgentsAndRuns> {
    return parseRelayAgentsAndRuns(
      await this.request('list_agents_and_runs', {
        workspace_id: workspaceId,
      })
    )
  }

  async listDispatches(workspaceId: string): Promise<MobileDispatchItem[]> {
    return parseRelayDispatches(
      await this.request('list_dispatches', {
        workspace_id: workspaceId,
      })
    )
  }

  sendMobileAction(actionBody: unknown): Promise<unknown> {
    return this.request('mobile_action', actionBody)
  }

  createMobileConfirmation(confirmationBody: unknown): Promise<unknown> {
    return this.request('create_mobile_confirmation', confirmationBody)
  }

  getMobileTranscript(workspaceId: string, runId: string): Promise<MobileTranscript> {
    return this.request('get_mobile_transcript', {
      run_id: runId,
      workspace_id: workspaceId,
    }) as Promise<MobileTranscript>
  }

  getMobileConversation(workspaceId: string, agentId: string, cursor?: number): Promise<unknown> {
    return this.request('get_mobile_conversation', {
      agent_id: agentId,
      ...(cursor !== undefined ? { cursor: String(cursor) } : {}),
      workspace_id: workspaceId,
    })
  }

  getMobileConversations(workspaceId: string, agentId: string, cursor?: string): Promise<unknown> {
    return this.request('get_mobile_conversations', {
      agent_id: agentId,
      ...(cursor ? { cursor } : {}),
      workspace_id: workspaceId,
    })
  }

  getMobileRecordedConversation(
    workspaceId: string,
    agentId: string,
    conversationId: string,
    cursor?: string
  ): Promise<unknown> {
    return this.request('get_mobile_recorded_conversation', {
      agent_id: agentId,
      conversation_id: conversationId,
      ...(cursor ? { cursor } : {}),
      workspace_id: workspaceId,
    })
  }

  listMobileFiles(): Promise<MobileFileExchangeItem[]> {
    return this.request('list_mobile_files', {}).then(parseMobileFileExchangeList)
  }

  async uploadMobileFile(file: RelayMobileFileUpload): Promise<MobileFileExchangeItem> {
    return parseMobileFileExchangeItem(await this.request('upload_mobile_file', file))
  }

  async sendWorkspaceFileToMobile(
    workspaceId: string,
    path: string
  ): Promise<MobileFileExchangeItem> {
    return parseMobileFileExchangeItem(
      await this.request('send_workspace_file_to_mobile', {
        path,
        workspace_id: workspaceId,
      })
    )
  }

  async downloadMobileFile(
    fileId: string,
    onProgress?: MobileFileDownloadProgressHandler,
    chatAttachment?: { submissionId: string; workspaceId: string }
  ): Promise<MobileFileDownload> {
    try {
      const url = new URL(
        resolveRelayHttpUrl(
          this.serverUrl,
          `/api/relay/mobile-files/${encodeURIComponent(fileId)}`
        ),
        getBrowserOrigin()
      )
      url.searchParams.set('desktop_id', this.desktopId)
      url.searchParams.set('device_id', this.deviceId)
      url.searchParams.set('token', this.token)
      if (chatAttachment) {
        url.searchParams.set('submission_id', chatAttachment.submissionId)
        url.searchParams.set('workspace_id', chatAttachment.workspaceId)
      }
      const response = await relayFetch(
        url.toString(),
        relayNoStoreRequest({ headers: relayTokenHeaders(this.token) }),
        `download mobile file ${fileId}`,
        Math.max(this.requestTimeoutMs, 10 * 60 * 1000)
      )
      if (!response.ok) {
        const message = await response.text().catch(() => '')
        throw new Error(message || `Relay file download failed: ${response.status}`)
      }
      const mimeType = response.headers.get('content-type') ?? 'application/octet-stream'
      return {
        content: await readResponseBlobWithProgress(response, mimeType, onProgress),
        mime_type: mimeType,
        name: parseDownloadName(response, fileId),
      }
    } catch {
      // Older relay servers do not expose the HTTP streaming endpoint. Keep the legacy
      // websocket/base64 download as a compatibility fallback.
    }
    const payload = parseRelayMobileFileDownload(
      await this.request('download_mobile_file', {
        file_id: fileId,
        ...(chatAttachment
          ? {
              submission_id: chatAttachment.submissionId,
              workspace_id: chatAttachment.workspaceId,
            }
          : {}),
      })
    )
    onProgress?.({ loadedBytes: 0, totalBytes: null })
    const content = base64ToBlob(payload.content_base64, payload.mime_type)
    onProgress?.({ loadedBytes: content.size, totalBytes: content.size })
    return {
      content,
      mime_type: payload.mime_type,
      name: payload.name,
    }
  }

  async deleteMobileFile(fileId: string): Promise<void> {
    await this.request('delete_mobile_file', { file_id: fileId })
  }

  async clearMobileFiles(): Promise<void> {
    await this.request('clear_mobile_files', {})
  }

  subscribeMobileEvents({
    onClose,
    onConversationInvalidated,
    onError,
    onHeartbeat,
    onSnapshot,
  }: RelayMobileEventsSubscriptionOptions): RelayMobileEventsSubscription {
    const subscriptionId = createBrowserId('mobile-events')
    let disposed = false
    this.mobileEventSubscriptions.set(subscriptionId, {
      ...(onClose ? { onClose } : {}),
      ...(onConversationInvalidated ? { onConversationInvalidated } : {}),
      ...(onError ? { onError } : {}),
      ...(onHeartbeat ? { onHeartbeat } : {}),
      onSnapshot,
    })

    void this.subscribeMobileEventsEnvelope(subscriptionId, () => disposed)
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        this.mobileEventSubscriptions.delete(subscriptionId)
        if (this.mobileEventSubscriptions.size === 0) this.clearMobileEventsReconnectTimer()
        this.sendMobileEventsEnvelope('unsubscribe_mobile_events', subscriptionId)
      },
    }
  }

  private clearMobileEventsReconnectTimer(): void {
    if (!this.mobileEventsReconnectTimer) return
    clearTimeout(this.mobileEventsReconnectTimer)
    this.mobileEventsReconnectTimer = null
  }

  private resetMobileEventsReconnectAttempt(): void {
    this.mobileEventsReconnectAttempt = 0
  }

  private getNextMobileEventsReconnectDelay(): RelayMobileEventsReconnectMeta {
    const attempt = this.mobileEventsReconnectAttempt + 1
    const nextDelayMs = Math.min(
      this.mobileEventsReconnectDelayMs * 2 ** (attempt - 1),
      MAX_MOBILE_EVENTS_RECONNECT_DELAY_MS
    )
    this.mobileEventsReconnectAttempt = attempt
    return { attempt, nextDelayMs }
  }

  private scheduleMobileEventsReconnect(): RelayMobileEventsReconnectMeta | null {
    if (this.mobileEventSubscriptions.size === 0 || this.mobileEventsReconnectTimer) return null
    const meta = this.getNextMobileEventsReconnectDelay()
    this.mobileEventsReconnectTimer = setTimeout(() => {
      this.mobileEventsReconnectTimer = null
      for (const subscriptionId of Array.from(this.mobileEventSubscriptions.keys())) {
        void this.subscribeMobileEventsEnvelope(subscriptionId)
      }
    }, meta.nextDelayMs)
    return meta
  }

  private async subscribeMobileEventsEnvelope(
    subscriptionId: string,
    isDisposed: () => boolean = () => false
  ): Promise<void> {
    const subscription = this.mobileEventSubscriptions.get(subscriptionId)
    if (!subscription) return
    try {
      await this.connect()
      if (isDisposed() || !this.mobileEventSubscriptions.has(subscriptionId)) return
      this.sendMobileEventsEnvelope('subscribe_mobile_events', subscriptionId)
    } catch (error) {
      if (isDisposed()) return
      subscription.onError?.(
        new Error(
          `Relay mobile events subscribe failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      )
      const reconnect = this.scheduleMobileEventsReconnect()
      if (reconnect) subscription.onClose?.('Relay mobile events subscribe failed', reconnect)
    }
  }

  private async request<TPayload>(type: string, payload: unknown): Promise<TPayload> {
    await this.connect()
    const socket = this.socket
    if (!socket || socket.readyState !== this.socketConstructor.OPEN) {
      return Promise.reject(new Error('Relay mobile socket is not connected'))
    }

    const requestId = createBrowserId('relay-request')
    const expectedType = `${type}_result`
    const envelope: RelayEnvelope = {
      channel: 'runtime',
      from: this.deviceId,
      payload,
      request_id: requestId,
      to: this.desktopId,
      type,
    }

    return new Promise<TPayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Relay request timed out: ${type}`))
      }, this.requestTimeoutMs)
      this.pending.set(requestId, {
        expectedType,
        reject,
        resolve: (value) => resolve(value as TPayload),
        timeout,
      })
      try {
        socket.send(JSON.stringify(envelope))
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(requestId)
        reject(
          new Error(
            `Relay request send failed: ${error instanceof Error ? error.message : String(error)}`
          )
        )
      }
    })
  }

  private sendMobileEventsEnvelope(type: string, subscriptionId: string): void {
    const socket = this.socket
    if (!socket || socket.readyState !== this.socketConstructor.OPEN) return
    const envelope: RelayEnvelope = {
      channel: 'mobile_events',
      from: this.deviceId,
      payload: { subscription_id: subscriptionId },
      request_id: subscriptionId,
      to: this.desktopId,
      type,
    }
    try {
      socket.send(JSON.stringify(envelope))
    } catch (error) {
      const subscription = this.mobileEventSubscriptions.get(subscriptionId)
      subscription?.onError?.(
        new Error(
          `Relay mobile events send failed: ${error instanceof Error ? error.message : String(error)}`
        )
      )
      this.scheduleMobileEventsReconnect()
      if (this.socket === socket) socket.close()
    }
  }

  private isExpectedResponse(envelope: RelayEnvelope, expectedType: string): boolean {
    if (isRelayError(envelope)) {
      return (
        (envelope.from === 'relay' || envelope.from === this.desktopId) &&
        envelope.to === this.deviceId
      )
    }
    return (
      envelope.channel === 'runtime' &&
      envelope.from === this.desktopId &&
      envelope.to === this.deviceId &&
      envelope.type === expectedType
    )
  }

  private handleMessage = (event: MessageEvent) => {
    let envelope: RelayEnvelope
    try {
      envelope = parseRelayMessage(event)
    } catch {
      return
    }
    if (this.handleMobileEventsMessage(envelope)) return
    if (!envelope.request_id) return
    const pending = this.pending.get(envelope.request_id)
    if (!pending) return
    if (!this.isExpectedResponse(envelope, pending.expectedType)) return
    this.pending.delete(envelope.request_id)
    clearTimeout(pending.timeout)

    if (isRelayError(envelope)) {
      pending.reject(new RelayRuntimeError(envelope.payload))
      return
    }
    pending.resolve(envelope.payload)
  }

  private handleMobileEventsMessage(envelope: RelayEnvelope): boolean {
    if (
      envelope.channel !== 'mobile_events' ||
      envelope.from !== this.desktopId ||
      envelope.to !== this.deviceId ||
      !envelope.request_id
    ) {
      return false
    }
    const subscription = this.mobileEventSubscriptions.get(envelope.request_id)
    if (!subscription) return false

    if (envelope.type === 'mobile_events_message') {
      const message = parseMobileEventsServerMessage(JSON.stringify(envelope.payload))
      if (!message) return true
      if (message.type === 'mobile-snapshot') {
        this.resetMobileEventsReconnectAttempt()
        subscription.onSnapshot(message.snapshot)
      } else if (message.type === 'conversation-invalidated') {
        this.resetMobileEventsReconnectAttempt()
        subscription.onConversationInvalidated?.(message)
      } else {
        this.resetMobileEventsReconnectAttempt()
        subscription.onHeartbeat?.(message.generated_at)
      }
      return true
    }

    if (envelope.type === 'mobile_events_close') {
      const reason =
        isRecord(envelope.payload) && typeof envelope.payload.reason === 'string'
          ? envelope.payload.reason
          : 'Relay mobile events closed'
      const reconnect = this.scheduleMobileEventsReconnect()
      subscription.onClose?.(reason, reconnect ?? undefined)
      return true
    }

    return false
  }

  private handleClose = (event: CloseEvent | Event) => {
    this.connecting = null
    this.socket = null
    const reason = getRelayCloseReasonSuffix(event)
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(`Relay socket closed before response: ${requestId}${reason}`))
    }
    this.pending.clear()
    const subscriptionIds = Array.from(this.mobileEventSubscriptions.keys())
    const reconnect = subscriptionIds.length > 0 ? this.scheduleMobileEventsReconnect() : null
    for (const subscription of this.mobileEventSubscriptions.values()) {
      subscription.onClose?.(`Relay mobile socket closed${reason}`, reconnect ?? undefined)
    }
  }
}
