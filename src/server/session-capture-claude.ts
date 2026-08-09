import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildAgentSessionBindingMarkerFromIds } from './agent-startup-instructions.js'
import {
  captureSessionIdWithCoordinator,
  resetSessionCaptureCoordinatorForTests,
} from './claude-session-coordinator.js'

const SESSION_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i
const CLAUDE_SESSION_PREFIX_MAX_BYTES = 256 * 1024
const EXPECTED_SESSION_FILE_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'ENOENT', 'ENOTDIR', 'EPERM'])

const isExpectedSessionFileError = (error: unknown) => {
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN'
  return EXPECTED_SESSION_FILE_ERROR_CODES.has(code)
}

const getDefaultProjectsRoot = () =>
  process.env.HIVE_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude/projects')

export const getClaudeProjectsRoot = (pattern?: string) => {
  if (!pattern) return getDefaultProjectsRoot()
  const markerIndex = pattern.indexOf('{encoded_cwd}')
  if (markerIndex === -1) return getDefaultProjectsRoot()
  const root = pattern.slice(0, markerIndex).replace(/[\\/]+$/, '')
  if (!root) return getDefaultProjectsRoot()
  if (root === '~' || root.startsWith('~/')) {
    return process.env.HIVE_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects')
  }
  return root
}

export const encodeClaudeProjectPath = (cwd: string) => cwd.replace(/[\\/:\s]/g, '-')

interface ClaudeSessionCandidate {
  filePath: string
  id: string
  mtimeMs: number
}

export interface ClaudeSessionCheckpoint {
  checkpoint: number
  filePath: string
  id: string
}

const listSessionCandidates = (
  cwd: string,
  projectsRoot = getDefaultProjectsRoot(),
  discriminator: ClaudeSessionCaptureDiscriminator = {}
): ClaudeSessionCandidate[] => {
  const projectDir = join(projectsRoot, encodeClaudeProjectPath(cwd))
  try {
    return readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SESSION_FILE.test(entry.name))
      .flatMap((entry) => {
        const id = entry.name.replace(/\.jsonl$/i, '')
        if (
          discriminator.contentIncludes &&
          !sessionFileContainsAny(cwd, projectsRoot, id, discriminator.contentIncludes)
        ) {
          return []
        }
        const filePath = join(projectDir, entry.name)
        return [{ filePath, id, mtimeMs: statSync(filePath).mtimeMs }]
      })
      .sort((left, right) => left.id.localeCompare(right.id))
  } catch (error) {
    if (!isExpectedSessionFileError(error)) throw error
    return []
  }
}

const listSessionIds = (cwd: string, projectsRoot = getDefaultProjectsRoot()) =>
  listSessionCandidates(cwd, projectsRoot).map((session) => session.id)

interface ClaudeSessionCaptureDiscriminator {
  contentIncludes?: string | readonly string[]
}

const includesAny = (content: string, needles: string | readonly string[]) => {
  const normalizedNeedles = Array.isArray(needles) ? needles : [needles]
  return normalizedNeedles.some((needle) => content.includes(needle))
}

const sessionFileContainsAny = (
  cwd: string,
  projectsRoot: string,
  sessionId: string,
  contentIncludes: string | readonly string[]
) => {
  const filePath = join(projectsRoot, encodeClaudeProjectPath(cwd), `${sessionId}.jsonl`)
  let descriptor: number | null = null
  try {
    descriptor = openSync(filePath, 'r')
    const size = Math.min(statSync(filePath).size, CLAUDE_SESSION_PREFIX_MAX_BYTES)
    const buffer = Buffer.allocUnsafe(size)
    const bytesRead = readSync(descriptor, buffer, 0, size, 0)
    return includesAny(buffer.subarray(0, bytesRead).toString('utf8'), contentIncludes)
  } catch (error) {
    if (!isExpectedSessionFileError(error)) throw error
    return false
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

export const getClaudeSessionFilePath = (cwd: string, sessionId: string, pattern?: string) =>
  join(getClaudeProjectsRoot(pattern), encodeClaudeProjectPath(cwd), `${sessionId}.jsonl`)

export const hasClaudeSessionFile = (
  cwd: string,
  sessionId: string,
  pattern?: string,
  discriminator: ClaudeSessionCaptureDiscriminator = {}
) => {
  if (
    !SESSION_FILE.test(`${sessionId}.jsonl`) ||
    !existsSync(getClaudeSessionFilePath(cwd, sessionId, pattern))
  ) {
    return false
  }
  const projectsRoot = getClaudeProjectsRoot(pattern)
  return discriminator.contentIncludes
    ? sessionFileContainsAny(cwd, projectsRoot, sessionId, discriminator.contentIncludes)
    : true
}

export const captureClaudeSessionId = async (
  cwd: string,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100,
  projectsRoot = getDefaultProjectsRoot(),
  discriminator: ClaudeSessionCaptureDiscriminator = {}
) => {
  const contentIncludes = discriminator.contentIncludes
  await captureSessionIdWithCoordinator({
    intervalMs,
    knownSessionIds,
    listSessionIds: () => listSessionIds(cwd, projectsRoot),
    onCapture,
    projectKey: join(projectsRoot, encodeClaudeProjectPath(cwd)),
    timeoutMs,
    ...(contentIncludes
      ? {
          matchesSessionId: (sessionId: string) =>
            sessionFileContainsAny(cwd, projectsRoot, sessionId, contentIncludes),
        }
      : {}),
  })
}

export const snapshotClaudeSessionIds = (cwd: string, projectsRoot = getDefaultProjectsRoot()) =>
  new Set(listSessionIds(cwd, projectsRoot))

export const snapshotClaudeSessionCheckpoints = (
  cwd: string,
  projectsRoot = getDefaultProjectsRoot(),
  discriminator: ClaudeSessionCaptureDiscriminator = {}
): ClaudeSessionCheckpoint[] =>
  listSessionCandidates(cwd, projectsRoot, discriminator).flatMap(({ filePath, id }) => {
    try {
      return [{ checkpoint: statSync(filePath).size, filePath, id }]
    } catch (error) {
      if (!isExpectedSessionFileError(error)) throw error
      return []
    }
  })

export const listClaudeSessionIdsByRecency = (
  cwd: string,
  projectsRoot = getDefaultProjectsRoot(),
  discriminator: ClaudeSessionCaptureDiscriminator = {}
) =>
  listSessionCandidates(cwd, projectsRoot, discriminator)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.id.localeCompare(left.id))
    .map((session) => session.id)

export const findLatestClaudeSessionForAgent = (
  cwd: string,
  workspaceId: string,
  agentId: string,
  projectsRoot = getDefaultProjectsRoot()
) =>
  listSessionCandidates(cwd, projectsRoot, {
    contentIncludes: buildAgentSessionBindingMarkerFromIds(workspaceId, agentId),
  }).sort((left, right) => right.mtimeMs - left.mtimeMs || right.id.localeCompare(left.id))[0]

export const resetClaudeSessionClaimsForTests = () => {
  resetSessionCaptureCoordinatorForTests()
}
