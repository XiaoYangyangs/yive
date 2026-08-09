import type { Database } from 'better-sqlite3'
import type { AgentIdentity } from '../shared/types.js'
import type { WorkspaceRecord } from './workspace-store-contract.js'
import {
  createOrchestrator,
  type MessageKindRecord,
  type WorkerRow,
  type WorkspaceRow,
  type WorkspaceSummaryRow,
} from './workspace-store-support.js'

const createWorkerSummary = (
  workspaceId: string,
  row: Pick<WorkerRow, 'id' | 'name'>
): AgentIdentity => ({
  id: row.id,
  workspaceId,
  name: row.name,
  kind: 'worker',
})

export const hydrateWorkspaceFromDb = (
  db: Database,
  workspaces: Map<string, WorkspaceRecord>,
  _messageKinds: MessageKindRecord[],
  workspaceId: string
) => {
  if (workspaces.has(workspaceId)) {
    return
  }

  const row = db
    .prepare('SELECT id, name, path, orchestrator_name FROM workspaces WHERE id = ?')
    .get(workspaceId) as WorkspaceSummaryRow | undefined
  if (!row) {
    return
  }

  workspaces.set(row.id, {
    summary: { id: row.id, name: row.name, path: row.path },
    agents: [createOrchestrator(row.id, row.orchestrator_name)],
  })

  for (const workerRow of db
    .prepare(
      'SELECT id, workspace_id, name FROM workers WHERE workspace_id = ? ORDER BY created_at ASC'
    )
    .all(workspaceId) as WorkerRow[]) {
    workspaces.get(workspaceId)?.agents.push(createWorkerSummary(workerRow.workspace_id, workerRow))
  }
}

export const seedWorkspacesFromDb = (
  db: Database,
  workspaces: Map<string, WorkspaceRecord>,
  _messageKinds: MessageKindRecord[]
) => {
  for (const row of db
    .prepare('SELECT id, name, path, orchestrator_name FROM workspaces ORDER BY created_at ASC')
    .all() as WorkspaceRow[]) {
    workspaces.set(row.id, {
      summary: { id: row.id, name: row.name, path: row.path },
      agents: [createOrchestrator(row.id, row.orchestrator_name)],
    })
  }

  for (const row of db
    .prepare('SELECT id, workspace_id, name FROM workers ORDER BY created_at ASC')
    .all() as WorkerRow[]) {
    workspaces.get(row.workspace_id)?.agents.push(createWorkerSummary(row.workspace_id, row))
  }
}
