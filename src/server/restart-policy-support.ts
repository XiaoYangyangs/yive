import type { AgentIdentity, WorkspaceSummary } from '../shared/types.js'
import type { PersistedAgentRun } from './agent-run-store.js'
import type { MessageLogHandle, MessageLogRecord } from './message-log-store.js'

export interface RestartPolicyInput {
  deleteMessage: (handle: MessageLogHandle) => void
  getWorkspaceSnapshot: (workspaceId: string) => {
    agents: AgentIdentity[]
    summary: WorkspaceSummary
  }
  insertMessage: (record: MessageLogRecord) => MessageLogHandle
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
}

export const findPreviousRun = (runs: PersistedAgentRun[], currentRunId: string) =>
  runs.find((run) => run.runId !== currentRunId)

export const writeSystemMessage = async ({
  deleteMessage,
  insertMessage,
  record,
  runId,
  text,
  writeToRun,
}: {
  deleteMessage: RestartPolicyInput['deleteMessage']
  insertMessage: RestartPolicyInput['insertMessage']
  record: MessageLogRecord
  runId: string
  text: string
  writeToRun: (runId: string, text: string) => Promise<boolean>
}) => {
  const handle = insertMessage(record)
  try {
    const delivered = await writeToRun(runId, text)
    if (!delivered) deleteMessage(handle)
    return delivered
  } catch (error) {
    deleteMessage(handle)
    throw error
  }
}
