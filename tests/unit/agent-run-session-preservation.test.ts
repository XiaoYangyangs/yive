import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { handleAgentRunExit } from '../../src/server/agent-run-exit-handler.js'
import type { AgentRunExitContext } from '../../src/server/agent-run-start-context.js'
import { createAgentSessionStore } from '../../src/server/agent-session-store.js'
import { createAgentTokenRegistry } from '../../src/server/agent-tokens.js'
import { createLiveRunRegistry } from '../../src/server/live-run-registry.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const workspace = { id: 'ws-1', name: 'Alpha', path: '/tmp/alpha' }
const agentId = 'agent-1'
const launchedSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const savedSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const createScenario = (currentSessionId: string, stopping = false) => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
    workspace.id,
    workspace.name,
    workspace.path,
    Date.now()
  )
  db.prepare(
    'INSERT INTO workers (id, workspace_id, name, last_session_id, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(agentId, workspace.id, 'Alice', currentSessionId, Date.now())
  db.prepare(
    'INSERT INTO agent_sessions (agent_id, workspace_id, provider, last_session_id, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(agentId, workspace.id, 'codex', currentSessionId, Date.now())

  const sessionStore = createAgentSessionStore(db)
  const registry = createLiveRunRegistry()
  const tokenRegistry = createAgentTokenRegistry()
  const token = tokenRegistry.issue(agentId)
  const runId = 'run-1'
  registry.add({
    agentId,
    exitCode: null,
    output: '',
    pid: 1,
    runId,
    startedAt: Date.now(),
    status: 'running',
    stopping,
  })

  const context: AgentRunExitContext = {
    agentId,
    handledRunExits: new Set(),
    onAgentExit: () => {},
    registry,
    sessionStore,
    startConfig: { resumedSessionId: launchedSessionId },
    store: {
      insertAgentRun: () => {},
      updatePersistedRun: () => {},
    },
    token,
    tokenRegistry,
    workspace,
  }

  return { context, db, runId, sessionStore }
}

const exitRun = (context: AgentRunExitContext, runId: string, exitCode: number | null) => {
  handleAgentRunExit(context, { endedAt: Date.now(), exitCode, runId })
}

describe('agent run session preservation', () => {
  test('keeps a newly saved session when an older resumed run is intentionally stopped', () => {
    const scenario = createScenario(savedSessionId, true)
    try {
      exitRun(scenario.context, scenario.runId, null)

      expect(scenario.sessionStore.getLastSessionId(workspace.id, agentId)).toBe(savedSessionId)
    } finally {
      scenario.db.close()
    }
  })

  test('keeps a resumed session when an unexpected exit has no exit code', () => {
    const scenario = createScenario(launchedSessionId)
    try {
      exitRun(scenario.context, scenario.runId, null)

      expect(scenario.sessionStore.getLastSessionId(workspace.id, agentId)).toBe(launchedSessionId)
    } finally {
      scenario.db.close()
    }
  })

  test('clears the resumed session after a proven non-zero resume failure', () => {
    const scenario = createScenario(launchedSessionId)
    try {
      exitRun(scenario.context, scenario.runId, 1)

      expect(scenario.sessionStore.getLastSessionId(workspace.id, agentId)).toBeUndefined()
    } finally {
      scenario.db.close()
    }
  })

  test('does not let an older failed run clear a newly saved session', () => {
    const scenario = createScenario(savedSessionId)
    try {
      exitRun(scenario.context, scenario.runId, 1)

      expect(scenario.sessionStore.getLastSessionId(workspace.id, agentId)).toBe(savedSessionId)
    } finally {
      scenario.db.close()
    }
  })
})
