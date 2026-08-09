import type { AgentIdentity } from '../shared/types.js'
import { HttpError } from './http-errors.js'
import { commandAllowedForKind, type TeamCommand } from './team-command-registry.js'

export { commandAllowedForKind, type TeamCommand } from './team-command-registry.js'

interface AuthenticateInput {
  fromAgentId: string | undefined
  getAgent: (workspaceId: string, agentId: string) => AgentIdentity
  token: string | undefined
  validateToken: (agentId: string, token: string | undefined) => boolean
  workspaceId: string
}

export const authenticateCliAgent = ({
  fromAgentId,
  getAgent,
  token,
  validateToken,
  workspaceId,
}: AuthenticateInput): AgentIdentity => {
  if (!fromAgentId) {
    throw new HttpError(401, 'Missing agent identity', 'unauthorized')
  }
  if (!validateToken(fromAgentId, token)) {
    throw new HttpError(401, 'Invalid or missing agent token', 'unauthorized')
  }
  let agent: AgentIdentity
  try {
    agent = getAgent(workspaceId, fromAgentId)
  } catch {
    throw new HttpError(401, 'Agent not found in workspace', 'unauthorized')
  }
  return agent
}

export const requireCommandForKind = (agent: AgentIdentity, command: TeamCommand) => {
  if (!commandAllowedForKind(agent.kind, command)) {
    throw new HttpError(
      403,
      `${agent.kind === 'orchestrator' ? 'Orchestrator' : 'Worker'} is not allowed to run team ${command}`,
      'team_command_forbidden'
    )
  }
}
