import { describe, expect, test, vi } from 'vitest'

import { createAgentLaunchCache } from '../../src/server/agent-launch-cache.js'
import type { AgentLaunchConfigInput } from '../../src/server/agent-run-store.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'

const config = (provider: 'claude' | 'codex'): AgentLaunchConfigInput =>
  buildManagedProviderLaunchConfig(provider)

describe('agent launch cache', () => {
  test('negative-caches missing launch configs until save', () => {
    const rows: Array<{ agentId: string; config: AgentLaunchConfigInput; workspaceId: string }> = []
    const store = {
      deleteLaunchConfig: vi.fn(),
      listLaunchConfigs: vi.fn(() => rows),
      saveLaunchConfig: vi.fn(),
    }
    const cache = createAgentLaunchCache(store)

    expect(cache.peek('workspace-1', 'agent-a')).toBeUndefined()
    expect(cache.peek('workspace-1', 'agent-a')).toBeUndefined()
    expect(store.listLaunchConfigs).toHaveBeenCalledTimes(2)

    cache.save('workspace-1', 'agent-a', config('codex'))
    expect(cache.peek('workspace-1', 'agent-a')).toMatchObject({
      command: 'codex',
      provider: 'codex',
    })
    expect(store.listLaunchConfigs).toHaveBeenCalledTimes(2)
  })

  test('remove records a miss so repeated peeks avoid store reloads', () => {
    const rows = [{ agentId: 'agent-a', config: config('codex'), workspaceId: 'workspace-1' }]
    const store = {
      deleteLaunchConfig: vi.fn(),
      listLaunchConfigs: vi.fn(() => rows),
      saveLaunchConfig: vi.fn(),
    }
    const cache = createAgentLaunchCache(store)

    expect(cache.peek('workspace-1', 'agent-a')).toMatchObject({
      command: 'codex',
      provider: 'codex',
    })
    cache.remove('workspace-1', 'agent-a')
    expect(cache.peek('workspace-1', 'agent-a')).toBeUndefined()
    expect(cache.peek('workspace-1', 'agent-a')).toBeUndefined()
    expect(store.listLaunchConfigs).toHaveBeenCalledTimes(1)
  })
})
