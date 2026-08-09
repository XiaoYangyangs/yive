import type { ConversationProvider } from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { readClaudeConversationIncrement } from './claude-conversation-provider.js'
import { readCodexConversationIncrement } from './codex-conversation-provider.js'
import type { ConversationIncrement } from './conversation-source.js'
import { HttpError } from './http-errors.js'
import { getManagedProviderDefinition } from './managed-provider.js'
import {
  type ProviderCapabilityProbe,
  type ProviderCapabilityProbeRunner,
  runProviderCapabilityProbe,
} from './provider-command-probe.js'
import type { SessionIdCaptureConfig } from './session-capture.js'
import {
  getClaudeProjectsRoot,
  getClaudeSessionFilePath,
  snapshotClaudeSessionCheckpoints,
} from './session-capture-claude.js'
import {
  findCodexSessionFile,
  getCodexHome,
  snapshotCodexSessionCheckpoints,
} from './session-capture-codex.js'

export type { ProviderCapabilityProbe } from './provider-command-probe.js'

type NativeInstructionRole = 'developer' | 'system'
type InterruptManager = Pick<AgentManager, 'writeInput'>

export interface ProviderSessionCheckpoint {
  checkpoint: number
  filePath: string
  id: string
}

interface ProviderCapabilityProbeInput {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  instructions?: string
  probe?: ProviderCapabilityProbeRunner
}

export interface ProviderAdapter {
  assertCapabilities: (input: ProviderCapabilityProbeInput) => void
  canTimeoutBeforePromptReady: boolean
  canVerifyResumeAtPromptReady: boolean
  findSessionSource: (cwd: string, sessionId: string, pattern?: string) => string | null
  hasPasteAcknowledgement: (output: string, baselineLength: number) => boolean
  id: ConversationProvider
  interruptCurrentTurn: (manager: InterruptManager, runId: string) => void
  isPromptReady: (output: string) => boolean
  nativeInstructionRole: NativeInstructionRole
  prepareLaunch: (config: AgentLaunchConfigInput, instructions: string) => AgentLaunchConfigInput
  prepareShellEnvironment?: (
    config: AgentLaunchConfigInput,
    env: NodeJS.ProcessEnv
  ) => AgentLaunchConfigInput
  readConversationIncrement: (input: {
    checkpoint: number | null
    filePath: string
  }) => ConversationIncrement
  resumeArgsTemplate: string
  sessionCapture: SessionIdCaptureConfig
  snapshotSessionCheckpoints: (cwd: string, pattern?: string) => ProviderSessionCheckpoint[]
  toPromptInput: (text: string) => string
}

type ProviderCapability = 'current_turn_interruption' | 'native_instructions' | 'session_resume'

export class ProviderCapabilityError extends HttpError {
  readonly capability: ProviderCapability
  readonly provider: ConversationProvider

  constructor(provider: ConversationProvider, capability: ProviderCapability, detail: string) {
    super(
      422,
      `${provider} Provider Adapter cannot prove ${capability.replaceAll('_', ' ')}: ${detail}`,
      'provider_capability_unavailable'
    )
    this.name = 'ProviderCapabilityError'
    this.capability = capability
    this.provider = provider
  }
}

const toBracketedPaste = (text: string) => `\u001b[200~${text}\u001b[201~`
const toNativeInstructionArgument = (text: string) => text.replace(/[\r\n\t]+/gu, ' ').trim()
const hasPasteAcknowledgement = (output: string, baselineLength: number) =>
  /\[(?:Pasted text #\d+|Pasted Content \d+ chars)\b/u.test(output.slice(baselineLength))
const ESCAPE = String.fromCharCode(0x1b)
const BELL = String.fromCharCode(0x07)
const ANSI_CONTROL_SEQUENCE = new RegExp(
  [`${ESCAPE}\\][^${BELL}]*(?:${BELL}|${ESCAPE}\\\\)`, `${ESCAPE}\\[[0-?]*[ -/]*[@-~]`].join('|'),
  'gu'
)
const ANSI_CURSOR_POSITION = new RegExp(`${ESCAPE}\\[[0-9;]*[Hf]`, 'gu')
const isInteractivePromptReady = (output: string) =>
  /(?:^|[\r\n])\s*(?:>|\u203a|\u276f)\s*$/u.test(
    output.replace(ANSI_CURSOR_POSITION, '\n').replace(ANSI_CONTROL_SEQUENCE, '')
  )

const hasArg = (args: readonly string[], names: readonly string[]) =>
  args.some((arg) => names.includes(arg) || names.some((name) => arg.startsWith(`${name}=`)))

const addResumeArgs = (
  provider: ConversationProvider,
  config: AgentLaunchConfigInput
): AgentLaunchConfigInput => {
  const sessionId = config.resumedSessionId
  if (!sessionId) return config
  const args = config.args ?? []
  if (
    provider === 'codex'
      ? args[0] === 'resume' || args.includes('resume')
      : hasArg(args, ['--resume', '-r', '--continue', '-c'])
  ) {
    return config
  }
  return {
    ...config,
    args: provider === 'codex' ? [...args, 'resume', sessionId] : [...args, '--resume', sessionId],
  }
}

const insertBeforeResume = (
  provider: ConversationProvider,
  args: string[],
  nativeArgs: string[]
) => {
  const resumeIndex = args.findIndex((arg) =>
    provider === 'codex'
      ? arg === 'resume'
      : arg === '--resume' || arg === '-r' || arg.startsWith('--resume=')
  )
  if (resumeIndex < 0) {
    return provider === 'codex' ? [...args, ...nativeArgs] : [...nativeArgs, ...args]
  }
  return [...args.slice(0, resumeIndex), ...nativeArgs, ...args.slice(resumeIndex)]
}

const probeOrThrow = (
  provider: ConversationProvider,
  capability: ProviderCapability,
  input: ProviderCapabilityProbeInput,
  args: string[],
  validate: (result: ProviderCapabilityProbe) => boolean
) => {
  let result: ProviderCapabilityProbe
  try {
    result = (input.probe ?? runProviderCapabilityProbe)({
      args,
      command: input.command,
      cwd: input.cwd,
      env: input.env,
    })
  } catch (error) {
    throw new ProviderCapabilityError(
      provider,
      capability,
      error instanceof Error ? error.message : String(error)
    )
  }
  if (result.status === 0 && validate(result)) return
  const detail = result.stderr.trim() || result.stdout.trim() || `probe exited ${result.status}`
  throw new ProviderCapabilityError(provider, capability, detail)
}

const readPromptInputMessages = (stdout: string): unknown[] => {
  const start = stdout.indexOf('[')
  if (start < 0) return []
  try {
    const parsed = JSON.parse(stdout.slice(start)) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const hasDeveloperProbe = (stdout: string, expected: string) =>
  readPromptInputMessages(stdout).some((item) => {
    if (!item || typeof item !== 'object' || !('role' in item) || item.role !== 'developer') {
      return false
    }
    if (!('content' in item) || !Array.isArray(item.content)) return false
    return item.content.some(
      (content) =>
        content !== null &&
        typeof content === 'object' &&
        'text' in content &&
        content.text === expected
    )
  })

const codexProbeText = 'YIVE_NATIVE_DEVELOPER_INSTRUCTION_PROBE'
const successfulCapabilityProbes = new Set<string>()
const codexDefinition = getManagedProviderDefinition('codex')
const claudeDefinition = getManagedProviderDefinition('claude')

const getProbeCacheKey = (provider: ConversationProvider, input: ProviderCapabilityProbeInput) =>
  `${provider}:${input.command}:${input.env.PATH ?? input.env.Path ?? ''}`

const codexAdapter: ProviderAdapter = {
  assertCapabilities(input) {
    const cacheKey = getProbeCacheKey('codex', input)
    if (!input.probe && successfulCapabilityProbes.has(cacheKey)) return
    const probeText = toNativeInstructionArgument(input.instructions ?? codexProbeText)
    probeOrThrow(
      'codex',
      'native_instructions',
      input,
      ['debug', 'prompt-input', '-c', `developer_instructions=${probeText}`],
      (result) => hasDeveloperProbe(result.stdout, probeText)
    )
    probeOrThrow('codex', 'session_resume', input, ['--help'], (result) =>
      /(?:^|\s)resume(?:\s|$)/u.test(result.stdout)
    )
    if (!input.probe) successfulCapabilityProbes.add(cacheKey)
  },
  canTimeoutBeforePromptReady: false,
  canVerifyResumeAtPromptReady: true,
  findSessionSource: (cwd, sessionId, pattern) =>
    findCodexSessionFile(cwd, sessionId, getCodexHome(pattern)) ?? null,
  hasPasteAcknowledgement,
  id: 'codex',
  interruptCurrentTurn: (manager, runId) => manager.writeInput(runId, '\u001b'),
  isPromptReady: isInteractivePromptReady,
  nativeInstructionRole: 'developer',
  prepareLaunch(config, instructions) {
    const withResume = addResumeArgs('codex', config)
    const nativeInstructions = toNativeInstructionArgument(instructions)
    return {
      ...withResume,
      args: insertBeforeResume('codex', withResume.args ?? [], [
        '-c',
        `developer_instructions=${nativeInstructions}`,
      ]),
    }
  },
  prepareShellEnvironment(config, env) {
    const path = env.PATH ?? env.Path
    if (!path) return config
    const shellEnvironmentAllowlist = [
      'APPDATA',
      'CI',
      'COMSPEC',
      'HIVE_AGENT_ID',
      'HIVE_AGENT_TOKEN',
      'HIVE_PORT',
      'HIVE_PROJECT_ID',
      'HOMEDRIVE',
      'HOMEPATH',
      'LOCALAPPDATA',
      'NO_COLOR',
      'NO_UPDATE_NOTIFIER',
      'PATH',
      'PATHEXT',
      'PROGRAMDATA',
      'PROGRAMFILES',
      'PROGRAMFILES(X86)',
      'PSMODULEPATH',
      'SYSTEMROOT',
      'TEMP',
      'TMP',
      'USERPROFILE',
      'WINDIR',
    ]
    return {
      ...config,
      args: insertBeforeResume('codex', config.args ?? [], [
        '-c',
        'shell_environment_policy.inherit=all',
        '-c',
        `shell_environment_policy.include_only=${JSON.stringify(shellEnvironmentAllowlist)}`,
        '-c',
        `shell_environment_policy.set.PATH=${JSON.stringify(path)}`,
      ]),
    }
  },
  readConversationIncrement: readCodexConversationIncrement,
  resumeArgsTemplate: codexDefinition.resumeArgsTemplate,
  sessionCapture: codexDefinition.sessionIdCapture,
  snapshotSessionCheckpoints: (cwd, pattern) =>
    snapshotCodexSessionCheckpoints(cwd, getCodexHome(pattern)),
  toPromptInput: toBracketedPaste,
}

const claudeAdapter: ProviderAdapter = {
  assertCapabilities(input) {
    const cacheKey = getProbeCacheKey('claude', input)
    if (!input.probe && successfulCapabilityProbes.has(cacheKey)) return
    probeOrThrow('claude', 'native_instructions', input, ['--help'], (result) =>
      result.stdout.includes('--append-system-prompt')
    )
    probeOrThrow('claude', 'session_resume', input, ['--help'], (result) =>
      result.stdout.includes('--resume')
    )
    if (!input.probe) successfulCapabilityProbes.add(cacheKey)
  },
  canTimeoutBeforePromptReady: false,
  canVerifyResumeAtPromptReady: false,
  findSessionSource: (cwd, sessionId, pattern) => getClaudeSessionFilePath(cwd, sessionId, pattern),
  hasPasteAcknowledgement,
  id: 'claude',
  interruptCurrentTurn: (manager, runId) => manager.writeInput(runId, '\u001b'),
  isPromptReady: isInteractivePromptReady,
  nativeInstructionRole: 'system',
  prepareLaunch(config, instructions) {
    const withResume = addResumeArgs('claude', config)
    return {
      ...withResume,
      args: insertBeforeResume('claude', withResume.args ?? [], [
        '--append-system-prompt',
        toNativeInstructionArgument(instructions),
      ]),
    }
  },
  readConversationIncrement: readClaudeConversationIncrement,
  resumeArgsTemplate: claudeDefinition.resumeArgsTemplate,
  sessionCapture: claudeDefinition.sessionIdCapture,
  snapshotSessionCheckpoints: (cwd, pattern) =>
    snapshotClaudeSessionCheckpoints(cwd, getClaudeProjectsRoot(pattern)),
  toPromptInput: toBracketedPaste,
}

const adapters = new Map<ConversationProvider, ProviderAdapter>([
  ['claude', claudeAdapter],
  ['codex', codexAdapter],
])

export const getProviderAdapter = (provider: ConversationProvider) => adapters.get(provider)

export const getProviderAdapterForCapture = (
  capture: SessionIdCaptureConfig | null | undefined
) => {
  if (capture?.source === 'codex_session_jsonl_dir') return codexAdapter
  if (capture?.source === 'claude_project_jsonl_dir') return claudeAdapter
  return undefined
}

export const getProviderAdapterForCommand = (command: string) => {
  const executable = command
    .split(/[\\/]/u)
    .pop()
    ?.toLowerCase()
    .replace(/\.(?:bat|cmd|exe)$/u, '')
  return executable === 'codex' || executable === 'claude' ? adapters.get(executable) : undefined
}

export const getProviderAdapterForLaunchConfig = (config: AgentLaunchConfigInput) => {
  if (config.provider === 'codex' || config.provider === 'claude') {
    return adapters.get(config.provider)
  }
  return undefined
}
