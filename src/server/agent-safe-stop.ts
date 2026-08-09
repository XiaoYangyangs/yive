import type { WorkspaceSummary } from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { AgentStopMode, AgentStopResult } from './agent-runtime-contract.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import { stopLiveRun } from './agent-runtime-stop-run.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import {
  type AgentSessionDurability,
  AgentSessionDurabilityTimeoutError,
  inspectAgentSessionDurability,
  snapshotAgentSessionDurabilityCandidates,
  waitForAgentSessionDurable,
} from './agent-session-durability.js'
import { resolveAgentSessionCapture } from './agent-session-rebind.js'
import { PtyInactiveError } from './http-errors.js'
import type { LiveRunRegistry } from './live-run-registry.js'

const buildCheckpointPrompt = () =>
  [
    '[Yive 恢复点请求]',
    `请求编号：${crypto.randomUUID()}`,
    '请只简要记录当前目标、已完成与进行中的工作、关键文件和下一步，以便稍后恢复；不要继续任务或调用工具。',
  ].join('\n')

interface AgentSafeStopDependencies {
  agentManager: AgentManager | undefined
  getLaunchConfig: (workspaceId: string, agentId: string) => AgentLaunchConfigInput
  registry: LiveRunRegistry
  sessionStore: AgentSessionStorePort
  syncRun: (run: LiveAgentRun) => LiveAgentRun
  writeChatSubmission: (
    workspaceId: string,
    agentId: string,
    prepareText: () => string | null
  ) => Promise<string | null>
}

const failedResult = (
  mode: AgentStopMode,
  runId: string,
  sessionId: string | null,
  reason: AgentStopResult['reason']
): AgentStopResult => ({ mode, reason, runId, sessionId, state: 'failed' })

export const createAgentSafeStop = ({
  agentManager,
  getLaunchConfig,
  registry,
  sessionStore,
  syncRun,
  writeChatSubmission,
}: AgentSafeStopDependencies) => {
  const checkpointStopPromises = new Map<string, Promise<AgentStopResult>>()

  return async (
    workspace: WorkspaceSummary,
    agentId: string,
    runId: string,
    input: { mode: AgentStopMode }
  ): Promise<AgentStopResult> => {
    const liveRun = registry.get(runId)
    const binding = sessionStore.getSessionBinding(workspace.id, agentId)
    const saveIntent = sessionStore.getSaveIntent(workspace.id, agentId)
    const stop = () => stopLiveRun(agentManager, registry, syncRun, runId)
    const canCheckpointUnverifiedSave =
      input.mode === 'checkpoint' && saveIntent?.state === 'waiting' && saveIntent.runId === runId
    if (input.mode === 'force' || !liveRun || (!binding?.savedAt && !canCheckpointUnverifiedSave)) {
      stop()
      return {
        mode: input.mode,
        reason: null,
        runId,
        sessionId: binding?.sessionId ?? null,
        state: 'stopped',
      }
    }

    const activeSessionId = liveRun.sessionId ?? null
    if (!activeSessionId && input.mode !== 'checkpoint') {
      return {
        mode: input.mode,
        reason: 'session_unverified',
        runId,
        sessionId: null,
        state: 'checkpoint_required',
      }
    }
    if (activeSessionId && binding?.savedAt && activeSessionId !== binding.sessionId) {
      return {
        mode: input.mode,
        reason: 'session_changed',
        runId,
        sessionId: activeSessionId,
        state: 'checkpoint_required',
      }
    }

    const capture = resolveAgentSessionCapture(getLaunchConfig(workspace.id, agentId))
    if (!capture) {
      return {
        mode: input.mode,
        reason: 'provider_unsupported',
        runId,
        sessionId: binding?.sessionId ?? null,
        state: 'checkpoint_required',
      }
    }

    let durability: AgentSessionDurability | null
    const expectedSessionId = binding?.sessionId ?? saveIntent?.previousSessionId ?? ''
    try {
      durability = inspectAgentSessionDurability({
        capture,
        lastInputAt: syncRun(liveRun).lastInputAt ?? null,
        sessionId: expectedSessionId,
        workspacePath: workspace.path,
      })
    } catch (error) {
      console.error('[yive] failed to inspect CLI session durability', error)
      return failedResult(input.mode, runId, binding?.sessionId ?? null, 'checkpoint_failed')
    }
    if (!durability) {
      return {
        mode: input.mode,
        reason: 'provider_unsupported',
        runId,
        sessionId: binding?.sessionId ?? null,
        state: 'checkpoint_required',
      }
    }

    if (activeSessionId && binding?.savedAt && durability.state === 'durable') {
      stop()
      return {
        mode: input.mode,
        reason: null,
        runId,
        sessionId: binding.sessionId,
        state: 'stopped',
      }
    }
    if (input.mode !== 'checkpoint') {
      return {
        mode: input.mode,
        reason: durability.reason,
        runId,
        sessionId: binding?.sessionId ?? null,
        state: 'checkpoint_required',
      }
    }

    const pending = checkpointStopPromises.get(runId)
    if (pending) return pending
    const checkpointStop = (async (): Promise<AgentStopResult> => {
      let checkpointSessionId = expectedSessionId
      try {
        const checkpointPrompt = buildCheckpointPrompt()
        const candidateCheckpoints = activeSessionId
          ? []
          : snapshotAgentSessionDurabilityCandidates({
              agentId,
              capture,
              workspaceId: workspace.id,
              workspacePath: workspace.path,
            })
        const deliveredRunId = await writeChatSubmission(workspace.id, agentId, () => {
          const currentRun = registry.get(runId)
          const currentBinding = sessionStore.getSessionBinding(workspace.id, agentId)
          if (
            !currentRun ||
            (currentRun.sessionId !== undefined && currentRun.sessionId !== expectedSessionId) ||
            (binding?.savedAt &&
              (currentBinding?.sessionId !== binding.sessionId || !currentBinding.savedAt)) ||
            (!binding?.savedAt &&
              (sessionStore.getSaveIntent(workspace.id, agentId)?.state !== 'waiting' ||
                sessionStore.getSaveIntent(workspace.id, agentId)?.runId !== runId))
          ) {
            return null
          }
          return checkpointPrompt
        })
        if (deliveredRunId !== runId) {
          return failedResult(
            input.mode,
            runId,
            binding?.sessionId ?? null,
            deliveredRunId ? 'session_changed' : 'pty_unavailable'
          )
        }

        const submittedRun = registry.get(runId)
        if (!submittedRun) {
          return failedResult(input.mode, runId, null, 'session_changed')
        }
        const submittedSnapshot = syncRun(submittedRun)
        const submittedLastInputAt = submittedSnapshot.lastInputAt ?? null
        const completedCheckpoint = await waitForAgentSessionDurable({
          agentId,
          baselineCheckpoint: durability.checkpoint,
          candidateCheckpoints,
          capture,
          lastInputAt: submittedLastInputAt,
          requiredUserText: checkpointPrompt,
          sessionId: expectedSessionId,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
        })
        checkpointSessionId = completedCheckpoint.sessionId

        const currentRun = registry.get(runId)
        const currentBinding = sessionStore.getSessionBinding(workspace.id, agentId)
        if (
          !currentRun ||
          (currentRun.sessionId !== undefined &&
            currentRun.sessionId !== expectedSessionId &&
            currentRun.sessionId !== checkpointSessionId) ||
          (binding?.savedAt &&
            currentBinding?.sessionId !== binding.sessionId &&
            currentBinding?.sessionId !== checkpointSessionId)
        ) {
          return failedResult(input.mode, runId, currentRun?.sessionId ?? null, 'session_changed')
        }

        const latestSnapshot = syncRun(currentRun)
        if ((latestSnapshot.lastInputAt ?? null) !== submittedLastInputAt) {
          return failedResult(input.mode, runId, checkpointSessionId, 'checkpoint_failed')
        }
        const intent = sessionStore.getSaveIntent(workspace.id, agentId)
        const completedSave =
          intent?.state === 'waiting' && intent.runId === runId
            ? sessionStore.completeSaveIntent(workspace.id, agentId, runId, checkpointSessionId)
            : undefined
        if (!completedSave) {
          sessionStore.saveLastSessionId(
            workspace.id,
            agentId,
            checkpointSessionId,
            getLaunchConfig(workspace.id, agentId).provider
          )
        }
        currentRun.sessionId = checkpointSessionId

        stop()
        return {
          mode: input.mode,
          reason: null,
          runId,
          sessionId: checkpointSessionId,
          state: 'stopped',
        }
      } catch (error) {
        if (
          !(error instanceof AgentSessionDurabilityTimeoutError) &&
          !(error instanceof PtyInactiveError)
        ) {
          console.error('[yive] recovery checkpoint stop failed', error)
        }
        return failedResult(
          input.mode,
          runId,
          checkpointSessionId,
          error instanceof AgentSessionDurabilityTimeoutError
            ? 'timeout'
            : error instanceof PtyInactiveError
              ? 'pty_unavailable'
              : 'checkpoint_failed'
        )
      }
    })().finally(() => {
      if (checkpointStopPromises.get(runId) === checkpointStop) {
        checkpointStopPromises.delete(runId)
      }
    })
    checkpointStopPromises.set(runId, checkpointStop)
    return checkpointStop
  }
}
