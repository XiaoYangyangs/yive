import type { Database } from 'better-sqlite3'
import type { ArtifactReference } from '../shared/types.js'

import type { DispatchStatus } from './dispatch-ledger-store.js'
import { BadRequestError, ConflictError, HttpError } from './http-errors.js'

export type DispatchNoteActorType = 'agent' | 'user'
export type DispatchNoteDeliveryState = 'delivered' | 'delivering' | 'failed' | 'queued'

export interface DispatchNoteRecord {
  actorId: string
  actorType: DispatchNoteActorType
  artifacts: ArtifactReference[]
  createdAt: number
  deliveredAt: number | null
  deliveryError: string | null
  deliveryState: DispatchNoteDeliveryState
  dispatchId: string
  id: string
  sequence: number
  text: string
  workspaceId: string
}

interface DispatchNoteRow {
  actor_id: string
  actor_type: DispatchNoteActorType
  artifacts_json: string
  created_at: number
  delivered_at: number | null
  delivery_error: string | null
  delivery_state: DispatchNoteDeliveryState
  dispatch_id: string
  id: string
  sequence: number
  text: string
  workspace_id: string
}

export interface AppendDispatchNoteInput {
  actorId: string
  actorType: DispatchNoteActorType
  artifacts: ArtifactReference[]
  dispatchId: string
  id: string
  text: string
  workspaceId: string
}

export interface ListDispatchNotesOptions {
  deliveryStates?: DispatchNoteDeliveryState[]
  limit?: number
  order?: 'asc' | 'desc'
}

const parseArtifacts = (value: string): ArtifactReference[] => {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('Invalid persisted Dispatch Note artifacts')
  }
  return parsed as ArtifactReference[]
}

const toRecord = (row: DispatchNoteRow): DispatchNoteRecord => ({
  actorId: row.actor_id,
  actorType: row.actor_type,
  artifacts: parseArtifacts(row.artifacts_json),
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
  deliveryError: row.delivery_error,
  deliveryState: row.delivery_state,
  dispatchId: row.dispatch_id,
  id: row.id,
  sequence: row.sequence,
  text: row.text,
  workspaceId: row.workspace_id,
})

const selectNote = (db: Database, noteId: string) =>
  db.prepare('SELECT * FROM dispatch_notes WHERE id = ?').get(noteId) as DispatchNoteRow | undefined

const samePayload = (row: DispatchNoteRow, input: AppendDispatchNoteInput) =>
  row.workspace_id === input.workspaceId &&
  row.dispatch_id === input.dispatchId &&
  row.actor_type === input.actorType &&
  row.actor_id === input.actorId &&
  row.text === input.text &&
  row.artifacts_json === JSON.stringify(input.artifacts)

export const createDispatchNoteStore = (db: Database) => {
  const append = (input: AppendDispatchNoteInput) =>
    db.transaction(() => {
      const existing = selectNote(db, input.id)
      if (existing) {
        if (!samePayload(existing, input)) {
          throw new ConflictError('Dispatch Note ID was already used with a different payload')
        }
        return { created: false, note: toRecord(existing) }
      }

      const dispatch = db
        .prepare(
          'SELECT id, status, operation_kind FROM dispatches WHERE id = ? AND workspace_id = ?'
        )
        .get(input.dispatchId, input.workspaceId) as
        | { id: string; operation_kind: string | null; status: DispatchStatus }
        | undefined
      if (!dispatch) {
        throw new HttpError(400, `Dispatch not found: ${input.dispatchId}`, 'dispatch_not_found')
      }
      if (dispatch.status !== 'queued' && dispatch.status !== 'submitted') {
        throw new HttpError(
          409,
          `Cannot append a Note to ${dispatch.status} Dispatch`,
          'dispatch_terminal'
        )
      }
      if (dispatch.operation_kind !== null) {
        throw new HttpError(
          409,
          `Dispatch ${input.dispatchId} has a lifecycle operation in progress`,
          'dispatch_operation_in_progress'
        )
      }

      const createdAt = Date.now()
      db.prepare(
        `INSERT INTO dispatch_notes (
          id, workspace_id, dispatch_id, actor_type, actor_id, text, artifacts_json,
          delivery_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
      ).run(
        input.id,
        input.workspaceId,
        input.dispatchId,
        input.actorType,
        input.actorId,
        input.text,
        JSON.stringify(input.artifacts),
        createdAt,
        createdAt
      )
      return { created: true, note: toRecord(selectNote(db, input.id) as DispatchNoteRow) }
    })()

  const listForDispatch = (
    workspaceId: string,
    dispatchId: string,
    options: ListDispatchNotesOptions = {}
  ) => {
    const dispatch = db
      .prepare('SELECT id FROM dispatches WHERE id = ? AND workspace_id = ?')
      .get(dispatchId, workspaceId)
    if (!dispatch) throw new BadRequestError(`Dispatch not found: ${dispatchId}`)
    const clauses = ['workspace_id = ?', 'dispatch_id = ?']
    const parameters: Array<number | string> = [workspaceId, dispatchId]
    if (options.deliveryStates?.length) {
      clauses.push(`delivery_state IN (${options.deliveryStates.map(() => '?').join(', ')})`)
      parameters.push(...options.deliveryStates)
    }
    const order = options.order === 'desc' ? 'DESC' : 'ASC'
    const limit = options.limit === undefined ? '' : ' LIMIT ?'
    if (options.limit !== undefined) parameters.push(options.limit)
    return (
      db
        .prepare(
          `SELECT * FROM dispatch_notes
           WHERE ${clauses.join(' AND ')}
           ORDER BY sequence ${order}${limit}`
        )
        .all(...parameters) as DispatchNoteRow[]
    ).map(toRecord)
  }

  const get = (workspaceId: string, noteId: string) => {
    const row = db
      .prepare('SELECT * FROM dispatch_notes WHERE id = ? AND workspace_id = ?')
      .get(noteId, workspaceId) as DispatchNoteRow | undefined
    return row ? toRecord(row) : undefined
  }

  const listNextForAgent = (workspaceId: string, agentId: string) => {
    const row = db
      .prepare(
        `SELECT note.*
         FROM dispatch_notes note
         JOIN dispatches dispatch ON dispatch.id = note.dispatch_id
         WHERE note.workspace_id = ?
            AND dispatch.to_agent_id = ?
            AND dispatch.status = 'submitted'
            AND note.delivery_state IN ('queued', 'failed')
         ORDER BY note.sequence ASC
         LIMIT 1`
      )
      .get(workspaceId, agentId) as DispatchNoteRow | undefined
    return row ? toRecord(row) : undefined
  }

  const claimPendingForDispatch = (
    workspaceId: string,
    dispatchId: string,
    dispatchStatus: 'queued' | 'submitted'
  ) =>
    db.transaction(() => {
      const rows = db
        .prepare(
          `SELECT note.*
           FROM dispatch_notes note
           JOIN dispatches dispatch ON dispatch.id = note.dispatch_id
           WHERE note.workspace_id = ? AND note.dispatch_id = ?
             AND dispatch.workspace_id = note.workspace_id
             AND dispatch.status = ?
             AND note.delivery_state IN ('queued', 'failed')
           ORDER BY note.sequence ASC`
        )
        .all(workspaceId, dispatchId, dispatchStatus) as DispatchNoteRow[]
      if (rows.length === 0) return []
      const ids = rows.map((row) => row.id)
      const result = db
        .prepare(
          `UPDATE dispatch_notes
           SET delivery_state = 'delivering', delivery_error = NULL, updated_at = ?
           WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(', ')})
             AND delivery_state IN ('queued', 'failed')`
        )
        .run(Date.now(), workspaceId, ...ids)
      if (result.changes !== ids.length) {
        throw new ConflictError('Dispatch Note delivery claim raced')
      }
      return ids.map((id) => toRecord(selectNote(db, id) as DispatchNoteRow))
    })()

  const markDeliveredMany = (workspaceId: string, noteIds: string[]) => {
    if (noteIds.length === 0) return 0
    const now = Date.now()
    const result = db
      .prepare(
        `UPDATE dispatch_notes
         SET delivery_state = 'delivered', delivered_at = ?, updated_at = ?
         WHERE workspace_id = ? AND id IN (${noteIds.map(() => '?').join(', ')})
           AND delivery_state = 'delivering'`
      )
      .run(now, now, workspaceId, ...noteIds)
    if (result.changes !== noteIds.length) {
      throw new ConflictError('Dispatch Note delivery completion raced')
    }
    return result.changes
  }

  const reconcileDeliveredMany = (workspaceId: string, noteIds: string[]) => {
    if (noteIds.length === 0) return 0
    const now = Date.now()
    return db
      .prepare(
        `UPDATE dispatch_notes
         SET delivery_state = 'delivered', delivered_at = COALESCE(delivered_at, ?),
             delivery_error = NULL, updated_at = ?
         WHERE workspace_id = ? AND id IN (${noteIds.map(() => '?').join(', ')})
           AND delivery_state IN ('queued', 'delivering', 'failed')`
      )
      .run(now, now, workspaceId, ...noteIds).changes
  }

  const markFailedMany = (workspaceId: string, noteIds: string[], error: string) => {
    if (noteIds.length === 0) return
    db.prepare(
      `UPDATE dispatch_notes
       SET delivery_state = 'failed', delivery_error = ?, updated_at = ?
       WHERE workspace_id = ? AND id IN (${noteIds.map(() => '?').join(', ')})
         AND delivery_state = 'delivering'`
    ).run(error, Date.now(), workspaceId, ...noteIds)
  }

  const findPendingForDispatch = (workspaceId: string, dispatchId: string) => {
    const row = db
      .prepare(
        `SELECT * FROM dispatch_notes
         WHERE workspace_id = ? AND dispatch_id = ?
           AND delivery_state IN ('queued', 'failed', 'delivering')
         ORDER BY sequence ASC LIMIT 1`
      )
      .get(workspaceId, dispatchId) as DispatchNoteRow | undefined
    return row ? toRecord(row) : undefined
  }

  const recoverInterruptedDeliveries = () =>
    db
      .prepare(
        `UPDATE dispatch_notes
         SET delivery_state = 'failed', delivery_error = 'runtime_restarted', updated_at = ?
         WHERE delivery_state = 'delivering'`
      )
      .run(Date.now()).changes

  const deleteWorkspace = (workspaceId: string) => {
    db.prepare('DELETE FROM dispatch_notes WHERE workspace_id = ?').run(workspaceId)
  }

  const deleteWorker = (workspaceId: string, agentId: string) => {
    db.prepare(
      `DELETE FROM dispatch_notes
       WHERE workspace_id = ? AND dispatch_id IN (
         SELECT id FROM dispatches WHERE workspace_id = ? AND to_agent_id = ?
       )`
    ).run(workspaceId, workspaceId, agentId)
  }

  return {
    append,
    claimPendingForDispatch,
    deleteWorker,
    deleteWorkspace,
    findPendingForDispatch,
    get,
    listForDispatch,
    listNextForAgent,
    markDeliveredMany,
    markFailedMany,
    reconcileDeliveredMany,
    recoverInterruptedDeliveries,
  }
}
