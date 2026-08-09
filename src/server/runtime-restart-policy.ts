import type { AgentRunStorePort } from './agent-runtime-ports.js'
import type { MessageLogHandle, MessageLogRecord } from './message-log-store.js'
import { createRestartPolicy } from './restart-policy.js'
import type { WorkspaceStore } from './workspace-store.js'

// Narrow helper keeps runtime-store under the hard line cap.
export const buildRuntimeRestartPolicy = ({
  agentRunStore,
  messageLogStore,
  workspaceStore,
}: {
  agentRunStore: Pick<AgentRunStorePort, 'listAgentRuns'>
  messageLogStore: {
    deleteMessage: (handle: MessageLogHandle) => void
    insertMessage: (record: MessageLogRecord) => MessageLogHandle
  }
  workspaceStore: Pick<WorkspaceStore, 'getWorkspaceSnapshot'>
}) =>
  createRestartPolicy({
    deleteMessage: messageLogStore.deleteMessage,
    getWorkspaceSnapshot: workspaceStore.getWorkspaceSnapshot,
    insertMessage: messageLogStore.insertMessage,
    listAgentRuns: agentRunStore.listAgentRuns,
  })
