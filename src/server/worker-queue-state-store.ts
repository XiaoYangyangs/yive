import type { Database } from 'better-sqlite3'

export interface WorkerQueueStateRecord {
  pauseReason: string | null
  pausedAt: number | null
  updatedAt: number
  workerId: string
  workspaceId: string
}

interface WorkerQueueStateRow {
  pause_reason: string | null
  paused_at: number | null
  updated_at: number
  worker_id: string
  workspace_id: string
}

const toRecord = (row: WorkerQueueStateRow): WorkerQueueStateRecord => ({
  pauseReason: row.pause_reason,
  pausedAt: row.paused_at,
  updatedAt: row.updated_at,
  workerId: row.worker_id,
  workspaceId: row.workspace_id,
})

export const createWorkerQueueStateStore = (db: Database) => {
  const get = (workspaceId: string, workerId: string) => {
    const row = db
      .prepare(
        `SELECT * FROM worker_queue_state
         WHERE workspace_id = ? AND worker_id = ?`
      )
      .get(workspaceId, workerId) as WorkerQueueStateRow | undefined
    return row ? toRecord(row) : null
  }

  const getPauseReason = (workspaceId: string, workerId: string) =>
    get(workspaceId, workerId)?.pauseReason ?? null

  const pause = (workspaceId: string, workerId: string, reason: string) => {
    const now = Date.now()
    db.prepare(
      `INSERT INTO worker_queue_state (
         workspace_id, worker_id, pause_reason, paused_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, worker_id) DO UPDATE SET
         pause_reason = excluded.pause_reason,
         paused_at = excluded.paused_at,
         updated_at = excluded.updated_at`
    ).run(workspaceId, workerId, reason, now, now)
    return get(workspaceId, workerId)
  }

  const resume = (workspaceId: string, workerId: string) => {
    const now = Date.now()
    db.prepare(
      `INSERT INTO worker_queue_state (
         workspace_id, worker_id, pause_reason, paused_at, updated_at
       ) VALUES (?, ?, NULL, NULL, ?)
       ON CONFLICT (workspace_id, worker_id) DO UPDATE SET
         pause_reason = NULL,
         paused_at = NULL,
         updated_at = excluded.updated_at`
    ).run(workspaceId, workerId, now)
    const state = get(workspaceId, workerId)
    if (!state) throw new Error(`Failed to resume Worker queue: ${workerId}`)
    return state
  }

  const deleteWorkspace = (workspaceId: string) => {
    db.prepare('DELETE FROM worker_queue_state WHERE workspace_id = ?').run(workspaceId)
  }

  const deleteWorker = (workspaceId: string, workerId: string) => {
    db.prepare('DELETE FROM worker_queue_state WHERE workspace_id = ? AND worker_id = ?').run(
      workspaceId,
      workerId
    )
  }

  return { deleteWorker, deleteWorkspace, get, getPauseReason, pause, resume }
}
