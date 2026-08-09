import { readClaudeConversationIncrement } from './claude-conversation-provider.js'
import { readCodexConversationIncrement } from './codex-conversation-provider.js'
import {
  captureClaudeSessionId,
  getClaudeProjectsRoot,
  hasClaudeSessionFile,
  listClaudeSessionIdsByRecency,
  snapshotClaudeSessionCheckpoints,
  snapshotClaudeSessionIds,
} from './session-capture-claude.js'
import {
  captureCodexSessionId,
  getCodexHome,
  hasCodexSession,
  listCodexSessionIdsByRecency,
  snapshotCodexSessionCheckpoints,
  snapshotCodexSessionIds,
} from './session-capture-codex.js'
export type SessionIdCaptureConfig =
  | { source: 'claude_project_jsonl_dir'; pattern: string }
  | { source: 'codex_session_jsonl_dir'; pattern: string }

export interface SessionCaptureSnapshot {
  checkpoints: Map<string, number>
  competingCheckpoints?: Map<string, number>
  discriminator?: { contentIncludes: string | readonly string[] }
  expectedSessionId?: string
  knownSessionIds: Set<string>
  env?: Record<string, string>
  root?: string
}

const hasSource = (value: unknown): value is { source: string } =>
  Boolean(value && typeof value === 'object' && 'source' in value)

export const parseSessionIdCapture = (value: unknown): SessionIdCaptureConfig | null => {
  if (!hasSource(value)) return null
  const pattern =
    'pattern' in value && (typeof value.pattern === 'string' || value.pattern === undefined)
      ? value.pattern
      : undefined
  if (value.source === 'claude_project_jsonl_dir' || value.source === 'codex_session_jsonl_dir') {
    return typeof pattern === 'string' ? { pattern, source: value.source } : null
  }
  return null
}

export const snapshotSessionIdsForCapture = (
  cwd: string,
  capture: SessionIdCaptureConfig | null | undefined,
  discriminator?: SessionCaptureSnapshot['discriminator']
): SessionCaptureSnapshot | undefined => {
  if (!capture) return undefined
  if (capture.source === 'claude_project_jsonl_dir') {
    const projectsRoot = getClaudeProjectsRoot(capture.pattern)
    return {
      env: { HIVE_CLAUDE_PROJECTS_DIR: projectsRoot },
      checkpoints: new Map(
        snapshotClaudeSessionCheckpoints(cwd, projectsRoot, discriminator).map((candidate) => [
          candidate.id,
          candidate.checkpoint,
        ])
      ),
      knownSessionIds: snapshotClaudeSessionIds(cwd, projectsRoot),
      root: projectsRoot,
      ...(discriminator ? { discriminator } : {}),
    }
  }
  if (capture.source === 'codex_session_jsonl_dir') {
    const codexHome = getCodexHome(capture.pattern)
    const checkpoints = snapshotCodexSessionCheckpoints(cwd, codexHome, discriminator, true)
    const competingCheckpoints = discriminator
      ? snapshotCodexSessionCheckpoints(cwd, codexHome, undefined, true)
      : checkpoints
    return {
      env: { CODEX_HOME: codexHome },
      checkpoints: new Map(checkpoints.map((candidate) => [candidate.id, candidate.checkpoint])),
      competingCheckpoints: new Map(
        competingCheckpoints.map((candidate) => [candidate.id, candidate.checkpoint])
      ),
      knownSessionIds: snapshotCodexSessionIds(cwd, codexHome),
      root: codexHome,
      ...(discriminator ? { discriminator } : {}),
    }
  }
  return undefined
}

export type SessionVerificationResult =
  | { sessionId: string; state: 'verified' }
  | { state: 'ambiguous' | 'waiting' }

interface SessionVerificationCandidate {
  checkpoint: number
  filePath: string
  id: string
}

const hasProviderNativeIncrement = (
  capture: SessionIdCaptureConfig,
  candidate: SessionVerificationCandidate,
  baselineCheckpoint: number
) => {
  const increment =
    capture.source === 'codex_session_jsonl_dir'
      ? readCodexConversationIncrement({
          checkpoint: baselineCheckpoint,
          filePath: candidate.filePath,
        })
      : capture.source === 'claude_project_jsonl_dir'
        ? readClaudeConversationIncrement({
            checkpoint: baselineCheckpoint,
            filePath: candidate.filePath,
          })
        : null
  return Boolean(
    increment &&
      (increment.activity_state !== null ||
        increment.turns.length > 0 ||
        increment.tool_activity.length > 0)
  )
}

const listSessionVerificationCandidates = (
  cwd: string,
  capture: SessionIdCaptureConfig,
  snapshot: SessionCaptureSnapshot
): SessionVerificationCandidate[] => {
  const candidates =
    capture.source === 'codex_session_jsonl_dir'
      ? snapshotCodexSessionCheckpoints(cwd, snapshot.root, snapshot.discriminator)
      : capture.source === 'claude_project_jsonl_dir'
        ? snapshotClaudeSessionCheckpoints(cwd, snapshot.root, snapshot.discriminator)
        : []
  return snapshot.expectedSessionId
    ? candidates.filter((candidate) => candidate.id === snapshot.expectedSessionId)
    : candidates
}

const inspectSessionVerificationCandidates = (
  candidates: readonly SessionVerificationCandidate[],
  snapshot: SessionCaptureSnapshot,
  capture: SessionIdCaptureConfig
): SessionVerificationResult => {
  const advanced = candidates.filter((candidate) => {
    const baselineCheckpoint = snapshot.checkpoints.get(candidate.id) ?? 0
    return (
      candidate.checkpoint > baselineCheckpoint &&
      hasProviderNativeIncrement(capture, candidate, baselineCheckpoint)
    )
  })
  if (advanced.length === 0) return { state: 'waiting' }
  if (advanced.length > 1) return { state: 'ambiguous' }
  const verified = advanced[0]
  return verified ? { sessionId: verified.id, state: 'verified' } : { state: 'waiting' }
}

export const inspectSessionVerification = (
  cwd: string,
  capture: SessionIdCaptureConfig,
  snapshot: SessionCaptureSnapshot
): SessionVerificationResult =>
  inspectSessionVerificationCandidates(
    listSessionVerificationCandidates(cwd, capture, snapshot),
    snapshot,
    capture
  )

export const resolvePromptReadyResumeVerification = (
  cwd: string,
  capture: SessionIdCaptureConfig,
  snapshot: SessionCaptureSnapshot
): { sessionId: string; state: 'verified' } | { state: 'rejected' } => {
  const expectedSessionId = snapshot.expectedSessionId
  if (!expectedSessionId || !snapshot.checkpoints.has(expectedSessionId)) {
    return { state: 'rejected' }
  }
  const {
    discriminator: _discriminator,
    expectedSessionId: _expectedSessionId,
    ...snapshotWithoutRestrictions
  } = snapshot
  const unrestrictedSnapshot: SessionCaptureSnapshot = {
    ...snapshotWithoutRestrictions,
    checkpoints: snapshot.competingCheckpoints ?? snapshot.checkpoints,
  }
  const candidates =
    capture.source === 'codex_session_jsonl_dir'
      ? snapshotCodexSessionCheckpoints(cwd, snapshot.root, undefined, true)
      : listSessionVerificationCandidates(cwd, capture, unrestrictedSnapshot)
  const expectedCandidates =
    capture.source === 'codex_session_jsonl_dir'
      ? snapshotCodexSessionCheckpoints(cwd, snapshot.root, snapshot.discriminator, true).filter(
          (candidate) => candidate.id === expectedSessionId
        )
      : listSessionVerificationCandidates(cwd, capture, snapshot)
  const expected = expectedCandidates[0]
  const expectedCheckpoint = snapshot.checkpoints.get(expectedSessionId) ?? 0
  if (!expected || expected.checkpoint < expectedCheckpoint) {
    return { state: 'rejected' }
  }
  const competingCheckpoints = snapshot.competingCheckpoints ?? snapshot.checkpoints
  const hasCompetingChange = candidates.some(
    (candidate) =>
      candidate.id !== expectedSessionId &&
      candidate.checkpoint > (competingCheckpoints.get(candidate.id) ?? 0)
  )
  if (hasCompetingChange) return { state: 'rejected' }
  return { sessionId: expectedSessionId, state: 'verified' }
}

const waitForVerificationPoll = (intervalMs: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, intervalMs)
    timer.unref?.()
  })

export const watchSessionVerification = async ({
  capture,
  cwd,
  isActive,
  onAmbiguous,
  onVerified,
  pollIntervalMs = 100,
  snapshot,
}: {
  capture: SessionIdCaptureConfig
  cwd: string
  isActive: () => boolean
  onAmbiguous: () => void
  onVerified: (sessionId: string) => void
  pollIntervalMs?: number
  snapshot: SessionCaptureSnapshot
}) => {
  const rollingSnapshot: SessionCaptureSnapshot = {
    ...snapshot,
    checkpoints: new Map(snapshot.checkpoints),
  }
  while (isActive()) {
    const candidates = listSessionVerificationCandidates(cwd, capture, rollingSnapshot)
    const result = inspectSessionVerificationCandidates(candidates, rollingSnapshot, capture)
    if (result.state !== 'waiting') {
      for (const candidate of candidates) {
        rollingSnapshot.checkpoints.set(candidate.id, candidate.checkpoint)
      }
      if (result.state === 'verified') onVerified(result.sessionId)
      else onAmbiguous()
      delete rollingSnapshot.expectedSessionId
    }
    await waitForVerificationPoll(pollIntervalMs)
  }
}

export const getSessionCaptureEnvironment = (
  snapshot: SessionCaptureSnapshot | undefined
): Record<string, string> => snapshot?.env ?? {}

export const captureSessionIdForCapture = async (
  cwd: string,
  capture: SessionIdCaptureConfig,
  snapshot: SessionCaptureSnapshot,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100
) => {
  if (capture.source === 'claude_project_jsonl_dir') {
    await captureClaudeSessionId(
      cwd,
      snapshot.knownSessionIds,
      onCapture,
      timeoutMs,
      intervalMs,
      snapshot.root,
      snapshot.discriminator
    )
  }
  if (capture.source === 'codex_session_jsonl_dir') {
    await captureCodexSessionId(
      cwd,
      snapshot.knownSessionIds,
      onCapture,
      timeoutMs,
      intervalMs,
      snapshot.root,
      snapshot.discriminator
    )
  }
}

export const doesCapturedSessionExist = (
  cwd: string,
  capture: SessionIdCaptureConfig,
  sessionId: string,
  discriminator?: SessionCaptureSnapshot['discriminator']
) => {
  if (capture.source === 'claude_project_jsonl_dir') {
    return hasClaudeSessionFile(cwd, sessionId, capture.pattern, discriminator)
  }
  if (capture.source === 'codex_session_jsonl_dir') {
    return hasCodexSession(cwd, sessionId, capture.pattern)
  }
  return false
}

export const listCapturedSessionIdsByRecency = (
  cwd: string,
  capture: SessionIdCaptureConfig,
  discriminator?: SessionCaptureSnapshot['discriminator']
) => {
  if (capture.source === 'claude_project_jsonl_dir') {
    return listClaudeSessionIdsByRecency(cwd, getClaudeProjectsRoot(capture.pattern), discriminator)
  }
  if (capture.source === 'codex_session_jsonl_dir') {
    const codexHome = getCodexHome(capture.pattern)
    const labeled = discriminator ? listCodexSessionIdsByRecency(cwd, codexHome, discriminator) : []
    return labeled.length > 0 ? labeled : listCodexSessionIdsByRecency(cwd, codexHome)
  }
  return []
}
