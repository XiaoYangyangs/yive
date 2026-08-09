import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import type { MobileConversationPage } from '../../src/shared/types.js'

const codexSessionMocks = vi.hoisted(() => ({
  findCodexSessionFile: vi.fn(),
  findLatestCodexSessionForAgent: vi.fn(),
}))

vi.mock('../../src/server/session-capture-codex.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/server/session-capture-codex.js')>()
  return { ...actual, ...codexSessionMocks }
})

import { createActiveConversationObserver } from '../../src/server/active-conversation-observer.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  codexSessionMocks.findCodexSessionFile.mockReset()
  codexSessionMocks.findLatestCodexSessionForAgent.mockReset()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('active conversation observer', () => {
  test('reuses a verified active Codex source without running a fallback catalog scan', () => {
    const directory = mkdtempSync(join(tmpdir(), 'yive-active-conversation-'))
    temporaryDirectories.push(directory)
    const sourcePath = join(directory, 'rollout-session-1.jsonl')
    writeFileSync(
      sourcePath,
      `${JSON.stringify({
        payload: { cwd: directory, id: 'session-1' },
        type: 'session_meta',
      })}\n`
    )
    const checkpoint = statSync(sourcePath).size
    const storedConversation = {
      activity_state: 'idle',
      active: true,
      agent_id: 'agent-1',
      cli_session_id: 'session-1',
      created_at: 1,
      id: 'conversation-1',
      provider: 'codex',
      stale: false,
      submissions: [],
      tool_activity: [],
      turns: [],
      updated_at: 1,
      workspace_id: 'workspace-1',
    } as unknown as MobileConversationPage
    const activeObservation = {
      cli_session_id: 'session-1',
      id: 'conversation-1',
      provider: 'codex',
      source_checkpoint: checkpoint,
      source_path: sourcePath,
    }
    const services = {
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1', sessionId: 'session-1' })),
        peekAgentLaunchConfig: vi.fn(() => ({
          provider: 'codex',
          sessionIdCapture: {
            pattern: '~/.codex/sessions/**/*.jsonl',
            source: 'codex_session_jsonl_dir',
          },
        })),
      },
      agentSessionStore: {
        getLastSessionId: vi.fn(() => 'session-1'),
        setLastSessionId: vi.fn(),
      },
      chatSubmissionStore: {
        confirmVerifiedUserTurns: vi.fn(),
        listForConversation: vi.fn(() => []),
        listPausedForAgent: vi.fn(() => []),
        pauseConversation: vi.fn(),
      },
      conversationStore: {
        appendTurns: vi.fn(),
        getActiveObservation: vi.fn(() => activeObservation),
        getCurrentConversation: vi.fn(() => storedConversation),
        markStale: vi.fn(),
        observeConversation: vi.fn(() => activeObservation),
      },
      db: {
        transaction: vi.fn((operation: () => void) => operation),
      },
      workspaceStore: {
        getAgent: vi.fn(),
        getWorkspaceSnapshot: vi.fn(() => ({
          agents: [{ id: 'agent-1' }],
          summary: { id: 'workspace-1', path: directory },
        })),
        listWorkspaces: vi.fn(() => []),
      },
    } as unknown as Parameters<typeof createActiveConversationObserver>[0]
    codexSessionMocks.findCodexSessionFile.mockImplementation(() => {
      throw new Error('Codex fallback catalog scan should not run')
    })
    codexSessionMocks.findLatestCodexSessionForAgent.mockReturnValue({
      filePath: sourcePath,
      id: 'session-1',
      mtimeMs: 1,
    })

    const observer = createActiveConversationObserver(services)
    try {
      expect(observer.getCurrentConversation('workspace-1', 'agent-1')).toMatchObject({
        id: 'conversation-1',
      })
    } finally {
      observer.close()
    }

    expect(codexSessionMocks.findLatestCodexSessionForAgent).not.toHaveBeenCalled()
    expect(codexSessionMocks.findCodexSessionFile).not.toHaveBeenCalled()
  })

  test('projects stored history as stale while an active run has no verified Session', () => {
    const storedConversation = {
      activity_state: 'idle',
      agent_id: 'agent-1',
      cli_session_id: 'old-session',
      id: 'conversation-1',
      stale: false,
      submissions: [],
      tool_activity: [],
      turns: [{ text: 'preserved history' }],
      workspace_id: 'workspace-1',
    } as unknown as MobileConversationPage
    const services = {
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-new', sessionId: undefined })),
        peekAgentLaunchConfig: vi.fn(() => ({ provider: 'codex' })),
      },
      chatSubmissionStore: {
        listForConversation: vi.fn(() => []),
        listPausedForAgent: vi.fn(() => []),
      },
      conversationStore: {
        getActiveObservation: vi.fn(),
        getCurrentConversation: vi.fn(() => storedConversation),
      },
      workspaceStore: {
        getAgent: vi.fn(),
        getWorkspaceSnapshot: vi.fn(() => ({
          agents: [{ id: 'agent-1' }],
          summary: { id: 'workspace-1', path: '/workspace' },
        })),
        listWorkspaces: vi.fn(() => []),
      },
    } as unknown as Parameters<typeof createActiveConversationObserver>[0]

    const observer = createActiveConversationObserver(services)
    try {
      expect(observer.getCurrentConversation('workspace-1', 'agent-1')).toMatchObject({
        activity_state: 'idle',
        stale: true,
        turns: [{ text: 'preserved history' }],
      })
    } finally {
      observer.close()
    }
  })
})
