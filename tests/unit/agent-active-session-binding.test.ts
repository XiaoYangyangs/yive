import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import type {
  AgentManager,
  AgentRunSnapshot,
  StartAgentInput,
} from '../../src/server/agent-manager.js'
import { createAgentRuntime } from '../../src/server/agent-runtime.js'
import {
  type AgentSessionStore,
  createAgentSessionStore,
} from '../../src/server/agent-session-store.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { buildYiveAgentNameContractLine } from '../../src/server/yive-startup-contract.js'

const outputBus = {
  clear: () => {},
  publish: () => {},
  subscribe: () => () => {},
}

const tempDirs: string[] = []

afterEach(() => {
  delete process.env.CODEX_HOME
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const waitFor = async (assertion: () => void, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw lastError
}

describe('active agent session binding', () => {
  test('keeps a resume id provisional until the Provider verifies this run', async () => {
    const dataDir = join(tmpdir(), `yive-provisional-session-${crypto.randomUUID()}`)
    const workspacePath = join(dataDir, 'workspace')
    const codexHome = join(dataDir, '.codex')
    tempDirs.push(dataDir)
    mkdirSync(workspacePath, { recursive: true })
    process.env.CODEX_HOME = codexHome

    const workspace = { id: 'workspace-1', name: 'Workspace', path: workspacePath }
    const agent = {
      id: `${workspace.id}:orchestrator`,
      name: 'Orchestrator',
      pendingTaskCount: 0,
      kind: 'orchestrator' as const,
      status: 'working' as const,
      workspaceId: workspace.id,
    }
    const resumedSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const actualSessionId = resumedSessionId
    const sessionsDir = join(codexHome, 'sessions', '2026', '07', '21')
    const nativeIdentity = buildYiveAgentNameContractLine(agent)
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(
      join(sessionsDir, `rollout-${resumedSessionId}.jsonl`),
      `${JSON.stringify({ payload: { cwd: workspacePath, id: resumedSessionId }, type: 'session_meta' })}\n${nativeIdentity}\n`
    )
    const actualSessionPath = join(sessionsDir, `rollout-${actualSessionId}.jsonl`)
    writeFileSync(
      actualSessionPath,
      `${JSON.stringify({ payload: { cwd: workspacePath, id: actualSessionId }, type: 'session_meta' })}\n${nativeIdentity}\n`
    )

    const database = new Database(':memory:')
    initializeRuntimeDatabase(database)
    database
      .prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)')
      .run(workspace.id, workspace.name, workspace.path, Date.now())
    const sessionStore = createAgentSessionStore(database)
    sessionStore.saveLastSessionId(workspace.id, agent.id, resumedSessionId, 'codex')

    const snapshot: AgentRunSnapshot = {
      agentId: agent.id,
      exitCode: null,
      output: '',
      pid: 1,
      runId: 'run-provisional',
      status: 'running',
    }
    const agentManager: AgentManager = {
      getOutputBus: () => outputBus,
      getRun: () => snapshot,
      pauseRun: () => {},
      removeRun: () => {},
      resizeRun: () => {},
      resumeRun: () => {},
      startAgent: async () => ({ ...snapshot, status: 'starting' }),
      stopRun: () => {},
      writeInput: () => {},
    }
    const runtime = createAgentRuntime(
      agentManager,
      {
        deleteLaunchConfig: () => {},
        insertAgentRun: () => {},
        listAgentRuns: () => [],
        listLaunchConfigs: () => [],
        markUnfinishedRunsStale: () => {},
        saveLaunchConfig: () => {},
        updatePersistedRun: () => {},
      },
      sessionStore,
      () => {},
      undefined,
      () => agent
    )
    runtime.configureAgentLaunch(workspace.id, agent.id, buildManagedProviderLaunchConfig('codex'))

    const run = await runtime.startAgent(workspace, agent.id, { hivePort: '4010' })
    const result = runtime.refreshAgentSessionBinding(workspace, agent.id)

    expect(run).toMatchObject({ resumedSessionId })
    expect(run.sessionId).toBeUndefined()
    expect(result).toMatchObject({
      previousSessionId: resumedSessionId,
      sessionId: null,
      state: 'waiting',
      unchanged: false,
    })
    expect(sessionStore.getSaveIntent(workspace.id, agent.id)).toMatchObject({
      runId: run.runId,
      state: 'waiting',
    })

    appendFileSync(
      actualSessionPath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
    )
    await waitFor(() => {
      expect(runtime.getLiveRun(run.runId).sessionId).toBe(actualSessionId)
      expect(sessionStore.getSaveIntent(workspace.id, agent.id)).toMatchObject({
        sessionId: actualSessionId,
        state: 'saved',
      })
      expect(sessionStore.getSessionBinding(workspace.id, agent.id)).toMatchObject({
        sessionId: actualSessionId,
      })
    })

    const switchedSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const switchedSessionPath = join(sessionsDir, `rollout-${switchedSessionId}.jsonl`)
    writeFileSync(
      switchedSessionPath,
      `${JSON.stringify({ payload: { cwd: workspacePath, id: switchedSessionId }, type: 'session_meta' })}\n${nativeIdentity}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
    )
    await waitFor(() => {
      expect(runtime.getLiveRun(run.runId).sessionId).toBe(switchedSessionId)
    })
    expect(sessionStore.getSessionBinding(workspace.id, agent.id)).toMatchObject({
      savedAt: expect.any(Number),
      sessionId: actualSessionId,
    })

    await runtime.close()
    database.close()
  })

  test('saves the session captured for the current PTY when another matching file is newer', async () => {
    const dataDir = join(tmpdir(), `yive-active-session-${crypto.randomUUID()}`)
    const workspacePath = join(dataDir, 'workspace')
    const codexHome = join(dataDir, '.codex')
    tempDirs.push(dataDir)
    mkdirSync(workspacePath, { recursive: true })
    process.env.CODEX_HOME = codexHome

    const workspace = { id: 'workspace-1', name: 'Workspace', path: workspacePath }
    const agent = {
      id: `${workspace.id}:orchestrator`,
      name: 'Orchestrator',
      pendingTaskCount: 0,
      kind: 'orchestrator' as const,
      status: 'working' as const,
      workspaceId: workspace.id,
    }
    const activeSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const wrongNewerSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const sessionsDir = join(codexHome, 'sessions', '2026', '07', '21')
    const nativeIdentity = buildYiveAgentNameContractLine(agent)
    const writeSession = (sessionId: string, completed = false) => {
      mkdirSync(sessionsDir, { recursive: true })
      const filePath = join(sessionsDir, `rollout-${sessionId}.jsonl`)
      writeFileSync(
        filePath,
        `${JSON.stringify({ payload: { cwd: workspacePath, id: sessionId }, type: 'session_meta' })}\n${nativeIdentity}\n${completed ? `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n` : ''}`
      )
      return filePath
    }

    let storedSessionId: string | undefined
    const sessionStore: AgentSessionStore = {
      beginSaveIntent: () => {
        throw new Error('not used')
      },
      clearLastSessionId: () => {
        storedSessionId = undefined
      },
      clearLastSessionIdIfMatches: (_workspaceId, _agentId, expectedSessionId) => {
        if (storedSessionId !== expectedSessionId) return false
        storedSessionId = undefined
        return true
      },
      getLastSessionId: () => storedSessionId,
      getSessionBinding: () =>
        storedSessionId ? { savedAt: null, sessionId: storedSessionId } : undefined,
      getSaveIntent: () => undefined,
      completeSaveIntent: () => undefined,
      failPendingSaveIntent: () => undefined,
      failPendingSaveIntentsForRuntimeRestart: () => 0,
      saveLastSessionId: (_workspaceId, _agentId, sessionId) => {
        storedSessionId = sessionId
      },
      setLastSessionId: (_workspaceId, _agentId, sessionId) => {
        storedSessionId = sessionId
      },
    }

    let startInput: StartAgentInput | undefined
    const terminalWrites: string[] = []
    let snapshot: AgentRunSnapshot = {
      agentId: agent.id,
      exitCode: null,
      output: '',
      pid: 1,
      runId: 'run-1',
      status: 'running',
    }
    const agentManager: AgentManager = {
      getOutputBus: () => outputBus,
      getRun: () => snapshot,
      pauseRun: () => {},
      removeRun: () => {},
      resizeRun: () => {},
      resumeRun: () => {},
      startAgent: async (input) => {
        startInput = input
        writeSession(activeSessionId, true)
        return { ...snapshot, status: 'starting' }
      },
      stopRun: () => {
        snapshot = { ...snapshot, exitCode: 0, status: 'exited' }
        startInput?.onExit?.({ exitCode: 0, runId: snapshot.runId })
      },
      writeInput: (_runId, text) => terminalWrites.push(text),
    }
    const runtime = createAgentRuntime(
      agentManager,
      {
        deleteLaunchConfig: () => {},
        insertAgentRun: () => {},
        listAgentRuns: () => [],
        listLaunchConfigs: () => [],
        markUnfinishedRunsStale: () => {},
        saveLaunchConfig: () => {},
        updatePersistedRun: () => {},
      },
      sessionStore,
      () => {}
    )

    runtime.configureAgentLaunch(workspace.id, agent.id, buildManagedProviderLaunchConfig('codex'))
    const run = await runtime.startAgent(workspace, agent.id, { hivePort: '4010' })
    await waitFor(() => {
      expect(runtime.getLiveRun(run.runId).sessionId).toBe(activeSessionId)
    })

    const wrongFile = writeSession(wrongNewerSessionId)
    const future = new Date(Date.now() + 1000)
    utimesSync(wrongFile, future, future)

    const result = runtime.refreshAgentSessionBinding(workspace, agent.id)

    expect(result.sessionId).toBe(activeSessionId)
    expect(storedSessionId).toBe(activeSessionId)
    expect(terminalWrites).toEqual([])
    await runtime.close()
  })
})
