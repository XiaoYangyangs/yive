import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'

const stores: Array<ReturnType<typeof createRuntimeStore>> = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('Dispatch FIFO persistence', () => {
  test('preserves concurrent enqueue order across restart and queued cancellation', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'yive-dispatch-fifo-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const firstStore = createRuntimeStore({ dataDir: join(dataDir, 'runtime') })
    const workspace = firstStore.createWorkspace(workspacePath, 'Alpha')
    const worker = firstStore.addWorker(workspace.id, { name: 'Alice' })
    const orchestrator = firstStore.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected Orchestrator')

    await Promise.all(
      ['First queued task', 'Second queued task', 'Third queued task'].map((text, index) =>
        firstStore.dispatchTask(workspace.id, worker.id, text, {
          fromAgentId: orchestrator.id,
          queue: true,
          requestId: `queue-request-${index + 1}`,
        })
      )
    )
    const beforeRestart = firstStore.listDispatches(workspace.id)
    expect(beforeRestart.map((dispatch) => dispatch.text)).toEqual([
      'First queued task',
      'Second queued task',
      'Third queued task',
    ])
    await firstStore.close()

    const reopened = createRuntimeStore({ dataDir: join(dataDir, 'runtime') })
    stores.push(reopened)
    const afterRestart = reopened.listDispatches(workspace.id)
    expect(afterRestart.map((dispatch) => [dispatch.sequence, dispatch.text])).toEqual(
      beforeRestart.map((dispatch) => [dispatch.sequence, dispatch.text])
    )
    expect(() =>
      reopened.reportTask(workspace.id, worker.id, {
        requestId: 'queued-restart-report',
        text: 'Must not report future work',
      })
    ).toThrowError(expect.objectContaining({ code: 'no_active_dispatch' }))
    expect(
      reopened.listDispatches(workspace.id).every((dispatch) => dispatch.status === 'queued')
    ).toBe(true)

    const middle = afterRestart[1]
    if (!middle) throw new Error('Expected middle queued Dispatch')
    await expect(
      reopened.cancelTask(workspace.id, middle.id, {
        fromAgentId: orchestrator.id,
        reason: 'No longer needed',
      })
    ).resolves.toMatchObject({ forwardError: null, forwarded: false })

    expect(
      reopened
        .listDispatches(workspace.id)
        .filter((dispatch) => dispatch.status === 'queued')
        .map((dispatch) => dispatch.text)
    ).toEqual(['First queued task', 'Third queued task'])
    expect(reopened.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: null,
      queuedDispatchCount: 2,
    })
  })
})
