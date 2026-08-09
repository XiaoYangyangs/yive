import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { writeProviderAdapterFixture } from '../helpers/provider-adapter-fixture.js'

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

describe('team runtime flow (unit)', () => {
  test('team report persists a pending event without an active Orchestrator run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yive-team-runtime-flow-'))
    const dataDir = join(root, 'runtime')
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(join(workspacePath, 'src'), { recursive: true })
    writeFileSync(join(workspacePath, 'src', 'auth.ts'), 'export const auth = true\n')
    const originalCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = join(root, 'codex-home')
    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    const app = createApp({ store })

    try {
      const workspace = store.createWorkspace(workspacePath, 'Alpha')
      const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
      if (!orchestrator) throw new Error('Expected default Orchestrator')
      const worker = store.addWorker(workspace.id, { name: 'Alice' })
      const fixture = writeProviderAdapterFixture({
        fixtureId: 'team-runtime-worker',
        provider: 'codex',
        root,
        workspacePath,
      })
      store.configureAgentLaunch(workspace.id, worker.id, {
        ...buildManagedProviderLaunchConfig('codex'),
        args: [],
        command: fixture.command,
        interactiveCommand: fixture.command,
      })
      await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
      await waitFor(() => {
        expect(store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('idle')
      })
      const dispatch = await store.dispatchTask(workspace.id, worker.id, 'Report this task', {
        fromAgentId: orchestrator.id,
        requestId: 'runtime-flow-dispatch',
      })

      await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Server did not bind')

      const response = await fetch(`http://127.0.0.1:${address.port}/api/team/report`, {
        body: JSON.stringify({
          artifacts: ['src/auth.ts'],
          from_agent_id: worker.id,
          project_id: workspace.id,
          request_id: 'runtime-flow-report',
          result: 'Login implementation complete',
          token: store.peekAgentToken(worker.id),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

      expect(response.status).toBe(202)
      await expect(response.json()).resolves.toMatchObject({
        dispatch_id: dispatch.id,
        outcome: 'completed',
        request_id: 'runtime-flow-report',
      })
      expect(store.getActiveRunByAgentId(workspace.id, orchestrator.id)).toBeUndefined()
      expect(store.listMessagesForRecovery(workspace.id, 0)).toContainEqual(
        expect.objectContaining({
          artifacts: ['src/auth.ts'],
          text: 'Login implementation complete',
          type: 'report',
        })
      )

      const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
      try {
        expect(
          db
            .prepare(
              `SELECT dispatch_id, kind, delivery_state, text
               FROM coordination_events
               WHERE request_id = ?`
            )
            .get('runtime-flow-report')
        ).toEqual({
          delivery_state: 'pending',
          dispatch_id: dispatch.id,
          kind: 'report',
          text: 'Login implementation complete',
        })
      } finally {
        db.close()
      }
    } finally {
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
      await store.close()
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      rmSync(root, { force: true, recursive: true })
    }
  })
})
