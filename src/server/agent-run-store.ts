import type { Database } from 'better-sqlite3'

import {
  buildManagedProviderLaunchConfig,
  isManagedProvider,
  type ManagedProvider,
} from './managed-provider.js'
import type { SessionIdCaptureConfig } from './session-capture.js'

export interface AgentLaunchConfigInput {
  command: string
  args?: string[]
  interactiveCommand?: string | null
  provider: ManagedProvider
  resumedSessionId?: string | null
  resumeArgsTemplate?: string | null
  sessionIdCapture?: SessionIdCaptureConfig | null
}

export interface PersistedAgentRun {
  runId: string
  agentId: string
  status: 'starting' | 'running' | 'exited' | 'error'
  exitCode: number | null
  pid: number | null
  processState: 'crashed' | 'running' | 'stopped'
  startedAt: number
  endedAt: number | null
}

interface LaunchConfigRow {
  workspace_id: string
  agent_id: string
  provider: ManagedProvider
}

interface AgentRunRow {
  run_id: string
  agent_id: string
  pid: number | null
  process_state: PersistedAgentRun['processState']
  status: 'starting' | 'running' | 'exited' | 'error'
  exit_code: number | null
  started_at: number
  ended_at: number | null
}

export const createAgentRunStore = (db: Database) => {
  let closed = false

  const close = () => {
    closed = true
  }

  const listLaunchConfigs = () => {
    if (closed) {
      return []
    }

    return db
      .prepare(
        `SELECT workspace_id, agent_id, provider
         FROM agent_launch_configs ORDER BY updated_at ASC`
      )
      .all()
      .map((row: unknown) => {
        const typedRow = row as LaunchConfigRow
        return {
          agentId: typedRow.agent_id,
          config: buildManagedProviderLaunchConfig(typedRow.provider),
          workspaceId: typedRow.workspace_id,
        }
      })
  }

  const saveLaunchConfig = (
    workspaceId: string,
    agentId: string,
    input: AgentLaunchConfigInput
  ) => {
    if (closed) {
      return
    }
    const provider = input.provider
    if (!isManagedProvider(provider)) {
      throw new TypeError(`Unsupported managed Agent Provider: ${String(provider)}`)
    }
    const createdAt = Date.now()
    db.prepare(
      `INSERT INTO agent_launch_configs (
         workspace_id,
         agent_id,
         provider,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, agent_id) DO UPDATE SET
          provider = excluded.provider,
          updated_at = excluded.updated_at`
    ).run(workspaceId, agentId, provider, createdAt, createdAt)
  }

  const deleteLaunchConfig = (workspaceId: string, agentId: string) => {
    if (closed) {
      return
    }
    db.prepare('DELETE FROM agent_launch_configs WHERE workspace_id = ? AND agent_id = ?').run(
      workspaceId,
      agentId
    )
  }

  const insertAgentRun = (
    runId: string,
    agentId: string,
    startedAt: number,
    pid: number | null,
    status: PersistedAgentRun['status'] = 'starting',
    exitCode: number | null = null,
    endedAt: number | null = null
  ) => {
    if (closed) {
      return
    }
    db.prepare(
      `INSERT INTO agent_runs (
         run_id, agent_id, pid, status, process_state, exit_code,
         started_at, ended_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runId,
      agentId,
      pid,
      status,
      status === 'exited' ? 'stopped' : status === 'error' ? 'crashed' : 'running',
      exitCode,
      startedAt,
      endedAt,
      startedAt,
      startedAt
    )
  }

  const updatePersistedRun = (
    runId: string,
    status: PersistedAgentRun['status'],
    exitCode: number | null,
    endedAt: number | null,
    processState: PersistedAgentRun['processState']
  ) => {
    if (closed) {
      return
    }
    db.prepare(
      `UPDATE agent_runs
       SET status = ?, process_state = ?, exit_code = ?, ended_at = ?, updated_at = ?
       WHERE run_id = ?`
    ).run(status, processState, exitCode, endedAt, Date.now(), runId)
  }

  const listAgentRuns = (agentId: string) => {
    if (closed) {
      return []
    }

    return db
      .prepare(
        `SELECT run_id, agent_id, pid, status, process_state, exit_code, started_at, ended_at
         FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC`
      )
      .all(agentId)
      .map((row: unknown) => {
        const typedRow = row as AgentRunRow
        return {
          runId: typedRow.run_id,
          agentId: typedRow.agent_id,
          pid: typedRow.pid,
          processState: typedRow.process_state,
          status: typedRow.status,
          exitCode: typedRow.exit_code,
          startedAt: typedRow.started_at,
          endedAt: typedRow.ended_at,
        }
      }) satisfies PersistedAgentRun[]
  }

  const markUnfinishedRunsStale = (endedAt = Date.now(), excludedRunIds: string[] = []) => {
    if (closed) {
      return
    }
    const placeholders = excludedRunIds.map(() => '?').join(', ')
    const exclusion = excludedRunIds.length > 0 ? `AND run_id NOT IN (${placeholders})` : ''
    db.prepare(
      `UPDATE agent_runs
       SET status = 'error', process_state = 'crashed', exit_code = NULL,
           ended_at = ?, updated_at = ?
       WHERE status IN ('starting', 'running') ${exclusion}`
    ).run(endedAt, endedAt, ...excludedRunIds)
  }

  return {
    close,
    insertAgentRun,
    deleteLaunchConfig,
    listAgentRuns,
    listLaunchConfigs,
    markUnfinishedRunsStale,
    saveLaunchConfig,
    updatePersistedRun,
  }
}
