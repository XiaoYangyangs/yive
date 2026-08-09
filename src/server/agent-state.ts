import type {
  AgentConversationActivity,
  AgentIdentity,
  AgentRuntimeState,
  MobileConversationPage,
} from '../shared/types.js'
import type { PersistedAgentRun } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'

interface BuildAgentStateInput {
  activeRun: LiveAgentRun | undefined
  agent: Pick<AgentIdentity, 'id'>
  conversation: MobileConversationPage | null
  dispatches: DispatchRecord[]
  queuePauseReason?: string | null
  runs: PersistedAgentRun[]
  processStateOverride?: AgentRuntimeState['processState']
}

const resolveProcessState = (
  activeRun: LiveAgentRun | undefined,
  latestRun: PersistedAgentRun | undefined,
  processStateOverride: AgentRuntimeState['processState'] | undefined
): AgentRuntimeState['processState'] => {
  if (processStateOverride) return processStateOverride
  if (activeRun) return 'running'
  if (!latestRun) return 'stopped'
  return latestRun.processState
}

const resolveConversationActivity = (
  processState: AgentRuntimeState['processState'],
  conversation: MobileConversationPage | null
): AgentConversationActivity => {
  if (processState !== 'running' || !conversation || conversation.stale) return 'unknown'
  return conversation.activity_state
}

export const buildAgentState = ({
  activeRun,
  agent,
  conversation,
  dispatches,
  queuePauseReason = null,
  runs,
  processStateOverride,
}: BuildAgentStateInput): AgentRuntimeState => {
  const latestRun = runs[0]
  const processState = resolveProcessState(activeRun, latestRun, processStateOverride)
  const open = dispatches.filter(
    (dispatch) =>
      dispatch.toAgentId === agent.id &&
      (dispatch.status === 'queued' || dispatch.status === 'submitted')
  )
  const activeDispatches = open.filter((dispatch) => dispatch.status === 'submitted')
  if (activeDispatches.length > 1) {
    throw new Error(
      `Agent ${agent.id} has multiple active Dispatches: ${activeDispatches
        .map((dispatch) => dispatch.id)
        .join(', ')}`
    )
  }
  const active = activeDispatches[0] ?? null
  const queued = open.filter((dispatch) => dispatch.status === 'queued')
  return {
    activeDispatchId: active?.id ?? null,
    conversationActivity: resolveConversationActivity(processState, conversation),
    lastObservedAt:
      (processState === 'running' ? conversation?.observed_at : latestRun?.endedAt) ??
      activeRun?.startedAt ??
      latestRun?.startedAt ??
      0,
    processState,
    queuePauseReason,
    queuedDispatchCount: queued.length,
  }
}
