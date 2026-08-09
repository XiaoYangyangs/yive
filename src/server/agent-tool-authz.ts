import type { AgentIdentity } from '../shared/types.js'
import { type AgentTool, agentToolAllowedForKind } from './agent-tool-registry.js'
import { HttpError } from './http-errors.js'

export const requireAgentToolForKind = (agent: AgentIdentity, tool: AgentTool) => {
  if (!agentToolAllowedForKind(agent.kind, tool)) {
    throw new HttpError(
      403,
      `${agent.kind === 'orchestrator' ? 'Orchestrator' : 'Worker'} is not allowed to run yive agent ${tool}`,
      'agent_tool_forbidden'
    )
  }
}
