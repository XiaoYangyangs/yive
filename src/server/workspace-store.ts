import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'

import type { AgentIdentity } from '../shared/types.js'
import { ConflictError, InvalidWorkerError } from './http-errors.js'
import type { WorkerInput, WorkspaceRecord, WorkspaceStore } from './workspace-store-contract.js'
import { hydrateWorkspaceFromDb, seedWorkspacesFromDb } from './workspace-store-hydration.js'
import {
  getAgentRecord,
  getWorkerByNameRecord,
  getWorkerRecord,
} from './workspace-store-mutations.js'
import {
  createOrchestrator,
  isWorkerAgent,
  type MessageKindRecord,
} from './workspace-store-support.js'

export type { WorkerInput, WorkspaceRecord, WorkspaceStore }

const normalizeWorkerName = (name: string) => {
  const trimmed = name.trim()
  if (!trimmed) throw new InvalidWorkerError('Worker name must not be empty')
  if (trimmed.length > 64) {
    throw new InvalidWorkerError('Worker name must be 64 characters or fewer')
  }
  return trimmed
}

export const createWorkspaceStore = (
  db: Database,
  messageKinds: MessageKindRecord[]
): WorkspaceStore => {
  const workspaces = new Map<string, WorkspaceRecord>()
  seedWorkspacesFromDb(db, workspaces, messageKinds)

  const getWorkspace = (workspaceId: string) => {
    hydrateWorkspaceFromDb(db, workspaces, messageKinds, workspaceId)
    const workspace = workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    return workspace
  }

  const renameAgent = (workspaceId: string, agentId: string, name: string) => {
    const workspace = getWorkspace(workspaceId)
    const agent = getAgentRecord(workspaces, workspaceId, agentId)
    const trimmed = normalizeWorkerName(name)
    if (trimmed === agent.name) return agent
    if (
      workspace.agents.some((candidate) => candidate.id !== agentId && candidate.name === trimmed)
    ) {
      throw new ConflictError(`Agent name already exists: ${trimmed}`)
    }

    if (isWorkerAgent(agent)) {
      db.prepare('UPDATE workers SET name = ? WHERE workspace_id = ? AND id = ?').run(
        trimmed,
        workspaceId,
        agentId
      )
    } else {
      db.prepare('UPDATE workspaces SET orchestrator_name = ? WHERE id = ?').run(
        trimmed,
        workspaceId
      )
    }
    agent.name = trimmed
    return agent
  }

  return {
    addWorker(workspaceId, input) {
      const workspace = getWorkspace(workspaceId)
      const name = normalizeWorkerName(input.name)
      if (workspace.agents.some((agent) => agent.name === name && isWorkerAgent(agent))) {
        throw new ConflictError(`Worker name already exists: ${name}`)
      }
      const worker: AgentIdentity = {
        id: randomUUID(),
        workspaceId,
        name,
        kind: 'worker',
      }
      db.prepare(
        'INSERT INTO workers (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)'
      ).run(worker.id, workspaceId, worker.name, Date.now())
      workspace.agents.push(worker)
      return worker
    },
    createWorkspace(path, name) {
      const summary = { id: randomUUID(), name, path }
      db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
        summary.id,
        name,
        path,
        Date.now()
      )
      workspaces.set(summary.id, { summary, agents: [createOrchestrator(summary.id)] })
      return summary
    },
    deleteWorkspace(workspaceId) {
      const workspace = getWorkspace(workspaceId)
      const agentIds = workspace.agents.map((agent) => agent.id)
      db.transaction(() => {
        db.prepare('DELETE FROM messages WHERE workspace_id = ?').run(workspaceId)
        db.prepare('DELETE FROM agent_launch_configs WHERE workspace_id = ?').run(workspaceId)
        db.prepare('DELETE FROM agent_session_save_intents WHERE workspace_id = ?').run(workspaceId)
        db.prepare('DELETE FROM agent_sessions WHERE workspace_id = ?').run(workspaceId)
        const deleteAgentRuns = db.prepare('DELETE FROM agent_runs WHERE agent_id = ?')
        for (const agentId of agentIds) deleteAgentRuns.run(agentId)
        db.prepare('DELETE FROM workers WHERE workspace_id = ?').run(workspaceId)
        db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId)
      })()
      workspaces.delete(workspaceId)
    },
    renameAgent,
    renameWorker(workspaceId, workerId, name) {
      getWorkerRecord(workspaces, workspaceId, workerId)
      return renameAgent(workspaceId, workerId, name)
    },
    deleteWorker(workspaceId, workerId) {
      const workspace = getWorkspace(workspaceId)
      getWorkerRecord(workspaces, workspaceId, workerId)
      db.transaction(() => {
        db.prepare('DELETE FROM messages WHERE workspace_id = ? AND worker_id = ?').run(
          workspaceId,
          workerId
        )
        db.prepare('DELETE FROM agent_launch_configs WHERE workspace_id = ? AND agent_id = ?').run(
          workspaceId,
          workerId
        )
        db.prepare('DELETE FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?').run(
          workspaceId,
          workerId
        )
        db.prepare(
          'DELETE FROM agent_session_save_intents WHERE workspace_id = ? AND agent_id = ?'
        ).run(workspaceId, workerId)
        db.prepare('DELETE FROM agent_runs WHERE agent_id = ?').run(workerId)
        db.prepare('DELETE FROM workers WHERE workspace_id = ? AND id = ?').run(
          workspaceId,
          workerId
        )
      })()
      workspace.agents = workspace.agents.filter((agent) => agent.id !== workerId)
    },
    getAgent: (workspaceId, agentId) => getAgentRecord(workspaces, workspaceId, agentId),
    getWorker: (workspaceId, workerId) => getWorkerRecord(workspaces, workspaceId, workerId),
    getWorkerByName: (workspaceId, workerName) =>
      getWorkerByNameRecord(workspaces, workspaceId, workerName),
    getWorkspaceSnapshot: getWorkspace,
    hasAgent(workspaceId, agentId) {
      hydrateWorkspaceFromDb(db, workspaces, messageKinds, workspaceId)
      return workspaces.get(workspaceId)?.agents.some((agent) => agent.id === agentId) ?? false
    },
    listWorkers(workspaceId) {
      return getWorkspace(workspaceId)
        .agents.filter(isWorkerAgent)
        .map((worker) => ({ ...worker }))
    },
    listWorkspaces() {
      return Array.from(workspaces.values(), (workspace) => workspace.summary)
    },
  }
}
