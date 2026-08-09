import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { writeProviderAdapterFixture } from '../helpers/provider-adapter-fixture.js'

const stores: Array<ReturnType<typeof createRuntimeStore>> = []
const tempDirs: string[] = []
const originalCodexHome = process.env.CODEX_HOME

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const waitFor = async (assertion: () => void, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw lastError
}

describe('queued Dispatch activation', () => {
  test('delivers the FIFO head once after Report and promotes it only after PTY success', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'yive-dispatch-activation-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(join(workspacePath, 'src'), { recursive: true })
    writeFileSync(join(workspacePath, 'src', 'queue.ts'), 'export const queued = true\n')
    tempDirs.push(dataDir)
    const providerFixture = writeProviderAdapterFixture({
      fixtureId: 'dispatch-activation',
      provider: 'codex',
      root: dataDir,
      workspacePath,
    })
    process.env.CODEX_HOME = join(dataDir, 'codex-home')

    const store = createRuntimeStore({
      agentManager: createAgentManager(),
      dataDir: join(dataDir, 'runtime'),
    })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected Orchestrator')
    const worker = store.addWorker(workspace.id, { name: 'Alice' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      ...buildManagedProviderLaunchConfig('codex'),
      args: [],
      command: providerFixture.command,
      interactiveCommand: providerFixture.command,
    })
    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    await waitFor(() => {
      expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
        conversationActivity: 'idle',
        processState: 'running',
      })
    })

    const active = await store.dispatchTask(workspace.id, worker.id, 'First active task', {
      fromAgentId: orchestrator.id,
      requestId: 'active-request-1',
    })
    expect(active).toMatchObject({
      deliveredAt: expect.any(Number),
      sequence: expect.any(Number),
      status: 'submitted',
      submittedAt: expect.any(Number),
    })
    const stdinAfterActive = providerFixture
      .readEvents()
      .filter((event) => event.kind === 'stdin').length
    const replay = await store.dispatchTask(workspace.id, worker.id, 'First active task', {
      fromAgentId: orchestrator.id,
      requestId: 'active-request-1',
    })
    expect(replay).toMatchObject({
      id: active.id,
      sequence: active.sequence,
      status: 'submitted',
    })
    expect(providerFixture.readEvents().filter((event) => event.kind === 'stdin')).toHaveLength(
      stdinAfterActive
    )
    await expect(
      store.dispatchTask(workspace.id, worker.id, 'Conflicting active retry', {
        fromAgentId: orchestrator.id,
        requestId: 'active-request-1',
      })
    ).rejects.toMatchObject({ code: 'dispatch_request_conflict', statusCode: 409 })
    const queued = await store.dispatchTask(workspace.id, worker.id, 'Second queued task', {
      artifacts: ['src/queue.ts'],
      fromAgentId: orchestrator.id,
      queue: true,
      requestId: 'queued-request-1',
    })
    const stdinBeforeReport = providerFixture
      .readEvents()
      .filter((event) => event.kind === 'stdin').length
    expect(store.getDispatch(workspace.id, queued.id)).toMatchObject({ status: 'queued' })

    store.reportTask(workspace.id, worker.id, {
      requestId: 'active-report-1',
      text: 'First task complete',
    })

    await waitFor(() => {
      expect(store.getDispatch(workspace.id, active.id)).toMatchObject({ status: 'reported' })
      expect(store.getDispatch(workspace.id, queued.id)).toMatchObject({ status: 'submitted' })
    })
    const activationWrites = providerFixture
      .readEvents()
      .filter((event) => event.kind === 'stdin')
      .slice(stdinBeforeReport)
    expect(activationWrites.map((event) => event.text).join('')).toContain('Second queued task')
    expect(activationWrites.map((event) => event.text).join('')).toContain('artifact: src/queue.ts')
    expect(
      activationWrites.filter((event) => event.text?.includes('Second queued task'))
    ).toHaveLength(1)
    expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: queued.id,
      conversationActivity: 'idle',
      queuedDispatchCount: 0,
    })

    const blocked = await store.dispatchTask(workspace.id, worker.id, 'Remain queued after loss', {
      fromAgentId: orchestrator.id,
      queue: true,
      requestId: 'queued-request-2',
    })
    const activeRun = store.getActiveRunByAgentId(workspace.id, worker.id)
    if (!activeRun) throw new Error('Expected active Worker run')
    store.stopAgentRun(activeRun.runId)
    const stdinBeforeLossReport = providerFixture
      .readEvents()
      .filter((event) => event.kind === 'stdin').length

    store.reportTask(workspace.id, worker.id, {
      requestId: 'active-report-2',
      text: 'Second task complete',
    })
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(store.getDispatch(workspace.id, blocked.id)).toMatchObject({ status: 'queued' })
    expect(providerFixture.readEvents().filter((event) => event.kind === 'stdin')).toHaveLength(
      stdinBeforeLossReport
    )
    expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: null,
      conversationActivity: 'unknown',
      queuedDispatchCount: 1,
    })
  }, 30_000)
})
