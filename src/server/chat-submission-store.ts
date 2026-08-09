import type { Database } from 'better-sqlite3'

import type { MobileChatAttachment } from '../shared/types.js'

import { getChatAttachmentReference } from './chat-attachment-binding.js'
import { normalizeVerifiedConversationText } from './conversation-content.js'
import { BadRequestError, ChatQueueCapacityError, ConflictError } from './http-errors.js'

type StoredSubmissionState =
  | 'accepted'
  | 'cancelled'
  | 'confirmed'
  | 'delivered'
  | 'paused'
  | 'queued'
  | 'sending'
  | 'undelivered'

interface SubmissionRow {
  accepted_at: number
  attachments_json: string
  body: string
  cancelled_at: number | null
  confirmed_at: number | null
  conversation_id: string
  delivered_at: number | null
  delivery_text: string
  error_code: string | null
  id: string
  provider_event_id: string | null
  provider_turn_sequence: number | null
  paused_at: number | null
  pause_reason: string | null
  queue_sequence: number | null
  state: StoredSubmissionState
}

interface SubmissionInput {
  attachments?: MobileChatAttachment[]
  body?: string
  conversationId: string
  deliveryText?: string
  id: string
  workspaceId: string
}

const parseAttachments = (value: string, submissionId: string): MobileChatAttachment[] => {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) throw new Error('Invalid persisted Chat attachments')
  return parsed.map((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('file_id' in item) ||
      typeof item.file_id !== 'string' ||
      !('mime_type' in item) ||
      typeof item.mime_type !== 'string' ||
      !('name' in item) ||
      typeof item.name !== 'string' ||
      !('placeholder' in item) ||
      typeof item.placeholder !== 'string' ||
      !('size' in item) ||
      typeof item.size !== 'number'
    ) {
      throw new Error('Invalid persisted Chat attachment')
    }
    return {
      artifact:
        'artifact' in item && typeof item.artifact === 'string'
          ? item.artifact
          : getChatAttachmentReference(submissionId, item.file_id, item.mime_type),
      file_id: item.file_id,
      mime_type: item.mime_type,
      name: item.name,
      placeholder: item.placeholder,
      size: item.size,
    }
  })
}

const attachmentsJson = (attachments: MobileChatAttachment[] | undefined) =>
  JSON.stringify(attachments ?? [])

const serializeSubmission = (row: SubmissionRow) => ({
  accepted_at: row.accepted_at,
  attachments: parseAttachments(row.attachments_json, row.id),
  body: normalizeVerifiedConversationText(row.body),
  cancelled_at: row.cancelled_at,
  confirmed_at: row.confirmed_at,
  conversation_id: row.conversation_id,
  delivered_at: row.delivered_at,
  error_code: row.error_code,
  id: row.id,
  provider_event_id: row.provider_event_id,
  provider_turn_sequence: row.provider_turn_sequence,
  paused_at: row.paused_at,
  pause_reason: row.pause_reason,
  queue_sequence: row.queue_sequence,
  state: row.state === 'accepted' ? ('sending' as const) : row.state,
})

const selectSubmission = (db: Database, id: string) =>
  db.prepare('SELECT * FROM chat_submissions WHERE id = ?').get(id) as SubmissionRow | undefined

const requireSubmission = (db: Database, workspaceId: string, id: string) => {
  const row = db
    .prepare(
      `SELECT submission.*
       FROM chat_submissions submission
       JOIN agent_conversations conversation ON conversation.id = submission.conversation_id
       WHERE submission.id = ? AND conversation.workspace_id = ?`
    )
    .get(id, workspaceId) as SubmissionRow | undefined
  if (!row) throw new BadRequestError(`Chat submission not found: ${id}`)
  return row
}

const findIdempotentSubmission = (db: Database, input: SubmissionInput) => {
  const existing = selectSubmission(db, input.id)
  if (!existing) return null
  const conversation = db
    .prepare('SELECT workspace_id FROM agent_conversations WHERE id = ?')
    .get(existing.conversation_id) as { workspace_id: string } | undefined
  if (
    (input.body !== undefined && existing.body !== input.body) ||
    (input.attachments !== undefined &&
      attachmentsJson(parseAttachments(existing.attachments_json, existing.id)) !==
        attachmentsJson(input.attachments)) ||
    existing.conversation_id !== input.conversationId ||
    conversation?.workspace_id !== input.workspaceId
  ) {
    throw new ConflictError('Chat submission UUID was already used with a different payload')
  }
  return serializeSubmission(existing)
}

const requireNewSubmissionBody = (db: Database, input: SubmissionInput) => {
  if (input.body === undefined && !input.attachments?.length) {
    throw new BadRequestError('Chat submission body or attachment is required for a new UUID')
  }
  const conversation = db
    .prepare('SELECT id FROM agent_conversations WHERE id = ? AND workspace_id = ?')
    .get(input.conversationId, input.workspaceId)
  if (!conversation) throw new BadRequestError(`Conversation not found: ${input.conversationId}`)
  return input.body ?? ''
}

export const createChatSubmissionStore = (db: Database) => ({
  find(id: string) {
    const row = selectSubmission(db, id)
    return row ? serializeSubmission(row) : null
  },
  pauseForRuntimeRestart() {
    const now = Date.now()
    return db
      .prepare(
        `UPDATE chat_submissions
         SET state = 'paused', error_code = 'runtime_restarted', paused_at = ?,
             pause_reason = 'runtime_restarted', updated_at = ?
         WHERE state IN ('accepted', 'queued', 'sending', 'undelivered')`
      )
      .run(now, now).changes
  },
  pauseConversation(conversationId: string, reason: string) {
    const now = Date.now()
    return db
      .prepare(
        `UPDATE chat_submissions
         SET state = 'paused', error_code = ?, paused_at = ?, pause_reason = ?, updated_at = ?
         WHERE conversation_id = ? AND state IN ('accepted', 'queued', 'sending', 'undelivered')`
      )
      .run(reason, now, reason, now, conversationId).changes
  },
  pauseAgent(workspaceId: string, agentId: string, reason: string) {
    const now = Date.now()
    return db
      .prepare(
        `UPDATE chat_submissions
         SET state = 'paused', error_code = ?, paused_at = ?, pause_reason = ?, updated_at = ?
         WHERE conversation_id IN (
           SELECT id FROM agent_conversations
           WHERE workspace_id = ? AND agent_id = ?
         ) AND state IN ('accepted', 'queued', 'sending', 'undelivered')`
      )
      .run(reason, now, reason, now, workspaceId, agentId).changes
  },
  continuePaused(workspaceId: string, id: string) {
    return db.transaction(() => {
      const row = requireSubmission(db, workspaceId, id)
      if (row.state !== 'paused')
        throw new ConflictError('Only a paused Chat submission can continue')
      const queuedCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM chat_submissions
             WHERE conversation_id = ? AND state = 'queued'`
          )
          .get(row.conversation_id) as { count: number }
      ).count
      if (queuedCount >= 3) throw new ChatQueueCapacityError()
      db.prepare(
        `UPDATE chat_submissions
         SET state = 'queued', error_code = NULL, paused_at = NULL, pause_reason = NULL,
             queue_sequence = (
               SELECT COALESCE(MAX(queue_sequence), 0) + 1
               FROM chat_submissions WHERE conversation_id = ?
             ),
             updated_at = ?
         WHERE id = ? AND state = 'paused'`
      ).run(row.conversation_id, Date.now(), id)
      return serializeSubmission(selectSubmission(db, id) as SubmissionRow)
    })()
  },
  getPausedBody(workspaceId: string, id: string) {
    const row = requireSubmission(db, workspaceId, id)
    if (row.state !== 'paused') throw new ConflictError('Only a paused Chat submission can migrate')
    return {
      attachments: parseAttachments(row.attachments_json, row.id),
      body: row.body,
      conversationId: row.conversation_id,
      deliveryText: row.delivery_text,
    }
  },
  listPausedForAgent(workspaceId: string, agentId: string, excludedConversationId?: string) {
    return (
      db
        .prepare(
          `SELECT submission.*
           FROM chat_submissions submission
           JOIN agent_conversations conversation ON conversation.id = submission.conversation_id
           WHERE conversation.workspace_id = ? AND conversation.agent_id = ?
             AND submission.state = 'paused'
             AND (? IS NULL OR submission.conversation_id <> ?)
           ORDER BY submission.accepted_at, submission.id`
        )
        .all(
          workspaceId,
          agentId,
          excludedConversationId ?? null,
          excludedConversationId ?? null
        ) as SubmissionRow[]
    ).map(serializeSubmission)
  },
  accept(input: SubmissionInput) {
    const existing = findIdempotentSubmission(db, input)
    if (existing) return existing
    const body = requireNewSubmissionBody(db, input)
    const now = Date.now()
    db.prepare(
      `INSERT INTO chat_submissions
         (id, conversation_id, body, delivery_text, confirmation_text, attachments_json,
          state, accepted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`
    ).run(
      input.id,
      input.conversationId,
      body,
      input.deliveryText ?? body,
      normalizeVerifiedConversationText(input.deliveryText ?? body),
      attachmentsJson(input.attachments),
      now,
      now
    )
    return serializeSubmission(selectSubmission(db, input.id) as SubmissionRow)
  },
  acceptQueued(input: SubmissionInput) {
    return db.transaction(() => {
      const existing = findIdempotentSubmission(db, input)
      if (existing) return existing
      const body = requireNewSubmissionBody(db, input)
      const queuedCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM chat_submissions
             WHERE conversation_id = ? AND state = 'queued'`
          )
          .get(input.conversationId) as { count: number }
      ).count
      if (queuedCount >= 3) {
        throw new ChatQueueCapacityError()
      }
      const now = Date.now()
      db.prepare(
        `INSERT INTO chat_submissions
           (id, conversation_id, body, delivery_text, confirmation_text, attachments_json,
            state, queue_sequence,
            accepted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued',
                 (SELECT COALESCE(MAX(queue_sequence), 0) + 1
                  FROM chat_submissions WHERE conversation_id = ?),
                 ?, ?)`
      ).run(
        input.id,
        input.conversationId,
        body,
        input.deliveryText ?? body,
        normalizeVerifiedConversationText(input.deliveryText ?? body),
        attachmentsJson(input.attachments),
        input.conversationId,
        now,
        now
      )
      return serializeSubmission(selectSubmission(db, input.id) as SubmissionRow)
    })()
  },
  requeueUndelivered(workspaceId: string, id: string) {
    return db.transaction(() => {
      const row = requireSubmission(db, workspaceId, id)
      if (row.state !== 'undelivered') {
        throw new ConflictError('Only an undelivered Chat submission can be queued for retry')
      }
      const queuedCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM chat_submissions
             WHERE conversation_id = ? AND state = 'queued'`
          )
          .get(row.conversation_id) as { count: number }
      ).count
      if (queuedCount >= 3) {
        throw new ChatQueueCapacityError()
      }
      db.prepare(
        `UPDATE chat_submissions
         SET state = 'queued', error_code = NULL,
             queue_sequence = (
               SELECT COALESCE(MAX(queue_sequence), 0) + 1
               FROM chat_submissions WHERE conversation_id = ?
             ),
             updated_at = ?
         WHERE id = ? AND state = 'undelivered'`
      ).run(row.conversation_id, Date.now(), id)
      return serializeSubmission(selectSubmission(db, id) as SubmissionRow)
    })()
  },
  beginForcedDelivery(workspaceId: string, id: string, expectedSkippedCount: number) {
    return db.transaction(() => {
      const row = requireSubmission(db, workspaceId, id)
      if (row.state !== 'queued' && row.state !== 'paused') {
        throw new ConflictError('Only a queued or paused Chat submission can be forced')
      }
      const skippedCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM chat_submissions
             WHERE conversation_id = ? AND state IN ('queued', 'paused')
               AND (accepted_at < ? OR (accepted_at = ? AND id < ?))`
          )
          .get(row.conversation_id, row.accepted_at, row.accepted_at, row.id) as { count: number }
      ).count
      if (skippedCount !== expectedSkippedCount) {
        throw new ConflictError('Chat submission queue changed; confirm the skipped count again')
      }
      const now = Date.now()
      const result = db
        .prepare(
          `UPDATE chat_submissions
           SET state = 'sending', error_code = NULL, paused_at = NULL, pause_reason = NULL,
               updated_at = ?
           WHERE id = ? AND state IN ('queued', 'paused')`
        )
        .run(now, id)
      return {
        body: row.delivery_text,
        skippedCount,
        started: result.changes === 1,
      }
    })()
  },
  beginAutomaticDelivery(conversationId: string, id: string) {
    return db.transaction(() => {
      const blocker = db
        .prepare(
          `SELECT id FROM chat_submissions
           WHERE conversation_id = ? AND state IN ('sending', 'delivered', 'undelivered')
           LIMIT 1`
        )
        .get(conversationId)
      if (blocker) return { body: '', started: false }
      const first = db
        .prepare(
          `SELECT id FROM chat_submissions
           WHERE conversation_id = ? AND state = 'queued'
           ORDER BY queue_sequence
           LIMIT 1`
        )
        .get(conversationId) as { id: string } | undefined
      if (first?.id !== id) return { body: '', started: false }
      const row = selectSubmission(db, id)
      if (!row) throw new BadRequestError(`Chat submission not found: ${id}`)
      const result = db
        .prepare(
          `UPDATE chat_submissions
           SET state = 'sending', error_code = NULL, updated_at = ?
           WHERE id = ? AND state = 'queued'`
        )
        .run(Date.now(), id)
      return { body: row.delivery_text, started: result.changes === 1 }
    })()
  },
  beginDelivery(id: string) {
    const now = Date.now()
    const result = db
      .prepare(
        `UPDATE chat_submissions
       SET state = 'sending', error_code = NULL, updated_at = ?
       WHERE id = ? AND state IN ('accepted', 'queued', 'undelivered')`
      )
      .run(now, id)
    const row = selectSubmission(db, id)
    if (!row) throw new BadRequestError(`Chat submission not found: ${id}`)
    return { body: row.delivery_text, started: result.changes === 1, state: row.state }
  },
  confirmVerifiedUserTurns(
    conversationId: string,
    turns: Array<{ providerEventId: string; text: string }>
  ) {
    const now = Date.now()
    db.transaction(() => {
      const findSequence = db.prepare(
        `SELECT sequence FROM conversation_turns
         WHERE conversation_id = ? AND provider_event_id = ? AND role = 'user'`
      )
      const confirm = db.prepare(
        `UPDATE chat_submissions
         SET state = 'confirmed', confirmed_at = ?, provider_event_id = ?,
             provider_turn_sequence = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM chat_submissions
           WHERE conversation_id = ? AND confirmation_text = ?
             AND state IN ('sending', 'delivered')
           ORDER BY accepted_at, id
           LIMIT 1
         )`
      )
      for (const turn of turns) {
        const row = findSequence.get(conversationId, turn.providerEventId) as
          | { sequence: number }
          | undefined
        if (!row) continue
        confirm.run(now, turn.providerEventId, row.sequence, now, conversationId, turn.text)
      }
    })()
  },
  cancel(workspaceId: string, id: string) {
    const row = requireSubmission(db, workspaceId, id)
    if (!['accepted', 'paused', 'queued', 'undelivered'].includes(row.state)) {
      throw new ConflictError('Chat submission was already delivered and is immutable')
    }
    const now = Date.now()
    db.prepare(
      `UPDATE chat_submissions
       SET state = 'cancelled', cancelled_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(now, now, id)
    return serializeSubmission(selectSubmission(db, id) as SubmissionRow)
  },
  rollbackAcceptance(id: string) {
    db.prepare(
      `DELETE FROM chat_submissions
       WHERE id = ? AND state IN ('accepted', 'queued') AND delivered_at IS NULL`
    ).run(id)
  },
  edit(workspaceId: string, id: string, body: string, deliveryText = body) {
    const row = requireSubmission(db, workspaceId, id)
    if (!['accepted', 'paused', 'queued', 'undelivered'].includes(row.state)) {
      throw new ConflictError('Chat submission was already delivered and is immutable')
    }
    db.prepare(
      `UPDATE chat_submissions
       SET body = ?, delivery_text = ?, confirmation_text = ?, updated_at = ?
       WHERE id = ?`
    ).run(body, deliveryText, normalizeVerifiedConversationText(deliveryText), Date.now(), id)
    return serializeSubmission(selectSubmission(db, id) as SubmissionRow)
  },
  markDelivered(id: string) {
    const now = Date.now()
    db.prepare(
      `UPDATE chat_submissions
       SET state = 'delivered', delivered_at = ?, error_code = NULL, updated_at = ?
       WHERE id = ? AND state IN ('accepted', 'paused', 'sending')`
    ).run(now, now, id)
    const row = selectSubmission(db, id)
    if (!row) throw new BadRequestError(`Chat submission not found: ${id}`)
    return serializeSubmission(row)
  },
  markUndelivered(id: string, errorCode: string) {
    db.prepare(
      `UPDATE chat_submissions
       SET state = 'undelivered', error_code = ?, updated_at = ?
       WHERE id = ? AND state IN ('accepted', 'queued', 'sending')`
    ).run(errorCode, Date.now(), id)
    const row = selectSubmission(db, id)
    if (!row) throw new BadRequestError(`Chat submission not found: ${id}`)
    return serializeSubmission(row)
  },
  listForConversation(conversationId: string) {
    return (
      db
        .prepare(
          `SELECT * FROM chat_submissions
           WHERE conversation_id = ?
           ORDER BY accepted_at, COALESCE(queue_sequence, 0), id`
        )
        .all(conversationId) as SubmissionRow[]
    ).map(serializeSubmission)
  },
  listAttachmentSubmissionIds(workspaceId: string, agentId?: string) {
    return (
      db
        .prepare(
          `SELECT submission.id
           FROM chat_submissions submission
           JOIN agent_conversations conversation ON conversation.id = submission.conversation_id
           WHERE conversation.workspace_id = ?
             AND (? IS NULL OR conversation.agent_id = ?)
             AND submission.attachments_json <> '[]'`
        )
        .all(workspaceId, agentId ?? null, agentId ?? null) as Array<{ id: string }>
    ).map((row) => row.id)
  },
  listAttachmentSubmissions() {
    return (
      db
        .prepare(
          `SELECT submission.id, submission.attachments_json, conversation.workspace_id
           FROM chat_submissions submission
           JOIN agent_conversations conversation ON conversation.id = submission.conversation_id
           WHERE submission.attachments_json <> '[]' AND submission.state <> 'cancelled'`
        )
        .all() as Array<{ attachments_json: string; id: string; workspace_id: string }>
    ).map((row) => ({
      attachments: parseAttachments(row.attachments_json, row.id),
      id: row.id,
      workspaceId: row.workspace_id,
    }))
  },
  listQueued(conversationId: string) {
    return (
      db
        .prepare(
          `SELECT * FROM chat_submissions
           WHERE conversation_id = ? AND state = 'queued'
           ORDER BY queue_sequence`
        )
        .all(conversationId) as SubmissionRow[]
    ).map(serializeSubmission)
  },
  getNextAutomaticCandidate(conversationId: string) {
    const blocker = db
      .prepare(
        `SELECT id FROM chat_submissions
         WHERE conversation_id = ? AND state IN ('sending', 'delivered', 'undelivered')
         LIMIT 1`
      )
      .get(conversationId)
    if (blocker) return null
    const row = db
      .prepare(
        `SELECT * FROM chat_submissions
         WHERE conversation_id = ? AND state = 'queued'
         ORDER BY queue_sequence
         LIMIT 1`
      )
      .get(conversationId) as SubmissionRow | undefined
    return row ? serializeSubmission(row) : null
  },
  hasQueued(conversationId: string) {
    return Boolean(
      db
        .prepare(
          `SELECT id FROM chat_submissions
           WHERE conversation_id = ? AND state = 'queued'
           LIMIT 1`
        )
        .get(conversationId)
    )
  },
  hasDeliveryBlocker(conversationId: string, excludedId?: string) {
    return Boolean(
      db
        .prepare(
          `SELECT id FROM chat_submissions
           WHERE conversation_id = ? AND state IN ('accepted', 'sending', 'delivered', 'undelivered')
             AND (? IS NULL OR id <> ?)
           LIMIT 1`
        )
        .get(conversationId, excludedId ?? null, excludedId ?? null)
    )
  },
  getSubmissionIdentity(workspaceId: string, id: string) {
    return db
      .prepare(
        `SELECT submission.id, submission.conversation_id, submission.state,
                conversation.agent_id, conversation.active, conversation.stale,
                conversation.workspace_id
         FROM chat_submissions submission
         JOIN agent_conversations conversation ON conversation.id = submission.conversation_id
         WHERE submission.id = ? AND conversation.workspace_id = ?`
      )
      .get(id, workspaceId) as
      | {
          active: number
          agent_id: string
          conversation_id: string
          id: string
          stale: number
          state: StoredSubmissionState
          workspace_id: string
        }
      | undefined
  },
  get(id: string) {
    const row = selectSubmission(db, id)
    if (!row) throw new BadRequestError(`Chat submission not found: ${id}`)
    return serializeSubmission(row)
  },
})
