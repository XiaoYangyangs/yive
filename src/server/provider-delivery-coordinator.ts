import type { MobileConversationPage } from '../shared/types.js'
import { createActiveConversationObserver } from './active-conversation-observer.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { normalizeArtifactReferences } from './artifact-reference.js'
import { validateBoundMobileChatAttachments } from './chat-attachment-binding.js'
import { resolveConversationProvider } from './conversation-provider-resolver.js'
import {
  findObservedCoordinationEventIds,
  serializeCoordinationEvents,
} from './coordination-event-prompt.js'
import type { CoordinationEventRecord } from './coordination-event-store.js'
import type { ProviderInputBoundary } from './dispatch-lifecycle-coordinator.js'
import { findObservedDispatchNoteIds, toDispatchNotePromptItem } from './dispatch-note-prompt.js'
import type { AppendDispatchNoteInput, DispatchNoteRecord } from './dispatch-note-store.js'
import {
  validateDispatchNoteFields,
  validateDispatchNoteInput,
} from './dispatch-note-validation.js'
import { ConflictError } from './http-errors.js'
import { hasInteractivePromptReady, isInteractiveAgentCommand } from './post-start-input-writer.js'
import {
  buildRuntimeContextPrompt,
  RUNTIME_CONTEXT_UNAVAILABLE_MESSAGE,
} from './recovery-summary.js'
import type { RuntimeStoreServices } from './runtime-store-helpers.js'
import type { DispatchTaskInput } from './team-operations.js'
import { canDeliverToWorker } from './worker-delivery-readiness.js'

interface StartAgentOptions {
  hivePort: string
  suppressStartupInstructions?: boolean
}

interface ProviderDeliveryCoordinatorOptions {
  assertWorkerReadyForImmediateDelivery: (
    workspaceId: string,
    workerId: string,
    expectedConversationId?: string
  ) => MobileConversationPage
  getRuntimeContext: (workspaceId: string, agentId: string) => unknown | null | undefined
  notifyRuntimeChanged: () => void
  services: RuntimeStoreServices
  startAgent: (
    workspaceId: string,
    agentId: string,
    input: StartAgentOptions
  ) => Promise<LiveAgentRun>
}

export const createProviderDeliveryCoordinator = ({
  assertWorkerReadyForImmediateDelivery,
  getRuntimeContext,
  notifyRuntimeChanged,
  services,
  startAgent,
}: ProviderDeliveryCoordinatorOptions) => {
  const conversationDeliveryChains = new Map<string, Promise<unknown>>()
  const conversationDeliveryKinds = new Map<string, 'automatic' | 'direct' | 'forced'>()
  const dispatchTaskChains = new Map<string, Promise<unknown>>()
  const dispatchNotePollTimers = new Map<string, NodeJS.Timeout>()
  const coordinationEventPollTimers = new Map<string, NodeJS.Timeout>()
  const pendingProviderBoundaries = new Map<string, ProviderInputBoundary>()
  let closed = false

  const runConversationDelivery = <T>(
    conversationId: string,
    kind: 'automatic' | 'direct' | 'forced',
    delivery: () => Promise<T>
  ) => {
    const previous = conversationDeliveryChains.get(conversationId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(delivery)
    conversationDeliveryChains.set(conversationId, current)
    conversationDeliveryKinds.set(conversationId, kind)
    const cleanup = () => {
      if (conversationDeliveryChains.get(conversationId) === current) {
        conversationDeliveryChains.delete(conversationId)
        conversationDeliveryKinds.delete(conversationId)
      }
    }
    void current.then(cleanup, cleanup)
    return current
  }

  const runDispatchTask = <T>(workspaceId: string, workerId: string, task: () => Promise<T>) => {
    const key = `${workspaceId}:${workerId}`
    const previous = dispatchTaskChains.get(key)
    const current = previous ? previous.catch(() => undefined).then(task) : task()
    dispatchTaskChains.set(key, current)
    const cleanup = () => {
      if (dispatchTaskChains.get(key) === current) dispatchTaskChains.delete(key)
    }
    void current.then(cleanup, cleanup)
    return current
  }

  const providerBoundaryKey = (workspaceId: string, agentId: string) => `${workspaceId}:${agentId}`

  const toProviderInputBoundary = (
    conversation: Pick<MobileConversationPage, 'id' | 'source_checkpoint' | 'stale'>
  ): ProviderInputBoundary | undefined => {
    if (conversation.stale) return undefined
    return {
      conversationId: conversation.id,
      sourceCheckpoint: conversation.source_checkpoint,
    }
  }

  const armProviderInputBoundary = (
    workspaceId: string,
    agentId: string,
    boundary: ProviderInputBoundary | undefined
  ) => {
    if (!boundary) return
    pendingProviderBoundaries.set(providerBoundaryKey(workspaceId, agentId), {
      conversationId: boundary.conversationId,
      sourceCheckpoint: boundary.sourceCheckpoint,
    })
  }

  const hasPendingProviderBoundary = (
    workspaceId: string,
    agentId: string,
    conversation: MobileConversationPage
  ) => {
    const key = providerBoundaryKey(workspaceId, agentId)
    const pending = pendingProviderBoundaries.get(key)
    if (!pending) return false
    const reachedFreshIdle =
      !conversation.stale &&
      conversation.activity_state === 'idle' &&
      (conversation.id !== pending.conversationId ||
        conversation.source_checkpoint > pending.sourceCheckpoint)
    if (!reachedFreshIdle) return true
    pendingProviderBoundaries.delete(key)
    return false
  }

  const buildCoordinationEventBatch = (events: CoordinationEventRecord[]) => {
    const truncateEventField = (value: string, limit: number) => {
      const characters = Array.from(value)
      return characters.length <= limit ? value : characters.slice(0, limit).join('')
    }
    const lines = ['[Hive system message: Team coordination updates]']
    for (const event of events) {
      const worker = services.workspaceStore.getWorker(event.workspaceId, event.workerId)
      lines.push('', `Worker: ${worker.name}`, `Dispatch: ${event.dispatchId ?? 'none'}`)
      if (event.kind === 'report') {
        lines.push(`Outcome: ${event.outcome ?? 'completed'}`)
      } else if (event.kind === 'crash') {
        lines.push('Update: Worker process crashed unexpectedly.')
      } else {
        lines.push('Update: notified Status')
      }
      lines.push(`Result: ${truncateEventField(event.text, 2_048)}`)
      for (const artifact of event.artifacts.slice(0, 20)) {
        lines.push(`Artifact: ${truncateEventField(artifact, 1_024)}`)
      }
    }
    lines.push('', serializeCoordinationEvents(events), '')
    return lines.join('\n')
  }

  const isCurrentOrchestratorIdle = (conversation: MobileConversationPage) => {
    const current = conversationObserver.getCurrentConversation(
      conversation.workspace_id,
      conversation.agent_id,
      30,
      { bypassDetectionCache: true }
    )
    return Boolean(
      current &&
        current.id === conversation.id &&
        !current.stale &&
        current.activity_state === 'idle'
    )
  }

  const reconcileObservedCoordinationEvents = (conversation: MobileConversationPage) => {
    const current = conversationObserver.getCurrentConversation(
      conversation.workspace_id,
      conversation.agent_id,
      100,
      { bypassDetectionCache: true }
    )
    if (!current || current.stale) return 0
    const undelivered = services.coordinationEventStore.listUndelivered(
      conversation.workspace_id,
      100
    )
    return services.coordinationEventStore.reconcileDelivered(
      findObservedCoordinationEventIds(current.turns, undelivered)
    )
  }

  const deliverCoordinationEventBatch = async (conversation: MobileConversationPage) => {
    let events: CoordinationEventRecord[] = []
    let ids: string[] = []
    let submitted = false
    try {
      const delivered = await services.agentRuntime.writeCoordinationPrompt(
        conversation.workspace_id,
        () => {
          if (!isCurrentOrchestratorIdle(conversation)) return null
          reconcileObservedCoordinationEvents(conversation)
          if (
            services.coordinationEventStore
              .listUndelivered(conversation.workspace_id, 100)
              .some((event) => event.deliveryState === 'delivering')
          ) {
            return null
          }
          events = services.coordinationEventStore.claimPending(conversation.workspace_id)
          ids = events.map((event) => event.id)
          return events.length > 0 ? buildCoordinationEventBatch(events) : null
        },
        {
          beforeWrite: () => {},
          onWriteFailed: () => services.coordinationEventStore.release(ids, 'pty_write_failed'),
        }
      )
      if (!delivered) {
        if (ids.length > 0) {
          services.coordinationEventStore.release(ids, 'orchestrator_not_idle')
        }
        return false
      }
      submitted = true
      notifyRuntimeChanged()
      schedulePendingCoordinationEventPoll(conversation.workspace_id)
      return true
    } catch (error) {
      if (!submitted) {
        services.coordinationEventStore.release(
          ids,
          error instanceof Error ? error.message : String(error)
        )
      }
      throw error
    }
  }

  const deliverSubmissionById = async (
    conversation: Pick<MobileConversationPage, 'agent_id' | 'id' | 'workspace_id'>,
    submissionId: string,
    prepare: () => { body: string; started: boolean },
    markUndeliveredBeforeStart: boolean,
    preflight?: () => void
  ) => {
    let deliveryStarted = false
    let inputBoundary: ProviderInputBoundary | undefined
    let runId: string | null
    try {
      preflight?.()
      runId = await services.agentRuntime.writeChatSubmission(
        conversation.workspace_id,
        conversation.agent_id,
        () => {
          const current = conversationObserver.getCurrentConversation(
            conversation.workspace_id,
            conversation.agent_id,
            30,
            { bypassDetectionCache: true }
          )
          if (!current || current.id !== conversation.id) {
            throw new ConflictError('Chat delivery requires the current active conversation')
          }
          inputBoundary = toProviderInputBoundary(current)
          const delivery = prepare()
          deliveryStarted = delivery.started
          return delivery.started ? delivery.body : null
        }
      )
    } catch (error) {
      if (deliveryStarted || markUndeliveredBeforeStart) {
        services.chatSubmissionStore.markUndelivered(submissionId, 'pty_delivery_failed')
      }
      throw error
    }
    if (runId === null || !deliveryStarted) return services.chatSubmissionStore.get(submissionId)
    armProviderInputBoundary(conversation.workspace_id, conversation.agent_id, inputBoundary)
    return services.chatSubmissionStore.markDelivered(submissionId)
  }

  const getReadyNoteInputBoundary = (
    workspaceId: string,
    workerId: string
  ): ProviderInputBoundary | undefined | null => {
    if (!services.agentRuntime.getActiveRunByAgentId(workspaceId, workerId)) return null
    const config = services.agentRuntime.peekAgentLaunchConfig(workspaceId, workerId)
    if (!config) return null
    const command = config.interactiveCommand ?? config.command
    if (!isInteractiveAgentCommand(command)) return undefined
    if (!resolveConversationProvider(config)) {
      const lastPtyLine = services.workerOutputTracker?.getLastPtyLine(workspaceId, workerId)
      return lastPtyLine && hasInteractivePromptReady(lastPtyLine, command) ? undefined : null
    }
    const conversation = conversationObserver.getCurrentConversation(workspaceId, workerId, 30, {
      bypassDetectionCache: true,
    })
    if (
      !conversation ||
      hasPendingProviderBoundary(workspaceId, workerId, conversation) ||
      conversation.stale ||
      conversation.activity_state !== 'idle'
    ) {
      return null
    }
    return toProviderInputBoundary(conversation) ?? null
  }

  const isNoteInputReady = (workspaceId: string, workerId: string) =>
    getReadyNoteInputBoundary(workspaceId, workerId) !== null

  const deliverDispatchNoteBatch = async (
    workspaceId: string,
    dispatchId: string,
    workerId: string
  ): Promise<DispatchNoteRecord[]> =>
    services.teamOps.runDispatchDelivery(dispatchId, async () => {
      const dispatch = services.dispatchLedgerStore.findDispatchById(workspaceId, dispatchId)
      if (!dispatch || dispatch.toAgentId !== workerId) {
        throw new ConflictError('Dispatch Note target Worker is no longer available')
      }
      if (
        dispatch.status !== 'submitted' ||
        dispatch.operationKind !== null ||
        !isNoteInputReady(workspaceId, workerId)
      ) {
        return []
      }
      const conversation = conversationObserver.getCurrentConversation(workspaceId, workerId, 100, {
        bypassDetectionCache: true,
      })
      if (conversation && !conversation.stale) {
        const pending = services.dispatchNoteStore.listForDispatch(workspaceId, dispatchId, {
          deliveryStates: ['queued', 'delivering', 'failed'],
        })
        const reconciledIds = findObservedDispatchNoteIds(conversation.turns, dispatchId, pending)
        services.dispatchNoteStore.reconcileDeliveredMany(workspaceId, reconciledIds)
      }
      const notes = services.dispatchNoteStore.claimPendingForDispatch(
        workspaceId,
        dispatchId,
        'submitted'
      )
      if (notes.length === 0) return []
      const noteIds = notes.map((note) => note.id)
      let inputBoundary: ProviderInputBoundary | undefined
      try {
        const delivered = await services.agentRuntime.writeDispatchNotePrompt(
          workspaceId,
          workerId,
          {
            dispatchId,
            notes: notes.map(toDispatchNotePromptItem),
          },
          () => {
            const current = services.dispatchLedgerStore.findDispatchById(workspaceId, dispatchId)
            if (current?.status !== 'submitted' || current.operationKind !== null) return false
            const readyBoundary = getReadyNoteInputBoundary(workspaceId, workerId)
            if (readyBoundary === null) return false
            inputBoundary = readyBoundary
            return true
          }
        )
        if (!delivered) {
          services.dispatchNoteStore.markFailedMany(
            workspaceId,
            noteIds,
            'provider_boundary_changed'
          )
          return []
        }
        armProviderInputBoundary(workspaceId, workerId, inputBoundary)
        services.dispatchNoteStore.markDeliveredMany(workspaceId, noteIds)
        return noteIds.flatMap((noteId) => {
          const note = services.dispatchNoteStore.get(workspaceId, noteId)
          return note ? [note] : []
        })
      } catch (error) {
        services.dispatchNoteStore.markFailedMany(
          workspaceId,
          noteIds,
          error instanceof Error ? error.message : String(error)
        )
        throw error
      }
    })

  const getNoteTarget = (workspaceId: string, note: DispatchNoteRecord) =>
    services.dispatchLedgerStore.findDispatchById(workspaceId, note.dispatchId)?.toAgentId

  const scheduleAutomaticQueuedNoteDelivery = (conversation: MobileConversationPage) => {
    if (closed) return false
    const candidate = services.dispatchNoteStore.listNextForAgent(
      conversation.workspace_id,
      conversation.agent_id
    )
    if (!candidate) return false
    const activeDelivery = conversationDeliveryChains.get(conversation.id)
    if (activeDelivery) {
      if (conversationDeliveryKinds.get(conversation.id) !== 'forced') {
        const retry = () => scheduleAutomaticQueuedDelivery(conversation)
        void activeDelivery.then(retry, retry)
      }
      return true
    }
    const target = getNoteTarget(conversation.workspace_id, candidate)
    if (!target) return true
    if (!isNoteInputReady(conversation.workspace_id, target)) {
      schedulePendingDispatchNotePoll(conversation.workspace_id, target)
      return true
    }
    void runConversationDelivery(conversation.id, 'automatic', () =>
      deliverDispatchNoteBatch(conversation.workspace_id, candidate.dispatchId, target)
    )
      .then(() => scheduleAutomaticQueuedDelivery(conversation))
      .catch((error) => {
        console.warn(`Failed to deliver Dispatch Note ${candidate.id}`, error)
      })
    return true
  }

  const scheduleAutomaticQueuedDelivery = (conversation: MobileConversationPage) => {
    if (closed) return
    const current = conversationObserver.getCurrentConversation(
      conversation.workspace_id,
      conversation.agent_id,
      30,
      { bypassDetectionCache: true }
    )
    if (
      !current ||
      current.id !== conversation.id ||
      current.stale ||
      current.activity_state !== 'idle'
    ) {
      return
    }
    const orchestratorId = `${conversation.workspace_id}:orchestrator`
    const orchestratorRun = services.agentRuntime.getActiveRunByAgentId(
      conversation.workspace_id,
      orchestratorId
    )
    const undeliveredCoordinationEvents =
      conversation.agent_id === orchestratorId
        ? services.coordinationEventStore.listUndelivered(conversation.workspace_id)
        : []
    if (
      conversation.agent_id === orchestratorId &&
      orchestratorRun &&
      orchestratorRun.stopping !== true &&
      orchestratorRun.status !== 'error' &&
      orchestratorRun.status !== 'exited' &&
      undeliveredCoordinationEvents.length > 0
    ) {
      if (undeliveredCoordinationEvents.some((event) => event.deliveryState === 'delivering')) {
        schedulePendingCoordinationEventPoll(conversation.workspace_id)
        return
      }
      const activeDelivery = conversationDeliveryChains.get(conversation.id)
      if (activeDelivery) {
        if (conversationDeliveryKinds.get(conversation.id) !== 'forced') {
          const retry = () => scheduleAutomaticQueuedDelivery(conversation)
          void activeDelivery.then(retry, retry)
        }
        return
      }
      void runConversationDelivery(conversation.id, 'automatic', () =>
        deliverCoordinationEventBatch(conversation)
      )
        .then(() => scheduleAutomaticQueuedDelivery(conversation))
        .catch((error) => {
          console.warn(`Failed to deliver Team coordination events for ${orchestratorId}`, error)
          schedulePendingCoordinationEventPoll(conversation.workspace_id)
        })
      return
    }
    if (
      services.agentRuntime.getActiveRunByAgentId(
        conversation.workspace_id,
        conversation.agent_id
      ) &&
      !services.workerQueueStateStore.getPauseReason(
        conversation.workspace_id,
        conversation.agent_id
      ) &&
      !services.dispatchLedgerStore.findSubmittedDispatch(
        conversation.workspace_id,
        conversation.agent_id
      ) &&
      services.dispatchLedgerStore.findNextQueuedDispatch(
        conversation.workspace_id,
        conversation.agent_id
      )
    ) {
      let inputBoundary: ProviderInputBoundary | undefined
      const canDeliver = () =>
        canDeliverToWorker(
          () =>
            assertWorkerReadyForImmediateDelivery(
              conversation.workspace_id,
              conversation.agent_id,
              conversation.id
            ),
          (readyConversation) => {
            inputBoundary = toProviderInputBoundary(readyConversation)
          }
        )
      void runDispatchTask(conversation.workspace_id, conversation.agent_id, () =>
        canDeliver()
          ? services.teamOps.activateNextQueuedDispatch(
              conversation.workspace_id,
              conversation.agent_id,
              { canDeliver }
            )
          : Promise.resolve(null)
      )
        .then((dispatch) => {
          if (dispatch) {
            armProviderInputBoundary(
              conversation.workspace_id,
              conversation.agent_id,
              inputBoundary
            )
            notifyRuntimeChanged()
          }
        })
        .catch((error) => {
          console.warn(`Failed to activate queued Dispatch for ${conversation.agent_id}`, error)
        })
      return
    }
    const activeDelivery = conversationDeliveryChains.get(conversation.id)
    if (activeDelivery) {
      if (conversationDeliveryKinds.get(conversation.id) !== 'forced') {
        const retry = () => scheduleAutomaticQueuedDelivery(conversation)
        void activeDelivery.then(retry, retry)
      }
      return
    }
    if (scheduleAutomaticQueuedNoteDelivery(conversation)) return
    const candidate = services.chatSubmissionStore.getNextAutomaticCandidate(conversation.id)
    if (!candidate) return
    void runConversationDelivery(conversation.id, 'automatic', () =>
      deliverSubmissionById(
        conversation,
        candidate.id,
        () => services.chatSubmissionStore.beginAutomaticDelivery(conversation.id, candidate.id),
        candidate.attachments.length > 0,
        candidate.attachments.length > 0
          ? () =>
              validateBoundMobileChatAttachments(
                services.workspaceStore.getWorkspaceSnapshot(conversation.workspace_id).summary
                  .path,
                candidate.id,
                candidate.attachments
              )
          : undefined
      )
    ).catch((error) => {
      console.warn(`Failed to deliver queued Chat submission ${candidate.id}`, error)
    })
  }

  const conversationObserver = createActiveConversationObserver(services, {
    onContextCompacted: (workspaceId, agentId) => {
      let prompt = RUNTIME_CONTEXT_UNAVAILABLE_MESSAGE
      try {
        const context = getRuntimeContext(workspaceId, agentId)
        if (context === undefined) return
        if (context !== null) prompt = buildRuntimeContextPrompt(context)
      } catch (error) {
        console.warn(`Failed to build Runtime Context after compaction for ${agentId}`, error)
      }
      try {
        services.agentRuntime.writeContextPrompt(workspaceId, agentId, prompt)
      } catch (error) {
        console.warn(`Failed to inject Runtime Context after compaction for ${agentId}`, error)
      }
    },
    onConversationChanged: notifyRuntimeChanged,
    onConversationIdle: scheduleAutomaticQueuedDelivery,
  })

  function schedulePendingCoordinationEventPoll(workspaceId: string) {
    if (closed || coordinationEventPollTimers.has(workspaceId)) return
    const timer = setTimeout(() => {
      coordinationEventPollTimers.delete(workspaceId)
      if (closed || services.coordinationEventStore.listUndelivered(workspaceId, 1).length === 0) {
        return
      }
      const orchestratorId = `${workspaceId}:orchestrator`
      const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, orchestratorId)
      const conversation = conversationObserver.getCurrentConversation(workspaceId, orchestratorId)
      if (conversation && !conversation.stale) {
        try {
          reconcileObservedCoordinationEvents(conversation)
        } catch (error) {
          console.warn(`Failed to reconcile Team coordination events for ${orchestratorId}`, error)
        }
      }
      if (services.coordinationEventStore.listUndelivered(workspaceId, 1).length === 0) return
      if (
        !activeRun ||
        activeRun.stopping === true ||
        activeRun.status === 'error' ||
        activeRun.status === 'exited'
      ) {
        return
      }
      if (conversation && !conversation.stale && conversation.activity_state === 'idle') {
        scheduleAutomaticQueuedDelivery(conversation)
        return
      }
      schedulePendingCoordinationEventPoll(workspaceId)
    }, 250)
    timer.unref()
    coordinationEventPollTimers.set(workspaceId, timer)
  }

  const deliverPendingDispatchNoteIfReady = async (workspaceId: string, workerId: string) => {
    const note = services.dispatchNoteStore.listNextForAgent(workspaceId, workerId)
    if (!note) return false
    if (!isNoteInputReady(workspaceId, workerId)) return false
    const conversation = conversationObserver.getCurrentConversation(workspaceId, workerId)
    const key = conversation?.id ?? `dispatch-note:${workspaceId}:${workerId}`
    await runConversationDelivery(key, 'automatic', () =>
      deliverDispatchNoteBatch(workspaceId, note.dispatchId, workerId)
    )
    return true
  }

  const dispatchNotePollKey = (workspaceId: string, workerId: string) =>
    `${workspaceId}:${workerId}`

  const clearDispatchNotePoll = (workspaceId: string, workerId: string) => {
    const key = dispatchNotePollKey(workspaceId, workerId)
    const timer = dispatchNotePollTimers.get(key)
    if (timer) clearTimeout(timer)
    dispatchNotePollTimers.delete(key)
  }

  function schedulePendingDispatchNotePoll(workspaceId: string, workerId: string) {
    if (closed) return
    const key = dispatchNotePollKey(workspaceId, workerId)
    if (dispatchNotePollTimers.has(key)) return
    const timer = setTimeout(async () => {
      dispatchNotePollTimers.delete(key)
      if (closed) return
      if (!services.agentRuntime.getActiveRunByAgentId(workspaceId, workerId)) return
      if (!services.dispatchNoteStore.listNextForAgent(workspaceId, workerId)) return
      try {
        await deliverPendingDispatchNoteIfReady(workspaceId, workerId)
      } catch (error) {
        console.warn(`Failed to deliver a queued Dispatch Note for ${workerId}`, error)
      }
      if (closed) return
      if (services.dispatchNoteStore.listNextForAgent(workspaceId, workerId)) {
        schedulePendingDispatchNotePoll(workspaceId, workerId)
      }
    }, 250)
    timer.unref()
    dispatchNotePollTimers.set(key, timer)
  }

  const appendDispatchNote = async (
    workspaceId: string,
    input: Omit<AppendDispatchNoteInput, 'artifacts' | 'workspaceId'> & { artifacts: string[] }
  ) => {
    const workspacePath = services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
    validateDispatchNoteFields(input)
    const lexicalArtifacts = normalizeArtifactReferences(input.artifacts)
    const existing = services.dispatchNoteStore.get(workspaceId, input.id)
    const noteInput = {
      ...input,
      artifacts: existing
        ? lexicalArtifacts
        : validateDispatchNoteInput({ ...input, artifacts: lexicalArtifacts, workspacePath }),
      workspaceId,
    }
    const result = services.dispatchNoteStore.append(noteInput)
    const note = result.note
    const dispatch = services.dispatchLedgerStore.findDispatchById(workspaceId, note.dispatchId)
    if (dispatch?.status !== 'submitted') return result
    const target = dispatch.toAgentId
    if (!target || !services.agentRuntime.getActiveRunByAgentId(workspaceId, target)) return result

    const conversation = conversationObserver.getCurrentConversation(workspaceId, target)
    if (!isNoteInputReady(workspaceId, target)) {
      schedulePendingDispatchNotePoll(workspaceId, target)
      return result
    }
    const key = conversation?.id ?? `dispatch-note:${workspaceId}:${target}`
    await runConversationDelivery(key, 'automatic', () =>
      deliverDispatchNoteBatch(workspaceId, note.dispatchId, target)
    )
    if (services.dispatchNoteStore.listNextForAgent(workspaceId, target)) {
      schedulePendingDispatchNotePoll(workspaceId, target)
    }
    return { ...result, note: services.dispatchNoteStore.get(workspaceId, note.id) ?? note }
  }

  const startAgentAndResumePending = async (
    workspaceId: string,
    agentId: string,
    input: StartAgentOptions
  ) => {
    const run = await startAgent(workspaceId, agentId, input)
    try {
      await deliverPendingDispatchNoteIfReady(workspaceId, agentId)
    } catch (error) {
      console.warn(`Failed to deliver a pending Dispatch Note for ${agentId}`, error)
    }
    if (services.dispatchNoteStore.listNextForAgent(workspaceId, agentId)) {
      schedulePendingDispatchNotePoll(workspaceId, agentId)
    }
    if (agentId === `${workspaceId}:orchestrator`) {
      schedulePendingCoordinationEventPoll(workspaceId)
    }
    return run
  }

  const prepareImmediateDelivery = (
    workspaceId: string,
    workerId: string,
    input: DispatchTaskInput | undefined
  ) => {
    let inputBoundary: ProviderInputBoundary | undefined
    if (!input?.fromAgentId || input.queue === true) {
      return { getInputBoundary: () => inputBoundary, input }
    }
    let expectedConversationId: string | undefined
    const assertWorkerReady = () => {
      expectedConversationId = assertWorkerReadyForImmediateDelivery(
        workspaceId,
        workerId,
        expectedConversationId
      ).id
    }
    const canDeliver = () =>
      canDeliverToWorker(
        () => assertWorkerReadyForImmediateDelivery(workspaceId, workerId, expectedConversationId),
        (conversation) => {
          expectedConversationId = conversation.id
          inputBoundary = toProviderInputBoundary(conversation)
        }
      )
    return {
      getInputBoundary: () => inputBoundary,
      input: { ...input, assertWorkerReady, canDeliver },
    }
  }

  const removeAgent = (workspaceId: string, agentId: string) => {
    clearDispatchNotePoll(workspaceId, agentId)
    pendingProviderBoundaries.delete(providerBoundaryKey(workspaceId, agentId))
  }

  const close = async () => {
    closed = true
    pendingProviderBoundaries.clear()
    for (const timer of dispatchNotePollTimers.values()) clearTimeout(timer)
    dispatchNotePollTimers.clear()
    for (const timer of coordinationEventPollTimers.values()) clearTimeout(timer)
    coordinationEventPollTimers.clear()
    conversationObserver.close()
    await Promise.allSettled([...conversationDeliveryChains.values()])
    await Promise.allSettled([...dispatchTaskChains.values()])
  }

  services.agentExitCallbacks.add((workspaceId, agentId, processState) => {
    notifyRuntimeChanged()
    if (processState !== 'crashed' || agentId === `${workspaceId}:orchestrator`) return
    schedulePendingCoordinationEventPoll(workspaceId)
  })

  return {
    appendDispatchNote,
    armProviderInputBoundary,
    close,
    conversationObserver,
    deliverSubmissionById,
    hasConversationDelivery: (conversationId: string) =>
      conversationDeliveryChains.has(conversationId),
    prepareImmediateDelivery,
    removeAgent,
    runConversationDelivery,
    runDispatchTask,
    scheduleAutomaticQueuedDelivery,
    schedulePendingDispatchNotePoll,
    startAgentAndResumePending,
    toProviderInputBoundary,
  }
}
