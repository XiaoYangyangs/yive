import { describe, expect, test, vi } from 'vitest'

import type { AgentManager } from '../../src/server/agent-manager.js'
import { AgentRunExitIntentStageError } from '../../src/server/agent-run-exit-intent-store.js'
import { createAgentRunStarter } from '../../src/server/agent-run-starter.js'
import { createAgentTokenRegistry } from '../../src/server/agent-tokens.js'
import { createLiveRunRegistry } from '../../src/server/live-run-registry.js'
import { createNoopRestartPolicy } from '../../src/server/restart-policy.js'

const sessionStore = {
  beginSaveIntent: vi.fn(),
  clearLastSessionId: vi.fn(),
  clearLastSessionIdIfMatches: vi.fn(() => false),
  completeSaveIntent: vi.fn(),
  failPendingSaveIntent: vi.fn(),
  getLastSessionId: vi.fn(() => undefined),
  getSaveIntent: vi.fn(() => undefined),
  getSessionBinding: vi.fn(() => undefined),
  saveLastSessionId: vi.fn(),
  setLastSessionId: vi.fn(),
}

describe('agent run starter', () => {
  test('does not publish an exit state when durable intent staging fails', async () => {
    const registry = createLiveRunRegistry()
    const tokenRegistry = createAgentTokenRegistry()
    let onExit: ((input: { exitCode: number | null; runId: string }) => void) | undefined
    const manager = {
      startAgent: vi.fn(async (input: { onExit: typeof onExit }) => {
        onExit = input.onExit
        return {
          agentId: 'agent-1',
          exitCode: null,
          output: '',
          pid: 42,
          runId: 'run-1',
          status: 'running' as const,
        }
      }),
    } as unknown as AgentManager
    const onAgentExit = vi.fn()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const start = createAgentRunStarter({
      agentManager: manager,
      getAgent: undefined,
      onAgentExit,
      persistRunExit: () => {
        throw new AgentRunExitIntentStageError(new Error('intent insert failed'))
      },
      registry,
      restartPolicy: createNoopRestartPolicy(),
      sessionStore,
      store: {
        insertAgentRun: vi.fn(),
        updatePersistedRun: vi.fn(),
      },
      tokenRegistry,
    })

    const run = await start(
      { id: 'workspace-1', name: 'Alpha', path: '/tmp/alpha' },
      'agent-1',
      { command: 'codex', provider: 'codex' },
      '4010',
      { suppressStartupInstructions: true }
    )
    onExit?.({ exitCode: 17, runId: 'run-1' })

    expect(run).toMatchObject({ exitCode: null, status: 'starting' })
    expect(onAgentExit).not.toHaveBeenCalled()
    expect(registry.get('run-1')).toBeUndefined()
    expect(tokenRegistry.peek('agent-1')).toBeUndefined()
    expect(errorLog).toHaveBeenCalledWith(
      '[yive] failed to persist Agent exit coordination for agent-1',
      expect.any(AgentRunExitIntentStageError)
    )
  })

  test('cleans up failed-spawn ownership when final persistence fails', async () => {
    const registry = createLiveRunRegistry()
    const resolveExit = vi.spyOn(registry, 'resolveExit')
    const clearPendingExitCode = vi.spyOn(registry, 'clearPendingExitCode')
    const tokenRegistry = createAgentTokenRegistry()
    const manager = {
      startAgent: vi.fn(async () => ({
        agentId: 'agent-1',
        exitCode: 1,
        output: 'spawn failed',
        pid: null,
        runId: 'run-1',
        status: 'error' as const,
      })),
    } as unknown as AgentManager
    const persistRunExit = vi.fn(() => {
      throw new Error('sqlite crash persistence failed')
    })
    const start = createAgentRunStarter({
      agentManager: manager,
      getAgent: undefined,
      onAgentExit: vi.fn(),
      persistRunExit,
      registry,
      restartPolicy: createNoopRestartPolicy(),
      sessionStore,
      store: {
        insertAgentRun: vi.fn(),
        updatePersistedRun: vi.fn(),
      },
      tokenRegistry,
    })

    await expect(
      start(
        { id: 'workspace-1', name: 'Alpha', path: '/tmp/alpha' },
        'agent-1',
        { command: 'codex', provider: 'codex' },
        '4010',
        { suppressStartupInstructions: true }
      )
    ).rejects.toThrow('sqlite crash persistence failed')

    expect(persistRunExit).toHaveBeenCalledOnce()
    expect(tokenRegistry.peek('agent-1')).toBeUndefined()
    expect(resolveExit).toHaveBeenCalledWith('run-1')
    expect(clearPendingExitCode).toHaveBeenCalledWith('run-1')
  })

  test('does not publish a failed-spawn exit when durable intent staging fails', async () => {
    const registry = createLiveRunRegistry()
    const tokenRegistry = createAgentTokenRegistry()
    const manager = {
      startAgent: vi.fn(async () => ({
        agentId: 'agent-1',
        exitCode: 1,
        output: 'spawn failed',
        pid: null,
        runId: 'run-1',
        status: 'error' as const,
      })),
    } as unknown as AgentManager
    const onAgentExit = vi.fn()
    const insertAgentRun = vi.fn()
    const updatePersistedRun = vi.fn()
    const start = createAgentRunStarter({
      agentManager: manager,
      getAgent: undefined,
      onAgentExit,
      persistRunExit: () => {
        throw new AgentRunExitIntentStageError(new Error('intent insert failed'))
      },
      registry,
      restartPolicy: createNoopRestartPolicy(),
      sessionStore,
      store: {
        insertAgentRun,
        updatePersistedRun,
      },
      tokenRegistry,
    })

    await expect(
      start(
        { id: 'workspace-1', name: 'Alpha', path: '/tmp/alpha' },
        'agent-1',
        { command: 'codex', provider: 'codex' },
        '4010',
        { suppressStartupInstructions: true }
      )
    ).rejects.toBeInstanceOf(AgentRunExitIntentStageError)

    expect(insertAgentRun).toHaveBeenCalledWith(
      'run-1',
      'agent-1',
      expect.any(Number),
      null,
      'starting',
      null
    )
    expect(updatePersistedRun).not.toHaveBeenCalled()
    expect(onAgentExit).not.toHaveBeenCalled()
    expect(registry.get('run-1')).toBeUndefined()
    expect(tokenRegistry.peek('agent-1')).toBeUndefined()
  })
})
