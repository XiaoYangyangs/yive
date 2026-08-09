import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readPackageVersion } from '../server/package-version.js'
import {
  normalizeRelayDeviceId,
  normalizeRelayDeviceKind,
  normalizeRelayWorkspaceIds,
  type PairingStore,
} from './pairing-store.js'
import type { RelayHub, RelayHubSnapshot } from './relay-hub.js'

export const RELAY_HTTP_PROTOCOL_VERSION = 2
export const RELAY_FEATURES = [
  'mobile_confirmations',
  'mobile_events',
  'mobile_file_exchange',
  'terminal_proxy',
] as const
const MAX_RELAY_JSON_BODY_BYTES = 16 * 1024

export interface RelayHttpOptions {
  accountLogin?: RelayAccountLoginOptions | undefined
  publicUrl?: string | undefined
  requireDesktopBinding?: boolean | undefined
  startedAt?: number | undefined
  staticDir?: string | undefined
}

export interface RelayAccountLoginOptions {
  desktopId?: string | undefined
  password: string
  username: string
}

const applyCorsHeaders = (response: ServerResponse) => {
  response.setHeader('access-control-allow-origin', '*')
  response.setHeader(
    'access-control-allow-headers',
    'authorization, content-type, x-hive-relay-token, x-yive-relay-token'
  )
  response.setHeader('access-control-allow-methods', 'GET, HEAD, POST, DELETE, OPTIONS')
  response.setHeader('access-control-max-age', '600')
}

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  options: { bodyless?: boolean } = {}
) => {
  response.statusCode = statusCode
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(options.bodyless ? undefined : JSON.stringify(body))
}

const firstHeader = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value

const readBearerToken = (value: string | undefined) => {
  const match = /^Bearer\s+(.+)$/iu.exec(value ?? '')
  return match?.[1]?.trim() || null
}

const readRelayToken = (request: IncomingMessage, url: URL) =>
  firstHeader(request.headers['x-yive-relay-token'])?.trim() ||
  firstHeader(request.headers['x-hive-relay-token'])?.trim() ||
  readBearerToken(firstHeader(request.headers.authorization)) ||
  url.searchParams.get('token')?.trim() ||
  null

const readRelayAdminToken = readRelayToken

const encodeDownloadFileName = (name: string): string => {
  const fallback = name.replace(/["\\\r\n]/gu, '_') || 'download'
  const encoded = encodeURIComponent(name)
    .replace(/['()]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/gu, '%2A')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

class RelayHttpBodyError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message)
  }
}

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += buffer.byteLength
    if (byteLength > MAX_RELAY_JSON_BODY_BYTES) {
      throw new RelayHttpBodyError(413, 'Relay request body is too large')
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new RelayHttpBodyError(400, 'Invalid JSON body')
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readBodyString = (body: unknown, field: string): string | null => {
  if (!isRecord(body)) return null
  const value = body[field]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

const readBodyStringArray = (body: unknown, field: string): string[] | null => {
  if (!isRecord(body) || body[field] === undefined) return null
  const value = body[field]
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}

const chooseAccountLoginDesktopId = (
  body: unknown,
  snapshot: RelayHubSnapshot,
  accountLogin: RelayAccountLoginOptions
): string | null => {
  if (accountLogin.desktopId) return accountLogin.desktopId
  const requestedDesktopId = normalizeRelayDeviceId(readBodyString(body, 'desktop_id'))
  if (requestedDesktopId) return requestedDesktopId
  const onlineDesktops = snapshot.desktops.filter((desktop) => desktop.runtime_status !== 'offline')
  if (onlineDesktops.length === 1) return onlineDesktops[0]?.device_id ?? null
  if (snapshot.desktops.length === 1) return snapshot.desktops[0]?.device_id ?? null
  return null
}

const getDefaultStaticDir = () => {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  if (moduleDir.includes(`${sep}dist${sep}src${sep}`)) {
    return resolve(moduleDir, '../../../web/dist')
  }
  return resolve(moduleDir, '../../web/dist')
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

const PWA_BOOT_CACHE_CONTROL: Record<string, string> = {
  '/': 'no-store',
  '/index.html': 'no-store',
  '/manifest.webmanifest': 'max-age=0, must-revalidate',
  '/mobile': 'no-store',
  '/sw.js': 'no-store',
}

const resolveRelayStaticDir = (input?: string) =>
  input ?? process.env.HIVE_RELAY_STATIC_DIR ?? process.env.HIVE_STATIC_DIR ?? getDefaultStaticDir()

const canServeStatic = async (staticDir: string) => {
  try {
    await access(join(staticDir, 'index.html'), constants.F_OK)
    return true
  } catch {
    return false
  }
}

const getStaticStatus = async (staticDir: string) => ({
  mobile_app_available: await canServeStatic(staticDir),
})

const filterDeviceSnapshotForToken = (
  snapshot: RelayHubSnapshot,
  deviceToken: NonNullable<ReturnType<PairingStore['getDeviceToken']>>
) => {
  const visibleDesktopIds = new Set<string>()
  if (deviceToken.desktop_id) visibleDesktopIds.add(deviceToken.desktop_id)
  for (const mobile of snapshot.mobiles) {
    if (mobile.device_id === deviceToken.device_id) visibleDesktopIds.add(mobile.desktop_id)
  }

  return {
    desktops: snapshot.desktops.filter((desktop) => visibleDesktopIds.has(desktop.device_id)),
    mobiles: snapshot.mobiles.filter(
      (mobile) =>
        mobile.device_id === deviceToken.device_id || visibleDesktopIds.has(mobile.desktop_id)
    ),
  }
}

const hasActiveMobileDevice = (
  snapshot: RelayHubSnapshot,
  deviceToken: NonNullable<ReturnType<PairingStore['getDeviceToken']>>
) => snapshot.mobiles.some((mobile) => mobile.device_id === deviceToken.device_id)

const getVisibleDeviceSnapshot = (
  snapshot: RelayHubSnapshot,
  deviceToken: NonNullable<ReturnType<PairingStore['getDeviceToken']>>
) => {
  if (deviceToken.desktop_id || hasActiveMobileDevice(snapshot, deviceToken)) {
    return filterDeviceSnapshotForToken(snapshot, deviceToken)
  }
  return {
    desktops: snapshot.desktops,
    mobiles: snapshot.mobiles,
  }
}

const getAdminDeviceSnapshot = (snapshot: RelayHubSnapshot) => ({
  desktops: snapshot.desktops,
  mobiles: snapshot.mobiles,
})

const getStaticAssetPath = (staticDir: string, pathname: string) => {
  const staticRoot = resolve(staticDir)
  if (pathname === '/' || extname(pathname) === '') return join(staticRoot, 'index.html')
  const candidate = resolve(staticRoot, `.${pathname}`)
  if (candidate === staticRoot || candidate.startsWith(`${staticRoot}${sep}`)) return candidate
  return undefined
}

const sendStatic = async (
  response: ServerResponse,
  staticDir: string,
  pathname: string,
  method: string
) => {
  if (method !== 'GET' && method !== 'HEAD') return false
  const filePath = getStaticAssetPath(staticDir, pathname)
  if (!filePath) return false
  try {
    const content = await readFile(filePath)
    response.setHeader(
      'content-type',
      CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream'
    )
    const cacheControl = PWA_BOOT_CACHE_CONTROL[pathname]
    if (cacheControl !== undefined) response.setHeader('cache-control', cacheControl)
    response.statusCode = 200
    response.end(method === 'HEAD' ? undefined : content)
    return true
  } catch {
    return false
  }
}

export const handleRelayHttpRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  hub: RelayHub,
  pairingStore: PairingStore,
  options: RelayHttpOptions = {}
) => {
  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  applyCorsHeaders(response)

  if (method === 'OPTIONS') {
    response.statusCode = 204
    response.end()
    return
  }

  if ((method === 'GET' || method === 'HEAD') && url.pathname === '/health') {
    const snapshot = hub.snapshot()
    const staticDir = resolveRelayStaticDir(options.staticDir)
    const settings = hub.settingsSnapshot()
    const pairingStoreDiagnostics = pairingStore.diagnostics()
    const now = Date.now()
    const startedAt = options.startedAt ?? now
    sendJson(
      response,
      200,
      {
        ok: true,
        service: 'hive-relay',
        version: readPackageVersion(),
        protocol_version: RELAY_HTTP_PROTOCOL_VERSION,
        features: RELAY_FEATURES,
        deployment: {
          public_url_configured: Boolean(options.publicUrl?.trim()),
        },
        pairing_store: {
          admin_token_default: pairingStoreDiagnostics.admin_token_default,
          device_token_count: pairingStoreDiagnostics.device_token_count,
          issued_token_count: pairingStoreDiagnostics.issued_token_count,
          persistent: pairingStoreDiagnostics.persistent,
          require_desktop_binding: Boolean(options.requireDesktopBinding),
        },
        started_at: startedAt,
        static: await getStaticStatus(staticDir),
        terminal_proxy_count: snapshot.terminalProxyCount,
        heartbeat_interval_ms: settings.heartbeat_interval_ms,
        heartbeat_timeout_ms: settings.heartbeat_timeout_ms,
        uptime_ms: Math.max(0, now - startedAt),
        desktop_count: snapshot.desktopCount,
        mobile_count: snapshot.mobileCount,
      },
      { bodyless: method === 'HEAD' }
    )
    return
  }

  if (method === 'GET' && url.pathname === '/devices') {
    const token = readRelayToken(request, url)
    const isAdmin = pairingStore.validateAdminToken(token)
    const deviceToken = pairingStore.getDeviceToken(token)
    if (!isAdmin && !deviceToken) {
      sendJson(response, 401, { error: 'Invalid relay token' })
      return
    }
    if (!isAdmin && options.requireDesktopBinding && !deviceToken?.desktop_id) {
      sendJson(response, 403, { error: 'Relay device token is not bound to a desktop' })
      return
    }
    const snapshot = hub.snapshot()
    sendJson(
      response,
      200,
      isAdmin || !deviceToken
        ? getAdminDeviceSnapshot(snapshot)
        : getVisibleDeviceSnapshot(snapshot, deviceToken)
    )
    return
  }

  if (
    (method === 'GET' || method === 'HEAD') &&
    url.pathname.startsWith('/api/relay/mobile-files/')
  ) {
    const token = readRelayToken(request, url)
    const desktopId = normalizeRelayDeviceId(url.searchParams.get('desktop_id'))
    const deviceId = normalizeRelayDeviceId(url.searchParams.get('device_id'))
    const fileId = decodeURIComponent(url.pathname.slice('/api/relay/mobile-files/'.length))
    const workspaceId = url.searchParams.get('workspace_id')?.trim()
    const submissionId = url.searchParams.get('submission_id')?.trim()
    if (!desktopId || !deviceId || !fileId.trim()) {
      sendJson(response, 400, { error: 'desktop_id, device_id, and file id are required' })
      return
    }
    if (Boolean(workspaceId) !== Boolean(submissionId)) {
      sendJson(response, 400, { error: 'workspace_id and submission_id are required together' })
      return
    }
    if (
      !pairingStore.validateConnectionTokenForDevice({
        desktopId,
        deviceId,
        requireDesktopBinding: Boolean(options.requireDesktopBinding),
        token,
      })
    ) {
      sendJson(response, 401, { error: 'Invalid relay token' })
      return
    }

    let headersSent = false
    const deviceToken = pairingStore.getDeviceToken(token)
    try {
      await hub.streamMobileFileDownload({
        desktopId,
        deviceId,
        fileId,
        ...(workspaceId && submissionId ? { chatAttachment: { submissionId, workspaceId } } : {}),
        onChunk: (chunk) => {
          if (method !== 'HEAD' && !response.destroyed) response.write(chunk)
        },
        onEnd: () => {
          if (!response.destroyed && !response.writableEnded) response.end()
        },
        onHeaders: ({ mimeType, name, size }) => {
          headersSent = true
          response.statusCode = 200
          response.setHeader('cache-control', 'no-store')
          response.setHeader('content-type', mimeType)
          response.setHeader('content-disposition', encodeDownloadFileName(name))
          if (size !== undefined) response.setHeader('content-length', String(size))
          if (method === 'HEAD' && !response.writableEnded) response.end()
        },
        ...(deviceToken?.workspace_ids ? { workspaceIds: deviceToken.workspace_ids } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Relay file download failed'
      if (!headersSent && !response.headersSent) {
        sendJson(response, 502, { error: message })
      } else if (!response.destroyed) {
        response.destroy(error instanceof Error ? error : new Error(message))
      }
    }
    return
  }

  if (method === 'POST' && url.pathname === '/pairings') {
    if (!pairingStore.validateAdminToken(readRelayAdminToken(request, url))) {
      sendJson(response, 401, { error: 'Invalid relay admin token' })
      return
    }
    sendJson(response, 201, pairingStore.createPairingToken())
    return
  }

  if (method === 'POST' && url.pathname === '/pairings/claim') {
    let body: unknown
    try {
      body = await readJsonBody(request)
    } catch (error) {
      if (error instanceof RelayHttpBodyError) {
        sendJson(response, error.statusCode, { error: error.message })
        return
      }
      throw error
    }
    const deviceId = normalizeRelayDeviceId(readBodyString(body, 'device_id'))
    if (!deviceId) {
      sendJson(response, 400, { error: 'Invalid device_id' })
      return
    }
    const desktopIdInput = readBodyString(body, 'desktop_id')
    const desktopId = desktopIdInput ? normalizeRelayDeviceId(desktopIdInput) : undefined
    if (desktopIdInput && !desktopId) {
      sendJson(response, 400, { error: 'Invalid desktop_id' })
      return
    }
    const deviceKindInput = readBodyString(body, 'device_kind')
    const deviceKind = deviceKindInput ? normalizeRelayDeviceKind(deviceKindInput) : undefined
    if (deviceKindInput && !deviceKind) {
      sendJson(response, 400, { error: 'Invalid device_kind' })
      return
    }
    const workspaceIdsInput = readBodyStringArray(body, 'workspace_ids')
    const workspaceIds = workspaceIdsInput
      ? normalizeRelayWorkspaceIds(workspaceIdsInput)
      : undefined
    if (workspaceIdsInput && !workspaceIds) {
      sendJson(response, 400, { error: 'Invalid workspace_ids' })
      return
    }
    const claimed = pairingStore.claimPairingToken({
      ...(desktopId ? { desktopId } : {}),
      ...(deviceKind ? { deviceKind } : {}),
      deviceId,
      token: readBodyString(body, 'token'),
      ...(workspaceIds ? { workspaceIds } : {}),
    })
    if (!claimed) {
      sendJson(response, 401, { error: 'Invalid or expired pairing token' })
      return
    }
    sendJson(response, 201, claimed)
    return
  }

  if (method === 'POST' && url.pathname === '/accounts/login') {
    if (!options.accountLogin) {
      sendJson(response, 404, { error: 'Relay account login is not configured' })
      return
    }
    let body: unknown
    try {
      body = await readJsonBody(request)
    } catch (error) {
      if (error instanceof RelayHttpBodyError) {
        sendJson(response, error.statusCode, { error: error.message })
        return
      }
      throw error
    }
    const username = readBodyString(body, 'username')
    const password = readBodyString(body, 'password')
    if (username !== options.accountLogin.username || password !== options.accountLogin.password) {
      sendJson(response, 401, { error: 'Invalid relay account credentials' })
      return
    }
    const deviceId = normalizeRelayDeviceId(readBodyString(body, 'device_id'))
    if (!deviceId) {
      sendJson(response, 400, { error: 'Invalid device_id' })
      return
    }
    const workspaceIdsInput = readBodyStringArray(body, 'workspace_ids')
    const workspaceIds = workspaceIdsInput
      ? normalizeRelayWorkspaceIds(workspaceIdsInput)
      : undefined
    if (workspaceIdsInput && !workspaceIds) {
      sendJson(response, 400, { error: 'Invalid workspace_ids' })
      return
    }
    const snapshot = hub.snapshot()
    const desktopId = chooseAccountLoginDesktopId(body, snapshot, options.accountLogin)
    if (!desktopId) {
      sendJson(response, 409, { error: 'Choose a desktop before logging in' })
      return
    }
    const desktopExists = snapshot.desktops.some((desktop) => desktop.device_id === desktopId)
    if (!desktopExists) {
      sendJson(response, 404, { error: 'Desktop is not online' })
      return
    }
    const token = pairingStore.createDeviceToken({
      desktopId,
      deviceId,
      deviceKind: 'mobile',
      ...(workspaceIds ? { workspaceIds } : {}),
    })
    if (!token) {
      sendJson(response, 400, { error: 'Unable to create mobile device token' })
      return
    }
    sendJson(response, 201, token)
    return
  }

  if (method === 'GET' && url.pathname === '/pairings/devices') {
    if (!pairingStore.validateAdminToken(readRelayAdminToken(request, url))) {
      sendJson(response, 401, { error: 'Invalid relay admin token' })
      return
    }
    sendJson(response, 200, { devices: pairingStore.listDeviceTokens() })
    return
  }

  if (method === 'DELETE' && url.pathname.startsWith('/pairings/devices/')) {
    if (!pairingStore.validateAdminToken(readRelayAdminToken(request, url))) {
      sendJson(response, 401, { error: 'Invalid relay admin token' })
      return
    }
    const deviceId = decodeURIComponent(url.pathname.slice('/pairings/devices/'.length))
    const revoked = pairingStore.revokeDeviceTokens({ deviceId })
    if (!revoked) {
      sendJson(response, 404, { error: 'Device token not found' })
      return
    }
    hub.disconnectDevice(deviceId)
    sendJson(response, 200, { device_id: deviceId, revoked: true })
    return
  }

  if (url.pathname.startsWith('/ws/')) {
    sendJson(response, 404, { error: 'Not found' })
    return
  }

  const staticDir = resolveRelayStaticDir(options.staticDir)
  if (await canServeStatic(staticDir)) {
    const served = await sendStatic(response, staticDir, url.pathname, method)
    if (served) return
  }

  sendJson(response, 404, { error: 'Not found' })
}
