import { createHash } from 'node:crypto'

import type { Database } from 'better-sqlite3'
import type { ArtifactReference } from '../shared/types.js'

import { DataCorruptionError, StatusRequestConflictError } from './http-errors.js'

export interface StatusSnapshotRecord {
  artifacts: ArtifactReference[]
  createdAt: number
  dispatchId: string
  dispatchSequence: number
  from: string
  idempotentReplay?: true
  notify: boolean
  requestId: string
  text: string
  type: 'status'
  workerId: string
  workspaceId: string
}

export interface RecordStatusSnapshotInput {
  artifacts: string[]
  dispatchId: string
  dispatchSequence: number
  notify: boolean
  requestId: string
  text: string
  workerId: string
  workspaceId: string
}

interface StatusSnapshotRow {
  artifacts: string
  created_at: number
  dispatch_id: string
  dispatch_sequence: number
  notify: number
  request_fingerprint: string
  request_id: string
  text: string
  worker_id: string
  workspace_id: string
}

const parseArtifacts = (value: string): ArtifactReference[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new DataCorruptionError('Invalid persisted Status snapshot artifacts')
  }
  if (!Array.isArray(parsed) || parsed.some((artifact) => typeof artifact !== 'string')) {
    throw new DataCorruptionError('Invalid persisted Status snapshot artifacts')
  }
  return parsed as ArtifactReference[]
}

const toRecord = (row: StatusSnapshotRow): StatusSnapshotRecord => ({
  artifacts: parseArtifacts(row.artifacts),
  createdAt: row.created_at,
  dispatchId: row.dispatch_id,
  dispatchSequence: row.dispatch_sequence,
  from: row.worker_id,
  notify: row.notify === 1,
  requestId: row.request_id,
  text: row.text,
  type: 'status',
  workerId: row.worker_id,
  workspaceId: row.workspace_id,
})

export const createStatusSnapshotStore = (db: Database) => {
  const getFingerprint = (
    input: Pick<RecordStatusSnapshotInput, 'artifacts' | 'notify' | 'text'>
  ) =>
    createHash('sha256')
      .update(
        JSON.stringify({
          artifacts: [...input.artifacts].sort(),
          notify: input.notify,
          text: input.text,
        })
      )
      .digest('hex')

  const findIdempotent = (
    input: Pick<
      RecordStatusSnapshotInput,
      'artifacts' | 'notify' | 'requestId' | 'text' | 'workerId' | 'workspaceId'
    >
  ) => {
    const row = db
      .prepare(
        `SELECT * FROM dispatch_status_updates
         WHERE workspace_id = ? AND worker_id = ? AND request_id = ?
         LIMIT 1`
      )
      .get(input.workspaceId, input.workerId, input.requestId) as StatusSnapshotRow | undefined
    if (!row) return undefined
    if (row.request_fingerprint !== getFingerprint(input)) {
      throw new StatusRequestConflictError(input.requestId)
    }
    return { ...toRecord(row), idempotentReplay: true as const }
  }

  const recordTransaction = db.transaction((input: RecordStatusSnapshotInput) => {
    const existing = findIdempotent(input)
    if (existing) return existing
    const createdAt = Date.now()
    db.prepare(
      `INSERT INTO dispatch_status_updates (
         workspace_id, dispatch_id, dispatch_sequence, worker_id, request_id,
         request_fingerprint, text, artifacts, notify, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.workspaceId,
      input.dispatchId,
      input.dispatchSequence,
      input.workerId,
      input.requestId,
      getFingerprint(input),
      input.text,
      JSON.stringify(input.artifacts),
      input.notify ? 1 : 0,
      createdAt
    )
    return {
      ...input,
      artifacts: input.artifacts as ArtifactReference[],
      createdAt,
      from: input.workerId,
      type: 'status' as const,
    }
  })

  const record = (input: RecordStatusSnapshotInput) => recordTransaction.immediate(input)

  const getLatest = (workspaceId: string, workerId: string) => {
    const row = db
      .prepare(
        `SELECT * FROM dispatch_status_updates
         WHERE workspace_id = ? AND worker_id = ?
         ORDER BY sequence DESC
         LIMIT 1`
      )
      .get(workspaceId, workerId) as StatusSnapshotRow | undefined
    return row ? toRecord(row) : null
  }

  const getLatestMany = (workspaceId: string, workerIds: string[]) => {
    if (workerIds.length === 0) return new Map<string, StatusSnapshotRecord>()
    const placeholders = workerIds.map(() => '?').join(', ')
    const rows = db
      .prepare(
        `SELECT status.*
         FROM dispatch_status_updates status
         JOIN (
           SELECT worker_id, MAX(sequence) AS sequence
           FROM dispatch_status_updates
           WHERE workspace_id = ? AND worker_id IN (${placeholders})
           GROUP BY worker_id
         ) latest ON latest.sequence = status.sequence`
      )
      .all(workspaceId, ...workerIds) as StatusSnapshotRow[]
    return new Map(rows.map((row) => [row.worker_id, toRecord(row)]))
  }

  const deleteWorkspace = (workspaceId: string) => {
    db.prepare('DELETE FROM dispatch_status_updates WHERE workspace_id = ?').run(workspaceId)
  }

  const deleteWorker = (workspaceId: string, workerId: string) => {
    db.prepare('DELETE FROM dispatch_status_updates WHERE workspace_id = ? AND worker_id = ?').run(
      workspaceId,
      workerId
    )
  }

  return { deleteWorker, deleteWorkspace, findIdempotent, getLatest, getLatestMany, record }
}
