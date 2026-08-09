import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import {
  type FixtureProvider,
  type ProviderAdapterFixture,
  writeProviderAdapterFixture,
} from '../helpers/provider-adapter-fixture.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const tempDirs: string[] = []
const originalCodexHome = process.env.CODEX_HOME
const originalClaudeProjectsDir = process.env.HIVE_CLAUDE_PROJECTS_DIR

afterEach(async () => {
  vi.restoreAllMocks()
  while (servers.length > 0) await servers.pop()?.close()
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  if (originalClaudeProjectsDir === undefined) delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  else process.env.HIVE_CLAUDE_PROJECTS_DIR = originalClaudeProjectsDir
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 4500,
  intervalMs = 25
) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw lastError
}

const readProviderRecords = (fixture: ProviderAdapterFixture): unknown[] => {
  if (!existsSync(fixture.sessionPath)) return []
  return readFileSync(fixture.sessionPath, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
}

const modelVisibleStartupText = (fixture: ProviderAdapterFixture) => {
  const events = fixture.readEvents()
  const nativeInstruction = events.find((event) => event.kind === 'native_instruction')?.text
  if (nativeInstruction) return nativeInstruction
  return events
    .filter((event) => event.kind === 'stdin')
    .map((event) => event.text ?? '')
    .join('')
    .replaceAll('\u001b[200~', '')
    .replaceAll('\u001b[201~', '')
    .replace(/[\r\n]+$/u, '')
}

const createFixture = async (
  provider: FixtureProvider,
  capabilityProbe: 'available' | 'unavailable' = 'available',
  options: {
    agentKind?: 'orchestrator' | 'worker'
    promptReady?: 'immediate' | 'manual'
  } = {}
) => {
  const root = mkdtempSync(join(tmpdir(), `yive-provider-adapter-${provider}-`))
  const workspacePath = join(root, 'workspace')
  tempDirs.push(root)
  mkdirSync(workspacePath, { recursive: true })
  const fixture = writeProviderAdapterFixture({
    capabilityProbe,
    promptReady: options.promptReady,
    provider,
    root,
    workspacePath,
  })
  if (provider === 'codex') process.env.CODEX_HOME = join(root, 'codex-home')
  else process.env.HIVE_CLAUDE_PROJECTS_DIR = join(root, 'claude-projects')

  const server = await startTestServer({ dataDir: join(root, 'data') })
  servers.push(server)
  const workspace = server.store.createWorkspace(workspacePath, 'Provider Contract')
  const worker =
    options.agentKind === 'orchestrator'
      ? server.store
          .getWorkspaceSnapshot(workspace.id)
          .agents.find((agent) => agent.id === `${workspace.id}:orchestrator`)
      : server.store.addWorker(workspace.id, { name: 'Alice' })
  if (!worker) throw new Error('Expected the Workspace Orchestrator')
  server.store.configureAgentLaunch(workspace.id, worker.id, {
    ...buildManagedProviderLaunchConfig(provider),
    args: [],
    command: fixture.command,
    interactiveCommand: fixture.command,
  })
  const cookie = await getUiCookie(server.baseUrl)
  const start = () =>
    fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`, {
      headers: { cookie },
      method: 'POST',
    })

  return { cookie, fixture, server, start, worker, workspace, workspacePath }
}

const startManagedAgent = async (provider: FixtureProvider) => {
  const context = await createFixture(provider)
  const response = await context.start()
  const body = (await response.json()) as { run_id?: string }
  expect(response.status, JSON.stringify(body)).toBe(201)
  expect(body.run_id).toEqual(expect.any(String))
  return { ...context, runId: body.run_id as string }
}

const getConversation = async (
  baseUrl: string,
  cookie: string,
  workspaceId: string,
  agentId: string
) => {
  const response = await fetch(
    `${baseUrl}/api/mobile/agents/${encodeURIComponent(agentId)}/conversation?workspace_id=${encodeURIComponent(workspaceId)}`,
    { headers: { cookie } }
  )
  expect(response.status).toBe(200)
  return (await response.json()) as {
    conversation: {
      activity_state: 'busy' | 'idle' | 'unknown'
      cli_session_id: string
      provider: FixtureProvider
    } | null
  }
}

interface ProviderAdapterModule {
  getProviderAdapter: (provider: FixtureProvider) =>
    | {
        interruptCurrentTurn: (
          manager: { writeInput: (runId: string, input: Buffer | string) => void },
          runId: string
        ) => void
      }
    | undefined
}

const providerAdapterModulePath = '../../src/server/provider-adapter.js'
const loadProviderAdapterModule = () =>
  import(/* @vite-ignore */ providerAdapterModulePath) as Promise<ProviderAdapterModule>

describe('managed Provider Adapter startup contract', () => {
  test.each([
    ['codex', 'developer'],
    ['claude', 'system'],
  ] as const)('%s injects startup identity through the native %s role', async (provider, role) => {
    const { fixture } = await startManagedAgent(provider)

    await waitFor(() => {
      expect(fixture.readEvents()).toContainEqual(
        expect.objectContaining({ kind: 'native_instruction', role })
      )
    })
    const userBootstrap = fixture
      .readEvents()
      .filter((event) => event.kind === 'stdin')
      .map((event) => event.text ?? '')
      .join('')
      .replace(/[\r\n]/gu, '')
    expect(userBootstrap).toBe('')
  })

  test.each([
    'codex',
    'claude',
  ] as const)('%s keeps machine identity out of the native launch invocation', async (provider) => {
    const { fixture, worker, workspace } = await startManagedAgent(provider)

    await waitFor(() => {
      expect(
        fixture.readEvents().filter((event) => event.kind === 'launch_invocation')
      ).toHaveLength(1)
    })
    const launch = fixture.readEvents().find((event) => event.kind === 'launch_invocation')
    const argv = launch?.args ?? []
    const argvText = argv.join('\n')
    const hasLegacyMachineLabel = argv.some(
      (arg, index) =>
        arg.startsWith('--name=Yive:') ||
        ((arg === '--name' || arg === '-n') && argv[index + 1]?.startsWith('Yive:'))
    )

    expect.soft(argvText).not.toContain(workspace.id)
    expect.soft(argvText).not.toContain(worker.id)
    expect.soft(argvText).not.toContain(workspace.id.slice(0, 8))
    expect.soft(argvText).not.toContain(worker.id.slice(0, 8))
    expect.soft(hasLegacyMachineLabel).toBe(false)
  })

  test.each([
    'codex',
    'claude',
  ] as const)('%s fails closed when its native capability probe fails', async (provider) => {
    const { fixture, start } = await createFixture(provider, 'unavailable')
    const response = await start()
    const body = (await response.json()) as { code?: string; error?: string; run_id?: string }

    expect.soft(response.status).toBeGreaterThanOrEqual(400)
    expect.soft(response.status).toBeLessThan(500)
    expect.soft(body.code).toEqual(expect.stringMatching(/capabil|provider/iu))
    expect.soft(body.error).toEqual(expect.stringMatching(new RegExp(provider, 'iu')))
    expect.soft(body.run_id).toBeUndefined()
    expect.soft(fixture.readEvents().some((event) => event.kind === 'stdin')).toBe(false)
    expect.soft(existsSync(fixture.sessionPath)).toBe(false)
  })

  test.each([
    'codex',
    'claude',
  ] as const)('%s keeps machine binding out of model-visible startup content', async (provider) => {
    const { fixture, worker, workspace } = await startManagedAgent(provider)
    await waitFor(() => expect(modelVisibleStartupText(fixture)).not.toBe(''))
    const text = modelVisibleStartupText(fixture)

    expect(text).not.toContain(workspace.id)
    expect(text).not.toContain(worker.id)
    expect(text).not.toContain(fixture.sessionId)
    expect(text).not.toMatch(/HIVE_(?:AGENT_TOKEN|AGENT_ID|PROJECT_ID)/u)
    expect(text).not.toMatch(/workspace_id=|agent_id=|session_id=/u)
  })

  test.each([
    'codex',
    'claude',
  ] as const)('%s persists a marker-free Provider Session binding internally', async (provider) => {
    const { cookie, fixture, runId, server, worker, workspace } = await startManagedAgent(provider)

    await waitFor(async () => {
      const response = await fetch(`${server.baseUrl}/api/runtime/runs/${runId}`, {
        headers: { cookie },
      })
      const run = (await response.json()) as { sessionId?: string }
      expect(run.sessionId).toBe(fixture.sessionId)
    })
    await waitFor(async () => {
      const page = await getConversation(server.baseUrl, cookie, workspace.id, worker.id)
      expect(page.conversation).toMatchObject({
        cli_session_id: fixture.sessionId,
        provider,
      })
    })

    expect(JSON.stringify(readProviderRecords(fixture))).not.toContain(workspace.id)
    expect(JSON.stringify(readProviderRecords(fixture))).not.toContain(worker.id)
  })

  test.each([
    'codex',
    'claude',
  ] as const)('%s isolates same-Workspace Agent Sessions under concurrent activity', async (provider) => {
    const root = mkdtempSync(join(tmpdir(), `yive-provider-isolation-${provider}-`))
    const workspacePath = join(root, 'workspace')
    const aliceSessionId = '33333333-3333-4333-8333-333333333333'
    const bobSessionId = '44444444-4444-4444-8444-444444444444'
    tempDirs.push(root)
    mkdirSync(workspacePath, { recursive: true })
    const aliceFixture = writeProviderAdapterFixture({
      fixtureId: 'alice',
      provider,
      root,
      sessionId: aliceSessionId,
      workspacePath,
    })
    const bobFixture = writeProviderAdapterFixture({
      fixtureId: 'bob',
      provider,
      root,
      sessionId: bobSessionId,
      workspacePath,
    })
    if (provider === 'codex') process.env.CODEX_HOME = join(root, 'codex-home')
    else process.env.HIVE_CLAUDE_PROJECTS_DIR = join(root, 'claude-projects')

    const server = await startTestServer({ dataDir: join(root, 'data') })
    servers.push(server)
    const workspace = server.store.createWorkspace(workspacePath, 'Provider Isolation')
    const alice = server.store.addWorker(workspace.id, { name: 'Alice' })
    const bob = server.store.addWorker(workspace.id, { name: 'Bob' })
    server.store.configureAgentLaunch(workspace.id, alice.id, {
      ...buildManagedProviderLaunchConfig(provider),
      args: [],
      command: aliceFixture.command,
      interactiveCommand: aliceFixture.command,
    })
    server.store.configureAgentLaunch(workspace.id, bob.id, {
      ...buildManagedProviderLaunchConfig(provider),
      args: [],
      command: bobFixture.command,
      interactiveCommand: bobFixture.command,
    })
    const cookie = await getUiCookie(server.baseUrl)
    const start = async (agentId: string) => {
      const response = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`,
        { headers: { cookie }, method: 'POST' }
      )
      const body = (await response.json()) as { run_id?: string }
      expect(response.status, JSON.stringify(body)).toBe(201)
      expect(body.run_id).toEqual(expect.any(String))
      return body.run_id as string
    }
    const expectRunSession = async (runId: string, sessionId: string) => {
      const response = await fetch(`${server.baseUrl}/api/runtime/runs/${runId}`, {
        headers: { cookie },
      })
      expect(response.status).toBe(200)
      const run = (await response.json()) as { sessionId?: string }
      expect(run.sessionId).toBe(sessionId)
    }

    const aliceRunId = await start(alice.id)
    await waitFor(() => expectRunSession(aliceRunId, aliceSessionId))
    await waitFor(async () => {
      const page = await getConversation(server.baseUrl, cookie, workspace.id, alice.id)
      expect(page.conversation?.cli_session_id).toBe(aliceSessionId)
    })
    aliceFixture.appendUser('alice provider event')
    aliceFixture.appendAssistant('alice completed independently')
    await waitFor(async () => {
      const page = await getConversation(server.baseUrl, cookie, workspace.id, alice.id)
      expect(page.conversation?.activity_state).toBe('busy')
    })
    aliceFixture.appendCompletion()
    await waitFor(async () => {
      const page = await getConversation(server.baseUrl, cookie, workspace.id, alice.id)
      expect(page.conversation?.activity_state).toBe('idle')
    })

    const bobRunId = await start(bob.id)
    await waitFor(() => expectRunSession(bobRunId, bobSessionId))
    await waitFor(async () => {
      const page = await getConversation(server.baseUrl, cookie, workspace.id, bob.id)
      expect(page.conversation?.cli_session_id).toBe(bobSessionId)
    })
    bobFixture.appendUser('bob provider event')
    bobFixture.appendAssistant('bob is still active')
    await waitFor(async () => {
      const page = await getConversation(server.baseUrl, cookie, workspace.id, bob.id)
      expect(page.conversation?.activity_state).toBe('busy')
    })

    await expectRunSession(aliceRunId, aliceSessionId)
    await expectRunSession(bobRunId, bobSessionId)
    const alicePage = await getConversation(server.baseUrl, cookie, workspace.id, alice.id)
    const bobPage = await getConversation(server.baseUrl, cookie, workspace.id, bob.id)
    expect(alicePage.conversation).toMatchObject({
      activity_state: 'idle',
      cli_session_id: aliceSessionId,
      provider,
    })
    expect(bobPage.conversation).toMatchObject({
      activity_state: 'busy',
      cli_session_id: bobSessionId,
      provider,
    })
  })

  test.each([
    'codex',
    'claude',
  ] as const)('%s resumes the same Provider Session after a managed restart', async (provider) => {
    const { cookie, fixture, runId, server, start, worker, workspace } =
      await startManagedAgent(provider)

    await waitFor(async () => {
      const response = await fetch(`${server.baseUrl}/api/runtime/runs/${runId}`, {
        headers: { cookie },
      })
      const run = (await response.json()) as { sessionId?: string }
      expect(run.sessionId).toBe(fixture.sessionId)
    })
    await waitFor(async () => {
      const page = await getConversation(server.baseUrl, cookie, workspace.id, worker.id)
      expect(page.conversation?.cli_session_id).toBe(fixture.sessionId)
    })
    const instructionCountBeforeRestart = fixture
      .readEvents()
      .filter((event) => event.kind === 'native_instruction').length
    expect(instructionCountBeforeRestart).toBe(1)

    const stopResponse = await fetch(`${server.baseUrl}/api/runtime/runs/${runId}/stop`, {
      body: JSON.stringify({ mode: 'force' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    const stopBody = (await stopResponse.json()) as { session_id?: string; state?: string }
    expect(stopResponse.status, JSON.stringify(stopBody)).toBe(200)
    expect(stopBody).toMatchObject({ session_id: fixture.sessionId, state: 'stopped' })

    const restartResponse = await start()
    const restartBody = (await restartResponse.json()) as { run_id?: string }
    expect(restartResponse.status, JSON.stringify(restartBody)).toBe(201)
    expect(restartBody.run_id).toEqual(expect.any(String))
    expect(restartBody.run_id).not.toBe(runId)

    await waitFor(() => {
      expect(fixture.readEvents()).toContainEqual({
        kind: 'native_resume',
        sessionId: fixture.sessionId,
      })
    })
    expect(
      fixture.readEvents().filter((event) => event.kind === 'native_instruction')
    ).toHaveLength(instructionCountBeforeRestart)
    await waitFor(async () => {
      const response = await fetch(
        `${server.baseUrl}/api/runtime/runs/${restartBody.run_id as string}`,
        { headers: { cookie } }
      )
      const run = (await response.json()) as { sessionId?: string }
      expect(run.sessionId).toBe(fixture.sessionId)
    })
    await waitFor(async () => {
      const page = await getConversation(server.baseUrl, cookie, workspace.id, worker.id)
      expect(page.conversation).toMatchObject({
        cli_session_id: fixture.sessionId,
        provider,
      })
    })
  })

  test.each([
    'codex',
    'claude',
  ] as const)('%s reports busy and idle only at verified Provider boundaries', async (provider) => {
    const { cookie, fixture, server, worker, workspace } = await startManagedAgent(provider)
    const conversation = () => getConversation(server.baseUrl, cookie, workspace.id, worker.id)

    await waitFor(async () => {
      expect((await conversation()).conversation?.activity_state).toBe('idle')
    })
    fixture.appendUser('inspect the failing contract')
    fixture.appendAssistant('I am still working.')
    await waitFor(async () => {
      expect((await conversation()).conversation?.activity_state).toBe('busy')
    })

    expect((await conversation()).conversation?.activity_state).toBe('busy')
    fixture.appendCompletion()
    await waitFor(async () => {
      expect((await conversation()).conversation?.activity_state).toBe('idle')
    })
  })

  test.each([
    'codex',
    'claude',
  ] as const)('%s exposes only the minimal progressive-disclosure startup contract', async (provider) => {
    const { fixture, workspacePath } = await startManagedAgent(provider)
    await waitFor(() => expect(modelVisibleStartupText(fixture)).not.toBe(''))
    const text = modelVisibleStartupText(fixture)

    expect(text).toContain('Alice')
    expect(text).toMatch(/Agent kind:\s*Worker/iu)
    expect(text).toContain(workspacePath)
    expect(text).toMatch(/Default write boundary/iu)
    expect(text).toMatch(/Authority boundary/iu)
    expect(text).toMatch(/Provider Subagent boundary/iu)
    expect(text).toContain('team --help')
    expect(text).toContain('team context')
    expect(text).toContain('yive agent --help')
    expect(text).not.toContain('.hive/tasks.md')
    expect(text).not.toContain('.hive/PROTOCOL.md')
    expect(text).not.toContain('mobile-attachments.json')
    expect(text).not.toMatch(/\b(?:credential|secret|token)\b/iu)
    expect(text).not.toMatch(/team (?:send|report|status|cancel|note)\b/u)
    expect(text.split(/\r?\n/u).length).toBeLessThanOrEqual(24)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2_000)
  })

  test.each([
    'codex',
    'claude',
  ] as const)('%s injects bounded Runtime Context after native compaction', async (provider) => {
    const { cookie, fixture, server, worker, workspace } = await startManagedAgent(provider)
    await waitFor(() => expect(existsSync(fixture.sessionPath)).toBe(true))
    await waitFor(async () => {
      expect(
        (await getConversation(server.baseUrl, cookie, workspace.id, worker.id)).conversation
      ).not.toBeNull()
    })
    const dispatch = await server.store.dispatchTask(
      workspace.id,
      worker.id,
      'Current compaction responsibility',
      {
        fromAgentId: `${workspace.id}:orchestrator`,
        hivePort: new URL(server.baseUrl).port,
      }
    )
    expect(dispatch.status).toBe('submitted')
    const privateSummary = `PRIVATE ${provider} COMPACTION SUMMARY`

    fixture.appendCompaction(privateSummary)

    await waitFor(async () => {
      await getConversation(server.baseUrl, cookie, workspace.id, worker.id)
      const written = fixture
        .readEvents()
        .filter((event) => event.kind === 'stdin')
        .map((event) => event.text ?? '')
        .join('')
      expect(written).toContain('Current bounded Runtime Context:')
      expect(written).toContain('"scope":"responsibility"')
      expect(written).toContain('Current compaction responsibility')
      expect(written).not.toContain(privateSummary)
      expect(written.length).toBeLessThan(20_000)
    })
  })

  test.each([
    'codex',
    'claude',
  ] as const)('%s skips Runtime Context after compaction without active responsibility', async (provider) => {
    const { cookie, fixture, server, worker, workspace } = await startManagedAgent(provider)
    await waitFor(async () => {
      expect(
        (await getConversation(server.baseUrl, cookie, workspace.id, worker.id)).conversation
      ).not.toBeNull()
    })
    const eventBoundary = fixture.readEvents().length

    fixture.appendCompaction(`PRIVATE EMPTY ${provider} COMPACTION SUMMARY`)
    await getConversation(server.baseUrl, cookie, workspace.id, worker.id)
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(
      fixture
        .readEvents()
        .slice(eventBoundary)
        .filter((event) => event.kind === 'stdin')
    ).toEqual([])
  })

  test('injects only the discovery fallback when compaction finds conflicting state', async () => {
    const { cookie, fixture, server, worker, workspace } = await startManagedAgent('codex')
    await waitFor(() => expect(existsSync(fixture.sessionPath)).toBe(true))
    await waitFor(async () => {
      expect(
        (await getConversation(server.baseUrl, cookie, workspace.id, worker.id)).conversation
      ).not.toBeNull()
    })
    const first = await server.store.dispatchTask(workspace.id, worker.id, 'first responsibility')
    const second = await server.store.dispatchTask(workspace.id, worker.id, 'second responsibility')
    const db = new Database(join(server.dataDir, 'runtime.sqlite'))
    try {
      db.exec('DROP INDEX idx_dispatches_one_submitted_per_worker')
      db.prepare(
        `UPDATE dispatches
         SET status = 'submitted', submitted_at = ?
         WHERE id IN (?, ?)`
      ).run(Date.now(), first.id, second.id)
    } finally {
      db.close()
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fixture.appendCompaction('PRIVATE CONFLICTING COMPACTION SUMMARY')

    await waitFor(async () => {
      await getConversation(server.baseUrl, cookie, workspace.id, worker.id)
      const written = fixture
        .readEvents()
        .filter((event) => event.kind === 'stdin')
        .map((event) => event.text ?? '')
        .join('')
      expect(written).toContain(
        'Runtime Context unavailable; run `team context` for a fresh snapshot.'
      )
      expect(written).not.toContain('Current bounded Runtime Context:')
      expect(written).not.toContain('first responsibility')
      expect(written).not.toContain('second responsibility')
    })
    expect(warn).toHaveBeenCalled()
  })

  test.each([
    'codex',
    'claude',
  ] as const)('%s withholds post-start input until the Provider reports prompt-ready', async (provider) => {
    const { cookie, fixture, server, start, workspace } = await createFixture(
      provider,
      'available',
      { agentKind: 'orchestrator', promptReady: 'manual' }
    )
    const startResponse = await start()
    const startBody = (await startResponse.json()) as { run_id?: string }
    expect(startResponse.status, JSON.stringify(startBody)).toBe(201)
    expect(startBody.run_id).toEqual(expect.any(String))
    await waitFor(() => expect(existsSync(fixture.sessionPath)).toBe(true))

    const sentinel = `delivery-after-${provider}-prompt-ready`
    const inputResponse = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/user-input`,
      {
        body: JSON.stringify({ text: sentinel }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      }
    )
    expect(inputResponse.status, await inputResponse.text()).toBe(202)

    await new Promise((resolve) => setTimeout(resolve, 3_400))
    expect(fixture.readEvents().filter((event) => event.kind === 'stdin')).toEqual([])

    fixture.releasePromptReady()
    await waitFor(() => {
      const events = fixture.readEvents()
      const readyIndex = events.findIndex((event) => event.kind === 'prompt_ready')
      const inputIndex = events.findIndex(
        (event) => event.kind === 'stdin' && event.text?.includes(sentinel)
      )
      expect(readyIndex).toBeGreaterThanOrEqual(0)
      expect(inputIndex).toBeGreaterThan(readyIndex)
    })
  }, 12_000)

  test.each([
    'codex',
    'claude',
  ] as const)('%s semantic current-turn interruption sends Esc rather than Ctrl+C', async (provider) => {
    const root = mkdtempSync(join(tmpdir(), `yive-provider-interrupt-${provider}-`))
    const workspacePath = join(root, 'workspace')
    tempDirs.push(root)
    mkdirSync(workspacePath, { recursive: true })
    const fixture = writeProviderAdapterFixture({ provider, root, workspacePath })
    const manager = createAgentManager()
    const run = await manager.startAgent({
      agentId: 'agent-under-test',
      command: fixture.command,
      cwd: workspacePath,
    })

    try {
      await waitFor(() => {
        expect(fixture.readEvents().some((event) => event.kind === 'invocation')).toBe(true)
      })
      const baseline = fixture.readEvents().length
      const adapter = (await loadProviderAdapterModule()).getProviderAdapter(provider)
      expect(adapter).toBeDefined()

      adapter?.interruptCurrentTurn(manager, run.runId)

      await waitFor(() => {
        const inputs = fixture
          .readEvents()
          .slice(baseline)
          .filter((event) => event.kind === 'stdin')
          .map((event) => event.text)
        expect(inputs).toEqual(['\u001b'])
        expect(inputs).not.toContain('\u0003')
      })
    } finally {
      manager.stopRun(run.runId)
    }
  })
})
