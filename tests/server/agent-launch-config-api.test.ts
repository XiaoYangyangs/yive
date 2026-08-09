import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

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
  while (servers.length > 0) {
    await servers.pop()?.close()
  }

  for (const dir of tempDirs.splice(0)) {
    await removeTempDir(dir)
  }
})

describe('retired agent launch config api', () => {
  test('POST /api/workspaces/:id/agents/:agentId/config is unavailable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-launch-config-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const store = createRuntimeStore({ dataDir })
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }

    const app = createApp({ store })
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    servers.push({
      async close() {
        app.close()
        await store.close()
        app.server.closeIdleConnections?.()
        app.server.closeAllConnections?.()
        await new Promise<void>((resolve) => app.server.close(() => resolve()))
      },
    })

    const address = app.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to an inet port')
    }
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestrator.id}/config`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ command: 'node', args: ['script.js'] }),
      }
    )

    expect(response.status).toBe(404)
    expect(store.peekAgentLaunchConfig(workspace.id, orchestrator.id)).toBeUndefined()
  })
})
