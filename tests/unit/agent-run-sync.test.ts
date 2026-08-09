import { describe, expect, test } from 'vitest'

import { completeLiveRun, syncPersistedRun } from '../../src/server/agent-run-sync.js'
import type { LiveAgentRun } from '../../src/server/agent-runtime-types.js'

const createLiveRun = (): LiveAgentRun => ({
  agentId: 'agent-1',
  exitCode: null,
  output: 'before',
  pid: 42,
  runId: 'run-1',
  startedAt: 1,
  status: 'running',
})

const failingStore = {
  updatePersistedRun: () => {
    throw new Error('sqlite update failed')
  },
}

describe('agent run persistence ordering', () => {
  test('does not advance synchronized in-memory state when persistence fails', () => {
    const run = createLiveRun()

    expect(() =>
      syncPersistedRun(
        run,
        {
          agentId: run.agentId,
          exitCode: 1,
          output: 'after',
          pid: run.pid,
          runId: run.runId,
          status: 'error',
        },
        failingStore
      )
    ).toThrow('sqlite update failed')

    expect(run).toMatchObject({ exitCode: null, output: 'before', status: 'running' })
  })

  test('does not complete the in-memory run when persistence fails', () => {
    const run = createLiveRun()

    expect(() => completeLiveRun(run, 1, 2, failingStore)).toThrow('sqlite update failed')

    expect(run).toMatchObject({ exitCode: null, status: 'running' })
  })
})
