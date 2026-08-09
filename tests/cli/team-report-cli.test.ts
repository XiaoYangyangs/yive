import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { runTeamCommand } from '../../src/cli/team.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { writeProviderAdapterFixture } from '../helpers/provider-adapter-fixture.js'
import { getUiCookie } from '../helpers/ui-session.js'

const runTeamBinaryWithStdin = (
  args: string[],
  env: Record<string, string>,
  stdinContent: string
): Promise<{ code: number | null; stderr: string; stdout: string }> =>
  new Promise((resolve, reject) => {
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
    const child = spawn(process.execPath, [tsxCli, 'bin/team', ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      resolve({
        code,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      })
    )
    child.stdin.write(stdinContent)
    child.stdin.end()
  })

const tempDirs: string[] = []
const originalEnv = { ...process.env }

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 10_000,
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

const setupTeam = async (fixtureId: string) => {
  const dataDir = mkdtempSync(join(tmpdir(), `yive-${fixtureId}-`))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(join(workspacePath, 'src'), { recursive: true })
  writeFileSync(join(workspacePath, 'src', 'auth.ts'), 'export const auth = true\n', 'utf8')
  tempDirs.push(dataDir)
  process.env.CODEX_HOME = join(dataDir, 'codex-home')
  process.env.HIVE_DATA_DIR = dataDir
  const hive = await runHiveCommand(['--port', '0'])
  const baseUrl = `http://127.0.0.1:${hive.port}`
  const uiCookie = await getUiCookie(baseUrl)
  const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    method: 'POST',
  })
  const workspace = (await workspaceResponse.json()) as { id: string }
  const orchestratorId = `${workspace.id}:orchestrator`
  const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
    body: JSON.stringify({ name: 'Alice' }),
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    method: 'POST',
  })
  const worker = (await workerResponse.json()) as { id: string }

  const orchestratorFixture = writeProviderAdapterFixture({
    fixtureId: `${fixtureId}-orchestrator`,
    provider: 'codex',
    root: dataDir,
    sessionId: '11111111-1111-4111-8111-111111111111',
    workspacePath,
  })
  const workerFixture = writeProviderAdapterFixture({
    fixtureId: `${fixtureId}-worker`,
    provider: 'codex',
    root: dataDir,
    sessionId: '22222222-2222-4222-8222-222222222222',
    workspacePath,
  })
  for (const [agentId, fixture] of [
    [orchestratorId, orchestratorFixture],
    [worker.id, workerFixture],
  ] as const) {
    hive.store.configureAgentLaunch(workspace.id, agentId, {
      ...buildManagedProviderLaunchConfig('codex'),
      args: [],
      command: fixture.command,
      interactiveCommand: fixture.command,
    })
    await hive.store.startAgent(workspace.id, agentId, { hivePort: String(hive.port) })
    await waitFor(() => {
      expect(hive.store.getAgentState(workspace.id, agentId)).toMatchObject({
        conversationActivity: 'idle',
        processState: 'running',
      })
    })
  }

  const orchestratorToken = hive.store.peekAgentToken(orchestratorId)
  const workerToken = hive.store.peekAgentToken(worker.id)
  if (!orchestratorToken || !workerToken) throw new Error('Expected Agent tokens')
  const envFor = (agentId: string, token: string) => ({
    ...originalEnv,
    CODEX_HOME: process.env.CODEX_HOME ?? '',
    HIVE_AGENT_ID: agentId,
    HIVE_AGENT_TOKEN: token,
    HIVE_DATA_DIR: dataDir,
    HIVE_PORT: String(hive.port),
    HIVE_PROJECT_ID: workspace.id,
  })
  const dispatch = async (task: string) => {
    process.env = envFor(orchestratorId, orchestratorToken)
    await runTeamCommand(['send', 'Alice', task])
    const active = hive.store
      .listDispatches(workspace.id)
      .find((item) => item.status === 'submitted')
    if (!active) throw new Error('Expected active Dispatch')
    return active
  }

  return {
    dataDir,
    dispatch,
    envFor,
    hive,
    orchestratorFixture,
    orchestratorId,
    orchestratorToken,
    worker,
    workerToken,
    workspace,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  process.env = { ...originalEnv }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('team report cli', () => {
  test('retries a lost Report response once with the same idempotency key and body', async () => {
    process.env = {
      ...originalEnv,
      HIVE_AGENT_ID: 'worker-1',
      HIVE_AGENT_TOKEN: 'worker-token',
      HIVE_PORT: '4511',
      HIVE_PROJECT_ID: 'workspace-1',
    }
    const bodies: Array<Record<string, unknown>> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (bodies.length === 1) throw new TypeError('response connection closed')
      return new Response(null, { status: 202 })
    })

    await runTeamCommand(['report', 'Committed before response loss'])

    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toEqual(bodies[1])
    expect(bodies[0]?.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    )
  })

  test('team status stores the latest active-Dispatch snapshot without model injection', async () => {
    const context = await setupTeam('team-status-cli')
    let closed = false
    try {
      const dispatch = await context.dispatch('Inspect the status path')
      const stdinBefore = context.orchestratorFixture
        .readEvents()
        .filter((event) => event.kind === 'stdin').length
      process.env = context.envFor(context.worker.id, context.workerToken)
      await runTeamCommand(['status', 'Focused tests are still running'])

      expect(
        context.hive.store.getLatestStatus(context.workspace.id, context.worker.id)
      ).toMatchObject({
        dispatchId: dispatch.id,
        notify: false,
        text: 'Focused tests are still running',
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(
        context.orchestratorFixture.readEvents().filter((event) => event.kind === 'stdin')
      ).toHaveLength(stdinBefore)

      await context.hive.close()
      closed = true
      const reopened = await runHiveCommand(['--port', '0'])
      try {
        expect(
          reopened.store.getLatestStatus(context.workspace.id, context.worker.id)
        ).toMatchObject({
          dispatchId: dispatch.id,
          text: 'Focused tests are still running',
        })
      } finally {
        await reopened.close()
      }
    } finally {
      if (!closed) await context.hive.close()
    }
  }, 20_000)

  test('team report persists artifacts and delivers one compact event at idle', async () => {
    const context = await setupTeam('team-report-cli')
    try {
      const dispatch = await context.dispatch('Report this CLI task with private details')
      process.env = context.envFor(context.worker.id, context.workerToken)
      await runTeamCommand(['report', 'Done via CLI', '--artifact', 'src/auth.ts'])

      await waitFor(() => {
        const input = context.orchestratorFixture
          .readEvents()
          .filter((event) => event.kind === 'stdin')
          .flatMap((event) => event.text ?? '')
          .join('')
        expect(input).toContain('Worker: Alice')
        expect(input).toContain(`Dispatch: ${dispatch.id}`)
        expect(input).toContain('Outcome: completed')
        expect(input).toContain('Result: Done via CLI')
        expect(input).toContain('Artifact: src/auth.ts')
        expect(input).not.toContain('private details')
      })
      expect(context.hive.store.listMessagesForRecovery(context.workspace.id, 0)).toContainEqual(
        expect.objectContaining({
          artifacts: ['src/auth.ts'],
          text: 'Done via CLI',
          type: 'report',
        })
      )
    } finally {
      await context.hive.close()
    }
  }, 20_000)

  test('team report --stdin preserves a multi-line result', async () => {
    const context = await setupTeam('team-report-stdin')
    try {
      await context.dispatch('Pipe a long report back')
      const multilineReport = [
        '## Bug fix summary',
        '',
        'Fixed the issue where `team report` lost results when',
        'the body contained "quotes" and special chars like $RUNTIME_VAR.',
        '',
        'Files touched:',
        '- src/cli/team.ts',
        '- tests/unit/team-cli-parse-args.test.ts',
      ].join('\n')

      const result = await runTeamBinaryWithStdin(
        ['report', '--stdin'],
        context.envFor(context.worker.id, context.workerToken),
        multilineReport
      )
      expect(result).toMatchObject({ code: 0, stderr: '' })
      expect(context.hive.store.listMessagesForRecovery(context.workspace.id, 0)).toContainEqual(
        expect.objectContaining({
          text: multilineReport,
          type: 'report',
        })
      )
    } finally {
      await context.hive.close()
    }
  }, 20_000)

  test('team report --stdin rejects piped input combined with a positional', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'yive-team-report-stdin-conflict-'))
    tempDirs.push(dataDir)
    const result = await runTeamBinaryWithStdin(
      ['report', '--stdin', 'positional-result'],
      {
        HIVE_AGENT_ID: 'unused',
        HIVE_AGENT_TOKEN: 'unused',
        HIVE_DATA_DIR: dataDir,
        HIVE_PORT: '1',
        HIVE_PROJECT_ID: 'unused',
      },
      'piped'
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--stdin is mutually exclusive with a positional argument')
    expect(result.stderr).toContain('Usage:')
  })
})
