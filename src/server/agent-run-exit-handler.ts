import { AgentRunExitIntentStageError } from './agent-run-exit-intent-store.js'
import type { AgentRunExitContext } from './agent-run-start-context.js'
import { completeLiveRun } from './agent-run-sync.js'

interface HandleRunExitInput {
  exitCode: number | null
  endedAt: number
  runId: string
}

const clearResumedSessionOnFailure = (
  context: Pick<AgentRunExitContext, 'agentId' | 'sessionStore' | 'startConfig' | 'workspace'>,
  stopping: boolean,
  exitCode: number | null
) => {
  const resumedSessionId = context.startConfig.resumedSessionId
  if (stopping || exitCode === null || exitCode === 0 || !resumedSessionId) return

  context.sessionStore.clearLastSessionIdIfMatches(
    context.workspace.id,
    context.agentId,
    resumedSessionId
  )
}

export const handleAgentRunExit = (
  context: AgentRunExitContext,
  { exitCode, endedAt, runId }: HandleRunExitInput
) => {
  context.registry.setPendingExitCode(runId, exitCode)
  const liveRun = context.registry.get(runId)
  if (!liveRun) {
    context.tokenRegistry.revokeIfMatches(context.agentId, context.token)
    return false
  }
  if (context.handledRunExits.has(runId)) {
    context.registry.clearPendingExitCode(runId)
    return false
  }

  try {
    const persistence = context.persistRunExit
      ? {
          updatePersistedRun: (
            persistedRunId: string,
            status: Parameters<typeof context.store.updatePersistedRun>[1],
            persistedExitCode: number | null,
            persistedEndedAt: number | null,
            processState: Parameters<typeof context.store.updatePersistedRun>[4]
          ) => {
            if ((status !== 'exited' && status !== 'error') || processState === 'running') {
              context.store.updatePersistedRun(
                persistedRunId,
                status,
                persistedExitCode,
                persistedEndedAt,
                processState
              )
              return
            }
            context.persistRunExit?.({
              agentId: context.agentId,
              endedAt: persistedEndedAt ?? endedAt,
              exitCode: persistedExitCode,
              processState,
              runId: persistedRunId,
              status,
              workspaceId: context.workspace.id,
            })
          },
        }
      : context.store
    try {
      completeLiveRun(liveRun, exitCode, endedAt, persistence)
    } catch (error) {
      if (error instanceof AgentRunExitIntentStageError) {
        context.registry.remove(runId)
        throw error
      }
      const processState = liveRun.stopping ? 'stopped' : 'crashed'
      liveRun.exitCode = exitCode
      liveRun.pendingExitPersistence = {
        agentId: context.agentId,
        endedAt,
        exitCode,
        processState,
        runId,
        status: liveRun.stopping || exitCode === 0 ? 'exited' : 'error',
        workspaceId: context.workspace.id,
      }
      liveRun.persistenceFailed = true
      liveRun.status = liveRun.stopping ? 'exited' : exitCode === 0 ? 'exited' : 'error'
      try {
        context.onAgentExit(context.workspace.id, context.agentId, processState)
      } catch (notificationError) {
        console.error(
          `[yive] failed to expose the unpersisted Agent exit for ${context.agentId}`,
          notificationError
        )
      }
      throw error
    }
    context.handledRunExits.add(runId)
    context.sessionStore.failPendingSaveIntent(
      context.workspace.id,
      context.agentId,
      runId,
      'run_exited'
    )
    clearResumedSessionOnFailure(context, liveRun.stopping === true, exitCode)
    context.onAgentExit(context.workspace.id, context.agentId)
  } finally {
    context.tokenRegistry.revokeIfMatches(context.agentId, context.token)
    context.registry.resolveExit(runId)
    context.registry.clearPendingExitCode(runId)
  }
  return true
}
