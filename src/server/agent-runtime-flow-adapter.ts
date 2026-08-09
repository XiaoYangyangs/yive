import { type AgentManager, AgentRunNotFoundError } from './agent-manager.js'
import type { PtyOutputBus } from './pty-output-bus.js'

interface FlowAdapterManager {
  getOutputBus: () => PtyOutputBus
  pauseRun: (runId: string) => void
  resizeRun: (runId: string, cols: number, rows: number) => void
  resumeRun: (runId: string) => void
}

export const createAgentRuntimeFlowAdapter = (
  requireManager: () => AgentManager
): FlowAdapterManager => ({
  getOutputBus() {
    return requireManager().getOutputBus()
  },
  pauseRun(runId) {
    try {
      requireManager().pauseRun(runId)
    } catch (error) {
      if (error instanceof AgentRunNotFoundError) return
      throw error
    }
  },
  resizeRun(runId, cols, rows) {
    try {
      requireManager().resizeRun(runId, cols, rows)
    } catch (error) {
      if (error instanceof AgentRunNotFoundError) return
      throw error
    }
  },
  resumeRun(runId) {
    try {
      requireManager().resumeRun(runId)
    } catch (error) {
      if (error instanceof AgentRunNotFoundError) return
      throw error
    }
  },
})
