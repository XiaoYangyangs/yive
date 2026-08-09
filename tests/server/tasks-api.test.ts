import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

describe('retired Workspace Tasks HTTP surface', () => {
  test('GET and PUT routes are unavailable', async () => {
    const server = await startTestServer()
    try {
      const workspacePath = join(server.dataDir, 'workspace')
      mkdirSync(join(workspacePath, '.hive'), { recursive: true })
      writeFileSync(join(workspacePath, '.hive', 'tasks.md'), '- [ ] retired\n', 'utf8')
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
      const cookie = await getUiCookie(server.baseUrl)
      const url = `${server.baseUrl}/api/workspaces/${workspace.id}/tasks`

      const getResponse = await fetch(url, { headers: { cookie } })
      const putResponse = await fetch(url, {
        body: JSON.stringify({ content: '- [ ] unavailable\n' }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'PUT',
      })

      expect(getResponse.status).toBe(404)
      expect(putResponse.status).toBe(404)
    } finally {
      await server.close()
    }
  })
})
