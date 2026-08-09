import type { AgentIdentity, WorkspaceSummary } from '../shared/types.js'

const toSingleLine = (value: string) =>
  value
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()

export const buildYiveAgentNameContractLine = (agent: Pick<AgentIdentity, 'name'>) =>
  `Agent name: ${toSingleLine(agent.name)}`

export const buildYiveStartupContract = ({
  agent,
  workspace,
}: {
  agent: AgentIdentity
  workspace: WorkspaceSummary
}) => {
  const kind = agent.kind === 'orchestrator' ? 'Orchestrator' : 'Worker'
  const responsibility =
    kind === 'Orchestrator'
      ? 'Coordinate durable work through the flat set of Yive Workers.'
      : 'Your durable responsibility is only the current Dispatch assigned by the Orchestrator.'

  return [
    'Yive managed Agent contract',
    buildYiveAgentNameContractLine(agent),
    `Agent kind: ${kind}`,
    `Workspace root: ${toSingleLine(workspace.path)}`,
    'Default write boundary: You may read outside the Workspace when required by toolchains. Modify files outside the Workspace only when the user explicitly names and authorizes the path.',
    `Authority boundary: Yive has exactly one Orchestrator and a flat set of Workers. ${responsibility}`,
    'Provider Subagent boundary: Provider Subagents may assist only within the calling Agent turn. The calling Yive Agent retains responsibility. Durable, independently recoverable work belongs to a Yive Worker.',
    'Discovery entry points: `team --help`, `team context`, and `yive agent --help`.',
  ].join('\n')
}
