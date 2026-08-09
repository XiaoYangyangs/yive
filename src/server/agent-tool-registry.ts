import type { AgentIdentity } from '../shared/types.js'

export type AgentTool = 'help' | 'notify' | 'send-file'

interface AgentToolDefinition {
  allowedKinds: readonly AgentIdentity['kind'][]
  effects?: readonly string[]
  errors?: readonly string[]
  example?: string
  hidden?: boolean
  name: AgentTool
  summary: string
  usage?: string
}

const AUTH_ERRORS = [
  '401 unauthorized - the Agent identity or token is missing or invalid.',
  '403 agent_tool_forbidden - the authenticated identity cannot use this tool.',
] as const

export const AGENT_TOOL_REGISTRY: readonly AgentToolDefinition[] = [
  {
    allowedKinds: ['orchestrator'],
    effects: [
      'Creates the existing Yive in-app/mobile notification for the current Workspace.',
      'An optional image must be a validated Workspace-relative Artifact.',
    ],
    errors: [
      ...AUTH_ERRORS,
      '400 bad_request - the title, body, or image Artifact is invalid.',
      '413 payload_too_large - the image exceeds the Artifact size policy.',
    ],
    example: 'yive agent notify "Build done" --body "Open the Files tab"',
    name: 'notify',
    summary: 'Notify the user from the Orchestrator.',
    usage: 'yive agent notify <title> --body <text> [--image <artifact>] [--json]',
  },
  {
    allowedKinds: ['orchestrator', 'worker'],
    effects: [
      'Copies one validated Workspace Artifact into temporary mobile file transport.',
      'Does not delete, execute, or silently preview the Workspace file.',
    ],
    errors: [
      ...AUTH_ERRORS,
      '400 bad_request - the Artifact path, type, or content is invalid.',
      '413 payload_too_large - the Artifact exceeds the size policy.',
    ],
    example: 'yive agent send-file dist/report.pdf',
    name: 'send-file',
    summary: 'Send a Workspace Artifact to the mobile Files tab.',
    usage: 'yive agent send-file <artifact> [--json]',
  },
  {
    allowedKinds: ['orchestrator', 'worker'],
    hidden: true,
    name: 'help',
    summary: 'Show role-aware Agent tool help.',
  },
]

const definitions = new Map(AGENT_TOOL_REGISTRY.map((definition) => [definition.name, definition]))

export const agentToolAllowedForKind = (kind: AgentIdentity['kind'], tool: AgentTool) =>
  definitions.get(tool)?.allowedKinds.includes(kind) === true

export const getAgentTool = (tool: string) => definitions.get(tool as AgentTool)

export const renderAgentToolHelp = (kind: AgentIdentity['kind'], tool: AgentTool) => {
  const definition = definitions.get(tool)
  if (
    !definition ||
    definition.hidden ||
    !definition.allowedKinds.includes(kind) ||
    !definition.usage ||
    !definition.effects ||
    !definition.errors ||
    !definition.example
  )
    return undefined
  return [
    `yive agent ${definition.name}`,
    '',
    'Syntax:',
    `  ${definition.usage}`,
    '',
    'Effects:',
    ...definition.effects.map((effect) => `  ${effect}`),
    '',
    'Common errors:',
    ...definition.errors.map((error) => `  ${error}`),
    '',
    'Example:',
    `  ${definition.example}`,
  ].join('\n')
}

export const renderAgentHelp = (kind: AgentIdentity['kind']) => {
  const identity = kind === 'orchestrator' ? 'Orchestrator' : 'Worker'
  const tools = AGENT_TOOL_REGISTRY.filter(
    (definition) => !definition.hidden && definition.allowedKinds.includes(kind)
  )
  const width = Math.max(...tools.map((definition) => definition.name.length))
  return [
    `Yive Agent tools for ${identity}`,
    '',
    ...tools.map((definition) => `  ${definition.name.padEnd(width)}  ${definition.summary}`),
    '',
    'Run `yive agent <tool> --help` for syntax, effects, errors, and an example.',
  ].join('\n')
}
