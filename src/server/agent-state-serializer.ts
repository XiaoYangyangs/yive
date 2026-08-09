import type { AgentIdentity, AgentRuntimeState, AgentSummaryPayload } from '../shared/types.js'

export const serializeAgentRuntimeState = (state: AgentRuntimeState) => ({
  active_dispatch_id: state.activeDispatchId,
  conversation_activity: state.conversationActivity,
  last_observed_at: state.lastObservedAt,
  process_state: state.processState,
  queue_pause_reason: state.queuePauseReason,
  queued_dispatch_count: state.queuedDispatchCount,
})

export const serializeAgentSummary = (
  agent: AgentIdentity,
  state: AgentRuntimeState
): AgentSummaryPayload => ({
  ...serializeAgentRuntimeState(state),
  id: agent.id,
  kind: agent.kind,
  name: agent.name,
  workspace_id: agent.workspaceId,
})
