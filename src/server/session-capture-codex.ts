import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildAgentSessionBindingMarkerFromIds } from './agent-startup-instructions.js'
import { captureSessionIdWithCoordinator } from './claude-session-coordinator.js'

const CODEX_SESSION_FILE = /^rollout-.*\.jsonl$/i
const CODEX_HEADER_READ_CHUNK_BYTES = 4096
const CODEX_HEADER_MAX_BYTES = 64 * 1024
const CODEX_BINDING_PREFIX_MAX_BYTES = 256 * 1024
const CODEX_DISCOVERY_CATALOG_TTL_MS = 2000

const getDefaultCodexHome = () => process.env.CODEX_HOME ?? join(homedir(), '.codex')

const expandHome = (path: string) =>
  path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(2)) : path

export const getCodexHome = (pattern?: string) => {
  if (!pattern) return getDefaultCodexHome()
  const markerIndex = pattern.indexOf('/sessions/')
  if (markerIndex === -1) return getDefaultCodexHome()
  const rawRoot = pattern.slice(0, markerIndex)
  if (rawRoot === '~/.codex' || rawRoot === '~/.codex/') return getDefaultCodexHome()
  const root = expandHome(rawRoot)
  return root || getDefaultCodexHome()
}

const walkSessionFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return walkSessionFiles(path)
      return entry.isFile() && CODEX_SESSION_FILE.test(entry.name) ? [path] : []
    })
  } catch {
    return []
  }
}

export const readCodexSessionFirstLine = (
  filePath: string,
  maxBytes = CODEX_HEADER_MAX_BYTES
): string | null => {
  const fd = openSync(filePath, 'r')
  try {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let position = 0
    let reachedLineEnd = false

    while (totalBytes < maxBytes) {
      const bytesToRead = Math.min(CODEX_HEADER_READ_CHUNK_BYTES, maxBytes - totalBytes)
      const buffer = Buffer.allocUnsafe(bytesToRead)
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position)
      if (bytesRead === 0) {
        reachedLineEnd = true
        break
      }

      const slice = buffer.subarray(0, bytesRead)
      const newlineIndex = slice.indexOf(0x0a)
      if (newlineIndex >= 0) {
        chunks.push(slice.subarray(0, newlineIndex))
        reachedLineEnd = true
        break
      }

      chunks.push(slice)
      totalBytes += bytesRead
      position += bytesRead
    }

    if (!reachedLineEnd) return null
    return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '')
  } finally {
    closeSync(fd)
  }
}

const readCodexSessionPrefix = (filePath: string, maxBytes = CODEX_BINDING_PREFIX_MAX_BYTES) => {
  const descriptor = openSync(filePath, 'r')
  try {
    const size = Math.min(statSync(filePath).size, maxBytes)
    const buffer = Buffer.allocUnsafe(size)
    const bytesRead = readSync(descriptor, buffer, 0, size, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

const parseCodexSession = (filePath: string) => {
  const firstLine = readCodexSessionFirstLine(filePath)
  if (!firstLine) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(firstLine) as unknown
  } catch {
    // Interrupted Codex startups can leave empty or truncated rollout files behind.
    return null
  }
  if (!parsed || typeof parsed !== 'object' || !('payload' in parsed)) return null
  const payload = parsed.payload
  if (!payload || typeof payload !== 'object') return null
  const id = 'id' in payload && typeof payload.id === 'string' ? payload.id : null
  const cwd = 'cwd' in payload && typeof payload.cwd === 'string' ? payload.cwd : null
  return id && cwd ? { cwd, id } : null
}

interface CodexSessionCandidate {
  filePath: string
  id: string
  mtimeMs: number
}

interface IndexedCodexSessionCandidate extends CodexSessionCandidate {
  cwd: string
  size: number
}

export interface CodexAgentSessionCheckpoint {
  checkpoint: number
  filePath: string
  id: string
}

const EXPECTED_SESSION_FILE_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'ENOENT', 'ENOTDIR', 'EPERM'])

const isExpectedSessionFileError = (error: unknown) =>
  error !== null &&
  typeof error === 'object' &&
  'code' in error &&
  EXPECTED_SESSION_FILE_ERROR_CODES.has(String(error.code))

interface CodexDiscoveryCatalog {
  candidates: IndexedCodexSessionCandidate[]
  checkedAt: number
}

interface CachedCodexSessionPrefix {
  complete: boolean
  size: number
  value: string
}

const discoveryCatalogs = new Map<string, CodexDiscoveryCatalog>()
const discoveryMetadata = new Map<string, { cwd: string; id: string }>()
const discoveryPrefixes = new Map<string, CachedCodexSessionPrefix>()

const getDiscoveryCatalog = (
  codexHome: string,
  forceRefresh = false
): IndexedCodexSessionCandidate[] => {
  const now = Date.now()
  const cached = discoveryCatalogs.get(codexHome)
  if (!forceRefresh && cached && now - cached.checkedAt < CODEX_DISCOVERY_CATALOG_TTL_MS) {
    return cached.candidates
  }

  const paths = walkSessionFiles(join(codexHome, 'sessions'))
  const livePaths = new Set(paths)
  const candidates = paths.flatMap((filePath) => {
    try {
      const stats = statSync(filePath)
      const session =
        (forceRefresh ? undefined : discoveryMetadata.get(filePath)) ?? parseCodexSession(filePath)
      if (!session) return []
      discoveryMetadata.set(filePath, session)
      return [
        {
          cwd: session.cwd,
          filePath,
          id: session.id,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
        },
      ]
    } catch (error) {
      if (isExpectedSessionFileError(error)) return []
      throw error
    }
  })

  for (const previous of cached?.candidates ?? []) {
    if (livePaths.has(previous.filePath)) continue
    discoveryMetadata.delete(previous.filePath)
    discoveryPrefixes.delete(previous.filePath)
  }
  discoveryCatalogs.set(codexHome, { candidates, checkedAt: now })
  return candidates
}

const readIndexedSessionPrefix = (
  candidate: IndexedCodexSessionCandidate,
  forceRefresh = false
) => {
  const cached = discoveryPrefixes.get(candidate.filePath)
  if (
    !forceRefresh &&
    cached &&
    (cached.size === candidate.size ||
      (cached.complete && candidate.size >= CODEX_BINDING_PREFIX_MAX_BYTES))
  ) {
    return cached.value
  }

  const value = readCodexSessionPrefix(candidate.filePath)
  discoveryPrefixes.set(candidate.filePath, {
    complete: candidate.size >= CODEX_BINDING_PREFIX_MAX_BYTES,
    size: candidate.size,
    value,
  })
  return value
}

const listIndexedSessionCandidates = (
  cwd: string,
  codexHome: string,
  discriminator: { contentIncludes: string | readonly string[] },
  forceRefresh = false
): IndexedCodexSessionCandidate[] => {
  const needles = Array.isArray(discriminator.contentIncludes)
    ? discriminator.contentIncludes
    : [discriminator.contentIncludes]
  return getDiscoveryCatalog(codexHome, forceRefresh)
    .filter((candidate) => candidate.cwd === cwd)
    .filter((candidate) => {
      const prefix = readIndexedSessionPrefix(candidate, forceRefresh)
      return needles.some((needle) => prefix.includes(needle))
    })
}

const listSessionCandidates = (
  cwd: string,
  codexHome = getDefaultCodexHome(),
  discriminator?: { contentIncludes?: string | readonly string[] }
): CodexSessionCandidate[] => {
  const sessionsRoot = join(codexHome, 'sessions')
  return walkSessionFiles(sessionsRoot)
    .flatMap((filePath) => {
      try {
        const session = parseCodexSession(filePath)
        if (session?.cwd !== cwd) return []
        if (discriminator?.contentIncludes) {
          const needles = Array.isArray(discriminator.contentIncludes)
            ? discriminator.contentIncludes
            : [discriminator.contentIncludes]
          const prefix = readCodexSessionPrefix(filePath)
          if (!needles.some((needle) => prefix.includes(needle))) return []
        }
        return [{ filePath, id: session.id, mtimeMs: statSync(filePath).mtimeMs }]
      } catch {
        return []
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id))
}

const listSessionIds = (cwd: string, codexHome = getDefaultCodexHome()) =>
  listSessionCandidates(cwd, codexHome).map((session) => session.id)

export const listCodexSessionIdsByRecency = (
  cwd: string,
  codexHome = getDefaultCodexHome(),
  discriminator?: { contentIncludes?: string | readonly string[] }
) =>
  listSessionCandidates(cwd, codexHome, discriminator)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.id.localeCompare(left.id))
    .map((session) => session.id)

export const findCodexSessionFile = (
  cwd: string,
  sessionId: string,
  codexHome = getDefaultCodexHome()
) => listSessionCandidates(cwd, codexHome).find((session) => session.id === sessionId)?.filePath

export const findLatestCodexSessionForAgent = (
  cwd: string,
  workspaceId: string,
  agentId: string,
  codexHome = getDefaultCodexHome()
) =>
  listIndexedSessionCandidates(cwd, codexHome, {
    contentIncludes: buildAgentSessionBindingMarkerFromIds(workspaceId, agentId),
  }).sort((left, right) => right.mtimeMs - left.mtimeMs || right.id.localeCompare(left.id))[0]

export const snapshotCodexAgentSessionCheckpoints = (
  cwd: string,
  workspaceId: string,
  agentId: string,
  codexHome = getDefaultCodexHome()
): CodexAgentSessionCheckpoint[] =>
  snapshotCodexSessionCheckpoints(cwd, codexHome, {
    contentIncludes: buildAgentSessionBindingMarkerFromIds(workspaceId, agentId),
  })

export const snapshotCodexSessionCheckpoints = (
  cwd: string,
  codexHome = getDefaultCodexHome(),
  discriminator?: { contentIncludes: string | readonly string[] },
  forceRefresh = false
): CodexAgentSessionCheckpoint[] =>
  (discriminator
    ? listIndexedSessionCandidates(cwd, codexHome, discriminator, forceRefresh)
    : listSessionCandidates(cwd, codexHome)
  ).flatMap(({ filePath, id }) => {
    try {
      return [{ checkpoint: statSync(filePath).size, filePath, id }]
    } catch (error) {
      if (isExpectedSessionFileError(error)) return []
      throw error
    }
  })

export const hasCodexSession = (cwd: string, sessionId: string, pattern?: string) =>
  listSessionIds(cwd, getCodexHome(pattern)).includes(sessionId)

export const snapshotCodexSessionIds = (cwd: string, codexHome = getDefaultCodexHome()) =>
  new Set(listSessionIds(cwd, codexHome))

export const captureCodexSessionId = async (
  cwd: string,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100,
  codexHome = getDefaultCodexHome(),
  discriminator?: { contentIncludes: string | readonly string[] }
) => {
  await captureSessionIdWithCoordinator({
    intervalMs,
    knownSessionIds,
    listSessionIds: () =>
      listSessionCandidates(cwd, codexHome, discriminator).map((session) => session.id),
    onCapture,
    projectKey: join(codexHome, 'sessions', cwd),
    timeoutMs,
  })
}

export const codexSessionStoreExists = (codexHome = getDefaultCodexHome()) =>
  existsSync(join(codexHome, 'sessions'))
