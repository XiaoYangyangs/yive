import type { WorkspaceSummary } from '../shared/types.js'
import type { PersistedAgentRun } from './agent-run-store.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import type { AgentTokenRegistry } from './agent-tokens.js'
import type { LiveRunRegistry } from './live-run-registry.js'

export type PersistedRunStatus = PersistedAgentRun['status']

export interface PersistAgentRunExitInput {
  agentId: string
  endedAt: number
  exitCode: number | null
  processState: Exclude<PersistedAgentRun['processState'], 'running'>
  runId: string
  status: Extract<PersistedRunStatus, 'error' | 'exited'>
  workspaceId: string
}

export type PersistAgentRunExit = (input: PersistAgentRunExitInput) => void

export interface AgentRunStarterStorePort {
  insertAgentRun: (
    runId: string,
    agentId: string,
    startedAt: number,
    pid: number | null,
    status?: PersistedRunStatus,
    exitCode?: number | null,
    endedAt?: number | null
  ) => void
  updatePersistedRun: (
    runId: string,
    status: PersistedRunStatus,
    exitCode: number | null,
    endedAt: number | null,
    processState: PersistedAgentRun['processState']
  ) => void
}

export interface AgentRunExitContext {
  agentId: string
  handledRunExits: Set<string>
  onAgentExit: (
    workspaceId: string,
    agentId: string,
    processStateOverride?: 'crashed' | 'stopped'
  ) => void
  persistRunExit?: PersistAgentRunExit
  registry: LiveRunRegistry
  sessionStore: AgentSessionStorePort
  startConfig: { resumedSessionId?: string | null }
  store: AgentRunStarterStorePort
  token: string
  tokenRegistry: AgentTokenRegistry
  workspace: WorkspaceSummary
}
