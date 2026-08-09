import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import type { AgentManager, AgentRunSnapshot } from '../../src/server/agent-manager.js'
import { createAgentRuntime } from '../../src/server/agent-runtime.js'
import type { AgentSessionStore } from '../../src/server/agent-session-store.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'

const outputBus = {
  clear: () => {},
  publish: () => {},
  subscribe: () => () => {},
}
const tempDirs: string[] = []

afterEach(() => {
  vi.useRealTimers()
  delete process.env.CODEX_HOME
  for (const directory of tempDirs.splice(0)) rmSync(directory, { force: true, recursive: true })
})

const createFixture = (
  inputIsDurable: boolean,
  completesCheckpoint = true,
  checkpointSessionId?: string,
  verifySessionOnStart = true,
  pendingSaveWithoutBinding = false
) => {
  const root = join(tmpdir(), `yive-safe-stop-${crypto.randomUUID()}`)
  const workspacePath = join(root, 'workspace')
  const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const sessionDirectory = join(root, '.codex', 'sessions', '2026', '07', '21')
  const sessionPath = join(sessionDirectory, `rollout-test-${sessionId}.jsonl`)
  tempDirs.push(root)
  mkdirSync(workspacePath, { recursive: true })
  mkdirSync(sessionDirectory, { recursive: true })
  process.env.CODEX_HOME = join(root, '.codex')
  const bindingMarker = `Hive session binding: workspace_id=workspace-1; agent_id=workspace-1:orchestrator`
  writeFileSync(
    sessionPath,
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspacePath, id: sessionId } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: bindingMarker }] } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
  )

  const workspace = { id: 'workspace-1', name: 'Workspace', path: workspacePath }
  const agent = {
    description: 'Orchestrator',
    id: `${workspace.id}:orchestrator`,
    name: 'Orchestrator',
    pendingTaskCount: 0,
    kind: 'orchestrator' as const,
    status: 'idle' as const,
    workspaceId: workspace.id,
  }
  const checkpointSessionPath = checkpointSessionId
    ? join(sessionDirectory, `rollout-test-${checkpointSessionId}.jsonl`)
    : sessionPath
  if (checkpointSessionId) {
    writeFileSync(
      checkpointSessionPath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { cwd: workspacePath, id: checkpointSessionId },
      })}\n${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Hive session binding: workspace_id=${workspace.id}; agent_id=${agent.id}`,
            },
          ],
        },
      })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
    )
  }
  let stopped = false
  let storedSessionId = sessionId
  let savedAt: number | null = pendingSaveWithoutBinding ? null : 1
  let saveIntentState: 'saved' | 'waiting' = pendingSaveWithoutBinding ? 'waiting' : 'saved'
  let pastedText = ''
  const writes: string[] = []
  const snapshot: AgentRunSnapshot = {
    agentId: agent.id,
    exitCode: null,
    lastInputAt: inputIsDurable ? null : Date.now() + 60_000,
    output: 'booting\n❯ ',
    pid: 1,
    runId: 'run-1',
    status: 'running',
  }
  const manager: AgentManager = {
    getOutputBus: () => outputBus,
    getRun: () => snapshot,
    pauseRun: () => {},
    removeRun: () => {},
    resizeRun: () => {},
    resumeRun: () => {},
    startAgent: async () => {
      if (verifySessionOnStart) {
        appendFileSync(
          sessionPath,
          `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
        )
      }
      return snapshot
    },
    stopRun: () => {
      stopped = true
      snapshot.status = 'exited'
    },
    writeInput: (_runId, text) => {
      const chunk = String(text)
      writes.push(chunk)
      snapshot.lastInputAt = Date.now()
      if (chunk.startsWith('\u001b[200~') && chunk.endsWith('\u001b[201~')) {
        pastedText = chunk.slice('\u001b[200~'.length, -'\u001b[201~'.length)
        snapshot.output += '\n[Pasted text #1]\n'
      }
      if (chunk === '\r' && completesCheckpoint) {
        appendFileSync(
          checkpointSessionPath,
          `${JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: pastedText }],
            },
          })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
        )
      }
    },
  }
  const sessionStore: AgentSessionStore = {
    beginSaveIntent: () => {
      throw new Error('not used')
    },
    clearLastSessionId: () => {
      savedAt = null
    },
    clearLastSessionIdIfMatches: () => false,
    getLastSessionId: () => storedSessionId,
    getSessionBinding: () => ({ savedAt, sessionId: storedSessionId }),
    getSaveIntent: () =>
      pendingSaveWithoutBinding
        ? {
            captureSource: 'codex_session_jsonl_dir',
            failureReason: null,
            previousSessionId: sessionId,
            provider: 'codex',
            requestedAt: 1,
            requestId: 'request-1',
            runId: 'run-1',
            sessionId: saveIntentState === 'saved' ? storedSessionId : null,
            state: saveIntentState,
            updatedAt: 1,
          }
        : undefined,
    completeSaveIntent: (_workspaceId, _agentId, _runId, nextSessionId) => {
      if (!pendingSaveWithoutBinding || saveIntentState !== 'waiting') return undefined
      storedSessionId = nextSessionId
      savedAt = Date.now()
      saveIntentState = 'saved'
      return {
        captureSource: 'codex_session_jsonl_dir',
        failureReason: null,
        previousSessionId: sessionId,
        provider: 'codex',
        requestedAt: 1,
        requestId: 'request-1',
        runId: 'run-1',
        sessionId: nextSessionId,
        state: 'saved',
        updatedAt: Date.now(),
      }
    },
    failPendingSaveIntent: () => undefined,
    failPendingSaveIntentsForRuntimeRestart: () => 0,
    saveLastSessionId: (_workspaceId, _agentId, nextSessionId) => {
      storedSessionId = nextSessionId
      savedAt = Date.now()
    },
    setLastSessionId: (_workspaceId, _agentId, nextSessionId) => {
      if (storedSessionId !== nextSessionId) savedAt = null
      storedSessionId = nextSessionId
    },
  }
  const runtime = createAgentRuntime(
    manager,
    {
      deleteLaunchConfig: () => {},
      insertAgentRun: () => {},
      listAgentRuns: () => [],
      listLaunchConfigs: () => [],
      markUnfinishedRunsStale: () => {},
      saveLaunchConfig: () => {},
      updatePersistedRun: () => {},
    },
    sessionStore,
    () => {}
  )
  runtime.configureAgentLaunch(workspace.id, agent.id, buildManagedProviderLaunchConfig('codex'))
  return {
    agent,
    runtime,
    stopped: () => stopped,
    storedSessionId: () => storedSessionId,
    workspace,
    writes,
  }
}

describe('Agent safe stop', () => {
  test('requires a checkpoint before safely stopping an unverified resumed session', async () => {
    const fixture = createFixture(true, true, undefined, false)
    const run = await fixture.runtime.startAgent(fixture.workspace, fixture.agent.id, {
      hivePort: '4010',
    })

    const result = await fixture.runtime.stopAgentRunSafely(
      fixture.workspace,
      fixture.agent.id,
      run.runId,
      { mode: 'safe' }
    )

    expect(result).toMatchObject({
      mode: 'safe',
      reason: 'session_unverified',
      sessionId: null,
      state: 'checkpoint_required',
    })
    expect(fixture.stopped()).toBe(false)
  })

  test('stops a saved durable session without writing a prompt', async () => {
    const fixture = createFixture(true)
    const run = await fixture.runtime.startAgent(fixture.workspace, fixture.agent.id, {
      hivePort: '4010',
    })

    const result = await fixture.runtime.stopAgentRunSafely(
      fixture.workspace,
      fixture.agent.id,
      run.runId,
      { mode: 'safe' }
    )

    expect(result).toMatchObject({ mode: 'safe', state: 'stopped' })
    expect(fixture.stopped()).toBe(true)
    expect(fixture.writes).toEqual([])
  })

  test('keeps the run alive when a saved session needs an explicit checkpoint', async () => {
    const fixture = createFixture(false)
    const run = await fixture.runtime.startAgent(fixture.workspace, fixture.agent.id, {
      hivePort: '4010',
    })

    const result = await fixture.runtime.stopAgentRunSafely(
      fixture.workspace,
      fixture.agent.id,
      run.runId,
      { mode: 'safe' }
    )

    expect(result).toMatchObject({
      mode: 'safe',
      reason: 'uncommitted_input',
      state: 'checkpoint_required',
    })
    expect(fixture.stopped()).toBe(false)
    expect(fixture.writes).toEqual([])
  })

  test('writes a visible checkpoint and waits for its completed Provider boundary before stopping', async () => {
    const fixture = createFixture(false)
    const run = await fixture.runtime.startAgent(fixture.workspace, fixture.agent.id, {
      hivePort: '4010',
    })

    const result = await fixture.runtime.stopAgentRunSafely(
      fixture.workspace,
      fixture.agent.id,
      run.runId,
      { mode: 'checkpoint' }
    )

    expect(result).toMatchObject({ mode: 'checkpoint', state: 'stopped' })
    expect(fixture.stopped()).toBe(true)
    expect(fixture.writes.join('')).toContain('Yive')
    expect(fixture.writes).toContain('\r')
  })

  test('coalesces concurrent checkpoint stop requests into one visible Provider turn', async () => {
    const fixture = createFixture(false)
    const run = await fixture.runtime.startAgent(fixture.workspace, fixture.agent.id, {
      hivePort: '4010',
    })

    const [first, second] = await Promise.all([
      fixture.runtime.stopAgentRunSafely(fixture.workspace, fixture.agent.id, run.runId, {
        mode: 'checkpoint',
      }),
      fixture.runtime.stopAgentRunSafely(fixture.workspace, fixture.agent.id, run.runId, {
        mode: 'checkpoint',
      }),
    ])

    expect(first).toMatchObject({ mode: 'checkpoint', state: 'stopped' })
    expect(second).toEqual(first)
    expect(fixture.writes.filter((chunk) => chunk.includes('[Yive')).length).toBe(1)
  })

  test('follows the checkpoint into the verified Codex session actually owned by the PTY', async () => {
    const checkpointSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const fixture = createFixture(false, true, checkpointSessionId, false)
    const run = await fixture.runtime.startAgent(fixture.workspace, fixture.agent.id, {
      hivePort: '4010',
    })
    vi.useFakeTimers()

    const pending = fixture.runtime.stopAgentRunSafely(
      fixture.workspace,
      fixture.agent.id,
      run.runId,
      { mode: 'checkpoint' }
    )
    await vi.advanceTimersByTimeAsync(65_000)
    const result = await pending

    expect(result).toMatchObject({
      mode: 'checkpoint',
      sessionId: checkpointSessionId,
      state: 'stopped',
    })
    expect(fixture.stopped()).toBe(true)
    expect(fixture.storedSessionId()).toBe(checkpointSessionId)
  })

  test('uses a checkpoint to complete a waiting save without an existing saved binding', async () => {
    const checkpointSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const fixture = createFixture(false, true, checkpointSessionId, false, true)
    const run = await fixture.runtime.startAgent(fixture.workspace, fixture.agent.id, {
      hivePort: '4010',
    })

    const result = await fixture.runtime.stopAgentRunSafely(
      fixture.workspace,
      fixture.agent.id,
      run.runId,
      { mode: 'checkpoint' }
    )

    expect(result).toMatchObject({
      mode: 'checkpoint',
      sessionId: checkpointSessionId,
      state: 'stopped',
    })
    expect(fixture.stopped()).toBe(true)
    expect(fixture.storedSessionId()).toBe(checkpointSessionId)
  })

  test('leaves the run alive when the Provider checkpoint does not complete before timeout', async () => {
    const fixture = createFixture(false, false)
    const run = await fixture.runtime.startAgent(fixture.workspace, fixture.agent.id, {
      hivePort: '4010',
    })
    vi.useFakeTimers()

    const pending = fixture.runtime.stopAgentRunSafely(
      fixture.workspace,
      fixture.agent.id,
      run.runId,
      { mode: 'checkpoint' }
    )
    await vi.advanceTimersByTimeAsync(65_000)

    await expect(pending).resolves.toMatchObject({
      mode: 'checkpoint',
      reason: 'timeout',
      state: 'failed',
    })
    expect(fixture.stopped()).toBe(false)
  })

  test('force stops without writing a checkpoint prompt', async () => {
    const fixture = createFixture(false)
    const run = await fixture.runtime.startAgent(fixture.workspace, fixture.agent.id, {
      hivePort: '4010',
    })

    const result = await fixture.runtime.stopAgentRunSafely(
      fixture.workspace,
      fixture.agent.id,
      run.runId,
      { mode: 'force' }
    )

    expect(result).toMatchObject({ mode: 'force', state: 'stopped' })
    expect(fixture.stopped()).toBe(true)
    expect(fixture.writes).toEqual([])
  })
})
