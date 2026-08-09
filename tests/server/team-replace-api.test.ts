import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'

describe('team replace API', () => {
  let server: Awaited<ReturnType<typeof startTestServer>> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  test('atomically replaces a queued Dispatch in its FIFO position without PTY input', async () => {
    server = await startTestServer()
    mkdirSync(join(server.dataDir, 'src'), { recursive: true })
    writeFileSync(join(server.dataDir, 'src', 'replacement.ts'), 'export const fixed = true\n')
    const workspace = server.store.createWorkspace(server.dataDir, 'Queued Replace')
    const orchestratorId = `${workspace.id}:orchestrator`
    const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
    const first = await server.store.dispatchTask(workspace.id, worker.id, 'First queued task')
    const replaced = await server.store.dispatchTask(workspace.id, worker.id, 'Incorrect task')
    const third = await server.store.dispatchTask(workspace.id, worker.id, 'Third queued task')
    server.store.configureAgentLaunch(workspace.id, orchestratorId, {
      args: ['-e', 'process.stdin.resume()'],
      command: process.execPath,
      provider: 'codex',
    })
    await server.store.startAgent(workspace.id, orchestratorId, {
      hivePort: server.baseUrl.split(':').at(-1) ?? '',
      suppressStartupInstructions: true,
    })
    const token = server.store.peekAgentToken(orchestratorId)
    if (!token) throw new Error('Expected Orchestrator token')

    const response = await fetch(`${server.baseUrl}/api/team/replace`, {
      body: JSON.stringify({
        artifacts: ['src/replacement.ts'],
        dispatch_id: replaced.id,
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        request_id: 'replace-queued-request',
        text: 'Corrected task',
        token,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status, await response.clone().text()).toBe(202)
    const receipt = (await response.json()) as {
      dispatch_id: string
      ok: true
      replaced_dispatch_id: string
      request_id: string
    }
    expect(receipt).toMatchObject({
      dispatch_id: expect.any(String),
      ok: true,
      replaced_dispatch_id: replaced.id,
      request_id: 'replace-queued-request',
    })

    expect(server.store.listDispatches(workspace.id)).toEqual([
      expect.objectContaining({ id: first.id, status: 'queued', text: 'First queued task' }),
      expect.objectContaining({
        id: replaced.id,
        replacedBy: receipt.dispatch_id,
        status: 'replaced',
        text: 'Incorrect task',
      }),
      expect.objectContaining({
        artifacts: ['src/replacement.ts'],
        id: receipt.dispatch_id,
        replacesDispatchId: replaced.id,
        status: 'queued',
        text: 'Corrected task',
      }),
      expect.objectContaining({ id: third.id, status: 'queued', text: 'Third queued task' }),
    ])
    expect(server.store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: null,
      processState: 'stopped',
      queuedDispatchCount: 3,
    })
    expect(server.store.getActiveRunByAgentId(workspace.id, worker.id)).toBeUndefined()

    rmSync(join(server.dataDir, 'src', 'replacement.ts'))
    const retry = await fetch(`${server.baseUrl}/api/team/replace`, {
      body: JSON.stringify({
        artifacts: ['src/replacement.ts'],
        dispatch_id: replaced.id,
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        request_id: 'replace-queued-request',
        text: 'Corrected task',
        token,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(retry.status).toBe(202)
    await expect(retry.json()).resolves.toMatchObject(receipt)
    expect(server.store.listDispatches(workspace.id)).toHaveLength(4)

    const conflict = await fetch(`${server.baseUrl}/api/team/replace`, {
      body: JSON.stringify({
        artifacts: ['src/replacement.ts'],
        dispatch_id: replaced.id,
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        request_id: 'replace-queued-request',
        text: 'Conflicting corrected task',
        token,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ code: 'dispatch_request_conflict' })

    const lateNote = await fetch(`${server.baseUrl}/api/team/note`, {
      body: JSON.stringify({
        dispatch_id: replaced.id,
        from_agent_id: orchestratorId,
        note_id: 'late-note-for-replaced',
        project_id: workspace.id,
        text: 'This must not mutate replaced history',
        token,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(lateNote.status).toBe(409)
    await expect(lateNote.json()).resolves.toMatchObject({ code: 'dispatch_terminal' })
    expect(() =>
      server?.store.reportTask(workspace.id, worker.id, {
        requestId: 'report-after-queued-replace',
        text: 'Cannot report a replaced or queued Dispatch',
      })
    ).toThrowError(expect.objectContaining({ code: 'no_active_dispatch' }))
  })
})
