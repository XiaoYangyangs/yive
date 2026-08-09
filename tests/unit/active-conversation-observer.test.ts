import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test, vi } from 'vitest'

import { createActiveConversationObserver } from '../../src/server/active-conversation-observer.js'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

test('reports a verified Codex compaction boundary once without projecting its summary', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yive-observer-compaction-'))
  tempDirectories.push(directory)
  const filePath = join(directory, 'rollout-session.jsonl')
  writeFileSync(filePath, '')
  appendFileSync(
    filePath,
    `${JSON.stringify({
      payload: { message: 'private summary', type: 'context_compacted' },
      type: 'event_msg',
    })}\n`
  )

  const active = {
    cli_session_id: 'session-1',
    id: 'conversation-1',
    provider: 'codex' as const,
    source_checkpoint: 0,
    source_path: filePath,
  }
  const compacted = vi.fn()
  let committedCheckpoint = 0
  const conversation = {
    activity_state: 'idle',
    conversation_id: 'conversation-1',
    turns: [],
  }
  const services = {
    agentRuntime: {
      getActiveRunByAgentId: () => ({ runId: 'run-1', sessionId: 'session-1' }),
      peekAgentLaunchConfig: () => ({ command: 'codex', provider: 'codex' as const }),
    },
    chatSubmissionStore: {
      confirmVerifiedUserTurns: vi.fn(),
      listForConversation: () => [],
      listPausedForAgent: () => [],
    },
    conversationStore: {
      appendTurns: vi.fn((_id: string, _turns: unknown[], checkpoint: number) => {
        committedCheckpoint = checkpoint
      }),
      getActiveObservation: () => active,
      getCurrentConversation: () => conversation,
      observeConversation: () => conversation,
    },
    db: { transaction: (fn: () => void) => fn },
    workspaceStore: {
      getAgent: () => ({ id: 'worker-1' }),
      getWorkspaceSnapshot: () => ({
        summary: { id: 'workspace-1', name: 'Alpha', path: directory },
      }),
      listWorkspaces: () => [],
    },
  }
  const observer = createActiveConversationObserver(services, {
    onContextCompacted: compacted,
  })

  try {
    const result = observer.getCurrentConversation('workspace-1', 'worker-1')
    await new Promise<void>((resolve) => setImmediate(resolve))
    active.source_checkpoint = committedCheckpoint
    observer.getCurrentConversation('workspace-1', 'worker-1')
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(result?.turns).toEqual([])
    expect(compacted).toHaveBeenCalledOnce()
    expect(compacted).toHaveBeenCalledWith('workspace-1', 'worker-1')
    expect(JSON.stringify(result)).not.toContain('private summary')
  } finally {
    observer.close()
  }
})
