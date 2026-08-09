import { afterEach, describe, expect, test } from 'vitest'

import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createLegacyAgentIdentityV52Database } from '../fixtures/legacy-agent-identity-v52.js'

const databases: Array<ReturnType<typeof createLegacyAgentIdentityV52Database>> = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

const listTables = (db: ReturnType<typeof createLegacyAgentIdentityV52Database>) =>
  new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string
      }>
    ).map((row) => row.name)
  )

describe('flat agent identity migration', () => {
  test('removes specialist Role storage from a v52 database', () => {
    const db = createLegacyAgentIdentityV52Database()
    databases.push(db)

    initializeRuntimeDatabase(db)

    const schemaVersion = db
      .prepare('SELECT MAX(version) AS version FROM schema_version')
      .get() as { version: number }
    expect(schemaVersion.version).toBeGreaterThan(52)

    const tables = listTables(db)
    expect(tables.has('role_templates')).toBe(false)
    expect(tables.has('dismissed_conversations')).toBe(true)

    const agentTable = tables.has('agents') ? 'agents' : 'workers'
    const agentColumns = new Set(
      (db.prepare(`PRAGMA table_info(${agentTable})`).all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    expect(agentColumns.has('role')).toBe(false)
    expect(agentColumns.has('description')).toBe(false)

    const agents = db.prepare(`SELECT id, name FROM ${agentTable} ORDER BY id`).all() as Array<{
      id: string
      name: string
    }>
    expect(agents).toEqual([
      { id: 'worker-coder', name: 'Builder' },
      { id: 'worker-tester', name: 'Verifier' },
    ])

    const workspaceColumns = new Set(
      (db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    expect(workspaceColumns.has('orchestrator_name')).toBe(true)
    expect(
      db.prepare('SELECT orchestrator_name FROM workspaces WHERE id = ?').get('ws-identity')
    ).toEqual({ orchestrator_name: 'Orchestrator' })
  })

  test('preserves launch, Session, Dispatch, conversation, and message records', () => {
    const db = createLegacyAgentIdentityV52Database()
    databases.push(db)

    initializeRuntimeDatabase(db)

    expect(
      db
        .prepare(
          'SELECT provider FROM agent_launch_configs WHERE workspace_id = ? AND agent_id = ?'
        )
        .get('ws-identity', 'worker-coder')
    ).toEqual({ provider: 'codex' })
    expect(
      (db.prepare('PRAGMA table_info(agent_launch_configs)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    ).toEqual(['workspace_id', 'agent_id', 'provider', 'created_at', 'updated_at'])
    expect(db.prepare('SELECT run_id, agent_id, status, pid FROM agent_runs').all()).toEqual([
      { agent_id: 'worker-coder', pid: 4242, run_id: 'run-coder', status: 'running' },
    ])
    expect(db.prepare('SELECT * FROM agent_sessions').all()).toEqual([
      {
        agent_id: 'worker-coder',
        last_session_id: 'session-coder',
        provider: 'codex',
        saved_at: 107,
        updated_at: 108,
        workspace_id: 'ws-identity',
      },
    ])
    expect(
      db
        .prepare(
          'SELECT id, text, status, report_text, artifacts FROM dispatches ORDER BY sequence'
        )
        .all()
    ).toEqual([
      {
        artifacts: '["result.md"]',
        id: 'dispatch-1',
        report_text: 'Preserved report',
        status: 'reported',
        text: 'Preserve this dispatch',
      },
    ])
    expect(db.prepare('SELECT id, text, delivery_state FROM dispatch_notes').all()).toEqual([
      { delivery_state: 'delivered', id: 'note-1', text: 'Preserved note' },
    ])
    expect(
      db.prepare('SELECT id, cli_session_id, provider FROM agent_conversations').all()
    ).toEqual([{ cli_session_id: 'session-coder', id: 'conversation-coder', provider: 'codex' }])
    expect(db.prepare('SELECT provider_event_id, text FROM conversation_turns').all()).toEqual([
      { provider_event_id: 'turn-1', text: 'Preserved reply' },
    ])
    expect(
      db.prepare('SELECT provider_event_id, label, status FROM conversation_tool_activity').all()
    ).toEqual([{ label: 'exec', provider_event_id: 'tool-1', status: 'completed' }])
    expect(db.prepare('SELECT type, text FROM messages').all()).toEqual([
      { text: 'Preserved status history', type: 'status' },
    ])
  })
})
