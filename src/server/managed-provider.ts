import type { ConversationProvider } from '../shared/types.js'

import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { SessionIdCaptureConfig } from './session-capture.js'

export const MANAGED_PROVIDERS = [
  'codex',
  'claude',
] as const satisfies readonly ConversationProvider[]

export type ManagedProvider = (typeof MANAGED_PROVIDERS)[number]

interface ManagedProviderDefinition {
  command: string
  defaultArgs: string[]
  resumeArgsTemplate: string
  sessionIdCapture: SessionIdCaptureConfig
}

const definitions: Record<ManagedProvider, ManagedProviderDefinition> = {
  claude: {
    command: 'claude',
    defaultArgs: ['--dangerously-skip-permissions', '--permission-mode=bypassPermissions'],
    resumeArgsTemplate: '--resume {session_id}',
    sessionIdCapture: {
      pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
      source: 'claude_project_jsonl_dir',
    },
  },
  codex: {
    command: 'codex',
    defaultArgs: ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'],
    resumeArgsTemplate: 'resume {session_id}',
    sessionIdCapture: {
      pattern: '~/.codex/sessions/**/*.jsonl',
      source: 'codex_session_jsonl_dir',
    },
  },
}

export const isManagedProvider = (value: unknown): value is ManagedProvider =>
  typeof value === 'string' && (MANAGED_PROVIDERS as readonly string[]).includes(value)

export const getManagedProviderDefinition = (provider: ManagedProvider) => definitions[provider]

export const buildManagedProviderLaunchConfig = (
  provider: ManagedProvider
): AgentLaunchConfigInput => {
  const definition = definitions[provider]
  return {
    args: [...definition.defaultArgs],
    command: definition.command,
    interactiveCommand: definition.command,
    provider,
    resumeArgsTemplate: definition.resumeArgsTemplate,
    sessionIdCapture: definition.sessionIdCapture,
  }
}
