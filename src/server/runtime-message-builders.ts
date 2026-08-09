import type { MessageLogRecord } from './message-log-store.js'

export const createUserInputMessage = (
  workspaceId: string,
  orchestratorId: string,
  text: string
): MessageLogRecord => ({
  createdAt: Date.now(),
  text,
  type: 'user_input',
  workerId: orchestratorId,
  workspaceId,
})

export const createSendMessage = (
  workspaceId: string,
  workerId: string,
  text: string,
  fromAgentId?: string
): MessageLogRecord => {
  const message: MessageLogRecord = {
    createdAt: Date.now(),
    text,
    toAgentId: workerId,
    type: 'send',
    workerId,
    workspaceId,
  }

  if (fromAgentId) {
    message.fromAgentId = fromAgentId
  }

  return message
}

export const createReportMessage = (
  workspaceId: string,
  workerId: string,
  text: string,
  outcome: 'completed' | 'failed' | undefined,
  artifacts: string[]
): MessageLogRecord => {
  const message: MessageLogRecord = {
    artifacts,
    createdAt: Date.now(),
    fromAgentId: workerId,
    text,
    type: 'report',
    workerId,
    workspaceId,
  }
  if (outcome) message.status = outcome
  return message
}

export const createStatusMessage = (
  workspaceId: string,
  workerId: string,
  text: string,
  artifacts: string[],
  lifecycle: { dispatchId: string | null; dispatchSequence: number | null }
): MessageLogRecord => ({
  artifacts,
  createdAt: Date.now(),
  fromAgentId: workerId,
  status: JSON.stringify({
    dispatch_id: lifecycle.dispatchId,
    dispatch_sequence: lifecycle.dispatchSequence,
  }),
  text,
  type: 'status',
  workerId,
  workspaceId,
})

export const createSystemRecoverySummaryMessage = (
  workspaceId: string,
  agentId: string,
  text: string
): MessageLogRecord => ({
  createdAt: Date.now(),
  text,
  toAgentId: agentId,
  type: 'system_recovery_summary',
  workerId: agentId,
  workspaceId,
})
