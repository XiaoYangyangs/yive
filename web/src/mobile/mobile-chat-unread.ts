import type { MobileConversationPage, MobileConversationTurn } from '../../../src/shared/types.js'

const INDEX_KEY = 'yive.mobile.chat-unread-index'
export const MOBILE_CHAT_UNREAD_CHANGED_EVENT = 'yive-mobile-chat-unread-changed'

interface ConversationReadState {
  notified: string[]
  unread: string[]
}

type UnreadIndex = Record<string, number>

const identityKey = (conversation: MobileConversationPage) =>
  `${conversation.workspace_id}:${conversation.agent_id}:${conversation.provider}:${conversation.cli_session_id}`

const stateKey = (conversation: MobileConversationPage) =>
  `yive.mobile.chat-state:${identityKey(conversation)}`

const agentKey = (workspaceId: string, agentId: string) => `${workspaceId}:${agentId}`

const readJson = <T>(storage: Storage, key: string, fallback: T): T => {
  const value = storage.getItem(key)
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch (error) {
    if (error instanceof SyntaxError) return fallback
    throw error
  }
}

const writeIndex = (storage: Storage, index: UnreadIndex) => {
  storage.setItem(INDEX_KEY, JSON.stringify(index))
}

export const readMobileChatUnreadIndex = (storage: Storage): UnreadIndex =>
  readJson(storage, INDEX_KEY, {})

export const recordCompletedMobileReply = (
  storage: Storage,
  conversation: MobileConversationPage,
  turns: MobileConversationTurn[]
) => {
  const key = stateKey(conversation)
  const state = readJson<ConversationReadState>(storage, key, { notified: [], unread: [] })
  const notified = new Set(state.notified)
  const unread = new Set(state.unread)
  const newTurns = turns.filter(
    (turn) => turn.role === 'assistant' && !notified.has(turn.provider_event_id)
  )
  for (const turn of newTurns) {
    notified.add(turn.provider_event_id)
    unread.add(turn.provider_event_id)
  }
  if (newTurns.length === 0) return { newTurns, unreadCount: unread.size }
  storage.setItem(key, JSON.stringify({ notified: [...notified], unread: [...unread] }))
  const index = readMobileChatUnreadIndex(storage)
  const indexKey = agentKey(conversation.workspace_id, conversation.agent_id)
  index[indexKey] = Math.max(0, (index[indexKey] ?? 0) + unread.size - state.unread.length)
  writeIndex(storage, index)
  return { newTurns, unreadCount: unread.size }
}

export const clearMobileConversationUnread = (
  storage: Storage,
  conversation: MobileConversationPage
) => {
  const key = stateKey(conversation)
  const state = readJson<ConversationReadState>(storage, key, { notified: [], unread: [] })
  if (state.unread.length === 0) return false
  storage.setItem(key, JSON.stringify({ ...state, unread: [] }))
  const index = readMobileChatUnreadIndex(storage)
  const indexKey = agentKey(conversation.workspace_id, conversation.agent_id)
  const remaining = Math.max(0, (index[indexKey] ?? 0) - state.unread.length)
  if (remaining === 0) delete index[indexKey]
  else index[indexKey] = remaining
  writeIndex(storage, index)
  return true
}

export const emitMobileChatUnreadChanged = () => {
  window.dispatchEvent(new Event(MOBILE_CHAT_UNREAD_CHANGED_EVENT))
}
