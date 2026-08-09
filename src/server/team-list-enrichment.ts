import type { ConversationProvider, TeamListItem } from '../shared/types.js'
import { resolveConversationProvider } from './conversation-provider-resolver.js'
import type { RuntimeStore } from './runtime-store.js'

export type TeamListEnrichmentStore = Pick<
  RuntimeStore,
  'getLastPtyLineForAgent' | 'peekAgentLaunchConfig'
>

/** Resolves the managed Provider from the worker's launch configuration. */
export const resolveAgentProvider = (
  store: Pick<RuntimeStore, 'peekAgentLaunchConfig'>,
  workspaceId: string,
  workerId: string
): ConversationProvider | null => {
  const config = store.peekAgentLaunchConfig(workspaceId, workerId)
  if (!config) return null
  return resolveConversationProvider(config)
}

/** Adds transient PTY and Provider signals at the route boundary. */
export const enrichTeamList = (
  workspaceId: string,
  store: TeamListEnrichmentStore,
  workers: TeamListItem[]
): TeamListItem[] =>
  workers.map((worker) => {
    const line = store.getLastPtyLineForAgent(workspaceId, worker.id)
    const provider = resolveAgentProvider(store, workspaceId, worker.id)
    const conversationProvider = resolveConversationProvider(
      store.peekAgentLaunchConfig(workspaceId, worker.id)
    )
    const next: TeamListItem = { ...worker }
    if (line !== null) next.lastPtyLine = line
    if (provider !== null) next.provider = provider
    if (conversationProvider !== null) next.conversationProvider = conversationProvider
    return next
  })
