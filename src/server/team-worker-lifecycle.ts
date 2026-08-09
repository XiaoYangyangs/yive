import type { AgentIdentity, AgentRuntimeState } from '../shared/types.js'
import type { AgentStopResult } from './agent-runtime-contract.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { HttpError, InternalServerError } from './http-errors.js'

type WorkerLifecycleCommand = 'restart' | 'start'

interface TeamWorkerLifecycleDependencies {
  getActiveRun: (workspaceId: string, agentId: string) => LiveAgentRun | undefined
  getAgent: (workspaceId: string, agentId: string) => AgentIdentity
  getAgentState: (workspaceId: string, agentId: string) => AgentRuntimeState
  getQueuePauseReason: (workspaceId: string, workerId: string) => string | null
  getSavedSessionId: (workspaceId: string, agentId: string) => string | null
  getWorker: (workspaceId: string, workerId: string) => AgentIdentity
  hasRecoveryContext: (workspaceId: string, agentId: string) => boolean
  runExclusive: <T>(workspaceId: string, workerId: string, task: () => Promise<T>) => Promise<T>
  sessionVerificationTimeoutMs: number
  resumeWorkerQueue: (workspaceId: string, workerId: string) => void
  startAgent: (
    workspaceId: string,
    agentId: string,
    input: { hivePort: string }
  ) => Promise<LiveAgentRun>
  stopAgentRun: (
    workspaceId: string,
    workerId: string,
    runId: string,
    mode: 'force' | 'safe'
  ) => Promise<AgentStopResult>
}

const waitForPoll = (delayMs: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs)
    timer.unref()
  })

export const createTeamWorkerLifecycle = ({
  getActiveRun,
  getAgent,
  getAgentState,
  getQueuePauseReason,
  getSavedSessionId,
  getWorker,
  hasRecoveryContext,
  runExclusive,
  sessionVerificationTimeoutMs,
  resumeWorkerQueue,
  startAgent,
  stopAgentRun,
}: TeamWorkerLifecycleDependencies) => {
  const waitForResumedSession = async (
    workspaceId: string,
    workerId: string,
    runId: string,
    expectedSessionId: string
  ) => {
    const deadline = Date.now() + sessionVerificationTimeoutMs
    while (Date.now() <= deadline) {
      const run = getActiveRun(workspaceId, workerId)
      if (!run || run.runId !== runId) return false
      if (run.stopping || run.status === 'error' || run.status === 'exited') return false
      if (run.sessionId) return run.sessionId === expectedSessionId
      await waitForPoll(50)
    }
    return false
  }

  const isolateStartedRun = async (workspaceId: string, workerId: string, runId: string) => {
    const result = await stopAgentRun(workspaceId, workerId, runId, 'force')
    if (result.state !== 'stopped') {
      throw new HttpError(
        409,
        'The unverified Worker process could not be isolated',
        'worker_lifecycle_failed'
      )
    }
    const deadline = Date.now() + sessionVerificationTimeoutMs
    while (Date.now() <= deadline) {
      if (getAgentState(workspaceId, workerId).processState !== 'running') return
      await waitForPoll(50)
    }
    throw new HttpError(
      409,
      'The unverified Worker process did not stop before the lifecycle timeout',
      'worker_lifecycle_failed'
    )
  }

  const isolateUnexpectedStartFailure = async (
    workspaceId: string,
    workerId: string,
    runId: string,
    message: string,
    code: string,
    cause: unknown
  ): Promise<never> => {
    try {
      await isolateStartedRun(workspaceId, workerId, runId)
    } catch (isolationError) {
      throw new InternalServerError(
        message,
        code,
        new AggregateError([cause, isolationError], `${message}; isolation also failed`)
      )
    }
    throw new InternalServerError(message, code, cause)
  }

  const waitForPostStartRecovery = (run: LiveAgentRun) =>
    run.postStartRecovery
      ? Promise.race([
          run.postStartRecovery,
          waitForPoll(sessionVerificationTimeoutMs).then(() => false),
        ])
      : Promise.resolve(false)

  const requiresVerifiedRecovery = (
    workspaceId: string,
    agentId: string,
    state: AgentRuntimeState
  ) =>
    getSavedSessionId(workspaceId, agentId) !== null ||
    state.activeDispatchId !== null ||
    state.queuedDispatchCount > 0 ||
    state.queuePauseReason !== null ||
    hasRecoveryContext(workspaceId, agentId)

  const startWithVerifiedRecovery = async (
    workspaceId: string,
    agent: AgentIdentity,
    hivePort: string,
    requireSavedSession: boolean
  ) => {
    const expectedSessionId = getSavedSessionId(workspaceId, agent.id)
    const initialState = getAgentState(workspaceId, agent.id)
    const recoveryRequired =
      requireSavedSession || requiresVerifiedRecovery(workspaceId, agent.id, initialState)
    if (recoveryRequired && !expectedSessionId && agent.kind === 'worker') {
      throw new HttpError(
        409,
        `Agent ${agent.name} recovery requires a saved Provider Session`,
        'worker_session_unverified'
      )
    }

    const run = await startAgent(workspaceId, agent.id, { hivePort })
    const processState = getAgentState(workspaceId, agent.id).processState
    if (run.status === 'error' || processState !== 'running') {
      throw new HttpError(409, `Agent ${agent.name} failed to start`, 'worker_lifecycle_failed')
    }
    const resumeCrashedWorkerQueue = async () => {
      if (
        agent.kind !== 'worker' ||
        getQueuePauseReason(workspaceId, agent.id) !== 'worker_crashed'
      ) {
        return
      }
      try {
        resumeWorkerQueue(workspaceId, agent.id)
      } catch (error) {
        return isolateUnexpectedStartFailure(
          workspaceId,
          agent.id,
          run.runId,
          `Worker ${agent.name} recovery could not resume its Dispatch queue`,
          'worker_queue_resume_failed',
          error
        )
      }
    }
    if (!recoveryRequired) return run

    const resumedExpectedSession = run.resumedSessionId === expectedSessionId
    if (
      expectedSessionId !== null &&
      (!resumedExpectedSession ||
        !(await waitForResumedSession(workspaceId, agent.id, run.runId, expectedSessionId)))
    ) {
      await isolateStartedRun(workspaceId, agent.id, run.runId)
      throw new HttpError(
        409,
        `Agent ${agent.name} recovery could not verify the resumed Provider Session`,
        'worker_session_unverified'
      )
    }

    let recovered = false
    try {
      recovered = (await waitForPostStartRecovery(run)) === true
    } catch (error) {
      return isolateUnexpectedStartFailure(
        workspaceId,
        agent.id,
        run.runId,
        `Agent ${agent.name} recovery failed unexpectedly`,
        'worker_recovery_failed',
        error
      )
    }
    if (!recovered) {
      await isolateStartedRun(workspaceId, agent.id, run.runId)
      throw new HttpError(
        409,
        `Agent ${agent.name} recovery Context could not be delivered`,
        'worker_lifecycle_failed'
      )
    }
    await resumeCrashedWorkerQueue()
    return run
  }

  return {
    recover(workspaceId: string, agentId: string, input: { hivePort: string }) {
      return runExclusive(workspaceId, agentId, async () => {
        const agent = getAgent(workspaceId, agentId)
        const state = getAgentState(workspaceId, agentId)
        if (state.processState === 'running') {
          throw new HttpError(
            409,
            `Agent ${agent.name} cannot be started while its process is running`,
            'worker_lifecycle_conflict'
          )
        }
        return startWithVerifiedRecovery(workspaceId, agent, input.hivePort, false)
      })
    },
    start(
      workspaceId: string,
      workerId: string,
      input: { command: WorkerLifecycleCommand; hivePort: string }
    ) {
      return runExclusive(workspaceId, workerId, async () => {
        const worker = getWorker(workspaceId, workerId)
        const initialState = getAgentState(workspaceId, workerId)
        const allowed =
          input.command === 'start'
            ? initialState.processState === 'stopped'
            : initialState.processState !== 'running'
        if (!allowed) {
          throw new HttpError(
            409,
            `Worker ${worker.name} cannot be ${input.command}ed while its process is ${initialState.processState}`,
            'worker_lifecycle_conflict'
          )
        }

        if (
          input.command === 'start' &&
          requiresVerifiedRecovery(workspaceId, workerId, initialState)
        ) {
          throw new HttpError(
            409,
            `Worker ${worker.name} has recoverable state; use team restart`,
            'worker_lifecycle_conflict'
          )
        }
        if (input.command === 'restart') {
          return startWithVerifiedRecovery(workspaceId, worker, input.hivePort, true)
        }

        const run = await startAgent(workspaceId, workerId, { hivePort: input.hivePort })
        const processState = getAgentState(workspaceId, workerId).processState
        if (run.status === 'error' || processState !== 'running') {
          throw new HttpError(
            409,
            `Worker ${worker.name} failed to ${input.command}`,
            'worker_lifecycle_failed'
          )
        }
        return run
      })
    },
    stop(workspaceId: string, workerId: string) {
      return runExclusive(workspaceId, workerId, async () => {
        const worker = getWorker(workspaceId, workerId)
        const state = getAgentState(workspaceId, workerId)
        if (state.processState !== 'running') {
          throw new HttpError(
            409,
            `Worker ${worker.name} cannot be stopped while its process is ${state.processState}`,
            'worker_lifecycle_conflict'
          )
        }
        if (state.activeDispatchId || state.queuedDispatchCount > 0) {
          throw new HttpError(
            409,
            `Worker ${worker.name} cannot be stopped while it owns Dispatch work`,
            'worker_lifecycle_conflict'
          )
        }
        if (state.conversationActivity !== 'idle') {
          throw new HttpError(
            409,
            `Worker ${worker.name} conversation is ${state.conversationActivity}`,
            state.conversationActivity === 'busy'
              ? 'worker_conversation_busy'
              : 'worker_conversation_unknown'
          )
        }
        const run = getActiveRun(workspaceId, workerId)
        if (!run) {
          throw new HttpError(
            409,
            `Worker ${worker.name} has no active process to stop`,
            'worker_lifecycle_conflict'
          )
        }
        const result = await stopAgentRun(workspaceId, workerId, run.runId, 'safe')
        if (result.state !== 'stopped') {
          throw new HttpError(
            409,
            `Worker ${worker.name} could not be stopped safely: ${result.reason ?? result.state}`,
            'worker_stop_blocked'
          )
        }
        return result
      })
    },
  }
}
