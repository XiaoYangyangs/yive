import type { TeamListItem } from '../shared/types.js'
import type { DispatchRecord, ListDispatchesOptions } from './dispatch-ledger-store.js'
import type { DispatchNoteRecord, ListDispatchNotesOptions } from './dispatch-note-store.js'
import type { StatusRecoveryMessage } from './message-log-store.js'
import { enrichTeamList, type TeamListEnrichmentStore } from './team-list-enrichment.js'

type TeamContextStore = TeamListEnrichmentStore & {
  getDispatch: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
  listDispatches: (workspaceId: string, options?: ListDispatchesOptions) => DispatchRecord[]
  listDispatchNotes: (
    workspaceId: string,
    dispatchId: string,
    options?: ListDispatchNotesOptions
  ) => DispatchNoteRecord[]
  getLatestStatuses: (
    workspaceId: string,
    workerIds: string[]
  ) => Map<string, StatusRecoveryMessage>
  listWorkers: (workspaceId: string) => TeamListItem[]
}

const CONTEXT_ITEM_LIMIT = 50
const CONTEXT_MEMBER_LIMIT = 50
const CONTEXT_ARTIFACT_LIMIT = 20
const CONTEXT_ARTIFACT_TEXT_LIMIT = 1_024
const CONTEXT_NOTE_TEXT_LIMIT = 4_096
const CONTEXT_QUEUE_TASK_LIMIT = 4_096
const CONTEXT_STATUS_TEXT_LIMIT = 2_048
const CONTEXT_TASK_LINE_LIMIT = 512
const CONTEXT_TERMINAL_TEXT_LIMIT = 4_096

const truncateText = (text: string, limit: number) => {
  if (text.length <= limit) return { text, truncated: false }
  let value = text.slice(0, limit)
  const lastCodeUnit = value.charCodeAt(value.length - 1)
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) value = value.slice(0, -1)
  return { text: value, truncated: true }
}

const serializeArtifacts = (artifacts: string[]) => {
  const visible = artifacts
    .slice(0, CONTEXT_ARTIFACT_LIMIT)
    .map((artifact) => truncateText(artifact, CONTEXT_ARTIFACT_TEXT_LIMIT))
  const truncated =
    artifacts.length > visible.length || visible.some((artifact) => artifact.truncated)
  return {
    artifacts: visible.map((artifact) => artifact.text),
    ...(truncated ? { artifacts_truncated: true } : {}),
  }
}

const firstTaskLine = (text: string) =>
  truncateText(text.split(/\r?\n/u, 1)[0]?.trim() ?? '', CONTEXT_TASK_LINE_LIMIT)

const getActionableFailures = (worker: TeamListItem) => {
  const failures: string[] = []
  if (worker.processState === 'crashed') failures.push('Worker process crashed.')
  if (worker.conversationActivity === 'unknown') {
    failures.push('Provider conversation state is unknown.')
  }
  if (worker.queuePauseReason) failures.push(`Queue paused: ${worker.queuePauseReason}`)
  return failures
}

const serializeLatestStatus = (status: StatusRecoveryMessage | undefined) =>
  status
    ? (() => {
        const serializedText = truncateText(status.text, CONTEXT_STATUS_TEXT_LIMIT)
        return {
          ...serializeArtifacts(status.artifacts),
          text: serializedText.text,
          ...(serializedText.truncated ? { text_truncated: true } : {}),
          updated_at: status.createdAt,
        }
      })()
    : null

const serializeReport = (dispatch: DispatchRecord) => {
  const serializedText = truncateText(dispatch.reportText ?? '', CONTEXT_TERMINAL_TEXT_LIMIT)
  return {
    ...serializeArtifacts(dispatch.artifacts),
    outcome: dispatch.reportOutcome,
    reported_at: dispatch.reportedAt,
    text: serializedText.text,
    ...(serializedText.truncated ? { text_truncated: true } : {}),
  }
}

const serializeCancellation = (dispatch: DispatchRecord) => {
  const serializedReason = truncateText(dispatch.reportText ?? '', CONTEXT_TERMINAL_TEXT_LIMIT)
  return {
    cancelled_at: dispatch.reportedAt,
    reason: serializedReason.text,
    ...(serializedReason.truncated ? { reason_truncated: true } : {}),
  }
}

const serializeLifecycle = (dispatch: DispatchRecord) =>
  dispatch.operationKind && dispatch.operationState
    ? {
        attempts: dispatch.operationAttempts,
        error: dispatch.operationError,
        kind: dispatch.operationKind,
        state: dispatch.operationState,
        updated_at: dispatch.operationUpdatedAt,
      }
    : null

const serializeReplacementLineage = (dispatch: DispatchRecord) => ({
  ...(dispatch.replacedBy ? { replaced_by: dispatch.replacedBy } : {}),
  ...(dispatch.replacesDispatchId ? { replaces_dispatch_id: dispatch.replacesDispatchId } : {}),
})

const serializeWorker = (worker: TeamListItem) => ({
  actionable_failures: getActionableFailures(worker),
  conversation_activity: worker.conversationActivity,
  kind: worker.kind,
  last_observed_at: worker.lastObservedAt,
  name: worker.name,
  process_state: worker.processState,
  provider: worker.provider ?? null,
  queue_pause_reason: worker.queuePauseReason,
  queued_dispatch_count: worker.queuedDispatchCount,
})

const serializeNotes = (notes: DispatchNoteRecord[]) =>
  notes.map((note) => {
    const serializedText = truncateText(note.text, CONTEXT_NOTE_TEXT_LIMIT)
    return {
      ...serializeArtifacts(note.artifacts),
      created_at: note.createdAt,
      delivered_at: note.deliveredAt,
      delivery_state: note.deliveryState,
      id: note.id,
      text: serializedText.text,
      ...(serializedText.truncated ? { text_truncated: true } : {}),
    }
  })

const serializeDispatch = (
  store: TeamContextStore,
  workspaceId: string,
  dispatch: DispatchRecord,
  latestStatus: StatusRecoveryMessage | undefined,
  noteVisibility: 'all' | 'delivered' | 'none',
  taskVisibility: 'full' | 'bounded' = 'full'
) => {
  const visibleNotes =
    noteVisibility === 'none'
      ? []
      : store.listDispatchNotes(workspaceId, dispatch.id, {
          ...(noteVisibility === 'delivered' ? { deliveryStates: ['delivered'] } : {}),
          limit: CONTEXT_ITEM_LIMIT + 1,
          order: 'desc',
        })
  const notes = visibleNotes.slice(0, CONTEXT_ITEM_LIMIT).reverse()
  const serializedTask =
    taskVisibility === 'bounded'
      ? truncateText(dispatch.text, CONTEXT_QUEUE_TASK_LIMIT)
      : { text: dispatch.text, truncated: false }
  const lifecycle = serializeLifecycle(dispatch)
  return {
    ...serializeArtifacts(dispatch.artifacts),
    ...serializeReplacementLineage(dispatch),
    created_at: dispatch.createdAt,
    delivered_at: dispatch.deliveredAt,
    id: dispatch.id,
    ...(lifecycle ? { lifecycle } : {}),
    latest_status: serializeLatestStatus(latestStatus),
    notes: serializeNotes(notes),
    notes_truncated: visibleNotes.length > notes.length,
    report:
      dispatch.status === 'reported' && dispatch.reportText ? serializeReport(dispatch) : null,
    cancellation:
      dispatch.status === 'cancelled' && dispatch.reportText
        ? serializeCancellation(dispatch)
        : null,
    status: dispatch.status,
    submitted_at: dispatch.submittedAt,
    task: serializedTask.text,
    ...(serializedTask.truncated ? { task_truncated: true } : {}),
  }
}

const getActiveDispatch = (store: TeamContextStore, workspaceId: string, worker: TeamListItem) => {
  if (!worker.activeDispatchId) return undefined
  const dispatch = store.getDispatch(workspaceId, worker.activeDispatchId)
  return dispatch?.toAgentId === worker.id && dispatch.status === 'submitted' ? dispatch : undefined
}

const getLatestDispatch = (store: TeamContextStore, workspaceId: string, workerId: string) =>
  store.listDispatches(workspaceId, {
    limit: 1,
    order: 'desc',
    toAgentId: workerId,
  })[0]

const getCurrentStatus = (
  store: TeamContextStore,
  workspaceId: string,
  worker: TeamListItem,
  latestStatus: StatusRecoveryMessage | undefined,
  active: DispatchRecord | undefined
) => {
  if (!latestStatus) return undefined
  if (active) return latestStatus.dispatchId === active.id ? latestStatus : undefined
  const latestDispatch = getLatestDispatch(store, workspaceId, worker.id)
  return latestStatus.dispatchId === null &&
    latestStatus.dispatchSequence === (latestDispatch?.sequence ?? null)
    ? latestStatus
    : undefined
}

const getLatestTerminalDispatch = (
  store: TeamContextStore,
  workspaceId: string,
  workerId: string
) => {
  const reported = store.listDispatches(workspaceId, {
    limit: 1,
    order: 'desc',
    status: 'reported',
    toAgentId: workerId,
  })[0]
  const cancelled = store.listDispatches(workspaceId, {
    limit: 1,
    order: 'desc',
    status: 'cancelled',
    toAgentId: workerId,
  })[0]
  if (!reported) return cancelled
  if (!cancelled) return reported
  return (reported.sequence ?? reported.createdAt) > (cancelled.sequence ?? cancelled.createdAt)
    ? reported
    : cancelled
}

const getEnrichedWorkers = (store: TeamContextStore, workspaceId: string) =>
  enrichTeamList(workspaceId, store, store.listWorkers(workspaceId))

export const buildDefaultOrchestratorContext = (store: TeamContextStore, workspaceId: string) => {
  const workers = getEnrichedWorkers(store, workspaceId)
  const visibleWorkers = workers.slice(0, CONTEXT_MEMBER_LIMIT)
  const latestStatusByWorker = store.getLatestStatuses(
    workspaceId,
    visibleWorkers.map((worker) => worker.id)
  )

  return {
    member_total_count: workers.length,
    members: visibleWorkers.map((worker) => {
      const active = getActiveDispatch(store, workspaceId, worker)
      const latestStatus = getCurrentStatus(
        store,
        workspaceId,
        worker,
        latestStatusByWorker.get(worker.id),
        active
      )
      const taskFirstLine = active ? firstTaskLine(active.text) : null
      const lifecycle = active ? serializeLifecycle(active) : null
      return {
        actionable_failures: getActionableFailures(worker),
        active_dispatch: active
          ? {
              ...serializeReplacementLineage(active),
              id: active.id,
              ...(lifecycle ? { lifecycle } : {}),
              task_first_line: taskFirstLine?.text ?? '',
              ...(taskFirstLine?.truncated ? { task_first_line_truncated: true } : {}),
            }
          : null,
        conversation_activity: worker.conversationActivity,
        kind: worker.kind,
        last_observed_at: worker.lastObservedAt,
        latest_status: latestStatus ? serializeLatestStatus(latestStatus) : null,
        name: worker.name,
        process_state: worker.processState,
        provider: worker.provider ?? null,
        queue_pause_reason: worker.queuePauseReason,
        queued_dispatch_count: worker.queuedDispatchCount,
      }
    }),
    members_truncated: workers.length > visibleWorkers.length,
    scope: 'team' as const,
  }
}

export const buildFocusedWorkerContext = (
  store: TeamContextStore,
  workspaceId: string,
  workerName: string
) => {
  const worker = getEnrichedWorkers(store, workspaceId).find(
    (candidate) => candidate.name === workerName
  )
  if (!worker) return undefined
  const active = getActiveDispatch(store, workspaceId, worker)
  const queued = store.listDispatches(workspaceId, {
    limit: CONTEXT_ITEM_LIMIT + 1,
    status: 'queued',
    toAgentId: worker.id,
  })
  const visibleQueue = queued.slice(0, CONTEXT_ITEM_LIMIT)
  const latestStatus = store.getLatestStatuses(workspaceId, [worker.id]).get(worker.id)
  const currentStatus = getCurrentStatus(store, workspaceId, worker, latestStatus, active)
  const recentTerminal = getLatestTerminalDispatch(store, workspaceId, worker.id)
  return {
    active_dispatch: active
      ? serializeDispatch(store, workspaceId, active, currentStatus, 'all')
      : null,
    queue: visibleQueue.map((dispatch) =>
      serializeDispatch(store, workspaceId, dispatch, undefined, 'none', 'bounded')
    ),
    queue_total_count: worker.queuedDispatchCount,
    queue_truncated: queued.length > visibleQueue.length,
    recent_cancellation:
      recentTerminal?.status === 'cancelled'
        ? {
            ...serializeCancellation(recentTerminal),
            id: recentTerminal.id,
            status: recentTerminal.status,
          }
        : null,
    recent_report:
      recentTerminal?.status === 'reported'
        ? {
            ...serializeReport(recentTerminal),
            id: recentTerminal.id,
            status: recentTerminal.status,
          }
        : null,
    scope: 'worker' as const,
    worker: serializeWorker(worker),
  }
}

export const buildWorkerResponsibilityContext = (
  store: TeamContextStore,
  workspaceId: string,
  workerId: string
) => {
  const worker = getEnrichedWorkers(store, workspaceId).find(
    (candidate) => candidate.id === workerId
  )
  if (!worker) return undefined
  const active = getActiveDispatch(store, workspaceId, worker)
  const latestStatus = store.getLatestStatuses(workspaceId, [worker.id]).get(worker.id)
  const currentStatus = getCurrentStatus(store, workspaceId, worker, latestStatus, active)
  const recentTerminal = !active
    ? getLatestTerminalDispatch(store, workspaceId, worker.id)
    : undefined
  return {
    active_dispatch: active
      ? serializeDispatch(store, workspaceId, active, currentStatus, 'delivered')
      : null,
    queued_dispatch_count: worker.queuedDispatchCount,
    recent_cancellation:
      recentTerminal?.status === 'cancelled'
        ? {
            ...serializeCancellation(recentTerminal),
            id: recentTerminal.id,
            status: recentTerminal.status,
          }
        : null,
    recent_report:
      recentTerminal?.status === 'reported'
        ? {
            ...serializeReport(recentTerminal),
            id: recentTerminal.id,
            status: recentTerminal.status,
          }
        : null,
    scope: 'responsibility' as const,
    worker: serializeWorker(worker),
  }
}

export const buildFocusedDispatchContext = (
  store: TeamContextStore,
  workspaceId: string,
  dispatchId: string
) => {
  const dispatch = store.getDispatch(workspaceId, dispatchId)
  if (!dispatch) return undefined
  const worker = getEnrichedWorkers(store, workspaceId).find(
    (candidate) => candidate.id === dispatch.toAgentId
  )
  if (!worker) return undefined
  const latestStatus = store.getLatestStatuses(workspaceId, [worker.id]).get(worker.id)
  const currentStatus = latestStatus?.dispatchId === dispatch.id ? latestStatus : undefined
  return {
    dispatch: serializeDispatch(store, workspaceId, dispatch, currentStatus, 'all'),
    scope: 'dispatch' as const,
    worker: serializeWorker(worker),
  }
}
