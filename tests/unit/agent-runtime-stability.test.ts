import '../helpers/mock-node-pty.ts'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createAgentRunStore } from '../../src/server/agent-run-store.js'
import { createAgentRuntime } from '../../src/server/agent-runtime.js'

const outputBus = {
  clear: () => {},
  publish: () => {},
  subscribe: () => () => {},
}

const sessionStore = {
  beginSaveIntent: () => {
    throw new Error('not used')
  },
  clearLastSessionId: () => {},
  clearLastSessionIdIfMatches: () => false,
  getLastSessionId: () => undefined,
  getSessionBinding: () => undefined,
  getSaveIntent: () => undefined,
  completeSaveIntent: () => undefined,
  failPendingSaveIntent: () => undefined,
  saveLastSessionId: () => {},
  setLastSessionId: () => {},
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('agent runtime stability (unit)', () => {
  test('run output is capped at 1MB and keeps the tail', async () => {
    const largeOutput = 'a'.repeat(1_500_000)

    const runtime = createAgentRuntime(
      {
        getRun: () => ({
          agentId: 'agent-1',
          exitCode: null,
          output: largeOutput,
          pid: 1,
          runId: 'run-1',
          status: 'running',
        }),
        startAgent: async () => ({
          agentId: 'agent-1',
          exitCode: null,
          output: '',
          pid: 1,
          runId: 'run-1',
          status: 'running',
        }),
        getOutputBus: () => outputBus,
        pauseRun: () => {},
        removeRun: () => {},
        resizeRun: () => {},
        resumeRun: () => {},
        stopRun: () => {},
        writeInput: () => {},
      },
      {
        insertAgentRun: () => {},
        listAgentRuns: () => [],
        listLaunchConfigs: () => [
          { workspaceId: 'ws-1', agentId: 'agent-1', config: { command: '/bin/bash', args: [] } },
        ],
        deleteLaunchConfig: () => {},
        markUnfinishedRunsStale: () => {},
        saveLaunchConfig: () => {},
        updatePersistedRun: () => {},
      },
      sessionStore,
      () => undefined
    )

    const run = await runtime.startAgent({ id: 'ws-1', name: 'A', path: '/tmp/a' }, 'agent-1', {
      hivePort: '4010',
    })

    const snapshot = runtime.getLiveRun(run.runId)
    expect(snapshot.output.length).toBeLessThanOrEqual(1_000_000)
    expect(snapshot.output.slice(-100)).toBe('a'.repeat(100))
  })

  test('loads the canonical launch config from a persisted managed Provider', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE agent_launch_configs (
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      );
    `)
    db.prepare(
      `INSERT INTO agent_launch_configs (
         workspace_id,
         agent_id,
         provider,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?)`
    ).run('ws-1', 'agent-1', 'codex', Date.now(), Date.now())

    const store = createAgentRunStore(db)
    const configs = store.listLaunchConfigs()

    expect(configs).toEqual([
      {
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        config: {
          args: ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'],
          command: 'codex',
          interactiveCommand: 'codex',
          provider: 'codex',
          resumeArgsTemplate: 'resume {session_id}',
          sessionIdCapture: {
            pattern: '~/.codex/sessions/**/*.jsonl',
            source: 'codex_session_jsonl_dir',
          },
        },
      },
    ])

    db.close()
  })

  test('waits for post-start recovery before closing Runtime persistence', async () => {
    let finishRecovery: ((delivered: boolean) => void) | undefined
    const recovery = new Promise<boolean>((resolve) => {
      finishRecovery = resolve
    })
    let onExit: ((event: { exitCode: number | null; runId: string }) => void) | undefined
    const snapshot = {
      agentId: 'agent-1',
      exitCode: null as number | null,
      output: '',
      pid: 1,
      runId: 'run-1',
      status: 'running' as 'error' | 'exited' | 'running' | 'starting',
    }
    const runtime = createAgentRuntime(
      {
        getRun: () => snapshot,
        startAgent: async (input) => {
          onExit = input.onExit
          return snapshot
        },
        getOutputBus: () => outputBus,
        pauseRun: () => {},
        removeRun: () => {},
        resizeRun: () => {},
        resumeRun: () => {},
        stopRun: () => {
          snapshot.status = 'exited'
          snapshot.exitCode = 0
          onExit?.({ exitCode: 0, runId: snapshot.runId })
        },
        writeInput: () => {},
      },
      {
        insertAgentRun: () => {},
        listAgentRuns: () => [],
        listLaunchConfigs: () => [
          {
            agentId: 'agent-1',
            config: { command: 'codex', provider: 'codex' },
            workspaceId: 'ws-1',
          },
        ],
        deleteLaunchConfig: () => {},
        markUnfinishedRunsStale: () => {},
        saveLaunchConfig: () => {},
        updatePersistedRun: () => {},
      },
      sessionStore,
      () => undefined,
      {
        injectPostStartMessage: () => recovery,
        setContextBuilder: () => {},
      }
    )

    await runtime.startAgent({ id: 'ws-1', name: 'A', path: '/tmp/a' }, 'agent-1', {
      hivePort: '4010',
    })
    let closed = false
    const close = runtime.close().then(() => {
      closed = true
    })

    await vi.waitFor(() => expect(snapshot.status).toBe('exited'))
    expect(closed).toBe(false)
    finishRecovery?.(false)
    await close
    expect(closed).toBe(true)
  })
})
