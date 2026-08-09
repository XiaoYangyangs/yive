import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const cleanups: Array<() => Promise<void>> = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('team send queue API contract', () => {
  test('persists an explicit queued Dispatch without starting or writing to the Worker', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'yive-team-send-queue-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(join(workspacePath, 'src'), { recursive: true })
    mkdirSync(join(workspacePath, 'tests'), { recursive: true })
    writeFileSync(join(workspacePath, 'src', 'auth.ts'), 'export const auth = true\n')
    writeFileSync(join(workspacePath, 'src', 'long-task.ts'), 'export const longTask = true\n')
    writeFileSync(join(workspacePath, 'tests', 'auth.test.ts'), 'export const tested = true\n')
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir: join(dataDir, 'runtime') })
    cleanups.push(server.close)
    const uiCookie = await getUiCookie(server.baseUrl)

    const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      body: JSON.stringify({
        autostart_orchestrator: false,
        name: 'Alpha',
        path: workspacePath,
        provider: 'codex',
      }),
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      method: 'POST',
    })
    const workspace = (await workspaceResponse.json()) as { id: string }
    const orchestratorId = `${workspace.id}:orchestrator`

    const workerResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
      body: JSON.stringify({ name: 'Alice' }),
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      method: 'POST',
    })
    const worker = (await workerResponse.json()) as { id: string }

    server.store.configureAgentLaunch(workspace.id, orchestratorId, {
      args: ['-e', 'process.stdin.resume()'],
      command: process.execPath,
      provider: 'codex',
    })
    await server.store.startAgent(workspace.id, orchestratorId, {
      hivePort: server.baseUrl.split(':').at(-1) ?? '',
      suppressStartupInstructions: true,
    })
    const orchestratorToken = server.store.peekAgentToken(orchestratorId)
    if (!orchestratorToken) throw new Error('Expected Orchestrator token')

    const requestId = '0d845410-88cf-4bc8-b985-8d079b7b845d'
    const send = (text: string) =>
      fetch(`${server.baseUrl}/api/team/send`, {
        body: JSON.stringify({
          from_agent_id: orchestratorId,
          artifacts: ['src\\.\\auth.ts', 'tests\\auth.test.ts'],
          project_id: workspace.id,
          queue: true,
          request_id: requestId,
          text,
          to: 'Alice',
          token: orchestratorToken,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

    const response = await send('Implement login validation')

    expect(response.status, await response.clone().text()).toBe(202)
    const receipt = (await response.json()) as {
      dispatch_id: string
      ok: true
      request_id: string
    }
    expect(receipt).toMatchObject({
      dispatch_id: expect.any(String),
      ok: true,
      request_id: requestId,
    })

    rmSync(join(workspacePath, 'src', 'auth.ts'))
    rmSync(join(workspacePath, 'tests', 'auth.test.ts'))
    const retryResponse = await send('Implement login validation')
    expect(retryResponse.status).toBe(202)
    await expect(retryResponse.json()).resolves.toMatchObject({
      dispatch_id: receipt.dispatch_id,
      request_id: requestId,
    })

    const conflictingRetry = await send('Implement a conflicting task')
    expect(conflictingRetry.status).toBe(409)
    await expect(conflictingRetry.json()).resolves.toMatchObject({
      code: 'dispatch_request_conflict',
    })
    const invalidQueue = await fetch(`${server.baseUrl}/api/team/send`, {
      body: JSON.stringify({
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        queue: 'yes',
        request_id: '9bb13972-25af-4a4d-bd40-20d731010954',
        text: 'Must not silently become immediate',
        to: 'Alice',
        token: orchestratorToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(invalidQueue.status).toBe(400)
    await expect(invalidQueue.json()).resolves.toMatchObject({
      code: 'invalid_dispatch_request',
    })
    for (const invalidRequestId of ['x'.repeat(201), 'request\nwith-control']) {
      const invalidRequest = await fetch(`${server.baseUrl}/api/team/send`, {
        body: JSON.stringify({
          from_agent_id: orchestratorId,
          project_id: workspace.id,
          queue: true,
          request_id: invalidRequestId,
          text: 'Must not persist an invalid request',
          to: 'Alice',
          token: orchestratorToken,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      expect(invalidRequest.status).toBe(400)
      await expect(invalidRequest.json()).resolves.toMatchObject({
        code: 'invalid_dispatch_request',
      })
    }
    const longTask = 'x'.repeat(50_001)
    const longTaskResponse = await fetch(`${server.baseUrl}/api/team/send`, {
      body: JSON.stringify({
        artifacts: ['src/long-task.ts'],
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        queue: true,
        request_id: 'long-dispatch-request',
        text: longTask,
        to: 'Alice',
        token: orchestratorToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(longTaskResponse.status, await longTaskResponse.clone().text()).toBe(202)
    const longTaskReceipt = (await longTaskResponse.json()) as { dispatch_id: string }

    const dispatches = server.store.listDispatches(workspace.id)
    expect(dispatches).toHaveLength(2)
    expect(dispatches[0]).toEqual(
      expect.objectContaining({
        fromAgentId: orchestratorId,
        artifacts: ['src/auth.ts', 'tests/auth.test.ts'],
        id: receipt.dispatch_id,
        status: 'queued',
        text: 'Implement login validation',
        toAgentId: worker.id,
      })
    )
    expect(dispatches[1]).toEqual(
      expect.objectContaining({
        artifacts: ['src/long-task.ts'],
        id: longTaskReceipt.dispatch_id,
        status: 'queued',
      })
    )
    expect(dispatches[1]?.text).toHaveLength(longTask.length)
    expect(server.store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: null,
      processState: 'stopped',
      queuedDispatchCount: 2,
    })
    expect(server.store.getActiveRunByAgentId(workspace.id, worker.id)).toBeUndefined()
  }, 30_000)
})
