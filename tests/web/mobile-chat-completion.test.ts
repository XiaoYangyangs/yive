// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  applyMobileChatDeepLink,
  loadCompletedMobileChatUpdate,
  readMobileChatDeepLink,
  sanitizeMobileChatNotificationPreview,
} from '../../web/src/mobile/mobile-chat-completion.js'
import type { MobileRuntimeClient } from '../../web/src/mobile/mobile-runtime-client.js'

beforeEach(() => localStorage.clear())

describe('mobile chat completion notification', () => {
  test('sanitizes secrets and local paths from its short preview', () => {
    const preview = sanitizeMobileChatNotificationPreview(
      'Done C:/Users/example/private HIVE_AGENT_TOKEN=secret-token Bearer bearer-secret'
    )
    expect(preview).not.toContain('C:/Users')
    expect(preview).not.toContain('secret-token')
    expect(preview).not.toContain('bearer-secret')
    expect(preview.length).toBeLessThanOrEqual(80)
  })

  test('writes and reads the exact workspace, agent, and conversation deep-link', () => {
    window.history.replaceState({}, '', '/mobile')
    applyMobileChatDeepLink({
      activity_state: 'idle',
      agent_id: 'agent-1',
      conversation_id: 'conversation-1',
      cursor: 42,
      type: 'conversation-invalidated',
      workspace_id: 'workspace-1',
    })
    expect(readMobileChatDeepLink()).toEqual({
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      workspaceId: 'workspace-1',
    })
  })

  test('fetches the completion cursor and deduplicates notification work by provider turn', async () => {
    const getCurrentConversation = vi.fn().mockResolvedValue({
      activity_state: 'idle',
      agent_id: 'agent-1',
      cli_session_id: 'session-1',
      cursor: 42,
      id: 'conversation-1',
      provider: 'codex',
      recording_boundary: 0,
      source_checkpoint: 42,
      stale: false,
      submissions: [],
      tool_activity: [],
      turns: [
        {
          provider_event_id: 'reply-1',
          role: 'assistant',
          sequence: 1,
          source_checkpoint: 42,
          text: 'Done C:/private HIVE_AGENT_TOKEN=secret-token',
        },
      ],
      workspace_id: 'workspace-1',
    })
    const client = { getCurrentConversation } as unknown as MobileRuntimeClient
    const invalidation = {
      activity_state: 'idle' as const,
      agent_id: 'agent-1',
      conversation_id: 'conversation-1',
      cursor: 42,
      type: 'conversation-invalidated' as const,
      workspace_id: 'workspace-1',
    }

    await expect(
      loadCompletedMobileChatUpdate(client, localStorage, invalidation)
    ).resolves.toMatchObject({ preview: 'Done [local path] HIVE_AGENT_TOKEN=[redacted]' })
    await expect(
      loadCompletedMobileChatUpdate(client, localStorage, invalidation)
    ).resolves.toBeNull()
    expect(getCurrentConversation).toHaveBeenCalledWith('workspace-1', 'agent-1', 41)
  })
})
