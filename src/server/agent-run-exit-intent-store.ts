import type { Database } from 'better-sqlite3'

import type { PersistAgentRunExitInput } from './agent-run-start-context.js'

interface AgentRunExitIntentRow {
  agent_id: string
  ended_at: number
  exit_code: number | null
  process_state: PersistAgentRunExitInput['processState']
  run_id: string
  status: PersistAgentRunExitInput['status']
  workspace_id: string
}

export class AgentRunExitIntentStageError extends Error {
  constructor(cause: unknown) {
    super('Failed to stage Agent run exit intent', { cause })
    this.name = 'AgentRunExitIntentStageError'
  }
}

const toInput = (row: AgentRunExitIntentRow): PersistAgentRunExitInput => ({
  agentId: row.agent_id,
  endedAt: row.ended_at,
  exitCode: row.exit_code,
  processState: row.process_state,
  runId: row.run_id,
  status: row.status,
  workspaceId: row.workspace_id,
})

export const createAgentRunExitIntentStore = (db: Database) => ({
  delete(runId: string) {
    db.prepare('DELETE FROM agent_run_exit_intents WHERE run_id = ?').run(runId)
  },
  list(workspaceId?: string, agentId?: string) {
    const clauses: string[] = []
    const values: string[] = []
    if (workspaceId) {
      clauses.push('workspace_id = ?')
      values.push(workspaceId)
    }
    if (agentId) {
      clauses.push('agent_id = ?')
      values.push(agentId)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    return (
      db
        .prepare(
          `SELECT run_id, workspace_id, agent_id, status, process_state, exit_code, ended_at
           FROM agent_run_exit_intents ${where}
           ORDER BY ended_at ASC, run_id ASC`
        )
        .all(...values) as AgentRunExitIntentRow[]
    ).map(toInput)
  },
  stage(input: PersistAgentRunExitInput) {
    const now = Date.now()
    db.prepare(
      `INSERT INTO agent_run_exit_intents (
         run_id, workspace_id, agent_id, status, process_state, exit_code,
         ended_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         agent_id = excluded.agent_id,
         status = excluded.status,
         process_state = excluded.process_state,
         exit_code = excluded.exit_code,
         ended_at = excluded.ended_at,
         updated_at = excluded.updated_at`
    ).run(
      input.runId,
      input.workspaceId,
      input.agentId,
      input.status,
      input.processState,
      input.exitCode,
      input.endedAt,
      now,
      now
    )
  },
})
