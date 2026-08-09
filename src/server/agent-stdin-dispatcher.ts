import type { ArtifactReference } from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { DispatchNotePromptInput, DispatchNotePromptItem } from './agent-runtime-contract.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { resolveConversationProvider } from './conversation-provider-resolver.js'
import { serializeDispatchNotes } from './dispatch-note-prompt.js'
import { PtyInactiveError } from './http-errors.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import {
  createPostStartInputWriter,
  createPostStartInputWriterAsync,
} from './post-start-input-writer.js'
import { getProviderAdapterForLaunchConfig } from './provider-adapter.js'

interface AgentStdinDispatcherInput {
  agentManager: AgentManager | undefined
  getLaunchConfig: (workspaceId: string, agentId: string) => AgentLaunchConfigInput | undefined
  getWorkspaceId: (agentId: string) => string | undefined
  registry: LiveRunRegistry
  syncRun: (run: LiveAgentRun) => LiveAgentRun
}

export const buildOrchestratorReportPayload = (
  workerName: string,
  text: string,
  artifacts: string[]
): string => {
  const lines: string[] = [`[Hive 系统消息：来自 @${workerName} 的汇报]`, text]
  for (const artifact of artifacts) lines.push(`artifact: ${artifact}`)
  lines.push('')
  return lines.join('\n')
}

export const buildOrchestratorStatusPayload = (
  workerName: string,
  text: string,
  artifacts: string[]
): string => {
  const lines: string[] = [`[Hive 系统消息：来自 @${workerName} 的状态更新]`, text]
  for (const artifact of artifacts) lines.push(`artifact: ${artifact}`)
  lines.push('')
  return lines.join('\n')
}

export const buildOrchestratorUserInputPayload = (text: string): string => text

export const buildWorkerDispatchPayload = (
  fromAgentName: string,
  dispatchId: string,
  text: string,
  artifacts: string[] = [],
  notes: DispatchNotePromptItem[] = []
): string => {
  const lines = [
    `[Hive 系统消息：来自 @${fromAgentName} 的派单]`,
    '',
    `dispatch_id: ${dispatchId}`,
    '',
    '任务内容：',
    text,
  ]
  for (const artifact of artifacts) lines.push(`artifact: ${artifact}`)
  if (notes.length > 0) {
    lines.push(
      '',
      '[Hive supplemental Dispatch Notes JSON]',
      serializeDispatchNotes(dispatchId, notes)
    )
  }
  lines.push('')
  return lines.join('\n')
}

export const buildWorkerCancelPayload = (dispatchId: string, reason: string): string =>
  [
    `[Hive 系统消息：dispatch ${dispatchId} 已取消]`,
    '',
    '请停止执行这条派单，不要再为它调用 team report。',
    '',
    '取消原因：',
    reason,
    '',
  ].join('\n')

export const buildWorkerDispatchNotePayload = (input: DispatchNotePromptInput): string =>
  [
    '[Hive system message: supplemental Dispatch Notes]',
    '',
    serializeDispatchNotes(input.dispatchId, input.notes),
    '',
  ].join('\n')

export const createAgentStdinDispatcher = ({
  agentManager,
  getLaunchConfig,
  getWorkspaceId,
  registry,
  syncRun,
}: AgentStdinDispatcherInput) => {
  const findLatestWritableRun = (workspaceId: string, agentId: string) =>
    registry
      .list()
      .filter((item) => item.agentId === agentId && getWorkspaceId(item.agentId) === workspaceId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .find((item) => {
        const status = syncRun(item).status
        return (
          (item as { stopping?: boolean }).stopping !== true &&
          (status === 'starting' || status === 'running')
        )
      })

  const writeToActiveAgentRun = (
    workspaceId: string,
    agentId: string,
    text: string,
    input: { requireActiveRun?: boolean } = {}
  ): boolean => {
    const run = findLatestWritableRun(workspaceId, agentId)
    if (!run) {
      if (input.requireActiveRun) {
        throw new PtyInactiveError(`No active run for agent: ${agentId}`)
      }
      return false
    }

    try {
      const config = getLaunchConfig(workspaceId, agentId)
      if (agentManager && config) {
        createPostStartInputWriter(agentManager, config.interactiveCommand ?? config.command)(
          run.runId,
          text
        )
      } else {
        agentManager?.writeInput(run.runId, text)
      }
      return true
    } catch (error) {
      throw new PtyInactiveError(error instanceof Error ? error.message : String(error))
    }
  }

  const writeToActiveAgentRunAsync = async (
    workspaceId: string,
    agentId: string,
    text: string,
    input: {
      beforeWrite?: () => void
      onSubmitted?: () => void
      onWriteFailed?: () => void
      prepareText?: () => string | null
      requireActiveRun?: boolean
    } = {}
  ): Promise<boolean> => {
    const run = findLatestWritableRun(workspaceId, agentId)
    if (!run) {
      if (input.requireActiveRun) {
        throw new PtyInactiveError(`No active run for agent: ${agentId}`)
      }
      return false
    }

    try {
      const config = getLaunchConfig(workspaceId, agentId)
      let delivered = false
      let deliveryAllowed = true
      const prepareText = input.prepareText
        ? () => {
            const preparedText = input.prepareText?.() ?? null
            deliveryAllowed = preparedText !== null
            return preparedText
          }
        : undefined
      if (agentManager && config) {
        delivered = await createPostStartInputWriterAsync(
          agentManager,
          config.interactiveCommand ?? config.command,
          {
            ...(input.beforeWrite ? { beforeWrite: input.beforeWrite } : {}),
            ...(input.onSubmitted ? { onSubmitted: input.onSubmitted } : {}),
            ...(input.onWriteFailed ? { onWriteFailed: input.onWriteFailed } : {}),
            ...(prepareText ? { prepareText } : {}),
          }
        )(run.runId, text)
      } else if (agentManager) {
        const prepared = prepareText ? prepareText() : text
        if (prepared !== null) {
          agentManager.writeInput(run.runId, prepared)
          delivered = true
          input.onSubmitted?.()
        }
      }
      if (!deliveryAllowed) return false
      if (!delivered && input.requireActiveRun) {
        throw new PtyInactiveError(`No active run for agent: ${agentId}`)
      }
      return delivered
    } catch (error) {
      if (error instanceof PtyInactiveError) throw error
      throw new PtyInactiveError(error instanceof Error ? error.message : String(error))
    }
  }

  return {
    interruptCurrentTurn(workspaceId: string, agentId: string) {
      const run = findLatestWritableRun(workspaceId, agentId)
      if (!run || !agentManager) throw new PtyInactiveError(`No active run for agent: ${agentId}`)
      const config = getLaunchConfig(workspaceId, agentId)
      const adapter = config ? getProviderAdapterForLaunchConfig(config) : undefined
      if (!adapter) {
        throw new PtyInactiveError(`No supported Provider Adapter for agent: ${agentId}`)
      }
      adapter.interruptCurrentTurn(agentManager, run.runId)
      return true
    },
    async writeChatSubmission(
      workspaceId: string,
      agentId: string,
      prepareText: () => string | null
    ) {
      const run = findLatestWritableRun(workspaceId, agentId)
      if (!run || !agentManager) throw new PtyInactiveError(`No active run for agent: ${agentId}`)
      const config = getLaunchConfig(workspaceId, agentId)
      if (!config) throw new PtyInactiveError(`No launch config for agent: ${agentId}`)
      const command =
        resolveConversationProvider(config) ?? config.interactiveCommand ?? config.command
      let prepareAttempted = false
      let prepared = false
      const delivered = await createPostStartInputWriterAsync(agentManager, command, {
        beforePaste: '\x15',
        prepareText: () => {
          prepareAttempted = true
          const text = prepareText()
          prepared = text !== null
          return text
        },
      })(run.runId, '')
      if (!delivered && prepareAttempted && !prepared) return null
      if (!delivered) throw new PtyInactiveError(`No active run for agent: ${agentId}`)
      return run.runId
    },
    writeReportPrompt(
      workspaceId: string,
      workerName: string,
      text: string,
      artifacts: ArtifactReference[],
      input: { requireActiveRun?: boolean } = {}
    ) {
      writeToActiveAgentRun(
        workspaceId,
        `${workspaceId}:orchestrator`,
        buildOrchestratorReportPayload(workerName, text, artifacts),
        input
      )
    },
    writeStatusPrompt(
      workspaceId: string,
      workerName: string,
      text: string,
      artifacts: ArtifactReference[],
      input: { requireActiveRun?: boolean } = {}
    ) {
      writeToActiveAgentRun(
        workspaceId,
        `${workspaceId}:orchestrator`,
        buildOrchestratorStatusPayload(workerName, text, artifacts),
        input
      )
    },
    async writeSendPrompt(
      workspaceId: string,
      workerId: string,
      dispatchId: string,
      fromAgentName: string,
      text: string,
      artifacts: ArtifactReference[] = [],
      canDeliver?: () => boolean,
      notes: DispatchNotePromptItem[] | (() => DispatchNotePromptItem[]) = []
    ) {
      const staticNotes = typeof notes === 'function' ? [] : notes
      const payload = buildWorkerDispatchPayload(
        fromAgentName,
        dispatchId,
        text,
        artifacts,
        staticNotes
      )
      const prepareText =
        canDeliver || typeof notes === 'function'
          ? () => {
              if (canDeliver && !canDeliver()) return null
              const boundaryNotes = typeof notes === 'function' ? notes() : notes
              return buildWorkerDispatchPayload(
                fromAgentName,
                dispatchId,
                text,
                artifacts,
                boundaryNotes
              )
            }
          : undefined
      return await writeToActiveAgentRunAsync(workspaceId, workerId, payload, {
        ...(prepareText ? { prepareText } : {}),
        requireActiveRun: true,
      })
    },
    async writeDispatchNotePrompt(
      workspaceId: string,
      workerId: string,
      input: DispatchNotePromptInput,
      canDeliver?: () => boolean
    ) {
      const payload = buildWorkerDispatchNotePayload(input)
      return await writeToActiveAgentRunAsync(workspaceId, workerId, payload, {
        ...(canDeliver ? { prepareText: () => (canDeliver() ? payload : null) } : {}),
        requireActiveRun: true,
      })
    },
    async writeCoordinationPrompt(
      workspaceId: string,
      prepareText: () => string | null,
      callbacks: { beforeWrite: () => void; onWriteFailed: () => void }
    ) {
      return await writeToActiveAgentRunAsync(workspaceId, `${workspaceId}:orchestrator`, '', {
        beforeWrite: callbacks.beforeWrite,
        onWriteFailed: callbacks.onWriteFailed,
        prepareText,
        requireActiveRun: true,
      })
    },
    writeCancelPrompt(
      workspaceId: string,
      workerId: string,
      dispatchId: string,
      reason: string,
      input: { requireActiveRun?: boolean } = {}
    ) {
      writeToActiveAgentRun(
        workspaceId,
        workerId,
        buildWorkerCancelPayload(dispatchId, reason),
        input
      )
    },
    writeUserInputPrompt(workspaceId: string, text: string) {
      writeToActiveAgentRun(
        workspaceId,
        `${workspaceId}:orchestrator`,
        buildOrchestratorUserInputPayload(text)
      )
    },
    writeContextPrompt(workspaceId: string, agentId: string, text: string) {
      writeToActiveAgentRun(workspaceId, agentId, text, { requireActiveRun: true })
    },
  }
}
