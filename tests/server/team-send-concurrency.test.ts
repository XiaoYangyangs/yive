import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { type AgentManager, createAgentManager } from '../../src/server/agent-manager.js'
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
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
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

describe('team send concurrency', () => {
  test('serializes sends per Worker before creating or delivering a second Dispatch', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'yive-team-send-concurrency-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)
    const providerFixture = writeProviderAdapterFixture({
      fixtureId: 'concurrent-send',
      provider: 'codex',
      root: dataDir,
      workspacePath,
    })
    process.env.CODEX_HOME = join(dataDir, 'codex-home')

    const baseManager = createAgentManager()
    const writes: string[] = []
    const manager: AgentManager = {
      getOutputBus: baseManager.getOutputBus,
      getRun: baseManager.getRun,
      pauseRun: baseManager.pauseRun,
      removeRun: baseManager.removeRun,
      resizeRun: baseManager.resizeRun,
      resumeRun: baseManager.resumeRun,
      stopRun: baseManager.stopRun,
      startAgent: baseManager.startAgent,
      writeInput(runId, input) {
        writes.push(String(input))
        baseManager.writeInput(runId, input)
      },
    }
    const store = createRuntimeStore({ agentManager: manager, dataDir: join(dataDir, 'runtime') })
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
    writes.length = 0

    const requests = [
      store.dispatchTask(workspace.id, worker.id, 'Concurrent task A', {
        fromAgentId: orchestrator.id,
      }),
      store.dispatchTask(workspace.id, worker.id, 'Concurrent task B', {
        fromAgentId: orchestrator.id,
      }),
    ]

    const settled = await Promise.allSettled(requests)

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({
      reason: {
        code: 'active_dispatch_exists',
        statusCode: 409,
      },
      status: 'rejected',
    })
    expect(store.listDispatches(workspace.id)).toEqual([
      expect.objectContaining({ status: 'submitted', text: 'Concurrent task A' }),
    ])
    expect(writes.join('')).toContain('Concurrent task A')
    expect(writes.join('')).not.toContain('Concurrent task B')
  })
})
