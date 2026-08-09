import { describe, expect, test } from 'vitest'
import type {
  DispatchRecord,
  ListDispatchesOptions,
} from '../../src/server/dispatch-ledger-store.js'
import type { DispatchNoteRecord } from '../../src/server/dispatch-note-store.js'
import type { StatusRecoveryMessage } from '../../src/server/message-log-store.js'
import {
  buildDefaultOrchestratorContext,
  buildFocusedWorkerContext,
  buildWorkerResponsibilityContext,
} from '../../src/server/team-context.js'
import type { TeamListItem } from '../../src/shared/types.js'

const workspaceId = 'workspace-1'
const workerId = 'worker-1'

const dispatch = (
  id: string,
  status: DispatchRecord['status'],
  sequence: number
): DispatchRecord => ({
  artifacts: [],
  createdAt: sequence,
  deliveredAt: status === 'submitted' ? sequence : null,
  fromAgentId: 'orchestrator-1',
  id,
  reportedAt: status === 'reported' || status === 'cancelled' ? sequence : null,
  reportText: null,
  sequence,
  status,
  submittedAt: status === 'submitted' ? sequence : null,
  text: `complete task ${id}`,
  toAgentId: workerId,
  workspaceId,
})

const note = (sequence: number): DispatchNoteRecord => ({
  actorId: 'orchestrator-1',
  actorType: 'agent',
  artifacts: [],
  createdAt: sequence,
  deliveredAt: sequence,
  deliveryError: null,
  deliveryState: 'delivered',
  dispatchId: 'active',
  id: `note-${sequence}`,
  sequence,
  text: `note ${sequence}`,
  workspaceId,
})

const createStore = (
  workers: TeamListItem[],
  dispatches: DispatchRecord[],
  notes: DispatchNoteRecord[],
  statuses: StatusRecoveryMessage[] = []
) => ({
  getDispatch: (_workspaceId: string, dispatchId: string) =>
    dispatches.find((candidate) => candidate.id === dispatchId),
  getLastPtyLineForAgent: () => null,
  getLatestStatuses: (_workspaceId: string, workerIds: string[]) =>
    new Map(
      statuses
        .filter((status) => workerIds.includes(status.from))
        .map((status) => [status.from, status])
    ),
  listDispatchNotes: (
    _workspaceId: string,
    _dispatchId: string,
    options: {
      deliveryStates?: DispatchNoteRecord['deliveryState'][]
      limit?: number
      order?: 'asc' | 'desc'
    } = {}
  ) => {
    const filtered = options.deliveryStates
      ? notes.filter((item) => options.deliveryStates?.includes(item.deliveryState))
      : notes
    const ordered = options.order === 'desc' ? filtered.toReversed() : filtered
    return ordered.slice(0, options.limit)
  },
  listDispatches: (_workspaceId: string, options: ListDispatchesOptions = {}) => {
    const filtered = dispatches.filter(
      (candidate) =>
        (!options.status || candidate.status === options.status) &&
        (!options.toAgentId || candidate.toAgentId === options.toAgentId)
    )
    const ordered = options.order === 'desc' ? filtered.toReversed() : filtered
    return ordered.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 100))
  },
  listWorkers: () => workers,
  peekAgentLaunchConfig: () => undefined,
})

describe('Team Context bounds', () => {
  test('caps focused queue and Note history while preserving complete current details', () => {
    const active = dispatch('active', 'submitted', 1)
    const queued = Array.from({ length: 55 }, (_, index) =>
      dispatch(`queued-${index}`, 'queued', index + 2)
    )
    const worker: TeamListItem = {
      activeDispatchId: active.id,
      conversationActivity: 'idle',
      id: workerId,
      kind: 'worker',
      lastObservedAt: 1,
      name: 'Alice',
      processState: 'running',
      queuePauseReason: null,
      queuedDispatchCount: queued.length,
    }
    const context = buildFocusedWorkerContext(
      createStore(
        [worker],
        [active, ...queued],
        Array.from({ length: 55 }, (_, index) => note(index))
      ),
      workspaceId,
      worker.name
    )

    expect(context?.active_dispatch).toMatchObject({
      notes_truncated: true,
      task: 'complete task active',
    })
    expect(context?.active_dispatch?.notes).toHaveLength(50)
    expect(context?.active_dispatch?.notes[0]?.id).toBe('note-5')
    expect(context?.queue).toHaveLength(50)
    expect(context?.queue.at(-1)?.id).toBe('queued-49')
    expect(context).toMatchObject({ queue_total_count: 55, queue_truncated: true })
  })

  test('resolves the active Dispatch directly after more than 100 historical records', () => {
    const active = dispatch('active', 'submitted', 121)
    const historical = Array.from({ length: 120 }, (_, index) =>
      dispatch(`reported-${index}`, 'reported', index + 1)
    )
    const worker: TeamListItem = {
      activeDispatchId: active.id,
      conversationActivity: 'busy',
      id: workerId,
      kind: 'worker',
      lastObservedAt: 1,
      name: 'Alice',
      processState: 'running',
      queuePauseReason: null,
      queuedDispatchCount: 0,
    }
    const context = buildDefaultOrchestratorContext(
      createStore([worker], [...historical, active], []),
      workspaceId
    )

    expect(context.members[0]?.active_dispatch).toEqual({
      id: active.id,
      task_first_line: active.text,
    })
  })

  test('shows blocked lifecycle and current replacement lineage without Provider Session identity', () => {
    const blocked = {
      ...dispatch('blocked-active', 'submitted', 1),
      operationAttempts: 2,
      operationError: 'Provider remained busy after two interruption attempts',
      operationKind: 'replace' as const,
      operationRequestId: 'replace-request',
      operationSessionId: 'provider-session-secret',
      operationState: 'blocked' as const,
      operationUpdatedAt: 10,
      pendingReplacementId: 'pending-replacement',
    }
    const worker: TeamListItem = {
      activeDispatchId: blocked.id,
      conversationActivity: 'busy',
      id: workerId,
      kind: 'worker',
      lastObservedAt: 10,
      name: 'Alice',
      processState: 'running',
      queuePauseReason: null,
      queuedDispatchCount: 0,
    }
    const store = createStore([worker], [blocked], [])
    const team = buildDefaultOrchestratorContext(store, workspaceId)
    const focused = buildFocusedWorkerContext(store, workspaceId, worker.name)
    const responsibility = buildWorkerResponsibilityContext(store, workspaceId, worker.id)

    expect(team.members[0]?.active_dispatch).toMatchObject({
      lifecycle: {
        attempts: 2,
        error: 'Provider remained busy after two interruption attempts',
        kind: 'replace',
        state: 'blocked',
        updated_at: 10,
      },
    })
    expect(focused?.active_dispatch?.lifecycle).toMatchObject({
      attempts: 2,
      kind: 'replace',
      state: 'blocked',
    })
    expect(responsibility?.active_dispatch?.lifecycle).toMatchObject({
      attempts: 2,
      kind: 'replace',
      state: 'blocked',
    })
    expect(JSON.stringify({ focused, responsibility, team })).not.toContain(
      'provider-session-secret'
    )

    const replacement = {
      ...dispatch('replacement', 'submitted', 2),
      replacesDispatchId: blocked.id,
    }
    const replacedWorker = { ...worker, activeDispatchId: replacement.id }
    const replacedStore = createStore([replacedWorker], [blocked, replacement], [])
    expect(
      buildDefaultOrchestratorContext(replacedStore, workspaceId).members[0]?.active_dispatch
    ).toMatchObject({ replaces_dispatch_id: blocked.id })
    expect(
      buildWorkerResponsibilityContext(replacedStore, workspaceId, worker.id)?.active_dispatch
    ).toMatchObject({ replaces_dispatch_id: blocked.id })
  })

  test('omits a cancellation once newer work has reached a terminal state', () => {
    const cancelled = {
      ...dispatch('cancelled', 'cancelled', 1),
      reportText: 'old direction',
      reportedAt: 20,
    }
    const reported = {
      ...dispatch('reported', 'reported', 2),
      reportText: 'new work complete',
      reportedAt: 20,
    }
    const worker: TeamListItem = {
      activeDispatchId: null,
      conversationActivity: 'idle',
      id: workerId,
      kind: 'worker',
      lastObservedAt: 1,
      name: 'Alice',
      processState: 'running',
      queuePauseReason: null,
      queuedDispatchCount: 0,
    }

    expect(
      buildWorkerResponsibilityContext(
        createStore([worker], [cancelled, reported], []),
        workspaceId,
        worker.id
      )?.recent_cancellation
    ).toBeNull()
  })

  test('shows only the latest terminal Report in Worker responsibility Context', () => {
    const cancelled = {
      ...dispatch('cancelled', 'cancelled', 1),
      reportText: 'old direction',
      reportedAt: 10,
    }
    const reported = {
      ...dispatch('reported', 'reported', 2),
      artifacts: ['reports/final.md'],
      reportText: 'verified result',
      reportedAt: 20,
    }
    const queued = dispatch('queued', 'queued', 3)
    const worker: TeamListItem = {
      activeDispatchId: null,
      conversationActivity: 'idle',
      id: workerId,
      kind: 'worker',
      lastObservedAt: 1,
      name: 'Alice',
      processState: 'running',
      queuePauseReason: null,
      queuedDispatchCount: 1,
    }

    expect(
      buildWorkerResponsibilityContext(
        createStore([worker], [cancelled, reported, queued], []),
        workspaceId,
        worker.id
      )
    ).toMatchObject({
      active_dispatch: null,
      queued_dispatch_count: 1,
      recent_cancellation: null,
      recent_report: {
        artifacts: ['reports/final.md'],
        id: reported.id,
        reported_at: 20,
        status: 'reported',
        text: 'verified result',
      },
    })
    expect(
      buildFocusedWorkerContext(
        createStore([worker], [cancelled, reported, queued], []),
        workspaceId,
        worker.name
      )
    ).toMatchObject({
      recent_cancellation: null,
      recent_report: {
        artifacts: ['reports/final.md'],
        id: reported.id,
        reported_at: 20,
        status: 'reported',
        text: 'verified result',
      },
    })
  })

  test('bounds terminal Report and cancellation payloads', () => {
    const worker: TeamListItem = {
      activeDispatchId: null,
      conversationActivity: 'idle',
      id: workerId,
      kind: 'worker',
      lastObservedAt: 1,
      name: 'Alice',
      processState: 'running',
      queuePauseReason: null,
      queuedDispatchCount: 0,
    }
    const reported = {
      ...dispatch('reported', 'reported', 1),
      artifacts: Array.from({ length: 25 }, () => 'x'.repeat(2_000)),
      reportText: 'R'.repeat(10_000),
    }
    const reportContext = buildWorkerResponsibilityContext(
      createStore([worker], [reported], []),
      workspaceId,
      worker.id
    )

    expect(reportContext?.recent_report).toMatchObject({
      artifacts_truncated: true,
      text_truncated: true,
    })
    expect(reportContext?.recent_report?.artifacts).toHaveLength(20)
    expect(reportContext?.recent_report?.artifacts[0]).toHaveLength(1_024)
    expect(reportContext?.recent_report?.text).toHaveLength(4_096)

    const cancelled = {
      ...dispatch('cancelled', 'cancelled', 2),
      reportText: 'C'.repeat(10_000),
    }
    const cancellationContext = buildWorkerResponsibilityContext(
      createStore([worker], [reported, cancelled], []),
      workspaceId,
      worker.id
    )

    expect(cancellationContext?.recent_cancellation).toMatchObject({
      reason_truncated: true,
      status: 'cancelled',
    })
    expect(cancellationContext?.recent_cancellation?.reason).toHaveLength(4_096)
    expect(cancellationContext?.recent_report).toBeNull()
  })

  test('caps default team summaries and discloses the omitted member count', () => {
    const workers = Array.from({ length: 55 }, (_, index) => ({
      activeDispatchId: null,
      conversationActivity: 'idle' as const,
      id: `worker-${index}`,
      kind: 'worker' as const,
      lastObservedAt: 1,
      name: `Worker ${index}`,
      processState: 'running' as const,
      queuePauseReason: null,
      queuedDispatchCount: 0,
    }))
    const context = buildDefaultOrchestratorContext(createStore(workers, [], []), workspaceId)

    expect(context.members).toHaveLength(50)
    expect(context).toMatchObject({ member_total_count: 55, members_truncated: true })
  })

  test('uses persisted lifecycle identity instead of timestamps for current Status', () => {
    const active = dispatch('active', 'submitted', 1)
    const worker: TeamListItem = {
      activeDispatchId: active.id,
      conversationActivity: 'busy',
      id: workerId,
      kind: 'worker',
      lastObservedAt: 1,
      name: 'Alice',
      processState: 'running',
      queuePauseReason: null,
      queuedDispatchCount: 0,
    }
    const currentStatus: StatusRecoveryMessage = {
      artifacts: [],
      createdAt: active.submittedAt ?? active.createdAt,
      dispatchId: active.id,
      dispatchSequence: active.sequence,
      from: worker.id,
      text: 'same-millisecond progress',
      type: 'status',
    }
    const staleIdleStatus: StatusRecoveryMessage = {
      ...currentStatus,
      dispatchId: null,
      dispatchSequence: null,
      text: 'idle before assignment',
    }

    expect(
      buildWorkerResponsibilityContext(
        createStore([worker], [active], [], [currentStatus]),
        workspaceId,
        worker.id
      )?.active_dispatch?.latest_status
    ).toMatchObject({ text: 'same-millisecond progress' })
    expect(
      buildWorkerResponsibilityContext(
        createStore([worker], [active], [], [staleIdleStatus]),
        workspaceId,
        worker.id
      )?.active_dispatch?.latest_status
    ).toBeNull()
  })

  test('bounds summary, queued task, Note, Status, and Artifact payloads', () => {
    const active = { ...dispatch('active', 'submitted', 1), text: 'A'.repeat(10_000) }
    const queued = { ...dispatch('queued', 'queued', 2), text: 'Q'.repeat(10_000) }
    const worker: TeamListItem = {
      activeDispatchId: active.id,
      conversationActivity: 'busy',
      id: workerId,
      kind: 'worker',
      lastObservedAt: 1,
      name: 'Alice',
      processState: 'running',
      queuePauseReason: null,
      queuedDispatchCount: 1,
    }
    const status: StatusRecoveryMessage = {
      artifacts: Array.from({ length: 25 }, () => 'x'.repeat(2_000)),
      createdAt: 1,
      dispatchId: active.id,
      dispatchSequence: active.sequence,
      from: worker.id,
      text: 'S'.repeat(10_000),
      type: 'status',
    }
    const notes = Array.from({ length: 55 }, (_, index) => ({
      ...note(index),
      artifacts: Array.from({ length: 25 }, () => 'x'.repeat(2_000)),
      text: 'N'.repeat(10_000),
    }))
    const store = createStore([worker], [active, queued], notes, [status])
    const team = buildDefaultOrchestratorContext(store, workspaceId)
    const focused = buildFocusedWorkerContext(store, workspaceId, worker.name)

    expect(team.members[0]?.active_dispatch).toMatchObject({ task_first_line_truncated: true })
    expect(team.members[0]?.active_dispatch?.task_first_line).toHaveLength(512)
    expect(team.members[0]?.latest_status).toMatchObject({
      artifacts_truncated: true,
      text_truncated: true,
    })
    expect(focused?.active_dispatch?.task).toHaveLength(10_000)
    expect(focused?.active_dispatch?.notes).toHaveLength(50)
    expect(focused?.active_dispatch?.notes[0]).toMatchObject({
      artifacts_truncated: true,
      text_truncated: true,
    })
    expect(focused?.queue[0]).toMatchObject({ task_truncated: true })
    expect(focused?.queue[0]?.task).toHaveLength(4_096)
  })
})
