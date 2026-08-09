import { describe, expect, test } from 'vitest'

import { buildAgentState } from '../../src/server/agent-state.js'
import type { DispatchRecord } from '../../src/server/dispatch-ledger-store.js'

const dispatch = (id: string, status: DispatchRecord['status']): DispatchRecord => ({
  artifacts: [],
  createdAt: 1,
  deliveredAt: null,
  fromAgentId: 'orchestrator-1',
  id,
  reportedAt: null,
  reportText: null,
  sequence: null,
  status,
  submittedAt: status === 'submitted' ? 1 : null,
  text: id,
  toAgentId: 'worker-1',
  workspaceId: 'workspace-1',
})

describe('canonical Agent state', () => {
  test('projects one active Dispatch and counts only queued Dispatches', () => {
    const state = buildAgentState({
      activeRun: undefined,
      agent: { id: 'worker-1' },
      conversation: null,
      dispatches: [dispatch('active-1', 'submitted'), dispatch('queued-1', 'queued')],
      runs: [],
    })

    expect(state.activeDispatchId).toBe('active-1')
    expect(state.queuedDispatchCount).toBe(1)
  })

  test('rejects an unrepresentable state with multiple active Dispatches', () => {
    expect(() =>
      buildAgentState({
        activeRun: undefined,
        agent: { id: 'worker-1' },
        conversation: null,
        dispatches: [dispatch('active-1', 'submitted'), dispatch('active-2', 'submitted')],
        runs: [],
      })
    ).toThrow('Agent worker-1 has multiple active Dispatches')
  })
})
