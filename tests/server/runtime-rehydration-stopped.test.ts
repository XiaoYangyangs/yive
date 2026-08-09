import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []

const removeTempDir = async (dir: string) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { force: true, recursive: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM' || attempt === 19) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await removeTempDir(dir)
})

describe('runtime rehydration Agent state', () => {
  test('runtime reload keeps process stopped and queued responsibility independent', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-rehydrate-stopped-'))
    tempDirs.push(dataDir)
    const firstStore = createRuntimeStore({ dataDir })
    const workspace = firstStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = firstStore.addWorker(workspace.id, { name: 'Alice' })
    await firstStore.dispatchTask(workspace.id, worker.id, 'Implement login')
    await firstStore.close()

    const secondStore = createRuntimeStore({ dataDir })
    try {
      expect(secondStore.listWorkers(workspace.id)).toContainEqual(
        expect.objectContaining({
          activeDispatchId: null,
          id: worker.id,
          processState: 'stopped',
          queuedDispatchCount: 1,
        })
      )
    } finally {
      await secondStore.close()
    }
  })
})
