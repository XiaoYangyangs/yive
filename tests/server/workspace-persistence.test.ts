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
  for (const dir of tempDirs.splice(0)) {
    await removeTempDir(dir)
  }
})

describe('workspace persistence', () => {
  test('reloads workspaces from sqlite-backed storage', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'hive-store-'))
    tempDirs.push(tempDir)

    const firstStore = createRuntimeStore({ dataDir: tempDir })
    firstStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    firstStore.createWorkspace('/tmp/hive-beta', 'Beta')
    await firstStore.close()

    const secondStore = createRuntimeStore({ dataDir: tempDir })
    try {
      expect(secondStore.listWorkspaces()).toEqual([
        {
          id: expect.any(String),
          name: 'Alpha',
          path: '/tmp/hive-alpha',
        },
        {
          id: expect.any(String),
          name: 'Beta',
          path: '/tmp/hive-beta',
        },
      ])
    } finally {
      await secondStore.close()
    }
  })
})
