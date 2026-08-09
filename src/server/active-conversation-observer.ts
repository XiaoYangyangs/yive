import { existsSync } from 'node:fs'

import type {
  ConversationProvider,
  MobileConversationInvalidation,
  MobileConversationPage,
} from '../shared/types.js'
import { resolveConversationProvider } from './conversation-provider-resolver.js'
import type { ConversationIncrement } from './conversation-source.js'
import { getProviderAdapter } from './provider-adapter.js'
import type { RuntimeStoreServices } from './runtime-store-helpers.js'

type ConversationServices = Pick<
  RuntimeStoreServices,
  'agentRuntime' | 'chatSubmissionStore' | 'conversationStore' | 'db' | 'workspaceStore'
>

interface ActiveConversationObserverOptions {
  onContextCompacted?: (workspaceId: string, agentId: string) => void
  onConversationChanged?: (event: MobileConversationInvalidation) => void
  onConversationIdle?: (conversation: MobileConversationPage) => void
}

const isExpectedSourceError = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code
  return Boolean(code && ['EACCES', 'EBUSY', 'ENOENT', 'EPERM'].includes(code))
}

export const createActiveConversationObserver = (
  services: ConversationServices,
  options: ActiveConversationObserverOptions = {}
) => {
  let closed = false
  const readStoredConversation = (
    workspaceId: string,
    agentId: string,
    limit: number,
    cursor: string | null | undefined
  ) => {
    const conversation = services.conversationStore.getCurrentConversation(
      workspaceId,
      agentId,
      limit,
      cursor
    )
    return conversation
      ? {
          ...conversation,
          submissions: [
            ...services.chatSubmissionStore.listForConversation(conversation.id),
            ...services.chatSubmissionStore.listPausedForAgent(
              workspaceId,
              agentId,
              conversation.id
            ),
          ].sort(
            (left, right) => left.accepted_at - right.accepted_at || left.id.localeCompare(right.id)
          ),
        }
      : null
  }
  const readUnverifiedStoredConversation = (
    workspaceId: string,
    agentId: string,
    limit: number,
    cursor: string | null | undefined
  ): MobileConversationPage | null => {
    const conversation = readStoredConversation(workspaceId, agentId, limit, cursor)
    return conversation ? { ...conversation, stale: true } : null
  }
  const notifyConversationIdle = (conversation: MobileConversationPage | null) => {
    if (!conversation || !options.onConversationIdle) return
    queueMicrotask(() => {
      if (!closed) options.onConversationIdle?.(conversation)
    })
  }
  const notifyConversationChanged = (event: MobileConversationInvalidation) => {
    if (!options.onConversationChanged) return
    queueMicrotask(() => {
      if (!closed) options.onConversationChanged?.(event)
    })
  }
  const notifyContextCompacted = (workspaceId: string, agentId: string) => {
    if (!options.onContextCompacted) return
    queueMicrotask(() => {
      if (!closed) options.onContextCompacted?.(workspaceId, agentId)
    })
  }

  const readIncrement = (
    provider: ConversationProvider,
    filePath: string,
    checkpoint: number | null
  ): ConversationIncrement => {
    const adapter = getProviderAdapter(provider)
    if (!adapter) throw new Error(`Provider Adapter not found: ${provider}`)
    return adapter.readConversationIncrement({ checkpoint, filePath })
  }

  const getCurrentConversation = (
    workspaceId: string,
    agentId: string,
    limit = 30,
    options: { bypassDetectionCache?: boolean; cursor?: string | null } = {}
  ): MobileConversationPage | null => {
    const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
    services.workspaceStore.getAgent(workspaceId, agentId)
    const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, agentId)
    if (!activeRun) {
      return readStoredConversation(workspaceId, agentId, limit, options.cursor)
    }
    const launchConfig = services.agentRuntime.peekAgentLaunchConfig(workspaceId, agentId)
    const provider = resolveConversationProvider(launchConfig)
    if (!provider) {
      return readUnverifiedStoredConversation(workspaceId, agentId, limit, options.cursor)
    }
    const adapter = getProviderAdapter(provider)
    if (!adapter) {
      return readUnverifiedStoredConversation(workspaceId, agentId, limit, options.cursor)
    }
    const capture = launchConfig?.sessionIdCapture
    const pattern =
      (provider === 'codex' && capture?.source === 'codex_session_jsonl_dir') ||
      (provider === 'claude' && capture?.source === 'claude_project_jsonl_dir')
        ? capture.pattern
        : undefined
    const active = services.conversationStore.getActiveObservation(workspaceId, agentId)
    const sessionId = activeRun.sessionId
    if (!sessionId) {
      return readUnverifiedStoredConversation(workspaceId, agentId, limit, options.cursor)
    }

    const sameSession = active?.cli_session_id === sessionId && active.provider === provider
    if (active && !sameSession) {
      services.chatSubmissionStore.pauseConversation(active.id, 'session_changed')
    }
    const activeSourcePath =
      sameSession && active?.source_path && existsSync(active.source_path)
        ? active.source_path
        : undefined
    const providerSourcePath = activeSourcePath
      ? undefined
      : adapter.findSessionSource(workspace.summary.path, sessionId, pattern)
    const filePath =
      activeSourcePath ??
      (providerSourcePath && existsSync(providerSourcePath) ? providerSourcePath : undefined)
    if (!filePath) {
      if (active && sameSession) services.conversationStore.markStale(active.id)
      return readUnverifiedStoredConversation(workspaceId, agentId, limit, options.cursor)
    }

    return observeSource({
      active,
      agentId,
      cursor: options.cursor,
      filePath,
      limit,
      provider,
      sessionId,
      workspaceId,
    })
  }

  const observeSource = ({
    active,
    agentId,
    cursor,
    filePath,
    limit,
    provider,
    sessionId,
    workspaceId,
  }: {
    active: ReturnType<ConversationServices['conversationStore']['getActiveObservation']>
    agentId: string
    cursor: string | null | undefined
    filePath: string
    limit: number
    provider: ConversationProvider
    sessionId: string
    workspaceId: string
  }): MobileConversationPage | null => {
    const sameSession = active?.cli_session_id === sessionId && active.provider === provider

    let increment: ConversationIncrement
    try {
      increment = readIncrement(
        provider,
        filePath,
        sameSession ? (active?.source_checkpoint ?? null) : null
      )
    } catch (error) {
      if (!isExpectedSourceError(error)) throw error
      if (active && sameSession) services.conversationStore.markStale(active.id)
      return readUnverifiedStoredConversation(workspaceId, agentId, limit, cursor)
    }
    const conversation = services.conversationStore.observeConversation({
      agentId,
      activityState: increment.activity_state,
      checkpoint: increment.checkpoint,
      cliSessionId: sessionId,
      provider,
      sourcePath: filePath,
      workspaceId,
    })
    if (!conversation) return null
    if (active && sameSession && increment.checkpoint !== active.source_checkpoint) {
      services.db.transaction(() => {
        services.conversationStore.appendTurns(
          conversation.id,
          increment.turns.map((turn) => ({
            providerEventId: turn.provider_event_id,
            role: turn.role,
            sourceCheckpoint: turn.source_checkpoint,
            text: turn.text,
          })),
          increment.checkpoint,
          increment.activity_state,
          increment.tool_activity.map((tool) => ({
            completedAt: tool.completed_at,
            label: tool.label,
            providerEventId: tool.provider_event_id,
            sourceCheckpoint: tool.source_checkpoint,
            startedAt: tool.started_at,
            status: tool.status,
          }))
        )
        services.chatSubmissionStore.confirmVerifiedUserTurns(
          conversation.id,
          increment.turns
            .filter((turn) => turn.role === 'user')
            .map((turn) => ({ providerEventId: turn.provider_event_id, text: turn.text }))
        )
      })()
    }
    const current = readStoredConversation(workspaceId, agentId, limit, cursor)
    if (active && sameSession && increment.checkpoint !== active.source_checkpoint) {
      notifyConversationChanged({
        activity_state: increment.activity_state ?? 'unknown',
        agent_id: agentId,
        conversation_id: conversation.id,
        cursor: increment.checkpoint,
        type: 'conversation-invalidated',
        workspace_id: workspaceId,
      })
      if (increment.context_compacted) notifyContextCompacted(workspaceId, agentId)
    }
    const observedFreshBoundary =
      !active || !sameSession || increment.checkpoint !== active.source_checkpoint
    if (observedFreshBoundary && increment.activity_state === 'idle') {
      notifyConversationIdle(current)
    }
    return current
  }

  const observeActiveConversations = () => {
    if (closed) return
    for (const workspace of services.workspaceStore.listWorkspaces()) {
      for (const agent of services.workspaceStore.getWorkspaceSnapshot(workspace.id).agents) {
        if (!services.agentRuntime.getActiveRunByAgentId(workspace.id, agent.id)) continue
        try {
          getCurrentConversation(workspace.id, agent.id)
        } catch (error) {
          console.warn(`Failed to observe conversation for ${workspace.id}/${agent.id}`, error)
        }
      }
    }
  }
  const timer = setInterval(observeActiveConversations, 750)
  timer.unref()
  queueMicrotask(observeActiveConversations)

  return {
    close() {
      closed = true
      clearInterval(timer)
    },
    getCurrentConversation,
  }
}
