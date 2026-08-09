import type { AgentRunSnapshot } from './agent-manager.js'
import type { PersistAgentRunExitInput } from './agent-run-start-context.js'
import type { SessionIdCaptureConfig } from './session-capture.js'

export interface LiveAgentRun extends AgentRunSnapshot {
  /** The process ended, but its final durable state must be reconciled on Runtime restart. */
  persistenceFailed?: boolean
  /** Exit state retained for an explicit in-process persistence retry. */
  pendingExitPersistence?: PersistAgentRunExitInput
  /** Completion of the bounded Runtime Context delivery for this process restart. */
  postStartRecovery?: Promise<boolean>
  /** Session currently owned by this PTY, whether resumed or captured after spawn. */
  sessionId?: string
  /** Provider-native source fixed when this PTY run starts. */
  sessionCapture?: SessionIdCaptureConfig
  resumedSessionId?: string
  startedAt: number
  stopping?: boolean
}
