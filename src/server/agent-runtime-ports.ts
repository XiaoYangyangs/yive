import type { AgentLaunchConfigInput, PersistedAgentRun } from './agent-run-store.js'
import type { AgentSessionBinding, AgentSessionStore } from './agent-session-store.js'

type PersistedRunStatus = PersistedAgentRun['status']

export interface AgentRunStorePort {
  close?: () => void
  insertAgentRun: (
    runId: string,
    agentId: string,
    startedAt: number,
    pid: number | null,
    status?: PersistedRunStatus,
    exitCode?: number | null,
    endedAt?: number | null
  ) => void
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  listLaunchConfigs: () => Array<{
    agentId: string
    config: AgentLaunchConfigInput
    workspaceId: string
  }>
  markUnfinishedRunsStale: (endedAt?: number) => void
  deleteLaunchConfig: (workspaceId: string, agentId: string) => void
  saveLaunchConfig: (workspaceId: string, agentId: string, input: AgentLaunchConfigInput) => void
  updatePersistedRun: (
    runId: string,
    status: PersistedRunStatus,
    exitCode: number | null,
    endedAt: number | null,
    processState: PersistedAgentRun['processState']
  ) => void
}

export interface AgentSessionStorePort {
  beginSaveIntent: AgentSessionStore['beginSaveIntent']
  clearLastSessionId: (workspaceId: string, agentId: string) => void
  clearLastSessionIdIfMatches: (
    workspaceId: string,
    agentId: string,
    expectedSessionId: string
  ) => boolean
  getLastSessionId: (workspaceId: string, agentId: string) => string | undefined
  getSessionBinding: (workspaceId: string, agentId: string) => AgentSessionBinding | undefined
  getSaveIntent: AgentSessionStore['getSaveIntent']
  completeSaveIntent: AgentSessionStore['completeSaveIntent']
  failPendingSaveIntent: AgentSessionStore['failPendingSaveIntent']
  saveLastSessionId: AgentSessionStore['saveLastSessionId']
  setLastSessionId: AgentSessionStore['setLastSessionId']
}
