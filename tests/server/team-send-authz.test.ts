import { describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'

describe('team send authorization', () => {
  test('dispatchTaskByWorkerName leaves state unchanged when the Worker is stopped', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const alice = store.addWorker(workspace.id, { name: 'Alice' })
    const bob = store.addWorker(workspace.id, { name: 'Bob' })

    await expect(
      store.dispatchTaskByWorkerName(workspace.id, 'Alice', 'Implement login', {
        fromAgentId: bob.id,
      })
    ).rejects.toMatchObject({ code: 'agent_process_not_running', statusCode: 409 })

    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: alice.id,
        activeDispatchId: null,
        queuedDispatchCount: 0,
      })
    )
    await store.close()
  })
})
