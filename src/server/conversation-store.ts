import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

import { BadRequestError, ConflictError } from './http-errors.js'

interface ConversationRow {
  active: number
  activity_state: 'busy' | 'idle' | 'unknown'
  agent_id: string
  cli_session_id: string
  created_at: number
  id: string
  provider: 'claude' | 'codex'
  recording_boundary: number
  source_checkpoint: number
  stale: number
  updated_at: number
  workspace_id: string
}

interface ConversationListRow extends ConversationRow {
  title: string | null
}

interface TurnRow {
  provider_event_id: string
  role: 'assistant' | 'user'
  sequence: number
  source_checkpoint: number
  text: string
}

interface ToolActivityRow {
  completed_at: number | null
  label: string
  provider_event_id: string
  sequence: number
  source_checkpoint: number
  started_at: number
  status: 'completed' | 'failed' | 'running'
}

export interface ObserveConversationInput {
  activityState: 'busy' | 'idle' | null
  agentId: string
  checkpoint: number
  cliSessionId: string
  provider: 'claude' | 'codex'
  sourcePath: string
  workspaceId: string
}

export interface ConversationTurnInput {
  providerEventId: string
  role: 'assistant' | 'user'
  sourceCheckpoint?: number
  text: string
}

export interface ConversationToolActivityInput {
  completedAt: number | null
  label: string | null
  providerEventId: string
  sourceCheckpoint: number
  startedAt: number | null
  status: 'completed' | 'failed' | 'running'
}

const serializeConversation = (
  row: ConversationRow,
  turns: TurnRow[],
  toolActivity: ToolActivityRow[]
) => ({
  activity_state: row.stale === 1 ? ('unknown' as const) : row.activity_state,
  agent_id: row.agent_id,
  cli_session_id: row.cli_session_id,
  cursor: row.source_checkpoint,
  id: row.id,
  observed_at: row.updated_at,
  provider: row.provider,
  recording_boundary: row.recording_boundary,
  source_checkpoint: row.source_checkpoint,
  stale: row.stale === 1,
  tool_activity: toolActivity.map((tool) => ({
    completed_at: tool.completed_at,
    duration_ms:
      tool.completed_at === null ? null : Math.max(0, tool.completed_at - tool.started_at),
    label: tool.label,
    provider_event_id: tool.provider_event_id,
    sequence: tool.sequence,
    source_checkpoint: tool.source_checkpoint,
    started_at: tool.started_at,
    status: tool.status,
  })),
  turns: turns.map((turn) => ({
    provider_event_id: turn.provider_event_id,
    role: turn.role,
    sequence: turn.sequence,
    source_checkpoint: turn.source_checkpoint,
    text: turn.text,
  })),
  workspace_id: row.workspace_id,
})

const normalizeConversationTitle = (title: string | null) => {
  const normalized = title?.replace(/\s+/gu, ' ').trim() ?? ''
  if (!normalized) return 'New conversation'
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`
}

const encodeConversationCursor = (row: Pick<ConversationRow, 'created_at' | 'id'>) =>
  Buffer.from(JSON.stringify([row.created_at, row.id]), 'utf8').toString('base64url')

const decodeConversationCursor = (cursor: string | undefined) => {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      Number.isSafeInteger(value[0]) &&
      typeof value[1] === 'string'
    ) {
      return { createdAt: Number(value[0]), id: value[1] }
    }
  } catch {
    // Invalid cursors produce an empty continuation rather than changing the query shape.
  }
  throw new BadRequestError('Invalid conversation cursor')
}

export const createConversationStore = (db: Database) => ({
  dismissConversation(workspaceId: string, agentId: string, conversationId: string) {
    return db.transaction(() => {
      const row = db
        .prepare(
          `SELECT id, provider, cli_session_id, active
           FROM agent_conversations
           WHERE id = ? AND workspace_id = ? AND agent_id = ?`
        )
        .get(conversationId, workspaceId, agentId) as
        | { active: number; cli_session_id: string; id: string; provider: string }
        | undefined
      if (!row) throw new BadRequestError(`Conversation not found: ${conversationId}`)
      if (row.active === 1) throw new ConflictError('Only a historical conversation can be removed')
      db.prepare(
        `INSERT INTO dismissed_conversations
           (workspace_id, agent_id, provider, cli_session_id, dismissed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, agent_id, provider, cli_session_id) DO UPDATE SET
           dismissed_at = excluded.dismissed_at`
      ).run(workspaceId, agentId, row.provider, row.cli_session_id, Date.now())
      db.prepare('DELETE FROM conversation_tool_activity WHERE conversation_id = ?').run(
        conversationId
      )
      db.prepare('DELETE FROM agent_conversations WHERE id = ?').run(conversationId)
      return { dismissed: true, id: conversationId }
    })()
  },
  listConversations(workspaceId: string, agentId: string, limit = 30, cursor?: string | null) {
    const decoded = decodeConversationCursor(cursor ?? undefined)
    const rows = db
      .prepare(
        `SELECT conversation.id, conversation.workspace_id, conversation.agent_id,
                conversation.provider, conversation.cli_session_id,
                conversation.activity_state, conversation.recording_boundary,
                conversation.source_checkpoint, conversation.active, conversation.stale,
                conversation.created_at, conversation.updated_at,
                (SELECT turn.text FROM conversation_turns turn
                 WHERE turn.conversation_id = conversation.id AND turn.role = 'user'
                 ORDER BY turn.sequence LIMIT 1) AS title
         FROM agent_conversations conversation
         WHERE conversation.workspace_id = ? AND conversation.agent_id = ?
           AND (? IS NULL OR conversation.created_at < ?
                OR (conversation.created_at = ? AND conversation.id < ?))
         ORDER BY conversation.created_at DESC, conversation.id DESC
         LIMIT ?`
      )
      .all(
        workspaceId,
        agentId,
        decoded?.createdAt ?? null,
        decoded?.createdAt ?? null,
        decoded?.createdAt ?? null,
        decoded?.id ?? null,
        Math.max(1, Math.min(limit, 30)) + 1
      ) as ConversationListRow[]
    const pageLimit = Math.max(1, Math.min(limit, 30))
    const items = rows.slice(0, pageLimit)
    return {
      items: items.map((row) => ({
        active: row.active === 1,
        cli_session_id: row.cli_session_id,
        id: row.id,
        provider: row.provider,
        started_at: row.created_at,
        title: normalizeConversationTitle(row.title),
      })),
      next_cursor:
        rows.length > pageLimit && items.length > 0
          ? encodeConversationCursor(items[items.length - 1] as ConversationListRow)
          : null,
    }
  },
  getConversationPage(
    workspaceId: string,
    agentId: string,
    conversationId: string,
    limit = 30,
    cursor?: string | null
  ) {
    const row = db
      .prepare(
        `SELECT id, workspace_id, agent_id, provider, cli_session_id, activity_state,
                recording_boundary, source_checkpoint, active, stale, created_at, updated_at
         FROM agent_conversations
         WHERE id = ? AND workspace_id = ? AND agent_id = ?`
      )
      .get(conversationId, workspaceId, agentId) as ConversationRow | undefined
    if (!row) return null
    if (cursor && !/^[1-9][0-9]*$/u.test(cursor)) {
      throw new BadRequestError('Invalid conversation turn cursor')
    }
    const beforeSequence = cursor ? Number(cursor) : null
    const pageLimit = Math.max(1, Math.min(limit, 30))
    const descending = db
      .prepare(
        `SELECT sequence, provider_event_id, role, text, source_checkpoint
         FROM conversation_turns
         WHERE conversation_id = ? AND (? IS NULL OR sequence < ?)
         ORDER BY sequence DESC
         LIMIT ?`
      )
      .all(conversationId, beforeSequence, beforeSequence, pageLimit + 1) as TurnRow[]
    const hasMore = descending.length > pageLimit
    const turns = descending.slice(0, pageLimit).reverse()
    const toolActivity = (
      db
        .prepare(
          `SELECT sequence, provider_event_id, label, status, started_at, completed_at,
                  source_checkpoint
           FROM conversation_tool_activity
           WHERE conversation_id = ?
           ORDER BY sequence DESC
           LIMIT ?`
        )
        .all(conversationId, pageLimit) as ToolActivityRow[]
    ).reverse()
    return {
      ...serializeConversation(row, turns, toolActivity),
      active: row.active === 1,
      next_cursor: hasMore && turns.length > 0 ? String(turns[0]?.sequence) : null,
    }
  },
  getConversationIdentity(conversationId: string) {
    return db
      .prepare(
        `SELECT id, workspace_id, agent_id, provider, cli_session_id, active, stale
         FROM agent_conversations WHERE id = ?`
      )
      .get(conversationId) as
      | {
          active: number
          agent_id: string
          cli_session_id: string
          id: string
          provider: 'claude' | 'codex'
          stale: number
          workspace_id: string
        }
      | undefined
  },
  appendTurns(
    conversationId: string,
    turns: ConversationTurnInput[],
    checkpoint: number,
    activityState: 'busy' | 'idle' | null = null,
    toolActivity: ConversationToolActivityInput[] = []
  ) {
    const createdAt = Date.now()
    db.transaction(() => {
      const insert = db.prepare(
        `INSERT INTO conversation_turns
           (conversation_id, provider_event_id, role, text, created_at, source_checkpoint)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, provider_event_id) DO UPDATE SET
           role = excluded.role,
           text = excluded.text,
           source_checkpoint = excluded.source_checkpoint`
      )
      for (const turn of turns) {
        insert.run(
          conversationId,
          turn.providerEventId,
          turn.role,
          turn.text,
          createdAt,
          turn.sourceCheckpoint ?? checkpoint
        )
      }
      const upsertTool = db.prepare(
        `INSERT INTO conversation_tool_activity
           (conversation_id, provider_event_id, label, status, started_at, completed_at,
            source_checkpoint)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, provider_event_id) DO UPDATE SET
           label = CASE WHEN excluded.label = 'Tool' THEN label ELSE excluded.label END,
           status = excluded.status,
           started_at = MIN(started_at, excluded.started_at),
           completed_at = excluded.completed_at,
           source_checkpoint = excluded.source_checkpoint`
      )
      for (const tool of toolActivity) {
        const completedAt =
          tool.status === 'running' ? null : (tool.completedAt ?? tool.startedAt ?? createdAt)
        const startedAt = tool.startedAt ?? tool.completedAt ?? createdAt
        upsertTool.run(
          conversationId,
          tool.providerEventId,
          tool.label ?? 'Tool',
          tool.status,
          startedAt,
          completedAt,
          tool.sourceCheckpoint
        )
      }
      if (activityState === 'idle') {
        db.prepare(
          `UPDATE conversation_turns
           SET source_checkpoint = ?
           WHERE sequence = (
             SELECT sequence FROM conversation_turns
             WHERE conversation_id = ? AND role = 'assistant'
             ORDER BY sequence DESC LIMIT 1
           )`
        ).run(checkpoint, conversationId)
      }
      db.prepare(
        `UPDATE agent_conversations
         SET source_checkpoint = ?, activity_state = COALESCE(?, activity_state),
             stale = 0, updated_at = ?
         WHERE id = ?`
      ).run(checkpoint, activityState, createdAt, conversationId)
    })()
  },
  deleteAgent(workspaceId: string, agentId: string) {
    db.prepare(
      `DELETE FROM conversation_tool_activity
       WHERE conversation_id IN (
         SELECT id FROM agent_conversations WHERE workspace_id = ? AND agent_id = ?
       )`
    ).run(workspaceId, agentId)
    db.prepare(
      `DELETE FROM conversation_turns
       WHERE conversation_id IN (
         SELECT id FROM agent_conversations WHERE workspace_id = ? AND agent_id = ?
       )`
    ).run(workspaceId, agentId)
    db.prepare('DELETE FROM agent_conversations WHERE workspace_id = ? AND agent_id = ?').run(
      workspaceId,
      agentId
    )
    db.prepare('DELETE FROM dismissed_conversations WHERE workspace_id = ? AND agent_id = ?').run(
      workspaceId,
      agentId
    )
  },
  deleteWorkspace(workspaceId: string) {
    db.prepare(
      `DELETE FROM conversation_tool_activity
       WHERE conversation_id IN (
         SELECT id FROM agent_conversations WHERE workspace_id = ?
       )`
    ).run(workspaceId)
    db.prepare(
      `DELETE FROM conversation_turns
       WHERE conversation_id IN (
         SELECT id FROM agent_conversations WHERE workspace_id = ?
       )`
    ).run(workspaceId)
    db.prepare('DELETE FROM agent_conversations WHERE workspace_id = ?').run(workspaceId)
    db.prepare('DELETE FROM dismissed_conversations WHERE workspace_id = ?').run(workspaceId)
  },
  getCurrentConversation(
    workspaceId: string,
    agentId: string,
    limit: number,
    cursor?: string | null
  ) {
    const row = db
      .prepare(
        `SELECT id, workspace_id, agent_id, provider, cli_session_id, activity_state,
                recording_boundary, source_checkpoint, stale
         FROM agent_conversations
         WHERE workspace_id = ? AND agent_id = ? AND active = 1
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(workspaceId, agentId) as ConversationRow | undefined
    if (!row) return null
    if (cursor && !/^[0-9]+$/u.test(cursor)) {
      throw new BadRequestError('Invalid conversation update cursor')
    }
    const afterCheckpoint = cursor ? Number(cursor) : null
    const turns = (
      db
        .prepare(
          `SELECT sequence, provider_event_id, role, text, source_checkpoint
           FROM conversation_turns
           WHERE conversation_id = ? AND (? IS NULL OR source_checkpoint > ?)
           ORDER BY sequence DESC
           LIMIT ?`
        )
        .all(row.id, afterCheckpoint, afterCheckpoint, limit) as TurnRow[]
    ).reverse()
    const toolActivity = (
      db
        .prepare(
          `SELECT sequence, provider_event_id, label, status, started_at, completed_at,
                  source_checkpoint
           FROM conversation_tool_activity
           WHERE conversation_id = ? AND (? IS NULL OR source_checkpoint > ?)
           ORDER BY sequence DESC
           LIMIT ?`
        )
        .all(row.id, afterCheckpoint, afterCheckpoint, limit) as ToolActivityRow[]
    ).reverse()
    return serializeConversation(row, turns, toolActivity)
  },
  getActiveObservation(workspaceId: string, agentId: string) {
    return db
      .prepare(
        `SELECT id, cli_session_id, provider, source_checkpoint, source_path
         FROM agent_conversations
         WHERE workspace_id = ? AND agent_id = ? AND active = 1
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(workspaceId, agentId) as
      | {
          cli_session_id: string
          id: string
          provider: 'claude' | 'codex'
          source_checkpoint: number
          source_path: string
        }
      | undefined
  },
  markStale(conversationId: string) {
    db.prepare('UPDATE agent_conversations SET stale = 1, updated_at = ? WHERE id = ?').run(
      Date.now(),
      conversationId
    )
  },
  observeConversation(input: ObserveConversationInput) {
    const dismissed = db
      .prepare(
        `SELECT 1 FROM dismissed_conversations
         WHERE workspace_id = ? AND agent_id = ? AND provider = ? AND cli_session_id = ?`
      )
      .get(input.workspaceId, input.agentId, input.provider, input.cliSessionId)
    if (dismissed) {
      db.prepare(
        'UPDATE agent_conversations SET active = 0, updated_at = ? WHERE workspace_id = ? AND agent_id = ?'
      ).run(Date.now(), input.workspaceId, input.agentId)
      return null
    }
    const latestCreatedAt = (
      db.prepare('SELECT MAX(created_at) AS value FROM agent_conversations').get() as {
        value: number | null
      }
    ).value
    const now = Math.max(Date.now(), (latestCreatedAt ?? 0) + 1)
    const existing = db
      .prepare(
        `SELECT id, workspace_id, agent_id, provider, cli_session_id, activity_state,
                recording_boundary, source_checkpoint, active, stale, created_at, updated_at
         FROM agent_conversations
         WHERE workspace_id = ? AND agent_id = ? AND provider = ? AND cli_session_id = ?`
      )
      .get(input.workspaceId, input.agentId, input.provider, input.cliSessionId) as
      | ConversationRow
      | undefined
    if (existing) {
      db.transaction(() => {
        db.prepare(
          'UPDATE agent_conversations SET active = 0 WHERE workspace_id = ? AND agent_id = ? AND id <> ?'
        ).run(input.workspaceId, input.agentId, existing.id)
        db.prepare(
          `UPDATE agent_conversations
           SET active = 1, source_path = ?, activity_state = COALESCE(?, activity_state),
               stale = 0, updated_at = ?
           WHERE id = ?`
        ).run(input.sourcePath, input.activityState, now, existing.id)
      })()
      return existing
    }
    const id = randomUUID()
    db.transaction(() => {
      db.prepare(
        'UPDATE agent_conversations SET active = 0 WHERE workspace_id = ? AND agent_id = ?'
      ).run(input.workspaceId, input.agentId)
      db.prepare(
        `INSERT INTO agent_conversations
           (id, workspace_id, agent_id, provider, cli_session_id, source_path,
            recording_boundary, source_checkpoint, activity_state, active, stale,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
      ).run(
        id,
        input.workspaceId,
        input.agentId,
        input.provider,
        input.cliSessionId,
        input.sourcePath,
        input.checkpoint,
        input.checkpoint,
        input.activityState ?? 'unknown',
        now,
        now
      )
    })()
    return {
      active: 1,
      activity_state: input.activityState ?? 'unknown',
      agent_id: input.agentId,
      cli_session_id: input.cliSessionId,
      created_at: now,
      id,
      provider: input.provider,
      recording_boundary: input.checkpoint,
      source_checkpoint: input.checkpoint,
      stale: 0,
      updated_at: now,
      workspace_id: input.workspaceId,
    } satisfies ConversationRow
  },
})
