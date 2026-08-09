import type { PersistedAgentRun } from './agent-run-store.js'
import type { LiveRunRegistry } from './live-run-registry.js'

export const listRunsWithFallback = (
  registry: LiveRunRegistry,
  persistedRuns: PersistedAgentRun[],
  agentId: string
): PersistedAgentRun[] => {
  if (persistedRuns.length > 0) {
    return persistedRuns
  }

  return registry
    .list()
    .filter((run) => run.agentId === agentId)
    .map((run) => ({
      runId: run.runId,
      agentId,
      pid: run.pid,
      processState: (run.status === 'exited' || run.status === 'error'
        ? run.stopping
          ? 'stopped'
          : 'crashed'
        : 'running') as PersistedAgentRun['processState'],
      status: run.status,
      exitCode: run.exitCode,
      startedAt: run.startedAt,
      endedAt: run.status === 'exited' || run.status === 'error' ? Date.now() : null,
    }))
    .sort((left, right) => right.startedAt - left.startedAt)
}
