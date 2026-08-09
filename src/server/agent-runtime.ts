import type { AgentIdentity } from '../shared/types.js'
import { createAgentLaunchCache } from './agent-launch-cache.js'
import type { AgentManager } from './agent-manager.js'
import type { PersistAgentRunExit } from './agent-run-start-context.js'
import { createAgentRunStarter } from './agent-run-starter.js'
import { syncPersistedRun } from './agent-run-sync.js'
import { getActiveRunByAgent } from './agent-runtime-active-run.js'
import { closeAgentRuntime } from './agent-runtime-close.js'
import type { AgentRuntime } from './agent-runtime-contract.js'
import { createAgentRuntimeFlowAdapter } from './agent-runtime-flow-adapter.js'
import { listRunsWithFallback } from './agent-runtime-list-runs.js'
import type { AgentRunStorePort, AgentSessionStorePort } from './agent-runtime-ports.js'
import { stopLiveRun } from './agent-runtime-stop-run.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { createAgentSafeStop } from './agent-safe-stop.js'
import { refreshAgentSessionBinding as rebindAgentSession } from './agent-session-rebind.js'
import { createAgentStdinDispatcher } from './agent-stdin-dispatcher.js'
import { createAgentTokenRegistry } from './agent-tokens.js'
import { createLiveRunRegistry } from './live-run-registry.js'
import { createNoopRestartPolicy, type RestartPolicy } from './restart-policy.js'

export const createAgentRuntime = (
  agentManager: AgentManager | undefined,
  agentRunStore: AgentRunStorePort,
  sessionStore: AgentSessionStorePort,
  onAgentExit: (
    workspaceId: string,
    agentId: string,
    processStateOverride?: 'crashed' | 'stopped'
  ) => void,
  restartPolicy: RestartPolicy = createNoopRestartPolicy(),
  getAgent?: (workspaceId: string, agentId: string) => AgentIdentity | undefined,
  persistRunExit?: PersistAgentRunExit,
  retryPendingRunExits?: (
    workspaceId?: string,
    agentId?: string
  ) => {
    committed: import('./agent-run-start-context.js').PersistAgentRunExitInput[]
    failures: unknown[]
  }
): AgentRuntime => {
  const registry = createLiveRunRegistry()
  const launchCache = createAgentLaunchCache(agentRunStore)
  const tokenRegistry = createAgentTokenRegistry()
  const startPromises = new Map<string, Promise<LiveAgentRun>>()
  let closing = false
  const requireManager = () => {
    if (!agentManager) throw new Error('Agent manager is required for PTY terminal operations')
    return agentManager
  }
  const flowAdapter = createAgentRuntimeFlowAdapter(requireManager)

  const syncRun = (run: LiveAgentRun) => {
    if (!agentManager || run.persistenceFailed) return run
    const workspaceId = launchCache.getWorkspaceId(run.agentId)
    const store =
      persistRunExit && workspaceId
        ? {
            updatePersistedRun: (
              runId: string,
              status: Parameters<typeof agentRunStore.updatePersistedRun>[1],
              exitCode: number | null,
              endedAt: number | null,
              processState: Parameters<typeof agentRunStore.updatePersistedRun>[4]
            ) => {
              if ((status !== 'error' && status !== 'exited') || processState === 'running') {
                agentRunStore.updatePersistedRun(runId, status, exitCode, endedAt, processState)
                return
              }
              persistRunExit({
                agentId: run.agentId,
                endedAt: endedAt ?? Date.now(),
                exitCode,
                processState,
                runId,
                status,
                workspaceId,
              })
            },
          }
        : agentRunStore
    return syncPersistedRun(run, agentManager.getRun(run.runId), store)
  }
  const stdinDispatcher = createAgentStdinDispatcher({
    agentManager,
    getLaunchConfig: launchCache.peek,
    getWorkspaceId: launchCache.getWorkspaceId,
    registry,
    syncRun,
  })
  const stopAgentRunSafely = createAgentSafeStop({
    agentManager,
    getLaunchConfig: launchCache.get,
    registry,
    sessionStore,
    syncRun,
    writeChatSubmission: stdinDispatcher.writeChatSubmission,
  })
  const startLiveRun = createAgentRunStarter({
    agentManager,
    registry,
    onAgentExit,
    store: agentRunStore,
    sessionStore,
    tokenRegistry,
    getAgent,
    restartPolicy,
    ...(persistRunExit ? { persistRunExit } : {}),
  })
  const reconcilePendingExitPersistence = (workspaceId: string, agentId: string) => {
    const failedRuns = registry
      .list()
      .filter(
        (run) =>
          run.agentId === agentId &&
          launchCache.getWorkspaceId(run.agentId) === workspaceId &&
          run.persistenceFailed &&
          run.pendingExitPersistence
      )
      .sort((left, right) => left.startedAt - right.startedAt)
    for (const run of failedRuns) {
      const pending = run.pendingExitPersistence
      if (!pending) continue
      if (persistRunExit) {
        persistRunExit(pending)
      } else {
        agentRunStore.updatePersistedRun(
          pending.runId,
          pending.status,
          pending.exitCode,
          pending.endedAt,
          pending.processState
        )
      }
      delete run.pendingExitPersistence
      delete run.persistenceFailed
      onAgentExit(workspaceId, agentId)
      agentManager?.removeRun(run.runId)
      registry.remove(run.runId)
    }
    const durableResult = retryPendingRunExits?.()
    for (const pending of durableResult?.committed ?? []) {
      onAgentExit(pending.workspaceId, pending.agentId)
    }
    if (durableResult && durableResult.failures.length > 0) {
      throw new AggregateError(durableResult.failures, 'Failed to reconcile durable Agent exits')
    }
  }

  return {
    async close() {
      closing = true
      await Promise.allSettled([...startPromises.values()])
      const pendingRecoveries = registry
        .list()
        .flatMap((run) => (run.postStartRecovery ? [run.postStartRecovery] : []))
      await closeAgentRuntime(agentManager, registry, syncRun)
      await Promise.allSettled(pendingRecoveries)
      try {
        const durableResult = retryPendingRunExits?.()
        for (const pending of durableResult?.committed ?? []) {
          onAgentExit(pending.workspaceId, pending.agentId)
        }
        if (durableResult && durableResult.failures.length > 0) {
          throw new AggregateError(
            durableResult.failures,
            'Failed to reconcile durable Agent exits'
          )
        }
      } catch (error) {
        console.error(
          '[yive] failed to reconcile durable Agent exit intents during shutdown',
          error
        )
      }
    },
    configureAgentLaunch(workspaceId, agentId, input) {
      launchCache.save(workspaceId, agentId, input)
    },
    deleteAgentLaunchConfig(workspaceId, agentId) {
      launchCache.remove(workspaceId, agentId)
    },
    peekAgentLaunchConfig(workspaceId, agentId) {
      return launchCache.peek(workspaceId, agentId)
    },
    getActiveRunByAgentId(workspaceId, agentId) {
      return getActiveRunByAgent(
        registry,
        launchCache.getWorkspaceId,
        syncRun,
        workspaceId,
        agentId
      )
    },
    interruptCurrentTurn(workspaceId, agentId) {
      return stdinDispatcher.interruptCurrentTurn(workspaceId, agentId)
    },
    getLiveRun(runId) {
      const run = registry.get(runId)
      if (!run) throw new Error(`Live run not found: ${runId}`)
      return syncRun(run)
    },
    getPtyOutputBus() {
      return flowAdapter.getOutputBus()
    },
    listAgentRuns(agentId) {
      return listRunsWithFallback(registry, agentRunStore.listAgentRuns(agentId), agentId)
    },
    pauseRun(runId) {
      flowAdapter.pauseRun(runId)
    },
    peekAgentToken(agentId) {
      return tokenRegistry.peek(agentId)
    },
    resizeAgentRun(runId, cols, rows) {
      flowAdapter.resizeRun(runId, cols, rows)
    },
    refreshAgentSessionBinding(workspace, agentId) {
      const activeRun = getActiveRunByAgent(
        registry,
        launchCache.getWorkspaceId,
        syncRun,
        workspace.id,
        agentId
      )
      return rebindAgentSession({
        ...(activeRun ? { activeRunId: activeRun.runId } : {}),
        activeSessionId: activeRun?.sessionId ?? null,
        ...(activeRun?.sessionCapture ? { activeSessionCapture: activeRun.sessionCapture } : {}),
        agentId,
        config: launchCache.get(workspace.id, agentId),
        sessionStore,
        workspace,
      })
    },
    resumeRun(runId) {
      flowAdapter.resumeRun(runId)
    },
    async startAgent(workspace, agentId, input) {
      if (closing) throw new Error('Agent runtime is closing')
      launchCache.setWorkspaceId(agentId, workspace.id)
      const key = `${workspace.id}:${agentId}`
      const pendingStart = startPromises.get(key)
      if (pendingStart) return pendingStart
      reconcilePendingExitPersistence(workspace.id, agentId)
      const activeRun = getActiveRunByAgent(
        registry,
        launchCache.getWorkspaceId,
        syncRun,
        workspace.id,
        agentId
      )
      if (activeRun) return activeRun
      const startOptions: { suppressStartupInstructions?: boolean } = {}
      if (input.suppressStartupInstructions !== undefined) {
        startOptions.suppressStartupInstructions = input.suppressStartupInstructions
      }
      const startPromise = startLiveRun(
        workspace,
        agentId,
        launchCache.get(workspace.id, agentId),
        input.hivePort,
        startOptions
      ).finally(() => {
        if (startPromises.get(key) === startPromise) {
          startPromises.delete(key)
        }
      })
      startPromises.set(key, startPromise)
      return startPromise
    },
    stopAgentRun(runId) {
      stopLiveRun(agentManager, registry, syncRun, runId)
    },
    stopAgentRunSafely,
    validateAgentToken: tokenRegistry.validate,
    writeChatSubmission(workspaceId, agentId, prepareText) {
      return stdinDispatcher.writeChatSubmission(workspaceId, agentId, prepareText)
    },
    writeReportPrompt(workspaceId, workerName, _workerId, text, artifacts, input = {}) {
      stdinDispatcher.writeReportPrompt(workspaceId, workerName, text, artifacts, input)
    },
    writeStatusPrompt(workspaceId, workerName, _workerId, text, artifacts, input = {}) {
      stdinDispatcher.writeStatusPrompt(workspaceId, workerName, text, artifacts, input)
    },
    writeSendPrompt(
      workspaceId,
      workerId,
      dispatchId,
      fromAgentName,
      text,
      artifacts = [],
      canDeliver,
      notes = []
    ) {
      return stdinDispatcher.writeSendPrompt(
        workspaceId,
        workerId,
        dispatchId,
        fromAgentName,
        text,
        artifacts,
        canDeliver,
        notes
      )
    },
    writeDispatchNotePrompt(workspaceId, workerId, input, canDeliver) {
      return stdinDispatcher.writeDispatchNotePrompt(workspaceId, workerId, input, canDeliver)
    },
    writeCoordinationPrompt(
      workspaceId: string,
      prepareText: () => string | null,
      callbacks: { beforeWrite: () => void; onWriteFailed: () => void }
    ) {
      return stdinDispatcher.writeCoordinationPrompt(workspaceId, prepareText, callbacks)
    },
    writeCancelPrompt(workspaceId, workerId, dispatchId, reason, input = {}) {
      stdinDispatcher.writeCancelPrompt(workspaceId, workerId, dispatchId, reason, input)
    },
    writeContextPrompt(workspaceId, agentId, text) {
      stdinDispatcher.writeContextPrompt(workspaceId, agentId, text)
    },
    writeUserInputPrompt(workspaceId, text) {
      stdinDispatcher.writeUserInputPrompt(workspaceId, text)
    },
  }
}

export type { AgentRuntime }
