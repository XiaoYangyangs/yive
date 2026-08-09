import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef } from 'react'

import type { MobileConversationPage } from '../../../src/shared/types.js'
import { mergeMobileConversationUpdate } from './mobile-conversation-live.js'
import type { MobileRuntimeClient } from './mobile-runtime-client.js'

export const useMobileConversationLiveUpdates = ({
  agentId,
  conversation,
  loadConversation,
  onError,
  runtimeClient,
  selectedHistoricalId,
  setConversation,
  workspaceId,
}: {
  agentId: string
  conversation: MobileConversationPage | null
  loadConversation: () => Promise<void>
  onError: (message: string | null) => void
  runtimeClient: MobileRuntimeClient
  selectedHistoricalId: string | null
  setConversation: Dispatch<SetStateAction<MobileConversationPage | null>>
  workspaceId: string
}) => {
  const conversationRef = useRef<MobileConversationPage | null>(conversation)
  useEffect(() => {
    conversationRef.current = conversation
  }, [conversation])

  const loadIncrement = useCallback(async () => {
    const current = conversationRef.current
    if (!current || selectedHistoricalId !== null) {
      await loadConversation()
      return
    }
    try {
      const update = await runtimeClient.getCurrentConversation(
        workspaceId,
        agentId,
        current.cursor
      )
      if (!update) return
      setConversation((value) => mergeMobileConversationUpdate(value, update))
      onError(null)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Conversation update failed')
    }
  }, [
    agentId,
    loadConversation,
    onError,
    runtimeClient,
    selectedHistoricalId,
    setConversation,
    workspaceId,
  ])

  useEffect(() => {
    if (selectedHistoricalId !== null || !runtimeClient.subscribeMobileEvents) return
    const subscription = runtimeClient.subscribeMobileEvents({
      onConversationInvalidated: (invalidation) => {
        const current = conversationRef.current
        if (
          invalidation.workspace_id !== workspaceId ||
          invalidation.agent_id !== agentId ||
          (current && invalidation.conversation_id !== current.id) ||
          (current?.cursor !== undefined && invalidation.cursor <= current.cursor)
        ) {
          return
        }
        void loadIncrement()
      },
      onSnapshot: () => void loadIncrement(),
    })
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void loadIncrement()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      subscription.dispose()
    }
  }, [agentId, loadIncrement, runtimeClient, selectedHistoricalId, workspaceId])
}
