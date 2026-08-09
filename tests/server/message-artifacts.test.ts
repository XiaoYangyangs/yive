import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
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

describe('message artifacts', () => {
  test('report messages persist artifacts for recovery and debugging', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yive-message-artifacts-'))
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(join(workspacePath, 'src'), { recursive: true })
    writeFileSync(join(workspacePath, 'src', 'auth.ts'), 'export const auth = true\n')
    const originalCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = join(root, 'codex-home')
    const store = createRuntimeStore({
      agentManager: createAgentManager(),
      dataDir: join(root, 'runtime'),
    })

    try {
      const workspace = store.createWorkspace(workspacePath, 'Alpha')
      const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
      if (!orchestrator) throw new Error('Expected default Orchestrator')
      const worker = store.addWorker(workspace.id, { name: 'Alice' })
      const fixture = writeProviderAdapterFixture({
        fixtureId: 'message-artifacts-worker',
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

      await store.dispatchTask(workspace.id, worker.id, 'Implement login', {
        fromAgentId: orchestrator.id,
        requestId: 'artifact-dispatch',
      })
      store.reportTask(workspace.id, worker.id, {
        artifacts: ['src/auth.ts'],
        requestId: 'artifact-report',
        text: 'Login implementation complete',
      })

      expect(store.listMessagesForRecovery(workspace.id, 0)).toContainEqual(
        expect.objectContaining({
          artifacts: ['src/auth.ts'],
          text: 'Login implementation complete',
          type: 'report',
        })
      )
    } finally {
      await store.close()
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      rmSync(root, { force: true, recursive: true })
    }
  })
})
