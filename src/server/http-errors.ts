export class HttpError extends Error {
  readonly code: string | undefined
  readonly statusCode: number

  constructor(statusCode: number, message: string, code?: string) {
    super(message)
    this.name = 'HttpError'
    this.code = code
    this.statusCode = statusCode
  }
}

export class PtyInactiveError extends HttpError {
  constructor(message: string) {
    super(409, message)
    this.name = 'PtyInactiveError'
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message: string) {
    super(401, message)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends HttpError {
  constructor(message: string) {
    super(403, message)
    this.name = 'ForbiddenError'
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string) {
    super(400, message)
    this.name = 'BadRequestError'
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(message: string) {
    super(413, message)
    this.name = 'PayloadTooLargeError'
  }
}

export class InternalServerError extends HttpError {
  readonly cause: unknown

  constructor(message: string, code: string, cause: unknown) {
    super(500, message, code)
    this.name = 'InternalServerError'
    this.cause = cause
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, message)
    this.name = 'ConflictError'
  }
}

export class ActiveDispatchConflictError extends HttpError {
  constructor(workerName: string, dispatchId: string) {
    super(
      409,
      `Worker ${workerName} already has active Dispatch ${dispatchId}`,
      'active_dispatch_exists'
    )
    this.name = 'ActiveDispatchConflictError'
  }
}

export class DispatchRequestConflictError extends HttpError {
  constructor(requestId: string) {
    super(
      409,
      `Dispatch request ${requestId} was already used with different content`,
      'dispatch_request_conflict'
    )
    this.name = 'DispatchRequestConflictError'
  }
}

export class DispatchOperationRequestConflictError extends HttpError {
  constructor(requestId: string) {
    super(
      409,
      `Dispatch operation request ${requestId} was already used with different content`,
      'dispatch_operation_request_conflict'
    )
    this.name = 'DispatchOperationRequestConflictError'
  }
}

export class DispatchOperationInProgressError extends HttpError {
  constructor(dispatchId: string) {
    super(
      409,
      `Dispatch ${dispatchId} already has a different lifecycle operation in progress`,
      'dispatch_operation_in_progress'
    )
    this.name = 'DispatchOperationInProgressError'
  }
}

export class DispatchInterruptionBlockedError extends HttpError {
  constructor(dispatchId: string, reason: string) {
    super(
      409,
      `Dispatch ${dispatchId} interruption is blocked: ${reason}`,
      'dispatch_interruption_blocked'
    )
    this.name = 'DispatchInterruptionBlockedError'
  }
}

export class ReplacementRequiresInterruptError extends HttpError {
  constructor(dispatchId: string) {
    super(
      409,
      `Dispatch ${dispatchId} is busy; replacement requires explicit --interrupt`,
      'replacement_requires_interrupt'
    )
    this.name = 'ReplacementRequiresInterruptError'
  }
}

export class DispatchReplacementBlockedError extends HttpError {
  constructor(dispatchId: string, reason: string) {
    super(
      409,
      `Dispatch ${dispatchId} replacement is blocked: ${reason}`,
      'dispatch_replacement_blocked'
    )
    this.name = 'DispatchReplacementBlockedError'
  }
}

export class ReportRequestConflictError extends HttpError {
  constructor(requestId: string) {
    super(
      409,
      `Report request ${requestId} was already used with different content`,
      'report_request_conflict'
    )
    this.name = 'ReportRequestConflictError'
  }
}

export class StatusRequestConflictError extends HttpError {
  constructor(requestId: string) {
    super(
      409,
      `Status request ${requestId} was already used with different content`,
      'status_request_conflict'
    )
    this.name = 'StatusRequestConflictError'
  }
}

export class WorkerQueuePausedError extends HttpError {
  constructor(workerName: string, reason: string) {
    super(
      409,
      `Worker ${workerName} queue is paused: ${reason}. Resume it before assigning more work`,
      'worker_queue_paused'
    )
    this.name = 'WorkerQueuePausedError'
  }
}

export class DispatchDeliveryInProgressError extends HttpError {
  constructor(dispatchId: string) {
    super(
      409,
      `Dispatch ${dispatchId} is currently being delivered; retry cancellation after delivery settles`,
      'dispatch_delivery_in_progress'
    )
    this.name = 'DispatchDeliveryInProgressError'
  }
}

export class AgentProcessConflictError extends HttpError {
  constructor(workerName: string, processState: 'crashed' | 'stopped') {
    super(
      409,
      `Worker ${workerName} process is ${processState}; start it before assigning work`,
      'agent_process_not_running'
    )
    this.name = 'AgentProcessConflictError'
  }
}

export class AgentConversationConflictError extends HttpError {
  constructor(workerName: string, activity: 'busy' | 'unknown') {
    super(
      409,
      `Worker ${workerName} conversation is ${activity}; immediate delivery requires verified idle`,
      activity === 'busy' ? 'agent_conversation_busy' : 'agent_conversation_unknown'
    )
    this.name = 'AgentConversationConflictError'
  }
}

export class ChatQueueCapacityError extends HttpError {
  constructor() {
    super(409, 'A conversation can have at most three queued submissions', 'chat_queue_capacity')
    this.name = 'ChatQueueCapacityError'
  }
}

export class NoOpenDispatchError extends HttpError {
  constructor(message: string) {
    super(409, message, 'no_open_dispatch')
    this.name = 'NoOpenDispatchError'
  }
}

export class NoActiveDispatchError extends HttpError {
  constructor(message: string) {
    super(409, message, 'no_active_dispatch')
    this.name = 'NoActiveDispatchError'
  }
}

export class DispatchNotePendingError extends HttpError {
  constructor(message: string) {
    super(409, message, 'dispatch_note_pending')
    this.name = 'DispatchNotePendingError'
  }
}

export class InvalidWorkerError extends HttpError {
  constructor(message: string) {
    super(400, message, 'invalid_worker')
    this.name = 'InvalidWorkerError'
  }
}

export class DataCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DataCorruptionError'
  }
}
