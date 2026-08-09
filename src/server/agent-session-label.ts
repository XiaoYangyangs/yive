import type { AgentIdentity, WorkspaceSummary } from '../shared/types.js'

const MAX_LABEL_PART_LENGTH = 48

const compactLabelPart = (value: string) => {
  const compacted = value
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return compacted.length <= MAX_LABEL_PART_LENGTH
    ? compacted
    : `${compacted.slice(0, MAX_LABEL_PART_LENGTH - 1)}...`
}

export const buildAgentSessionLabel = ({
  agent,
  workspace,
}: {
  agent: AgentIdentity
  workspace: WorkspaceSummary
}) =>
  [
    'Yive',
    workspace.id.slice(0, 8),
    agent.id.slice(0, 8),
    compactLabelPart(workspace.name),
    compactLabelPart(agent.name),
  ].join(':')

export const buildAgentSessionDiscriminatorLabels = ({
  agent,
  workspace,
}: {
  agent: AgentIdentity
  workspace: WorkspaceSummary
}) => [buildAgentSessionLabel({ agent, workspace }), `agent_id=${agent.id}`]
