import type { AgentIdentity } from '../shared/types.js'

export type TeamCommand =
  | 'list'
  | 'context'
  | 'add'
  | 'start'
  | 'restart'
  | 'stop'
  | 'send'
  | 'note'
  | 'cancel'
  | 'replace'
  | 'queue'
  | 'status'
  | 'report'
  | 'help'

interface TeamCommandDefinition {
  allowedKinds: readonly AgentIdentity['kind'][]
  effects?: readonly string[]
  errors?: readonly string[]
  example?: string
  hidden?: boolean
  name: TeamCommand
  summary: string
  usage?: string
}

const AUTH_ERRORS = [
  '401 unauthorized - the Agent identity or token is missing or invalid.',
  '403 team_command_forbidden - the authenticated identity cannot use this command.',
] as const

export const TEAM_COMMAND_REGISTRY: readonly TeamCommandDefinition[] = [
  {
    allowedKinds: ['orchestrator', 'worker'],
    effects: ['Returns canonical Agent state for the current Workspace; changes no state.'],
    errors: AUTH_ERRORS,
    example: 'team list',
    name: 'list',
    summary: 'Show current Agent process, conversation, and Dispatch state.',
    usage: 'team list',
  },
  {
    allowedKinds: ['orchestrator', 'worker'],
    effects: [
      'Returns a bounded Runtime snapshot; focused queries reveal only authorized current facts.',
    ],
    errors: [
      ...AUTH_ERRORS,
      '400 invalid_context_focus - Worker and Dispatch focus cannot be combined.',
      '403 context_scope_forbidden - Workers can read only their own responsibility.',
      '404 context_target_not_found - the requested Worker or Dispatch does not exist.',
    ],
    example: 'team context --worker Alice',
    name: 'context',
    summary: 'Read a bounded snapshot of current Team responsibility.',
    usage: 'team context [--worker <worker-name> | --dispatch <dispatch-id>]',
  },
  {
    allowedKinds: ['orchestrator'],
    effects: [
      'Creates one durable Worker and starts it only when --start is present.',
      "Uses the Orchestrator's Provider unless --provider selects codex or claude.",
    ],
    errors: [
      ...AUTH_ERRORS,
      '400 invalid_worker - the name or Provider is invalid.',
      '400 unsupported_agent_provider_configuration - the Provider or payload field is unsupported.',
      '409 worker_name_exists - the Workspace already has a Worker with that name.',
    ],
    example: 'team add Alice --provider claude --start',
    name: 'add',
    summary: 'Create a Worker, optionally choosing its Provider and starting it.',
    usage: 'team add <worker-name> [--provider codex|claude] [--start]',
  },
  {
    allowedKinds: ['orchestrator'],
    effects: ['Starts one configured Worker whose process is currently stopped.'],
    errors: [
      ...AUTH_ERRORS,
      '404 worker_not_found - the Worker does not exist.',
      '409 worker_lifecycle_conflict - the Worker is not stopped.',
      '409 worker_lifecycle_failed - the configured Worker process failed to start.',
      '409 worker_session_unverified - the requested Provider Session could not be verified.',
    ],
    example: 'team start Alice',
    name: 'start',
    summary: 'Start a configured stopped Worker.',
    usage: 'team start <worker-name>',
  },
  {
    allowedKinds: ['orchestrator'],
    effects: [
      'Starts one stopped or crashed Worker and resumes its latest verified Provider Session when available.',
    ],
    errors: [
      ...AUTH_ERRORS,
      '404 worker_not_found - the Worker does not exist.',
      '409 worker_lifecycle_conflict - the Worker is already running.',
      '409 worker_lifecycle_failed - the configured Worker process failed to restart.',
      '409 worker_session_unverified - the requested Provider Session could not be verified.',
    ],
    example: 'team restart Alice',
    name: 'restart',
    summary: 'Explicitly restart a stopped or crashed Worker.',
    usage: 'team restart <worker-name>',
  },
  {
    allowedKinds: ['orchestrator'],
    effects: [
      'Safely stops one running Worker only when it is verified idle and owns no active or queued Dispatch.',
    ],
    errors: [
      ...AUTH_ERRORS,
      '404 worker_not_found - the Worker does not exist.',
      '409 worker_lifecycle_conflict - the Worker is not running or still owns Dispatch work.',
      '409 worker_conversation_busy - the Provider conversation is busy.',
      '409 worker_conversation_unknown - the Provider conversation cannot be verified idle.',
      '409 worker_stop_blocked - the Provider Session cannot be stopped safely.',
    ],
    example: 'team stop Alice',
    name: 'stop',
    summary: 'Safely stop an idle Worker with no Dispatch responsibility.',
    usage: 'team stop <worker-name>',
  },
  {
    allowedKinds: ['orchestrator'],
    effects: [
      'Without --queue, creates one active Dispatch and delivers it only to a running, verified-idle Worker.',
      'With --queue, appends one persisted Dispatch without starting or writing to the Worker.',
    ],
    errors: [
      ...AUTH_ERRORS,
      '400 invalid_dispatch_request - queue or request_id is invalid.',
      '409 active_dispatch_exists - the Worker already owns an active Dispatch.',
      '409 agent_process_not_running - start the stopped or crashed Worker first.',
      '409 agent_conversation_busy - wait for the current Provider turn to finish.',
      '409 agent_conversation_unknown - inspect or recover the Provider session first.',
      '409 dispatch_request_conflict - request_id was already used for different work.',
      '409 worker_queue_paused - resume the Worker queue before assigning more work.',
    ],
    example: 'team send Alice "Implement login validation"',
    name: 'send',
    summary: 'Assign immediate work or explicitly append it to the Worker queue.',
    usage: 'team send <worker-name> "<task>" [--artifact <path>] [--queue]',
  },
  {
    allowedKinds: ['orchestrator'],
    effects: [
      'Appends supplemental text and Artifacts to one open Dispatch.',
      'Delivery waits for a safe Provider input boundary when the Worker is busy.',
    ],
    errors: [
      ...AUTH_ERRORS,
      '400 invalid_note - required Note input is missing or invalid.',
      '400 dispatch_not_found - the Dispatch does not exist in this Workspace.',
      '409 dispatch_operation_in_progress - cancellation or replacement already owns the Dispatch.',
      '409 dispatch_terminal - completed or cancelled Dispatches cannot receive Notes.',
    ],
    example: 'team note --dispatch 123e4567-e89b-42d3-a456-426614174000 "Use the v2 API"',
    name: 'note',
    summary: 'Append supplemental context to an open Dispatch.',
    usage: 'team note --dispatch <dispatch-id> "<text>" [--artifact <path>]',
  },
  {
    allowedKinds: ['orchestrator'],
    effects: ['Closes the selected open Dispatch and records the reason.'],
    errors: [
      ...AUTH_ERRORS,
      '400 invalid_dispatch - the Dispatch identifier or reason is missing.',
      '409 dispatch_delivery_in_progress - retry after the current delivery attempt settles.',
      '409 dispatch_interruption_blocked - Provider interruption could not be verified.',
      '409 dispatch_operation_request_conflict - request_id was reused for different content.',
      '409 no_open_dispatch - the Dispatch is already terminal or does not exist.',
    ],
    example: 'team cancel --dispatch 123e4567-e89b-42d3-a456-426614174000 "Direction changed"',
    name: 'cancel',
    summary: 'Cancel an open Dispatch with an explicit reason.',
    usage: 'team cancel --dispatch <dispatch-id> "<reason>" [--request-id <request-id>]',
  },
  {
    allowedKinds: ['orchestrator'],
    effects: [
      'Replaces a queued Dispatch at the same FIFO position and retains an immutable audit link.',
      'Replacing busy active work requires --interrupt and preserves the Provider Session.',
    ],
    errors: [
      ...AUTH_ERRORS,
      '400 invalid_replacement - required replacement input is missing or invalid.',
      '409 no_open_dispatch - the Dispatch is terminal or does not exist.',
      '409 dispatch_operation_request_conflict - request_id was reused for different content.',
      '409 dispatch_replacement_blocked - interruption or replacement delivery could not be verified.',
      '409 replacement_requires_interrupt - busy active work requires --interrupt.',
    ],
    example: 'team replace --dispatch 123e4567-e89b-42d3-a456-426614174000 "Use the corrected API"',
    name: 'replace',
    summary: 'Replace queued or active work without reordering the remaining queue.',
    usage:
      'team replace --dispatch <dispatch-id> "<task>" [--artifact <path>] [--interrupt] [--request-id <request-id>]',
  },
  {
    allowedKinds: ['orchestrator'],
    effects: [
      'Clears a failure pause without reordering queued Dispatches.',
      'Delivery still waits for a running, verified-idle Worker.',
    ],
    errors: [...AUTH_ERRORS, '404 worker_not_found - the Worker does not exist.'],
    example: 'team queue resume Alice',
    name: 'queue',
    summary: 'Resume a Worker queue paused by a failed Report.',
    usage: 'team queue resume <worker-name>',
  },
  {
    allowedKinds: ['worker'],
    effects: [
      'Stores the latest bounded Status without completing the current responsibility.',
      'With --notify, persists an Orchestrator event that waits for a verified-idle delivery boundary.',
    ],
    errors: [
      ...AUTH_ERRORS,
      '400 invalid_status - the Status body, request_id, or notify value is invalid.',
      '409 no_active_dispatch - this Worker has no current responsibility.',
      '409 status_request_conflict - request_id was already used for different Status content.',
    ],
    example: 'team status --notify "Waiting for the integration environment"',
    name: 'status',
    summary: 'Replace the latest Status for the active responsibility.',
    usage: 'team status (<current-status> | --stdin) [--notify] [--artifact <path>]',
  },
  {
    allowedKinds: ['worker'],
    effects: [
      'Persists one immutable terminal result and closes the active Dispatch atomically.',
      'Completed is the default outcome; --failed pauses the Worker queue until explicit resume.',
    ],
    errors: [
      ...AUTH_ERRORS,
      '400 invalid_report - the Report body, request_id, or outcome is invalid.',
      '409 dispatch_operation_in_progress - cancellation or replacement already owns the Dispatch.',
      '409 no_active_dispatch - this Worker has no current responsibility.',
      '409 dispatch_note_pending - accepted supplemental context is not yet delivered.',
      '409 report_request_conflict - request_id was already used for different Report content.',
    ],
    example: 'team report "Implemented validation; focused tests pass"',
    name: 'report',
    summary: 'Submit the terminal result for the active responsibility.',
    usage: 'team report (<result> | --stdin) [--failed] [--artifact <path>]',
  },
  {
    allowedKinds: ['orchestrator', 'worker'],
    hidden: true,
    name: 'help',
    summary: 'Show role-aware Team command help.',
  },
]

const commandDefinitions = new Map(
  TEAM_COMMAND_REGISTRY.map((definition) => [definition.name, definition])
)

export const commandAllowedForKind = (kind: AgentIdentity['kind'], command: TeamCommand) =>
  commandDefinitions.get(command)?.allowedKinds.includes(kind) === true

export const renderTeamHelp = (kind: AgentIdentity['kind']) => {
  const identity = kind === 'orchestrator' ? 'Orchestrator' : 'Worker'
  const commands = TEAM_COMMAND_REGISTRY.filter(
    (definition) => !definition.hidden && definition.allowedKinds.includes(kind)
  )
  const width = Math.max(...commands.map((definition) => definition.name.length))
  return [
    `Team commands for ${identity}`,
    '',
    ...commands.map((definition) => `  ${definition.name.padEnd(width)}  ${definition.summary}`),
    '',
    'Run `team <command> --help` for syntax, effects, errors, and an example.',
  ].join('\n')
}

export const getTeamCommand = (command: string) => commandDefinitions.get(command as TeamCommand)

export const renderTeamCommandHelp = (kind: AgentIdentity['kind'], command: TeamCommand) => {
  const definition = commandDefinitions.get(command)
  if (
    !definition ||
    definition.hidden ||
    !definition.allowedKinds.includes(kind) ||
    !definition.usage ||
    !definition.effects ||
    !definition.errors ||
    !definition.example
  ) {
    return undefined
  }

  return [
    `team ${definition.name}`,
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
