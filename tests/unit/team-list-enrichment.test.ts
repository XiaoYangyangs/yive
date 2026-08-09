import { describe, expect, test, vi } from 'vitest'

import type { AgentLaunchConfigInput } from '../../src/server/agent-run-store.js'
import type { RuntimeStore } from '../../src/server/runtime-store.js'
import { enrichTeamList, resolveAgentProvider } from '../../src/server/team-list-enrichment.js'
import type { TeamListItem } from '../../src/shared/types.js'

const makeStore = (launchConfigs: Map<string, AgentLaunchConfigInput>, lastPtyLines = new Map()) =>
  ({
    getLastPtyLineForAgent: vi.fn(
      (_workspaceId: string, agentId: string) => lastPtyLines.get(agentId) ?? null
    ),
    peekAgentLaunchConfig: vi.fn((_workspaceId: string, agentId: string) =>
      launchConfigs.get(agentId)
    ),
  }) as unknown as Pick<RuntimeStore, 'getLastPtyLineForAgent' | 'peekAgentLaunchConfig'>

const worker = (overrides: Partial<TeamListItem> = {}): TeamListItem => ({
  activeDispatchId: null,
  conversationActivity: 'idle',
  id: 'worker-1',
  kind: 'worker',
  lastObservedAt: 1_754_360_000_000,
  name: 'alice',
  processState: 'running',
  queuePauseReason: null,
  queuedDispatchCount: 0,
  ...overrides,
})

describe('managed Provider team-list enrichment', () => {
  test('resolves only an explicit managed Provider', () => {
    const store = makeStore(
      new Map([['worker-1', { command: 'claude', args: [], provider: 'claude' }]])
    )
    expect(resolveAgentProvider(store, 'ws-1', 'worker-1')).toBe('claude')
  })

  test('does not infer a Provider from an unsupported or generic config', () => {
    const store = makeStore(
      new Map([
        [
          'worker-1',
          {
            command: 'bash',
            args: ['-c', 'echo'],
            provider: null,
            sessionIdCapture: { pattern: 'stdout', source: 'stdout_regex' },
          },
        ],
      ])
    )
    expect(resolveAgentProvider(store, 'ws-1', 'worker-1')).toBeNull()
  })

  test('adds Provider and last PTY line without mutating the source record', () => {
    const sourceWorker = worker({ id: 'worker-1' })
    const store = makeStore(
      new Map([['worker-1', { command: 'codex', args: [], provider: 'codex' }]]),
      new Map([['worker-1', 'Editing src/index.ts (line 12)']])
    )
    const [result] = enrichTeamList('ws-1', store, [sourceWorker])

    expect(result).toMatchObject({
      lastPtyLine: 'Editing src/index.ts (line 12)',
      provider: 'codex',
    })
    expect(sourceWorker.provider).toBeUndefined()
  })

  test('omits Provider when no launch config exists', () => {
    const [result] = enrichTeamList('ws-1', makeStore(new Map()), [worker()])
    expect(result).toBeDefined()
    expect('provider' in (result ?? {})).toBe(false)
  })
})
