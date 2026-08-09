import { existsSync, statSync } from 'node:fs'

import type { ConversationProvider } from '../shared/types.js'
import { normalizeVerifiedConversationText } from './conversation-content.js'
import { getProviderAdapter, getProviderAdapterForCapture } from './provider-adapter.js'
import type { SessionIdCaptureConfig } from './session-capture.js'

export type AgentSessionDurabilityReason =
  | 'provider_busy'
  | 'provider_state_unknown'
  | 'source_unavailable'
  | 'uncommitted_input'

export interface AgentSessionDurability {
  checkpoint: number
  filePath: string | null
  provider: ConversationProvider
  reason: AgentSessionDurabilityReason | null
  sessionId: string
  state: 'checkpoint_required' | 'durable'
}

export interface AgentSessionDurabilityCandidate {
  checkpoint: number
  filePath: string
  id: string
}

export class AgentSessionDurabilityTimeoutError extends Error {
  readonly code = 'AGENT_SESSION_DURABILITY_TIMEOUT'
}

const resolveProvider = (capture: SessionIdCaptureConfig): ConversationProvider | null =>
  getProviderAdapterForCapture(capture)?.id ?? null

export const inspectAgentSessionDurability = ({
  capture,
  lastInputAt,
  sessionId,
  workspacePath,
}: {
  capture: SessionIdCaptureConfig
  lastInputAt: number | null
  sessionId: string
  workspacePath: string
}): AgentSessionDurability | null => {
  const adapter = getProviderAdapterForCapture(capture)
  if (!adapter) return null
  const provider = adapter.id
  const filePath = adapter.findSessionSource(workspacePath, sessionId, capture.pattern)
  if (!filePath || !existsSync(filePath)) {
    return {
      checkpoint: 0,
      filePath: null,
      provider,
      reason: 'source_unavailable',
      sessionId,
      state: 'checkpoint_required',
    }
  }

  const increment = adapter.readConversationIncrement({ checkpoint: null, filePath })
  const checkpoint = increment.checkpoint
  if (increment.activity_state === 'busy') {
    return {
      checkpoint,
      filePath,
      provider,
      reason: 'provider_busy',
      sessionId,
      state: 'checkpoint_required',
    }
  }
  if (increment.activity_state !== 'idle') {
    return {
      checkpoint,
      filePath,
      provider,
      reason: 'provider_state_unknown',
      sessionId,
      state: 'checkpoint_required',
    }
  }
  if (lastInputAt !== null && statSync(filePath).mtimeMs < lastInputAt) {
    return {
      checkpoint,
      filePath,
      provider,
      reason: 'uncommitted_input',
      sessionId,
      state: 'checkpoint_required',
    }
  }
  return { checkpoint, filePath, provider, reason: null, sessionId, state: 'durable' }
}

export const snapshotAgentSessionDurabilityCandidates = ({
  capture,
  workspacePath,
}: {
  agentId: string
  capture: SessionIdCaptureConfig
  workspaceId: string
  workspacePath: string
}): AgentSessionDurabilityCandidate[] => {
  return (
    getProviderAdapterForCapture(capture)?.snapshotSessionCheckpoints(
      workspacePath,
      capture.pattern
    ) ?? []
  )
}

const readRequiredCheckpoint = ({
  baselineCheckpoint,
  filePath,
  normalizedRequiredUserText,
  provider,
  sessionId,
}: {
  baselineCheckpoint: number
  filePath: string
  normalizedRequiredUserText: string
  provider: ConversationProvider
  sessionId: string
}): AgentSessionDurability | null => {
  const adapter = getProviderAdapter(provider)
  if (!adapter) return null
  const increment = adapter.readConversationIncrement({ checkpoint: baselineCheckpoint, filePath })
  const requiredTurnRecorded = increment.turns.some(
    (turn) => turn.role === 'user' && turn.text === normalizedRequiredUserText
  )
  if (!requiredTurnRecorded || increment.activity_state !== 'idle') return null
  return {
    checkpoint: increment.checkpoint,
    filePath,
    provider,
    reason: null,
    sessionId,
    state: 'durable',
  }
}

export const waitForAgentSessionDurable = async ({
  agentId,
  baselineCheckpoint,
  candidateCheckpoints = [],
  capture,
  lastInputAt,
  pollIntervalMs = 100,
  requiredUserText,
  sessionId,
  timeoutMs = 60_000,
  workspaceId,
  workspacePath,
}: {
  agentId?: string
  baselineCheckpoint: number
  candidateCheckpoints?: readonly AgentSessionDurabilityCandidate[]
  capture: SessionIdCaptureConfig
  lastInputAt: number | null
  pollIntervalMs?: number
  requiredUserText?: string
  sessionId: string
  timeoutMs?: number
  workspaceId?: string
  workspacePath: string
}): Promise<AgentSessionDurability> => {
  const deadline = Date.now() + timeoutMs
  let latest: AgentSessionDurability | null = null
  const normalizedRequiredUserText = requiredUserText
    ? normalizeVerifiedConversationText(requiredUserText)
    : null
  const candidateBaselines = new Map(
    candidateCheckpoints.map((candidate) => [candidate.id, candidate.checkpoint])
  )
  while (Date.now() <= deadline) {
    latest = inspectAgentSessionDurability({
      capture,
      lastInputAt,
      sessionId,
      workspacePath,
    })
    if (latest && latest.checkpoint > baselineCheckpoint) {
      if (!normalizedRequiredUserText && latest.state === 'durable') return latest
      if (normalizedRequiredUserText && latest.filePath) {
        const requiredCheckpoint = readRequiredCheckpoint({
          baselineCheckpoint,
          filePath: latest.filePath,
          normalizedRequiredUserText,
          provider: latest.provider,
          sessionId,
        })
        if (requiredCheckpoint) return requiredCheckpoint
      }
    }
    if (normalizedRequiredUserText && candidateCheckpoints.length > 0 && agentId && workspaceId) {
      const provider = resolveProvider(capture)
      if (provider) {
        const candidates = snapshotAgentSessionDurabilityCandidates({
          agentId,
          capture,
          workspaceId,
          workspacePath,
        })
        for (const candidate of candidates) {
          if (candidate.id === sessionId) continue
          const candidateBaseline = candidateBaselines.get(candidate.id) ?? 0
          if (candidate.checkpoint <= candidateBaseline) continue
          const requiredCheckpoint = readRequiredCheckpoint({
            baselineCheckpoint: candidateBaseline,
            filePath: candidate.filePath,
            normalizedRequiredUserText,
            provider,
            sessionId: candidate.id,
          })
          if (requiredCheckpoint) return requiredCheckpoint
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  throw new AgentSessionDurabilityTimeoutError(
    `Timed out waiting for CLI session checkpoint${latest?.reason ? `: ${latest.reason}` : ''}`
  )
}
