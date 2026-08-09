import type { AgentRuntimeState } from '../../../src/shared/types.js'

export type AgentStatusPresentationKind =
  | 'awaiting-report'
  | 'busy'
  | 'crashed'
  | 'idle'
  | 'stopped'
  | 'unknown'

export interface AgentStatusPresentation {
  dotClass: string
  kind: AgentStatusPresentationKind
  label: string
  tone: string
}

export const presentAgentStatus = (
  agent: Pick<AgentRuntimeState, 'activeDispatchId' | 'conversationActivity' | 'processState'>
): AgentStatusPresentation => {
  if (agent.processState === 'crashed') {
    return {
      dotClass: 'status-dot status-dot--crashed',
      kind: 'crashed',
      label: 'crashed',
      tone: 'var(--status-red)',
    }
  }
  if (agent.processState === 'stopped') {
    return {
      dotClass: 'status-dot status-dot--stopped',
      kind: 'stopped',
      label: 'stopped',
      tone: 'var(--text-tertiary)',
    }
  }
  if (agent.conversationActivity === 'busy') {
    return {
      dotClass: 'status-dot status-dot--working',
      kind: 'busy',
      label: 'busy',
      tone: 'var(--status-green)',
    }
  }
  if (agent.conversationActivity === 'unknown') {
    return {
      dotClass: 'status-dot status-dot--unknown',
      kind: 'unknown',
      label: 'unknown',
      tone: 'var(--status-orange)',
    }
  }
  if (agent.activeDispatchId) {
    return {
      dotClass: 'status-dot status-dot--queued',
      kind: 'awaiting-report',
      label: 'awaiting report',
      tone: 'var(--status-orange)',
    }
  }
  return {
    dotClass: 'status-dot status-dot--idle',
    kind: 'idle',
    label: 'idle',
    tone: 'var(--text-tertiary)',
  }
}

export const formatLastObservedAt = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return 'Last observed: unavailable'
  return `Last observed: ${new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))}`
}

export const isAgentActivelyWorking = (
  agent: Pick<AgentRuntimeState, 'conversationActivity' | 'processState'>
): boolean => agent.processState === 'running' && agent.conversationActivity === 'busy'

export const areAllAgentsVerifiedIdle = (
  agents: Array<
    Pick<AgentRuntimeState, 'activeDispatchId' | 'conversationActivity' | 'processState'>
  >
): boolean =>
  agents.length > 0 && agents.every((agent) => presentAgentStatus(agent).kind === 'idle')

export const presentWorkerStatus = presentAgentStatus
