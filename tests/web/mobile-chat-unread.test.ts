// @vitest-environment jsdom

import { beforeEach, describe, expect, test } from 'vitest'

import type { MobileConversationPage, MobileConversationTurn } from '../../src/shared/types.js'
import {
  clearMobileConversationUnread,
  readMobileChatUnreadIndex,
  recordCompletedMobileReply,
} from '../../web/src/mobile/mobile-chat-unread.js'

const conversation = {
  agent_id: 'agent-1',
  cli_session_id: 'session-1',
  provider: 'codex',
  workspace_id: 'workspace-1',
} as MobileConversationPage
const reply = {
  provider_event_id: 'reply-1',
  role: 'assistant',
  sequence: 1,
  text: 'done',
} as MobileConversationTurn

beforeEach(() => localStorage.clear())

describe('mobile chat unread state', () => {
  test('counts a completed provider turn once and clears it when read', () => {
    expect(recordCompletedMobileReply(localStorage, conversation, [reply]).newTurns).toEqual([
      reply,
    ])
    expect(recordCompletedMobileReply(localStorage, conversation, [reply]).newTurns).toEqual([])
    expect(readMobileChatUnreadIndex(localStorage)).toEqual({ 'workspace-1:agent-1': 1 })

    expect(clearMobileConversationUnread(localStorage, conversation)).toBe(true)
    expect(readMobileChatUnreadIndex(localStorage)).toEqual({})
  })

  test('preserves unread replies from another CLI session for the same agent', () => {
    const otherConversation = { ...conversation, cli_session_id: 'session-2' }
    const otherReply = { ...reply, provider_event_id: 'reply-2' }
    recordCompletedMobileReply(localStorage, conversation, [reply])
    recordCompletedMobileReply(localStorage, otherConversation, [otherReply])
    expect(readMobileChatUnreadIndex(localStorage)).toEqual({ 'workspace-1:agent-1': 2 })

    clearMobileConversationUnread(localStorage, conversation)
    expect(readMobileChatUnreadIndex(localStorage)).toEqual({ 'workspace-1:agent-1': 1 })
  })
})
