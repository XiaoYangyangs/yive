import { randomUUID } from 'node:crypto'

import type { MobileConversationPage } from '../shared/types.js'
import type { createActiveConversationObserver } from './active-conversation-observer.js'
import { normalizeArtifactReferences } from './artifact-reference.js'
import { normalizeDispatchArtifactReferences } from './dispatch-note-validation.js'
import {
  DispatchInterruptionBlockedError,
  DispatchReplacementBlockedError,
  ForbiddenError,
  InternalServerError,
  NoOpenDispatchError,
  PtyInactiveError,
  ReplacementRequiresInterruptError,
} from './http-errors.js'
import type { RuntimeStoreServices } from './runtime-store-helpers.js'
import type {
  CancelTaskInput,
  ReplaceTaskInput,
  ReplaceTaskResult,
  ReportTaskResult,
} from './team-operations.js'

export interface ProviderInputBoundary {
  conversationId: string
  sourceCheckpoint: number
}

interface DispatchLifecycleCoordinatorOptions {
  armProviderInputBoundary: (
    workspaceId: string,
    agentId: string,
    boundary: ProviderInputBoundary | undefined
  ) => void
  conversationObserver: Pick<
    ReturnType<typeof createActiveConversationObserver>,
    'getCurrentConversation'
  >
  interruptionPollMs: number
  interruptionTimeoutMs: number
  runDataMutation: <T>(mutation: () => T) => T
  runDispatchTask: <T>(workspaceId: string, workerId: string, task: () => Promise<T>) => Promise<T>
  services: RuntimeStoreServices
  toProviderInputBoundary: (
    conversation: Pick<MobileConversationPage, 'id' | 'source_checkpoint' | 'stale'>
  ) => ProviderInputBoundary | undefined
}

export const createDispatchLifecycleCoordinator = ({
  armProviderInputBoundary,
  conversationObserver,
  interruptionPollMs,
  interruptionTimeoutMs,
  runDataMutation,
  runDispatchTask,
  services,
  toProviderInputBoundary,
}: DispatchLifecycleCoordinatorOptions) => {
  const delay = (durationMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, durationMs))

  const readVerifiedConversationActivity = (
    workspaceId: string,
    workerId: string,
    expectedSessionId?: string | null
  ) => {
    const run = services.agentRuntime.getActiveRunByAgentId(workspaceId, workerId)
    const conversation = conversationObserver.getCurrentConversation(workspaceId, workerId, 30, {
      bypassDetectionCache: true,
    })
    const sessionId = run?.sessionId ?? null
    if (
      !sessionId ||
      (expectedSessionId && sessionId !== expectedSessionId) ||
      !conversation ||
      conversation.stale ||
      conversation.cli_session_id !== sessionId
    ) {
      return { activity: 'unknown' as const, sessionId }
    }
    return { activity: conversation.activity_state, sessionId }
  }

  const waitForSessionBoundary = async (
    workspaceId: string,
    workerId: string,
    sessionId: string,
    deadline: number
  ) => {
    let state = readVerifiedConversationActivity(workspaceId, workerId, sessionId)
    while (state.activity === 'busy' && Date.now() < deadline) {
      await delay(Math.min(interruptionPollMs, Math.max(1, deadline - Date.now())))
      state = readVerifiedConversationActivity(workspaceId, workerId, sessionId)
    }
    return state
  }

  const interruptCurrentTurn = (workspaceId: string, workerId: string) => {
    try {
      services.agentRuntime.interruptCurrentTurn(workspaceId, workerId)
      return null
    } catch (error) {
      if (error instanceof PtyInactiveError) return error.message
      throw new InternalServerError(
        'Provider current-turn interruption failed',
        'dispatch_interruption_failed',
        error
      )
    }
  }

  const interruptPersistedDispatch = async (
    workspaceId: string,
    workerId: string,
    dispatchId: string,
    requestId: string
  ): Promise<string | null> => {
    let operation = services.dispatchLedgerStore.findDispatchById(workspaceId, dispatchId)
    const sessionId = operation?.operationSessionId
    if (!operation || !sessionId) return 'Provider activity or Session is not verifiable'

    while (true) {
      const boundary = readVerifiedConversationActivity(workspaceId, workerId, sessionId)
      if (boundary.activity === 'idle') return null
      if (boundary.activity !== 'busy') return 'Provider activity or Session became unknown'

      if (operation.operationAttempts === 0) {
        operation = runDataMutation(() =>
          services.dispatchLedgerStore.recordInterruptionAttempt(workspaceId, dispatchId, requestId)
        )
        if (!operation) return 'Interruption attempt could not be persisted'
        const interruptionError = interruptCurrentTurn(workspaceId, workerId)
        if (interruptionError) return interruptionError
      }

      const deadline = (operation.operationUpdatedAt ?? Date.now()) + interruptionTimeoutMs
      const observed = await waitForSessionBoundary(workspaceId, workerId, sessionId, deadline)
      if (observed.activity === 'idle') return null
      if (observed.activity !== 'busy') return 'Provider activity or Session became unknown'
      if (operation.operationAttempts >= 2) {
        return 'Provider remained busy after two interruption attempts'
      }
      operation = runDataMutation(() =>
        services.dispatchLedgerStore.recordInterruptionAttempt(workspaceId, dispatchId, requestId)
      )
      if (!operation) return 'Interruption retry could not be persisted'
      const interruptionError = interruptCurrentTurn(workspaceId, workerId)
      if (interruptionError) return interruptionError
    }
  }

  const cancelTask = async (
    workspaceId: string,
    dispatchId: string,
    input: CancelTaskInput
  ): Promise<ReportTaskResult> => {
    const actor = services.workspaceStore.getAgent(workspaceId, input.fromAgentId)
    if (actor.kind !== 'orchestrator') {
      throw new ForbiddenError('Only the Orchestrator can cancel a Dispatch')
    }
    const requestInput = { ...input, requestId: input.requestId ?? randomUUID() }
    const initial = services.dispatchLedgerStore.findDispatchById(workspaceId, dispatchId)
    if (!initial || initial.status === 'queued' || initial.status === 'cancelled') {
      return runDataMutation(() =>
        services.teamOps.cancelTask(workspaceId, dispatchId, requestInput)
      )
    }
    const worker = services.workspaceStore.getWorker(workspaceId, initial.toAgentId)
    return runDispatchTask(workspaceId, worker.id, async () => {
      const finish = () =>
        runDataMutation(() => {
          const result = services.teamOps.cancelTask(workspaceId, dispatchId, requestInput)
          services.workerQueueStateStore.pause(workspaceId, worker.id, input.reason)
          return result
        })
      const current = readVerifiedConversationActivity(workspaceId, worker.id)
      if (current.activity === 'idle') return finish()

      const operation = runDataMutation(() =>
        services.dispatchLedgerStore.beginCancellation({
          dispatchId,
          reason: input.reason,
          requestId: requestInput.requestId,
          sessionId: current.sessionId,
          workspaceId,
        })
      )
      if (!operation) {
        return services.teamOps.cancelTask(workspaceId, dispatchId, requestInput)
      }
      const block = (reason: string): never => {
        runDataMutation(() =>
          services.dispatchLedgerStore.markOperationBlocked(
            workspaceId,
            dispatchId,
            requestInput.requestId,
            reason
          )
        )
        throw new DispatchInterruptionBlockedError(dispatchId, reason)
      }
      const sessionId = operation.operationSessionId
      if (current.activity !== 'busy' || !sessionId || current.sessionId !== sessionId) {
        block('Provider activity or Session is not verifiable')
      }
      const interruptionError = await interruptPersistedDispatch(
        workspaceId,
        worker.id,
        dispatchId,
        requestInput.requestId
      )
      if (interruptionError) block(interruptionError)
      return finish()
    })
  }

  const replaceTask = async (
    workspaceId: string,
    dispatchId: string,
    input: ReplaceTaskInput
  ): Promise<ReplaceTaskResult> => {
    const actor = services.workspaceStore.getAgent(workspaceId, input.fromAgentId)
    if (actor.kind !== 'orchestrator') {
      throw new ForbiddenError('Only the Orchestrator can replace a Dispatch')
    }
    const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
    const lexicalArtifacts = normalizeArtifactReferences(input.artifacts ?? [])
    const replacementInput = {
      ...input,
      artifacts: lexicalArtifacts,
      resolveArtifacts: () =>
        normalizeDispatchArtifactReferences({
          artifacts: lexicalArtifacts,
          workspacePath: workspace.summary.path,
        }),
    }
    const initial = services.dispatchLedgerStore.findDispatchById(workspaceId, dispatchId)
    const operationReplay = services.dispatchLedgerStore.findIdempotentReplacement({
      ...replacementInput,
      dispatchId,
      interrupt: input.interrupt === true,
      operationState:
        initial?.operationState === 'waiting_for_idle'
          ? 'waiting_for_idle'
          : 'delivering_replacement',
      sessionId: initial?.operationSessionId ?? null,
      workspaceId,
    })
    if (
      initial?.status === 'replaced' &&
      initial.operationKind === 'replace' &&
      initial.operationRequestId
    ) {
      if (!operationReplay) throw new NoOpenDispatchError(`No active dispatch: ${dispatchId}`)
      return operationReplay
    }
    if (!initial || initial.status === 'queued' || initial.status === 'replaced') {
      return runDataMutation(() =>
        services.teamOps.replaceTask(workspaceId, dispatchId, replacementInput)
      )
    }
    const resolvedReplacementInput = operationReplay
      ? { ...replacementInput, artifacts: operationReplay.dispatch.artifacts }
      : { ...replacementInput, artifacts: replacementInput.resolveArtifacts() }
    const worker = services.workspaceStore.getWorker(workspaceId, initial.toAgentId)
    return runDispatchTask(workspaceId, worker.id, async (): Promise<ReplaceTaskResult> => {
      const current = readVerifiedConversationActivity(workspaceId, worker.id)
      if (current.activity === 'busy' && !input.interrupt) {
        throw new ReplacementRequiresInterruptError(dispatchId)
      }
      let operation = runDataMutation(() =>
        services.dispatchLedgerStore.beginReplacement({
          ...resolvedReplacementInput,
          dispatchId,
          interrupt: input.interrupt === true,
          operationState:
            current.activity === 'idle' ? 'delivering_replacement' : 'waiting_for_idle',
          sessionId: current.sessionId,
          workspaceId,
        })
      )
      if (!operation) throw new NoOpenDispatchError(`No active dispatch: ${dispatchId}`)
      const block = (reason: string): never => {
        runDataMutation(() =>
          services.dispatchLedgerStore.markOperationBlocked(
            workspaceId,
            dispatchId,
            input.requestId,
            reason
          )
        )
        throw new DispatchReplacementBlockedError(dispatchId, reason)
      }
      if (operation.replacedDispatch.operationState === 'completed') return operation
      const sessionId = operation.replacedDispatch.operationSessionId
      if (!sessionId || current.sessionId !== sessionId) {
        block('Provider activity or Session is not verifiable')
      }
      if (current.activity === 'busy') {
        const interruptionError = await interruptPersistedDispatch(
          workspaceId,
          worker.id,
          dispatchId,
          input.requestId
        )
        if (interruptionError) block(interruptionError)
      } else if (current.activity !== 'idle') {
        block('Provider activity or Session is not verifiable')
      }
      if (operation.replacedDispatch.operationState !== 'delivering_replacement') {
        const delivering = runDataMutation(() =>
          services.dispatchLedgerStore.markReplacementDelivering(
            workspaceId,
            dispatchId,
            input.requestId
          )
        )
        if (!delivering) return block('Replacement delivery state could not be persisted')
        operation = { ...operation, replacedDispatch: delivering }
      }
      const conversation = conversationObserver.getCurrentConversation(
        workspaceId,
        worker.id,
        100,
        { bypassDetectionCache: true }
      )
      const alreadyObserved =
        conversation &&
        !conversation.stale &&
        conversation.cli_session_id === sessionId &&
        conversation.turns.some(
          (turn) =>
            turn.role === 'user' && turn.text.includes(`dispatch_id: ${operation.dispatch.id}`)
        )
      let inputBoundary: ProviderInputBoundary | undefined
      if (!alreadyObserved) {
        const delivered = await services.agentRuntime.writeSendPrompt(
          workspaceId,
          worker.id,
          operation.dispatch.id,
          actor.name,
          operation.dispatch.text,
          operation.dispatch.artifacts,
          () => {
            const boundary = readVerifiedConversationActivity(workspaceId, worker.id, sessionId)
            const active = services.dispatchLedgerStore.findDispatchById(workspaceId, dispatchId)
            if (
              boundary.activity !== 'idle' ||
              active?.operationState !== 'delivering_replacement' ||
              active.pendingReplacementId !== operation.dispatch.id
            ) {
              return false
            }
            const ready = conversationObserver.getCurrentConversation(workspaceId, worker.id, 30, {
              bypassDetectionCache: true,
            })
            inputBoundary = ready ? toProviderInputBoundary(ready) : undefined
            return true
          }
        )
        if (!delivered) return block('Replacement delivery lost its verified idle boundary')
      }
      const completed = runDataMutation(() =>
        services.dispatchLedgerStore.completeReplacement(workspaceId, dispatchId, input.requestId)
      )
      if (!completed) return block('Replacement completion transaction did not commit')
      armProviderInputBoundary(workspaceId, worker.id, inputBoundary)
      return completed
    })
  }

  return { cancelTask, replaceTask }
}
