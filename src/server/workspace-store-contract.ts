import type { AgentIdentity, WorkspaceSummary } from '../shared/types.js'

export interface WorkspaceRecord {
  summary: WorkspaceSummary
  agents: AgentIdentity[]
}

export interface WorkerInput {
  name: string
}

export interface WorkspaceStore {
  addWorker: (workspaceId: string, input: WorkerInput) => AgentIdentity
  createWorkspace: (path: string, name: string) => WorkspaceSummary
  deleteWorkspace: (workspaceId: string) => void
  deleteWorker: (workspaceId: string, workerId: string) => void
  renameAgent: (workspaceId: string, agentId: string, name: string) => AgentIdentity
  renameWorker: (workspaceId: string, workerId: string, name: string) => AgentIdentity
  getAgent: (workspaceId: string, agentId: string) => AgentIdentity
  getWorker: (workspaceId: string, workerId: string) => AgentIdentity
  getWorkerByName: (workspaceId: string, workerName: string) => AgentIdentity
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceRecord
  hasAgent: (workspaceId: string, agentId: string) => boolean
  listWorkers: (workspaceId: string) => AgentIdentity[]
  listWorkspaces: () => WorkspaceSummary[]
}
