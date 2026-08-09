import type { AgentIdentity } from '../shared/types.js'

export interface MessageKindRecord {
  type: 'send' | 'report'
  worker_id: string
  workspace_id: string
}

export interface WorkspaceRow {
  id: string
  name: string
  orchestrator_name: string
  path: string
}

export interface WorkerRow {
  id: string
  workspace_id: string
  name: string
}

export interface WorkspaceSummaryRow extends WorkspaceRow {}

export const getOrchestratorId = (workspaceId: string) => `${workspaceId}:orchestrator`

export const createOrchestrator = (workspaceId: string, name = 'Orchestrator'): AgentIdentity => ({
  id: getOrchestratorId(workspaceId),
  workspaceId,
  name,
  kind: 'orchestrator',
})

export const isWorkerAgent = (agent: AgentIdentity): agent is AgentIdentity & { kind: 'worker' } =>
  agent.kind === 'worker'
