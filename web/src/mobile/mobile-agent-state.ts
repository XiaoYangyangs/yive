import type {
  AgentProvider,
  AgentRuntimeState,
  AgentSummary,
  ConversationProvider,
  TeamListItem,
  TerminalRunSummary,
} from '../../../src/shared/types.js'
import { type AgentStatusPresentationKind, presentAgentStatus } from '../worker/worker-status.js'

export type MobileAgentCard = AgentRuntimeState & {
  id: string
  provider?: AgentProvider
  conversationProvider?: ConversationProvider
  kind: 'orchestrator' | 'worker'
  name: string
  run?: TerminalRunSummary
  runStatus: string
}

export interface MobileAgentSummary {
  awaitingReport: number
  busy: number
  crashed: number
  idle: number
  stopped: number
  unknown: number
}

export const MOBILE_AGENT_STATUS_PRIORITY: Record<AgentStatusPresentationKind, number> = {
  busy: 0,
  'awaiting-report': 1,
  idle: 2,
  unknown: 3,
  crashed: 4,
  stopped: 5,
}

export const deriveOrchestratorCard = (
  runs: TerminalRunSummary[],
  orchestrator: AgentSummary
): MobileAgentCard => {
  const run = runs.find((item) => item.agent_id === orchestrator.id)
  return {
    ...orchestrator,
    ...(run ? { run } : {}),
    runStatus: run?.status ?? '未运行',
  }
}

export const deriveWorkerCard = (
  worker: TeamListItem,
  runs: TerminalRunSummary[]
): MobileAgentCard => {
  const run = runs.find((item) => item.agent_id === worker.id)
  return {
    activeDispatchId: worker.activeDispatchId,
    conversationActivity: worker.conversationActivity,
    id: worker.id,
    kind: 'worker',
    lastObservedAt: worker.lastObservedAt,
    name: worker.name,
    processState: worker.processState,
    queuePauseReason: worker.queuePauseReason,
    queuedDispatchCount: worker.queuedDispatchCount,
    ...(worker.provider ? { provider: worker.provider } : {}),
    ...(worker.conversationProvider ? { conversationProvider: worker.conversationProvider } : {}),
    ...(run ? { run } : {}),
    runStatus: run?.status ?? '未运行',
  }
}

export const summarizeMobileAgents = (agents: MobileAgentCard[]): MobileAgentSummary => {
  const summary: MobileAgentSummary = {
    awaitingReport: 0,
    busy: 0,
    crashed: 0,
    idle: 0,
    stopped: 0,
    unknown: 0,
  }
  for (const agent of agents) {
    const kind = presentAgentStatus(agent).kind
    if (kind === 'awaiting-report') {
      summary.awaitingReport += 1
    } else {
      summary[kind] += 1
    }
  }
  return summary
}
