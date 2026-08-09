import { type AgentManager, AgentRunNotFoundError } from './agent-manager.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { LiveRunRegistry } from './live-run-registry.js'

const CLOSE_EXIT_WAIT_MS = 2500

const waitForExitEntries = async (entries: Array<{ promise: Promise<void> }>) => {
  if (entries.length === 0) return
  await Promise.race([
    Promise.all(entries.map((entry) => entry.promise)),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_EXIT_WAIT_MS)
      timer.unref?.()
    }),
  ])
}

export const closeAgentRuntime = async (
  agentManager: AgentManager | undefined,
  registry: LiveRunRegistry,
  syncRun: (run: LiveAgentRun) => LiveAgentRun
) => {
  const runs = registry.list()
  for (const run of runs) {
    let syncedRun = run
    try {
      syncedRun = syncRun(run)
    } catch (error) {
      if (!(error instanceof AgentRunNotFoundError)) throw error
      registry.resolveExit(run.runId)
      continue
    }
    if (syncedRun.status === 'exited' || syncedRun.status === 'error') {
      registry.resolveExit(syncedRun.runId)
      continue
    }
    run.stopping = true
    agentManager?.stopRun(run.runId)
  }

  await waitForExitEntries(registry.listExitEntries())

  for (const run of registry.list()) {
    let syncedRun = run
    try {
      syncedRun = syncRun(run)
    } catch (error) {
      if (!(error instanceof AgentRunNotFoundError)) throw error
      registry.resolveExit(run.runId)
    }
    if (syncedRun.status === 'exited' || syncedRun.status === 'error') {
      registry.resolveExit(syncedRun.runId)
    }
    agentManager?.removeRun(run.runId)
    registry.remove(run.runId)
  }
}
