import { randomUUID } from 'node:crypto'

import type { ArtifactReference } from '../shared/types.js'
import type { AgentRuntime } from './agent-runtime.js'
import type {
  CreateDispatchInput,
  DispatchRecord,
  ReplaceQueuedDispatchInput,
} from './dispatch-ledger-store.js'
import { toDispatchNotePromptItem } from './dispatch-note-prompt.js'
import type { DispatchNoteRecord } from './dispatch-note-store.js'
import {
  ActiveDispatchConflictError,
  DispatchDeliveryInProgressError,
  DispatchNotePendingError,
  ForbiddenError,
  NoActiveDispatchError,
  NoOpenDispatchError,
  PtyInactiveError,
  ReportRequestConflictError,
  StatusRequestConflictError,
} from './http-errors.js'
import type { MessageLogHandle, MessageLogRecord } from './message-log-store.js'
import {
  createReportMessage,
  createSendMessage,
  createUserInputMessage,
} from './runtime-message-builders.js'
import type { RecordStatusSnapshotInput, StatusSnapshotRecord } from './status-snapshot-store.js'
import type { WorkspaceStore } from './workspace-store.js'

export interface TeamOperationsInput {
  agentRuntime: AgentRuntime
  createDispatch: (input: CreateDispatchInput) => DispatchRecord
  deleteDispatch: (dispatchId: string) => void
  deleteMessage: (handle: MessageLogHandle) => void
  findOpenDispatch: (
    workspaceId: string,
    toAgentId: string,
    dispatchId?: string
  ) => DispatchRecord | undefined
  findOpenDispatchById: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
  findDispatchById: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
  findIdempotentDispatch?: (input: CreateDispatchInput) => DispatchRecord | undefined
  findIdempotentReport: (input: {
    artifacts: string[]
    outcome: 'completed' | 'failed'
    reportText: string
    requestId: string
    toAgentId: string
    workspaceId: string
  }) => DispatchRecord | undefined
  findNextQueuedDispatch?: (workspaceId: string, toAgentId: string) => DispatchRecord | undefined
  findSubmittedDispatch: (workspaceId: string, toAgentId: string) => DispatchRecord | undefined
  findPendingDispatchNote: (
    workspaceId: string,
    dispatchId: string
  ) => DispatchNoteRecord | undefined
  claimPendingDispatchNotes: (
    workspaceId: string,
    dispatchId: string,
    dispatchStatus: 'queued' | 'submitted'
  ) => DispatchNoteRecord[]
  insertMessage: (record: MessageLogRecord) => MessageLogHandle
  findIdempotentStatus: (
    input: Pick<
      RecordStatusSnapshotInput,
      'artifacts' | 'notify' | 'requestId' | 'text' | 'workerId' | 'workspaceId'
    >
  ) => StatusSnapshotRecord | undefined
  markDispatchCancelled: (input: {
    dispatchId: string
    reason: string
    requestId: string
    workspaceId: string
  }) => DispatchRecord | undefined
  markDispatchReportedByWorker: (input: {
    artifacts: string[]
    outcome: 'completed' | 'failed'
    reportText: string
    requestId: string
    toAgentId: string
    workspaceId: string
  }) => DispatchRecord | undefined
  markQueuedDispatchActivated: (
    workspaceId: string,
    dispatchId: string,
    noteIds: string[]
  ) => boolean
  markDispatchSubmitted: (dispatchId: string) => boolean | undefined
  markDispatchNotesFailed: (workspaceId: string, noteIds: string[], error: string) => void
  recordStatus: (input: RecordStatusSnapshotInput) => StatusSnapshotRecord
  replaceQueuedDispatch: (input: ReplaceQueuedDispatchInput) => DispatchRecord | undefined
  workspaceStore: WorkspaceStore
}

export interface DispatchTaskInput {
  assertWorkerReady?: () => void
  artifacts?: string[]
  canDeliver?: () => boolean
  fromAgentId?: string
  hivePort?: string
  queue?: boolean
  requestId?: string
  resolveArtifacts?: () => ArtifactReference[]
}

export interface ReportTaskInput {
  artifacts?: string[]
  outcome?: 'completed' | 'failed'
  requestId?: string
  resolveArtifacts?: () => ArtifactReference[]
  text?: string
}

export interface StatusTaskInput {
  artifacts?: string[]
  notify?: boolean
  requestId?: string
  resolveArtifacts?: () => ArtifactReference[]
  text?: string
}

export interface CancelTaskInput {
  fromAgentId: string
  reason: string
  requestId?: string
}

export interface ReplaceTaskInput {
  artifacts?: string[]
  fromAgentId: string
  interrupt?: boolean
  requestId: string
  resolveArtifacts?: () => ArtifactReference[]
  text: string
}

export interface ReplaceTaskResult {
  dispatch: DispatchRecord
  replacedDispatch: DispatchRecord
}

export interface ReportTaskResult {
  dispatch: DispatchRecord | null
  forwardError: string | null
  forwarded: boolean
}

export interface StatusTaskResult extends ReportTaskResult {
  status: StatusSnapshotRecord
}

export interface DispatchTaskResult extends DispatchRecord {
  startError: string | null
  workerStarted: boolean
}

export const createTeamOperations = ({
  agentRuntime,
  createDispatch,
  deleteDispatch,
  deleteMessage,
  findOpenDispatchById,
  findDispatchById,
  findIdempotentDispatch,
  findIdempotentReport,
  findNextQueuedDispatch,
  findSubmittedDispatch,
  findPendingDispatchNote,
  claimPendingDispatchNotes,
  findIdempotentStatus,
  insertMessage,
  markDispatchCancelled,
  markDispatchReportedByWorker,
  markQueuedDispatchActivated,
  markDispatchSubmitted,
  markDispatchNotesFailed,
  recordStatus,
  replaceQueuedDispatch,
  workspaceStore,
}: TeamOperationsInput) => {
  const deliveriesInProgress = new Set<string>()
  const runDispatchDelivery = async <T>(dispatchId: string, delivery: () => Promise<T>) => {
    if (deliveriesInProgress.has(dispatchId)) {
      throw new DispatchDeliveryInProgressError(dispatchId)
    }
    deliveriesInProgress.add(dispatchId)
    try {
      return await delivery()
    } finally {
      deliveriesInProgress.delete(dispatchId)
    }
  }
  const dispatchTask = async (
    workspaceId: string,
    workerId: string,
    text: string,
    input: DispatchTaskInput = {}
  ) => {
    const queueOnly = input.queue === true

    let messageHandle: MessageLogHandle | undefined
    let dispatch: DispatchRecord | undefined
    let createdDispatch = false
    let delivered = false
    const workerStarted = false

    try {
      const dispatchInput: CreateDispatchInput = {
        ...(input.artifacts ? { artifacts: input.artifacts } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        queue: queueOnly,
        text,
        toAgentId: workerId,
        workspaceId,
      }
      if (input.fromAgentId) dispatchInput.fromAgentId = input.fromAgentId

      const replay = findIdempotentDispatch?.(dispatchInput)
      if (replay) {
        return Object.assign(replay, {
          startError: null,
          workerStarted,
        })
      }

      if (input.fromAgentId && !queueOnly) {
        const worker = workspaceStore.getWorker(workspaceId, workerId)
        const activeDispatch = findSubmittedDispatch(workspaceId, workerId)
        if (activeDispatch) {
          throw new ActiveDispatchConflictError(worker.name, activeDispatch.id)
        }
        input.assertWorkerReady?.()
      }

      if (input.resolveArtifacts) {
        dispatchInput.artifacts = input.resolveArtifacts()
      }

      dispatch = createDispatch(dispatchInput)
      const persistedArtifacts = dispatch.artifacts
      createdDispatch = dispatch.idempotentReplay !== true

      if (dispatch.idempotentReplay) {
        return Object.assign(dispatch, {
          startError: null,
          workerStarted,
        })
      }

      if (queueOnly) {
        return Object.assign(dispatch, {
          startError: null,
          workerStarted,
        })
      }

      if (input.fromAgentId) {
        const dispatchId = dispatch.id
        const sender = workspaceStore.getAgent(workspaceId, input.fromAgentId)
        messageHandle = insertMessage(
          createSendMessage(workspaceId, workerId, text, input.fromAgentId)
        )

        delivered = await runDispatchDelivery(dispatchId, async () => {
          const written = await agentRuntime.writeSendPrompt(
            workspaceId,
            workerId,
            dispatchId,
            sender.name,
            text,
            persistedArtifacts,
            () =>
              findOpenDispatchById(workspaceId, dispatchId)?.status === 'queued' &&
              (input.canDeliver?.() ?? true)
          )
          delivered = written
          if (!written) return false
          if (markDispatchSubmitted(dispatchId) === false) {
            throw new PtyInactiveError(
              `Dispatch delivery state changed before activation: ${dispatchId}`
            )
          }
          return true
        })
        if (!delivered) {
          if (
            createdDispatch &&
            findOpenDispatchById(workspaceId, dispatchId)?.status === 'queued'
          ) {
            deleteDispatch(dispatchId)
          }
          if (messageHandle) deleteMessage(messageHandle)
          input.assertWorkerReady?.()
          throw new PtyInactiveError(`No active run for agent: ${workerId}`)
        }
        const activatedDispatch = findOpenDispatchById(workspaceId, dispatchId)
        if (activatedDispatch?.status !== 'submitted') {
          throw new PtyInactiveError(`Dispatch activation was not persisted: ${dispatchId}`)
        }
        dispatch = activatedDispatch
      } else {
        messageHandle = insertMessage(createSendMessage(workspaceId, workerId, text))
      }

      return Object.assign(dispatch, {
        startError: null,
        workerStarted,
      })
    } catch (error) {
      if (
        dispatch &&
        createdDispatch &&
        !delivered &&
        findOpenDispatchById(workspaceId, dispatch.id)?.status === 'queued'
      ) {
        deleteDispatch(dispatch.id)
      }
      if (messageHandle && !delivered) deleteMessage(messageHandle)
      throw error
    }
  }

  return {
    async activateNextQueuedDispatch(
      workspaceId: string,
      workerId: string,
      input: { canDeliver?: () => boolean } = {}
    ) {
      if (findSubmittedDispatch(workspaceId, workerId)) return null
      const dispatch = findNextQueuedDispatch?.(workspaceId, workerId)
      if (!dispatch) return null
      const sender = dispatch.fromAgentId
        ? workspaceStore.getAgent(workspaceId, dispatch.fromAgentId)
        : workspaceStore.getAgent(workspaceId, `${workspaceId}:orchestrator`)
      workspaceStore.getWorker(workspaceId, workerId)
      let delivered: boolean
      let notes: DispatchNoteRecord[] = []
      try {
        delivered = await runDispatchDelivery(dispatch.id, async () => {
          const written = await agentRuntime.writeSendPrompt(
            workspaceId,
            workerId,
            dispatch.id,
            sender.name,
            dispatch.text,
            dispatch.artifacts,
            () =>
              !findSubmittedDispatch(workspaceId, workerId) &&
              findOpenDispatchById(workspaceId, dispatch.id)?.status === 'queued' &&
              (input.canDeliver?.() ?? true),
            () => {
              notes = claimPendingDispatchNotes(workspaceId, dispatch.id, 'queued')
              return notes.map(toDispatchNotePromptItem)
            }
          )
          if (!written) return false
          return markQueuedDispatchActivated(
            workspaceId,
            dispatch.id,
            notes.map((note) => note.id)
          )
        })
      } catch (error) {
        markDispatchNotesFailed(
          workspaceId,
          notes.map((note) => note.id),
          error instanceof Error ? error.message : String(error)
        )
        throw error
      }
      if (!delivered) {
        markDispatchNotesFailed(
          workspaceId,
          notes.map((note) => note.id),
          'dispatch_activation_deferred'
        )
        return null
      }
      const activatedDispatch = findOpenDispatchById(workspaceId, dispatch.id)
      if (activatedDispatch?.status !== 'submitted') return null
      insertMessage(
        createSendMessage(workspaceId, workerId, dispatch.text, dispatch.fromAgentId ?? undefined)
      )
      return activatedDispatch
    },
    runDispatchDelivery,
    cancelTask(workspaceId: string, dispatchId: string, input: CancelTaskInput) {
      const actor = workspaceStore.getAgent(workspaceId, input.fromAgentId)
      if (actor.kind !== 'orchestrator') {
        throw new ForbiddenError('Only the Orchestrator can cancel a Dispatch')
      }
      if (deliveriesInProgress.has(dispatchId)) {
        throw new DispatchDeliveryInProgressError(dispatchId)
      }
      const dispatch = markDispatchCancelled({
        dispatchId,
        reason: input.reason,
        requestId: input.requestId ?? randomUUID(),
        workspaceId,
      })
      if (!dispatch) {
        throw new NoOpenDispatchError(`No open dispatch: ${dispatchId}`)
      }
      return { dispatch, forwardError: null, forwarded: false }
    },
    dispatchTask,
    dispatchTaskByWorkerName(
      workspaceId: string,
      workerName: string,
      text: string,
      input: DispatchTaskInput = {}
    ) {
      const worker = workspaceStore.getWorkerByName(workspaceId, workerName)
      return dispatchTask(workspaceId, worker.id, text, input)
    },
    recordUserInput(workspaceId: string, orchestratorId: string, text: string) {
      workspaceStore.getAgent(workspaceId, orchestratorId)
      agentRuntime.writeUserInputPrompt(workspaceId, text)
      insertMessage(createUserInputMessage(workspaceId, orchestratorId, text))
    },
    statusTask(workspaceId: string, workerId: string, input: StatusTaskInput = {}) {
      const text = input.text ?? ''
      let artifacts = input.artifacts ?? []
      const notify = input.notify ?? false
      const requestId = input.requestId ?? randomUUID()
      const worker = workspaceStore.getWorker(workspaceId, workerId)
      const activeDispatch = findSubmittedDispatch(workspaceId, workerId)
      if (!activeDispatch) {
        throw new NoActiveDispatchError(`No open dispatch for worker: ${worker.name}`)
      }
      const replay = findIdempotentStatus({
        artifacts,
        notify,
        requestId,
        text,
        workerId,
        workspaceId,
      })
      if (replay) {
        if (replay.dispatchId !== activeDispatch.id) {
          throw new StatusRequestConflictError(requestId)
        }
        return {
          dispatch: activeDispatch,
          forwardError: null,
          forwarded: false,
          status: replay,
        }
      }
      if (input.resolveArtifacts) artifacts = input.resolveArtifacts()
      if (activeDispatch.sequence === null) {
        throw new Error(`Active Dispatch has no sequence: ${activeDispatch.id}`)
      }
      const status = recordStatus({
        artifacts,
        dispatchId: activeDispatch.id,
        dispatchSequence: activeDispatch.sequence,
        notify,
        requestId,
        text,
        workerId,
        workspaceId,
      })
      return {
        dispatch: activeDispatch,
        forwardError: null,
        forwarded: false,
        status,
      }
    },
    reportTask(workspaceId: string, workerId: string, input: ReportTaskInput = {}) {
      const text = input.text ?? ''
      let artifacts = input.artifacts ?? []
      const outcome = input.outcome ?? 'completed'
      const requestId = input.requestId ?? randomUUID()
      const worker = workspaceStore.getWorker(workspaceId, workerId)
      const replay = findIdempotentReport({
        artifacts,
        outcome,
        reportText: text,
        requestId,
        toAgentId: workerId,
        workspaceId,
      })
      const openDispatch = findSubmittedDispatch(workspaceId, workerId)
      if (replay) {
        if (openDispatch && replay.id !== openDispatch.id) {
          throw new ReportRequestConflictError(requestId)
        }
        return { dispatch: replay, forwardError: null, forwarded: false }
      }
      if (!openDispatch) {
        throw new NoActiveDispatchError(`No open dispatch for worker: ${worker.name}`)
      }
      const pendingNote = findPendingDispatchNote(workspaceId, openDispatch.id)
      if (pendingNote) {
        throw new DispatchNotePendingError(
          `Dispatch Note ${pendingNote.id} has not been delivered at a safe Provider boundary`
        )
      }
      if (input.resolveArtifacts) artifacts = input.resolveArtifacts()
      const dispatch = markDispatchReportedByWorker({
        artifacts,
        outcome,
        reportText: text,
        requestId,
        toAgentId: workerId,
        workspaceId,
      })
      if (!dispatch) {
        throw new NoActiveDispatchError(`No open dispatch for worker: ${worker.name}`)
      }
      insertMessage(createReportMessage(workspaceId, workerId, text, outcome, artifacts))
      return { dispatch, forwardError: null, forwarded: false }
    },
    replaceTask(workspaceId: string, dispatchId: string, input: ReplaceTaskInput) {
      const actor = workspaceStore.getAgent(workspaceId, input.fromAgentId)
      if (actor.kind !== 'orchestrator') {
        throw new ForbiddenError('Only the Orchestrator can replace a Dispatch')
      }
      const replacedDispatch = findDispatchById(workspaceId, dispatchId)
      if (!replacedDispatch) throw new NoOpenDispatchError(`No open dispatch: ${dispatchId}`)
      const replay = findIdempotentDispatch?.({
        artifacts: input.artifacts ?? [],
        fromAgentId: input.fromAgentId,
        queue: true,
        queuePosition: replacedDispatch.queuePosition,
        replacesDispatchId: replacedDispatch.id,
        requestId: input.requestId,
        text: input.text,
        toAgentId: replacedDispatch.toAgentId,
        workspaceId,
      })
      if (replay) return { dispatch: replay, replacedDispatch }
      const artifacts = input.resolveArtifacts?.() ?? input.artifacts
      const dispatch = replaceQueuedDispatch({
        ...(artifacts ? { artifacts } : {}),
        dispatchId,
        fromAgentId: input.fromAgentId,
        requestId: input.requestId,
        text: input.text,
        workspaceId,
      })
      if (!dispatch) {
        throw new NoOpenDispatchError(`Dispatch is not queued: ${dispatchId}`)
      }
      return { dispatch, replacedDispatch }
    },
  }
}
