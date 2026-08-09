import type { AgentStopMode, ArtifactReference, WorkspaceSummary } from '../shared/types.js'

export type { AgentStopMode } from '../shared/types.js'

import type { PersistedAgentRun } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { AgentSessionDurabilityReason } from './agent-session-durability.js'
import type { AgentSessionRebindResult } from './agent-session-rebind.js'
import type { AgentTokenRegistry } from './agent-tokens.js'
import type { PtyOutputBus } from './pty-output-bus.js'

interface StartAgentOptions {
  hivePort: string
  suppressStartupInstructions?: boolean
}

export interface DispatchNotePromptItem {
  actorId: string
  actorType: 'agent' | 'user'
  artifacts: ArtifactReference[]
  noteId: string
  text: string
}

export interface DispatchNotePromptInput {
  dispatchId: string
  notes: DispatchNotePromptItem[]
}

export interface AgentStopResult {
  mode: AgentStopMode
  reason:
    | AgentSessionDurabilityReason
    | 'checkpoint_failed'
    | 'provider_unsupported'
    | 'pty_unavailable'
    | 'session_changed'
    | 'session_unverified'
    | 'timeout'
    | null
  runId: string
  sessionId: string | null
  state: 'checkpoint_required' | 'failed' | 'stopped'
}

export interface AgentRuntime {
  close: () => Promise<void>
  configureAgentLaunch: (
    workspaceId: string,
    agentId: string,
    input: import('./agent-run-store.js').AgentLaunchConfigInput
  ) => void
  deleteAgentLaunchConfig: (workspaceId: string, agentId: string) => void
  getActiveRunByAgentId: (workspaceId: string, agentId: string) => LiveAgentRun | undefined
  interruptCurrentTurn: (workspaceId: string, agentId: string) => boolean
  peekAgentLaunchConfig: (
    workspaceId: string,
    agentId: string
  ) => import('./agent-run-store.js').AgentLaunchConfigInput | undefined
  getLiveRun: (runId: string) => LiveAgentRun
  getPtyOutputBus: () => PtyOutputBus
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  pauseRun: (runId: string) => void
  peekAgentToken: (agentId: string) => string | undefined
  resizeAgentRun: (runId: string, cols: number, rows: number) => void
  refreshAgentSessionBinding: (
    workspace: WorkspaceSummary,
    agentId: string
  ) => AgentSessionRebindResult
  resumeRun: (runId: string) => void
  startAgent: (
    workspace: WorkspaceSummary,
    agentId: string,
    input: StartAgentOptions
  ) => Promise<LiveAgentRun>
  stopAgentRun: (runId: string) => void
  stopAgentRunSafely: (
    workspace: WorkspaceSummary,
    agentId: string,
    runId: string,
    input: { mode: AgentStopMode }
  ) => Promise<AgentStopResult>
  validateAgentToken: AgentTokenRegistry['validate']
  writeChatSubmission: (
    workspaceId: string,
    agentId: string,
    prepareText: () => string | null
  ) => Promise<string | null>
  writeCoordinationPrompt: (
    workspaceId: string,
    prepareText: () => string | null,
    callbacks: {
      beforeWrite: () => void
      onWriteFailed: () => void
    }
  ) => Promise<boolean>
  writeReportPrompt: (
    workspaceId: string,
    workerName: string,
    workerId: string,
    text: string,
    artifacts: ArtifactReference[],
    input?: { requireActiveRun?: boolean }
  ) => void
  writeStatusPrompt: (
    workspaceId: string,
    workerName: string,
    workerId: string,
    text: string,
    artifacts: ArtifactReference[],
    input?: { requireActiveRun?: boolean }
  ) => void
  writeSendPrompt: (
    workspaceId: string,
    workerId: string,
    dispatchId: string,
    fromAgentName: string,
    text: string,
    artifacts?: ArtifactReference[],
    canDeliver?: () => boolean,
    notes?: DispatchNotePromptItem[] | (() => DispatchNotePromptItem[])
  ) => Promise<boolean>
  writeDispatchNotePrompt: (
    workspaceId: string,
    workerId: string,
    input: DispatchNotePromptInput,
    canDeliver?: () => boolean
  ) => Promise<boolean>
  writeCancelPrompt: (
    workspaceId: string,
    workerId: string,
    dispatchId: string,
    reason: string,
    input?: { requireActiveRun?: boolean }
  ) => void
  writeContextPrompt: (workspaceId: string, agentId: string, text: string) => void
  writeUserInputPrompt: (workspaceId: string, text: string) => void
}

export type { StartAgentOptions }
