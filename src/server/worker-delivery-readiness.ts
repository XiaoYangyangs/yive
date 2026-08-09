import {
  AgentConversationConflictError,
  AgentProcessConflictError,
  WorkerQueuePausedError,
} from './http-errors.js'

const isExpectedWorkerDeliveryConflict = (error: unknown) =>
  error instanceof WorkerQueuePausedError ||
  error instanceof AgentProcessConflictError ||
  error instanceof AgentConversationConflictError

export const canDeliverToWorker = <T>(assertReady: () => T, onReady: (ready: T) => void) => {
  try {
    const ready = assertReady()
    onReady(ready)
    return true
  } catch (error) {
    if (isExpectedWorkerDeliveryConflict(error)) return false
    throw error
  }
}
