import { describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'

describe('report queued responsibility', () => {
  test('report rejects future queued work instead of claiming it as active responsibility', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice' })
    store.dispatchTask(workspace.id, worker.id, 'Task 1')
    store.dispatchTask(workspace.id, worker.id, 'Task 2')
    expect(() =>
      store.reportTask(workspace.id, worker.id, {
        requestId: 'queued-report',
        text: 'Done one',
      })
    ).toThrowError(expect.objectContaining({ code: 'no_active_dispatch' }))

    expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: null,
      processState: 'stopped',
      queuedDispatchCount: 2,
    })
  })
})
