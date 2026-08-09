import type { WorkspaceSummary } from '../shared/types.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { buildRecoverySummary } from './recovery-summary.js'
import {
  findPreviousRun,
  type RestartPolicyInput,
  writeSystemMessage,
} from './restart-policy-support.js'
import { createSystemRecoverySummaryMessage } from './runtime-message-builders.js'

type RuntimeContextBuilder = (workspaceId: string, agentId: string) => unknown | null | undefined

export interface RestartPolicy {
  injectPostStartMessage: (input: {
    agentId: string
    runId: string
    startConfig: AgentLaunchConfigInput
    workspace: WorkspaceSummary
    writeToRun: (runId: string, text: string) => Promise<boolean>
  }) => Promise<boolean>
  setContextBuilder: (builder: RuntimeContextBuilder) => void
}

export const createNoopRestartPolicy = (): RestartPolicy => ({
  async injectPostStartMessage() {
    return false
  },
  setContextBuilder() {},
})

export const createRestartPolicy = ({
  deleteMessage,
  getWorkspaceSnapshot,
  insertMessage,
  listAgentRuns,
}: RestartPolicyInput): RestartPolicy => {
  let buildRuntimeContext: RuntimeContextBuilder = () => null

  return {
    async injectPostStartMessage({ agentId, runId, workspace, writeToRun }) {
      const previousRun = findPreviousRun(listAgentRuns(agentId), runId)
      if (!previousRun) return false

      const snapshot = getWorkspaceSnapshot(workspace.id)
      const agent = snapshot.agents.find((item) => item.id === agentId)
      if (!agent) return false
      let context: unknown | null | undefined
      try {
        context = buildRuntimeContext(workspace.id, agentId)
      } catch (error) {
        console.warn(`Failed to build restart Runtime Context for ${agentId}`, error)
        context = null
      }
      if (context === undefined) return true

      const text = buildRecoverySummary({
        agent,
        context,
        workspace,
      })
      return await writeSystemMessage({
        deleteMessage,
        insertMessage,
        record: createSystemRecoverySummaryMessage(workspace.id, agentId, text),
        runId,
        text,
        writeToRun,
      })
    },
    setContextBuilder(builder) {
      buildRuntimeContext = builder
    },
  }
}
