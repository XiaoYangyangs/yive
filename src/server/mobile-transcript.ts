import { BadRequestError } from './http-errors.js'
import type { RecoveryMessage } from './message-log-store.js'
import { type MobileAttachmentRecord, readMobileAttachments } from './mobile-attachments.js'
import type { RuntimeStore } from './runtime-store.js'
import type { TerminalRunSummary } from './terminal-input-profile.js'

const RECENT_OUTPUT_LIMIT = 4_000
const RECENT_OUTPUT_LINE_LIMIT = 80
const RECOVERY_WINDOW_MS = 10 * 60 * 1000
const ACTION_ECHO_LIMIT = 100
const RUN_TRANSCRIPT_CACHE_LIMIT = 100
const PREVIEW_LIMIT = 500
const BASE64_LIKE_PATTERN = /\b(?:[A-Za-z0-9+/]{80,}={0,2})\b/g
const ANSI_CURSOR_FORWARD_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[(\\d*)C`, 'g')
const ANSI_OSC_PATTERN = new RegExp(
  `${String.fromCharCode(0x1b)}\\][^\\u0007]*(?:\\u0007|${String.fromCharCode(0x1b)}\\\\)`,
  'g'
)
const ANSI_PATTERN = new RegExp(
  [ANSI_OSC_PATTERN.source, `${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`].join('|'),
  'g'
)
const CONTROL_PATTERN = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x08)}${String.fromCharCode(
    0x0b
  )}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
  'g'
)

type MobileTranscriptActionKind =
  | 'bind_current_session'
  | 'chat_continue'
  | 'file_review'
  | 'native_image_paste'
  | 'restart_run'
  | 'start_run'
  | 'stop_run'
  | 'team_cancel'
  | 'team_replace'
  | 'team_note'
  | 'team_report'
  | 'team_send'
  | 'team_status'
  | 'terminal_input'

interface MobileActionEchoFileReview {
  comment?: string
  decision: string
  file_id: string
  name?: string
  workspace_path?: string
}

export interface MobileActionEchoInput {
  actionId: string
  attachments?: Array<{ file_id: string; placeholder: string }>
  bytes?: number
  confirmed?: boolean
  fileReview?: MobileActionEchoFileReview
  kind: MobileTranscriptActionKind
  runId?: string
  workspaceId: string
}

interface Sanitizer {
  normalizeText: (value: string, limit?: number) => { text: string; truncated: boolean }
  sanitizeText: (value: string, limit?: number) => { text: string; truncated: boolean }
  sanitizeArtifact: (value: string) => string
}

const actionEchoes: MobileActionEchoInput[] = []
const runTranscriptCache = new Map<
  string,
  {
    exitCode: number | null
    output: string
    runSummary: TerminalRunSummary
    sensitiveValues: string[]
    status: 'starting' | 'running' | 'exited' | 'error'
  }
>()

export const recordMobileActionEcho = (input: MobileActionEchoInput) => {
  actionEchoes.push(input)
  if (actionEchoes.length > ACTION_ECHO_LIMIT) {
    actionEchoes.splice(0, actionEchoes.length - ACTION_ECHO_LIMIT)
  }
}

const rememberRunTranscript = (
  runId: string,
  runSummary: TerminalRunSummary,
  liveRun: {
    exitCode: number | null
    output: string
    status: 'starting' | 'running' | 'exited' | 'error'
  },
  sensitiveValues: string[] = []
) => {
  runTranscriptCache.set(runId, {
    exitCode: liveRun.exitCode,
    output: liveRun.output,
    runSummary,
    sensitiveValues,
    status: liveRun.status,
  })
  while (runTranscriptCache.size > RUN_TRANSCRIPT_CACHE_LIMIT) {
    const oldestKey = runTranscriptCache.keys().next().value
    if (!oldestKey) break
    runTranscriptCache.delete(oldestKey)
  }
}

const tailLines = (value: string) =>
  value.split(/\r?\n/u).slice(-RECENT_OUTPUT_LINE_LIMIT).join('\n')

const truncate = (value: string, limit: number) => {
  if (value.length <= limit) return { text: value, truncated: false }
  return { text: value.slice(-limit), truncated: true }
}

const uniqueSensitiveValues = (values: Array<string | null | undefined>) =>
  Array.from(new Set(values.filter((value): value is string => Boolean(value && value.length > 0))))

const createSanitizer = (sensitiveValues: string[]): Sanitizer => {
  const redact = (value: string) => {
    let sanitized = value
    for (const sensitive of sensitiveValues) {
      sanitized = sanitized.split(sensitive).join('[redacted]')
    }
    return sanitized.replace(BASE64_LIKE_PATTERN, '[redacted-base64]')
  }

  const sanitizeText = (value: string, limit = PREVIEW_LIMIT) => {
    const sanitized = redact(value)
      .replace(ANSI_CURSOR_FORWARD_PATTERN, (_match, count: string) =>
        ' '.repeat(Math.max(1, Number(count || '1')))
      )
      .replace(ANSI_PATTERN, '')
      .replace(CONTROL_PATTERN, '')
    return truncate(sanitized, limit)
  }

  return {
    normalizeText(value, limit = PREVIEW_LIMIT) {
      const sanitized = redact(value)
        .replace(ANSI_CURSOR_FORWARD_PATTERN, (_match, count: string) =>
          ' '.repeat(Math.max(1, Number(count || '1')))
        )
        .replace(ANSI_PATTERN, '')
        .replace(CONTROL_PATTERN, '')
      return truncate(sanitized, limit)
    },
    sanitizeArtifact(value) {
      return sanitizeText(value, PREVIEW_LIMIT).text
    },
    sanitizeText,
  }
}

const getRunFromWorkspace = (store: RuntimeStore, workspaceId: string, runId: string) => {
  const run = store
    .listTerminalRuns(workspaceId)
    .find((terminalRun) => terminalRun.run_id === runId)
  if (run) return run
  const cached = runTranscriptCache.get(runId)
  if (cached) return cached.runSummary
  throw new BadRequestError(`Run not found in workspace: ${runId}`)
}

const getWorkspace = (store: RuntimeStore, workspaceId: string) => {
  const workspace = store.listWorkspaces().find((item) => item.id === workspaceId)
  if (!workspace) throw new BadRequestError(`Workspace not found: ${workspaceId}`)
  return workspace
}

const serializeAttachment = (attachment: MobileAttachmentRecord) => ({
  created_at: attachment.created_at,
  file_id: attachment.file_id,
  mime_type: attachment.mime_type,
  name: attachment.name,
  placeholder: attachment.placeholder,
  size: attachment.size,
})

const serializeMessage = (
  message: RecoveryMessage,
  index: number,
  sanitizer: Sanitizer,
  workspaceId: string
) => {
  const text = sanitizer.normalizeText(message.text)
  const base = {
    created_at: message.createdAt,
    id: `message:${workspaceId}:${message.createdAt}:${index}`,
    text: text.text,
    truncated: text.truncated,
  }

  if (message.type === 'user_input') {
    return { ...base, type: 'mobile_action_echo' }
  }
  if (message.type === 'send') {
    return {
      ...base,
      from_agent_id: message.from ?? null,
      to_agent_id: message.to,
      type: 'dispatch',
    }
  }
  return {
    ...base,
    artifacts: message.artifacts.map((artifact) => sanitizer.sanitizeArtifact(artifact)),
    from_agent_id: message.from,
    ...(message.type === 'report' && message.outcome ? { outcome: message.outcome } : {}),
    type: message.type,
  }
}

const buildSensitiveValues = (
  store: RuntimeStore,
  workspaceId: string,
  attachments: MobileAttachmentRecord[]
) => {
  const workspace = store.getWorkspaceSnapshot(workspaceId)
  return uniqueSensitiveValues([
    ...workspace.agents.map((agent) => store.peekAgentToken(agent.id)),
    ...attachments.map((attachment) => attachment.local_path),
  ])
}

export const rememberMobileRunTranscript = (
  store: RuntimeStore,
  workspaceId: string,
  runId: string
) => {
  const workspaceSummary = getWorkspace(store, workspaceId)
  const runSummary = getRunFromWorkspace(store, workspaceId, runId)
  const liveRun = store.getLiveRun(runId)
  const attachments = readMobileAttachments(workspaceSummary.path)
  rememberRunTranscript(
    runId,
    runSummary,
    liveRun,
    buildSensitiveValues(store, workspaceId, attachments)
  )
}

export const buildMobileTranscript = (store: RuntimeStore, workspaceId: string, runId: string) => {
  const workspaceSummary = getWorkspace(store, workspaceId)
  const runSummary = getRunFromWorkspace(store, workspaceId, runId)
  let liveRun: {
    exitCode: number | null
    output: string
    status: 'starting' | 'running' | 'exited' | 'error'
  }
  try {
    liveRun = store.getLiveRun(runId)
  } catch (error) {
    const cached = runTranscriptCache.get(runId)
    if (!cached) throw error
    liveRun = cached
  }
  const attachments = readMobileAttachments(workspaceSummary.path)
  const sensitiveValues = uniqueSensitiveValues([
    ...buildSensitiveValues(store, workspaceId, attachments),
    ...(runTranscriptCache.get(runId)?.sensitiveValues ?? []),
  ])
  rememberRunTranscript(runId, runSummary, liveRun, sensitiveValues)
  const sanitizer = createSanitizer(sensitiveValues)
  const generatedAt = Date.now()
  const recentRaw = tailLines(liveRun.output)
  const rawSummary = sanitizer.sanitizeText(recentRaw, RECENT_OUTPUT_LIMIT)
  const normalizedOutput = sanitizer.normalizeText(recentRaw, RECENT_OUTPUT_LIMIT)
  const safeAttachments = attachments.map(serializeAttachment)
  const recentMessages = store
    .listMessagesForRecovery(workspaceId, generatedAt - RECOVERY_WINDOW_MS)
    .map((message, index) => serializeMessage(message, index, sanitizer, workspaceId))
  const recentActionEchoes = actionEchoes
    .filter((action) => action.workspaceId === workspaceId && action.runId === runId)
    .map((action) => ({
      attachments: action.attachments ?? [],
      bytes: action.bytes ?? null,
      confirmed: action.confirmed === true,
      ...(action.fileReview ? { file_review: action.fileReview } : {}),
      created_at: generatedAt,
      id: `action:${action.actionId}`,
      kind: action.kind,
      run_id: runId,
      type: 'mobile_action_echo',
    }))
  const attachmentEvents = safeAttachments.map((attachment) => ({
    attachment,
    created_at: attachment.created_at,
    id: `attachment:${attachment.file_id}`,
    run_id: runId,
    type: 'attachment',
  }))

  return {
    generated_at: generatedAt,
    workspace_id: workspaceId,
    run_id: runId,
    run: {
      agent_id: runSummary.agent_id,
      agent_name: runSummary.agent_name,
      exit_code: liveRun.exitCode,
      status: liveRun.status,
      terminal_input_profile: runSummary.terminal_input_profile,
    },
    attachments: safeAttachments,
    events: [
      {
        created_at: generatedAt,
        id: `status:${runId}`,
        run_id: runId,
        status: liveRun.status,
        type: 'status',
      },
      ...(normalizedOutput.text.length > 0 || rawSummary.text.length > 0
        ? [
            {
              created_at: generatedAt,
              id: `output:${runId}`,
              raw_summary: rawSummary.text,
              run_id: runId,
              text: normalizedOutput.text,
              truncated: normalizedOutput.truncated || rawSummary.truncated,
              type: 'terminal_output',
            },
          ]
        : []),
      ...recentMessages,
      ...recentActionEchoes,
      ...attachmentEvents,
    ],
  }
}
