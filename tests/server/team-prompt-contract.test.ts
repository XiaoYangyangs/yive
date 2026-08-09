import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import {
  type FixtureProvider,
  writeProviderAdapterFixture,
} from '../helpers/provider-adapter-fixture.js'

const tempDirs: string[] = []
const stores: Array<ReturnType<typeof createRuntimeStore>> = []
const originalCodexHome = process.env.CODEX_HOME
const originalClaudeProjectsDir = process.env.HIVE_CLAUDE_PROJECTS_DIR

const waitFor = async (assertion: () => void, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw lastError
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  if (originalClaudeProjectsDir === undefined) delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  else process.env.HIVE_CLAUDE_PROJECTS_DIR = originalClaudeProjectsDir
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const createStartedWorker = async (provider: FixtureProvider, fixtureId: string) => {
  const dataDir = mkdtempSync(join(tmpdir(), `yive-team-prompt-${provider}-`))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  mkdirSync(join(workspacePath, 'src'), { recursive: true })
  writeFileSync(join(workspacePath, 'src', 'auth.ts'), 'export const auth = true\n')
  tempDirs.push(dataDir)
  if (provider === 'codex') process.env.CODEX_HOME = join(dataDir, 'codex-home')
  else process.env.HIVE_CLAUDE_PROJECTS_DIR = join(dataDir, 'claude-projects')

  const fixture = writeProviderAdapterFixture({
    fixtureId,
    provider,
    root: dataDir,
    workspacePath,
  })
  const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
  stores.push(store)
  const workspace = store.createWorkspace(workspacePath, 'Alpha')
  const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
  if (!orchestrator) throw new Error('Expected default Orchestrator')
  const worker = store.addWorker(workspace.id, { name: 'Alice' })
  store.configureAgentLaunch(workspace.id, worker.id, {
    ...buildManagedProviderLaunchConfig(provider),
    args: [],
    command: fixture.command,
    interactiveCommand: fixture.command,
  })
  await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
  await waitFor(() => {
    expect(store.getAgentState(workspace.id, worker.id)).toMatchObject({
      conversationActivity: 'idle',
      processState: 'running',
    })
  })
  return { dataDir, fixture, orchestrator, store, worker, workspace, workspacePath }
}

describe('team prompt contract', () => {
  test('team send injects sender identity and task text without a permanent Role', async () => {
    const { fixture, orchestrator, store, workspace } = await createStartedWorker(
      'codex',
      'codex-send'
    )

    const dispatch = await store.dispatchTaskByWorkerName(workspace.id, 'Alice', '实现登录', {
      fromAgentId: orchestrator.id,
    })
    const input = fixture
      .readEvents()
      .filter((event) => event.kind === 'stdin')
      .flatMap((event) => event.text ?? '')
      .join('')

    expect(input).toContain('@Orchestrator')
    expect(input).toContain(`dispatch_id: ${dispatch.id}`)
    expect(input).not.toContain(`team report "<result>" --dispatch ${dispatch.id}`)
    expect(input).not.toContain('你必须遵守')
    expect(input).toContain('实现登录')
    expect(input).not.toContain('--success')
    expect(input).not.toContain('--failed')
  })

  test('team send submits to Claude only after bracketed paste delivery', async () => {
    const { fixture, orchestrator, store, workspace } = await createStartedWorker(
      'claude',
      'claude-send'
    )

    await store.dispatchTaskByWorkerName(workspace.id, 'Alice', '实现登录', {
      fromAgentId: orchestrator.id,
    })
    const stdin = fixture.readEvents().filter((event) => event.kind === 'stdin')
    const pasteIndex = stdin.findIndex((event) => event.text?.includes('\u001b[201~'))
    const submitIndex = stdin.findIndex((event) => /^[\r\n]+$/u.test(event.text ?? ''))

    expect(pasteIndex).toBeGreaterThanOrEqual(0)
    expect(submitIndex).toBeGreaterThan(pasteIndex)
    expect(stdin[pasteIndex]?.text).toContain('\u001b[200~')
  })

  test('team report reaches a managed Claude Orchestrator through its Provider driver', async () => {
    const context = await createStartedWorker('codex', 'report-worker')
    process.env.HIVE_CLAUDE_PROJECTS_DIR = join(context.dataDir, 'claude-projects')
    const orchestratorFixture = writeProviderAdapterFixture({
      fixtureId: 'report-orchestrator',
      provider: 'claude',
      root: context.dataDir,
      sessionId: '33333333-3333-4333-8333-333333333333',
      workspacePath: context.workspacePath,
    })
    context.store.configureAgentLaunch(context.workspace.id, context.orchestrator.id, {
      ...buildManagedProviderLaunchConfig('claude'),
      args: [],
      command: orchestratorFixture.command,
      interactiveCommand: orchestratorFixture.command,
    })
    await context.store.startAgent(context.workspace.id, context.orchestrator.id, {
      hivePort: '4010',
    })
    await waitFor(() => {
      expect(
        context.store.getAgentState(context.workspace.id, context.orchestrator.id)
      ).toMatchObject({ conversationActivity: 'idle', processState: 'running' })
    })

    await context.store.dispatchTask(context.workspace.id, context.worker.id, 'Report this task', {
      fromAgentId: context.orchestrator.id,
    })
    context.store.reportTask(context.workspace.id, context.worker.id, {
      artifacts: ['src/auth.ts'],
      requestId: 'claude-contract-report',
      text: 'Done from Claude contract',
    })
    await waitFor(() => {
      const input = orchestratorFixture
        .readEvents()
        .filter((event) => event.kind === 'stdin')
        .flatMap((event) => event.text ?? '')
        .join('')
      expect(input).toContain('Worker: Alice')
      expect(input).toContain('Outcome: completed')
      expect(input).toContain('Done from Claude contract')
      expect(input).toContain('src/auth.ts')
    })
  })
})
