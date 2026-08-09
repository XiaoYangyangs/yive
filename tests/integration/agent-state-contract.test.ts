import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'
import { writeProviderAdapterFixture } from '../helpers/provider-adapter-fixture.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const roots: string[] = []
const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const originalCodexHome = process.env.CODEX_HOME
const originalClaudeProjectsDir = process.env.HIVE_CLAUDE_PROJECTS_DIR

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  if (originalClaudeProjectsDir === undefined) delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  else process.env.HIVE_CLAUDE_PROJECTS_DIR = originalClaudeProjectsDir
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

const waitFor = async (assertion: () => Promise<void> | void, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw lastError
}

const readTeamMember = async (baseUrl: string, cookie: string, workspaceId: string) => {
  const response = await fetch(`${baseUrl}/api/ui/workspaces/${workspaceId}/team`, {
    headers: { cookie },
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as Array<Record<string, unknown>>
  expect(body).toHaveLength(1)
  return body[0] as Record<string, unknown>
}

describe.each(['codex', 'claude'] as const)('%s canonical Agent state', (provider) => {
  test('keeps process, conversation, and Dispatch responsibility independent', async () => {
    const root = mkdtempSync(join(tmpdir(), `yive-agent-state-${provider}-`))
    roots.push(root)
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    const fixture = writeProviderAdapterFixture({
      fixtureId: 'canonical-state',
      provider,
      root,
      workspacePath,
    })
    if (provider === 'codex') process.env.CODEX_HOME = join(root, 'codex-home')
    else process.env.HIVE_CLAUDE_PROJECTS_DIR = join(root, 'claude-projects')
    const server = await startTestServer({ dataDir: join(root, 'data') })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = server.store.createWorkspace(workspacePath, 'State Lab')
    const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      ...buildManagedProviderLaunchConfig(provider),
      args: [],
      command: fixture.command,
      interactiveCommand: fixture.command,
    })

    const start = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
      { headers: { cookie }, method: 'POST' }
    )
    expect(start.status).toBe(201)

    const readTeam = () => readTeamMember(server.baseUrl, cookie, workspace.id)

    await waitFor(async () => {
      const response = await fetch(
        `${server.baseUrl}/api/mobile/agents/${worker.id}/conversation?workspace_id=${workspace.id}`,
        { headers: { cookie } }
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        conversation: { cli_session_id?: string } | null
      }
      expect(body.conversation?.cli_session_id).toBe(fixture.sessionId)
    })

    const active = await server.store.dispatchTask(workspace.id, worker.id, 'Implement state', {
      fromAgentId: `${workspace.id}:orchestrator`,
      hivePort: new URL(server.baseUrl).port,
    })
    await server.store.dispatchTask(workspace.id, worker.id, 'Run follow-up checks')
    await waitFor(async () => {
      expect(await readTeam()).toMatchObject({
        active_dispatch_id: active.id,
        conversation_activity: 'idle',
        process_state: 'running',
        queue_pause_reason: null,
        queued_dispatch_count: 1,
      })
    })

    fixture.appendUser('first observed turn')
    fixture.appendAssistant('completed after the recording boundary')
    fixture.appendCompletion()
    await waitFor(async () => {
      expect(await readTeam()).toMatchObject({
        active_dispatch_id: active.id,
        conversation_activity: 'idle',
        process_state: 'running',
      })
    })

    fixture.appendUser('continue')
    fixture.appendAssistant('working')
    await waitFor(async () => {
      const state = await readTeam()
      expect(state).toMatchObject({
        active_dispatch_id: active.id,
        conversation_activity: 'busy',
        process_state: 'running',
      })
      expect(state.last_observed_at).toEqual(expect.any(Number))
      expect(state).not.toHaveProperty('status')
      expect(state).not.toHaveProperty('pending_task_count')
    })

    fixture.crash()
    await waitFor(async () => {
      expect(await readTeam()).toMatchObject({
        active_dispatch_id: active.id,
        conversation_activity: 'unknown',
        process_state: 'crashed',
        queue_pause_reason: 'worker_crashed',
        queued_dispatch_count: 1,
      })
    })
  })

  test('persists an explicit HTTP stop independently from conversation and Dispatch state', async () => {
    const root = mkdtempSync(join(tmpdir(), `yive-agent-stop-${provider}-`))
    roots.push(root)
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    const fixture = writeProviderAdapterFixture({
      fixtureId: 'explicit-stop',
      provider,
      root,
      workspacePath,
    })
    if (provider === 'codex') process.env.CODEX_HOME = join(root, 'codex-home')
    else process.env.HIVE_CLAUDE_PROJECTS_DIR = join(root, 'claude-projects')
    const server = await startTestServer({ dataDir: join(root, 'data') })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = server.store.createWorkspace(workspacePath, 'Stop Lab')
    const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      ...buildManagedProviderLaunchConfig(provider),
      args: [],
      command: fixture.command,
      interactiveCommand: fixture.command,
    })

    const start = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
      { headers: { cookie }, method: 'POST' }
    )
    expect(start.status).toBe(201)
    const started = (await start.json()) as { run_id: string }
    await waitFor(async () => {
      expect(await readTeamMember(server.baseUrl, cookie, workspace.id)).toMatchObject({
        conversation_activity: 'idle',
        process_state: 'running',
      })
    })
    const active = await server.store.dispatchTask(workspace.id, worker.id, 'Keep responsibility', {
      fromAgentId: `${workspace.id}:orchestrator`,
      hivePort: new URL(server.baseUrl).port,
    })

    await waitFor(async () => {
      expect(await readTeamMember(server.baseUrl, cookie, workspace.id)).toMatchObject({
        active_dispatch_id: active.id,
        conversation_activity: 'idle',
        process_state: 'running',
      })
    })

    const stop = await fetch(`${server.baseUrl}/api/runtime/runs/${started.run_id}/stop`, {
      body: JSON.stringify({ mode: 'force' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(stop.status).toBe(200)

    await waitFor(async () => {
      expect(await readTeamMember(server.baseUrl, cookie, workspace.id)).toMatchObject({
        active_dispatch_id: active.id,
        conversation_activity: 'unknown',
        process_state: 'stopped',
      })
      expect(server.store.listAgentRuns(worker.id)[0]).toMatchObject({
        processState: 'stopped',
        runId: started.run_id,
      })
    })
  })

  test('rejects immediate delivery while Provider activity is busy or unknown', async () => {
    const root = mkdtempSync(join(tmpdir(), `yive-agent-send-boundary-${provider}-`))
    roots.push(root)
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    const fixture = writeProviderAdapterFixture({
      fixtureId: 'send-boundary',
      provider,
      root,
      workspacePath,
    })
    if (provider === 'codex') process.env.CODEX_HOME = join(root, 'codex-home')
    else process.env.HIVE_CLAUDE_PROJECTS_DIR = join(root, 'claude-projects')
    const server = await startTestServer({ dataDir: join(root, 'data') })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = server.store.createWorkspace(workspacePath, 'Boundary Lab')
    const orchestrator = server.store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected Orchestrator')
    const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      ...buildManagedProviderLaunchConfig(provider),
      args: [],
      command: fixture.command,
      interactiveCommand: fixture.command,
    })

    await server.store.startAgent(workspace.id, worker.id, {
      hivePort: new URL(server.baseUrl).port,
    })
    await waitFor(async () => {
      expect(await readTeamMember(server.baseUrl, cookie, workspace.id)).toMatchObject({
        conversation_activity: 'idle',
        process_state: 'running',
      })
    })

    fixture.appendUser('provider is now busy')
    await waitFor(async () => {
      expect(await readTeamMember(server.baseUrl, cookie, workspace.id)).toMatchObject({
        conversation_activity: 'busy',
      })
    })
    await expect(
      server.store.dispatchTask(workspace.id, worker.id, 'Must not enter busy turn', {
        fromAgentId: orchestrator.id,
      })
    ).rejects.toMatchObject({ code: 'agent_conversation_busy', statusCode: 409 })

    renameSync(fixture.sessionPath, `${fixture.sessionPath}.missing`)
    await waitFor(async () => {
      expect(await readTeamMember(server.baseUrl, cookie, workspace.id)).toMatchObject({
        conversation_activity: 'unknown',
      })
    })
    await expect(
      server.store.dispatchTask(workspace.id, worker.id, 'Must not enter unknown turn', {
        fromAgentId: orchestrator.id,
      })
    ).rejects.toMatchObject({ code: 'agent_conversation_unknown', statusCode: 409 })

    expect(server.store.listDispatches(workspace.id)).toEqual([])
    const stdin = fixture.readEvents().filter((event) => event.kind === 'stdin')
    expect(stdin.some((event) => event.text?.includes('Must not enter'))).toBe(false)
  })

  test('keeps projected history readable while a missing Provider source fails closed', async () => {
    const root = mkdtempSync(join(tmpdir(), `yive-agent-stale-${provider}-`))
    roots.push(root)
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    const fixture = writeProviderAdapterFixture({
      fixtureId: 'stale-source',
      provider,
      root,
      workspacePath,
    })
    if (provider === 'codex') process.env.CODEX_HOME = join(root, 'codex-home')
    else process.env.HIVE_CLAUDE_PROJECTS_DIR = join(root, 'claude-projects')
    const server = await startTestServer({ dataDir: join(root, 'data') })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = server.store.createWorkspace(workspacePath, 'Stale Lab')
    const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      ...buildManagedProviderLaunchConfig(provider),
      args: [],
      command: fixture.command,
      interactiveCommand: fixture.command,
    })

    const start = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
      { headers: { cookie }, method: 'POST' }
    )
    expect(start.status).toBe(201)
    const conversationUrl = `${server.baseUrl}/api/mobile/agents/${worker.id}/conversation?workspace_id=${workspace.id}`
    await waitFor(async () => {
      const response = await fetch(conversationUrl, { headers: { cookie } })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        conversation: { cli_session_id?: string } | null
      }
      expect(body.conversation?.cli_session_id).toBe(fixture.sessionId)
    })
    fixture.appendUser('preserved user turn')
    fixture.appendAssistant('preserved assistant turn')
    fixture.appendCompletion()

    await waitFor(async () => {
      const response = await fetch(conversationUrl, { headers: { cookie } })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        conversation: { stale: boolean; turns: Array<{ text: string }> } | null
      }
      expect(body.conversation).toMatchObject({
        stale: false,
        turns: [{ text: 'preserved user turn' }, { text: 'preserved assistant turn' }],
      })
    })

    renameSync(fixture.sessionPath, `${fixture.sessionPath}.missing`)
    await waitFor(async () => {
      expect(await readTeamMember(server.baseUrl, cookie, workspace.id)).toMatchObject({
        conversation_activity: 'unknown',
        process_state: 'running',
      })
      const response = await fetch(conversationUrl, { headers: { cookie } })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        conversation: { stale: boolean; turns: Array<{ text: string }> } | null
      }
      expect(body.conversation).toMatchObject({
        stale: true,
        turns: [{ text: 'preserved user turn' }, { text: 'preserved assistant turn' }],
      })
    })
  })
})

test('runtime startup persists unfinished Agent runs as crashed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yive-agent-restart-state-'))
  roots.push(root)
  const dataDir = join(root, 'data')
  const workspacePath = join(root, 'workspace')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(workspacePath, { recursive: true })
  const db = new Database(join(dataDir, 'runtime.sqlite'))
  initializeRuntimeDatabase(db)
  const workspaceStore = createWorkspaceStore(db, [])
  const workspace = workspaceStore.createWorkspace(workspacePath, 'Restart Lab')
  const worker = workspaceStore.addWorker(workspace.id, { name: 'Alice' })
  const startedAt = Date.now() - 60_000
  db.prepare(
    `INSERT INTO agent_runs (
       run_id, agent_id, pid, status, process_state, exit_code,
       started_at, ended_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'unfinished-run',
    worker.id,
    999_999,
    'running',
    'running',
    null,
    startedAt,
    null,
    startedAt,
    startedAt
  )
  db.close()

  const server = await startTestServer({ dataDir })
  servers.push(server)
  const cookie = await getUiCookie(server.baseUrl)

  await waitFor(async () => {
    expect(await readTeamMember(server.baseUrl, cookie, workspace.id)).toMatchObject({
      conversation_activity: 'unknown',
      process_state: 'crashed',
    })
    expect(server.store.listAgentRuns(worker.id)[0]).toMatchObject({
      endedAt: expect.any(Number),
      processState: 'crashed',
      runId: 'unfinished-run',
      status: 'error',
    })
  })
})
