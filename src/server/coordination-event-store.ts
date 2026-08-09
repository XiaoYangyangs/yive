import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

import { ConflictError, DataCorruptionError } from './http-errors.js'

export type CoordinationEventKind = 'crash' | 'report' | 'status'
export type CoordinationEventDeliveryState = 'delivered' | 'delivering' | 'pending'

export interface CoordinationEventRecord {
  artifacts: string[]
  attemptCount: number
  createdAt: number
  deliveredAt: number | null
  deliveryState: CoordinationEventDeliveryState
  dispatchId: string | null
  id: string
  kind: CoordinationEventKind
  lastError: string | null
  outcome: 'completed' | 'failed' | null
  requestId: string
  text: string
  workerId: string
  workspaceId: string
}

export interface CreateCoordinationEventInput {
  artifacts: string[]
  dispatchId: string | null
  kind: CoordinationEventKind
  outcome?: 'completed' | 'failed'
  requestId: string
  text: string
  workerId: string
  workspaceId: string
}

interface CoordinationEventRow {
  artifacts: string
  attempt_count: number
  created_at: number
  delivered_at: number | null
  delivery_state: CoordinationEventDeliveryState
  dispatch_id: string | null
  id: string
  kind: CoordinationEventKind
  last_error: string | null
  outcome: 'completed' | 'failed' | null
  request_id: string
  text: string
  worker_id: string
  workspace_id: string
}

const parseArtifacts = (value: string) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new DataCorruptionError('Invalid persisted coordination event artifacts')
  }
  if (!Array.isArray(parsed) || parsed.some((artifact) => typeof artifact !== 'string')) {
    throw new DataCorruptionError('Invalid persisted coordination event artifacts')
  }
  return parsed
}

const toRecord = (row: CoordinationEventRow): CoordinationEventRecord => ({
  artifacts: parseArtifacts(row.artifacts),
  attemptCount: row.attempt_count,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
  deliveryState: row.delivery_state,
  dispatchId: row.dispatch_id,
  id: row.id,
  kind: row.kind,
  lastError: row.last_error,
  outcome: row.outcome,
  requestId: row.request_id,
  text: row.text,
  workerId: row.worker_id,
  workspaceId: row.workspace_id,
})

export const createCoordinationEventStore = (db: Database) => {
  const create = (input: CreateCoordinationEventInput) => {
    const existing = db
      .prepare(
        `SELECT * FROM coordination_events
         WHERE workspace_id = ? AND worker_id = ? AND kind = ? AND request_id = ?
         LIMIT 1`
      )
      .get(input.workspaceId, input.workerId, input.kind, input.requestId) as
      | CoordinationEventRow
      | undefined
    if (existing) return toRecord(existing)
    const record: CoordinationEventRecord = {
      ...input,
      attemptCount: 0,
      createdAt: Date.now(),
      deliveredAt: null,
      deliveryState: 'pending',
      id: randomUUID(),
      lastError: null,
      outcome: input.outcome ?? null,
    }
    db.prepare(
      `INSERT INTO coordination_events (
         id, workspace_id, dispatch_id, worker_id, kind, request_id, outcome,
         text, artifacts, delivery_state, attempt_count, last_error, created_at, delivered_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.workspaceId,
      record.dispatchId,
      record.workerId,
      record.kind,
      record.requestId,
      record.outcome,
      record.text,
      JSON.stringify(record.artifacts),
      record.deliveryState,
      record.attemptCount,
      record.lastError,
      record.createdAt,
      record.deliveredAt
    )
    return record
  }

  const listPending = (workspaceId: string, limit = 50) =>
    (
      db
        .prepare(
          `SELECT * FROM coordination_events
           WHERE workspace_id = ? AND delivery_state = 'pending'
           ORDER BY sequence ASC
           LIMIT ?`
        )
        .all(workspaceId, limit) as CoordinationEventRow[]
    ).map(toRecord)

  const listUndelivered = (workspaceId: string, limit = 50) =>
    (
      db
        .prepare(
          `SELECT * FROM coordination_events
           WHERE workspace_id = ? AND delivery_state IN ('pending', 'delivering')
           ORDER BY sequence ASC
           LIMIT ?`
        )
        .all(workspaceId, limit) as CoordinationEventRow[]
    ).map(toRecord)

  const claimPendingTransaction = db.transaction((workspaceId: string, limit = 50) => {
    const pending = listPending(workspaceId, limit)
    if (pending.length === 0) return []
    const placeholders = pending.map(() => '?').join(', ')
    db.prepare(
      `UPDATE coordination_events
       SET delivery_state = 'delivering', attempt_count = attempt_count + 1, last_error = NULL
       WHERE id IN (${placeholders}) AND delivery_state = 'pending'`
    ).run(...pending.map((event) => event.id))
    return pending.map((event) => ({
      ...event,
      attemptCount: event.attemptCount + 1,
      deliveryState: 'delivering' as const,
    }))
  })
  const claimPending = (workspaceId: string, limit = 50) =>
    claimPendingTransaction.immediate(workspaceId, limit)

  const markDelivered = (ids: string[]) => {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(', ')
    const result = db
      .prepare(
        `UPDATE coordination_events
         SET delivery_state = 'delivered', delivered_at = ?, last_error = NULL
         WHERE id IN (${placeholders}) AND delivery_state = 'delivering'`
      )
      .run(Date.now(), ...ids)
    if (result.changes !== ids.length) {
      throw new ConflictError('Coordination event delivery completion raced')
    }
    return result.changes
  }

  const reconcileDelivered = (ids: string[]) => {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(', ')
    return db
      .prepare(
        `UPDATE coordination_events
         SET delivery_state = 'delivered', delivered_at = COALESCE(delivered_at, ?),
             last_error = NULL
         WHERE id IN (${placeholders}) AND delivery_state IN ('pending', 'delivering')`
      )
      .run(Date.now(), ...ids).changes
  }

  const release = (ids: string[], error: string) => {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(', ')
    db.prepare(
      `UPDATE coordination_events
       SET delivery_state = 'pending', last_error = ?
       WHERE id IN (${placeholders}) AND delivery_state = 'delivering'`
    ).run(error, ...ids)
  }

  const recoverInterruptedDeliveries = () => {
    db.prepare(
      `UPDATE coordination_events
       SET delivery_state = 'pending', last_error = 'runtime_restarted_during_delivery'
       WHERE delivery_state = 'delivering'`
    ).run()
  }

  const deleteWorkspace = (workspaceId: string) => {
    db.prepare('DELETE FROM coordination_events WHERE workspace_id = ?').run(workspaceId)
  }

  const deleteWorker = (workspaceId: string, workerId: string) => {
    db.prepare('DELETE FROM coordination_events WHERE workspace_id = ? AND worker_id = ?').run(
      workspaceId,
      workerId
    )
  }

  return {
    claimPending,
    create,
    deleteWorker,
    deleteWorkspace,
    listPending,
    listUndelivered,
    markDelivered,
    reconcileDelivered,
    recoverInterruptedDeliveries,
    release,
  }
}
