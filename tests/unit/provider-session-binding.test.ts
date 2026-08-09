import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { createAgentSessionStore } from '../../src/server/agent-session-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

describe('Provider Session binding', () => {
  test('persists Agent, Provider, and Provider Session identity before exposing it in memory', () => {
    const database = new Database(':memory:')
    initializeRuntimeDatabase(database)
    database
      .prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)')
      .run('workspace-1', 'Workspace', 'C:/workspace', 1)
    database
      .prepare('INSERT INTO workers (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)')
      .run('agent-1', 'workspace-1', 'Alice', 1)

    const store = createAgentSessionStore(database)
    store.saveLastSessionId('workspace-1', 'agent-1', 'session-1', 'codex')

    expect(store.getSessionBinding('workspace-1', 'agent-1')).toEqual({
      provider: 'codex',
      savedAt: expect.any(Number),
      sessionId: 'session-1',
    })
    expect(
      database
        .prepare(
          'SELECT provider, last_session_id FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?'
        )
        .get('workspace-1', 'agent-1')
    ).toEqual({ provider: 'codex', last_session_id: 'session-1' })

    const rehydrated = createAgentSessionStore(database)
    expect(rehydrated.getSessionBinding('workspace-1', 'agent-1')).toMatchObject({
      provider: 'codex',
      sessionId: 'session-1',
    })
    database.close()
  })
})
