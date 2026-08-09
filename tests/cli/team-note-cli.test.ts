import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { runTeamCommand } from '../../src/cli/team.js'
import { startTestServer } from '../helpers/test-server.js'

const originalEnv = { ...process.env }

describe('team note CLI', () => {
  let server: Awaited<ReturnType<typeof startTestServer>> | undefined
  let workspacePath = ''
  let workspaceId = ''
  let workerId = ''
  let dispatchId = ''

  beforeEach(async () => {
    server = await startTestServer()
    workspacePath = mkdtempSync(join(tmpdir(), 'yive-team-note-cli-'))
    mkdirSync(join(workspacePath, 'src'), { recursive: true })
    writeFileSync(join(workspacePath, 'src', 'auth.ts'), 'export const auth = true\n', 'utf8')
    const workspace = server.store.createWorkspace(workspacePath, 'CLI Notes')
    workspaceId = workspace.id
    const orchestratorId = `${workspace.id}:orchestrator`
    const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
    workerId = worker.id
    const launchConfig = {
      args: ['-e', 'process.stdin.resume()'],
      command: process.execPath,
      provider: 'codex' as const,
    }
    server.store.configureAgentLaunch(workspace.id, orchestratorId, launchConfig)
    server.store.configureAgentLaunch(workspace.id, worker.id, launchConfig)
    await server.store.startAgent(workspace.id, orchestratorId, {
      hivePort: new URL(server.baseUrl).port,
      suppressStartupInstructions: true,
    })
    await server.store.startAgent(workspace.id, worker.id, {
      hivePort: new URL(server.baseUrl).port,
      suppressStartupInstructions: true,
    })
    const dispatch = await server.store.dispatchTask(workspace.id, worker.id, 'Implement login')
    dispatchId = dispatch.id
    const token = server.store.peekAgentToken(orchestratorId)
    if (!token) throw new Error('Expected Orchestrator token')
    process.env = {
      ...originalEnv,
      HIVE_AGENT_ID: orchestratorId,
      HIVE_AGENT_TOKEN: token,
      HIVE_PORT: new URL(server.baseUrl).port,
      HIVE_PROJECT_ID: workspace.id,
    }
  })

  afterEach(async () => {
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
    await server?.close()
    server = undefined
    rmSync(workspacePath, { force: true, recursive: true })
  })

  test('removes forced delivery and explicit acknowledgement from the public contract', async () => {
    await expect(
      runTeamCommand(['note', '--dispatch', dispatchId, 'Check auth flow', '--force'])
    ).rejects.toThrow('Unknown argument: --force')

    await expect(
      runTeamCommand(['note', 'ack', '--note', 'note-1', '--dispatch', dispatchId])
    ).rejects.toThrow('Unknown argument: --note')

    process.env.HIVE_AGENT_ID = workerId
    const workerToken = server?.store.peekAgentToken(workerId)
    if (!workerToken) throw new Error('Expected Worker token')
    const acknowledgement = await fetch(`${server?.baseUrl}/api/team/note/ack`, {
      body: JSON.stringify({
        dispatch_id: dispatchId,
        from_agent_id: workerId,
        note_id: 'note-1',
        project_id: workspaceId,
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(acknowledgement.status).toBe(404)
  })

  test('appends a safe-boundary Note through the real CLI and runtime', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runTeamCommand([
      'note',
      '--dispatch',
      dispatchId,
      'Check auth flow',
      '--artifact',
      'src/auth.ts',
    ])

    const appendPayload = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      note: { artifacts: string[]; delivery_state: string; id: string }
      ok: true
    }
    expect(appendPayload).toMatchObject({
      note: {
        artifacts: ['src/auth.ts'],
        delivery_state: 'queued',
        id: expect.any(String),
      },
      ok: true,
    })
    expect(server?.store.listDispatches(workspaceId)).toHaveLength(1)

    expect(server?.store.listDispatchNotes(workspaceId, dispatchId)).toEqual([
      expect.objectContaining({ deliveryState: 'queued' }),
    ])
  })

  test('reuses the Note id when the accepted response is lost in transport', async () => {
    const originalFetch = globalThis.fetch
    const noteIds: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await originalFetch(input, init)
      if (String(input).endsWith('/api/team/note') && typeof init?.body === 'string') {
        noteIds.push((JSON.parse(init.body) as { note_id: string }).note_id)
        if (noteIds.length === 1) throw new Error('accepted response was lost')
      }
      return response
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runTeamCommand(['note', '--dispatch', dispatchId, 'Check auth flow'])

    expect(noteIds).toHaveLength(2)
    expect(new Set(noteIds).size).toBe(1)
    expect(server?.store.listDispatchNotes(workspaceId, dispatchId)).toEqual([
      expect.objectContaining({ id: noteIds[0], text: 'Check auth flow' }),
    ])
  })
})
