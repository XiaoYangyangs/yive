import { normalizeVerifiedConversationText } from '../../../src/shared/conversation-content.js'
import type { MobileConversationInvalidation } from '../../../src/shared/types.js'
import { recordCompletedMobileReply } from './mobile-chat-unread.js'
import type { MobileRuntimeClient } from './mobile-runtime-client.js'

export const sanitizeMobileChatNotificationPreview = (text: string) =>
  normalizeVerifiedConversationText(text).replace(/\s+/gu, ' ').trim().slice(0, 80)

export const applyMobileChatDeepLink = (invalidation: MobileConversationInvalidation) => {
  const url = new URL(window.location.href)
  url.searchParams.set('workspace_id', invalidation.workspace_id)
  url.searchParams.set('agent_id', invalidation.agent_id)
  url.searchParams.set('conversation_id', invalidation.conversation_id)
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

export const readMobileChatDeepLink = () => {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const workspaceId = params.get('workspace_id')
  const agentId = params.get('agent_id')
  const conversationId = params.get('conversation_id')
  return workspaceId && agentId && conversationId ? { agentId, conversationId, workspaceId } : null
}

export const loadCompletedMobileChatUpdate = async (
  client: MobileRuntimeClient,
  storage: Storage,
  invalidation: MobileConversationInvalidation
) => {
  const conversation = await client.getCurrentConversation(
    invalidation.workspace_id,
    invalidation.agent_id,
    Math.max(0, invalidation.cursor - 1)
  )
  if (!conversation || conversation.id !== invalidation.conversation_id) return null
  const completed = recordCompletedMobileReply(storage, conversation, conversation.turns)
  const turn = completed.newTurns[completed.newTurns.length - 1]
  return turn
    ? {
        conversation,
        preview: sanitizeMobileChatNotificationPreview(turn.text),
        turn,
      }
    : null
}

export const showMobileChatCompletionNotification = ({
  agentName,
  onClick,
  preview,
  tag,
}: {
  agentName: string
  onClick: () => void
  preview: string
  tag: string
}) => {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (Notification.permission !== 'granted') return
  try {
    const notification = new Notification(agentName, { body: preview, tag })
    notification.onclick = () => {
      window.focus()
      onClick()
    }
  } catch (error) {
    console.warn('Failed to show mobile Chat completion notification', error)
  }
}
