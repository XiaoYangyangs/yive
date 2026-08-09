import type { MobileConversationInvalidation } from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import {
  AgentRunExitIntentStageError,
  createAgentRunExitIntentStore,
} from './agent-run-exit-intent-store.js'
import type { PersistAgentRunExitInput } from './agent-run-start-context.js'
import {
  type AgentLaunchConfigInput,
  createAgentRunStore,
  type PersistedAgentRun,
} from './agent-run-store.js'
import { createAgentRuntime } from './agent-runtime.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { createAgentSessionStore } from './agent-session-store.js'
import { createChatSubmissionStore } from './chat-submission-store.js'
import { createConversationStore } from './conversation-store.js'
import { createCoordinationEventStore } from './coordination-event-store.js'
import { createDispatchLedgerStore } from './dispatch-ledger-store.js'
import { createDispatchNoteStore } from './dispatch-note-store.js'
import { createMessageLogStore } from './message-log-store.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import type { RestartPolicy } from './restart-policy.js'
import { removeRetiredWorkspaceFiles } from './retired-workspace-files.js'
import { openRuntimeDatabase } from './runtime-database.js'
import { buildRuntimeRestartPolicy } from './runtime-restart-policy.js'
import { createSettingsStore } from './settings-store.js'
import { createStatusSnapshotStore } from './status-snapshot-store.js'
import { createTeamOperations } from './team-operations.js'
import { resolveTerminalInputProfile } from './terminal-input-profile.js'
import { createUiAuth } from './ui-auth.js'
import { createWorkerOutputTracker, type WorkerOutputTracker } from './worker-output-tracker.js'
import { createWorkerQueueStateStore } from './worker-queue-state-store.js'
import { createWorkspaceShellRuntime } from './workspace-shell-runtime.js'
import { createWorkspaceStore } from './workspace-store.js'

export interface RuntimeStoreServices {
  agentExitCallbacks: Set<
    (workspaceId: string, agentId: string, processState: 'crashed' | 'stopped') => void
  >
  agentProcessStateOverrides: Map<string, 'crashed' | 'stopped'>
  agentRunExitIntentStore: ReturnType<typeof createAgentRunExitIntentStore>
  agentRunStore: ReturnType<typeof createAgentRunStore>
  agentRuntime: ReturnType<typeof createAgentRuntime>
  agentSessionStore: ReturnType<typeof createAgentSessionStore>
  chatSubmissionStore: ReturnType<typeof createChatSubmissionStore>
  conversationStore: ReturnType<typeof createConversationStore>
  coordinationEventStore: ReturnType<typeof createCoordinationEventStore>
  db: ReturnType<typeof openRuntimeDatabase>
  dispatchLedgerStore: ReturnType<typeof createDispatchLedgerStore>
  dispatchNoteStore: ReturnType<typeof createDispatchNoteStore>
  messageLogStore: ReturnType<typeof createMessageLogStore>
  statusSnapshotStore: ReturnType<typeof createStatusSnapshotStore>
  mobileAuth: ReturnType<typeof createUiAuth>
  runtimeChangeCallbacks: Set<(event?: MobileConversationInvalidation) => void>
  restartPolicy: RestartPolicy
  settings: ReturnType<typeof createSettingsStore>
  shellRuntime: ReturnType<typeof createWorkspaceShellRuntime>
  teamOps: ReturnType<typeof createTeamOperations>
  uiAuth: ReturnType<typeof createUiAuth>
  workerOutputTracker: WorkerOutputTracker | null
  workspaceStore: ReturnType<typeof createWorkspaceStore>
  workerQueueStateStore: ReturnType<typeof createWorkerQueueStateStore>
}

interface CreateRuntimeStoreServicesOptions {
  agentManager?: AgentManager
  dataDir?: string
}

interface CreateRuntimeStoreLifecycleOptions {
  agentManager?: AgentManager
  services: RuntimeStoreServices
}

export const createRuntimeStoreServices = (
  options: CreateRuntimeStoreServicesOptions = {}
): RuntimeStoreServices => {
  const db = openRuntimeDatabase(options.dataDir)
  const messageLogStore = createMessageLogStore(db)
  const statusSnapshotStore = createStatusSnapshotStore(db)
  const dispatchLedgerStore = createDispatchLedgerStore(db)
  const dispatchNoteStore = createDispatchNoteStore(db)
  dispatchNoteStore.recoverInterruptedDeliveries()
  const agentRunStore = createAgentRunStore(db)
  const agentRunExitIntentStore = createAgentRunExitIntentStore(db)
  const agentSessionStore = createAgentSessionStore(db)
  agentSessionStore.failPendingSaveIntentsForRuntimeRestart()
  const conversationStore = createConversationStore(db)
  const coordinationEventStore = createCoordinationEventStore(db)
  coordinationEventStore.recoverInterruptedDeliveries()
  const workerQueueStateStore = createWorkerQueueStateStore(db)
  const chatSubmissionStore = createChatSubmissionStore(db)
  chatSubmissionStore.pauseForRuntimeRestart()
  const settings = createSettingsStore(db)
  const runtimeChangeCallbacks = new Set<(event?: MobileConversationInvalidation) => void>()
  const agentExitCallbacks = new Set<
    (workspaceId: string, agentId: string, processState: 'crashed' | 'stopped') => void
  >()
  const agentProcessStateOverrides = new Map<string, 'crashed' | 'stopped'>()
  const mobileAuth = createUiAuth()
  const uiAuth = createUiAuth()
  const shellRuntime = createWorkspaceShellRuntime(options.agentManager)

  const workspaceStore = createWorkspaceStore(db, dispatchLedgerStore.listOpenDispatchKinds())
  for (const workspace of workspaceStore.listWorkspaces()) {
    removeRetiredWorkspaceFiles(workspace.path)
  }
  const restartPolicy = buildRuntimeRestartPolicy({
    agentRunStore,
    messageLogStore,
    workspaceStore,
  })
  const workerOutputTracker = options.agentManager
    ? createWorkerOutputTracker(options.agentManager.getOutputBus())
    : null
  const recordWorkerCrash = (
    workspaceId: string,
    workerId: string,
    run: Pick<PersistedAgentRun, 'exitCode' | 'runId'>
  ) => {
    if (!workerQueueStateStore.getPauseReason(workspaceId, workerId)) {
      workerQueueStateStore.pause(workspaceId, workerId, 'worker_crashed')
    }
    const dispatch = dispatchLedgerStore.findSubmittedDispatch(workspaceId, workerId)
    coordinationEventStore.create({
      artifacts: [],
      dispatchId: dispatch?.id ?? null,
      kind: 'crash',
      requestId: `crash:${run.runId}`,
      text: `Process exited unexpectedly${run.exitCode === null ? '' : ` with code ${run.exitCode}`}.`,
      workerId,
      workspaceId,
    })
  }
  const finalizeRunExit = db.transaction((input: PersistAgentRunExitInput) => {
    agentRunStore.updatePersistedRun(
      input.runId,
      input.status,
      input.exitCode,
      input.endedAt,
      input.processState
    )
    if (
      input.processState === 'crashed' &&
      workspaceStore.hasAgent(input.workspaceId, input.agentId)
    ) {
      const agent = workspaceStore.getAgent(input.workspaceId, input.agentId)
      if (agent.kind === 'worker') {
        recordWorkerCrash(input.workspaceId, input.agentId, {
          exitCode: input.exitCode,
          runId: input.runId,
        })
      }
    }
    agentRunExitIntentStore.delete(input.runId)
  })
  const persistRunExit = (input: PersistAgentRunExitInput) => {
    try {
      agentRunExitIntentStore.stage(input)
    } catch (error) {
      throw new AgentRunExitIntentStageError(error)
    }
    finalizeRunExit.immediate(input)
  }
  const retryPendingRunExits = (workspaceId?: string, agentId?: string) => {
    const committed: PersistAgentRunExitInput[] = []
    const failures: unknown[] = []
    for (const input of agentRunExitIntentStore.list(workspaceId, agentId)) {
      try {
        finalizeRunExit.immediate(input)
        committed.push(input)
      } catch (error) {
        failures.push(error)
      }
    }
    return { committed, failures }
  }
  for (const input of agentRunExitIntentStore.list()) {
    try {
      finalizeRunExit.immediate(input)
    } catch (error) {
      agentProcessStateOverrides.set(`${input.workspaceId}:${input.agentId}`, input.processState)
      console.error(`[yive] failed to reconcile durable Agent exit intent ${input.runId}`, error)
    }
  }
  const remainingExitIntents = agentRunExitIntentStore.list()
  agentRunStore.markUnfinishedRunsStale(
    Date.now(),
    remainingExitIntents.map((intent) => intent.runId)
  )
  for (const input of remainingExitIntents) {
    agentProcessStateOverrides.set(`${input.workspaceId}:${input.agentId}`, input.processState)
  }
  const recoverWorkerCrash = db.transaction(recordWorkerCrash)
  for (const workspace of workspaceStore.listWorkspaces()) {
    for (const agent of workspaceStore.getWorkspaceSnapshot(workspace.id).agents) {
      if (agent.kind !== 'worker') continue
      const latestRun = agentRunStore.listAgentRuns(agent.id)[0]
      if (latestRun?.processState === 'crashed') {
        recoverWorkerCrash.immediate(workspace.id, agent.id, latestRun)
      }
    }
  }
  const agentRuntime = createAgentRuntime(
    options.agentManager,
    agentRunStore,
    agentSessionStore,
    (workspaceId, agentId, processStateOverride) => {
      workerOutputTracker?.detach(workspaceId, agentId)
      chatSubmissionStore.pauseAgent(workspaceId, agentId, 'agent_stopped')
      if (!workspaceStore.hasAgent(workspaceId, agentId)) return
      const overrideKey = `${workspaceId}:${agentId}`
      const processState =
        processStateOverride ?? agentRunStore.listAgentRuns(agentId)[0]?.processState
      if (processState !== 'crashed' && processState !== 'stopped') return
      if (processStateOverride) agentProcessStateOverrides.set(overrideKey, processStateOverride)
      else agentProcessStateOverrides.delete(overrideKey)
      for (const callback of agentExitCallbacks) {
        try {
          callback(workspaceId, agentId, processState)
        } catch (error) {
          console.error(`[yive] Agent exit listener failed for ${agentId}`, error)
        }
      }
    },
    restartPolicy,
    (workspaceId, agentId) => workspaceStore.getAgent(workspaceId, agentId),
    persistRunExit,
    retryPendingRunExits
  )
  const markQueuedDispatchActivated = db.transaction(
    (workspaceId: string, dispatchId: string, noteIds: string[]) => {
      if (!dispatchLedgerStore.markSubmitted(dispatchId)) return false
      dispatchNoteStore.markDeliveredMany(workspaceId, noteIds)
      return true
    }
  )
  const teamOps = createTeamOperations({
    agentRuntime,
    createDispatch: dispatchLedgerStore.createDispatch,
    deleteDispatch: dispatchLedgerStore.deleteDispatch,
    deleteMessage: messageLogStore.deleteMessage,
    findOpenDispatch: dispatchLedgerStore.findOpenDispatch,
    findDispatchById: dispatchLedgerStore.findDispatchById,
    findOpenDispatchById: dispatchLedgerStore.findOpenDispatchById,
    findIdempotentDispatch: dispatchLedgerStore.findIdempotentDispatch,
    findIdempotentReport: dispatchLedgerStore.findIdempotentReport,
    findNextQueuedDispatch: dispatchLedgerStore.findNextQueuedDispatch,
    findSubmittedDispatch: dispatchLedgerStore.findSubmittedDispatch,
    findIdempotentStatus: statusSnapshotStore.findIdempotent,
    findPendingDispatchNote: dispatchNoteStore.findPendingForDispatch,
    claimPendingDispatchNotes: dispatchNoteStore.claimPendingForDispatch,
    insertMessage: messageLogStore.insertMessage,
    markDispatchCancelled: dispatchLedgerStore.markCancelled,
    markDispatchReportedByWorker: dispatchLedgerStore.markReportedByWorker,
    markQueuedDispatchActivated,
    markDispatchSubmitted: dispatchLedgerStore.markSubmitted,
    markDispatchNotesFailed: dispatchNoteStore.markFailedMany,
    recordStatus: statusSnapshotStore.record,
    replaceQueuedDispatch: dispatchLedgerStore.replaceQueued,
    workspaceStore,
  })
  return {
    agentExitCallbacks,
    agentProcessStateOverrides,
    agentRunExitIntentStore,
    agentRunStore,
    agentRuntime,
    agentSessionStore,
    chatSubmissionStore,
    conversationStore,
    coordinationEventStore,
    db,
    dispatchLedgerStore,
    dispatchNoteStore,
    messageLogStore,
    mobileAuth,
    runtimeChangeCallbacks,
    restartPolicy,
    statusSnapshotStore,
    settings,
    shellRuntime,
    teamOps,
    uiAuth,
    workerOutputTracker,
    workerQueueStateStore,
    workspaceStore,
  }
}

export const createRuntimeStoreLifecycle = ({
  agentManager,
  services,
}: CreateRuntimeStoreLifecycleOptions) => {
  const startAgent = async (
    workspaceId: string,
    agentId: string,
    input: { hivePort: string; suppressStartupInstructions?: boolean }
  ): Promise<LiveAgentRun> => {
    services.workspaceStore.getAgent(workspaceId, agentId)
    const run = await services.agentRuntime.startAgent(
      services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary,
      agentId,
      input
    )
    if (run.status !== 'error') {
      services.agentProcessStateOverrides.delete(`${workspaceId}:${agentId}`)
      services.workerOutputTracker?.attach(workspaceId, agentId, run.runId, run.output)
    }
    return run
  }

  const autostartConfiguredAgents = async (input: { hivePort: string }) => {
    if (!agentManager) return []
    const starts = services.workspaceStore.listWorkspaces().flatMap((workspace) => {
      return services.workspaceStore
        .getWorkspaceSnapshot(workspace.id)
        .agents.filter(
          (agent) =>
            !services.agentRuntime.getActiveRunByAgentId(workspace.id, agent.id) &&
            services.agentRuntime.peekAgentLaunchConfig(workspace.id, agent.id)
        )
        .map(async (agent) => {
          try {
            const run = await startAgent(workspace.id, agent.id, input)
            return {
              agent_id: agent.id,
              error: null,
              ok: true,
              run_id: run.runId,
              workspace_id: workspace.id,
            }
          } catch (error) {
            return {
              agent_id: agent.id,
              error: error instanceof Error ? error.message : String(error),
              ok: false,
              run_id: null,
              workspace_id: workspace.id,
            }
          }
        })
    })
    return Promise.all(starts)
  }

  return {
    close: async () => {
      services.shellRuntime.close()
      await services.agentRuntime.close()
      services.workerOutputTracker?.closeAll()
      services.agentRunStore.close?.()
      services.db.close()
    },
    configureAgentLaunch: (workspaceId: string, agentId: string, input: AgentLaunchConfigInput) => {
      services.workspaceStore.getAgent(workspaceId, agentId)
      services.agentRuntime.configureAgentLaunch(workspaceId, agentId, input)
    },
    refreshAgentSessionBinding: (workspaceId: string, agentId: string) => {
      const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
      services.workspaceStore.getAgent(workspaceId, agentId)
      return services.agentRuntime.refreshAgentSessionBinding(workspace.summary, agentId)
    },
    peekAgentLaunchConfig: (workspaceId: string, agentId: string) =>
      services.agentRuntime.peekAgentLaunchConfig(workspaceId, agentId),
    deleteWorkspaceShell: (workspaceId: string) => {
      services.shellRuntime.deleteWorkspace(workspaceId)
    },
    closeWorkspaceShell: (workspaceId: string, runId: string) =>
      services.shellRuntime.closeRun(workspaceId, runId),
    getLiveRun: (runId: string) =>
      services.shellRuntime.getLiveRun(runId) ?? services.agentRuntime.getLiveRun(runId),
    getPtyOutputBus: (): PtyOutputBus => {
      if (!agentManager) throw new Error('Agent manager is required for PTY output subscriptions')
      return agentManager.getOutputBus()
    },
    listTerminalRuns: (workspaceId: string) => [
      ...services.workspaceStore.getWorkspaceSnapshot(workspaceId).agents.flatMap((agent) => {
        const run = services.agentRuntime.getActiveRunByAgentId(workspaceId, agent.id)
        if (!run) return []
        const launchConfig = services.agentRuntime.peekAgentLaunchConfig(workspaceId, agent.id)
        return [
          {
            agent_id: agent.id,
            agent_name: agent.name,
            run_id: run.runId,
            status: run.status,
            terminal_input_profile: resolveTerminalInputProfile(launchConfig),
          },
        ]
      }),
      ...services.shellRuntime.listTerminalRuns(workspaceId),
    ],
    startAgent,
    startWorkspaceShell: (workspaceId: string) =>
      services.shellRuntime.start(
        services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary
      ),
    autostartConfiguredAgents,
    writeRunInput: (runId: string, input: Buffer | string) => {
      if (!agentManager) throw new Error('Agent manager is required for PTY stdin writes')
      if (services.shellRuntime.hasRun(runId)) {
        services.shellRuntime.writeInput(runId, input)
        return
      }
      agentManager.writeInput(runId, input)
    },
    pauseTerminalRun: (runId: string) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.pauseRun(runId)
      else services.agentRuntime.pauseRun(runId)
    },
    resizeTerminalRun: (runId: string, cols: number, rows: number) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.resizeRun(runId, cols, rows)
      else services.agentRuntime.resizeAgentRun(runId, cols, rows)
    },
    resumeTerminalRun: (runId: string) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.resumeRun(runId)
      else services.agentRuntime.resumeRun(runId)
    },
    stopTerminalRun: (runId: string) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.stopRun(runId)
      else services.agentRuntime.stopAgentRun(runId)
    },
  }
}
