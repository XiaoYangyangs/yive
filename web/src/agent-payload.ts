import type {
  AgentRuntimeState,
  AgentSummary,
  AgentSummaryPayload,
  MobileSnapshotAgentPayload,
  TeamListItem,
  TeamListItemPayload,
} from '../../src/shared/types.js'

type AgentRuntimeStatePayload = Pick<
  TeamListItemPayload,
  | 'active_dispatch_id'
  | 'conversation_activity'
  | 'last_observed_at'
  | 'process_state'
  | 'queue_pause_reason'
  | 'queued_dispatch_count'
>

export const fromAgentRuntimeStatePayload = (
  payload: AgentRuntimeStatePayload
): AgentRuntimeState => ({
  activeDispatchId: payload.active_dispatch_id,
  conversationActivity: payload.conversation_activity,
  lastObservedAt: payload.last_observed_at,
  processState: payload.process_state,
  queuePauseReason: payload.queue_pause_reason,
  queuedDispatchCount: payload.queued_dispatch_count,
})

export const fromTeamListItemPayload = (payload: TeamListItemPayload): TeamListItem => ({
  ...fromAgentRuntimeStatePayload(payload),
  id: payload.id,
  kind: payload.kind,
  name: payload.name,
  ...(payload.last_pty_line ? { lastPtyLine: payload.last_pty_line } : {}),
  ...(payload.provider ? { provider: payload.provider } : {}),
  ...(payload.conversation_provider ? { conversationProvider: payload.conversation_provider } : {}),
})

export const fromAgentSummaryPayload = (payload: AgentSummaryPayload): AgentSummary => ({
  ...fromAgentRuntimeStatePayload(payload),
  id: payload.id,
  kind: payload.kind,
  name: payload.name,
  workspaceId: payload.workspace_id,
})

export const fromMobileSnapshotWorkerPayload = (
  payload: MobileSnapshotAgentPayload
): TeamListItem => ({
  ...fromAgentRuntimeStatePayload(payload),
  id: payload.id,
  kind: 'worker',
  name: payload.name,
  ...(payload.last_pty_line ? { lastPtyLine: payload.last_pty_line } : {}),
  ...(payload.provider ? { provider: payload.provider } : {}),
  ...(payload.conversation_provider ? { conversationProvider: payload.conversation_provider } : {}),
})
