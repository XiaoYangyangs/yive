import { createHash, randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'
import type { ArtifactReference } from '../shared/types.js'

import {
  DataCorruptionError,
  DispatchOperationInProgressError,
  DispatchOperationRequestConflictError,
  DispatchRequestConflictError,
  ReportRequestConflictError,
} from './http-errors.js'

export type DispatchStatus =
  | 'queued'
  | 'submitted'
  | 'reported'
  | 'cancelled'
  | 'replaced'
  | 'replacement_pending'
export type DispatchOperationKind = 'cancel' | 'replace'
export type DispatchOperationState =
  | 'waiting_for_idle'
  | 'blocked'
  | 'delivering_replacement'
  | 'completed'

export interface DispatchRecord {
  artifacts: ArtifactReference[]
  createdAt: number
  deliveredAt: number | null
  fromAgentId: string | null
  id: string
  idempotentReplay?: true
  operationAttempts: number
  operationError: string | null
  operationKind: DispatchOperationKind | null
  operationReason: string | null
  operationRequestId: string | null
  operationRequestedAt: number | null
  operationSessionId: string | null
  operationState: DispatchOperationState | null
  operationUpdatedAt: number | null
  operationIdempotentReplay?: true
  pendingReplacementId: string | null
  queuePosition: number
  reportedAt: number | null
  reportIdempotentReplay?: true
  reportOutcome: 'completed' | 'failed' | null
  reportRequestId: string | null
  reportText: string | null
  requestId?: string | null
  replacedBy: string | null
  replacesDispatchId: string | null
  sequence: number | null
  status: DispatchStatus
  submittedAt: number | null
  text: string
  toAgentId: string
  workspaceId: string
}

interface DispatchRow {
  artifacts: string | null
  created_at: number
  delivered_at: number | null
  from_agent_id: string | null
  id: string
  operation_attempts: number
  operation_error: string | null
  operation_kind: DispatchOperationKind | null
  operation_reason: string | null
  operation_request_fingerprint: string | null
  operation_request_id: string | null
  operation_requested_at: number | null
  operation_session_id: string | null
  operation_state: DispatchOperationState | null
  operation_updated_at: number | null
  pending_replacement_id: string | null
  queue_position: number
  reported_at: number | null
  report_outcome: 'completed' | 'failed' | null
  report_request_fingerprint: string | null
  report_request_id: string | null
  report_text: string | null
  request_fingerprint: string | null
  request_id: string | null
  replaced_by: string | null
  replaces_dispatch_id: string | null
  sequence: number
  status: DispatchStatus
  submitted_at: number | null
  text: string
  to_agent_id: string
  workspace_id: string
}

export interface CreateDispatchInput {
  artifacts?: string[]
  fromAgentId?: string
  queue?: boolean
  queuePosition?: number
  replacesDispatchId?: string
  requestId?: string
  text: string
  toAgentId: string
  workspaceId: string
}

interface ReportDispatchInput {
  artifacts: string[]
  outcome: 'completed' | 'failed'
  requestId: string
  reportText: string
  toAgentId: string
  workspaceId: string
}

interface CancelDispatchInput {
  dispatchId: string
  reason: string
  requestId: string
  workspaceId: string
}

export interface ReplaceQueuedDispatchInput {
  artifacts?: string[]
  dispatchId: string
  fromAgentId: string
  requestId: string
  text: string
  workspaceId: string
}

export interface BeginCancellationInput extends CancelDispatchInput {
  sessionId: string | null
}

export interface BeginReplacementInput extends ReplaceQueuedDispatchInput {
  interrupt: boolean
  operationState: Extract<DispatchOperationState, 'waiting_for_idle' | 'delivering_replacement'>
  sessionId: string | null
}

export interface DispatchReplacementResult {
  dispatch: DispatchRecord
  operationIdempotentReplay?: true
  replacedDispatch: DispatchRecord
}

export interface ListDispatchesOptions {
  limit?: number
  offset?: number
  order?: 'asc' | 'desc'
  status?: DispatchStatus
  toAgentId?: string
}

const parseArtifacts = (value: string | null): ArtifactReference[] => {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? (parsed.filter(
          (artifact): artifact is string => typeof artifact === 'string'
        ) as ArtifactReference[])
      : []
  } catch {
    return []
  }
}

const parseReportOutcome = (value: unknown): 'completed' | 'failed' | null => {
  if (value === null || value === 'completed' || value === 'failed') return value
  throw new DataCorruptionError('Invalid persisted Report outcome')
}

const toRecord = (row: DispatchRow): DispatchRecord => ({
  artifacts: parseArtifacts(row.artifacts),
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
  fromAgentId: row.from_agent_id,
  id: row.id,
  operationAttempts: row.operation_attempts,
  operationError: row.operation_error,
  operationKind: row.operation_kind,
  operationReason: row.operation_reason,
  operationRequestId: row.operation_request_id,
  operationRequestedAt: row.operation_requested_at,
  operationSessionId: row.operation_session_id,
  operationState: row.operation_state,
  operationUpdatedAt: row.operation_updated_at,
  pendingReplacementId: row.pending_replacement_id,
  queuePosition: row.queue_position,
  reportedAt: row.reported_at,
  reportOutcome: parseReportOutcome(row.report_outcome),
  reportRequestId: row.report_request_id,
  reportText: row.report_text,
  requestId: row.request_id,
  replacedBy: row.replaced_by,
  replacesDispatchId: row.replaces_dispatch_id,
  sequence: row.sequence,
  status: row.status,
  submittedAt: row.submitted_at,
  text: row.text,
  toAgentId: row.to_agent_id,
  workspaceId: row.workspace_id,
})

export const createDispatchLedgerStore = (db: Database) => {
  const getCancellationFingerprint = (input: CancelDispatchInput) =>
    createHash('sha256')
      .update(JSON.stringify({ dispatch_id: input.dispatchId, reason: input.reason }))
      .digest('hex')

  const getReplacementFingerprint = (input: BeginReplacementInput) =>
    createHash('sha256')
      .update(
        JSON.stringify({
          artifacts: [...(input.artifacts ?? [])].sort(),
          dispatch_id: input.dispatchId,
          interrupt: input.interrupt,
          text: input.text,
        })
      )
      .digest('hex')

  const getRequestFingerprint = (input: CreateDispatchInput) =>
    createHash('sha256')
      .update(
        JSON.stringify({
          artifacts: [...(input.artifacts ?? [])].sort(),
          delivery_mode: input.queue === true ? 'queued' : 'immediate',
          replaces_dispatch_id: input.replacesDispatchId ?? null,
          text: input.text,
          to_agent_id: input.toAgentId,
        })
      )
      .digest('hex')

  const getReportRequestFingerprint = (input: ReportDispatchInput) =>
    createHash('sha256')
      .update(
        JSON.stringify({
          artifacts: [...input.artifacts].sort(),
          outcome: input.outcome,
          report_text: input.reportText,
        })
      )
      .digest('hex')

  const findIdempotentReport = (input: ReportDispatchInput) => {
    const existing = db
      .prepare(
        `SELECT *
         FROM dispatches
         WHERE workspace_id = ?
           AND to_agent_id = ?
           AND report_request_id = ?
         LIMIT 1`
      )
      .get(input.workspaceId, input.toAgentId, input.requestId) as DispatchRow | undefined
    if (!existing) return undefined
    if (existing.report_request_fingerprint !== getReportRequestFingerprint(input)) {
      throw new ReportRequestConflictError(input.requestId)
    }
    return { ...toRecord(existing), reportIdempotentReplay: true as const }
  }

  const findIdempotentDispatch = (input: CreateDispatchInput) => {
    if (!input.requestId) return undefined
    const existing = db
      .prepare(
        `SELECT *
         FROM dispatches
         WHERE workspace_id = ?
           AND from_agent_id IS ?
           AND request_id = ?
         LIMIT 1`
      )
      .get(input.workspaceId, input.fromAgentId ?? null, input.requestId) as DispatchRow | undefined
    if (!existing) return undefined
    if (existing.request_fingerprint !== getRequestFingerprint(input)) {
      throw new DispatchRequestConflictError(input.requestId)
    }
    return { ...toRecord(existing), idempotentReplay: true as const }
  }

  const createDispatchTransaction = db.transaction((input: CreateDispatchInput) => {
    const artifacts = input.artifacts ?? []
    const requestId = input.requestId ?? randomUUID()
    const requestFingerprint = getRequestFingerprint(input)
    const existing = findIdempotentDispatch({ ...input, requestId })
    if (existing) {
      return existing
    }

    const queuePosition =
      input.queuePosition ??
      (
        db
          .prepare(
            `SELECT COALESCE(MAX(queue_position), 0) + 1 AS next_position
             FROM dispatches
             WHERE workspace_id = ? AND to_agent_id = ?`
          )
          .get(input.workspaceId, input.toAgentId) as { next_position: number }
      ).next_position
    const record: DispatchRecord = {
      artifacts: artifacts as ArtifactReference[],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: input.fromAgentId ?? null,
      id: randomUUID(),
      operationAttempts: 0,
      operationError: null,
      operationKind: null,
      operationReason: null,
      operationRequestId: null,
      operationRequestedAt: null,
      operationSessionId: null,
      operationState: null,
      operationUpdatedAt: null,
      pendingReplacementId: null,
      queuePosition,
      reportedAt: null,
      reportOutcome: null,
      reportRequestId: null,
      reportText: null,
      requestId,
      replacedBy: null,
      replacesDispatchId: input.replacesDispatchId ?? null,
      sequence: null,
      status: 'queued',
      submittedAt: null,
      text: input.text,
      toAgentId: input.toAgentId,
      workspaceId: input.workspaceId,
    }

    const insertResult = db
      .prepare(
        `INSERT INTO dispatches (
        id,
        workspace_id,
        from_agent_id,
        to_agent_id,
        text,
        status,
        created_at,
        delivered_at,
        submitted_at,
        reported_at,
        report_text,
        artifacts,
        request_id,
        request_fingerprint,
        queue_position,
        replaced_by,
        replaces_dispatch_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.workspaceId,
        record.fromAgentId,
        record.toAgentId,
        record.text,
        record.status,
        record.createdAt,
        record.deliveredAt,
        record.submittedAt,
        record.reportedAt,
        record.reportText,
        JSON.stringify(record.artifacts),
        requestId,
        requestFingerprint,
        record.queuePosition,
        record.replacedBy,
        record.replacesDispatchId
      )

    return { ...record, sequence: Number(insertResult.lastInsertRowid) }
  })
  const createDispatch = (input: CreateDispatchInput) => createDispatchTransaction.immediate(input)

  const deleteDispatch = (dispatchId: string) => {
    db.prepare('DELETE FROM dispatches WHERE id = ?').run(dispatchId)
  }

  const markSubmitted = (dispatchId: string) => {
    const submittedAt = Date.now()
    const result = db
      .prepare(
        `UPDATE dispatches
       SET status = ?, delivered_at = ?, submitted_at = ?
       WHERE id = ? AND status = 'queued'`
      )
      .run('submitted', submittedAt, submittedAt, dispatchId)
    return result.changes === 1
  }

  const findNextQueuedDispatch = (workspaceId: string, toAgentId: string) => {
    const row = db
      .prepare(
        `SELECT *
         FROM dispatches
         WHERE workspace_id = ?
           AND to_agent_id = ?
           AND status = 'queued'
         ORDER BY queue_position ASC, sequence ASC
         LIMIT 1`
      )
      .get(workspaceId, toAgentId) as DispatchRow | undefined

    return row ? toRecord(row) : undefined
  }

  const findOpenDispatch = (workspaceId: string, toAgentId: string, dispatchId?: string) => {
    if (dispatchId) {
      const row = db
        .prepare(
          `SELECT *
           FROM dispatches
           WHERE id = ?
             AND workspace_id = ?
             AND to_agent_id = ?
             AND status IN ('queued', 'submitted')
           LIMIT 1`
        )
        .get(dispatchId, workspaceId, toAgentId) as DispatchRow | undefined

      return row ? toRecord(row) : undefined
    }

    const row = db
      .prepare(
        `SELECT *
         FROM dispatches
         WHERE workspace_id = ?
           AND to_agent_id = ?
           AND status IN ('queued', 'submitted')
         ORDER BY queue_position ASC, sequence ASC
         LIMIT 1`
      )
      .get(workspaceId, toAgentId) as DispatchRow | undefined

    return row ? toRecord(row) : undefined
  }

  const findOpenDispatchById = (workspaceId: string, dispatchId: string) => {
    const row = db
      .prepare(
        `SELECT *
         FROM dispatches
         WHERE id = ?
           AND workspace_id = ?
           AND status IN ('queued', 'submitted')
         LIMIT 1`
      )
      .get(dispatchId, workspaceId) as DispatchRow | undefined

    return row ? toRecord(row) : undefined
  }

  const findSubmittedDispatch = (workspaceId: string, toAgentId: string) => {
    const row = db
      .prepare(
        `SELECT *
         FROM dispatches
         WHERE workspace_id = ?
           AND to_agent_id = ?
           AND status = 'submitted'
         ORDER BY queue_position ASC, sequence ASC
         LIMIT 1`
      )
      .get(workspaceId, toAgentId) as DispatchRow | undefined

    return row ? toRecord(row) : undefined
  }

  const findLatestDispatch = (workspaceId: string, toAgentId: string) => {
    const row = db
      .prepare(
        `SELECT *
         FROM dispatches
         WHERE workspace_id = ? AND to_agent_id = ?
         ORDER BY sequence DESC
         LIMIT 1`
      )
      .get(workspaceId, toAgentId) as DispatchRow | undefined

    return row ? toRecord(row) : undefined
  }

  const findDispatchById = (workspaceId: string, dispatchId: string) => {
    const row = db
      .prepare('SELECT * FROM dispatches WHERE id = ? AND workspace_id = ? LIMIT 1')
      .get(dispatchId, workspaceId) as DispatchRow | undefined
    return row ? toRecord(row) : undefined
  }

  const markReportedByWorkerTransaction = db.transaction((input: ReportDispatchInput) => {
    const existing = findIdempotentReport(input)
    if (existing) return existing
    const submittedDispatch = findSubmittedDispatch(input.workspaceId, input.toAgentId)
    if (!submittedDispatch) {
      return undefined
    }
    if (submittedDispatch.operationKind !== null) {
      throw new DispatchOperationInProgressError(submittedDispatch.id)
    }

    const reportedAt = Date.now()
    const requestFingerprint = getReportRequestFingerprint(input)
    const result = db
      .prepare(
        `UPDATE dispatches
         SET status = ?,
             reported_at = ?,
             report_text = ?,
             artifacts = ?,
             report_outcome = ?,
             report_request_id = ?,
             report_request_fingerprint = ?
         WHERE id = ? AND status = 'submitted' AND report_request_id IS NULL
           AND operation_kind IS NULL`
      )
      .run(
        'reported',
        reportedAt,
        input.reportText,
        JSON.stringify(input.artifacts),
        input.outcome,
        input.requestId,
        requestFingerprint,
        submittedDispatch.id
      )
    if (result.changes !== 1) {
      const current = findDispatchById(input.workspaceId, submittedDispatch.id)
      if (current?.operationKind) {
        throw new DispatchOperationInProgressError(submittedDispatch.id)
      }
      return findIdempotentReport(input)
    }

    return {
      ...submittedDispatch,
      artifacts: input.artifacts as ArtifactReference[],
      reportedAt,
      reportOutcome: input.outcome,
      reportRequestId: input.requestId,
      reportText: input.reportText,
      status: 'reported' as const,
    }
  })
  const markReportedByWorker = (input: ReportDispatchInput) =>
    markReportedByWorkerTransaction.immediate(input)

  const findOperationRequest = (workspaceId: string, requestId: string) =>
    db
      .prepare(
        `SELECT * FROM dispatches
         WHERE workspace_id = ? AND operation_request_id = ?
         LIMIT 1`
      )
      .get(workspaceId, requestId) as DispatchRow | undefined

  const assertCancellationRequest = (
    row: DispatchRow,
    input: CancelDispatchInput,
    fingerprint: string
  ) => {
    if (
      row.id !== input.dispatchId ||
      row.operation_kind !== 'cancel' ||
      row.operation_request_fingerprint !== fingerprint
    ) {
      throw new DispatchOperationRequestConflictError(input.requestId)
    }
  }

  const beginCancellationTransaction = db.transaction((input: BeginCancellationInput) => {
    const fingerprint = getCancellationFingerprint(input)
    const replay = findOperationRequest(input.workspaceId, input.requestId)
    if (replay) {
      assertCancellationRequest(replay, input, fingerprint)
      return { ...toRecord(replay), operationIdempotentReplay: true as const }
    }
    const dispatch = findOpenDispatchById(input.workspaceId, input.dispatchId)
    if (!dispatch || dispatch.status !== 'submitted') return undefined
    if (dispatch.operationRequestId && dispatch.operationRequestId !== input.requestId) {
      throw new DispatchOperationInProgressError(dispatch.id)
    }
    const now = Date.now()
    const result = db
      .prepare(
        `UPDATE dispatches
         SET operation_kind = 'cancel',
             operation_state = 'waiting_for_idle',
             operation_error = NULL,
             operation_request_id = ?,
             operation_request_fingerprint = ?,
             operation_reason = ?,
             operation_session_id = ?,
             operation_attempts = 0,
             operation_requested_at = ?,
             operation_updated_at = ?
         WHERE id = ? AND workspace_id = ? AND status = 'submitted'
           AND operation_request_id IS NULL`
      )
      .run(
        input.requestId,
        fingerprint,
        input.reason,
        input.sessionId,
        now,
        now,
        input.dispatchId,
        input.workspaceId
      )
    if (result.changes !== 1) throw new DispatchOperationInProgressError(dispatch.id)
    return findDispatchById(input.workspaceId, input.dispatchId)
  })
  const beginCancellation = (input: BeginCancellationInput) =>
    beginCancellationTransaction.immediate(input)

  const findIdempotentReplacement = (
    input: BeginReplacementInput
  ): DispatchReplacementResult | undefined => {
    const fingerprint = getReplacementFingerprint(input)
    const operationReplay = findOperationRequest(input.workspaceId, input.requestId)
    if (!operationReplay) return undefined
    if (
      operationReplay.id !== input.dispatchId ||
      operationReplay.operation_kind !== 'replace' ||
      operationReplay.operation_request_fingerprint !== fingerprint ||
      !operationReplay.pending_replacement_id
    ) {
      throw new DispatchOperationRequestConflictError(input.requestId)
    }
    const replacement = findDispatchById(input.workspaceId, operationReplay.pending_replacement_id)
    if (!replacement) throw new DataCorruptionError('Pending replacement Dispatch is missing')
    return {
      dispatch: replacement,
      operationIdempotentReplay: true,
      replacedDispatch: toRecord(operationReplay),
    }
  }

  const beginReplacementTransaction = db.transaction(
    (input: BeginReplacementInput): DispatchReplacementResult | undefined => {
      const target = findDispatchById(input.workspaceId, input.dispatchId)
      if (!target) return undefined
      const fingerprint = getReplacementFingerprint(input)
      const operationReplay = findIdempotentReplacement(input)
      if (operationReplay) return operationReplay
      if (target.status !== 'submitted') return undefined
      if (target.operationRequestId && target.operationRequestId !== input.requestId) {
        throw new DispatchOperationInProgressError(target.id)
      }
      const replacement = createDispatchTransaction({
        artifacts: input.artifacts ?? [],
        fromAgentId: input.fromAgentId,
        queue: false,
        queuePosition: target.queuePosition,
        replacesDispatchId: target.id,
        requestId: input.requestId,
        text: input.text,
        toAgentId: target.toAgentId,
        workspaceId: input.workspaceId,
      })
      const now = Date.now()
      const pending = db
        .prepare(
          `UPDATE dispatches SET status = 'replacement_pending'
           WHERE id = ? AND status = 'queued'`
        )
        .run(replacement.id)
      if (pending.changes !== 1) {
        throw new Error(`Failed to persist pending replacement: ${replacement.id}`)
      }
      const operation = db
        .prepare(
          `UPDATE dispatches
           SET operation_kind = 'replace',
               operation_state = ?,
               operation_error = NULL,
               operation_request_id = ?,
               operation_request_fingerprint = ?,
               operation_reason = NULL,
               operation_session_id = ?,
               operation_attempts = 0,
               operation_requested_at = ?,
               operation_updated_at = ?,
               pending_replacement_id = ?
           WHERE id = ? AND workspace_id = ? AND status = 'submitted'
             AND operation_request_id IS NULL`
        )
        .run(
          input.operationState,
          input.requestId,
          fingerprint,
          input.sessionId,
          now,
          now,
          replacement.id,
          target.id,
          input.workspaceId
        )
      if (operation.changes !== 1) throw new DispatchOperationInProgressError(target.id)
      const replacedDispatch = findDispatchById(input.workspaceId, target.id)
      const pendingDispatch = findDispatchById(input.workspaceId, replacement.id)
      if (!replacedDispatch || !pendingDispatch) {
        throw new DataCorruptionError('Replacement lifecycle records are missing')
      }
      return { dispatch: pendingDispatch, replacedDispatch }
    }
  )
  const beginReplacement = (input: BeginReplacementInput) =>
    beginReplacementTransaction.immediate(input)

  const recordInterruptionAttempt = (
    workspaceId: string,
    dispatchId: string,
    requestId: string
  ) => {
    const now = Date.now()
    const result = db
      .prepare(
        `UPDATE dispatches
         SET operation_attempts = operation_attempts + 1,
             operation_state = 'waiting_for_idle',
             operation_error = NULL,
             operation_updated_at = ?
         WHERE id = ? AND workspace_id = ? AND status = 'submitted'
           AND operation_kind IN ('cancel', 'replace') AND operation_request_id = ?
           AND operation_attempts < 2`
      )
      .run(now, dispatchId, workspaceId, requestId)
    if (result.changes !== 1) return undefined
    return findDispatchById(workspaceId, dispatchId)
  }

  const markOperationBlocked = (
    workspaceId: string,
    dispatchId: string,
    requestId: string,
    error: string
  ) => {
    const now = Date.now()
    db.prepare(
      `UPDATE dispatches
       SET operation_state = 'blocked', operation_error = ?, operation_updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'submitted'
         AND operation_request_id = ?`
    ).run(error, now, dispatchId, workspaceId, requestId)
    return findDispatchById(workspaceId, dispatchId)
  }

  const markReplacementDelivering = (
    workspaceId: string,
    dispatchId: string,
    requestId: string
  ) => {
    const now = Date.now()
    const result = db
      .prepare(
        `UPDATE dispatches
         SET operation_state = 'delivering_replacement',
             operation_error = NULL,
             operation_updated_at = ?
         WHERE id = ? AND workspace_id = ? AND status = 'submitted'
           AND operation_kind = 'replace' AND operation_request_id = ?`
      )
      .run(now, dispatchId, workspaceId, requestId)
    if (result.changes !== 1) return undefined
    return findDispatchById(workspaceId, dispatchId)
  }

  const completeReplacementTransaction = db.transaction(
    (workspaceId: string, dispatchId: string, requestId: string) => {
      const target = findDispatchById(workspaceId, dispatchId)
      if (
        !target ||
        target.status !== 'submitted' ||
        target.operationKind !== 'replace' ||
        target.operationRequestId !== requestId ||
        !target.pendingReplacementId
      ) {
        return undefined
      }
      const replacement = findDispatchById(workspaceId, target.pendingReplacementId)
      if (!replacement || replacement.status !== 'replacement_pending') {
        throw new DataCorruptionError('Pending replacement Dispatch is unavailable')
      }
      const now = Date.now()
      const completedOld = db
        .prepare(
          `UPDATE dispatches
           SET status = 'replaced',
               replaced_by = ?,
               reported_at = ?,
               operation_state = 'completed',
               operation_error = NULL,
               operation_updated_at = ?
           WHERE id = ? AND workspace_id = ? AND status = 'submitted'
             AND operation_kind = 'replace' AND operation_request_id = ?`
        )
        .run(replacement.id, now, now, target.id, workspaceId, requestId)
      const activatedNew = db
        .prepare(
          `UPDATE dispatches
           SET status = 'submitted', delivered_at = ?, submitted_at = ?
           WHERE id = ? AND workspace_id = ? AND status = 'replacement_pending'`
        )
        .run(now, now, replacement.id, workspaceId)
      if (completedOld.changes !== 1 || activatedNew.changes !== 1) {
        throw new Error(`Failed to complete replacement for Dispatch: ${target.id}`)
      }
      const completed = findDispatchById(workspaceId, target.id)
      const activated = findDispatchById(workspaceId, replacement.id)
      if (!completed || !activated)
        throw new DataCorruptionError('Completed replacement is missing')
      return { dispatch: activated, replacedDispatch: completed }
    }
  )
  const completeReplacement = (workspaceId: string, dispatchId: string, requestId: string) =>
    completeReplacementTransaction.immediate(workspaceId, dispatchId, requestId)

  const markCancelledTransaction = db.transaction((input: CancelDispatchInput) => {
    const fingerprint = getCancellationFingerprint(input)
    const replay = findOperationRequest(input.workspaceId, input.requestId)
    if (replay) {
      assertCancellationRequest(replay, input, fingerprint)
      if (replay.status === 'cancelled' && replay.operation_state === 'completed') {
        return { ...toRecord(replay), operationIdempotentReplay: true as const }
      }
    }
    const dispatch = replay
      ? toRecord(replay)
      : findOpenDispatchById(input.workspaceId, input.dispatchId)
    if (!dispatch) {
      return undefined
    }

    const cancelledAt = Date.now()
    db.prepare(
      `UPDATE dispatches
       SET status = ?,
           reported_at = ?,
           report_text = ?,
           operation_kind = 'cancel',
           operation_state = 'completed',
           operation_error = NULL,
           operation_request_id = ?,
           operation_request_fingerprint = ?,
           operation_reason = ?,
           operation_session_id = operation_session_id,
           operation_requested_at = ?,
           operation_updated_at = ?
       WHERE id = ?`
    ).run(
      'cancelled',
      cancelledAt,
      input.reason,
      input.requestId,
      fingerprint,
      input.reason,
      cancelledAt,
      cancelledAt,
      dispatch.id
    )

    return {
      ...dispatch,
      operationKind: 'cancel' as const,
      operationReason: input.reason,
      operationRequestId: input.requestId,
      operationRequestedAt: cancelledAt,
      operationState: 'completed' as const,
      operationUpdatedAt: cancelledAt,
      reportedAt: cancelledAt,
      reportText: input.reason,
      status: 'cancelled' as const,
    }
  })
  const markCancelled = (input: CancelDispatchInput) => markCancelledTransaction.immediate(input)

  const replaceQueuedTransaction = db.transaction((input: ReplaceQueuedDispatchInput) => {
    const target = findDispatchById(input.workspaceId, input.dispatchId)
    if (!target) return undefined
    const createInput: CreateDispatchInput = {
      artifacts: input.artifacts ?? [],
      fromAgentId: input.fromAgentId,
      queue: true,
      queuePosition: target.queuePosition,
      replacesDispatchId: target.id,
      requestId: input.requestId,
      text: input.text,
      toAgentId: target.toAgentId,
      workspaceId: input.workspaceId,
    }
    const replay = findIdempotentDispatch(createInput)
    if (replay) return replay
    if (target.status !== 'queued') return undefined

    const replacement = createDispatchTransaction(createInput)
    const replacedAt = Date.now()
    const result = db
      .prepare(
        `UPDATE dispatches
         SET status = 'replaced', replaced_by = ?, reported_at = ?
         WHERE id = ? AND workspace_id = ? AND status = 'queued'`
      )
      .run(replacement.id, replacedAt, target.id, input.workspaceId)
    if (result.changes !== 1) throw new Error(`Failed to replace queued Dispatch: ${target.id}`)
    return replacement
  })
  const replaceQueued = (input: ReplaceQueuedDispatchInput) =>
    replaceQueuedTransaction.immediate(input)

  const listWorkspaceDispatches = (workspaceId: string, options: ListDispatchesOptions = {}) => {
    const offset = options.offset ?? 0
    const limit = options.limit ?? 100
    const order = options.order === 'desc' ? 'DESC' : 'ASC'
    const clauses = ['workspace_id = ?']
    const parameters: Array<number | string> = [workspaceId]
    if (options.status) {
      clauses.push('status = ?')
      parameters.push(options.status)
    }
    if (options.toAgentId) {
      clauses.push('to_agent_id = ?')
      parameters.push(options.toAgentId)
    }

    return (
      db
        .prepare(
          `SELECT *
           FROM dispatches
           WHERE ${clauses.join(' AND ')}
           ORDER BY queue_position ${order}, sequence ${order}
           LIMIT ? OFFSET ?`
        )
        .all(...parameters, limit, offset) as DispatchRow[]
    ).map(toRecord)
  }

  const listOpenDispatches = (workspaceId: string, toAgentId?: string) => {
    const query = toAgentId
      ? `SELECT *
         FROM dispatches
         WHERE workspace_id = ?
           AND to_agent_id = ?
           AND status IN ('queued', 'submitted')
         ORDER BY queue_position ASC, sequence ASC`
      : `SELECT *
         FROM dispatches
         WHERE workspace_id = ?
           AND status IN ('queued', 'submitted')
         ORDER BY queue_position ASC, sequence ASC`
    const params = toAgentId ? [workspaceId, toAgentId] : [workspaceId]
    return (db.prepare(query).all(...params) as DispatchRow[]).map(toRecord)
  }

  const listOpenDispatchKinds = () => {
    return db
      .prepare(
        `SELECT workspace_id, to_agent_id AS worker_id, 'send' AS type
           FROM dispatches
           WHERE status IN ('queued', 'submitted')
           ORDER BY queue_position ASC, sequence ASC`
      )
      .all() as Array<{ type: 'send'; worker_id: string; workspace_id: string }>
  }

  const deleteWorkspaceDispatches = (workspaceId: string) => {
    db.prepare('DELETE FROM dispatches WHERE workspace_id = ?').run(workspaceId)
  }

  const deleteWorkerDispatches = (workspaceId: string, workerId: string) => {
    db.prepare('DELETE FROM dispatches WHERE workspace_id = ? AND to_agent_id = ?').run(
      workspaceId,
      workerId
    )
  }

  return {
    createDispatch,
    beginReplacement,
    completeReplacement,
    deleteDispatch,
    deleteWorkerDispatches,
    deleteWorkspaceDispatches,
    findOpenDispatch,
    findDispatchById,
    findIdempotentDispatch,
    findIdempotentReplacement,
    findIdempotentReport,
    findLatestDispatch,
    findNextQueuedDispatch,
    findOpenDispatchById,
    findSubmittedDispatch,
    listOpenDispatchKinds,
    listOpenDispatches,
    listWorkspaceDispatches,
    markCancelled,
    beginCancellation,
    markOperationBlocked,
    markReplacementDelivering,
    markReportedByWorker,
    markSubmitted,
    recordInterruptionAttempt,
    replaceQueued,
  }
}
