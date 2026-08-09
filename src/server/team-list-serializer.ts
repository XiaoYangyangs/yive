import type { TeamListItem, TeamListItemPayload } from '../shared/types.js'
import { serializeAgentRuntimeState } from './agent-state-serializer.js'

export const serializeTeamListItem = (item: TeamListItem): TeamListItemPayload => ({
  ...serializeAgentRuntimeState(item),
  id: item.id,
  kind: item.kind,
  last_pty_line: item.lastPtyLine ?? null,
  name: item.name,
  provider: item.provider ?? null,
  conversation_provider: item.conversationProvider ?? null,
})
