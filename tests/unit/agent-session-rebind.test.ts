import { describe, expect, test } from 'vitest'

import { refreshAgentSessionBinding } from '../../src/server/agent-session-rebind.js'
import type { AgentSessionStore } from '../../src/server/agent-session-store.js'

const workspace = {
  id: 'workspace-1',
  name: 'Workspace',
  path: '/tmp/workspace',
}
const agent = {
  description: 'Orchestrator',
  id: 'agent-1',
  name: 'Orchestrator',
  pendingTaskCount: 0,
  kind: 'orchestrator' as const,
  status: 'working' as const,
  workspaceId: workspace.id,
}

describe('agent session rebind', () => {
  test('saves the session owned by the active PTY instead of scanning by file recency', () => {
    let storedSessionId = 'old-session'
    let explicitlySaved = false
    const sessionStore: AgentSessionStore = {
      beginSaveIntent: () => {
        throw new Error('not used')
      },
      clearLastSessionId: () => {},
      clearLastSessionIdIfMatches: () => false,
      getLastSessionId: () => storedSessionId,
      getSessionBinding: () => undefined,
      getSaveIntent: () => undefined,
      completeSaveIntent: () => undefined,
      failPendingSaveIntent: () => undefined,
      failPendingSaveIntentsForRuntimeRestart: () => 0,
      saveLastSessionId: (_workspaceId, _agentId, sessionId) => {
        explicitlySaved = true
        storedSessionId = sessionId
      },
      setLastSessionId: (_workspaceId, _agentId, sessionId) => {
        storedSessionId = sessionId
      },
    }

    const result = refreshAgentSessionBinding({
      activeRunId: 'run-1',
      activeSessionId: 'active-pty-session',
      agentId: agent.id,
      config: {
        args: [],
        command: 'codex',
        provider: 'codex',
        sessionIdCapture: {
          pattern: '~/.codex/sessions/**/*.jsonl',
          source: 'codex_session_jsonl_dir',
        },
      },
      sessionStore,
      workspace,
    })

    expect(result).toEqual({
      captureSource: 'codex_session_jsonl_dir',
      failureReason: null,
      previousSessionId: 'old-session',
      requestId: null,
      runId: 'run-1',
      sessionId: 'active-pty-session',
      state: 'saved',
      unchanged: false,
    })
    expect(storedSessionId).toBe('active-pty-session')
    expect(explicitlySaved).toBe(true)
  })

  test('reports unresolved without guessing when there is no active PTY run', () => {
    const sessionStore: AgentSessionStore = {
      beginSaveIntent: () => {
        throw new Error('not used')
      },
      clearLastSessionId: () => {},
      clearLastSessionIdIfMatches: () => false,
      getLastSessionId: () => 'previous-session',
      getSessionBinding: () => undefined,
      getSaveIntent: () => undefined,
      completeSaveIntent: () => undefined,
      failPendingSaveIntent: () => undefined,
      failPendingSaveIntentsForRuntimeRestart: () => 0,
      saveLastSessionId: () => {},
      setLastSessionId: () => {},
    }

    expect(
      refreshAgentSessionBinding({
        activeSessionId: null,
        agentId: agent.id,
        config: {
          args: [],
          command: 'codex',
          provider: 'codex',
          sessionIdCapture: {
            pattern: '~/.codex/sessions/**/*.jsonl',
            source: 'codex_session_jsonl_dir',
          },
        },
        sessionStore,
        workspace,
      })
    ).toEqual({
      captureSource: 'codex_session_jsonl_dir',
      failureReason: null,
      previousSessionId: 'previous-session',
      requestId: null,
      runId: null,
      sessionId: null,
      state: 'unresolved',
      unchanged: true,
    })
  })

  test('rejects saving when the launch Provider changed during the active run', () => {
    let saved = false
    const sessionStore = {
      getLastSessionId: () => 'saved-session',
      getSessionBinding: () => ({ savedAt: 1, sessionId: 'saved-session' }),
      getSaveIntent: () => undefined,
      saveLastSessionId: () => {
        saved = true
      },
    } as unknown as AgentSessionStore

    expect(
      refreshAgentSessionBinding({
        activeRunId: 'run-1',
        activeSessionCapture: {
          pattern: '~/.codex/sessions/**/*.jsonl',
          source: 'codex_session_jsonl_dir',
        },
        activeSessionId: 'active-codex-session',
        agentId: agent.id,
        config: {
          args: [],
          command: 'claude',
          provider: 'claude',
          sessionIdCapture: {
            pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
            source: 'claude_project_jsonl_dir',
          },
        },
        sessionStore,
        workspace,
      })
    ).toMatchObject({ failureReason: 'provider_changed', state: 'failed', unchanged: true })
    expect(saved).toBe(false)
  })

  test('reports unresolved without capture when no active run exists', () => {
    const sessionStore = {
      getLastSessionId: () => 'previous-session',
      getSessionBinding: () => undefined,
      getSaveIntent: () => undefined,
      saveLastSessionId: () => {
        throw new Error('should not save')
      },
    } as unknown as AgentSessionStore

    expect(
      refreshAgentSessionBinding({
        activeSessionId: null,
        agentId: agent.id,
        config: { args: [], command: 'codex', provider: 'codex' },
        sessionStore,
        workspace,
      })
    ).toEqual({
      captureSource: null,
      failureReason: null,
      previousSessionId: 'previous-session',
      requestId: null,
      runId: null,
      sessionId: null,
      state: 'unresolved',
      unchanged: true,
    })
  })

  test('fails with capture_unavailable when an active run cannot capture sessions', () => {
    const sessionStore = {
      getLastSessionId: () => 'previous-session',
      getSessionBinding: () => undefined,
      getSaveIntent: () => undefined,
      saveLastSessionId: () => {
        throw new Error('should not save')
      },
    } as unknown as AgentSessionStore

    expect(
      refreshAgentSessionBinding({
        activeRunId: 'run-1',
        activeSessionId: null,
        agentId: agent.id,
        config: { args: [], command: 'codex', provider: 'codex' },
        sessionStore,
        workspace,
      })
    ).toEqual({
      captureSource: null,
      failureReason: 'capture_unavailable',
      previousSessionId: 'previous-session',
      requestId: null,
      runId: 'run-1',
      sessionId: null,
      state: 'failed',
      unchanged: true,
    })
  })
})
