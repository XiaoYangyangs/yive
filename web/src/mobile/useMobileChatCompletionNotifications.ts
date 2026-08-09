import { useCallback, useEffect, useState } from 'react'

import type { MobileConversationInvalidation } from '../../../src/shared/types.js'
import {
  loadCompletedMobileChatUpdate,
  showMobileChatCompletionNotification,
} from './mobile-chat-completion.js'
import {
  emitMobileChatUnreadChanged,
  MOBILE_CHAT_UNREAD_CHANGED_EVENT,
  readMobileChatUnreadIndex,
} from './mobile-chat-unread.js'
import type { MobileRuntimeClient } from './mobile-runtime-client.js'

export const useMobileChatCompletionNotifications = ({
  getAgentName,
  onOpenConversation,
  runtimeClient,
}: {
  getAgentName: (agentId: string) => string
  onOpenConversation: (invalidation: MobileConversationInvalidation) => void
  runtimeClient: MobileRuntimeClient
}) => {
  const [unreadIndex, setUnreadIndex] = useState(() =>
    typeof window === 'undefined' ? {} : readMobileChatUnreadIndex(window.localStorage)
  )

  useEffect(() => {
    const refreshUnread = () => setUnreadIndex(readMobileChatUnreadIndex(window.localStorage))
    window.addEventListener(MOBILE_CHAT_UNREAD_CHANGED_EVENT, refreshUnread)
    return () => window.removeEventListener(MOBILE_CHAT_UNREAD_CHANGED_EVENT, refreshUnread)
  }, [])

  const handleConversationInvalidated = useCallback(
    async (invalidation: MobileConversationInvalidation) => {
      if (invalidation.activity_state !== 'idle') return
      try {
        const completion = await loadCompletedMobileChatUpdate(
          runtimeClient,
          window.localStorage,
          invalidation
        )
        if (!completion) return
        setUnreadIndex(readMobileChatUnreadIndex(window.localStorage))
        emitMobileChatUnreadChanged()
        showMobileChatCompletionNotification({
          agentName: getAgentName(invalidation.agent_id),
          onClick: () => onOpenConversation(invalidation),
          preview: completion.preview,
          tag: `yive-chat:${invalidation.conversation_id}:${completion.turn.provider_event_id}`,
        })
      } catch (error) {
        console.warn('Failed to process completed mobile Chat reply', error)
      }
    },
    [getAgentName, onOpenConversation, runtimeClient]
  )

  return { handleConversationInvalidated, unreadIndex }
}
