import type { AgentIdentity, WorkspaceSummary } from '../shared/types.js'

export const buildAgentSessionBindingMarkerFromIds = (workspaceId: string, agentId: string) =>
  `Hive session binding: workspace_id=${workspaceId}; agent_id=${agentId}`

export const buildAgentSessionBindingMarker = ({
  agent,
  workspace,
}: {
  agent: AgentIdentity
  workspace: WorkspaceSummary
}) => buildAgentSessionBindingMarkerFromIds(workspace.id, agent.id)

export const buildAgentLegacyIdentityMarker = ({
  agent,
  workspace,
}: {
  agent: AgentIdentity
  workspace: WorkspaceSummary
}) =>
  `You are ${agent.name}, the Yive ${agent.kind === 'orchestrator' ? 'Orchestrator' : 'Worker'} for ${workspace.name}.`
