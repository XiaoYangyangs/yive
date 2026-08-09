import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { AgentManager, AgentRunSnapshot } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'

const tempDirs: string[] = []
const outputBus = {
  clear: () => {},
  publish: () => {},
  subscribe: () => () => {},
}

const createFakeAgentManager = (): AgentManager => {
  const runs = new Map<string, AgentRunSnapshot>()
  const onExitByRunId = new Map<
    string,
    NonNullable<Parameters<AgentManager['startAgent']>[0]['onExit']>
  >()

  return {
    getOutputBus() {
      return outputBus
    },
    pauseRun() {},
    resizeRun() {},
    resumeRun() {},
    getRun(runId) {
      const run = runs.get(runId)
      if (!run) {
        throw new Error(`Run not found: ${runId}`)
      }
      return run
    },
    removeRun(runId) {
      runs.delete(runId)
    },
    async startAgent(input) {
      const run = {
        agentId: input.agentId,
        exitCode: null,
        output: '',
        pid: 1,
        runId: `run-${input.agentId}`,
        status: 'starting' as const,
      }
      runs.set(run.runId, run)
      if (input.onExit) onExitByRunId.set(run.runId, input.onExit)
      return run
    },
    stopRun(runId) {
      const run = runs.get(runId)
      if (!run || run.status === 'exited' || run.status === 'error') return
      run.status = 'exited'
      run.exitCode = 0
      onExitByRunId.get(runId)?.({ exitCode: 0, runId })
    },
    writeInput() {},
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('runtime store', () => {
  test('can create workspace', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')

    expect(workspace).toMatchObject({
      name: 'Alpha',
      path: '/tmp/hive-alpha',
    })
  })

  test('createWorkspace does not mutate memory when DB insert fails', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-create-workspace-db-fail-'))
    tempDirs.push(dataDir)
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    initializeRuntimeDatabase(db)
    const workspaceStore = createWorkspaceStore(db, [])
    const originalPrepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((source: string) => {
      if (source.startsWith('INSERT INTO workspaces')) {
        throw new Error('insert workspace failed')
      }
      return originalPrepare(source)
    })

    expect(() => workspaceStore.createWorkspace('/tmp/hive-alpha', 'Alpha')).toThrow(
      /insert workspace failed/
    )
    expect(workspaceStore.listWorkspaces()).toEqual([])

    db.close()
  })

  test('each workspace automatically has one orchestrator', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const snapshot = store.getWorkspaceSnapshot(workspace.id)

    expect(snapshot.agents).toHaveLength(1)
    expect(snapshot.agents[0]).toMatchObject({
      name: 'Orchestrator',
      kind: 'orchestrator',
    })
    expect(store.getAgentState(workspace.id, snapshot.agents[0]?.id ?? '')).toMatchObject({
      activeDispatchId: null,
      conversationActivity: 'unknown',
      processState: 'stopped',
      queuedDispatchCount: 0,
    })
  })

  test('can add worker', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
    })

    expect(worker).toMatchObject({
      workspaceId: workspace.id,
      kind: 'worker',
      name: 'Alice',
    })
    expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: null,
      conversationActivity: 'unknown',
      processState: 'stopped',
      queuedDispatchCount: 0,
    })
  })

  test('dispatchTask records queued responsibility without inventing conversation activity', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
    })
    // Simulate PTY started: worker is idle, not stopped (spec §3.6.4 keeps
    // stopped workers from being silently promoted to working when their
    // PTY isn't actually running).
    store.dispatchTask(workspace.id, worker.id, 'Implement feature')

    expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: null,
      conversationActivity: 'unknown',
      processState: 'stopped',
      queuedDispatchCount: 1,
    })
  })

  test('dispatchTask keeps process state stopped while accumulating a queue', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
    })
    // worker.addWorker initialises status='stopped' (PTY hasn't started).

    store.dispatchTask(workspace.id, worker.id, 'Implement feature')

    expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
      processState: 'stopped',
      queuedDispatchCount: 1,
    })
  })

  test('filters and orders Dispatch history for bounded Worker Context queries', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const alice = store.addWorker(workspace.id, { name: 'Alice' })
    const bob = store.addWorker(workspace.id, { name: 'Bob' })

    const first = await store.dispatchTask(workspace.id, alice.id, 'Alice first')
    const second = await store.dispatchTask(workspace.id, alice.id, 'Alice second')
    await store.dispatchTask(workspace.id, bob.id, 'Bob only')

    expect(
      store.listDispatches(workspace.id, {
        limit: 1,
        order: 'desc',
        status: 'queued',
        toAgentId: alice.id,
      })
    ).toEqual([expect.objectContaining({ id: second.id, text: 'Alice second' })])
    expect(first.id).not.toBe(second.id)
  })

  test('startAgent moves process state to running without claiming verified idle', async () => {
    const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
    })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: '/bin/bash',
      args: [],
      provider: 'codex',
    })

    await store.startAgent(workspace.id, worker.id, {
      hivePort: '4010',
      suppressStartupInstructions: true,
    })

    expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
      conversationActivity: 'unknown',
      processState: 'running',
    })
  })

  test('startAgent keeps queued responsibility independent from Provider activity', async () => {
    const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
    })
    // Worker was running, took a dispatch (pendingTaskCount=1, status='working'),
    // then user hit [Restart]. A fresh PTY hasn't done any work yet — the next
    // team send is what should flip status back to 'working', not the leftover
    // queue depth.
    store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: '/bin/bash',
      args: [],
      provider: 'codex',
    })

    await store.startAgent(workspace.id, worker.id, {
      hivePort: '4010',
      suppressStartupInstructions: true,
    })

    const updatedState = store.getAgentState(workspace.id, worker.id)
    expect(updatedState).toMatchObject({
      activeDispatchId: null,
      conversationActivity: 'unknown',
      processState: 'running',
    })
    // pendingTaskCount stays so WorkerModal / recovery summary can still surface
    // the backlog — the status field just doesn't read from it anymore.
    expect(updatedState.queuedDispatchCount).toBe(1)
  })

  test('startAgent preserves queued responsibility across the restart path', async () => {
    const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
    })
    // Simulate the hydration end-state after a hive restart: worker status is
    // 'stopped' (PTY isn't running), but dispatch ledger replay left
    // pendingTaskCount > 0 because the previous session ended before the
    // worker reported back. User hits [Restart] -> startAgent -> must NOT
    // auto-promote to 'working'.
    store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
      processState: 'stopped',
      queuedDispatchCount: 1,
    })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: '/bin/bash',
      args: [],
      provider: 'codex',
    })

    await store.startAgent(workspace.id, worker.id, {
      hivePort: '4010',
      suppressStartupInstructions: true,
    })

    expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
      conversationActivity: 'unknown',
      processState: 'running',
      queuedDispatchCount: 1,
    })
  })

  test('reportTask rejects queued responsibility without changing process state', async () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
    })
    await store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    expect(() =>
      store.reportTask(workspace.id, worker.id, {
        requestId: 'queued-report-completed',
        text: 'Done',
      })
    ).toThrow('No open dispatch for worker: Alice')

    expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: null,
      processState: 'stopped',
      queuedDispatchCount: 1,
    })
  })

  test('failed report cannot close or pause queued responsibility', async () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
    })

    await store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    expect(() =>
      store.reportTask(workspace.id, worker.id, {
        outcome: 'failed',
        requestId: 'queued-report-failed',
        text: 'Blocked',
      })
    ).toThrow('No open dispatch for worker: Alice')

    expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
      processState: 'stopped',
      queuePauseReason: null,
      queuedDispatchCount: 1,
    })
  })

  test('stopWorker stops an active worker without deleting its launch config or record', async () => {
    const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
    })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: '/bin/bash',
      args: [],
      provider: 'codex',
    })
    await store.startAgent(workspace.id, worker.id, {
      hivePort: '4010',
      suppressStartupInstructions: true,
    })

    store.stopWorker(workspace.id, worker.id)

    expect(store.listWorkers(workspace.id)).toEqual([
      expect.objectContaining({
        id: worker.id,
        name: 'Alice',
        processState: 'stopped',
      }),
    ])
    expect(store.listTerminalRuns(workspace.id).some((run) => run.agent_id === worker.id)).toBe(
      false
    )
    expect(store.peekAgentLaunchConfig(workspace.id, worker.id)).toEqual(
      expect.objectContaining({
        command: '/bin/bash',
      })
    )
  })

  test('listWorkers excludes orchestrator', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    store.addWorker(workspace.id, {
      name: 'Alice',
    })
    store.addWorker(workspace.id, {
      name: 'Bob',
    })

    expect(store.listWorkers(workspace.id)).toEqual([
      {
        activeDispatchId: null,
        conversationActivity: 'unknown',
        id: expect.any(String),
        kind: 'worker',
        lastObservedAt: 0,
        name: 'Alice',
        processState: 'stopped',
        queuePauseReason: null,
        queuedDispatchCount: 0,
      },
      {
        activeDispatchId: null,
        conversationActivity: 'unknown',
        id: expect.any(String),
        kind: 'worker',
        lastObservedAt: 0,
        name: 'Bob',
        processState: 'stopped',
        queuePauseReason: null,
        queuedDispatchCount: 0,
      },
    ])
  })

  test('rejects duplicate worker names within the same workspace', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    store.addWorker(workspace.id, {
      name: 'Alice',
    })

    expect(() =>
      store.addWorker(workspace.id, {
        name: 'Alice',
      })
    ).toThrow('Worker name already exists: Alice')
  })

  test('normalizes worker names on create before storing and matching duplicates', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')

    const worker = store.addWorker(workspace.id, {
      name: ' Alice ',
    })

    expect(worker.name).toBe('Alice')
    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({ id: worker.id, name: 'Alice' })
    )
    expect(() =>
      store.addWorker(workspace.id, {
        name: 'Alice',
      })
    ).toThrow('Worker name already exists: Alice')
  })

  test('rejects blank worker names on create', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')

    expect(() => store.addWorker(workspace.id, { name: '   ' })).toThrow(
      'Worker name must not be empty'
    )
  })

  test('addWorker does not mutate memory when DB insert fails', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-add-worker-db-fail-'))
    tempDirs.push(dataDir)
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    initializeRuntimeDatabase(db)
    const workspaceStore = createWorkspaceStore(db, [])
    const workspace = workspaceStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const originalPrepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((source: string) => {
      if (source.startsWith('INSERT INTO workers')) {
        throw new Error('insert worker failed')
      }
      return originalPrepare(source)
    })

    expect(() => workspaceStore.addWorker(workspace.id, { name: 'Alice' })).toThrow(
      /insert worker failed/
    )
    expect(workspaceStore.listWorkers(workspace.id)).toEqual([])

    db.close()
  })
})
