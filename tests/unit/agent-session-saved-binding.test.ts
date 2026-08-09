import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createAgentSessionStore } from '../../src/server/agent-session-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const databases: Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

const createStore = () => {
  const database = new Database(':memory:')
  databases.push(database)
  initializeRuntimeDatabase(database)
  database
    .prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)')
    .run('workspace-1', 'Workspace', '/workspace', Date.now())
  database
    .prepare('INSERT INTO workers (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run('agent-1', 'workspace-1', 'Agent', Date.now())
  return createAgentSessionStore(database)
}

const seedAgent = (database: Database) => {
  database
    .prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)')
    .run('workspace-1', 'Workspace', '/workspace', Date.now())
  database
    .prepare('INSERT INTO workers (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run('agent-1', 'workspace-1', 'Agent', Date.now())
}

describe('saved CLI session binding', () => {
  test('automatic capture does not claim that the user saved the conversation', () => {
    const store = createStore()

    store.setLastSessionId('workspace-1', 'agent-1', 'session-1', 'codex')

    expect(store.getSessionBinding('workspace-1', 'agent-1')).toEqual({
      provider: 'codex',
      savedAt: null,
      sessionId: 'session-1',
    })
  })

  test('saving survives later captures of the same session but not a session change', () => {
    const store = createStore()

    store.saveLastSessionId('workspace-1', 'agent-1', 'session-1', 'codex')
    const saved = store.getSessionBinding('workspace-1', 'agent-1')
    expect(saved?.savedAt).toEqual(expect.any(Number))

    store.setLastSessionId('workspace-1', 'agent-1', 'session-1', 'codex')
    expect(store.getSessionBinding('workspace-1', 'agent-1')).toEqual(saved)

    store.setLastSessionId('workspace-1', 'agent-1', 'session-2', 'codex')
    expect(store.getSessionBinding('workspace-1', 'agent-1')).toEqual({
      provider: 'codex',
      savedAt: null,
      sessionId: 'session-2',
    })
  })

  test('persists one waiting save intent per run and prevents a later run from completing it', () => {
    const database = new Database(':memory:')
    databases.push(database)
    initializeRuntimeDatabase(database)
    seedAgent(database)
    const firstStore = createAgentSessionStore(database)

    const first = firstStore.beginSaveIntent({
      agentId: 'agent-1',
      captureSource: 'codex_session_jsonl_dir',
      previousSessionId: 'session-old',
      provider: 'codex',
      runId: 'run-1',
      workspaceId: 'workspace-1',
    })
    const retry = firstStore.beginSaveIntent({
      agentId: 'agent-1',
      captureSource: 'codex_session_jsonl_dir',
      previousSessionId: 'session-old',
      provider: 'codex',
      runId: 'run-1',
      workspaceId: 'workspace-1',
    })

    expect(retry).toEqual(first)
    expect(first).toMatchObject({
      previousSessionId: 'session-old',
      runId: 'run-1',
      sessionId: null,
      state: 'waiting',
    })

    firstStore.failPendingSaveIntentsForRuntimeRestart()
    const restartedStore = createAgentSessionStore(database)
    expect(restartedStore.getSaveIntent('workspace-1', 'agent-1')).toMatchObject({
      failureReason: 'runtime_restarted',
      requestId: first.requestId,
      state: 'failed',
    })
    expect(
      restartedStore.completeSaveIntent('workspace-1', 'agent-1', 'run-2', 'session-new')
    ).toBeUndefined()
    expect(restartedStore.getSessionBinding('workspace-1', 'agent-1')).toBeUndefined()
  })
})
