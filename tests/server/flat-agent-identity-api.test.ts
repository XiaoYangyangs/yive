import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { startTestServer } from '../helpers/test-server.js'
import { getMobileCookie, getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const dataDir of tempDirs.splice(0)) rmSync(dataDir, { force: true, recursive: true })
})

const retiredKeys = ['role', 'role_type', 'description', 'instructions', 'template_id']

const expectRoleFreeRecord = (record: Record<string, unknown>, kind: 'orchestrator' | 'worker') => {
  expect(record.kind).toBe(kind)
  for (const key of retiredKeys) expect(record).not.toHaveProperty(key)
}

const waitFor = async (assertion: () => Promise<void>, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastError
}

describe('flat agent identity HTTP contract', () => {
  test('renames the Orchestrator without changing its durable identity', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-flat-orchestrator-'))
    tempDirs.push(dataDir)
    const firstServer = await startTestServer({ dataDir })
    servers.push(firstServer)
    const firstCookie = await getUiCookie(firstServer.baseUrl)
    const workspace = firstServer.store.createWorkspace(
      'C:/flat-orchestrator-rename',
      'Orchestrator Rename'
    )
    const orchestratorId = `${workspace.id}:orchestrator`

    const renameResponse = await fetch(
      `${firstServer.baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: firstCookie },
        body: JSON.stringify({ name: 'Lead Agent' }),
      }
    )
    expect(renameResponse.status).toBe(200)
    await expect(renameResponse.json()).resolves.toMatchObject({
      id: orchestratorId,
      kind: 'orchestrator',
      name: 'Lead Agent',
      workspace_id: workspace.id,
    })

    const identityChangeResponse = await fetch(
      `${firstServer.baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: firstCookie },
        body: JSON.stringify({ kind: 'worker', name: 'Demoted Agent' }),
      }
    )
    expect(identityChangeResponse.status).toBe(400)

    servers.splice(servers.indexOf(firstServer), 1)
    await firstServer.close()

    const secondServer = await startTestServer({ dataDir })
    servers.push(secondServer)
    const secondCookie = await getUiCookie(secondServer.baseUrl)
    const mobileCookie = await getMobileCookie(secondServer.baseUrl)

    const agentResponse = await fetch(
      `${secondServer.baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}`,
      { headers: { cookie: secondCookie } }
    )
    expect(agentResponse.status).toBe(200)
    await expect(agentResponse.json()).resolves.toMatchObject({
      id: orchestratorId,
      kind: 'orchestrator',
      name: 'Lead Agent',
      workspace_id: workspace.id,
    })

    secondServer.store.settings.setAppState('active_workspace_id', workspace.id)
    const snapshotResponse = await fetch(`${secondServer.baseUrl}/api/mobile/snapshot`, {
      headers: { cookie: mobileCookie },
    })
    expect(snapshotResponse.status).toBe(200)
    await expect(snapshotResponse.json()).resolves.toMatchObject({
      active_workspace: {
        orchestrator: {
          id: orchestratorId,
          kind: 'orchestrator',
          name: 'Lead Agent',
        },
      },
    })
  })

  test('creates a Worker without Role fields', async () => {
    const server = await startTestServer()
    servers.push(server)
    const uiCookie = await getUiCookie(server.baseUrl)
    const workspace = server.store.createWorkspace('C:/flat-agent-api', 'Flat API')

    const createResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({ name: 'Flat Worker', provider: 'codex' }),
    })

    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as Record<string, unknown>
    expectRoleFreeRecord(created, 'worker')
  })

  test('serializes desktop and mobile Agents with Orchestrator-or-Worker identity only', async () => {
    const server = await startTestServer()
    servers.push(server)
    const uiCookie = await getUiCookie(server.baseUrl)
    const mobileCookie = await getMobileCookie(server.baseUrl)
    const workspace = server.store.createWorkspace('C:/flat-agent-payloads', 'Flat Payloads')
    server.store.addWorker(workspace.id, { name: 'Flat Worker' })

    const desktopResponse = await fetch(
      `${server.baseUrl}/api/ui/workspaces/${workspace.id}/team`,
      { headers: { cookie: uiCookie } }
    )
    expect(desktopResponse.status).toBe(200)
    const desktopAgents = (await desktopResponse.json()) as Array<Record<string, unknown>>
    expect(desktopAgents).toHaveLength(1)
    expectRoleFreeRecord(desktopAgents[0] ?? {}, 'worker')

    server.store.settings.setAppState('active_workspace_id', workspace.id)
    const mobileResponse = await fetch(`${server.baseUrl}/api/mobile/snapshot`, {
      headers: { cookie: mobileCookie },
    })
    expect(mobileResponse.status).toBe(200)
    const snapshot = (await mobileResponse.json()) as {
      active_workspace: {
        orchestrator: Record<string, unknown>
        workers: Array<Record<string, unknown>>
      }
    }
    expectRoleFreeRecord(snapshot.active_workspace.orchestrator, 'orchestrator')
    expect(snapshot.active_workspace.workers).toHaveLength(1)
    expectRoleFreeRecord(snapshot.active_workspace.workers[0] ?? {}, 'worker')
  })

  test('keeps live terminal history visible while projecting a flat Worker identity', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspacePath = join(server.dataDir, 'terminal-workspace')
    mkdirSync(workspacePath, { recursive: true })
    const workspace = server.store.createWorkspace(workspacePath, 'Terminal Identity')
    const worker = server.store.addWorker(workspace.id, { name: 'Terminal Worker' })

    server.store.configureAgentLaunch(workspace.id, worker.id, {
      args: ['-e', "console.log('preserved-terminal-line'); process.stdin.resume()"],
      command: process.execPath,
      provider: 'codex',
    })
    await server.store.startAgent(workspace.id, worker.id, {
      hivePort: server.baseUrl.split(':').at(-1) ?? '',
      suppressStartupInstructions: true,
    })

    let projectedWorker: Record<string, unknown> | undefined
    await waitFor(async () => {
      const response = await fetch(`${server.baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
        headers: { cookie },
      })
      const agents = (await response.json()) as Array<Record<string, unknown>>
      projectedWorker = agents.find((agent) => agent.id === worker.id)
      expect(projectedWorker?.last_pty_line).toBe('preserved-terminal-line')
    })

    expectRoleFreeRecord(projectedWorker ?? {}, 'worker')
  })

  test('rejects legacy Role-bearing Agent creation payloads', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = server.store.createWorkspace('C:/flat-agent-legacy-input', 'Legacy Input')

    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        description: 'Do not persist this',
        instructions: 'Do not inject this',
        name: 'Legacy Worker',
        role: 'tester',
        template_id: 'custom-legacy',
      }),
    })

    expect([400, 404, 410, 422]).toContain(response.status)
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) })
  })

  test('removes Role template and marketplace HTTP surfaces', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const requests = await Promise.all([
      fetch(`${server.baseUrl}/api/settings/role-templates`, { headers: { cookie } }),
      fetch(`${server.baseUrl}/api/settings/role-templates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'Legacy', role_type: 'custom', description: 'retire' }),
      }),
      fetch(`${server.baseUrl}/api/settings/role-templates/legacy`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'Legacy', role_type: 'custom', description: 'retire' }),
      }),
      fetch(`${server.baseUrl}/api/settings/role-templates/legacy`, {
        method: 'DELETE',
        headers: { cookie },
      }),
      fetch(`${server.baseUrl}/api/marketplace/manifest?lang=en`, { headers: { cookie } }),
      fetch(`${server.baseUrl}/api/marketplace/agent?lang=en&path=legacy.md`, {
        headers: { cookie },
      }),
    ])

    for (const response of requests) expect([404, 410]).toContain(response.status)
  })

  test('authorizes Team operations from authenticated Orchestrator-or-Worker identity', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = server.store.createWorkspace('C:/flat-agent-authz', 'Flat Authz')
    const orchestratorId = `${workspace.id}:orchestrator`
    server.store.configureAgentLaunch(
      workspace.id,
      orchestratorId,
      buildManagedProviderLaunchConfig('codex')
    )
    const createWorkerResponse = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/workers`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'Authenticated Worker' }),
      }
    )
    expect(createWorkerResponse.status).toBe(201)
    const worker = (await createWorkerResponse.json()) as { id: string }

    for (const agentId of [orchestratorId, worker.id]) {
      server.store.configureAgentLaunch(workspace.id, agentId, {
        args: ['-e', 'process.stdin.resume()'],
        command: process.execPath,
        provider: 'codex',
      })
      await server.store.startAgent(workspace.id, agentId, {
        hivePort: server.baseUrl.split(':').at(-1) ?? '',
        suppressStartupInstructions: true,
      })
    }

    const workerToken = server.store.peekAgentToken(worker.id)
    const orchestratorToken = server.store.peekAgentToken(orchestratorId)
    expect(workerToken).toEqual(expect.any(String))
    expect(orchestratorToken).toEqual(expect.any(String))

    const legacyOrchestratorAddResponse = await fetch(`${server.baseUrl}/api/team/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_agent_id: orchestratorId,
        name: 'Legacy Nested Worker',
        project_id: workspace.id,
        role: 'reviewer',
        token: orchestratorToken,
      }),
    })
    expect(legacyOrchestratorAddResponse.status).toBe(400)
    await expect(legacyOrchestratorAddResponse.json()).resolves.toMatchObject({
      error: expect.stringMatching(/role/i),
    })

    const workerAddResponse = await fetch(`${server.baseUrl}/api/team/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_agent_id: worker.id,
        name: 'Nested Worker',
        project_id: workspace.id,
        token: workerToken,
      }),
    })
    expect(workerAddResponse.status).toBe(403)
    await expect(workerAddResponse.json()).resolves.toMatchObject({
      error: expect.stringMatching(/worker/i),
    })

    const orchestratorReportResponse = await fetch(`${server.baseUrl}/api/team/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        artifacts: [],
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        result: 'Orchestrators do not report Dispatch work',
        token: orchestratorToken,
      }),
    })
    expect(orchestratorReportResponse.status).toBe(403)
    await expect(orchestratorReportResponse.json()).resolves.toMatchObject({
      error: expect.stringMatching(/orchestrator/i),
    })

    const orchestratorAddResponse = await fetch(`${server.baseUrl}/api/team/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_agent_id: orchestratorId,
        name: 'Second Flat Worker',
        project_id: workspace.id,
        token: orchestratorToken,
      }),
    })
    expect(orchestratorAddResponse.status).toBe(201)
    expectRoleFreeRecord(
      (await orchestratorAddResponse.json()) as Record<string, unknown>,
      'worker'
    )
  })
})
