import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { runTeamCommand } from '../../src/cli/team.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { writeProviderAdapterFixture } from '../helpers/provider-adapter-fixture.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const originalEnv = { ...process.env }

const waitFor = async (assertion: () => void, timeoutMs = 10_000) => {
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

afterEach(() => {
  process.env = { ...originalEnv }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('team send CLI side effects (R1.3)', () => {
  const setup = async (fixtureId: string, startWorker: boolean) => {
    const dataDir = mkdtempSync(join(tmpdir(), `yive-${fixtureId}-`))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)
    process.env.CODEX_HOME = join(dataDir, 'codex-home')
    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])
    const baseUrl = `http://127.0.0.1:${hive.port}`
    const cookie = await getUiCookie(baseUrl)
    const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
      body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    const workspace = (await workspaceResponse.json()) as { id: string }
    const orchestratorId = `${workspace.id}:orchestrator`
    const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
      body: JSON.stringify({ name: 'Alice' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    const worker = (await workerResponse.json()) as { id: string }
    const orchestratorFixture = writeProviderAdapterFixture({
      fixtureId: `${fixtureId}-orchestrator`,
      provider: 'codex',
      root: dataDir,
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
    }
    await hive.store.startAgent(workspace.id, orchestratorId, { hivePort: String(hive.port) })
    await waitFor(() => {
      expect(hive.store.getAgentState(workspace.id, orchestratorId).conversationActivity).toBe(
        'idle'
      )
    })
    if (startWorker) {
      await hive.store.startAgent(workspace.id, worker.id, { hivePort: String(hive.port) })
      await waitFor(() => {
        expect(hive.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('idle')
      })
    }
    const token = hive.store.peekAgentToken(orchestratorId)
    if (!token) throw new Error('Expected Orchestrator token')
    process.env = {
      ...originalEnv,
      CODEX_HOME: process.env.CODEX_HOME,
      HIVE_AGENT_ID: orchestratorId,
      HIVE_AGENT_TOKEN: token,
      HIVE_DATA_DIR: dataDir,
      HIVE_PORT: String(hive.port),
      HIVE_PROJECT_ID: workspace.id,
    }
    return { hive, orchestratorId, worker, workerFixture, workspace }
  }

  test('team send injects one active Dispatch without leaking machine identity', async () => {
    const context = await setup('team-cli-side-effects', true)
    try {
      await runTeamCommand(['send', 'Alice', 'Implement login'])
      const dispatch = context.hive.store.listDispatches(context.workspace.id)[0]
      expect(dispatch).toMatchObject({ status: 'submitted', text: 'Implement login' })
      expect(
        context.hive.store.getAgentState(context.workspace.id, context.worker.id)
      ).toMatchObject({
        activeDispatchId: dispatch?.id,
        processState: 'running',
        queuedDispatchCount: 0,
      })
      await waitFor(() => {
        const input = context.workerFixture
          .readEvents()
          .filter((event) => event.kind === 'stdin')
          .flatMap((event) => event.text ?? '')
          .join('')
        expect(input).toContain('@Orchestrator')
        expect(input).toContain('Implement login')
        expect(input).toContain(`dispatch_id: ${dispatch?.id}`)
        expect(input).not.toContain('team report')
        expect(input).not.toContain(context.workspace.id)
        expect(input).not.toContain(context.worker.id)
        expect(input).not.toContain(context.orchestratorId)
      })
    } finally {
      await context.hive.close()
    }
  })

  test('team send rejects a stopped Worker without auto-starting it', async () => {
    const context = await setup('team-cli-stopped-worker', false)
    try {
      await expect(runTeamCommand(['send', 'Alice', 'Inspect project structure'])).rejects.toThrow(
        'Worker Alice process is stopped; start it before assigning work'
      )
      expect(
        context.hive.store.getActiveRunByAgentId(context.workspace.id, context.worker.id)
      ).toBeUndefined()
      expect(context.hive.store.listDispatches(context.workspace.id)).toEqual([])
    } finally {
      await context.hive.close()
    }
  })

  test('team replace and cancel cross the real CLI and HTTP boundary', async () => {
    const context = await setup('team-cli-replace-cancel', true)
    try {
      await runTeamCommand(['send', 'Alice', 'Incorrect implementation task'])
      const original = context.hive.store.listDispatches(context.workspace.id)[0]
      if (!original) throw new Error('Expected active Dispatch')

      await runTeamCommand([
        'replace',
        '--dispatch',
        original.id,
        '--request-id',
        'cli-replace-recovery',
        'Corrected implementation task',
      ])
      const replacement = context.hive.store
        .listDispatches(context.workspace.id)
        .find((dispatch) => dispatch.replacesDispatchId === original.id)
      expect(context.hive.store.getDispatch(context.workspace.id, original.id)).toMatchObject({
        replacedBy: replacement?.id,
        status: 'replaced',
      })
      expect(replacement).toMatchObject({
        requestId: 'cli-replace-recovery',
        status: 'submitted',
        text: 'Corrected implementation task',
      })

      await runTeamCommand([
        'cancel',
        '--dispatch',
        replacement?.id ?? '',
        '--request-id',
        'cli-cancel-recovery',
        'Direction changed again',
      ])
      expect(
        context.hive.store.getDispatch(context.workspace.id, replacement?.id ?? '')
      ).toMatchObject({
        operationRequestId: 'cli-cancel-recovery',
        reportText: 'Direction changed again',
        status: 'cancelled',
      })
    } finally {
      await context.hive.close()
    }
  })
})
