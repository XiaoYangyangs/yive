import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

import type { ConversationProvider } from '../shared/types.js'
import type { SessionIdCaptureConfig } from './session-capture.js'

interface AgentSessionRow {
  agent_id: string
  last_session_id: string
  provider: ConversationProvider
  saved_at: number | null
  workspace_id: string
}

export interface AgentSessionBinding {
  provider: ConversationProvider
  savedAt: number | null
  sessionId: string
}

export type AgentSessionSaveState = 'failed' | 'saved' | 'waiting'

export interface AgentSessionSaveIntent {
  captureSource: SessionIdCaptureConfig['source']
  failureReason: string | null
  previousSessionId: string | null
  provider: ConversationProvider
  requestedAt: number
  requestId: string
  runId: string
  sessionId: string | null
  state: AgentSessionSaveState
  updatedAt: number
}

interface AgentSessionSaveIntentRow {
  capture_source: SessionIdCaptureConfig['source']
  failure_reason: string | null
  previous_session_id: string | null
  provider: ConversationProvider
  requested_at: number
  request_id: string
  run_id: string
  session_id: string | null
  state: AgentSessionSaveState
  updated_at: number
}

interface BeginSaveIntentInput {
  agentId: string
  captureSource: SessionIdCaptureConfig['source']
  previousSessionId: string | null
  provider: ConversationProvider
  runId: string
  workspaceId: string
}

export interface AgentSessionStore {
  beginSaveIntent: (input: BeginSaveIntentInput) => AgentSessionSaveIntent
  clearLastSessionId: (workspaceId: string, agentId: string) => void
  clearLastSessionIdIfMatches: (
    workspaceId: string,
    agentId: string,
    expectedSessionId: string
  ) => boolean
  getLastSessionId: (workspaceId: string, agentId: string) => string | undefined
  getSessionBinding: (workspaceId: string, agentId: string) => AgentSessionBinding | undefined
  getSaveIntent: (workspaceId: string, agentId: string) => AgentSessionSaveIntent | undefined
  completeSaveIntent: (
    workspaceId: string,
    agentId: string,
    runId: string,
    sessionId: string
  ) => AgentSessionSaveIntent | undefined
  failPendingSaveIntent: (
    workspaceId: string,
    agentId: string,
    runId: string,
    reason: string
  ) => AgentSessionSaveIntent | undefined
  failPendingSaveIntentsForRuntimeRestart: () => number
  saveLastSessionId: (
    workspaceId: string,
    agentId: string,
    sessionId: string,
    provider: ConversationProvider
  ) => void
  setLastSessionId: (
    workspaceId: string,
    agentId: string,
    sessionId: string,
    provider: ConversationProvider
  ) => void
}

export const createAgentSessionStore = (db: Database): AgentSessionStore => {
  const bindings = new Map<string, AgentSessionBinding>()

  for (const row of db
    .prepare(
      'SELECT agent_id, workspace_id, provider, last_session_id, saved_at FROM agent_sessions ORDER BY updated_at ASC'
    )
    .all() as AgentSessionRow[]) {
    bindings.set(`${row.workspace_id}:${row.agent_id}`, {
      provider: row.provider,
      savedAt: row.saved_at,
      sessionId: row.last_session_id,
    })
  }

  const writeBindingRows = (
    workspaceId: string,
    agentId: string,
    sessionId: string,
    provider: ConversationProvider,
    savedAt: number | null,
    updatedAt: number
  ) => {
    const workerExists = Boolean(
      db
        .prepare('SELECT 1 FROM workers WHERE workspace_id = ? AND id = ?')
        .get(workspaceId, agentId)
    )
    const isOrchestrator = agentId === `${workspaceId}:orchestrator`
    const workspaceExists =
      isOrchestrator &&
      Boolean(db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(workspaceId))
    if (!workerExists && !workspaceExists) {
      return false
    }
    db.prepare(
      `INSERT INTO agent_sessions (agent_id, workspace_id, provider, last_session_id, saved_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, agent_id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           provider = excluded.provider,
           last_session_id = excluded.last_session_id,
           saved_at = excluded.saved_at,
           updated_at = excluded.updated_at`
    ).run(agentId, workspaceId, provider, sessionId, savedAt, updatedAt)
    if (workerExists) {
      db.prepare('UPDATE workers SET last_session_id = ? WHERE id = ? AND workspace_id = ?').run(
        sessionId,
        agentId,
        workspaceId
      )
    }
    return true
  }

  const writeBinding = (
    workspaceId: string,
    agentId: string,
    sessionId: string,
    savedAt: number | null,
    provider: ConversationProvider
  ) => {
    const key = `${workspaceId}:${agentId}`
    const updatedAt = Date.now()
    const written = db.transaction(() =>
      writeBindingRows(workspaceId, agentId, sessionId, provider, savedAt, updatedAt)
    )()
    if (!written) {
      bindings.delete(key)
      return
    }
    bindings.set(key, { provider, savedAt, sessionId })
  }

  const mapSaveIntent = (row: AgentSessionSaveIntentRow): AgentSessionSaveIntent => ({
    captureSource: row.capture_source,
    failureReason: row.failure_reason,
    previousSessionId: row.previous_session_id,
    provider: row.provider,
    requestedAt: row.requested_at,
    requestId: row.request_id,
    runId: row.run_id,
    sessionId: row.session_id,
    state: row.state,
    updatedAt: row.updated_at,
  })

  const getSaveIntent = (workspaceId: string, agentId: string) => {
    const row = db
      .prepare(
        `SELECT request_id, run_id, provider, capture_source, state, previous_session_id,
                session_id, failure_reason, requested_at, updated_at
         FROM agent_session_save_intents
         WHERE workspace_id = ? AND agent_id = ?`
      )
      .get(workspaceId, agentId) as AgentSessionSaveIntentRow | undefined
    return row ? mapSaveIntent(row) : undefined
  }

  return {
    beginSaveIntent(input) {
      const existing = getSaveIntent(input.workspaceId, input.agentId)
      if (
        existing?.state === 'waiting' &&
        existing.runId === input.runId &&
        existing.provider === input.provider &&
        existing.captureSource === input.captureSource
      ) {
        return existing
      }
      const now = Date.now()
      const requestId = randomUUID()
      db.prepare(
        `INSERT INTO agent_session_save_intents
           (workspace_id, agent_id, request_id, run_id, provider, capture_source, state,
            previous_session_id, session_id, failure_reason, requested_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, NULL, NULL, ?, ?)
         ON CONFLICT(workspace_id, agent_id) DO UPDATE SET
           request_id = excluded.request_id,
           run_id = excluded.run_id,
           provider = excluded.provider,
           capture_source = excluded.capture_source,
           state = excluded.state,
           previous_session_id = excluded.previous_session_id,
           session_id = excluded.session_id,
           failure_reason = excluded.failure_reason,
           requested_at = excluded.requested_at,
           updated_at = excluded.updated_at`
      ).run(
        input.workspaceId,
        input.agentId,
        requestId,
        input.runId,
        input.provider,
        input.captureSource,
        input.previousSessionId,
        now,
        now
      )
      return getSaveIntent(input.workspaceId, input.agentId) as AgentSessionSaveIntent
    },
    clearLastSessionId(workspaceId, agentId) {
      db.transaction(() => {
        db.prepare('DELETE FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?').run(
          workspaceId,
          agentId
        )
        db.prepare(
          'UPDATE workers SET last_session_id = NULL WHERE id = ? AND workspace_id = ?'
        ).run(agentId, workspaceId)
      })()
      bindings.delete(`${workspaceId}:${agentId}`)
    },
    clearLastSessionIdIfMatches(workspaceId, agentId, expectedSessionId) {
      const cleared = db.transaction(() => {
        const result = db
          .prepare(
            'DELETE FROM agent_sessions WHERE workspace_id = ? AND agent_id = ? AND last_session_id = ?'
          )
          .run(workspaceId, agentId, expectedSessionId)
        if (result.changes === 0) return false

        db.prepare(
          'UPDATE workers SET last_session_id = NULL WHERE id = ? AND workspace_id = ? AND last_session_id = ?'
        ).run(agentId, workspaceId, expectedSessionId)
        return true
      })()

      const key = `${workspaceId}:${agentId}`
      if (cleared) {
        bindings.delete(key)
      } else {
        const row = db
          .prepare(
            'SELECT provider, last_session_id, saved_at FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?'
          )
          .get(workspaceId, agentId) as
          | Pick<AgentSessionRow, 'last_session_id' | 'provider' | 'saved_at'>
          | undefined
        if (row) {
          bindings.set(key, {
            provider: row.provider,
            savedAt: row.saved_at,
            sessionId: row.last_session_id,
          })
        } else bindings.delete(key)
      }
      return cleared
    },
    getLastSessionId(workspaceId, agentId) {
      return bindings.get(`${workspaceId}:${agentId}`)?.sessionId
    },
    getSessionBinding(workspaceId, agentId) {
      return bindings.get(`${workspaceId}:${agentId}`)
    },
    getSaveIntent,
    completeSaveIntent(workspaceId, agentId, runId, sessionId) {
      const now = Date.now()
      const completed = db.transaction(() => {
        const current = getSaveIntent(workspaceId, agentId)
        if (current?.state !== 'waiting' || current.runId !== runId) return false
        if (!writeBindingRows(workspaceId, agentId, sessionId, current.provider, now, now)) {
          return false
        }
        const result = db
          .prepare(
            `UPDATE agent_session_save_intents
             SET state = 'saved', session_id = ?, failure_reason = NULL, updated_at = ?
             WHERE workspace_id = ? AND agent_id = ? AND run_id = ? AND state = 'waiting'`
          )
          .run(sessionId, now, workspaceId, agentId, runId)
        return result.changes === 1
      })()
      if (!completed) return undefined
      const completedIntent = getSaveIntent(workspaceId, agentId)
      if (!completedIntent) {
        throw new Error(`Completed Session save intent not found: ${workspaceId}:${agentId}`)
      }
      bindings.set(`${workspaceId}:${agentId}`, {
        provider: completedIntent.provider,
        savedAt: now,
        sessionId,
      })
      return completedIntent
    },
    failPendingSaveIntent(workspaceId, agentId, runId, reason) {
      const result = db
        .prepare(
          `UPDATE agent_session_save_intents
           SET state = 'failed', failure_reason = ?, updated_at = ?
           WHERE workspace_id = ? AND agent_id = ? AND run_id = ? AND state = 'waiting'`
        )
        .run(reason, Date.now(), workspaceId, agentId, runId)
      return result.changes === 1 ? getSaveIntent(workspaceId, agentId) : undefined
    },
    failPendingSaveIntentsForRuntimeRestart() {
      return db
        .prepare(
          `UPDATE agent_session_save_intents
           SET state = 'failed', failure_reason = 'runtime_restarted', updated_at = ?
           WHERE state = 'waiting'`
        )
        .run(Date.now()).changes
    },
    saveLastSessionId(workspaceId, agentId, sessionId, provider) {
      writeBinding(workspaceId, agentId, sessionId, Date.now(), provider)
    },
    setLastSessionId(workspaceId, agentId, sessionId, provider) {
      const previous = bindings.get(`${workspaceId}:${agentId}`)
      writeBinding(
        workspaceId,
        agentId,
        sessionId,
        previous?.sessionId === sessionId ? previous.savedAt : null,
        provider
      )
    },
  }
}
