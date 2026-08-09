import { describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'

describe('cancel dispatch', () => {
  test('cancelTask closes an open dispatch without changing process truth', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice' })
    const dispatch = await store.dispatchTask(workspace.id, worker.id, 'Front-end scan')

    const result = await store.cancelTask(workspace.id, dispatch.id, {
      fromAgentId: `${workspace.id}:orchestrator`,
      reason: 'Direction changed',
    })

    expect(result.dispatch).toMatchObject({
      id: dispatch.id,
      reportText: 'Direction changed',
      status: 'cancelled',
    })
    expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: null,
      processState: 'stopped',
      queuedDispatchCount: 0,
    })
  })

  test('cancelTask decrements only the selected dispatch when multiple are open', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice' })
    const first = await store.dispatchTask(workspace.id, worker.id, 'Old task')
    const second = await store.dispatchTask(workspace.id, worker.id, 'New task')

    await store.cancelTask(workspace.id, first.id, {
      fromAgentId: `${workspace.id}:orchestrator`,
      reason: 'Superseded',
    })

    expect(store.listDispatches(workspace.id)).toEqual([
      expect.objectContaining({ id: first.id, status: 'cancelled' }),
      expect.objectContaining({ id: second.id, status: 'queued' }),
    ])
    expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: null,
      processState: 'stopped',
      queuedDispatchCount: 1,
    })
  })
})
