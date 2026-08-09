import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import {
  type ProviderAdapterFixture,
  writeProviderAdapterFixture,
} from '../helpers/provider-adapter-fixture.js'

const tempDirs: string[] = []
const originalCodexHome = process.env.CODEX_HOME

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 2000,
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

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('cross workspace send isolation', () => {
  test('team send Alice reaches only the current workspace Alice run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-send-isolation-'))
    tempDirs.push(dataDir)
    process.env.CODEX_HOME = join(dataDir, 'codex-home')
    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])

    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiSessionResponse = await fetch(`${baseUrl}/api/ui/session`)
      const uiCookie = uiSessionResponse.headers.get('set-cookie')
      if (!uiCookie) {
        throw new Error('Expected UI session cookie')
      }
      const workspaceAPath = join(dataDir, 'workspace-a')
      const workspaceBPath = join(dataDir, 'workspace-b')
      mkdirSync(workspaceAPath, { recursive: true })
      mkdirSync(workspaceBPath, { recursive: true })

      const workerFixtureA = writeProviderAdapterFixture({
        fixtureId: 'worker-a',
        provider: 'codex',
        root: dataDir,
        sessionId: '11111111-1111-4111-8111-111111111111',
        workspacePath: workspaceAPath,
      })
      const workerFixtureB = writeProviderAdapterFixture({
        fixtureId: 'worker-b',
        provider: 'codex',
        root: dataDir,
        sessionId: '11111111-1111-4111-8111-111111111112',
        workspacePath: workspaceBPath,
      })
      const orchestratorFixture = writeProviderAdapterFixture({
        fixtureId: 'orchestrator-a',
        provider: 'codex',
        root: dataDir,
        sessionId: '11111111-1111-4111-8111-111111111113',
        workspacePath: workspaceAPath,
      })

      const createWorkspace = async (name: string, path: string) => {
        const response = await fetch(`${baseUrl}/api/workspaces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ autostart_orchestrator: false, name, path }),
        })
        return (await response.json()) as { id: string }
      }

      const a = await createWorkspace('A', workspaceAPath)
      const b = await createWorkspace('B', workspaceBPath)

      const addWorker = async (workspaceId: string) => {
        const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/workers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ name: 'Alice' }),
        })
        return (await response.json()) as { id: string }
      }

      const workerA = await addWorker(a.id)
      const workerB = await addWorker(b.id)

      const config = (workspaceId: string, agentId: string, fixture: ProviderAdapterFixture) => {
        hive.store.configureAgentLaunch(workspaceId, agentId, {
          ...buildManagedProviderLaunchConfig('codex'),
          args: [],
          command: fixture.command,
          interactiveCommand: fixture.command,
        })
      }

      config(a.id, workerA.id, workerFixtureA)
      config(b.id, workerB.id, workerFixtureB)
      config(a.id, `${a.id}:orchestrator`, orchestratorFixture)

      const start = async (workspaceId: string, agentId: string) => {
        const run = await hive.store.startAgent(workspaceId, agentId, {
          hivePort: String(hive.port),
        })
        return { runId: run.runId }
      }

      const runA = await start(a.id, workerA.id)
      const runB = await start(b.id, workerB.id)
      await start(a.id, `${a.id}:orchestrator`)
      await waitFor(() => {
        expect(hive.store.getAgentState(a.id, workerA.id)).toMatchObject({
          conversationActivity: 'idle',
          processState: 'running',
        })
        expect(hive.store.getAgentState(b.id, workerB.id)).toMatchObject({
          conversationActivity: 'idle',
          processState: 'running',
        })
      }, 10_000)

      const sendResponse = await fetch(`${baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: a.id,
          from_agent_id: `${a.id}:orchestrator`,
          token: hive.store.peekAgentToken(`${a.id}:orchestrator`),
          to: 'Alice',
          text: '实现登录',
        }),
      })
      if (sendResponse.status !== 202) {
        throw new Error(`Expected team send 202: ${await sendResponse.text()}`)
      }

      await waitFor(
        async () => {
          const responseA = await fetch(`${baseUrl}/api/runtime/runs/${runA.runId}`, {
            headers: { cookie: uiCookie },
          })
          const responseB = await fetch(`${baseUrl}/api/runtime/runs/${runB.runId}`, {
            headers: { cookie: uiCookie },
          })
          const bodyA = (await responseA.json()) as { output: string }
          const bodyB = (await responseB.json()) as { output: string }

          expect(bodyA.output).toContain('[Pasted text #1]')
          expect(bodyB.output).not.toContain('[Pasted text #1]')
          const workerAInput = workerFixtureA
            .readEvents()
            .filter((event) => event.kind === 'stdin')
            .map((event) => event.text ?? '')
            .join('')
          const workerBInput = workerFixtureB
            .readEvents()
            .filter((event) => event.kind === 'stdin')
            .map((event) => event.text ?? '')
            .join('')
          expect(workerAInput).toContain('@Orchestrator')
          expect(workerAInput).toContain('实现登录')
          expect(workerBInput).not.toContain('实现登录')
        },
        10_000,
        25
      )
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }
  })
})
