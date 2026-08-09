import type { AgentLaunchConfigInput } from './agent-run-store.js'
import {
  buildManagedProviderLaunchConfig,
  isManagedProvider,
  type ManagedProvider,
} from './managed-provider.js'
import { getOrchestratorId } from './workspace-store-support.js'

interface ConfigurePort {
  configureAgentLaunch: (
    workspaceId: string,
    agentId: string,
    input: AgentLaunchConfigInput
  ) => void
  peekAgentLaunchConfig: (
    workspaceId: string,
    agentId: string
  ) => AgentLaunchConfigInput | undefined
}

export const resolveOrchestratorLaunchConfig = (
  provider: ManagedProvider
): AgentLaunchConfigInput | undefined => {
  return buildManagedProviderLaunchConfig(provider)
}

/**
 * Idempotent: only seeds when no existing launch config is present for the
 * orchestrator (prevents stomping on user-customized configs across restarts).
 */
export const seedOrchestratorLaunchConfig = (
  port: ConfigurePort,
  workspaceId: string,
  provider: ManagedProvider
): void => {
  const orchestratorId = getOrchestratorId(workspaceId)
  if (port.peekAgentLaunchConfig(workspaceId, orchestratorId)) return
  if (!isManagedProvider(provider)) return
  const config = resolveOrchestratorLaunchConfig(provider)
  if (!config) return
  port.configureAgentLaunch(workspaceId, orchestratorId, config)
}
