import { randomUUID } from 'node:crypto'

import type {
  AgentIdentity,
  AgentRuntimeState,
  MobileAgentNotification,
  MobileConversationHistoryPage,
  MobileConversationInvalidation,
  MobileConversationPage,
  MobilePushTokenRegistration,
  MobileRecordedConversationPage,
  TeamListItem,
  WorkspaceSummary,
} from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput, PersistedAgentRun } from './agent-run-store.js'
import type { AgentStopMode, AgentStopResult } from './agent-runtime-contract.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { AgentSessionRebindResult } from './agent-session-rebind.js'
import { buildAgentState } from './agent-state.js'
import { normalizeArtifactReferences } from './artifact-reference.js'
import {
  cleanupBoundMobileChatAttachmentDirectories,
  cleanupBoundMobileChatAttachments,
  cleanupOrphanedMobileChatAttachmentStaging,
  prepareMigratedMobileChatAttachments,
  prepareMobileChatAttachments,
  reconcileBoundMobileChatAttachments,
  resolveBoundMobileChatAttachment,
  validateBoundMobileChatAttachments,
} from './chat-attachment-binding.js'
import { buildChatSubmissionDeliveryText } from './chat-submission-content.js'
import type { DispatchRecord, ListDispatchesOptions } from './dispatch-ledger-store.js'
import { createDispatchLifecycleCoordinator } from './dispatch-lifecycle-coordinator.js'
import type {
  AppendDispatchNoteInput,
  DispatchNoteRecord,
  ListDispatchNotesOptions,
} from './dispatch-note-store.js'
import { normalizeDispatchArtifactReferences } from './dispatch-note-validation.js'
import {
  AgentConversationConflictError,
  AgentProcessConflictError,
  BadRequestError,
  ConflictError,
  WorkerQueuePausedError,
} from './http-errors.js'
import type { RecoveryMessage } from './message-log-store.js'
import { readMobileAttachments, replaceMobileAttachments } from './mobile-attachments.js'
import { createProviderDeliveryCoordinator } from './provider-delivery-coordinator.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import { removeRetiredWorkspaceFiles } from './retired-workspace-files.js'
import { createRuntimeStoreLifecycle, createRuntimeStoreServices } from './runtime-store-helpers.js'
import type { SettingsStore } from './settings-store.js'
import type { StatusSnapshotRecord } from './status-snapshot-store.js'
import {
  buildDefaultOrchestratorContext,
  buildWorkerResponsibilityContext,
} from './team-context.js'
import type {
  CancelTaskInput,
  DispatchTaskInput,
  DispatchTaskResult,
  ReplaceTaskInput,
  ReplaceTaskResult,
  ReportTaskInput,
  ReportTaskResult,
  StatusTaskInput,
  StatusTaskResult,
} from './team-operations.js'
import { createTeamWorkerLifecycle } from './team-worker-lifecycle.js'
import type { TerminalRunSummary } from './terminal-input-profile.js'
import type { WorkerInput, WorkspaceRecord } from './workspace-store.js'

interface RuntimeStore {
  close: () => Promise<void>
  createWorkspace: (path: string, name: string) => WorkspaceSummary
  deleteWorkspace: (workspaceId: string) => Promise<void>
  listWorkspaces: () => WorkspaceSummary[]
  addWorker: (workspaceId: string, input: WorkerInput) => AgentIdentity
  deleteWorker: (workspaceId: string, workerId: string) => void
  stopWorker: (workspaceId: string, workerId: string) => void
  renameAgent: (workspaceId: string, agentId: string, name: string) => AgentIdentity
  renameWorker: (workspaceId: string, workerId: string, name: string) => AgentIdentity
  recordUserInput: (workspaceId: string, orchestratorId: string, text: string) => void
  refreshAgentSessionBinding: (workspaceId: string, agentId: string) => AgentSessionRebindResult
  dispatchTask: (
    workspaceId: string,
    workerId: string,
    text: string,
    input?: DispatchTaskInput
  ) => Promise<DispatchTaskResult>
  dispatchTaskByWorkerName: (
    workspaceId: string,
    workerName: string,
    text: string,
    input?: DispatchTaskInput
  ) => Promise<DispatchTaskResult>
  reportTask: (workspaceId: string, workerId: string, input?: ReportTaskInput) => ReportTaskResult
  resumeQueue: (
    workspaceId: string,
    workerId: string
  ) => {
    pauseReason: string | null
    workerId: string
    workspaceId: string
  }
  statusTask: (workspaceId: string, workerId: string, input?: StatusTaskInput) => StatusTaskResult
  cancelTask: (
    workspaceId: string,
    dispatchId: string,
    input: CancelTaskInput
  ) => Promise<ReportTaskResult>
  replaceTask: (
    workspaceId: string,
    dispatchId: string,
    input: ReplaceTaskInput
  ) => Promise<ReplaceTaskResult>
  listDispatches: (workspaceId: string, options?: ListDispatchesOptions) => DispatchRecord[]
  getDispatch: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
  appendDispatchNote: (
    workspaceId: string,
    input: Omit<AppendDispatchNoteInput, 'artifacts' | 'workspaceId'> & { artifacts: string[] }
  ) => Promise<{ created: boolean; note: DispatchNoteRecord }>
  listDispatchNotes: (
    workspaceId: string,
    dispatchId: string,
    options?: ListDispatchNotesOptions
  ) => DispatchNoteRecord[]
  getDispatchNote: (workspaceId: string, noteId: string) => DispatchNoteRecord | undefined
  listWorkers: (workspaceId: string) => TeamListItem[]
  getAgentState: (workspaceId: string, agentId: string) => AgentRuntimeState
  getLastPtyLineForAgent: (workspaceId: string, agentId: string) => string | null
  getCurrentAgentConversation: (
    workspaceId: string,
    agentId: string,
    limit?: number,
    cursor?: string | null
  ) => MobileConversationPage | null
  listAgentConversations: (
    workspaceId: string,
    agentId: string,
    cursor?: string | null
  ) => MobileConversationHistoryPage
  getAgentConversation: (
    workspaceId: string,
    agentId: string,
    conversationId: string,
    cursor?: string | null
  ) => MobileRecordedConversationPage | null
  dismissAgentConversation: (
    workspaceId: string,
    agentId: string,
    conversationId: string
  ) => { dismissed: boolean; id: string }
  submitChatMessage: (input: {
    attachmentFileIds?: string[]
    body?: string
    conversationId: string
    id: string
    workspaceId: string
  }) => Promise<Record<string, unknown>>
  cancelChatSubmission: (workspaceId: string, submissionId: string) => Record<string, unknown>
  editChatSubmission: (
    workspaceId: string,
    submissionId: string,
    body: string
  ) => Record<string, unknown>
  forceChatSubmission: (
    workspaceId: string,
    submissionId: string,
    expectedSkippedCount: number
  ) => Promise<Record<string, unknown>>
  continueChatSubmission: (workspaceId: string, submissionId: string) => Record<string, unknown>
  migrateChatSubmission: (
    workspaceId: string,
    sourceSubmissionId: string,
    targetConversationId: string,
    newSubmissionId: string
  ) => Promise<Record<string, unknown>>
  getChatAttachment: (
    workspaceId: string,
    submissionId: string,
    fileId: string
  ) => { content: Buffer; localPath: string; mimeType: string; name: string; size: number }
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceRecord
  getWorker: (workspaceId: string, workerId: string) => AgentIdentity
  getAgent: (workspaceId: string, agentId: string) => AgentIdentity
  getPtyOutputBus: () => PtyOutputBus
  listTerminalRuns: (workspaceId: string) => TerminalRunSummary[]
  closeWorkspaceShell: (workspaceId: string, runId: string) => boolean
  startWorkspaceShell: (workspaceId: string) => Promise<LiveAgentRun>
  configureAgentLaunch: (
    workspaceId: string,
    agentId: string,
    input: AgentLaunchConfigInput
  ) => void
  peekAgentLaunchConfig: (
    workspaceId: string,
    agentId: string
  ) => AgentLaunchConfigInput | undefined
  startAgent: (
    workspaceId: string,
    agentId: string,
    input: StartAgentOptions
  ) => Promise<LiveAgentRun>
  startAgentForUser: (
    workspaceId: string,
    agentId: string,
    input: StartAgentOptions
  ) => Promise<LiveAgentRun>
  startWorkerForTeam: (
    workspaceId: string,
    workerId: string,
    input: { command: 'restart' | 'start'; hivePort: string }
  ) => Promise<LiveAgentRun>
  autostartConfiguredAgents: (input: StartAgentOptions) => Promise<
    Array<{
      agent_id: string
      error: string | null
      ok: boolean
      run_id: string | null
      workspace_id: string
    }>
  >
  getLiveRun: (runId: string) => LiveAgentRun
  getActiveRunByAgentId: (workspaceId: string, agentId: string) => LiveAgentRun | undefined
  registerRuntimeChangeListener: (
    listener: (event?: MobileConversationInvalidation) => void
  ) => () => void
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  getLatestStatus: (workspaceId: string, workerId: string) => StatusSnapshotRecord | null
  getLatestStatuses: (workspaceId: string, workerIds: string[]) => Map<string, StatusSnapshotRecord>
  listMessagesForRecovery: (workspaceId: string, sinceMs: number) => RecoveryMessage[]
  listMobileNotifications: (workspaceIds?: string[] | undefined) => MobileAgentNotification[]
  listMobilePushTokens: (workspaceIds?: string[] | undefined) => MobilePushTokenRegistration[]
  pushMobileNotification: (input: {
    body: string
    image?: MobileAgentNotification['image']
    title: string
    workspaceId: string
  }) => MobileAgentNotification
  registerMobilePushToken: (input: {
    appId?: string
    deviceId?: string
    platform: 'fcm' | 'xiaomi'
    token: string
    workspaceIds?: string[]
  }) => MobilePushTokenRegistration
  peekAgentToken: (agentId: string) => string | undefined
  pauseTerminalRun: (runId: string) => void
  resizeAgentRun: (runId: string, cols: number, rows: number) => void
  resumeTerminalRun: (runId: string) => void
  settings: SettingsStore
  writeRunInput: (runId: string, input: Buffer | string) => void
  getMobileToken: () => string
  getUiToken: () => string
  stopAgentRun: (runId: string) => void
  stopAgentRunSafely: (runId: string, input: { mode: AgentStopMode }) => Promise<AgentStopResult>
  stopWorkerForTeam: (workspaceId: string, workerId: string) => Promise<AgentStopResult>
  validateAgentToken: (agentId: string, token: string | undefined) => boolean
  validateMobileToken: (token: string | undefined) => boolean
  validateUiToken: (token: string | undefined) => boolean
}

interface RuntimeStoreOptions {
  dataDir?: string
  agentManager?: AgentManager
  dispatchInterruptionPollMs?: number
  dispatchInterruptionTimeoutMs?: number
  teamSessionVerificationTimeoutMs?: number
}

interface StartAgentOptions {
  hivePort: string
  suppressStartupInstructions?: boolean
}

export type { RuntimeStore }

export const createRuntimeStore = (options: RuntimeStoreOptions = {}): RuntimeStore => {
  const services = createRuntimeStoreServices(options)
  const attachmentSubmissions = services.chatSubmissionStore.listAttachmentSubmissions()
  for (const workspace of services.workspaceStore.listWorkspaces()) {
    const workspaceSubmissions = attachmentSubmissions.filter(
      (submission) => submission.workspaceId === workspace.id
    )
    try {
      readMobileAttachments(workspace.path)
    } catch {
      replaceMobileAttachments(workspace.path, [])
    }
    try {
      cleanupOrphanedMobileChatAttachmentStaging(
        workspace.path,
        new Set(workspaceSubmissions.map((submission) => submission.id))
      )
    } catch {
      // Staging cleanup is best-effort and never invalidates durable submissions.
    }
    for (const submission of workspaceSubmissions) {
      try {
        reconcileBoundMobileChatAttachments(workspace.path, submission.id, submission.attachments)
      } catch {
        // Keep the durable submission and its files for an explicit recovery retry.
      }
    }
  }
  const lifecycle = createRuntimeStoreLifecycle(
    options.agentManager ? { agentManager: options.agentManager, services } : { services }
  )
  const runDataMutation = <T>(mutation: () => T): T => {
    if (!services.db) {
      return mutation()
    }
    return services.db.transaction(mutation)()
  }
  const notifyRuntimeChanged = (event?: MobileConversationInvalidation) => {
    for (const listener of services.runtimeChangeCallbacks) listener(event)
  }
  const mobileNotifications: MobileAgentNotification[] = []
  const mobilePushTokens: MobilePushTokenRegistration[] = []
  const MOBILE_NOTIFICATION_LIMIT = 100
  const MOBILE_PUSH_TOKEN_LIMIT = 500
  const mutateRuntime = <T>(mutation: () => T): T => {
    try {
      return mutation()
    } finally {
      notifyRuntimeChanged()
    }
  }
  const mutateRuntimeAsync = async <T>(mutation: () => Promise<T>): Promise<T> => {
    try {
      return await mutation()
    } finally {
      notifyRuntimeChanged()
    }
  }
  const getQueuePauseReason = (text: string) => {
    const normalized = text.trim() || 'Worker Report failed'
    const characters = Array.from(normalized)
    if (characters.length <= 512) return normalized
    return `${characters.slice(0, 509).join('')}...`
  }
  let buildRuntimeContext: (workspaceId: string, agentId: string) => unknown | null | undefined =
    () => null
  const providerDelivery = createProviderDeliveryCoordinator({
    assertWorkerReadyForImmediateDelivery: (workspaceId, workerId, expectedConversationId) =>
      assertWorkerReadyForImmediateDelivery(workspaceId, workerId, expectedConversationId),
    getRuntimeContext: (workspaceId, agentId) => buildRuntimeContext(workspaceId, agentId),
    notifyRuntimeChanged,
    services,
    startAgent: lifecycle.startAgent,
  })
  const {
    appendDispatchNote,
    armProviderInputBoundary,
    conversationObserver,
    deliverSubmissionById,
    hasConversationDelivery,
    prepareImmediateDelivery,
    removeAgent: removeAgentDelivery,
    runConversationDelivery,
    runDispatchTask,
    scheduleAutomaticQueuedDelivery,
    schedulePendingDispatchNotePoll,
    startAgentAndResumePending,
    toProviderInputBoundary,
  } = providerDelivery
  const dispatchInterruptionTimeoutMs = options.dispatchInterruptionTimeoutMs ?? 1_000
  const dispatchInterruptionPollMs = options.dispatchInterruptionPollMs ?? 25
  const dispatchLifecycle = createDispatchLifecycleCoordinator({
    armProviderInputBoundary,
    conversationObserver,
    interruptionPollMs: dispatchInterruptionPollMs,
    interruptionTimeoutMs: dispatchInterruptionTimeoutMs,
    runDataMutation,
    runDispatchTask,
    services,
    toProviderInputBoundary,
  })
  const getAgentState = (workspaceId: string, agentId: string) => {
    const agent = services.workspaceStore.getAgent(workspaceId, agentId)
    const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, agentId)
    const conversation = conversationObserver.getCurrentConversation(workspaceId, agentId)
    const processStateOverride = services.agentProcessStateOverrides.get(
      `${workspaceId}:${agentId}`
    )
    const persistedPauseReason = services.workerQueueStateStore.getPauseReason(workspaceId, agentId)
    return buildAgentState({
      activeRun,
      agent,
      conversation,
      dispatches: services.dispatchLedgerStore.listOpenDispatches(workspaceId, agentId),
      ...(processStateOverride ? { processStateOverride } : {}),
      queuePauseReason:
        persistedPauseReason ??
        (processStateOverride === 'crashed' && agent.kind === 'worker' ? 'worker_crashed' : null),
      runs: services.agentRuntime.listAgentRuns(agentId),
    })
  }
  const recoveryContextStore = {
    getDispatch: services.dispatchLedgerStore.findDispatchById,
    getLastPtyLineForAgent: (workspaceId: string, agentId: string) =>
      services.workerOutputTracker?.getLastPtyLine(workspaceId, agentId) ?? null,
    listDispatches: services.dispatchLedgerStore.listWorkspaceDispatches,
    listDispatchNotes: services.dispatchNoteStore.listForDispatch,
    getLatestStatus: services.statusSnapshotStore.getLatest,
    getLatestStatuses: services.statusSnapshotStore.getLatestMany,
    listWorkers: (workspaceId: string) =>
      services.workspaceStore.listWorkers(workspaceId).map((worker) => ({
        id: worker.id,
        kind: 'worker' as const,
        name: worker.name,
        ...getAgentState(workspaceId, worker.id),
      })),
    peekAgentLaunchConfig: lifecycle.peekAgentLaunchConfig,
  }
  buildRuntimeContext = (workspaceId, agentId) => {
    const agent = services.workspaceStore.getAgent(workspaceId, agentId)
    if (agent.kind === 'orchestrator') {
      const context = buildDefaultOrchestratorContext(recoveryContextStore, workspaceId)
      const hasActiveTeamState = context.members.some(
        (worker) =>
          worker.active_dispatch !== null ||
          worker.queued_dispatch_count > 0 ||
          worker.queue_pause_reason !== null ||
          worker.process_state === 'crashed' ||
          (worker.process_state === 'running' && worker.conversation_activity !== 'idle')
      )
      return hasActiveTeamState ? context : undefined
    }
    const context = buildWorkerResponsibilityContext(recoveryContextStore, workspaceId, agentId)
    if (!context) return null
    return context.active_dispatch ? context : undefined
  }
  services.restartPolicy.setContextBuilder((workspaceId, agentId) =>
    buildRuntimeContext(workspaceId, agentId)
  )

  function assertWorkerReadyForImmediateDelivery(
    workspaceId: string,
    workerId: string,
    expectedConversationId?: string
  ) {
    const worker = services.workspaceStore.getWorker(workspaceId, workerId)
    const state = getAgentState(workspaceId, workerId)
    if (state.queuePauseReason) {
      throw new WorkerQueuePausedError(worker.name, state.queuePauseReason)
    }
    if (state.processState !== 'running') {
      throw new AgentProcessConflictError(worker.name, state.processState)
    }
    const conversation = conversationObserver.getCurrentConversation(workspaceId, workerId, 30, {
      bypassDetectionCache: true,
    })
    if (!conversation || conversation.stale) {
      throw new AgentConversationConflictError(worker.name, 'unknown')
    }
    if (conversation.activity_state !== 'idle') {
      throw new AgentConversationConflictError(
        worker.name,
        conversation.activity_state === 'busy' ? 'busy' : 'unknown'
      )
    }
    if (expectedConversationId && conversation.id !== expectedConversationId) {
      throw new AgentConversationConflictError(worker.name, 'unknown')
    }
    return conversation
  }

  const normalizeDispatchTaskInput = (
    workspaceId: string,
    input: DispatchTaskInput | undefined
  ): DispatchTaskInput | undefined => {
    if (!input?.artifacts) return input
    const workspacePath = services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
    const artifacts = normalizeArtifactReferences(input.artifacts)
    return {
      ...input,
      artifacts,
      resolveArtifacts: () =>
        normalizeDispatchArtifactReferences({
          artifacts,
          workspacePath,
        }),
    }
  }

  const normalizeTeamArtifactInput = <T extends { artifacts?: string[] }>(
    workspaceId: string,
    input: T | undefined
  ): T | undefined => {
    if (!input?.artifacts) return input
    const workspacePath = services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
    const artifacts = normalizeArtifactReferences(input.artifacts)
    return {
      ...input,
      artifacts,
      resolveArtifacts: () =>
        normalizeDispatchArtifactReferences({
          artifacts,
          workspacePath,
        }),
    }
  }

  const teamWorkerLifecycle = createTeamWorkerLifecycle({
    getActiveRun: services.agentRuntime.getActiveRunByAgentId,
    getAgent: services.workspaceStore.getAgent,
    getAgentState,
    getQueuePauseReason: services.workerQueueStateStore.getPauseReason,
    getSavedSessionId: (workspaceId, agentId) =>
      services.agentSessionStore.getLastSessionId(workspaceId, agentId) ?? null,
    getWorker: services.workspaceStore.getWorker,
    hasRecoveryContext: (workspaceId, agentId) =>
      buildRuntimeContext(workspaceId, agentId) !== undefined,
    resumeWorkerQueue: (workspaceId, workerId) => {
      services.workerQueueStateStore.resume(workspaceId, workerId)
    },
    runExclusive: runDispatchTask,
    sessionVerificationTimeoutMs: options.teamSessionVerificationTimeoutMs ?? 5_000,
    startAgent: startAgentAndResumePending,
    stopAgentRun: async (workspaceId, workerId, runId, mode) => {
      const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary
      const result = await services.agentRuntime.stopAgentRunSafely(workspace, workerId, runId, {
        mode,
      })
      if (result.state === 'stopped') {
        services.chatSubmissionStore.pauseAgent(workspaceId, workerId, 'agent_stopped')
      }
      return result
    },
  })
  return {
    close: async () => {
      await providerDelivery.close()
      await lifecycle.close()
    },
    createWorkspace: (path, name) =>
      mutateRuntime(() => {
        removeRetiredWorkspaceFiles(path)
        const workspace = services.workspaceStore.createWorkspace(path, name)
        return workspace
      }),
    listWorkspaces: () => services.workspaceStore.listWorkspaces(),
    deleteWorkspace: async (workspaceId) =>
      mutateRuntimeAsync(async () => {
        const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
        const attachmentSubmissionIds =
          services.chatSubmissionStore.listAttachmentSubmissionIds(workspaceId)
        lifecycle.deleteWorkspaceShell(workspaceId)
        for (const agent of workspace.agents) {
          removeAgentDelivery(workspaceId, agent.id)
          const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, agent.id)
          if (activeRun) services.agentRuntime.stopAgentRun(activeRun.runId)
          services.agentRuntime.deleteAgentLaunchConfig(workspaceId, agent.id)
        }
        runDataMutation(() => {
          services.conversationStore.deleteWorkspace(workspaceId)
          services.coordinationEventStore.deleteWorkspace(workspaceId)
          services.dispatchNoteStore.deleteWorkspace(workspaceId)
          services.dispatchLedgerStore.deleteWorkspaceDispatches(workspaceId)
          services.statusSnapshotStore.deleteWorkspace(workspaceId)
          services.workerQueueStateStore.deleteWorkspace(workspaceId)
          services.workspaceStore.deleteWorkspace(workspaceId)
        })
        cleanupBoundMobileChatAttachmentDirectories(workspace.summary.path, attachmentSubmissionIds)
        if (services.settings.getAppState('active_workspace_id')?.value === workspaceId) {
          services.settings.setAppState('active_workspace_id', null)
        }
      }),
    addWorker: (workspaceId, input) =>
      mutateRuntime(() => services.workspaceStore.addWorker(workspaceId, input)),
    renameAgent: (workspaceId, agentId, name) =>
      mutateRuntime(() => services.workspaceStore.renameAgent(workspaceId, agentId, name)),
    renameWorker: (workspaceId, workerId, name) =>
      mutateRuntime(() => services.workspaceStore.renameWorker(workspaceId, workerId, name)),
    deleteWorker: (workspaceId, workerId) =>
      mutateRuntime(() => {
        removeAgentDelivery(workspaceId, workerId)
        const workspacePath = services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
        const attachmentSubmissionIds = services.chatSubmissionStore.listAttachmentSubmissionIds(
          workspaceId,
          workerId
        )
        const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, workerId)
        if (activeRun) services.agentRuntime.stopAgentRun(activeRun.runId)
        services.agentRuntime.deleteAgentLaunchConfig(workspaceId, workerId)
        runDataMutation(() => {
          services.conversationStore.deleteAgent(workspaceId, workerId)
          services.coordinationEventStore.deleteWorker(workspaceId, workerId)
          services.dispatchNoteStore.deleteWorker(workspaceId, workerId)
          services.dispatchLedgerStore.deleteWorkerDispatches(workspaceId, workerId)
          services.statusSnapshotStore.deleteWorker(workspaceId, workerId)
          services.workerQueueStateStore.deleteWorker(workspaceId, workerId)
          services.workspaceStore.deleteWorker(workspaceId, workerId)
        })
        cleanupBoundMobileChatAttachmentDirectories(workspacePath, attachmentSubmissionIds)
      }),
    stopWorker: (workspaceId, workerId) =>
      mutateRuntime(() => {
        removeAgentDelivery(workspaceId, workerId)
        const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, workerId)
        services.chatSubmissionStore.pauseAgent(workspaceId, workerId, 'agent_stopped')
        if (activeRun) services.agentRuntime.stopAgentRun(activeRun.runId)
      }),
    recordUserInput: (workspaceId, orchestratorId, text) =>
      mutateRuntime(() => services.teamOps.recordUserInput(workspaceId, orchestratorId, text)),
    refreshAgentSessionBinding: (workspaceId, agentId) =>
      mutateRuntime(() => lifecycle.refreshAgentSessionBinding(workspaceId, agentId)),
    cancelTask: (workspaceId, dispatchId, input) =>
      mutateRuntimeAsync(() => dispatchLifecycle.cancelTask(workspaceId, dispatchId, input)),
    dispatchTask: (workspaceId, workerId, text, input) =>
      mutateRuntimeAsync(() => {
        const normalizedInput = normalizeDispatchTaskInput(workspaceId, input)
        const prepared = prepareImmediateDelivery(workspaceId, workerId, normalizedInput)
        const task = async () => {
          const result = await services.teamOps.dispatchTask(
            workspaceId,
            workerId,
            text,
            prepared.input
          )
          if (result.status === 'submitted' && !result.idempotentReplay) {
            armProviderInputBoundary(workspaceId, workerId, prepared.getInputBoundary())
          }
          return result
        }
        return input?.fromAgentId ? runDispatchTask(workspaceId, workerId, task) : task()
      }),
    dispatchTaskByWorkerName: (workspaceId, workerName, text, input) =>
      mutateRuntimeAsync(() => {
        const worker = services.workspaceStore.getWorkerByName(workspaceId, workerName)
        const normalizedInput = normalizeDispatchTaskInput(workspaceId, input)
        const prepared = prepareImmediateDelivery(workspaceId, worker.id, normalizedInput)
        const task = async () => {
          const result = await services.teamOps.dispatchTask(
            workspaceId,
            worker.id,
            text,
            prepared.input
          )
          if (result.status === 'submitted' && !result.idempotentReplay) {
            armProviderInputBoundary(workspaceId, worker.id, prepared.getInputBoundary())
          }
          return result
        }
        return input?.fromAgentId ? runDispatchTask(workspaceId, worker.id, task) : task()
      }),
    reportTask: (workspaceId, workerId, input) => {
      const normalizedInput = normalizeTeamArtifactInput(workspaceId, input)
      const result = mutateRuntime(() =>
        runDataMutation(() => {
          const reportResult = services.teamOps.reportTask(workspaceId, workerId, normalizedInput)
          const dispatch = reportResult.dispatch
          if (dispatch && !dispatch.reportIdempotentReplay && dispatch.reportOutcome) {
            services.coordinationEventStore.create({
              artifacts: dispatch.artifacts,
              dispatchId: dispatch.id,
              kind: 'report',
              outcome: dispatch.reportOutcome,
              requestId: dispatch.reportRequestId ?? randomUUID(),
              text: dispatch.reportText ?? '',
              workerId,
              workspaceId,
            })
            if (dispatch.reportOutcome === 'failed') {
              services.workerQueueStateStore.pause(
                workspaceId,
                workerId,
                getQueuePauseReason(dispatch.reportText ?? '')
              )
            }
          }
          return reportResult
        })
      )
      if (result.dispatch) {
        queueMicrotask(() => {
          try {
            const orchestrator = conversationObserver.getCurrentConversation(
              workspaceId,
              `${workspaceId}:orchestrator`
            )
            if (orchestrator && !orchestrator.stale && orchestrator.activity_state === 'idle') {
              scheduleAutomaticQueuedDelivery(orchestrator)
            }
            if (result.dispatch?.reportOutcome === 'completed') {
              const worker = conversationObserver.getCurrentConversation(workspaceId, workerId)
              if (worker && !worker.stale && worker.activity_state === 'idle') {
                scheduleAutomaticQueuedDelivery(worker)
              }
            }
          } catch (error) {
            console.warn(`Failed to schedule Report follow-up for ${workerId}`, error)
          }
        })
      }
      return result
    },
    replaceTask: (workspaceId, dispatchId, input) =>
      mutateRuntimeAsync(() => dispatchLifecycle.replaceTask(workspaceId, dispatchId, input)),
    resumeQueue: (workspaceId, workerId) => {
      services.workspaceStore.getWorker(workspaceId, workerId)
      const state = mutateRuntime(() =>
        runDataMutation(() => services.workerQueueStateStore.resume(workspaceId, workerId))
      )
      queueMicrotask(() => {
        const conversation = conversationObserver.getCurrentConversation(workspaceId, workerId)
        if (conversation && !conversation.stale && conversation.activity_state === 'idle') {
          scheduleAutomaticQueuedDelivery(conversation)
        }
      })
      return state
    },
    statusTask: (workspaceId, workerId, input) => {
      const normalizedInput = normalizeTeamArtifactInput(workspaceId, input)
      const result = mutateRuntime(() =>
        runDataMutation(() => {
          const statusResult = services.teamOps.statusTask(workspaceId, workerId, normalizedInput)
          if (statusResult.status.notify && !statusResult.status.idempotentReplay) {
            services.coordinationEventStore.create({
              artifacts: statusResult.status.artifacts,
              dispatchId: statusResult.status.dispatchId,
              kind: 'status',
              requestId: statusResult.status.requestId,
              text: statusResult.status.text,
              workerId,
              workspaceId,
            })
          }
          return statusResult
        })
      )
      if (result.status.notify) {
        queueMicrotask(() => {
          const orchestrator = conversationObserver.getCurrentConversation(
            workspaceId,
            `${workspaceId}:orchestrator`
          )
          if (orchestrator?.activity_state === 'idle' && !orchestrator.stale) {
            scheduleAutomaticQueuedDelivery(orchestrator)
          }
        })
      }
      return result
    },
    listDispatches: services.dispatchLedgerStore.listWorkspaceDispatches,
    getDispatch: services.dispatchLedgerStore.findDispatchById,
    appendDispatchNote: (workspaceId, input) =>
      mutateRuntimeAsync(() => appendDispatchNote(workspaceId, input)),
    listDispatchNotes: services.dispatchNoteStore.listForDispatch,
    getDispatchNote: services.dispatchNoteStore.get,
    listWorkers: (workspaceId) =>
      services.workspaceStore.listWorkers(workspaceId).map((worker) => ({
        id: worker.id,
        kind: 'worker' as const,
        name: worker.name,
        ...getAgentState(workspaceId, worker.id),
      })),
    getAgentState,
    getLastPtyLineForAgent: (workspaceId, agentId) =>
      services.workerOutputTracker?.getLastPtyLine(workspaceId, agentId) ?? null,
    getCurrentAgentConversation: (workspaceId, agentId, limit = 30, cursor) =>
      conversationObserver.getCurrentConversation(workspaceId, agentId, limit, {
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    listAgentConversations: (workspaceId, agentId, cursor) => {
      services.workspaceStore.getAgent(workspaceId, agentId)
      return services.conversationStore.listConversations(workspaceId, agentId, 30, cursor)
    },
    getAgentConversation: (workspaceId, agentId, conversationId, cursor) => {
      services.workspaceStore.getAgent(workspaceId, agentId)
      const page = services.conversationStore.getConversationPage(
        workspaceId,
        agentId,
        conversationId,
        30,
        cursor
      )
      return page
        ? { ...page, submissions: services.chatSubmissionStore.listForConversation(page.id) }
        : null
    },
    dismissAgentConversation: (workspaceId, agentId, conversationId) =>
      mutateRuntime(() => {
        const submissions = services.chatSubmissionStore.listForConversation(conversationId)
        const dismissed = services.conversationStore.dismissConversation(
          workspaceId,
          agentId,
          conversationId
        )
        const workspacePath = services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
        cleanupBoundMobileChatAttachmentDirectories(
          workspacePath,
          submissions
            .filter((submission) => submission.attachments.length > 0)
            .map((submission) => submission.id)
        )
        return dismissed
      }),
    cancelChatSubmission: (workspaceId, submissionId) => {
      const submission = services.chatSubmissionStore.get(submissionId)
      const cancelled = services.chatSubmissionStore.cancel(workspaceId, submissionId)
      if (submission.attachments.length > 0) {
        const workspacePath = services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
        cleanupBoundMobileChatAttachments(workspacePath, submissionId)
      }
      return cancelled
    },
    editChatSubmission: (workspaceId, submissionId, body) => {
      const submission = services.chatSubmissionStore.get(submissionId)
      return services.chatSubmissionStore.edit(
        workspaceId,
        submissionId,
        body,
        buildChatSubmissionDeliveryText(body, submission.attachments)
      )
    },
    forceChatSubmission: async (workspaceId, submissionId, expectedSkippedCount) => {
      const identity = services.chatSubmissionStore.getSubmissionIdentity(workspaceId, submissionId)
      if (!identity) throw new BadRequestError(`Chat submission not found: ${submissionId}`)
      if (!services.agentRuntime.getActiveRunByAgentId(workspaceId, identity.agent_id)) {
        throw new ConflictError('Forced delivery requires a running agent')
      }
      const observed = conversationObserver.getCurrentConversation(workspaceId, identity.agent_id)
      if (!observed || observed.id !== identity.conversation_id) {
        throw new ConflictError('Forced delivery requires the current active conversation')
      }
      return runConversationDelivery(identity.conversation_id, 'forced', () => {
        const submission = services.chatSubmissionStore.get(submissionId)
        return deliverSubmissionById(
          observed,
          submissionId,
          () =>
            services.chatSubmissionStore.beginForcedDelivery(
              workspaceId,
              submissionId,
              expectedSkippedCount
            ),
          submission.attachments.length > 0,
          submission.attachments.length > 0
            ? () =>
                validateBoundMobileChatAttachments(
                  services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path,
                  submissionId,
                  submission.attachments
                )
            : undefined
        )
      })
    },
    continueChatSubmission: (workspaceId, submissionId) => {
      const identity = services.chatSubmissionStore.getSubmissionIdentity(workspaceId, submissionId)
      if (!identity) throw new BadRequestError(`Chat submission not found: ${submissionId}`)
      if (!services.agentRuntime.getActiveRunByAgentId(workspaceId, identity.agent_id)) {
        throw new ConflictError('Continuing requires a running agent')
      }
      const observed = conversationObserver.getCurrentConversation(workspaceId, identity.agent_id)
      if (!observed || observed.id !== identity.conversation_id) {
        throw new ConflictError('Continuing requires the current active conversation')
      }
      const continued = services.chatSubmissionStore.continuePaused(workspaceId, submissionId)
      if (observed.activity_state === 'idle') scheduleAutomaticQueuedDelivery(observed)
      return continued
    },
    migrateChatSubmission: async (
      workspaceId,
      sourceSubmissionId,
      targetConversationId,
      newSubmissionId
    ) => {
      const source = services.chatSubmissionStore.getPausedBody(workspaceId, sourceSubmissionId)
      const sourceIdentity = services.conversationStore.getConversationIdentity(
        source.conversationId
      )
      const target = services.conversationStore.getConversationIdentity(targetConversationId)
      if (!sourceIdentity || !target || sourceIdentity.agent_id !== target.agent_id) {
        throw new ConflictError('Chat migration requires the same agent')
      }
      if (!services.agentRuntime.getActiveRunByAgentId(workspaceId, target.agent_id)) {
        throw new ConflictError('Chat migration requires a running agent')
      }
      const observed = conversationObserver.getCurrentConversation(workspaceId, target.agent_id)
      if (!observed || observed.id !== targetConversationId) {
        throw new ConflictError('Chat migration requires the current active conversation')
      }
      const workspacePath = services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
      const binding = prepareMigratedMobileChatAttachments(
        workspacePath,
        sourceSubmissionId,
        newSubmissionId,
        source.attachments
      )
      try {
        binding.bind()
        const queued = services.chatSubmissionStore.acceptQueued({
          attachments: binding.attachments,
          body: source.body,
          conversationId: targetConversationId,
          deliveryText: buildChatSubmissionDeliveryText(source.body, binding.attachments),
          id: newSubmissionId,
          workspaceId,
        })
        binding.register()
        if (observed.activity_state === 'idle') scheduleAutomaticQueuedDelivery(observed)
        return queued
      } catch (error) {
        services.chatSubmissionStore.rollbackAcceptance(newSubmissionId)
        binding.cleanup()
        throw error
      }
    },
    getChatAttachment: (workspaceId, submissionId, fileId) => {
      const identity = services.chatSubmissionStore.getSubmissionIdentity(workspaceId, submissionId)
      if (!identity) throw new BadRequestError(`Chat submission not found: ${submissionId}`)
      const submission = services.chatSubmissionStore.get(submissionId)
      const attachment = submission.attachments.find((candidate) => candidate.file_id === fileId)
      if (!attachment) throw new BadRequestError(`Chat attachment not found: ${fileId}`)
      const workspacePath = services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
      return resolveBoundMobileChatAttachment(workspacePath, submissionId, attachment)
    },
    submitChatMessage: async (input) => {
      const conversation = services.conversationStore.getConversationIdentity(input.conversationId)
      if (!conversation || conversation.workspace_id !== input.workspaceId) {
        throw new BadRequestError(`Conversation not found: ${input.conversationId}`)
      }
      if (!services.agentRuntime.getActiveRunByAgentId(input.workspaceId, conversation.agent_id)) {
        throw new ConflictError('Chat submission requires a running agent')
      }
      const existing = services.chatSubmissionStore.find(input.id)
      if (existing) {
        const requestedFileIds = input.attachmentFileIds ?? []
        if (
          requestedFileIds.length !== existing.attachments.length ||
          requestedFileIds.some((fileId, index) => existing.attachments[index]?.file_id !== fileId)
        ) {
          throw new ConflictError(
            'Chat submission UUID was already used with different attachments'
          )
        }
        const idempotent = services.chatSubmissionStore.accept({
          attachments: existing.attachments,
          ...input,
        })
        if (idempotent.state !== 'undelivered') return idempotent
      }
      const observed = conversationObserver.getCurrentConversation(
        input.workspaceId,
        conversation.agent_id
      )
      if (!observed || observed.id !== input.conversationId) {
        throw new ConflictError('Chat submission requires the current verified conversation')
      }
      const workspacePath = services.workspaceStore.getWorkspaceSnapshot(input.workspaceId).summary
        .path
      const binding = existing
        ? null
        : prepareMobileChatAttachments(
            workspacePath,
            input.workspaceId,
            input.id,
            input.attachmentFileIds ?? []
          )
      const attachments = existing?.attachments ?? binding?.attachments ?? []
      const submissionInput = {
        attachments,
        ...(input.body === undefined ? {} : { body: input.body }),
        conversationId: input.conversationId,
        deliveryText: buildChatSubmissionDeliveryText(
          input.body ?? existing?.body ?? '',
          attachments
        ),
        id: input.id,
        workspaceId: input.workspaceId,
      }
      const shouldQueue =
        observed.activity_state !== 'idle' ||
        hasConversationDelivery(input.conversationId) ||
        services.chatSubmissionStore.hasDeliveryBlocker(input.conversationId, existing?.id) ||
        services.chatSubmissionStore.hasQueued(input.conversationId)
      if (shouldQueue) {
        if (existing) {
          if (attachments.length > 0) {
            validateBoundMobileChatAttachments(workspacePath, input.id, attachments)
          }
          const queued = services.chatSubmissionStore.requeueUndelivered(
            input.workspaceId,
            input.id
          )
          if (observed.activity_state === 'idle') scheduleAutomaticQueuedDelivery(observed)
          return queued
        }
        try {
          binding?.bind()
          const queued = services.chatSubmissionStore.acceptQueued(submissionInput)
          binding?.register()
          if (observed.activity_state === 'idle') scheduleAutomaticQueuedDelivery(observed)
          return queued
        } catch (error) {
          services.chatSubmissionStore.rollbackAcceptance(input.id)
          binding?.cleanup()
          throw error
        }
      }
      if (!existing) {
        try {
          binding?.bind()
          services.chatSubmissionStore.accept(submissionInput)
          binding?.register()
        } catch (error) {
          services.chatSubmissionStore.rollbackAcceptance(input.id)
          binding?.cleanup()
          throw error
        }
      }
      return runConversationDelivery(input.conversationId, 'direct', () =>
        deliverSubmissionById(
          observed,
          input.id,
          () => services.chatSubmissionStore.beginDelivery(input.id),
          true,
          attachments.length > 0
            ? () => validateBoundMobileChatAttachments(workspacePath, input.id, attachments)
            : undefined
        )
      )
    },
    getWorkspaceSnapshot: (workspaceId) =>
      services.workspaceStore.getWorkspaceSnapshot(workspaceId),
    getWorker: (workspaceId, workerId) => services.workspaceStore.getWorker(workspaceId, workerId),
    getAgent: (workspaceId, agentId) => services.workspaceStore.getAgent(workspaceId, agentId),
    getPtyOutputBus: lifecycle.getPtyOutputBus,
    listTerminalRuns: lifecycle.listTerminalRuns,
    closeWorkspaceShell: (workspaceId, runId) =>
      mutateRuntime(() => lifecycle.closeWorkspaceShell(workspaceId, runId)),
    configureAgentLaunch: (workspaceId, agentId, input) =>
      mutateRuntime(() => lifecycle.configureAgentLaunch(workspaceId, agentId, input)),
    peekAgentLaunchConfig: lifecycle.peekAgentLaunchConfig,
    startAgent: (workspaceId, agentId, input) =>
      mutateRuntimeAsync(() => startAgentAndResumePending(workspaceId, agentId, input)),
    startAgentForUser: (workspaceId, agentId, input) =>
      mutateRuntimeAsync(() => teamWorkerLifecycle.recover(workspaceId, agentId, input)),
    startWorkerForTeam: (workspaceId, workerId, input) =>
      mutateRuntimeAsync(() => teamWorkerLifecycle.start(workspaceId, workerId, input)),
    autostartConfiguredAgents: (input) =>
      mutateRuntimeAsync(async () => {
        const results = await lifecycle.autostartConfiguredAgents(input)
        for (const result of results) {
          if (result.ok) schedulePendingDispatchNotePoll(result.workspace_id, result.agent_id)
        }
        return results
      }),
    startWorkspaceShell: (workspaceId) =>
      mutateRuntimeAsync(() => lifecycle.startWorkspaceShell(workspaceId)),
    getLiveRun: lifecycle.getLiveRun,
    getActiveRunByAgentId: (workspaceId, agentId) =>
      services.agentRuntime.getActiveRunByAgentId(workspaceId, agentId),
    registerRuntimeChangeListener: (listener) => {
      services.runtimeChangeCallbacks.add(listener)
      return () => {
        services.runtimeChangeCallbacks.delete(listener)
      }
    },
    listAgentRuns: (agentId) => services.agentRuntime.listAgentRuns(agentId),
    getLatestStatus: services.statusSnapshotStore.getLatest,
    getLatestStatuses: services.statusSnapshotStore.getLatestMany,
    listMessagesForRecovery: (workspaceId, sinceMs) =>
      services.messageLogStore.listMessagesForRecovery(workspaceId, sinceMs),
    listMobileNotifications: (workspaceIds) => {
      const allowed = workspaceIds ? new Set(workspaceIds) : null
      return mobileNotifications.filter(
        (notification) => !allowed || allowed.has(notification.workspace_id)
      )
    },
    listMobilePushTokens: (workspaceIds) => {
      const allowed = workspaceIds ? new Set(workspaceIds) : null
      return mobilePushTokens.filter((registration) => {
        if (!allowed) return true
        if (!registration.workspace_ids) return true
        return registration.workspace_ids.some((workspaceId) => allowed.has(workspaceId))
      })
    },
    pushMobileNotification: (input) =>
      mutateRuntime(() => {
        services.workspaceStore.getWorkspaceSnapshot(input.workspaceId)
        const notification: MobileAgentNotification = {
          body: input.body,
          created_at: Date.now(),
          id: globalThis.crypto.randomUUID(),
          ...(input.image ? { image: input.image } : {}),
          source: 'agent',
          title: input.title,
          workspace_id: input.workspaceId,
        }
        mobileNotifications.push(notification)
        while (mobileNotifications.length > MOBILE_NOTIFICATION_LIMIT) mobileNotifications.shift()
        return notification
      }),
    registerMobilePushToken: (input) =>
      mutateRuntime(() => {
        for (const workspaceId of input.workspaceIds ?? []) {
          services.workspaceStore.getWorkspaceSnapshot(workspaceId)
        }
        const now = Date.now()
        const existing = mobilePushTokens.find((registration) => registration.token === input.token)
        if (existing) {
          existing.updated_at = now
          existing.platform = input.platform
          if (input.appId !== undefined) existing.app_id = input.appId
          if (input.deviceId !== undefined) existing.device_id = input.deviceId
          if (input.workspaceIds !== undefined) {
            existing.workspace_ids = input.workspaceIds
          } else {
            delete existing.workspace_ids
          }
          return existing
        }
        const registration: MobilePushTokenRegistration = {
          created_at: now,
          id: globalThis.crypto.randomUUID(),
          platform: input.platform,
          token: input.token,
          updated_at: now,
          ...(input.appId !== undefined ? { app_id: input.appId } : {}),
          ...(input.deviceId !== undefined ? { device_id: input.deviceId } : {}),
          ...(input.workspaceIds !== undefined ? { workspace_ids: input.workspaceIds } : {}),
        }
        mobilePushTokens.push(registration)
        while (mobilePushTokens.length > MOBILE_PUSH_TOKEN_LIMIT) mobilePushTokens.shift()
        return registration
      }),
    peekAgentToken: (agentId) => services.agentRuntime.peekAgentToken(agentId),
    pauseTerminalRun: lifecycle.pauseTerminalRun,
    resizeAgentRun: (runId, cols, rows) =>
      mutateRuntime(() => lifecycle.resizeTerminalRun(runId, cols, rows)),
    resumeTerminalRun: lifecycle.resumeTerminalRun,
    settings: services.settings,
    writeRunInput: (runId, input) => mutateRuntime(() => lifecycle.writeRunInput(runId, input)),
    getMobileToken: () => services.mobileAuth.getToken(),
    getUiToken: () => services.uiAuth.getToken(),
    stopAgentRun: (runId) =>
      mutateRuntime(() => {
        for (const workspace of services.workspaceStore.listWorkspaces()) {
          for (const agent of services.workspaceStore.getWorkspaceSnapshot(workspace.id).agents) {
            const activeRun = services.agentRuntime.getActiveRunByAgentId(workspace.id, agent.id)
            if (activeRun?.runId === runId) {
              services.chatSubmissionStore.pauseAgent(workspace.id, agent.id, 'agent_stopped')
            }
          }
        }
        lifecycle.stopTerminalRun(runId)
      }),
    stopAgentRunSafely: (runId, input) =>
      mutateRuntimeAsync(async () => {
        for (const workspace of services.workspaceStore.listWorkspaces()) {
          for (const agent of services.workspaceStore.getWorkspaceSnapshot(workspace.id).agents) {
            const activeRun = services.agentRuntime.getActiveRunByAgentId(workspace.id, agent.id)
            if (activeRun?.runId !== runId) continue
            const result = await services.agentRuntime.stopAgentRunSafely(
              workspace,
              agent.id,
              runId,
              input
            )
            if (result.state === 'stopped') {
              services.chatSubmissionStore.pauseAgent(workspace.id, agent.id, 'agent_stopped')
            }
            return result
          }
        }
        lifecycle.stopTerminalRun(runId)
        return {
          mode: input.mode,
          reason: null,
          runId,
          sessionId: null,
          state: 'stopped',
        }
      }),
    stopWorkerForTeam: (workspaceId, workerId) =>
      mutateRuntimeAsync(() => teamWorkerLifecycle.stop(workspaceId, workerId)),
    validateAgentToken: (agentId, token) =>
      services.agentRuntime.validateAgentToken(agentId, token),
    validateMobileToken: (token) => services.mobileAuth.validate(token),
    validateUiToken: (token) => services.uiAuth.validate(token),
  }
}
