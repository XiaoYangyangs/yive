import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

const createWorkspace = async (
  server: Awaited<ReturnType<typeof startTestServer>>,
  cookie: string,
  provider: 'claude' | 'codex' = 'codex'
) => {
  const response = await fetch(`${server.baseUrl}/api/workspaces`, {
    body: JSON.stringify({
      autostart_orchestrator: false,
      name: 'Worker Provider',
      path: server.dataDir,
      provider,
    }),
    headers: { 'content-type': 'application/json', cookie },
    method: 'POST',
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
}

describe('POST /api/workspaces/:workspaceId/workers managed Provider contract', () => {
  test('inherits the Orchestrator Provider without starting when autostart is false', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = await createWorkspace(server, cookie, 'claude')

    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
      body: JSON.stringify({ autostart: false, name: 'Alice' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })

    expect(response.status).toBe(201)
    const worker = (await response.json()) as {
      agent_start: { error: string | null; ok: boolean; run_id: string | null }
      id: string
      provider: string
    }
    expect(worker).toMatchObject({
      agent_start: { error: null, ok: false, run_id: null },
      provider: 'claude',
    })
    expect(server.store.peekAgentLaunchConfig(workspace.id, worker.id)).toMatchObject({
      command: 'claude',
      provider: 'claude',
    })
    expect(server.store.listTerminalRuns(workspace.id)).toEqual([])
  })

  test('allows an explicit cross-Provider Worker', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = await createWorkspace(server, cookie)

    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
      body: JSON.stringify({ autostart: false, name: 'Claude Worker', provider: 'claude' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({ provider: 'claude' })
  })
})
