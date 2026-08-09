import type { WorkspaceRecord } from './workspace-store-contract.js'
import { isWorkerAgent } from './workspace-store-support.js'

type WorkspaceMap = Map<string, WorkspaceRecord>

const getWorkspaceRecord = (workspaces: WorkspaceMap, workspaceId: string) => {
  const workspace = workspaces.get(workspaceId)
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
  return workspace
}

export const getAgentRecord = (workspaces: WorkspaceMap, workspaceId: string, agentId: string) => {
  const agent = getWorkspaceRecord(workspaces, workspaceId).agents.find(
    (item) => item.id === agentId
  )
  if (!agent) throw new Error(`Agent not found: ${agentId}`)
  return agent
}

export const getWorkerRecord = (
  workspaces: WorkspaceMap,
  workspaceId: string,
  workerId: string
) => {
  const worker = getAgentRecord(workspaces, workspaceId, workerId)
  if (!isWorkerAgent(worker)) throw new Error(`Worker not found: ${workerId}`)
  return worker
}

export const getWorkerByNameRecord = (
  workspaces: WorkspaceMap,
  workspaceId: string,
  workerName: string
) => {
  const worker = getWorkspaceRecord(workspaces, workspaceId).agents.find(
    (item) => item.name === workerName && isWorkerAgent(item)
  )
  if (!worker) throw new Error(`Worker not found: ${workerName}`)
  return worker
}
