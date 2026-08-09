import { describe, expect, test, vi } from 'vitest'
import type { PersistedAgentRun } from '../../src/server/agent-run-store.js'
import { createRestartPolicy } from '../../src/server/restart-policy.js'

const run = (runId: string): PersistedAgentRun => ({
  agentId: 'workspace-1:orchestrator',
  endedAt: null,
  exitCode: null,
  pid: 1,
  processState: 'running',
  runId,
  startedAt: runId === 'current' ? 2 : 1,
  status: 'running',
})

const createPolicy = () =>
  createRestartPolicy({
    deleteMessage: vi.fn(),
    getWorkspaceSnapshot: () => ({
      agents: [
        {
          id: 'workspace-1:orchestrator',
          kind: 'orchestrator',
          name: 'Orchestrator',
          workspaceId: 'workspace-1',
        },
      ],
      summary: { id: 'workspace-1', name: 'Alpha', path: 'C:/alpha' },
    }),
    insertMessage: vi.fn(() => ({ sequence: 1 })),
    listAgentRuns: () => [run('current'), run('previous')],
  })

describe('restart policy Runtime Context injection', () => {
  test('injects the registered bounded Context instead of replaying legacy state', async () => {
    const policy = createPolicy()
    policy.setContextBuilder(() => ({ members: [], scope: 'team' }))
    const writeToRun = vi.fn(async () => true)

    await expect(
      policy.injectPostStartMessage({
        agentId: 'workspace-1:orchestrator',
        runId: 'current',
        startConfig: { command: 'codex', provider: 'codex' },
        workspace: { id: 'workspace-1', name: 'Alpha', path: 'C:/alpha' },
        writeToRun,
      })
    ).resolves.toBe(true)

    const payload = String(writeToRun.mock.calls[0]?.[1])
    expect(payload).toContain('"scope":"team"')
    expect(payload).not.toContain('legacy tasks content')
    expect(payload).not.toContain('Recent user input')
  })

  test('injects current Context into a natively resumed Provider Session', async () => {
    const policy = createPolicy()
    policy.setContextBuilder(() => ({ members: [], scope: 'team' }))
    const writeToRun = vi.fn(async () => true)

    await expect(
      policy.injectPostStartMessage({
        agentId: 'workspace-1:orchestrator',
        runId: 'current',
        startConfig: {
          command: 'codex',
          provider: 'codex',
          resumedSessionId: 'provider-session-1',
        },
        workspace: { id: 'workspace-1', name: 'Alpha', path: 'C:/alpha' },
        writeToRun,
      })
    ).resolves.toBe(true)
    expect(String(writeToRun.mock.calls[0]?.[1])).toContain('"scope":"team"')
  })

  test('does not inject when the registered Context is explicitly empty', async () => {
    const policy = createPolicy()
    policy.setContextBuilder(() => undefined)
    const writeToRun = vi.fn(async () => true)

    await expect(
      policy.injectPostStartMessage({
        agentId: 'workspace-1:orchestrator',
        runId: 'current',
        startConfig: { command: 'codex', provider: 'codex' },
        workspace: { id: 'workspace-1', name: 'Alpha', path: 'C:/alpha' },
        writeToRun,
      })
    ).resolves.toBe(true)
    expect(writeToRun).not.toHaveBeenCalled()
  })

  test('injects a discovery fallback when Runtime Context construction fails', async () => {
    const policy = createPolicy()
    policy.setContextBuilder(() => {
      throw new Error('multiple active Dispatches')
    })
    const writeToRun = vi.fn(async () => true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      policy.injectPostStartMessage({
        agentId: 'workspace-1:orchestrator',
        runId: 'current',
        startConfig: { command: 'codex', provider: 'codex' },
        workspace: { id: 'workspace-1', name: 'Alpha', path: 'C:/alpha' },
        writeToRun,
      })
    ).resolves.toBe(true)

    expect(String(writeToRun.mock.calls[0]?.[1])).toContain(
      'Runtime Context unavailable; run `team context` for a fresh snapshot.'
    )
    expect(warn).toHaveBeenCalledOnce()
  })

  test('reports delayed recovery delivery failure and removes its persisted message', async () => {
    const deleteMessage = vi.fn()
    const policy = createRestartPolicy({
      deleteMessage,
      getWorkspaceSnapshot: () => ({
        agents: [
          {
            id: 'workspace-1:orchestrator',
            kind: 'orchestrator',
            name: 'Orchestrator',
            workspaceId: 'workspace-1',
          },
        ],
        summary: { id: 'workspace-1', name: 'Alpha', path: 'C:/alpha' },
      }),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      listAgentRuns: () => [run('current'), run('previous')],
    })
    policy.setContextBuilder(() => ({ members: [], scope: 'team' }))

    await expect(
      policy.injectPostStartMessage({
        agentId: 'workspace-1:orchestrator',
        runId: 'current',
        startConfig: { command: 'codex', provider: 'codex' },
        workspace: { id: 'workspace-1', name: 'Alpha', path: 'C:/alpha' },
        writeToRun: async () => false,
      })
    ).resolves.toBe(false)
    expect(deleteMessage).toHaveBeenCalledWith({ sequence: 1 })
  })
})
