import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const tempDirs: string[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  for (const path of tempDirs.splice(0)) rmSync(path, { force: true, recursive: true })
})

const makeWorkspacePath = () => {
  const root = mkdtempSync(join(tmpdir(), 'yive-provider-workspace-'))
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  tempDirs.push(root)
  return workspacePath
}

describe('POST /api/workspaces managed Provider contract', () => {
  test('rejects a missing path before creating a Workspace', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const missingPath = join(tmpdir(), `yive-missing-${crypto.randomUUID()}`)

    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      body: JSON.stringify({ name: 'Missing', path: missingPath }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })

    expect(response.status).toBe(400)
    expect(server.store.listWorkspaces()).toEqual([])
  })

  test.each([
    ['codex', undefined],
    ['claude', 'claude'],
  ] as const)('seeds a %s Orchestrator launch config without autostart', async (expected, input) => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      body: JSON.stringify({
        autostart_orchestrator: false,
        name: `Provider ${expected}`,
        path: makeWorkspacePath(),
        ...(input ? { provider: input } : {}),
      }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })

    expect(response.status).toBe(201)
    const workspace = (await response.json()) as {
      id: string
      orchestrator_start: { error: string | null; ok: boolean; run_id: string | null }
    }
    expect(workspace.orchestrator_start).toEqual({ error: null, ok: false, run_id: null })
    expect(
      server.store.peekAgentLaunchConfig(workspace.id, `${workspace.id}:orchestrator`)
    ).toMatchObject({
      args:
        expected === 'claude'
          ? ['--dangerously-skip-permissions', '--permission-mode=bypassPermissions']
          : ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'],
      command: expected,
      provider: expected,
    })
    expect(server.store.listTerminalRuns(workspace.id)).toEqual([])
  })

  test.each([
    { provider: 'gemini' },
    { startup_command: 'node custom.js' },
    { command_preset_id: 'codex' },
  ])('rejects unsupported Provider configuration atomically: %j', async (extra) => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      body: JSON.stringify({ name: 'Rejected', path: makeWorkspacePath(), ...extra }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'unsupported_agent_provider_configuration',
    })
    expect(server.store.listWorkspaces()).toEqual([])
  })
})
