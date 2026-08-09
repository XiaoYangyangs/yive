import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { writeProviderAdapterFixture } from '../helpers/provider-adapter-fixture.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<{ close: () => void }> = []
const stores: Array<ReturnType<typeof createRuntimeStore>> = []
const tempDirs: string[] = []
const originalCodexHome = process.env.CODEX_HOME

afterEach(async () => {
  while (servers.length > 0) {
    servers.pop()?.close()
  }
  await Promise.all(stores.splice(0).map((store) => store.close()))
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const startServer = async () => {
  const store = createRuntimeStore({ agentManager: createAgentManager() })
  stores.push(store)
  const app = createApp({ store })

  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })

  servers.push(app.server)

  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }

  return {
    store,
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
}

const startServerWithVersionInfo = async () => {
  const store = createRuntimeStore({ agentManager: createAgentManager() })
  stores.push(store)
  const app = createApp({
    store,
    versionService: {
      getVersionInfo: async () => ({
        current_version: '0.6.0-alpha.3',
        install_hint: 'yive update',
        latest_version: '0.6.0-alpha.4',
        package_name: 'yive',
        release_url: 'https://www.npmjs.com/package/yive/v/0.6.0-alpha.4',
        update_available: true,
      }),
    },
  })

  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })

  servers.push(app.server)

  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
}

const requestWithHeaders = async (
  baseUrl: string,
  path: string,
  headers: Record<string, string>
) => {
  const target = new URL(path, baseUrl)
  return new Promise<{ body: string; statusCode: number }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        path: target.pathname + target.search,
        port: target.port,
        method: 'GET',
        headers,
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          resolve({ body, statusCode: response.statusCode ?? 0 })
        })
      }
    )
    request.on('error', reject)
    request.end()
  })
}

const waitFor = async (assertion: () => void, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastError
}

describe('runtime http app', () => {
  test('GET /api/version returns cached update metadata for the UI', async () => {
    const { baseUrl } = await startServerWithVersionInfo()

    const response = await fetch(`${baseUrl}/api/version`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      current_version: '0.6.0-alpha.3',
      install_hint: 'yive update',
      latest_version: '0.6.0-alpha.4',
      package_name: 'yive',
      release_url: 'https://www.npmjs.com/package/yive/v/0.6.0-alpha.4',
      update_available: true,
    })
  })

  test('GET /api/workspaces returns current workspace list', async () => {
    const { store, baseUrl } = await startServer()
    store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces`, { headers: { cookie } })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual([
      {
        id: expect.any(String),
        name: 'Alpha',
        path: '/tmp/hive-alpha',
      },
    ])
  })

  test('POST /api/workspaces creates workspace (autostart skipped)', async () => {
    const { baseUrl } = await startServer()
    const cookie = await getUiCookie(baseUrl)
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-beta-'))
    tempDirs.push(workspacePath)

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        path: workspacePath,
        name: 'Beta',
        autostart_orchestrator: false,
      }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({
      id: expect.any(String),
      name: 'Beta',
      path: realpathSync(workspacePath),
      orchestrator_start: { ok: false, error: null, run_id: null },
    })
  })

  test('POST /api/workspaces rejects oversized JSON bodies before creating workspace', async () => {
    const { store, baseUrl } = await startServer()
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        path: '/tmp/hive-oversized',
        name: 'Oversized',
        notes: 'x'.repeat(1024 * 1024),
      }),
    })

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({ error: 'Request body too large' })
    expect(store.listWorkspaces()).toEqual([])
  })

  test('GET /api/ui/workspaces/:id/team returns worker team list for the UI', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
    })
    store.dispatchTask(workspace.id, worker.id, 'Implement feature')

    const sessionResponse = await fetch(`${baseUrl}/api/ui/session`)
    const cookie = sessionResponse.headers.get('set-cookie')
    if (!cookie) {
      throw new Error('Expected UI session cookie')
    }

    const response = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
      headers: { cookie },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual([
      {
        active_dispatch_id: null,
        conversation_activity: 'unknown',
        conversation_provider: null,
        id: worker.id,
        kind: 'worker',
        last_observed_at: 0,
        last_pty_line: null,
        name: 'Alice',
        process_state: 'stopped',
        provider: null,
        queue_pause_reason: null,
        queued_dispatch_count: 1,
      },
    ])
  })

  test('GET /api/workspaces/:id/team rejects anonymous callers', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    store.addWorker(workspace.id, {
      name: 'Alice',
    })

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/team`)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      code: 'unauthorized',
      error: 'Missing agent identity',
    })
  })

  test('GET /api/ui/workspaces/:id/team rejects non-browser requests', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    store.addWorker(workspace.id, {
      name: 'Alice',
    })

    const response = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/team`)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: 'UI endpoint requires valid UI token',
    })
  })

  test('GET /api/ui/session issues HttpOnly UI cookie', async () => {
    const { baseUrl } = await startServer()

    const response = await fetch(`${baseUrl}/api/ui/session`)

    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response.headers.get('set-cookie')).toContain('SameSite=Strict')
    await expect(response.json()).resolves.toEqual({
      ok: true,
    })
  })

  test('rejects non-local Host and Origin headers before issuing a UI token', async () => {
    const { baseUrl } = await startServer()

    const hostResponse = await requestWithHeaders(baseUrl, '/api/ui/session', {
      Host: 'attacker.example',
    })
    expect(hostResponse.statusCode).toBe(403)
    expect(JSON.parse(hostResponse.body)).toEqual({
      error: 'Local runtime rejected non-local Host header',
    })

    const originResponse = await requestWithHeaders(baseUrl, '/api/ui/session', {
      Origin: 'https://attacker.example',
    })
    expect(originResponse.statusCode).toBe(403)
    expect(JSON.parse(originResponse.body)).toEqual({
      error: 'Local runtime rejected non-local Origin header',
    })
  })

  test('POST /api/workspaces/:id/workers creates a worker', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Alice', provider: 'codex' }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({
      agent_start: { ok: false, error: null, run_id: null },
      active_dispatch_id: null,
      conversation_activity: 'unknown',
      conversation_provider: 'codex',
      id: expect.any(String),
      kind: 'worker',
      last_observed_at: 0,
      last_pty_line: null,
      name: 'Alice',
      process_state: 'stopped',
      provider: 'codex',
      queue_pause_reason: null,
      queued_dispatch_count: 0,
    })
    expect(store.listWorkers(workspace.id)).toEqual([
      {
        activeDispatchId: null,
        conversationActivity: 'unknown',
        id: expect.any(String),
        kind: 'worker',
        lastObservedAt: 0,
        name: 'Alice',
        processState: 'stopped',
        queuePauseReason: null,
        queuedDispatchCount: 0,
      },
    ])
  })

  test('POST /api/workspaces/:id/workers/:workerId/stop stops active run without removing worker', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const cookie = await getUiCookie(baseUrl)
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
    })

    store.configureAgentLaunch(workspace.id, worker.id, {
      args: ['-e', 'process.stdin.resume()'],
      command: process.execPath,
      provider: 'codex',
    })
    await store.startAgent(workspace.id, worker.id, {
      hivePort: '4010',
      suppressStartupInstructions: true,
    })
    expect(store.listTerminalRuns(workspace.id).some((run) => run.agent_id === worker.id)).toBe(
      true
    )

    const stopResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/workers/${worker.id}/stop`,
      {
        method: 'POST',
        headers: { cookie },
      }
    )

    expect(stopResponse.status).toBe(202)
    await waitFor(() => {
      expect(store.listWorkers(workspace.id)).toEqual([
        expect.objectContaining({
          id: worker.id,
          name: 'Alice',
          processState: 'stopped',
        }),
      ])
    })
    expect(store.listTerminalRuns(workspace.id).some((run) => run.agent_id === worker.id)).toBe(
      false
    )
    expect(store.peekAgentLaunchConfig(workspace.id, worker.id)).toEqual(
      expect.objectContaining({
        command: process.execPath,
      })
    )
  })

  test('POST /api/runtime/runs/:runId/stop returns the structured safe-stop result', async () => {
    const { store, baseUrl } = await startServer()
    const workspacePath = mkdtempSync(join(tmpdir(), 'yive-app-safe-stop-'))
    tempDirs.push(workspacePath)
    const workspace = store.createWorkspace(workspacePath, 'Safe stop')
    const cookie = await getUiCookie(baseUrl)
    const worker = store.addWorker(workspace.id, { name: 'Alice' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      args: ['-e', 'process.stdin.resume()'],
      command: process.execPath,
      provider: 'codex',
    })
    const run = await store.startAgent(workspace.id, worker.id, {
      hivePort: '4010',
      suppressStartupInstructions: true,
    })

    const response = await fetch(`${baseUrl}/api/runtime/runs/${run.runId}/stop`, {
      body: JSON.stringify({ mode: 'safe' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })

    const responseBody = await response.text()
    expect(response.status, responseBody).toBe(200)
    expect(JSON.parse(responseBody)).toEqual({
      mode: 'safe',
      reason: null,
      run_id: run.runId,
      session_id: null,
      state: 'stopped',
    })
  })

  test('POST /api/team/send and /api/team/report update worker state', async () => {
    const { store, baseUrl } = await startServer()
    const dataDir = mkdtempSync(join(tmpdir(), 'yive-app-team-send-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)
    const providerFixture = writeProviderAdapterFixture({
      fixtureId: 'app-team-send',
      provider: 'codex',
      root: dataDir,
      workspacePath,
    })
    process.env.CODEX_HOME = join(dataDir, 'codex-home')
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
    })

    store.recordUserInput(workspace.id, orchestrator.id, 'bootstrap')

    store.configureAgentLaunch(workspace.id, worker.id, {
      ...buildManagedProviderLaunchConfig('codex'),
      args: [],
      command: providerFixture.command,
      interactiveCommand: providerFixture.command,
    })
    store.configureAgentLaunch(workspace.id, orchestrator.id, {
      args: ['-e', 'process.stdin.resume()'],
      command: process.execPath,
      provider: 'codex',
    })
    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    await store.startAgent(workspace.id, orchestrator.id, {
      hivePort: '4010',
      suppressStartupInstructions: true,
    })
    await waitFor(() => {
      expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
        conversationActivity: 'idle',
        processState: 'running',
      })
    })

    const orchestratorToken = store.peekAgentToken(orchestrator.id)
    const workerToken = store.peekAgentToken(worker.id)

    const sendResponse = await fetch(`${baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: orchestrator.id,
        token: orchestratorToken,
        to: 'Alice',
        text: 'Implement feature',
      }),
    })

    expect(sendResponse.status).toBe(202)
    const sendBody = (await sendResponse.json()) as { dispatch_id: string }
    expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: sendBody.dispatch_id,
      processState: 'running',
      queuedDispatchCount: 0,
    })

    const reportResponse = await fetch(`${baseUrl}/api/team/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: worker.id,
        token: workerToken,
        request_id: 'app-report',
        result: 'Done',
        artifacts: [],
      }),
    })

    expect(reportResponse.status).toBe(202)
    expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: null,
      processState: 'running',
      queuedDispatchCount: 0,
    })
  })

  test('POST /api/workspaces/:id/workers rejects duplicate worker names in one workspace', async () => {
    const { store, baseUrl } = await startServer()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const cookie = await getUiCookie(baseUrl)
    store.addWorker(workspace.id, {
      name: 'Alice',
    })

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Alice', provider: 'codex' }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      code: 'worker_name_exists',
      error: 'Worker name already exists: Alice',
    })
  })
})
