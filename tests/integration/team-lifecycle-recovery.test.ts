import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { runTeamCommand } from '../../src/cli/team.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { writeProviderAdapterFixture } from '../helpers/provider-adapter-fixture.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const originalCodexHome = process.env.CODEX_HOME
const originalEnv = { ...process.env }
const tempDirs: string[] = []
let server: Awaited<ReturnType<typeof startTestServer>> | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  process.env = { ...originalEnv }
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  vi.restoreAllMocks()
  for (const directory of tempDirs.splice(0)) rmSync(directory, { force: true, recursive: true })
})

const waitFor = async (assertion: () => void | Promise<void>, timeoutMs = 5_000) => {
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

const normalizePastedInput = (text: string) => {
  const pasteStart = '\u001b[200~'
  const pasteEnd = '\u001b[201~'
  const withoutStart = text.startsWith(pasteStart) ? text.slice(pasteStart.length) : text
  return withoutStart.endsWith(pasteEnd) ? withoutStart.slice(0, -pasteEnd.length) : withoutStart
}

const setupLifecycleWorkspace = async (
  input: { advanceSessionOnResume?: boolean; managedOrchestrator?: boolean } = {}
) => {
  const root = mkdtempSync(join(tmpdir(), 'yive-team-lifecycle-'))
  tempDirs.push(root)
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  process.env.CODEX_HOME = join(root, 'codex-home')
  process.env.HIVE_CLAUDE_PROJECTS_DIR = join(root, 'claude-projects')
  const providerFixture = writeProviderAdapterFixture({
    advanceSessionOnResume: input.advanceSessionOnResume,
    fixtureId: 'team-lifecycle',
    provider: 'codex',
    root,
    workspacePath,
  })
  const orchestratorFixture = input.managedOrchestrator
    ? writeProviderAdapterFixture({
        fixtureId: 'team-lifecycle-orchestrator',
        provider: 'claude',
        root,
        workspacePath,
      })
    : null
  server = await startTestServer({ dataDir: join(root, 'data') })
  const workspace = server.store.createWorkspace(workspacePath, 'Team lifecycle')
  const orchestratorId = `${workspace.id}:orchestrator`
  const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
  server.store.configureAgentLaunch(workspace.id, worker.id, {
    ...buildManagedProviderLaunchConfig('codex'),
    args: [],
    command: providerFixture.command,
    interactiveCommand: providerFixture.command,
  })
  server.store.configureAgentLaunch(workspace.id, orchestratorId, {
    ...(orchestratorFixture
      ? {
          ...buildManagedProviderLaunchConfig('claude'),
          args: [],
          command: orchestratorFixture.command,
          interactiveCommand: orchestratorFixture.command,
        }
      : { args: ['-e', 'process.stdin.resume()'], command: process.execPath }),
    provider: orchestratorFixture ? 'claude' : 'codex',
  })
  await server.store.startAgent(workspace.id, orchestratorId, {
    hivePort: new URL(server.baseUrl).port,
    suppressStartupInstructions: !orchestratorFixture,
  })
  const token = server.store.peekAgentToken(orchestratorId)
  if (!token) throw new Error('Expected Orchestrator token')
  if (orchestratorFixture) {
    await waitFor(() => {
      server?.store.refreshAgentSessionBinding(workspace.id, orchestratorId)
      expect(server?.store.getCurrentAgentConversation(workspace.id, orchestratorId)).toMatchObject(
        {
          activity_state: 'idle',
          cli_session_id: orchestratorFixture.sessionId,
        }
      )
    })
  }
  return { orchestratorFixture, orchestratorId, providerFixture, token, worker, workspace }
}

describe('Team lifecycle recovery', () => {
  test('starts a configured stopped Worker through authenticated Team HTTP', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } =
      await setupLifecycleWorkspace()
    if (!server) throw new Error('Expected test server')
    expect(server.store.getAgentState(workspace.id, worker.id).processState).toBe('stopped')

    const response = await fetch(`${server.baseUrl}/api/team/start`, {
      body: JSON.stringify({
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        token,
        worker: worker.name,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status, await response.clone().text()).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      agent_id: worker.id,
      ok: true,
      process_state: 'running',
      resumed_session_id: null,
      run_id: expect.any(String),
    })
    await waitFor(() => {
      expect(server?.store.getCurrentAgentConversation(workspace.id, worker.id)).toMatchObject({
        activity_state: 'idle',
        cli_session_id: providerFixture.sessionId,
      })
    })
  })

  test('serializes concurrent Team start requests into one Worker process', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } =
      await setupLifecycleWorkspace()
    if (!server) throw new Error('Expected test server')
    const start = () =>
      fetch(`${server?.baseUrl}/api/team/start`, {
        body: JSON.stringify({
          from_agent_id: orchestratorId,
          project_id: workspace.id,
          token,
          worker: worker.name,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

    const responses = await Promise.all([start(), start()])
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409])
    const conflict = responses.find((response) => response.status === 409)
    await expect(conflict?.json()).resolves.toMatchObject({
      code: 'worker_lifecycle_conflict',
    })
    await waitFor(() => {
      expect(
        providerFixture.readEvents().filter((event) => event.kind === 'launch_invocation')
      ).toHaveLength(1)
    })
  })

  test('restarts a crashed Worker by resuming its verified Provider Session', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } =
      await setupLifecycleWorkspace({ advanceSessionOnResume: false })
    if (!server) throw new Error('Expected test server')

    const startResponse = await fetch(`${server.baseUrl}/api/team/start`, {
      body: JSON.stringify({
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        token,
        worker: worker.name,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(startResponse.status, await startResponse.clone().text()).toBe(201)
    await waitFor(() => {
      expect(server?.store.getCurrentAgentConversation(workspace.id, worker.id)).toMatchObject({
        activity_state: 'idle',
        cli_session_id: providerFixture.sessionId,
      })
    })

    providerFixture.crash()
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).processState).toBe('crashed')
    })
    providerFixture.clearCrash()
    const restartEventBoundary = providerFixture.readEvents().length

    const restartResponse = await fetch(`${server.baseUrl}/api/team/restart`, {
      body: JSON.stringify({
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        token,
        worker: worker.name,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(restartResponse.status, await restartResponse.clone().text()).toBe(201)
    await expect(restartResponse.json()).resolves.toMatchObject({
      agent_id: worker.id,
      ok: true,
      process_state: 'running',
      resumed_session_id: providerFixture.sessionId,
      run_id: expect.any(String),
    })
    await waitFor(() => {
      expect(providerFixture.readEvents()).toContainEqual({
        kind: 'native_resume',
        sessionId: providerFixture.sessionId,
      })
      expect(server?.store.getCurrentAgentConversation(workspace.id, worker.id)).toMatchObject({
        activity_state: 'idle',
        cli_session_id: providerFixture.sessionId,
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(
      providerFixture
        .readEvents()
        .slice(restartEventBoundary)
        .filter((event) => event.kind === 'stdin')
    ).toEqual([])
  })

  test('safely stops an idle Worker with no Dispatch responsibility', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } =
      await setupLifecycleWorkspace()
    if (!server) throw new Error('Expected test server')

    const startResponse = await fetch(`${server.baseUrl}/api/team/start`, {
      body: JSON.stringify({
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        token,
        worker: worker.name,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(startResponse.status, await startResponse.clone().text()).toBe(201)
    const started = (await startResponse.json()) as { run_id: string }
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id)).toMatchObject({
        activeDispatchId: null,
        conversationActivity: 'idle',
        processState: 'running',
        queuedDispatchCount: 0,
      })
    })

    const stopResponse = await fetch(`${server.baseUrl}/api/team/stop`, {
      body: JSON.stringify({
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        token,
        worker: worker.name,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(stopResponse.status, await stopResponse.clone().text()).toBe(200)
    await expect(stopResponse.json()).resolves.toMatchObject({
      agent_id: worker.id,
      ok: true,
      process_state: 'stopped',
      run_id: started.run_id,
      session_id: providerFixture.sessionId,
    })
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).processState).toBe('stopped')
    })
  })

  test('rejects Team stop for queued, busy, active, unknown, or Worker-owned requests', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } =
      await setupLifecycleWorkspace()
    if (!server) throw new Error('Expected test server')
    const post = (
      path: string,
      body: Record<string, unknown>,
      identity: { agentId: string; token: string } = { agentId: orchestratorId, token }
    ) =>
      fetch(`${server?.baseUrl}${path}`, {
        body: JSON.stringify({
          from_agent_id: identity.agentId,
          project_id: workspace.id,
          token: identity.token,
          ...body,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    const expectConflict = async (response: Response, code: string) => {
      expect(response.status, await response.clone().text()).toBe(409)
      await expect(response.json()).resolves.toMatchObject({ code })
      expect(server?.store.getAgentState(workspace.id, worker.id).processState).toBe('running')
    }

    const start = await post('/api/team/start', { worker: worker.name })
    expect(start.status, await start.clone().text()).toBe(201)
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('idle')
    })

    const queued = await post('/api/team/send', {
      queue: true,
      request_id: 'stop-queued',
      text: 'Queued stop blocker',
      to: worker.name,
    })
    expect(queued.status, await queued.clone().text()).toBe(202)
    const queuedDispatch = (await queued.json()) as { dispatch_id: string }
    await expectConflict(
      await post('/api/team/stop', { worker: worker.name }),
      'worker_lifecycle_conflict'
    )
    const cancelQueued = await post('/api/team/cancel', {
      dispatch_id: queuedDispatch.dispatch_id,
      reason: 'Clear queued stop fixture',
      request_id: 'stop-cancel-queued',
    })
    expect(cancelQueued.status, await cancelQueued.clone().text()).toBe(202)

    providerFixture.appendUser('Provider remains busy')
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('busy')
    })
    await expectConflict(
      await post('/api/team/stop', { worker: worker.name }),
      'worker_conversation_busy'
    )
    providerFixture.appendCompletion()
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('idle')
    })

    const active = await post('/api/team/send', {
      request_id: 'stop-active',
      text: 'Active stop blocker',
      to: worker.name,
    })
    expect(active.status, await active.clone().text()).toBe(202)
    const activeDispatch = (await active.json()) as { dispatch_id: string }
    await expectConflict(
      await post('/api/team/stop', { worker: worker.name }),
      'worker_lifecycle_conflict'
    )
    const workerToken = server.store.peekAgentToken(worker.id)
    if (!workerToken) throw new Error('Expected Worker token')
    const forbidden = await post(
      '/api/team/restart',
      { worker: worker.name },
      { agentId: worker.id, token: workerToken }
    )
    expect(forbidden.status, await forbidden.clone().text()).toBe(403)
    await expect(forbidden.json()).resolves.toMatchObject({ code: 'team_command_forbidden' })

    const cancelActive = await post('/api/team/cancel', {
      dispatch_id: activeDispatch.dispatch_id,
      reason: 'Clear active stop fixture',
      request_id: 'stop-cancel-active',
    })
    expect(cancelActive.status, await cancelActive.clone().text()).toBe(202)
    rmSync(providerFixture.sessionPath, { force: true })
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe(
        'unknown'
      )
    })
    await expectConflict(
      await post('/api/team/stop', { worker: worker.name }),
      'worker_conversation_unknown'
    )
  })

  test('rejects Team start when a stopped Worker still owns Dispatch responsibility', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } =
      await setupLifecycleWorkspace()
    if (!server) throw new Error('Expected test server')
    const postTeam = (path: string, body: Record<string, unknown>) =>
      fetch(`${server?.baseUrl}${path}`, {
        body: JSON.stringify({
          from_agent_id: orchestratorId,
          project_id: workspace.id,
          token,
          ...body,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

    const startResponse = await postTeam('/api/team/start', { worker: worker.name })
    expect(startResponse.status, await startResponse.clone().text()).toBe(201)
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('idle')
    })
    const dispatchResponse = await postTeam('/api/team/send', {
      request_id: 'stopped-worker-active',
      text: 'Preserve this responsibility while stopped',
      to: worker.name,
    })
    expect(dispatchResponse.status, await dispatchResponse.clone().text()).toBe(202)
    const dispatch = (await dispatchResponse.json()) as { dispatch_id: string }
    const activeRun = server.store.getActiveRunByAgentId(workspace.id, worker.id)
    if (!activeRun) throw new Error('Expected active Worker run')
    await expect(
      server.store.stopAgentRunSafely(activeRun.runId, { mode: 'force' })
    ).resolves.toMatchObject({ state: 'stopped' })
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id)).toMatchObject({
        activeDispatchId: dispatch.dispatch_id,
        processState: 'stopped',
      })
    })
    const launchBoundary = providerFixture
      .readEvents()
      .filter((event) => event.kind === 'launch_invocation').length

    const rejectedStart = await postTeam('/api/team/start', { worker: worker.name })
    expect(rejectedStart.status, await rejectedStart.clone().text()).toBe(409)
    await expect(rejectedStart.json()).resolves.toMatchObject({
      code: 'worker_lifecycle_conflict',
    })
    expect(
      providerFixture.readEvents().filter((event) => event.kind === 'launch_invocation')
    ).toHaveLength(launchBoundary)
    expect(server.store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: dispatch.dispatch_id,
      processState: 'stopped',
    })
  })

  test('controls Worker lifecycle through the real Team CLI and Runtime', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } =
      await setupLifecycleWorkspace()
    if (!server) throw new Error('Expected test server')
    process.env = {
      ...process.env,
      HIVE_AGENT_ID: orchestratorId,
      HIVE_AGENT_TOKEN: token,
      HIVE_PORT: new URL(server.baseUrl).port,
      HIVE_PROJECT_ID: workspace.id,
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runTeamCommand(['start', worker.name])
    await waitFor(() => {
      expect(server?.store.getCurrentAgentConversation(workspace.id, worker.id)).toMatchObject({
        activity_state: 'idle',
        cli_session_id: providerFixture.sessionId,
      })
    })
    await runTeamCommand(['stop', worker.name])
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).processState).toBe('stopped')
    })
    await runTeamCommand(['restart', worker.name])

    expect(log).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(log.mock.calls[2]?.[0]))).toMatchObject({
      agent_id: worker.id,
      process_state: 'running',
      resumed_session_id: providerFixture.sessionId,
    })
    await waitFor(() => {
      expect(providerFixture.readEvents()).toContainEqual({
        kind: 'native_resume',
        sessionId: providerFixture.sessionId,
      })
    })
  })

  test('preserves work and emits one event without restarting a crashed Worker', async () => {
    const { orchestratorFixture, orchestratorId, providerFixture, token, worker, workspace } =
      await setupLifecycleWorkspace({ managedOrchestrator: true })
    if (!server || !orchestratorFixture) throw new Error('Expected managed test runtime')

    const startResponse = await fetch(`${server.baseUrl}/api/team/start`, {
      body: JSON.stringify({
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        token,
        worker: worker.name,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(startResponse.status, await startResponse.clone().text()).toBe(201)
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('idle')
    })

    const send = (text: string, queue: boolean) =>
      fetch(`${server?.baseUrl}/api/team/send`, {
        body: JSON.stringify({
          from_agent_id: orchestratorId,
          project_id: workspace.id,
          queue,
          request_id: `crash-${queue ? 'queued' : 'active'}`,
          text,
          to: worker.name,
          token,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    const activeResponse = await send('Preserve active crash task', false)
    expect(activeResponse.status, await activeResponse.clone().text()).toBe(202)
    const active = (await activeResponse.json()) as { dispatch_id: string }
    const queuedResponse = await send('Preserve queued crash task', true)
    expect(queuedResponse.status, await queuedResponse.clone().text()).toBe(202)
    const launchesBeforeCrash = providerFixture
      .readEvents()
      .filter((event) => event.kind === 'launch_invocation').length

    providerFixture.crash()

    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id)).toMatchObject({
        activeDispatchId: active.dispatch_id,
        processState: 'crashed',
        queuePauseReason: 'worker_crashed',
        queuedDispatchCount: 1,
      })
    })
    const cookie = await getUiCookie(server.baseUrl)
    const desktopTeam = await fetch(`${server.baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
      headers: { cookie },
    })
    expect(desktopTeam.status, await desktopTeam.clone().text()).toBe(200)
    await expect(desktopTeam.json()).resolves.toEqual([
      expect.objectContaining({
        active_dispatch_id: active.dispatch_id,
        id: worker.id,
        process_state: 'crashed',
        queue_pause_reason: 'worker_crashed',
        queued_dispatch_count: 1,
      }),
    ])
    const mobileSnapshot = await fetch(`${server.baseUrl}/api/mobile/snapshot`, {
      headers: { cookie },
    })
    expect(mobileSnapshot.status, await mobileSnapshot.clone().text()).toBe(200)
    await expect(mobileSnapshot.json()).resolves.toMatchObject({
      active_workspace: {
        workers: [
          expect.objectContaining({
            active_dispatch_id: active.dispatch_id,
            id: worker.id,
            process_state: 'crashed',
            queue_pause_reason: 'worker_crashed',
            queued_dispatch_count: 1,
          }),
        ],
      },
    })
    await waitFor(() => {
      const crashDeliveries = orchestratorFixture
        .readEvents()
        .filter(
          (event) =>
            event.kind === 'stdin' && event.text?.includes('Worker process crashed unexpectedly')
        )
      expect(crashDeliveries).toHaveLength(1)
      expect(crashDeliveries[0]?.text).toContain(`Dispatch: ${active.dispatch_id}`)
    })
    const crashPromptEvent = orchestratorFixture
      .readEvents()
      .find(
        (event) =>
          event.kind === 'stdin' && event.text?.includes('[Hive Team coordination events JSON]')
      )
    let crashPrompt = crashPromptEvent?.text ?? ''
    crashPrompt = normalizePastedInput(crashPrompt)
    const deliveryDb = new Database(join(server.dataDir, 'runtime.sqlite'))
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(
      deliveryDb
        .prepare("SELECT delivery_state FROM coordination_events WHERE kind = 'crash'")
        .get()
    ).toEqual({ delivery_state: 'delivering' })
    orchestratorFixture.appendUser(crashPrompt)
    orchestratorFixture.appendCompletion()
    await waitFor(() => {
      expect(
        deliveryDb
          .prepare("SELECT delivery_state FROM coordination_events WHERE kind = 'crash'")
          .get()
      ).toEqual({ delivery_state: 'delivered' })
    })
    deliveryDb.close()
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(
      providerFixture.readEvents().filter((event) => event.kind === 'launch_invocation')
    ).toHaveLength(launchesBeforeCrash)
  })

  test('reconciles an unfinished Worker run once after Runtime restart without autostart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yive-runtime-crash-recovery-'))
    tempDirs.push(root)
    const dataDir = join(root, 'data')
    server = await startTestServer({ dataDir })
    const workspace = server.store.createWorkspace(join(root, 'workspace'), 'Runtime recovery')
    const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
    const active = await server.store.dispatchTask(workspace.id, worker.id, 'Preserve active', {
      queue: true,
    })
    await server.store.dispatchTask(workspace.id, worker.id, 'Preserve queued', { queue: true })
    const runId = 'runtime-interrupted-run'
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.prepare(
      `UPDATE dispatches
       SET status = 'submitted', submitted_at = ?
       WHERE id = ?`
    ).run(Date.now(), active.id)
    db.prepare(
      `INSERT INTO agent_runs (
         run_id, agent_id, pid, status, process_state, exit_code,
         started_at, ended_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'running', 'running', NULL, ?, NULL, ?, ?)`
    ).run(runId, worker.id, 12345, 1, 1, 1)
    db.close()
    await server.close()
    server = undefined

    server = await startTestServer({ dataDir })
    expect(server.store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: active.id,
      processState: 'crashed',
      queuePauseReason: 'worker_crashed',
      queuedDispatchCount: 1,
    })
    expect(server.store.getActiveRunByAgentId(workspace.id, worker.id)).toBeUndefined()
    const recoveredDb = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    expect(
      recoveredDb
        .prepare(
          `SELECT kind, request_id, delivery_state
           FROM coordination_events WHERE worker_id = ?`
        )
        .all(worker.id)
    ).toEqual([
      {
        delivery_state: 'pending',
        kind: 'crash',
        request_id: `crash:${runId}`,
      },
    ])
    recoveredDb.close()
    await server.close()
    server = undefined

    server = await startTestServer({ dataDir })
    const reopenedDb = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    expect(
      reopenedDb
        .prepare(`SELECT COUNT(*) AS count FROM coordination_events WHERE kind = 'crash'`)
        .get()
    ).toEqual({ count: 1 })
    reopenedDb.close()
    expect(server.store.getActiveRunByAgentId(workspace.id, worker.id)).toBeUndefined()
  })

  test('persists Worker crash state, queue pause, and notification atomically', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } =
      await setupLifecycleWorkspace()
    if (!server) throw new Error('Expected test server')
    const postTeam = (path: string, body: Record<string, unknown>) =>
      fetch(`${server?.baseUrl}${path}`, {
        body: JSON.stringify({
          from_agent_id: orchestratorId,
          project_id: workspace.id,
          token,
          ...body,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

    const startResponse = await postTeam('/api/team/start', { worker: worker.name })
    expect(startResponse.status, await startResponse.clone().text()).toBe(201)
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('idle')
    })
    const dispatchResponse = await postTeam('/api/team/send', {
      request_id: 'atomic-crash-active',
      text: 'Preserve this responsibility across crash persistence failure',
      to: worker.name,
    })
    expect(dispatchResponse.status, await dispatchResponse.clone().text()).toBe(202)

    const db = new Database(join(server.dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TRIGGER fail_crash_event_insert
      BEFORE INSERT ON coordination_events
      WHEN NEW.kind = 'crash'
      BEGIN
        SELECT RAISE(ABORT, 'crash event write failed');
      END;
    `)
    providerFixture.crash()
    await waitFor(() => {
      expect(server?.store.getActiveRunByAgentId(workspace.id, worker.id)).toBeUndefined()
    })

    expect(
      db
        .prepare('SELECT process_state FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC')
        .get(worker.id)
    ).toEqual({ process_state: 'running' })
    expect(
      db.prepare('SELECT pause_reason FROM worker_queue_state WHERE worker_id = ?').get(worker.id)
    ).toBeUndefined()
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM coordination_events WHERE kind = 'crash'").get()
    ).toEqual({ count: 0 })
    expect(
      db
        .prepare(
          `SELECT process_state, status FROM agent_run_exit_intents
           WHERE run_id = (SELECT run_id FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC)`
        )
        .get(worker.id)
    ).toEqual({ process_state: 'crashed', status: 'error' })
    expect(server.store.getAgentState(workspace.id, worker.id)).toMatchObject({
      processState: 'crashed',
      queuePauseReason: 'worker_crashed',
    })

    db.exec('DROP TRIGGER fail_crash_event_insert')
    db.close()
    providerFixture.clearCrash()
    const restartResponse = await postTeam('/api/team/restart', { worker: worker.name })
    expect(restartResponse.status, await restartResponse.clone().text()).toBe(201)
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).processState).toBe('running')
    })
    const recoveredDb = new Database(join(server.dataDir, 'runtime.sqlite'), { readonly: true })
    expect(
      recoveredDb
        .prepare("SELECT COUNT(*) AS count FROM coordination_events WHERE kind = 'crash'")
        .get()
    ).toEqual({ count: 1 })
    expect(
      recoveredDb
        .prepare('SELECT pause_reason FROM worker_queue_state WHERE worker_id = ?')
        .get(worker.id)
    ).toEqual({ pause_reason: null })
    expect(
      recoveredDb.prepare('SELECT COUNT(*) AS count FROM agent_run_exit_intents').get()
    ).toEqual({ count: 0 })
    recoveredDb.close()
  })

  test('preserves a failed explicit stop through Runtime shutdown and retries it before start', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } =
      await setupLifecycleWorkspace()
    if (!server) throw new Error('Expected test server')
    const postTeam = (path: string, body: Record<string, unknown>) =>
      fetch(`${server?.baseUrl}${path}`, {
        body: JSON.stringify({
          from_agent_id: orchestratorId,
          project_id: workspace.id,
          token,
          ...body,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

    const startResponse = await postTeam('/api/team/start', { worker: worker.name })
    expect(startResponse.status, await startResponse.clone().text()).toBe(201)
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('idle')
    })

    const db = new Database(join(server.dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TRIGGER fail_stopped_run_persistence
      BEFORE UPDATE OF process_state ON agent_runs
      WHEN NEW.process_state = 'stopped'
      BEGIN
        SELECT RAISE(ABORT, 'stopped run persistence failed');
      END;
    `)
    const stopResponse = await postTeam('/api/team/stop', { worker: worker.name })
    expect(stopResponse.status, await stopResponse.clone().text()).toBe(200)
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).processState).toBe('stopped')
      expect(
        db
          .prepare('SELECT process_state FROM agent_run_exit_intents WHERE agent_id = ?')
          .get(worker.id)
      ).toEqual({ process_state: 'stopped' })
    })
    db.close()

    const dataDir = server.dataDir
    await server.close()
    server = await startTestServer({ dataDir })
    expect(server.store.getAgentState(workspace.id, worker.id).processState).toBe('stopped')

    const recoveredDb = new Database(join(dataDir, 'runtime.sqlite'))
    recoveredDb.exec('DROP TRIGGER fail_stopped_run_persistence')
    recoveredDb.close()
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      ...buildManagedProviderLaunchConfig('codex'),
      args: [],
      command: providerFixture.command,
      interactiveCommand: providerFixture.command,
    })
    const recoveredCookie = await getUiCookie(server.baseUrl)
    const recoveredStart = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${encodeURIComponent(worker.id)}/start`,
      { headers: { cookie: recoveredCookie }, method: 'POST' }
    )
    expect(recoveredStart.status, await recoveredStart.clone().text()).toBe(201)
    const verifiedDb = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    expect(
      verifiedDb.prepare('SELECT COUNT(*) AS count FROM agent_run_exit_intents').get()
    ).toEqual({ count: 0 })
    expect(
      verifiedDb
        .prepare(
          `SELECT process_state FROM agent_runs WHERE agent_id = ?
           ORDER BY started_at ASC LIMIT 1`
        )
        .get(worker.id)
    ).toEqual({ process_state: 'stopped' })
    verifiedDb.close()
  })

  test('serializes Team stop against concurrent Dispatch creation', async () => {
    const { orchestratorId, token, worker, workspace } = await setupLifecycleWorkspace()
    if (!server) throw new Error('Expected test server')
    const postTeam = (path: string, body: Record<string, unknown>) =>
      fetch(`${server?.baseUrl}${path}`, {
        body: JSON.stringify({
          from_agent_id: orchestratorId,
          project_id: workspace.id,
          token,
          ...body,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

    const startResponse = await postTeam('/api/team/start', { worker: worker.name })
    expect(startResponse.status, await startResponse.clone().text()).toBe(201)
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('idle')
    })

    const [stopResponse, sendResponse] = await Promise.all([
      postTeam('/api/team/stop', { worker: worker.name }),
      postTeam('/api/team/send', {
        request_id: 'concurrent-stop-send',
        text: 'This Dispatch may win the lifecycle lock',
        to: worker.name,
      }),
    ])
    const successCount = [stopResponse.status, sendResponse.status].filter((status) =>
      [200, 202].includes(status)
    ).length
    expect(successCount).toBe(1)
    expect([stopResponse.status, sendResponse.status]).toContain(409)

    const state = server.store.getAgentState(workspace.id, worker.id)
    if (stopResponse.status === 200) {
      expect(state).toMatchObject({ activeDispatchId: null, processState: 'stopped' })
    } else {
      expect(sendResponse.status, await sendResponse.clone().text()).toBe(202)
      expect(state).toMatchObject({
        activeDispatchId: expect.any(String),
        processState: 'running',
      })
    }
  })

  test('restores only the crashed Worker bounded responsibility after native resume', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } =
      await setupLifecycleWorkspace()
    if (!server) throw new Error('Expected test server')
    const postTeam = (path: string, body: Record<string, unknown>) =>
      fetch(`${server?.baseUrl}${path}`, {
        body: JSON.stringify({
          from_agent_id: orchestratorId,
          project_id: workspace.id,
          token,
          ...body,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

    const startResponse = await postTeam('/api/team/start', { worker: worker.name })
    expect(startResponse.status, await startResponse.clone().text()).toBe(201)
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('idle')
    })
    const activeResponse = await postTeam('/api/team/send', {
      request_id: 'recovery-active',
      text: 'Preserve active recovery task',
      to: worker.name,
    })
    expect(activeResponse.status, await activeResponse.clone().text()).toBe(202)
    const active = (await activeResponse.json()) as { dispatch_id: string }
    providerFixture.appendUser('Preserve active recovery task')
    providerFixture.appendCompletion()
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('idle')
    })
    const noteResponse = await postTeam('/api/team/note', {
      dispatch_id: active.dispatch_id,
      note_id: 'recovery-note',
      text: 'Preserve delivered recovery note',
    })
    expect(noteResponse.status, await noteResponse.clone().text()).toBe(201)
    await waitFor(() => {
      expect(server?.store.getDispatchNote(workspace.id, 'recovery-note')).toMatchObject({
        deliveryState: 'delivered',
      })
    })
    const workerToken = server.store.peekAgentToken(worker.id)
    if (!workerToken) throw new Error('Expected Worker token')
    const statusResponse = await fetch(`${server.baseUrl}/api/team/status`, {
      body: JSON.stringify({
        from_agent_id: worker.id,
        notify: false,
        project_id: workspace.id,
        request_id: 'recovery-status',
        result: 'Preserve latest recovery status',
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(statusResponse.status, await statusResponse.clone().text()).toBe(202)
    const queuedResponse = await postTeam('/api/team/send', {
      queue: true,
      request_id: 'recovery-queued',
      text: 'Preserve queued recovery task',
      to: worker.name,
    })
    expect(queuedResponse.status, await queuedResponse.clone().text()).toBe(202)
    const bob = server.store.addWorker(workspace.id, { name: 'Bob' })
    const bobQueueResponse = await postTeam('/api/team/send', {
      queue: true,
      request_id: 'bob-private-queued',
      text: 'Do not leak Bob private task',
      to: bob.name,
    })
    expect(bobQueueResponse.status, await bobQueueResponse.clone().text()).toBe(202)
    providerFixture.appendAssistant('Historical chat must not enter Runtime Context')

    providerFixture.crash()
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).processState).toBe('crashed')
    })
    providerFixture.clearCrash()
    const eventBoundary = providerFixture.readEvents().length
    const restartResponse = await postTeam('/api/team/restart', { worker: worker.name })
    expect(restartResponse.status, await restartResponse.clone().text()).toBe(201)

    await waitFor(() => {
      const recoveryInput = providerFixture
        .readEvents()
        .slice(eventBoundary)
        .filter((event) => event.kind === 'stdin')
        .map((event) => event.text ?? '')
        .join('')
      expect(recoveryInput).toContain('Current bounded Runtime Context:')
      expect(recoveryInput).toContain('Preserve active recovery task')
      expect(recoveryInput).toContain('Preserve delivered recovery note')
      expect(recoveryInput).toContain('Preserve latest recovery status')
      expect(recoveryInput).toContain('"queued_dispatch_count":1')
      expect(recoveryInput).not.toContain('Do not leak Bob private task')
      expect(recoveryInput).not.toContain('Historical chat must not enter Runtime Context')
    })
  })

  test('fails restart when the saved Provider Session source is missing', async () => {
    const { orchestratorId, token, worker, workspace } = await setupLifecycleWorkspace()
    if (!server) throw new Error('Expected test server')
    const sourceLossFixture = writeProviderAdapterFixture({
      fixtureId: 'team-lifecycle-source-loss',
      provider: 'claude',
      root: dirname(workspace.path),
      workspacePath: workspace.path,
    })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      ...buildManagedProviderLaunchConfig('claude'),
      args: [],
      command: sourceLossFixture.command,
      interactiveCommand: sourceLossFixture.command,
    })
    const postTeam = (path: string, body: Record<string, unknown>) =>
      fetch(`${server?.baseUrl}${path}`, {
        body: JSON.stringify({
          from_agent_id: orchestratorId,
          project_id: workspace.id,
          token,
          ...body,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

    const startResponse = await postTeam('/api/team/start', { worker: worker.name })
    expect(startResponse.status, await startResponse.clone().text()).toBe(201)
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('idle')
    })
    sourceLossFixture.crash()
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).processState).toBe('crashed')
    })
    sourceLossFixture.clearCrash()
    rmSync(sourceLossFixture.sessionPath, { force: true })

    const restartResponse = await postTeam('/api/team/restart', { worker: worker.name })
    expect(restartResponse.status, await restartResponse.clone().text()).toBe(409)
    await expect(restartResponse.json()).resolves.toMatchObject({
      code: 'worker_session_unverified',
    })
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).processState).not.toBe('running')
    })

    const cookie = await getUiCookie(server.baseUrl)
    const desktopStartResponse = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${encodeURIComponent(worker.id)}/start`,
      { headers: { cookie }, method: 'POST' }
    )
    expect(desktopStartResponse.status, await desktopStartResponse.clone().text()).toBe(409)
    await expect(desktopStartResponse.json()).resolves.toMatchObject({
      code: 'worker_session_unverified',
    })
    expect(server.store.getAgentState(workspace.id, worker.id).processState).not.toBe('running')
  })

  test('isolates a mismatched resumed Provider Session and allows a clean retry', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } =
      await setupLifecycleWorkspace()
    if (!server) throw new Error('Expected test server')
    const postTeam = (path: string, body: Record<string, unknown>) =>
      fetch(`${server?.baseUrl}${path}`, {
        body: JSON.stringify({
          from_agent_id: orchestratorId,
          project_id: workspace.id,
          token,
          ...body,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

    const startResponse = await postTeam('/api/team/start', { worker: worker.name })
    expect(startResponse.status, await startResponse.clone().text()).toBe(201)
    await waitFor(() => {
      expect(server?.store.getCurrentAgentConversation(workspace.id, worker.id)).toMatchObject({
        cli_session_id: providerFixture.sessionId,
      })
    })
    const activeResponse = await postTeam('/api/team/send', {
      request_id: 'mismatch-active',
      text: 'Responsibility must remain visible after mismatch',
      to: worker.name,
    })
    expect(activeResponse.status, await activeResponse.clone().text()).toBe(202)
    const active = (await activeResponse.json()) as { dispatch_id: string }
    providerFixture.crash()
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).processState).toBe('crashed')
    })

    const mismatchFixture = writeProviderAdapterFixture({
      fixtureId: 'team-lifecycle-mismatch',
      provider: 'codex',
      root: dirname(workspace.path),
      sessionId: '44444444-4444-4444-8444-444444444444',
      workspacePath: workspace.path,
    })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      ...buildManagedProviderLaunchConfig('codex'),
      args: [],
      command: mismatchFixture.command,
      interactiveCommand: mismatchFixture.command,
    })
    const mismatchBoundary = mismatchFixture.readEvents().length
    const restartResponse = await postTeam('/api/team/restart', { worker: worker.name })
    expect(restartResponse.status, await restartResponse.clone().text()).toBe(409)
    await expect(restartResponse.json()).resolves.toMatchObject({
      code: 'worker_session_unverified',
    })
    await waitFor(() => {
      expect(mismatchFixture.readEvents()).toContainEqual({
        kind: 'native_resume',
        sessionId: providerFixture.sessionId,
      })
      expect(server?.store.getAgentState(workspace.id, worker.id)).toMatchObject({
        activeDispatchId: active.dispatch_id,
        processState: 'stopped',
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const mismatchedInput = mismatchFixture
      .readEvents()
      .slice(mismatchBoundary)
      .filter((event) => event.kind === 'stdin')
      .map((event) => event.text ?? '')
      .join('')
    expect(mismatchedInput).not.toContain('Current bounded Runtime Context:')
    expect(mismatchedInput).not.toContain('Responsibility must remain visible after mismatch')

    const retryFixture = writeProviderAdapterFixture({
      fixtureId: 'team-lifecycle-mismatch-retry',
      provider: 'codex',
      root: dirname(workspace.path),
      sessionId: providerFixture.sessionId,
      workspacePath: workspace.path,
    })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      ...buildManagedProviderLaunchConfig('codex'),
      args: [],
      command: retryFixture.command,
      interactiveCommand: retryFixture.command,
    })
    const retryResponse = await postTeam('/api/team/restart', { worker: worker.name })
    expect(retryResponse.status, await retryResponse.clone().text()).toBe(201)
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id)).toMatchObject({
        activeDispatchId: active.dispatch_id,
        processState: 'running',
      })
      expect(retryFixture.readEvents()).toContainEqual({
        kind: 'native_resume',
        sessionId: providerFixture.sessionId,
      })
    })
  })

  test('does not inject an Orchestrator team dump when no Team state is active', async () => {
    const { orchestratorFixture, orchestratorId, workspace } = await setupLifecycleWorkspace({
      managedOrchestrator: true,
    })
    if (!server || !orchestratorFixture) throw new Error('Expected managed test runtime')
    const run = server.store.getActiveRunByAgentId(workspace.id, orchestratorId)
    if (!run) throw new Error('Expected active Orchestrator run')

    await expect(
      server.store.stopAgentRunSafely(run.runId, { mode: 'safe' })
    ).resolves.toMatchObject({
      state: 'stopped',
    })
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, orchestratorId).processState).toBe('stopped')
    })
    const eventBoundary = orchestratorFixture.readEvents().length
    const cookie = await getUiCookie(server.baseUrl)
    const restartResponse = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${encodeURIComponent(orchestratorId)}/start`,
      { headers: { cookie }, method: 'POST' }
    )
    expect(restartResponse.status, await restartResponse.clone().text()).toBe(201)
    await waitFor(() => {
      expect(
        orchestratorFixture
          .readEvents()
          .slice(eventBoundary)
          .filter((event) => event.kind === 'prompt_ready')
      ).toHaveLength(1)
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(
      orchestratorFixture
        .readEvents()
        .slice(eventBoundary)
        .filter((event) => event.kind === 'stdin')
    ).toEqual([])
  })

  test('does not write a coordination event before its durable delivery claim succeeds', async () => {
    const { orchestratorFixture, orchestratorId, providerFixture, token, worker, workspace } =
      await setupLifecycleWorkspace({ managedOrchestrator: true })
    if (!server || !orchestratorFixture) throw new Error('Expected managed test runtime')
    const postTeam = (path: string, body: Record<string, unknown>) =>
      fetch(`${server?.baseUrl}${path}`, {
        body: JSON.stringify({
          from_agent_id: orchestratorId,
          project_id: workspace.id,
          token,
          ...body,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

    const startWorker = await postTeam('/api/team/start', { worker: worker.name })
    expect(startWorker.status, await startWorker.clone().text()).toBe(201)
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('idle')
    })
    const orchestratorRun = server.store.getActiveRunByAgentId(workspace.id, orchestratorId)
    if (!orchestratorRun) throw new Error('Expected active Orchestrator run')
    await expect(
      server.store.stopAgentRunSafely(orchestratorRun.runId, { mode: 'force' })
    ).resolves.toMatchObject({ state: 'stopped' })
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, orchestratorId).processState).toBe('stopped')
    })
    providerFixture.crash()
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).processState).toBe('crashed')
    })

    const db = new Database(join(server.dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TRIGGER fail_coordination_delivery_commit
      BEFORE UPDATE OF delivery_state ON coordination_events
      WHEN NEW.delivery_state = 'delivering'
      BEGIN
        SELECT RAISE(ABORT, 'coordination delivery commit failed');
      END;
    `)
    const eventBoundary = orchestratorFixture.readEvents().length
    const cookie = await getUiCookie(server.baseUrl)
    const restart = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${encodeURIComponent(orchestratorId)}/start`,
      { headers: { cookie }, method: 'POST' }
    )
    expect(restart.status, await restart.clone().text()).toBe(201)
    await waitFor(() => {
      const row = db
        .prepare(
          `SELECT attempt_count, delivery_state FROM coordination_events
           WHERE kind = 'crash' AND worker_id = ?`
        )
        .get(worker.id) as { attempt_count: number; delivery_state: string }
      expect(row.attempt_count).toBe(0)
      expect(row.delivery_state).toBe('pending')
    })
    expect(
      orchestratorFixture
        .readEvents()
        .slice(eventBoundary)
        .filter(
          (event) =>
            event.kind === 'stdin' && event.text?.includes('[Yive Team coordination updates]')
        )
    ).toEqual([])

    const failedDeliveryRun = server.store.getActiveRunByAgentId(workspace.id, orchestratorId)
    if (!failedDeliveryRun) throw new Error('Expected restarted Orchestrator run')
    await expect(
      server.store.stopAgentRunSafely(failedDeliveryRun.runId, { mode: 'force' })
    ).resolves.toMatchObject({ state: 'stopped' })
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, orchestratorId).processState).toBe('stopped')
      expect(
        db.prepare("SELECT delivery_state FROM coordination_events WHERE kind = 'crash'").get()
      ).toEqual({ delivery_state: 'pending' })
    })

    db.exec('DROP TRIGGER fail_coordination_delivery_commit')
    db.close()
    const dataDir = server.dataDir
    await server.close()
    server = await startTestServer({ dataDir })
    server.store.configureAgentLaunch(workspace.id, orchestratorId, {
      ...buildManagedProviderLaunchConfig('claude'),
      args: [],
      command: orchestratorFixture.command,
      interactiveCommand: orchestratorFixture.command,
    })
    const recoveredCookie = await getUiCookie(server.baseUrl)
    const recoveredRestart = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${encodeURIComponent(orchestratorId)}/start`,
      { headers: { cookie: recoveredCookie }, method: 'POST' }
    )
    expect(recoveredRestart.status, await recoveredRestart.clone().text()).toBe(201)
    let recoveredPrompt = ''
    await waitFor(() => {
      const event = orchestratorFixture
        .readEvents()
        .slice(eventBoundary)
        .find(
          (candidate) =>
            candidate.kind === 'stdin' &&
            candidate.text?.includes('[Hive Team coordination events JSON]')
        )
      expect(event?.text).toBeTruthy()
      recoveredPrompt = normalizePastedInput(event?.text ?? '')
    })
    orchestratorFixture.appendUser(recoveredPrompt)
    orchestratorFixture.appendCompletion()
    await waitFor(() => {
      const recoveredDb = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
      const state = recoveredDb
        .prepare("SELECT delivery_state FROM coordination_events WHERE kind = 'crash'")
        .get()
      recoveredDb.close()
      expect(state).toEqual({ delivery_state: 'delivered' })
    })
    await waitFor(() => {
      expect(
        orchestratorFixture
          .readEvents()
          .slice(eventBoundary)
          .some(
            (event) =>
              event.kind === 'stdin' && event.text?.includes('Worker process crashed unexpectedly.')
          )
      ).toBe(true)
    })
  })

  test('reconciles an observed coordination event after Runtime exits before completion commit', async () => {
    const { orchestratorFixture, orchestratorId, providerFixture, token, worker, workspace } =
      await setupLifecycleWorkspace({ managedOrchestrator: true })
    if (!server || !orchestratorFixture) throw new Error('Expected managed test runtime')
    const postTeam = (path: string, body: Record<string, unknown>) =>
      fetch(`${server?.baseUrl}${path}`, {
        body: JSON.stringify({
          from_agent_id: orchestratorId,
          project_id: workspace.id,
          token,
          ...body,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

    const startWorker = await postTeam('/api/team/start', { worker: worker.name })
    expect(startWorker.status, await startWorker.clone().text()).toBe(201)
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('idle')
    })
    const orchestratorRun = server.store.getActiveRunByAgentId(workspace.id, orchestratorId)
    if (!orchestratorRun) throw new Error('Expected active Orchestrator run')
    await expect(
      server.store.stopAgentRunSafely(orchestratorRun.runId, { mode: 'force' })
    ).resolves.toMatchObject({ state: 'stopped' })
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, orchestratorId).processState).toBe('stopped')
    })
    providerFixture.crash()
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).processState).toBe('crashed')
    })

    const db = new Database(join(server.dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TRIGGER fail_coordination_delivery_completion
      BEFORE UPDATE OF delivery_state ON coordination_events
      WHEN NEW.delivery_state = 'delivered'
      BEGIN
        SELECT RAISE(ABORT, 'coordination completion commit failed');
      END;
    `)
    const firstDeliveryBoundary = orchestratorFixture.readEvents().length
    const cookie = await getUiCookie(server.baseUrl)
    const restart = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${encodeURIComponent(orchestratorId)}/start`,
      { headers: { cookie }, method: 'POST' }
    )
    expect(restart.status, await restart.clone().text()).toBe(201)

    let observedPrompt = ''
    await waitFor(() => {
      const event = orchestratorFixture
        .readEvents()
        .slice(firstDeliveryBoundary)
        .find(
          (candidate) =>
            candidate.kind === 'stdin' &&
            candidate.text?.includes('[Hive Team coordination events JSON]')
        )
      expect(event?.text).toBeTruthy()
      const pasteStart = '\u001b[200~'
      const pasteEnd = '\u001b[201~'
      observedPrompt = event?.text ?? ''
      if (observedPrompt.startsWith(pasteStart)) {
        observedPrompt = observedPrompt.slice(pasteStart.length)
      }
      if (observedPrompt.endsWith(pasteEnd)) {
        observedPrompt = observedPrompt.slice(0, -pasteEnd.length)
      }
    })
    orchestratorFixture.appendUser(observedPrompt)
    orchestratorFixture.appendCompletion()

    const failedDeliveryRun = server.store.getActiveRunByAgentId(workspace.id, orchestratorId)
    if (!failedDeliveryRun) throw new Error('Expected restarted Orchestrator run')
    await expect(
      server.store.stopAgentRunSafely(failedDeliveryRun.runId, { mode: 'force' })
    ).resolves.toMatchObject({ state: 'stopped' })
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, orchestratorId).processState).toBe('stopped')
    })
    db.exec('DROP TRIGGER fail_coordination_delivery_completion')
    await waitFor(() => {
      expect(
        db.prepare("SELECT delivery_state FROM coordination_events WHERE kind = 'crash'").get()
      ).toEqual({ delivery_state: 'delivering' })
    })
    db.close()

    const dataDir = server.dataDir
    await server.close()
    const recoveredBoundary = orchestratorFixture.readEvents().length
    server = await startTestServer({ dataDir })
    server.store.configureAgentLaunch(workspace.id, orchestratorId, {
      ...buildManagedProviderLaunchConfig('claude'),
      args: [],
      command: orchestratorFixture.command,
      interactiveCommand: orchestratorFixture.command,
    })
    const recoveredCookie = await getUiCookie(server.baseUrl)
    const recoveredRestart = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${encodeURIComponent(orchestratorId)}/start`,
      { headers: { cookie: recoveredCookie }, method: 'POST' }
    )
    expect(recoveredRestart.status, await recoveredRestart.clone().text()).toBe(201)
    await waitFor(() => {
      const recoveredDb = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
      const state = recoveredDb
        .prepare("SELECT delivery_state FROM coordination_events WHERE kind = 'crash'")
        .get()
      recoveredDb.close()
      expect(state).toEqual({ delivery_state: 'delivered' })
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(
      orchestratorFixture
        .readEvents()
        .slice(recoveredBoundary)
        .filter(
          (event) =>
            event.kind === 'stdin' && event.text?.includes('[Hive Team coordination events JSON]')
        )
    ).toEqual([])
  })

  test('restores bounded Team state and delivers an undelivered crash event exactly once', async () => {
    const { orchestratorFixture, orchestratorId, providerFixture, token, worker, workspace } =
      await setupLifecycleWorkspace({ managedOrchestrator: true })
    if (!server || !orchestratorFixture) throw new Error('Expected managed test runtime')
    const postTeam = (path: string, body: Record<string, unknown>) =>
      fetch(`${server?.baseUrl}${path}`, {
        body: JSON.stringify({
          from_agent_id: orchestratorId,
          project_id: workspace.id,
          token,
          ...body,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

    const startWorker = await postTeam('/api/team/start', { worker: worker.name })
    expect(startWorker.status, await startWorker.clone().text()).toBe(201)
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('idle')
    })
    const activeResponse = await postTeam('/api/team/send', {
      request_id: 'orchestrator-recovery-active',
      text: 'Orchestrator recovery first line\nPrivate later task detail',
      to: worker.name,
    })
    expect(activeResponse.status, await activeResponse.clone().text()).toBe(202)
    const active = (await activeResponse.json()) as { dispatch_id: string }
    providerFixture.appendUser('Orchestrator recovery first line\nPrivate later task detail')
    providerFixture.appendCompletion()
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('idle')
    })
    const workerToken = server.store.peekAgentToken(worker.id)
    if (!workerToken) throw new Error('Expected Worker token')
    const statusResponse = await fetch(`${server.baseUrl}/api/team/status`, {
      body: JSON.stringify({
        from_agent_id: worker.id,
        notify: false,
        project_id: workspace.id,
        request_id: 'orchestrator-recovery-status',
        result: 'Latest bounded Worker status',
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(statusResponse.status, await statusResponse.clone().text()).toBe(202)
    const queuedResponse = await postTeam('/api/team/send', {
      queue: true,
      request_id: 'orchestrator-recovery-queued',
      text: 'Queued task body stays out of Orchestrator snapshot',
      to: worker.name,
    })
    expect(queuedResponse.status, await queuedResponse.clone().text()).toBe(202)

    const orchestratorRun = server.store.getActiveRunByAgentId(workspace.id, orchestratorId)
    if (!orchestratorRun) throw new Error('Expected active Orchestrator run')
    await expect(
      server.store.stopAgentRunSafely(orchestratorRun.runId, { mode: 'force' })
    ).resolves.toMatchObject({ state: 'stopped' })
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, orchestratorId).processState).toBe('stopped')
    })
    const firstRestartBoundary = orchestratorFixture.readEvents().length
    providerFixture.crash()
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, worker.id)).toMatchObject({
        activeDispatchId: active.dispatch_id,
        processState: 'crashed',
        queuePauseReason: 'worker_crashed',
        queuedDispatchCount: 1,
      })
    })

    const dataDir = server.dataDir
    await server.close()
    server = await startTestServer({ dataDir })
    server.store.configureAgentLaunch(workspace.id, orchestratorId, {
      ...buildManagedProviderLaunchConfig('claude'),
      args: [],
      command: orchestratorFixture.command,
      interactiveCommand: orchestratorFixture.command,
    })
    expect(server.store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: active.dispatch_id,
      processState: 'crashed',
      queuePauseReason: 'worker_crashed',
      queuedDispatchCount: 1,
    })

    const cookie = await getUiCookie(server.baseUrl)
    const restartOrchestrator = () =>
      fetch(
        `${server?.baseUrl}/api/workspaces/${workspace.id}/agents/${encodeURIComponent(orchestratorId)}/start`,
        { headers: { cookie }, method: 'POST' }
      )
    const firstRestart = await restartOrchestrator()
    expect(firstRestart.status, await firstRestart.clone().text()).toBe(201)
    await waitFor(() => {
      const recoveryInput = orchestratorFixture
        .readEvents()
        .slice(firstRestartBoundary)
        .filter((event) => event.kind === 'stdin')
        .map((event) => event.text ?? '')
        .join('')
      expect(recoveryInput).toContain('Current bounded Runtime Context:')
      expect(recoveryInput).toContain(`"id":"${active.dispatch_id}"`)
      expect(recoveryInput).toContain('Orchestrator recovery first line')
      expect(recoveryInput).not.toContain('Private later task detail')
      expect(recoveryInput).toContain('Latest bounded Worker status')
      expect(recoveryInput).toContain('"queued_dispatch_count":1')
      expect(recoveryInput).toContain('"queue_pause_reason":"worker_crashed"')
      expect(recoveryInput.match(/Worker process crashed unexpectedly\./gu) ?? []).toHaveLength(1)
    })

    const launchesBeforeOrchestratorCrash = orchestratorFixture
      .readEvents()
      .filter((event) => event.kind === 'launch_invocation').length
    orchestratorFixture.crash()
    await waitFor(() => {
      expect(server?.store.getAgentState(workspace.id, orchestratorId).processState).toBe('crashed')
    })
    const crashedSnapshot = await fetch(`${server.baseUrl}/api/mobile/snapshot`, {
      headers: { cookie },
    })
    expect(crashedSnapshot.status, await crashedSnapshot.clone().text()).toBe(200)
    await expect(crashedSnapshot.json()).resolves.toMatchObject({
      active_workspace: {
        orchestrator: {
          id: orchestratorId,
          process_state: 'crashed',
        },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(
      orchestratorFixture.readEvents().filter((event) => event.kind === 'launch_invocation')
    ).toHaveLength(launchesBeforeOrchestratorCrash)
    orchestratorFixture.clearCrash()
    const secondRestartBoundary = orchestratorFixture.readEvents().length
    const secondRestart = await restartOrchestrator()
    expect(secondRestart.status, await secondRestart.clone().text()).toBe(201)
    await waitFor(() => {
      expect(
        orchestratorFixture
          .readEvents()
          .slice(secondRestartBoundary)
          .filter((event) => event.kind === 'prompt_ready')
      ).toHaveLength(1)
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    const secondRecoveryInput = orchestratorFixture
      .readEvents()
      .slice(secondRestartBoundary)
      .filter((event) => event.kind === 'stdin')
      .map((event) => event.text ?? '')
      .join('')
    expect(secondRecoveryInput).toContain('Current bounded Runtime Context:')
    expect(secondRecoveryInput).not.toContain('Worker process crashed unexpectedly.')
  })
})
