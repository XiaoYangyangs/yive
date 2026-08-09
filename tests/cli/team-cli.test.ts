import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runTeamCommand } from '../../src/cli/team.js'
import { startTestServer } from '../helpers/test-server.js'

let cleanupServer: (() => Promise<void>) | undefined
let serverStore: Awaited<ReturnType<typeof startTestServer>>['store'] | undefined
let workerId = ''
const describeWithRealPty = process.platform === 'win32' ? describe.skip : describe
const testWithRealPty = process.platform === 'win32' ? test.skip : test
const originalEnv = { ...process.env }

beforeEach(async () => {
  const server = await startTestServer()
  cleanupServer = server.close
  serverStore = server.store
  const uiSessionResponse = await fetch(`${server.baseUrl}/api/ui/session`)
  const uiCookie = uiSessionResponse.headers.get('set-cookie')
  if (!uiCookie) {
    throw new Error('Expected UI session cookie')
  }

  const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({
      autostart_orchestrator: false,
      name: 'Alpha',
      path: '/tmp/hive-alpha',
      provider: 'codex',
    }),
  })
  const workspace = (await workspaceResponse.json()) as { id: string }

  const orchestratorId = `${workspace.id}:orchestrator`
  process.env = {
    ...originalEnv,
    HIVE_AGENT_ID: orchestratorId,
    HIVE_AGENT_TOKEN: 'placeholder-replaced-after-start',
    HIVE_PORT: server.baseUrl.split(':').at(-1) ?? '',
    HIVE_PROJECT_ID: workspace.id,
  }

  await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ name: 'Alice' }),
  })

  const sessionResponse = await fetch(`${server.baseUrl}/api/ui/session`)
  const cookie = sessionResponse.headers.get('set-cookie')
  if (!cookie) {
    throw new Error('Expected UI session cookie')
  }
  const workerListResponse = await fetch(
    `${server.baseUrl}/api/ui/workspaces/${workspace.id}/team`,
    {
      headers: { cookie },
    }
  )
  const workers = (await workerListResponse.json()) as Array<{ id: string; name: string }>
  const alice = workers.find((worker) => worker.name === 'Alice')
  if (!alice) {
    throw new Error('Expected Alice worker')
  }
  workerId = alice.id

  for (const agentId of [orchestratorId, alice.id]) {
    server.store.configureAgentLaunch(workspace.id, agentId, {
      args: ['-e', 'process.stdin.resume()'],
      command: process.execPath,
      provider: 'codex',
    })
    await server.store.startAgent(workspace.id, agentId, {
      hivePort: process.env.HIVE_PORT ?? '',
      suppressStartupInstructions: true,
    })
  }

  const token = server.store.peekAgentToken(orchestratorId)
  if (!token) {
    throw new Error('Expected orchestrator token after start')
  }
  process.env.HIVE_AGENT_TOKEN = token
})

afterEach(async () => {
  vi.restoreAllMocks()
  process.env = { ...originalEnv }
  serverStore = undefined
  workerId = ''
  await cleanupServer?.()
  cleanupServer = undefined
})

describeWithRealPty('team cli with real server', () => {
  test('team list prints snake_case payload from a real backend', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['list'])

    const output = logSpy.mock.calls[0]?.[0] ?? ''
    const parsed = JSON.parse(output) as Array<{
      active_dispatch_id: string | null
      conversation_activity: 'busy' | 'idle' | 'unknown'
      conversation_provider: 'codex'
      id: string
      kind: 'worker'
      last_observed_at: number
      last_pty_line: string | null
      name: string
      process_state: 'crashed' | 'running' | 'stopped'
      provider: 'codex'
      queue_pause_reason: string | null
      queued_dispatch_count: number
    }>

    expect(parsed).toEqual([
      {
        active_dispatch_id: null,
        conversation_activity: 'unknown',
        conversation_provider: 'codex',
        id: expect.any(String),
        kind: 'worker',
        last_observed_at: expect.any(Number),
        last_pty_line: null,
        name: 'Alice',
        process_state: 'running',
        provider: 'codex',
        queue_pause_reason: null,
        queued_dispatch_count: 0,
      },
    ])
    expect(parsed[0]).not.toHaveProperty('status')
    expect(parsed[0]).not.toHaveProperty('pending_task_count')
    logSpy.mockRestore()
  })

  testWithRealPty('team send Alice reaches the real backend', async () => {
    if (!serverStore) {
      throw new Error('Expected test server store')
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(runTeamCommand(['send', 'Alice', 'Implement login'])).resolves.toBeUndefined()
    const output = logSpy.mock.calls[0]?.[0] ?? ''
    const parsed = JSON.parse(output) as {
      dispatch_id: string
      ok: true
      start_error?: string | null
      worker_started?: boolean
      worker_status?: string
    }
    expect(parsed).toEqual({
      dispatch_id: expect.any(String),
      ok: true,
    })
    logSpy.mockRestore()

    const workspaceId = process.env.HIVE_PROJECT_ID
    if (!workspaceId) {
      throw new Error('Expected workspace id')
    }

    expect(serverStore.getAgentState(workspaceId, workerId)).toMatchObject({
      activeDispatchId: parsed.dispatch_id,
      processState: 'running',
      queuedDispatchCount: 0,
    })
    expect(serverStore.listMessagesForRecovery(workspaceId, 0)).toContainEqual(
      expect.objectContaining({ type: 'send', to: workerId, text: 'Implement login' })
    )
  })

  testWithRealPty('team cancel --dispatch closes the selected dispatch', async () => {
    if (!serverStore) {
      throw new Error('Expected test server store')
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['send', 'Alice', 'Front-end scan'])
    const output = logSpy.mock.calls[0]?.[0] ?? ''
    const parsed = JSON.parse(output) as {
      dispatch_id: string
      ok: true
      start_error?: string | null
      worker_started?: boolean
      worker_status?: string
    }
    logSpy.mockRestore()

    await runTeamCommand([
      'cancel',
      '--dispatch',
      parsed.dispatch_id,
      'Direction changed; front-end scan is no longer needed',
    ])

    const workspaceId = process.env.HIVE_PROJECT_ID
    if (!workspaceId) {
      throw new Error('Expected workspace id')
    }
    expect(serverStore.listDispatches(workspaceId)).toEqual([
      expect.objectContaining({
        id: parsed.dispatch_id,
        reportText: 'Direction changed; front-end scan is no longer needed',
        status: 'cancelled',
      }),
    ])
    expect(serverStore.getAgentState(workspaceId, workerId)).toMatchObject({
      activeDispatchId: null,
      processState: 'running',
      queuedDispatchCount: 0,
    })
  })

  testWithRealPty(
    'team send joins unquoted task words instead of silently truncating',
    async () => {
      if (!serverStore) {
        throw new Error('Expected test server store')
      }
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await runTeamCommand(['send', 'Alice', 'Implement', 'multi', 'word', 'task'])
      logSpy.mockRestore()

      const workspaceId = process.env.HIVE_PROJECT_ID
      if (!workspaceId) {
        throw new Error('Expected workspace id')
      }
      expect(serverStore.listMessagesForRecovery(workspaceId, 0)).toContainEqual(
        expect.objectContaining({
          type: 'send',
          to: workerId,
          text: 'Implement multi word task',
        })
      )
    }
  )

  test('team report rejects an orchestrator token with the server error detail', async () => {
    if (!serverStore) {
      throw new Error('Expected test server store')
    }

    await expect(runTeamCommand(['report', 'orchestrator should not report'])).rejects.toThrow(
      "Request failed with status 403: Role 'orchestrator' is not allowed to run team report"
    )

    const workspaceId = process.env.HIVE_PROJECT_ID
    if (!workspaceId) {
      throw new Error('Expected workspace id')
    }

    expect(
      serverStore.listMessagesForRecovery(workspaceId, 0).filter((item) => item.type === 'report')
    ).toEqual([])
  })

  testWithRealPty('team report --dispatch reports the selected active dispatch', async () => {
    if (!serverStore) {
      throw new Error('Expected test server store')
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['send', 'Alice', 'Selected task'])
    const selectedDispatch = JSON.parse(logSpy.mock.calls[0]?.[0] ?? '{}') as {
      dispatch_id: string
    }
    logSpy.mockRestore()

    const workerToken = serverStore.peekAgentToken(workerId)
    if (!workerToken) {
      throw new Error('Expected worker token after start')
    }
    process.env.HIVE_AGENT_ID = workerId
    process.env.HIVE_AGENT_TOKEN = workerToken

    await runTeamCommand([
      'report',
      'Selected task done',
      '--dispatch',
      selectedDispatch.dispatch_id,
    ])

    const workspaceId = process.env.HIVE_PROJECT_ID
    if (!workspaceId) {
      throw new Error('Expected workspace id')
    }

    expect(serverStore.listDispatches(workspaceId)).toEqual([
      expect.objectContaining({
        id: selectedDispatch.dispatch_id,
        reportText: 'Selected task done',
        status: 'reported',
      }),
    ])
    expect(serverStore.getAgentState(workspaceId, workerId)).toMatchObject({
      activeDispatchId: null,
      queuedDispatchCount: 0,
    })
  })

  testWithRealPty('team list surfaces 403 when a worker token is used', async () => {
    if (!serverStore) {
      throw new Error('Expected test server store')
    }
    const workerToken = serverStore.peekAgentToken(workerId)
    if (!workerToken) {
      throw new Error('Expected worker token after start')
    }

    process.env.HIVE_AGENT_ID = workerId
    process.env.HIVE_AGENT_TOKEN = workerToken

    await expect(runTeamCommand(['list'])).rejects.toThrow('Request failed with status 403')
  })

  test('team list explains when the Hive runtime cannot be reached', async () => {
    process.env.HIVE_PORT = '9'

    await expect(runTeamCommand(['list'])).rejects.toThrow(
      'Failed to reach Hive runtime at http://127.0.0.1:9'
    )
  })
})
