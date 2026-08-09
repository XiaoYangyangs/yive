import { afterEach, describe, expect, test, vi } from 'vitest'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { createTeamOperations } from '../../src/server/team-operations.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const dispatchNoteDependencies = () => ({
  claimPendingDispatchNotes: vi.fn(() => []),
  markDispatchNotesFailed: vi.fn(),
  markQueuedDispatchActivated: vi.fn(() => true),
})

describe('team atomicity', () => {
  test('dispatchTask rejects a stopped Worker without creating a Dispatch', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-stopped-worker', 'Stopped Worker')
    const worker = store.addWorker(workspace.id, { name: 'Alice' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')

    await expect(
      store.dispatchTask(workspace.id, worker.id, 'Do not auto-start', {
        fromAgentId: orchestrator.id,
      })
    ).rejects.toMatchObject({ code: 'agent_process_not_running', statusCode: 409 })

    expect(store.listDispatches(workspace.id)).toEqual([])
    await store.close()
  })

  test('dispatchTask rejects a second active Dispatch before recording or PTY delivery', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }
    const activeDispatch = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: Date.now(),
      fromAgentId: orchestrator.id,
      id: 'dispatch-active',
      reportedAt: null,
      reportText: null,
      sequence: 1,
      status: 'submitted',
      submittedAt: Date.now(),
      text: 'Existing task',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    } as const
    const candidateDispatch = {
      ...activeDispatch,
      deliveredAt: null,
      id: 'dispatch-candidate',
      sequence: 2,
      status: 'queued' as const,
      submittedAt: null,
      text: 'Second task',
    }
    const createDispatch = vi.fn(() => candidateDispatch)
    const deleteDispatch = vi.fn()
    const insertMessage = vi.fn()
    const writeSendPrompt = vi.fn()
    const ops = createTeamOperations({
      ...dispatchNoteDependencies(),
      agentRuntime: {
        writeSendPrompt,
      } as never,
      createDispatch,
      deleteDispatch,
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(),
      findOpenDispatchById: vi.fn(() => candidateDispatch),
      findSubmittedDispatch: vi.fn(() => activeDispatch),
      findPendingDispatchNote: vi.fn(),
      insertMessage,
      markDispatchCancelled: vi.fn(),
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted: vi.fn(),
      workspaceStore: store,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Second task', {
        fromAgentId: orchestrator.id,
      })
    ).rejects.toMatchObject({
      code: 'active_dispatch_exists',
      message: 'Worker Alice already has active Dispatch dispatch-active',
      statusCode: 409,
    })

    expect(insertMessage).not.toHaveBeenCalled()
    expect(createDispatch).not.toHaveBeenCalled()
    expect(deleteDispatch).not.toHaveBeenCalled()
    expect(writeSendPrompt).not.toHaveBeenCalled()
  })

  test('dispatchTask does not create responsibility when message insert fails before PTY write', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }
    const insertMessage = vi.fn(() => {
      throw new Error('insert message failed')
    })
    const dispatch = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: orchestrator.id,
      id: 'dispatch-1',
      reportedAt: null,
      reportText: null,
      sequence: 1,
      status: 'queued' as const,
      submittedAt: null,
      text: 'Implement login',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    }
    const createDispatch = vi.fn(() => dispatch)
    const deleteDispatch = vi.fn()
    const deleteMessage = vi.fn()
    const writeSendPrompt = vi.fn()
    const markTaskDispatched = vi.fn()
    const ops = createTeamOperations({
      ...dispatchNoteDependencies(),
      agentRuntime: {
        writeSendPrompt,
        writeReportPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch,
      deleteDispatch,
      deleteMessage,
      findOpenDispatch: vi.fn(),
      findOpenDispatchById: vi.fn(() => dispatch),
      findSubmittedDispatch: vi.fn(),
      findPendingDispatchNote: vi.fn(),
      insertMessage,
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted: vi.fn(),
      workspaceStore: {
        getAgent: store.getAgent,
        getWorker: store.getWorker,
        getWorkerByName: (workspaceId: string, workerName: string) => {
          const worker = store
            .getWorkspaceSnapshot(workspaceId)
            .agents.find((agent) => agent.name === workerName && agent.kind === 'worker')
          if (!worker) {
            throw new Error(`Worker not found: ${workerName}`)
          }
          return worker
        },
        markTaskDispatched,
        markTaskReported: vi.fn(),
      } as never,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Implement login', { fromAgentId: orchestrator.id })
    ).rejects.toThrow(/insert message failed/)

    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: worker.id,
        activeDispatchId: null,
        processState: 'stopped',
        queuedDispatchCount: 0,
      })
    )
    expect(store.listMessagesForRecovery(workspace.id, 0)).toEqual([])
    expect(writeSendPrompt).not.toHaveBeenCalled()
    expect(insertMessage).toHaveBeenCalledTimes(1)
    expect(createDispatch).toHaveBeenCalledOnce()
    expect(deleteMessage).not.toHaveBeenCalled()
    expect(deleteDispatch).toHaveBeenCalledWith(dispatch.id)
    expect(markTaskDispatched).not.toHaveBeenCalled()
  })

  test('dispatchTask rolls back responsibility when the running PTY is inactive', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }
    const dispatch = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: orchestrator.id,
      id: 'dispatch-1',
      reportedAt: null,
      reportText: null,
      status: 'queued',
      submittedAt: null,
      text: 'Implement login',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    } as const
    const deleteDispatch = vi.fn()
    const deleteMessage = vi.fn()
    const startAgent = vi.fn()

    const ops = createTeamOperations({
      ...dispatchNoteDependencies(),
      agentRuntime: {
        startAgent,
        writeReportPrompt: vi.fn(),
        writeSendPrompt: vi.fn(() => false),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(() => dispatch),
      deleteDispatch,
      deleteMessage,
      findOpenDispatch: vi.fn(),
      findOpenDispatchById: vi.fn(() => dispatch),
      findSubmittedDispatch: vi.fn(),
      findPendingDispatchNote: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted: vi.fn(),
      workspaceStore: {
        ...store,
        markAgentStarted: vi.fn(),
        markAgentStopped: vi.fn(),
      } as never,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Implement login', { fromAgentId: orchestrator.id })
    ).rejects.toThrow(/No active run for agent/)

    expect(startAgent).not.toHaveBeenCalled()
    expect(deleteDispatch).toHaveBeenCalledWith(dispatch.id)
    expect(deleteMessage).toHaveBeenCalledWith({ sequence: 1 })
    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: worker.id,
        activeDispatchId: null,
        processState: 'stopped',
        queuedDispatchCount: 0,
      })
    )
  })

  test('dispatchTask revalidates the Worker before writing stdin', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }
    const dispatch = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: orchestrator.id,
      id: 'dispatch-1',
      reportedAt: null,
      reportText: null,
      status: 'queued',
      submittedAt: null,
      text: 'Implement login',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    } as const
    const deleteDispatch = vi.fn()
    const deleteMessage = vi.fn()
    const markDispatchSubmitted = vi.fn()
    const writeSendPrompt = vi.fn()

    const ops = createTeamOperations({
      ...dispatchNoteDependencies(),
      agentRuntime: {
        writeReportPrompt: vi.fn(),
        writeSendPrompt,
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(() => dispatch),
      deleteDispatch,
      deleteMessage,
      findOpenDispatch: vi.fn(),
      findOpenDispatchById: vi.fn(() => dispatch),
      findSubmittedDispatch: vi.fn(),
      findPendingDispatchNote: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted,
      workspaceStore: {
        ...store,
        getWorker: (workspaceId: string, workerId: string) => {
          store.deleteWorker(workspaceId, workerId)
          return store.getWorker(workspaceId, workerId)
        },
      } as never,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Implement login', { fromAgentId: orchestrator.id })
    ).rejects.toThrow(/Agent not found|Worker not found/)

    expect(writeSendPrompt).not.toHaveBeenCalled()
    expect(markDispatchSubmitted).not.toHaveBeenCalled()
    expect(deleteDispatch).not.toHaveBeenCalled()
    expect(deleteMessage).not.toHaveBeenCalled()
  })

  test('queued activation revalidates the Provider boundary immediately before PTY delivery', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-queued-boundary', 'Queued Boundary')
    const worker = store.addWorker(workspace.id, { name: 'Alice' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    const dispatch = {
      artifacts: ['src/task.ts'],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: orchestrator.id,
      id: 'dispatch-queued',
      reportedAt: null,
      reportText: null,
      sequence: 1,
      status: 'queued' as const,
      submittedAt: null,
      text: 'Queued task',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    }
    const insertMessage = vi.fn()
    const markDispatchSubmitted = vi.fn()
    const writeSendPrompt = vi.fn(
      async (...args: unknown[]) => (args[6] as (() => boolean) | undefined)?.() ?? true
    )
    const ops = createTeamOperations({
      ...dispatchNoteDependencies(),
      agentRuntime: { writeSendPrompt } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findLatestDispatch: vi.fn(),
      findNextQueuedDispatch: vi.fn(() => dispatch),
      findOpenDispatch: vi.fn(),
      findOpenDispatchById: vi.fn(() => dispatch),
      findPendingDispatchNote: vi.fn(),
      findSubmittedDispatch: vi.fn(),
      insertMessage,
      markDispatchCancelled: vi.fn(),
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted,
      workspaceStore: store,
    })

    await expect(
      ops.activateNextQueuedDispatch(workspace.id, worker.id, { canDeliver: () => false })
    ).resolves.toBeNull()
    expect(writeSendPrompt).toHaveBeenCalledOnce()
    expect(markDispatchSubmitted).not.toHaveBeenCalled()
    expect(insertMessage).not.toHaveBeenCalled()
    await store.close()
  })

  test('queued cancellation fails closed while the same Dispatch is being delivered', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-delivery-cancel', 'Delivery Cancel')
    const worker = store.addWorker(workspace.id, { name: 'Alice' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    const dispatch = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: orchestrator.id,
      id: 'dispatch-delivering',
      reportedAt: null,
      reportText: null,
      sequence: 1,
      status: 'queued' as const,
      submittedAt: null,
      text: 'Queued task',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    }
    let finishDelivery: ((delivered: boolean) => void) | undefined
    const delivery = new Promise<boolean>((resolve) => {
      finishDelivery = resolve
    })
    const writeSendPrompt = vi.fn(() => delivery)
    const markDispatchCancelled = vi.fn()
    let dispatchSubmitted = false
    const markQueuedDispatchActivated = vi.fn(() => {
      dispatchSubmitted = true
      return true
    })
    const ops = createTeamOperations({
      ...dispatchNoteDependencies(),
      agentRuntime: { writeSendPrompt } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findLatestDispatch: vi.fn(),
      findNextQueuedDispatch: vi.fn(() => dispatch),
      findOpenDispatch: vi.fn(),
      findOpenDispatchById: vi.fn(() => ({
        ...dispatch,
        status: dispatchSubmitted ? ('submitted' as const) : dispatch.status,
      })),
      findPendingDispatchNote: vi.fn(),
      findSubmittedDispatch: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled,
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted: vi.fn(),
      markQueuedDispatchActivated,
      workspaceStore: store,
    })

    const activation = ops.activateNextQueuedDispatch(workspace.id, worker.id)
    await vi.waitFor(() => expect(writeSendPrompt).toHaveBeenCalledOnce())
    expect(() =>
      ops.cancelTask(workspace.id, dispatch.id, {
        fromAgentId: orchestrator.id,
        reason: 'Changed direction',
      })
    ).toThrowError(
      expect.objectContaining({ code: 'dispatch_delivery_in_progress', statusCode: 409 })
    )
    expect(markDispatchCancelled).not.toHaveBeenCalled()

    finishDelivery?.(true)
    await expect(activation).resolves.toMatchObject({ id: dispatch.id, status: 'submitted' })
    expect(markQueuedDispatchActivated).toHaveBeenCalledWith(workspace.id, dispatch.id, [])
    await store.close()
  })

  test('reportTask does not write a message or orchestrator stdin when Dispatch persistence fails', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice' })
    const dispatch = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: `${workspace.id}:orchestrator`,
      id: 'dispatch-1',
      reportedAt: null,
      reportText: null,
      sequence: 1,
      status: 'submitted',
      submittedAt: Date.now(),
      text: 'Implement login',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    } as const
    const insertMessage = vi.fn()
    const writeReportPrompt = vi.fn()

    const ops = createTeamOperations({
      ...dispatchNoteDependencies(),
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        writeReportPrompt,
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findIdempotentReport: vi.fn(),
      findOpenDispatch: vi.fn(() => dispatch),
      findSubmittedDispatch: vi.fn(() => dispatch),
      findPendingDispatchNote: vi.fn(),
      insertMessage,
      markDispatchReportedByWorker: vi.fn(() => {
        throw new Error('dispatch ledger failed')
      }),
      markDispatchSubmitted: vi.fn(),
      workspaceStore: {
        getWorker: store.getWorker,
      } as never,
    })

    expect(() =>
      ops.reportTask(workspace.id, worker.id, {
        outcome: 'completed',
        requestId: 'report-request-1',
        text: 'Done',
      })
    ).toThrow(/dispatch ledger failed/)

    expect(writeReportPrompt).not.toHaveBeenCalled()
    expect(insertMessage).not.toHaveBeenCalled()
  })

  test('reportTask records an outcome without synchronously writing orchestrator stdin', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice' })
    const dispatch = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: `${workspace.id}:orchestrator`,
      id: 'dispatch-1',
      reportedAt: null,
      reportText: null,
      sequence: 1,
      status: 'submitted',
      submittedAt: Date.now(),
      text: 'Implement login',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    } as const
    const reportedDispatch = {
      ...dispatch,
      reportOutcome: 'completed' as const,
      reportRequestId: 'report-request-1',
      reportText: 'Done',
      status: 'reported' as const,
    }
    const markDispatchReportedByWorker = vi.fn(() => reportedDispatch)
    const insertMessage = vi.fn(() => ({ sequence: 1 }))
    const writeReportPrompt = vi.fn(() => {
      throw new Error('orchestrator stdin must not be used')
    })

    const ops = createTeamOperations({
      ...dispatchNoteDependencies(),
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        writeReportPrompt,
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findIdempotentReport: vi.fn(),
      findOpenDispatch: vi.fn(() => dispatch),
      findSubmittedDispatch: vi.fn(() => dispatch),
      findPendingDispatchNote: vi.fn(),
      insertMessage,
      markDispatchReportedByWorker,
      markDispatchSubmitted: vi.fn(),
      workspaceStore: {
        getWorker: store.getWorker,
      } as never,
    })

    const result = ops.reportTask(workspace.id, worker.id, {
      outcome: 'completed',
      requestId: 'report-request-1',
      text: 'Done',
    })

    expect(markDispatchReportedByWorker).toHaveBeenCalledWith({
      artifacts: [],
      outcome: 'completed',
      reportText: 'Done',
      requestId: 'report-request-1',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
    expect(insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        text: 'Done',
        type: 'report',
      })
    )
    expect(writeReportPrompt).not.toHaveBeenCalled()
    expect(result).toEqual({
      dispatch: reportedDispatch,
      forwardError: null,
      forwarded: false,
    })
  })
})
