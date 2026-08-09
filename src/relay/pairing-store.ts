import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type {
  RelayDeviceKind,
  RelayDeviceTokenSummary,
  RelayPairingToken,
} from '../shared/relay-types.js'

export type {
  RelayDeviceKind,
  RelayDeviceTokenSummary,
  RelayPairingToken,
} from '../shared/relay-types.js'

export interface RelayDeviceToken {
  desktop_id?: string | undefined
  device_id: string
  device_kind?: RelayDeviceKind | undefined
  token: string
  workspace_ids?: string[] | undefined
}

export interface PairingStore {
  claimPairingToken: (input: {
    desktopId?: string | null | undefined
    deviceKind?: RelayDeviceKind | null | undefined
    deviceId: string
    token: string | null
    workspaceIds?: string[] | null | undefined
  }) => RelayDeviceToken | null
  createDeviceToken: (input: {
    desktopId?: string | null | undefined
    deviceKind?: RelayDeviceKind | null | undefined
    deviceId: string
    workspaceIds?: string[] | null | undefined
  }) => RelayDeviceToken | null
  createPairingToken: () => RelayPairingToken
  diagnostics: () => RelayPairingStoreDiagnostics
  getDeviceToken: (token: string | null) => RelayDeviceTokenSummary | null
  listDeviceTokens: () => RelayDeviceTokenSummary[]
  revokeDeviceTokens: (input: { deviceId: string }) => boolean
  validateAdminToken: (token: string | null) => boolean
  validateConnectionTokenForDevice: (input: {
    desktopId?: string | null | undefined
    deviceId: string
    requireDesktopBinding?: boolean | undefined
    token: string | null
  }) => boolean
  validateToken: (token: string | null) => boolean
  validateTokenForDevice: (input: {
    desktopId?: string | null | undefined
    deviceId: string
    requireDesktopBinding?: boolean | undefined
    token: string | null
  }) => boolean
}

export interface RelayPairingStoreDiagnostics {
  admin_token_default: boolean
  device_token_count: number
  issued_token_count: number
  persistent: boolean
  storage_path?: string
}

export interface CreateDevelopmentPairingStoreOptions {
  storagePath?: string | undefined
  token?: string | undefined
  tokenTtlMs?: number | undefined
}

const DEFAULT_DEV_TOKEN = 'dev-relay-token'
export const DEFAULT_PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000
export const MAX_RELAY_DEVICE_ID_LENGTH = 80

const createToken = () => randomBytes(9).toString('base64url')

const summarizeToken = (token: string) =>
  token.length <= 10 ? `${token.slice(0, 2)}...` : `${token.slice(0, 6)}...${token.slice(-4)}`
const hashToken = (token: string) => `sha256:${createHash('sha256').update(token).digest('hex')}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const normalizeRelayDeviceId = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim()
  if (!trimmed || trimmed.length > MAX_RELAY_DEVICE_ID_LENGTH) return null
  for (const character of trimmed) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return null
  }
  return trimmed
}

export const normalizeRelayDeviceKind = (
  value: string | null | undefined
): RelayDeviceKind | undefined => (value === 'desktop' || value === 'mobile' ? value : undefined)

export const normalizeRelayWorkspaceIds = (
  values: readonly string[] | null | undefined
): string[] | undefined => {
  if (!values || values.length === 0) return undefined
  const normalized: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > 120) return undefined
    for (const character of trimmed) {
      const code = character.charCodeAt(0)
      if (code < 32 || code === 127) return undefined
    }
    if (!normalized.includes(trimmed)) normalized.push(trimmed)
  }
  return normalized.length > 0 ? normalized : undefined
}

interface StoredDeviceToken {
  desktopId?: string | undefined
  deviceKind?: RelayDeviceKind | undefined
  deviceId: string
  tokenHint: string
  workspaceIds?: string[] | undefined
}

const readStoredEntries = (
  storagePath: string | undefined
): {
  deviceTokens: Map<string, StoredDeviceToken>
  issuedTokens: Map<string, number>
} => {
  const deviceTokens = new Map<string, StoredDeviceToken>()
  const issuedTokens = new Map<string, number>()
  if (!storagePath) return { deviceTokens, issuedTokens }

  try {
    const parsed = JSON.parse(readFileSync(storagePath, 'utf8')) as unknown
    if (!isRecord(parsed)) return { deviceTokens, issuedTokens }
    if (Array.isArray(parsed.issued_tokens)) {
      for (const entry of parsed.issued_tokens) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') {
          issuedTokens.set(entry[0], entry[1])
        }
      }
    }
    if (Array.isArray(parsed.device_tokens)) {
      for (const entry of parsed.device_tokens) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
          const deviceId = normalizeRelayDeviceId(entry[1])
          if (!deviceId) continue
          deviceTokens.set(hashToken(entry[0]), {
            deviceId,
            tokenHint: summarizeToken(entry[0]),
          })
          continue
        }
        if (
          isRecord(entry) &&
          typeof entry.token_hash === 'string' &&
          entry.token_hash.startsWith('sha256:') &&
          typeof entry.device_id === 'string' &&
          typeof entry.token_hint === 'string'
        ) {
          const deviceId = normalizeRelayDeviceId(entry.device_id)
          if (!deviceId) continue
          const desktopId =
            typeof entry.desktop_id === 'string'
              ? normalizeRelayDeviceId(entry.desktop_id)
              : undefined
          const deviceKind =
            typeof entry.device_kind === 'string'
              ? normalizeRelayDeviceKind(entry.device_kind)
              : undefined
          const workspaceIds = Array.isArray(entry.workspace_ids)
            ? normalizeRelayWorkspaceIds(
                entry.workspace_ids.filter((item): item is string => typeof item === 'string')
              )
            : undefined
          deviceTokens.set(entry.token_hash, {
            ...(desktopId ? { desktopId } : {}),
            ...(deviceKind ? { deviceKind } : {}),
            deviceId,
            tokenHint: entry.token_hint,
            ...(workspaceIds ? { workspaceIds } : {}),
          })
        }
      }
    }
  } catch {
    return { deviceTokens, issuedTokens }
  }

  return { deviceTokens, issuedTokens }
}

const writeStoredEntries = (
  storagePath: string | undefined,
  issuedTokens: Map<string, number>,
  deviceTokens: Map<string, StoredDeviceToken>
) => {
  if (!storagePath) return
  mkdirSync(dirname(storagePath), { recursive: true })
  const tmpPath = `${storagePath}.${process.pid}.tmp`
  writeFileSync(
    tmpPath,
    `${JSON.stringify(
      {
        device_tokens: Array.from(deviceTokens.entries())
          .map(([tokenHash, entry]) => ({
            ...(entry.desktopId ? { desktop_id: entry.desktopId } : {}),
            device_id: entry.deviceId,
            ...(entry.deviceKind ? { device_kind: entry.deviceKind } : {}),
            token_hash: tokenHash,
            token_hint: entry.tokenHint,
            ...(entry.workspaceIds ? { workspace_ids: entry.workspaceIds } : {}),
          }))
          .sort((left, right) =>
            left.device_id === right.device_id
              ? left.token_hint.localeCompare(right.token_hint)
              : left.device_id.localeCompare(right.device_id)
          ),
        issued_tokens: Array.from(issuedTokens.entries()),
        version: 2,
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
  renameSync(tmpPath, storagePath)
}

const summarizeDeviceToken = (entry: StoredDeviceToken): RelayDeviceTokenSummary => ({
  ...(entry.desktopId ? { desktop_id: entry.desktopId } : {}),
  device_id: entry.deviceId,
  ...(entry.deviceKind ? { device_kind: entry.deviceKind } : {}),
  token_hint: entry.tokenHint,
  ...(entry.workspaceIds ? { workspace_ids: entry.workspaceIds } : {}),
})

export const createDevelopmentPairingStore = (
  options: CreateDevelopmentPairingStoreOptions = {}
): PairingStore => {
  const usesDefaultAdminToken = !options.token && !process.env.HIVE_RELAY_DEV_TOKEN
  const token = options.token ?? process.env.HIVE_RELAY_DEV_TOKEN ?? DEFAULT_DEV_TOKEN
  const tokenTtlMs = options.tokenTtlMs ?? DEFAULT_PAIRING_TOKEN_TTL_MS
  const storagePath = options.storagePath
  const { deviceTokens, issuedTokens } = readStoredEntries(storagePath)

  const persist = () => writeStoredEntries(storagePath, issuedTokens, deviceTokens)

  const createDeviceToken = ({
    desktopId,
    deviceKind,
    deviceId,
    workspaceIds,
  }: {
    desktopId?: string | null | undefined
    deviceKind?: RelayDeviceKind | null | undefined
    deviceId: string
    workspaceIds?: string[] | null | undefined
  }): RelayDeviceToken | null => {
    const normalizedDeviceId = normalizeRelayDeviceId(deviceId)
    const normalizedDesktopId = desktopId ? normalizeRelayDeviceId(desktopId) : undefined
    const normalizedDeviceKind = deviceKind ? normalizeRelayDeviceKind(deviceKind) : undefined
    const normalizedWorkspaceIds = workspaceIds
      ? normalizeRelayWorkspaceIds(workspaceIds)
      : undefined
    if (
      !normalizedDeviceId ||
      (desktopId && !normalizedDesktopId) ||
      (deviceKind && !normalizedDeviceKind) ||
      (workspaceIds && !normalizedWorkspaceIds)
    )
      return null
    let deviceToken = createToken()
    while (
      issuedTokens.has(deviceToken) ||
      deviceTokens.has(hashToken(deviceToken)) ||
      deviceToken === token
    ) {
      deviceToken = createToken()
    }
    deviceTokens.set(hashToken(deviceToken), {
      ...(normalizedDesktopId ? { desktopId: normalizedDesktopId } : {}),
      ...(normalizedDeviceKind ? { deviceKind: normalizedDeviceKind } : {}),
      deviceId: normalizedDeviceId,
      tokenHint: summarizeToken(deviceToken),
      ...(normalizedWorkspaceIds ? { workspaceIds: normalizedWorkspaceIds } : {}),
    })
    persist()
    return {
      ...(normalizedDesktopId ? { desktop_id: normalizedDesktopId } : {}),
      device_id: normalizedDeviceId,
      ...(normalizedDeviceKind ? { device_kind: normalizedDeviceKind } : {}),
      token: deviceToken,
      ...(normalizedWorkspaceIds ? { workspace_ids: normalizedWorkspaceIds } : {}),
    }
  }

  const pruneExpired = (now: number) => {
    let changed = false
    for (const [issuedToken, expiresAt] of issuedTokens) {
      if (expiresAt <= now) {
        issuedTokens.delete(issuedToken)
        changed = true
      }
    }
    if (changed) persist()
  }

  return {
    claimPairingToken({ desktopId, deviceKind, deviceId, token: input, workspaceIds }) {
      if (!input) return null
      const now = Date.now()
      pruneExpired(now)
      const expiresAt = issuedTokens.get(input)
      if (expiresAt === undefined || expiresAt <= now) return null
      const normalizedDeviceId = normalizeRelayDeviceId(deviceId)
      const normalizedDesktopId = desktopId ? normalizeRelayDeviceId(desktopId) : undefined
      const normalizedDeviceKind = deviceKind ? normalizeRelayDeviceKind(deviceKind) : undefined
      const normalizedWorkspaceIds = workspaceIds
        ? normalizeRelayWorkspaceIds(workspaceIds)
        : undefined
      if (
        !normalizedDeviceId ||
        (desktopId && !normalizedDesktopId) ||
        (deviceKind && !normalizedDeviceKind) ||
        (workspaceIds && !normalizedWorkspaceIds)
      )
        return null
      issuedTokens.delete(input)
      persist()
      return createDeviceToken({
        desktopId: normalizedDesktopId,
        deviceId: normalizedDeviceId,
        deviceKind: normalizedDeviceKind,
        workspaceIds: normalizedWorkspaceIds,
      })
    },
    createDeviceToken,
    createPairingToken() {
      const now = Date.now()
      pruneExpired(now)
      let issuedToken = createToken()
      while (issuedTokens.has(issuedToken) || issuedToken === token) issuedToken = createToken()
      const expiresAt = now + tokenTtlMs
      issuedTokens.set(issuedToken, expiresAt)
      persist()
      return {
        expires_at: expiresAt,
        token: issuedToken,
        ttl_ms: tokenTtlMs,
      }
    },
    diagnostics() {
      pruneExpired(Date.now())
      return {
        admin_token_default: usesDefaultAdminToken,
        device_token_count: deviceTokens.size,
        issued_token_count: issuedTokens.size,
        persistent: Boolean(storagePath),
        ...(storagePath ? { storage_path: storagePath } : {}),
      }
    },
    getDeviceToken(input) {
      if (!input || input === token) return null
      pruneExpired(Date.now())
      const deviceToken = deviceTokens.get(hashToken(input))
      return deviceToken ? summarizeDeviceToken(deviceToken) : null
    },
    listDeviceTokens() {
      return Array.from(deviceTokens.entries())
        .map(([, entry]) => summarizeDeviceToken(entry))
        .sort((left, right) =>
          left.device_id === right.device_id
            ? left.token_hint.localeCompare(right.token_hint)
            : left.device_id.localeCompare(right.device_id)
        )
    },
    revokeDeviceTokens({ deviceId }) {
      const target = normalizeRelayDeviceId(deviceId)
      if (!target) return false
      let revoked = false
      for (const [tokenHash, entry] of deviceTokens) {
        if (entry.deviceId !== target) continue
        deviceTokens.delete(tokenHash)
        revoked = true
      }
      if (revoked) persist()
      return revoked
    },
    validateAdminToken(input) {
      return input === token
    },
    validateConnectionTokenForDevice({
      desktopId,
      deviceId,
      requireDesktopBinding = false,
      token: input,
    }) {
      if (input === token) return true
      if (!input) return false
      const normalizedDeviceId = normalizeRelayDeviceId(deviceId)
      if (!normalizedDeviceId) return false
      const normalizedDesktopId = desktopId ? normalizeRelayDeviceId(desktopId) : undefined
      if (desktopId && !normalizedDesktopId) return false
      pruneExpired(Date.now())
      const deviceToken = deviceTokens.get(hashToken(input))
      if (!deviceToken || deviceToken.deviceId !== normalizedDeviceId) return false
      if (requireDesktopBinding && !deviceToken.desktopId) return false
      return !deviceToken.desktopId || deviceToken.desktopId === normalizedDesktopId
    },
    validateToken(input) {
      if (input === token) return true
      if (!input) return false
      const now = Date.now()
      pruneExpired(now)
      const expiresAt = issuedTokens.get(input)
      return (expiresAt !== undefined && expiresAt > now) || deviceTokens.has(hashToken(input))
    },
    validateTokenForDevice({ desktopId, deviceId, requireDesktopBinding = false, token: input }) {
      if (input === token) return true
      if (!input) return false
      const normalizedDeviceId = normalizeRelayDeviceId(deviceId)
      if (!normalizedDeviceId) return false
      const normalizedDesktopId = desktopId ? normalizeRelayDeviceId(desktopId) : undefined
      if (desktopId && !normalizedDesktopId) return false
      const now = Date.now()
      pruneExpired(now)
      const expiresAt = issuedTokens.get(input)
      if (expiresAt !== undefined && expiresAt > now) return true
      const deviceToken = deviceTokens.get(hashToken(input))
      if (!deviceToken || deviceToken.deviceId !== normalizedDeviceId) return false
      if (requireDesktopBinding && !deviceToken.desktopId) return false
      return !deviceToken.desktopId || deviceToken.desktopId === normalizedDesktopId
    },
  }
}

export { DEFAULT_DEV_TOKEN }
