import type { IncomingMessage } from 'node:http'
import { MOBILE_ARTIFACT_CONTRACT_VERSION } from '../shared/types.js'
import { bindMobileArtifactFiles } from './chat-attachment-binding.js'
import { serializeDispatchRecord } from './dispatch-ledger-serializer.js'
import { BadRequestError, HttpError } from './http-errors.js'
import type { MobileAttachmentRecord } from './mobile-attachments.js'
import { pasteMobileImageToNativeClipboard } from './mobile-native-clipboard.js'
import { sendMobileNotification } from './mobile-notification-service.js'
import { buildMobileSnapshot } from './mobile-snapshot.js'
import {
  buildMobileTranscript,
  type MobileActionEchoInput,
  recordMobileActionEcho,
  rememberMobileRunTranscript,
} from './mobile-transcript.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { getMobileFileExchangeItem } from './routes-file-exchange.js'
import type { RuntimeStore } from './runtime-store.js'
import {
  assertMobileWorkspaceAccess,
  requireMobileOrUiTokenFromRequest,
} from './ui-auth-helpers.js'
import { getOrchestratorId } from './workspace-store-support.js'

const RESTART_STOP_WAIT_MS = 2_000
const RESTART_STOP_POLL_MS = 25
const MOBILE_ACTION_DEDUPE_TTL_MS = 5 * 60 * 1_000
const MOBILE_ACTION_DEDUPE_MAX_ENTRIES = 500
const MOBILE_CONFIRMATION_TTL_MS = 60_000
const MOBILE_CONFIRMATION_MAX_ENTRIES = 500
const shouldUseNativeImagePaste = () =>
  process.env.HIVE_MOBILE_NATIVE_IMAGE_PASTE === '1' ||
  (process.env.HIVE_MOBILE_NATIVE_IMAGE_PASTE !== '0' && process.platform === 'win32')

const describeNativeImagePasteFallback = (error: unknown): string => {
  if (process.env.HIVE_MOBILE_NATIVE_IMAGE_PASTE === '0') {
    return 'native_image_paste_disabled'
  }
  if (process.platform !== 'win32') {
    return 'native_image_paste_requires_windows_desktop'
  }
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/clipboard/iu.test(message)) return 'native_clipboard_unavailable'
  if (/timeout/iu.test(message)) return 'native_clipboard_timeout'
  return 'native_image_paste_unavailable'
}

type MobileActionKind =
  | 'chat_cancel'
  | 'chat_edit'
  | 'chat_force'
  | 'chat_continue'
  | 'chat_migrate'
  | 'chat_dismiss_conversation'
  | 'chat_submit'
  | 'file_review'
  | 'native_image_paste'
  | 'terminal_input'
  | 'start_run'
  | 'stop_run'
  | 'restart_run'
  | 'bind_current_session'
  | 'team_note'
  | 'team_send'
  | 'team_status'
  | 'team_report'
  | 'team_cancel'
  | 'team_replace'

interface MobileActionBody {
  action_id?: unknown
  artifact_contract_version?: unknown
  workspace_id?: unknown
  kind?: unknown
  target?: unknown
  payload?: unknown
}

interface MobileConfirmationBody {
  workspace_id?: unknown
  kind?: unknown
  target?: unknown
}

interface MobileNotificationBody {
  body?: unknown
  image_path?: unknown
  title?: unknown
  workspace_id?: unknown
}

interface MobilePushTokenBody {
  app_id?: unknown
  device_id?: unknown
  platform?: unknown
  token?: unknown
  workspace_ids?: unknown
}

interface MobileActionEnvelope {
  actionId: string
  artifactContractVersion: number | null
  workspaceId: string
  kind: MobileActionKind
  target: Record<string, unknown>
  payload: Record<string, unknown>
}

interface MobileTerminalAttachmentInput {
  fileId: string
  placeholder: string
}

type MobileFileReviewDecision = 'approved' | 'needs_changes' | 'rejected'

type MobileActionResult = Record<string, unknown>

interface MobileActionDedupeEntry {
  chatSubmissionIdentity: string | null
  createdAt: number
  promise: Promise<MobileActionResult>
  signature: string
}

interface MobileConfirmationEntry {
  createdAt: number
  expiresAt: number
  signature: string
}

const mobileActionDedupeCache = new Map<string, MobileActionDedupeEntry>()
const mobileConfirmations = new Map<string, MobileConfirmationEntry>()

const getRuntimePort = (request: IncomingMessage) => String(request.socket.localPort ?? '')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requireString = (value: unknown, field: string) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestError(`${field} is required`)
  }
  return value
}

const parseArtifactContractVersion = (value: unknown) => {
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new BadRequestError('artifact_contract_version must be a positive integer')
  }
  return value
}

const parseMobileTerminalAttachments = (value: unknown): MobileTerminalAttachmentInput[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new BadRequestError('payload.attachments must be an array')
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new BadRequestError(`payload.attachments[${index}] must be an object`)
    }
    const fileId = requireString(item.file_id, `payload.attachments[${index}].file_id`)
    const placeholder = requireString(item.placeholder, `payload.attachments[${index}].placeholder`)
    if (!/^\[Image #\d+\]$/u.test(placeholder)) {
      throw new BadRequestError(`Invalid image placeholder: ${placeholder}`)
    }
    return { fileId, placeholder }
  })
}

const parseMobileChatAttachmentIds = (value: unknown): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new BadRequestError('payload.attachments must be an array')
  const fileIds = value.map((item, index) => {
    if (!isRecord(item)) {
      throw new BadRequestError(`payload.attachments[${index}] must be an object`)
    }
    return requireString(item.file_id, `payload.attachments[${index}].file_id`)
  })
  if (new Set(fileIds).size !== fileIds.length) {
    throw new BadRequestError('payload.attachments must not contain duplicate file IDs')
  }
  return fileIds
}

const parseMobileArtifacts = (value: unknown) => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new BadRequestError('payload.artifacts must be an array')
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new BadRequestError(`payload.artifacts[${index}] must be a string`)
    }
    return item
  })
}

const requireFileReviewDecision = (value: unknown): MobileFileReviewDecision => {
  const decision = requireString(value, 'payload.decision')
  if (decision !== 'approved' && decision !== 'needs_changes' && decision !== 'rejected') {
    throw new BadRequestError(`Unsupported file review decision: ${decision}`)
  }
  return decision
}

const parseOptionalFileReviewComment = (value: unknown) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new BadRequestError('payload.comment must be a string')
  const comment = value.trim()
  if (comment.length > 4_000) throw new BadRequestError('payload.comment is too long')
  return comment.length > 0 ? comment : undefined
}

const requireActionKind = (value: unknown): MobileActionKind => {
  const kind = requireString(value, 'kind')
  if (
    kind !== 'chat_cancel' &&
    kind !== 'chat_edit' &&
    kind !== 'chat_force' &&
    kind !== 'chat_continue' &&
    kind !== 'chat_migrate' &&
    kind !== 'chat_dismiss_conversation' &&
    kind !== 'chat_submit' &&
    kind !== 'file_review' &&
    kind !== 'terminal_input' &&
    kind !== 'native_image_paste' &&
    kind !== 'start_run' &&
    kind !== 'stop_run' &&
    kind !== 'restart_run' &&
    kind !== 'bind_current_session' &&
    kind !== 'team_note' &&
    kind !== 'team_send' &&
    kind !== 'team_status' &&
    kind !== 'team_report' &&
    kind !== 'team_cancel' &&
    kind !== 'team_replace'
  ) {
    throw new BadRequestError(`Unsupported mobile action kind: ${kind}`)
  }
  return kind
}

const parseMobileAction = (body: MobileActionBody): MobileActionEnvelope => ({
  actionId: requireString(body.action_id, 'action_id'),
  artifactContractVersion: parseArtifactContractVersion(body.artifact_contract_version),
  workspaceId: requireString(body.workspace_id, 'workspace_id'),
  kind: requireActionKind(body.kind),
  target: isRecord(body.target)
    ? body.target
    : (() => {
        throw new BadRequestError('target is required')
      })(),
  payload:
    body.payload === undefined
      ? {}
      : isRecord(body.payload)
        ? body.payload
        : (() => {
            throw new BadRequestError('payload must be an object')
          })(),
})

const parseMobileConfirmation = (body: MobileConfirmationBody) => ({
  kind: requireActionKind(body.kind),
  target: isRecord(body.target)
    ? body.target
    : (() => {
        throw new BadRequestError('target is required')
      })(),
  workspaceId: requireString(body.workspace_id, 'workspace_id'),
})

const parseMobileNotification = (body: MobileNotificationBody) => {
  const title = requireString(body.title, 'title').trim()
  const message = requireString(body.body, 'body').trim()
  if (!title) throw new BadRequestError('title is required')
  if (!message) throw new BadRequestError('body is required')
  if (title.length > 120) throw new BadRequestError('title is too long')
  if (message.length > 2_000) throw new BadRequestError('body is too long')
  const imagePath =
    body.image_path === undefined || body.image_path === null
      ? undefined
      : requireString(body.image_path, 'image_path').trim()
  if (imagePath !== undefined && imagePath.length === 0) {
    throw new BadRequestError('image_path is required')
  }
  if (imagePath !== undefined && imagePath.length > 500) {
    throw new BadRequestError('image_path is too long')
  }
  return {
    body: message,
    ...(imagePath !== undefined ? { imagePath } : {}),
    title,
    workspaceId: requireString(body.workspace_id, 'workspace_id'),
  }
}

const parseOptionalShortString = (value: unknown, field: string) => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new BadRequestError(`${field} must be a string`)
  const text = value.trim()
  if (!text) return undefined
  if (text.length > 160) throw new BadRequestError(`${field} is too long`)
  return text
}

const parseMobilePushWorkspaceIds = (value: unknown) => {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new BadRequestError('workspace_ids must be an array')
  const workspaceIds = value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new BadRequestError(`workspace_ids[${index}] must be a string`)
    }
    const workspaceId = item.trim()
    if (workspaceId.length > 120) throw new BadRequestError(`workspace_ids[${index}] is too long`)
    return workspaceId
  })
  return workspaceIds.length > 0 ? Array.from(new Set(workspaceIds)) : undefined
}

const parseMobilePushToken = (body: MobilePushTokenBody) => {
  const platform = requireString(body.platform ?? 'fcm', 'platform')
  const normalizedPlatform = platform === 'android' ? 'fcm' : platform
  if (normalizedPlatform !== 'fcm' && normalizedPlatform !== 'xiaomi') {
    throw new BadRequestError(`Unsupported push platform: ${platform}`)
  }
  const pushPlatform: 'fcm' | 'xiaomi' = normalizedPlatform
  const token = requireString(body.token, 'token').trim()
  if (token.length < 20) throw new BadRequestError('token is too short')
  if (token.length > 4096) throw new BadRequestError('token is too long')
  return {
    appId: parseOptionalShortString(body.app_id, 'app_id'),
    deviceId: parseOptionalShortString(body.device_id, 'device_id'),
    platform: pushPlatform,
    token,
    workspaceIds: parseMobilePushWorkspaceIds(body.workspace_ids),
  }
}

const getMobileDangerSignature = (input: {
  kind: MobileActionKind
  target: Record<string, unknown>
  workspaceId: string
}) =>
  JSON.stringify({
    kind: input.kind,
    target: input.target,
    workspace_id: input.workspaceId,
  })

const isDangerousMobileAction = (kind: MobileActionKind) =>
  kind === 'stop_run' || kind === 'restart_run' || kind === 'team_cancel' || kind === 'team_replace'

const pruneMobileConfirmations = (now = Date.now()) => {
  for (const [nonce, entry] of mobileConfirmations) {
    if (entry.expiresAt <= now) mobileConfirmations.delete(nonce)
  }

  while (mobileConfirmations.size > MOBILE_CONFIRMATION_MAX_ENTRIES) {
    const [oldestNonce] = mobileConfirmations.keys()
    if (oldestNonce === undefined) break
    mobileConfirmations.delete(oldestNonce)
  }
}

const createMobileConfirmationNonce = (action: {
  kind: MobileActionKind
  target: Record<string, unknown>
  workspaceId: string
}) => {
  if (!isDangerousMobileAction(action.kind)) {
    throw new BadRequestError(`Mobile confirmation is not required for action: ${action.kind}`)
  }
  const now = Date.now()
  pruneMobileConfirmations(now)
  const nonce = globalThis.crypto.randomUUID()
  mobileConfirmations.set(nonce, {
    createdAt: now,
    expiresAt: now + MOBILE_CONFIRMATION_TTL_MS,
    signature: getMobileDangerSignature(action),
  })
  return nonce
}

const consumeMobileConfirmationNonce = (action: MobileActionEnvelope) => {
  if (!isDangerousMobileAction(action.kind)) return
  pruneMobileConfirmations()
  const nonce = requireString(action.payload.confirmation_nonce, 'payload.confirmation_nonce')
  const entry = mobileConfirmations.get(nonce)
  mobileConfirmations.delete(nonce)
  if (!entry) throw new BadRequestError('Invalid or expired mobile confirmation nonce')
  if (entry.expiresAt <= Date.now()) {
    throw new BadRequestError('Invalid or expired mobile confirmation nonce')
  }
  if (entry.signature !== getMobileDangerSignature(action)) {
    throw new BadRequestError('Mobile confirmation nonce does not match this action')
  }
}

const pruneMobileActionDedupeCache = (now = Date.now()) => {
  for (const [key, entry] of mobileActionDedupeCache) {
    if (now - entry.createdAt > MOBILE_ACTION_DEDUPE_TTL_MS) {
      mobileActionDedupeCache.delete(key)
    }
  }

  while (mobileActionDedupeCache.size > MOBILE_ACTION_DEDUPE_MAX_ENTRIES) {
    const [oldestKey] = mobileActionDedupeCache.keys()
    if (oldestKey === undefined) break
    mobileActionDedupeCache.delete(oldestKey)
  }
}

const getMobileActionDedupeKey = (action: MobileActionEnvelope) =>
  `${action.workspaceId}:${action.actionId}`

const getMobileActionSignature = (action: MobileActionEnvelope) =>
  JSON.stringify({
    artifact_contract_version: action.artifactContractVersion,
    kind: action.kind,
    payload: action.payload,
    target: action.target,
    workspace_id: action.workspaceId,
  })

const getChatSubmissionIdentity = (action: MobileActionEnvelope) =>
  action.kind === 'chat_submit'
    ? JSON.stringify({
        kind: action.kind,
        target: action.target,
        workspace_id: action.workspaceId,
      })
    : null

const isBodylessChatSubmissionRetry = (
  action: MobileActionEnvelope,
  existing: MobileActionDedupeEntry
) =>
  action.kind === 'chat_submit' &&
  Object.keys(action.payload).length === 0 &&
  existing.chatSubmissionIdentity === getChatSubmissionIdentity(action)

const runMobileActionOnce = async (
  action: MobileActionEnvelope,
  execute: () => Promise<MobileActionResult>
) => {
  pruneMobileActionDedupeCache()
  const key = getMobileActionDedupeKey(action)
  const signature = getMobileActionSignature(action)
  const existing = mobileActionDedupeCache.get(key)
  if (existing) {
    if (existing.signature !== signature && !isBodylessChatSubmissionRetry(action, existing)) {
      throw new BadRequestError(
        `Duplicate mobile action_id with different payload: ${action.actionId}`
      )
    }
    return { duplicate: true, result: await existing.promise }
  }

  const promise = execute().catch((error: unknown) => {
    mobileActionDedupeCache.delete(key)
    throw error
  })
  mobileActionDedupeCache.set(key, {
    chatSubmissionIdentity: getChatSubmissionIdentity(action),
    createdAt: Date.now(),
    promise,
    signature,
  })
  return { duplicate: false, result: await promise }
}

const requireWorkspace = (store: RuntimeStore, workspaceId: string) => {
  if (!store.listWorkspaces().some((workspace) => workspace.id === workspaceId)) {
    throw new BadRequestError(`Workspace not found: ${workspaceId}`)
  }
}

const requireWorkspaceRun = (store: RuntimeStore, workspaceId: string, runId: string) => {
  const run = store
    .listTerminalRuns(workspaceId)
    .find((terminalRun) => terminalRun.run_id === runId)
  if (!run) {
    throw new BadRequestError(`Run not found in workspace: ${runId}`)
  }
  return run
}

const requireWorkspaceAgent = (store: RuntimeStore, workspaceId: string, agentId: string) => {
  const snapshot = store.getWorkspaceSnapshot(workspaceId)
  const agent = snapshot.agents.find((item) => item.id === agentId)
  if (!agent) {
    throw new BadRequestError(`Agent not found in workspace: ${agentId}`)
  }
  return agent
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const waitForAgentRunInactive = async (
  store: RuntimeStore,
  workspaceId: string,
  agentId: string,
  runId: string
) => {
  const deadline = Date.now() + RESTART_STOP_WAIT_MS
  while (Date.now() <= deadline) {
    const activeRun = store.getActiveRunByAgentId(workspaceId, agentId)
    if (!activeRun || activeRun.runId !== runId) return
    await sleep(RESTART_STOP_POLL_MS)
  }
  throw new BadRequestError(`Run did not stop before restart: ${runId}`)
}

const bindMobileAttachments = (
  store: RuntimeStore,
  workspaceId: string,
  bindingId: string,
  attachments: MobileTerminalAttachmentInput[]
) => {
  if (attachments.length === 0) return []
  const workspacePath = store.getWorkspaceSnapshot(workspaceId).summary.path
  return bindMobileArtifactFiles(workspacePath, workspaceId, bindingId, attachments)
}

const bindSingleMobileImageAttachment = (
  store: RuntimeStore,
  workspaceId: string,
  bindingId: string,
  placeholder: string,
  fileId: string
) => {
  const records = bindMobileAttachments(store, workspaceId, bindingId, [{ fileId, placeholder }])
  const [record] = records
  if (!record) throw new BadRequestError(`Mobile attachment not found: ${fileId}`)
  return record
}

const buildMobileImageAttachmentInput = (attachment: MobileAttachmentRecord): string =>
  [
    '[Yive mobile attachment]',
    JSON.stringify({
      artifact: attachment.artifact,
      mime_type: attachment.mime_type,
      name: attachment.name,
      size: attachment.size,
    }),
    'Read this Workspace-relative Artifact directly as image context.',
  ].join('\n')

const buildSafeMobileTerminalInput = (
  input: string,
  attachments: MobileAttachmentRecord[]
): string =>
  [input, ...attachments.map(buildMobileImageAttachmentInput)]
    .filter((part) => part.length > 0)
    .join('\n')

const requireArtifactContractVersion = (action: MobileActionEnvelope) => {
  if (action.artifactContractVersion === MOBILE_ARTIFACT_CONTRACT_VERSION) return
  throw new HttpError(
    426,
    `Mobile attachment actions require Artifact contract version ${MOBILE_ARTIFACT_CONTRACT_VERSION}`,
    'mobile_artifact_contract_upgrade_required'
  )
}

const FILE_REVIEW_DECISION_LABELS: Record<MobileFileReviewDecision, string> = {
  approved: '通过',
  needs_changes: '需要修改',
  rejected: '退回',
}

const buildFileReviewTerminalInput = (input: {
  comment?: string
  decision: MobileFileReviewDecision
  fileName: string
  workspacePath?: string
}) =>
  [
    `手机端文件审核结果：${FILE_REVIEW_DECISION_LABELS[input.decision]}`,
    `文件：${input.workspacePath ?? input.fileName}`,
    ...(input.comment ? [`备注：${input.comment}`] : []),
  ].join('\n')

const executeMobileAction = async (
  request: IncomingMessage,
  store: RuntimeStore,
  action: MobileActionEnvelope
): Promise<MobileActionResult> => {
  requireWorkspace(store, action.workspaceId)

  if (action.kind === 'chat_cancel') {
    return store.cancelChatSubmission(
      action.workspaceId,
      requireString(action.target.submission_id, 'target.submission_id')
    )
  }

  if (action.kind === 'chat_edit') {
    const body = requireString(action.payload.body, 'payload.body')
    if (!body.trim()) throw new BadRequestError('payload.body must contain text')
    if (body.length > 32_000) throw new BadRequestError('payload.body is too long')
    return store.editChatSubmission(
      action.workspaceId,
      requireString(action.target.submission_id, 'target.submission_id'),
      body
    )
  }

  if (action.kind === 'chat_force') {
    const skippedCount = action.payload.skipped_count
    if (!Number.isInteger(skippedCount) || Number(skippedCount) < 0 || Number(skippedCount) > 2) {
      throw new BadRequestError('payload.skipped_count must be an integer from 0 to 2')
    }
    return store.forceChatSubmission(
      action.workspaceId,
      requireString(action.target.submission_id, 'target.submission_id'),
      Number(skippedCount)
    )
  }

  if (action.kind === 'chat_continue') {
    return store.continueChatSubmission(
      action.workspaceId,
      requireString(action.target.submission_id, 'target.submission_id')
    )
  }

  if (action.kind === 'chat_migrate') {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        action.actionId
      )
    ) {
      throw new BadRequestError('action_id must be a UUID for chat_migrate')
    }
    return store.migrateChatSubmission(
      action.workspaceId,
      requireString(action.target.submission_id, 'target.submission_id'),
      requireString(action.target.conversation_id, 'target.conversation_id'),
      action.actionId
    )
  }

  if (action.kind === 'chat_dismiss_conversation') {
    return store.dismissAgentConversation(
      action.workspaceId,
      requireString(action.target.agent_id, 'target.agent_id'),
      requireString(action.target.conversation_id, 'target.conversation_id')
    )
  }

  if (action.kind === 'chat_submit') {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        action.actionId
      )
    ) {
      throw new BadRequestError('action_id must be a UUID for chat_submit')
    }
    const conversationId = requireString(action.target.conversation_id, 'target.conversation_id')
    const body =
      action.payload.body === undefined
        ? undefined
        : requireString(action.payload.body, 'payload.body')
    if (body !== undefined && !body.trim()) {
      throw new BadRequestError('payload.body must contain text')
    }
    if (body !== undefined && body.length > 32_000) {
      throw new BadRequestError('payload.body is too long')
    }
    const attachmentFileIds = parseMobileChatAttachmentIds(action.payload.attachments)
    if (body === undefined && attachmentFileIds.length === 0) {
      throw new BadRequestError('payload.body or payload.attachments is required')
    }
    return store.submitChatMessage({
      attachmentFileIds,
      ...(body === undefined ? {} : { body }),
      conversationId,
      id: action.actionId,
      workspaceId: action.workspaceId,
    })
  }

  if (action.kind === 'file_review') {
    const fileId = requireString(action.target.file_id, 'target.file_id')
    const item = getMobileFileExchangeItem(fileId)
    if (!item) throw new BadRequestError(`Mobile file not found: ${fileId}`)
    if (item.workspaceId && item.workspaceId !== action.workspaceId) {
      throw new BadRequestError(`Mobile file belongs to another Workspace: ${fileId}`)
    }
    const decision = requireFileReviewDecision(action.payload.decision)
    const comment = parseOptionalFileReviewComment(action.payload.comment)
    const runId =
      action.target.run_id === undefined
        ? undefined
        : requireString(action.target.run_id, 'target.run_id')
    let bytes: number | undefined
    if (runId !== undefined) {
      requireWorkspaceRun(store, action.workspaceId, runId)
      const terminalInput = buildFileReviewTerminalInput({
        ...(comment ? { comment } : {}),
        decision,
        fileName: item.name,
        ...(item.workspacePath ? { workspacePath: item.workspacePath } : {}),
      })
      store.writeRunInput(runId, terminalInput)
      bytes = Buffer.byteLength(terminalInput)
    }
    return {
      ...(bytes !== undefined ? { bytes } : {}),
      ...(comment ? { comment } : {}),
      decision,
      file_id: item.id,
      name: item.name,
      ...(runId ? { run_id: runId } : {}),
      source: item.source,
      ...(item.workspacePath ? { workspace_path: item.workspacePath } : {}),
    }
  }

  if (action.kind === 'terminal_input') {
    const runId = requireString(action.target.run_id, 'target.run_id')
    const attachmentInputs = parseMobileTerminalAttachments(action.payload.attachments)
    if (typeof action.payload.input !== 'string') {
      throw new BadRequestError('payload.input is required')
    }
    const input = action.payload.input
    if (input.length === 0 && attachmentInputs.length === 0) {
      throw new BadRequestError('payload.input is required')
    }
    requireWorkspaceRun(store, action.workspaceId, runId)
    if (attachmentInputs.length > 0) requireArtifactContractVersion(action)
    const attachments = bindMobileAttachments(
      store,
      action.workspaceId,
      action.actionId,
      attachmentInputs
    )
    const safeInput =
      attachments.length > 0 ? buildSafeMobileTerminalInput(input, attachments) : input
    store.writeRunInput(runId, safeInput)
    return {
      ...(attachments.length > 0
        ? {
            attachments: attachments.map((attachment) => ({
              file_id: attachment.file_id,
              placeholder: attachment.placeholder,
              artifact: attachment.artifact,
            })),
          }
        : {}),
      bytes: Buffer.byteLength(safeInput),
      run_id: runId,
    }
  }

  if (action.kind === 'native_image_paste') {
    const runId = requireString(action.target.run_id, 'target.run_id')
    const fileId = requireString(action.payload.file_id, 'payload.file_id')
    const placeholder = requireString(action.payload.placeholder, 'payload.placeholder')
    if (!/^\[Image #\d+\]$/u.test(placeholder)) {
      throw new BadRequestError(`Invalid image placeholder: ${placeholder}`)
    }
    requireWorkspaceRun(store, action.workspaceId, runId)
    requireArtifactContractVersion(action)
    const attachment = bindSingleMobileImageAttachment(
      store,
      action.workspaceId,
      action.actionId,
      placeholder,
      fileId
    )
    let fallbackReason: string | undefined
    if (shouldUseNativeImagePaste()) {
      try {
        await pasteMobileImageToNativeClipboard(attachment.local_path)
        store.writeRunInput(runId, '\x16')
        return {
          attachment: {
            file_id: attachment.file_id,
            placeholder: attachment.placeholder,
            artifact: attachment.artifact,
          },
          input: 'ctrl_v',
          run_id: runId,
        }
      } catch (error) {
        fallbackReason = describeNativeImagePasteFallback(error)
        // Fall through to the file-reference prompt. Cloud runtimes usually have no GUI clipboard.
      }
    } else {
      fallbackReason = describeNativeImagePasteFallback(null)
    }

    const input = buildMobileImageAttachmentInput(attachment)
    store.writeRunInput(runId, input)
    return {
      attachment: {
        file_id: attachment.file_id,
        placeholder: attachment.placeholder,
        artifact: attachment.artifact,
      },
      bytes: Buffer.byteLength(input),
      ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
      input: 'server_attachment_prompt',
      run_id: runId,
    }
  }

  if (action.kind === 'start_run') {
    const agentId = requireString(action.target.agent_id, 'target.agent_id')
    requireWorkspaceAgent(store, action.workspaceId, agentId)
    const run = await store.startAgentForUser(action.workspaceId, agentId, {
      hivePort: getRuntimePort(request),
    })
    return {
      agent_id: agentId,
      run_id: run.runId,
      status: run.status,
    }
  }

  if (action.kind === 'bind_current_session') {
    const agentId = requireString(action.target.agent_id, 'target.agent_id')
    requireWorkspaceAgent(store, action.workspaceId, agentId)
    const result = store.refreshAgentSessionBinding(action.workspaceId, agentId)
    return {
      agent_id: agentId,
      capture_source: result.captureSource,
      failure_reason: result.failureReason,
      previous_session_id: result.previousSessionId,
      request_id: result.requestId,
      run_id: result.runId,
      session_id: result.sessionId,
      state: result.state,
      unchanged: result.unchanged,
    }
  }

  if (action.kind === 'team_send') {
    const to = requireString(action.target.to, 'target.to')
    const text = requireString(action.payload.text, 'payload.text')
    const orchestratorId = getOrchestratorId(action.workspaceId)
    requireWorkspaceAgent(store, action.workspaceId, orchestratorId)
    const result = await store.dispatchTaskByWorkerName(action.workspaceId, to, text, {
      fromAgentId: orchestratorId,
      hivePort: getRuntimePort(request),
    })
    return {
      dispatch_id: result.id,
      start_error: result.startError,
      to,
      worker_started: result.workerStarted,
    }
  }

  if (action.kind === 'team_note') {
    const dispatchId = requireString(action.target.dispatch_id, 'target.dispatch_id')
    const text = requireString(action.payload.text, 'payload.text')
    if (action.payload.force !== undefined) {
      throw new BadRequestError('force delivery is not supported for Dispatch Notes')
    }
    const result = await store.appendDispatchNote(action.workspaceId, {
      actorId: 'mobile-user',
      actorType: 'user',
      artifacts: parseMobileArtifacts(action.payload.artifacts),
      dispatchId,
      id: action.actionId,
      text,
    })
    return {
      created: result.created,
      delivery_state: result.note.deliveryState,
      dispatch_id: result.note.dispatchId,
      note_id: result.note.id,
    }
  }

  if (action.kind === 'team_status') {
    const agentId = requireString(action.target.agent_id, 'target.agent_id')
    const text = requireString(action.payload.text, 'payload.text')
    const agent = requireWorkspaceAgent(store, action.workspaceId, agentId)
    if (agent.kind !== 'worker') throw new BadRequestError('Only a Worker can publish Status')
    if (action.target.dispatch_id !== undefined) {
      throw new BadRequestError('Mobile Status binds automatically; dispatch_id is not accepted')
    }
    if (action.payload.notify !== undefined && typeof action.payload.notify !== 'boolean') {
      throw new BadRequestError('payload.notify must be a boolean')
    }
    const result = store.statusTask(action.workspaceId, agentId, {
      artifacts: parseMobileArtifacts(action.payload.artifacts),
      notify: action.payload.notify === true,
      requestId: action.actionId,
      text,
    })
    return {
      agent_id: agentId,
      dispatch_id: result.status.dispatchId,
      notify: result.status.notify,
      request_id: result.status.requestId,
      updated_at: result.status.createdAt,
    }
  }

  if (action.kind === 'team_report') {
    const agentId = requireString(action.target.agent_id, 'target.agent_id')
    const text = requireString(action.payload.text, 'payload.text')
    const agent = requireWorkspaceAgent(store, action.workspaceId, agentId)
    if (agent.kind !== 'worker') throw new BadRequestError('Only a Worker can submit a Report')
    if (action.target.dispatch_id !== undefined || action.payload.status !== undefined) {
      throw new BadRequestError(
        'Mobile Report binds automatically and uses outcome; legacy dispatch_id/status is not accepted'
      )
    }
    const outcome = action.payload.outcome ?? 'completed'
    if (outcome !== 'completed' && outcome !== 'failed') {
      throw new BadRequestError('payload.outcome must be completed or failed')
    }
    const result = store.reportTask(action.workspaceId, agentId, {
      artifacts: parseMobileArtifacts(action.payload.artifacts),
      outcome,
      requestId: action.actionId,
      text,
    })
    return {
      agent_id: agentId,
      dispatch_id: result.dispatch?.id ?? null,
      outcome: result.dispatch?.reportOutcome ?? outcome,
      reported_at: result.dispatch?.reportedAt ?? null,
      request_id: result.dispatch?.reportRequestId ?? action.actionId,
    }
  }

  if (action.kind === 'team_cancel') {
    const dispatchId = requireString(action.target.dispatch_id, 'target.dispatch_id')
    const reason = requireString(action.payload.reason, 'payload.reason')
    const orchestratorId = getOrchestratorId(action.workspaceId)
    requireWorkspaceAgent(store, action.workspaceId, orchestratorId)
    consumeMobileConfirmationNonce(action)
    const result = await store.cancelTask(action.workspaceId, dispatchId, {
      fromAgentId: orchestratorId,
      reason,
      requestId: action.actionId,
    })
    return {
      dispatch_id: result.dispatch?.id ?? null,
      forward_error: result.forwardError,
      forwarded: result.forwarded,
    }
  }

  if (action.kind === 'team_replace') {
    const dispatchId = requireString(action.target.dispatch_id, 'target.dispatch_id')
    const text = requireString(action.payload.text, 'payload.text')
    if (action.payload.interrupt !== undefined && typeof action.payload.interrupt !== 'boolean') {
      throw new BadRequestError('payload.interrupt must be a boolean')
    }
    const orchestratorId = getOrchestratorId(action.workspaceId)
    requireWorkspaceAgent(store, action.workspaceId, orchestratorId)
    consumeMobileConfirmationNonce(action)
    const result = await store.replaceTask(action.workspaceId, dispatchId, {
      artifacts: parseMobileArtifacts(action.payload.artifacts),
      fromAgentId: orchestratorId,
      interrupt: action.payload.interrupt === true,
      requestId: action.actionId,
      text,
    })
    return {
      dispatch_id: result.dispatch.id,
      replaced_dispatch_id: result.replacedDispatch.id,
      request_id: result.dispatch.requestId,
    }
  }

  if (action.kind === 'stop_run') {
    const runId = requireString(action.target.run_id, 'target.run_id')
    const mode = action.target.mode ?? 'safe'
    if (mode !== 'safe' && mode !== 'checkpoint' && mode !== 'force') {
      throw new BadRequestError(`Unsupported stop mode: ${String(mode)}`)
    }
    consumeMobileConfirmationNonce(action)
    requireWorkspaceRun(store, action.workspaceId, runId)
    rememberMobileRunTranscript(store, action.workspaceId, runId)
    const result = await store.stopAgentRunSafely(runId, { mode })
    return {
      mode: result.mode,
      reason: result.reason,
      run_id: result.runId,
      session_id: result.sessionId,
      state: result.state,
    }
  }

  const agentId = requireString(action.target.agent_id, 'target.agent_id')
  requireWorkspaceAgent(store, action.workspaceId, agentId)
  const runId =
    action.target.run_id === undefined
      ? undefined
      : requireString(action.target.run_id, 'target.run_id')
  if (runId !== undefined) {
    requireWorkspaceRun(store, action.workspaceId, runId)
    consumeMobileConfirmationNonce(action)
    rememberMobileRunTranscript(store, action.workspaceId, runId)
    store.stopAgentRun(runId)
    await waitForAgentRunInactive(store, action.workspaceId, agentId, runId)
  } else {
    consumeMobileConfirmationNonce(action)
  }
  const run = await store.startAgentForUser(action.workspaceId, agentId, {
    hivePort: getRuntimePort(request),
  })
  return {
    agent_id: agentId,
    stopped_run_id: runId ?? null,
    run_id: run.runId,
    status: run.status,
  }
}

const getMobileTranscriptQuery = (request: IncomingMessage) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  return {
    workspaceId: requireString(url.searchParams.get('workspace_id'), 'workspace_id'),
    runId: requireString(url.searchParams.get('run_id'), 'run_id'),
  }
}

const validateMobileConfirmationTarget = (
  store: RuntimeStore,
  confirmation: {
    kind: MobileActionKind
    target: Record<string, unknown>
    workspaceId: string
  }
) => {
  requireWorkspace(store, confirmation.workspaceId)
  if (confirmation.kind === 'stop_run') {
    const runId = requireString(confirmation.target.run_id, 'target.run_id')
    requireWorkspaceRun(store, confirmation.workspaceId, runId)
    return
  }
  if (confirmation.kind === 'restart_run') {
    const agentId = requireString(confirmation.target.agent_id, 'target.agent_id')
    requireWorkspaceAgent(store, confirmation.workspaceId, agentId)
    if (confirmation.target.run_id !== undefined) {
      const runId = requireString(confirmation.target.run_id, 'target.run_id')
      requireWorkspaceRun(store, confirmation.workspaceId, runId)
    }
    return
  }
  if (confirmation.kind === 'team_cancel' || confirmation.kind === 'team_replace') {
    const dispatchId = requireString(confirmation.target.dispatch_id, 'target.dispatch_id')
    if (
      !store.listDispatches(confirmation.workspaceId).some((dispatch) => dispatch.id === dispatchId)
    ) {
      throw new BadRequestError(`Dispatch not found in workspace: ${dispatchId}`)
    }
    return
  }
  throw new BadRequestError(`Mobile confirmation is not required for action: ${confirmation.kind}`)
}

const buildMobileActionEcho = (
  action: MobileActionEnvelope,
  result: unknown
): MobileActionEchoInput | null => {
  if (
    action.kind === 'chat_cancel' ||
    action.kind === 'chat_continue' ||
    action.kind === 'chat_migrate' ||
    action.kind === 'chat_dismiss_conversation' ||
    action.kind === 'chat_edit' ||
    action.kind === 'chat_force' ||
    action.kind === 'chat_submit'
  ) {
    return null
  }
  const echo: MobileActionEchoInput = {
    actionId: action.actionId,
    ...(isDangerousMobileAction(action.kind) ? { confirmed: true } : {}),
    kind: action.kind,
    workspaceId: action.workspaceId,
  }
  const resultRecord = isRecord(result) ? result : {}
  const attachments = Array.isArray(resultRecord.attachments)
    ? resultRecord.attachments.flatMap((item) =>
        isRecord(item) && typeof item.file_id === 'string' && typeof item.placeholder === 'string'
          ? [{ file_id: item.file_id, placeholder: item.placeholder }]
          : []
      )
    : []
  const singleAttachment =
    isRecord(resultRecord.attachment) &&
    typeof resultRecord.attachment.file_id === 'string' &&
    typeof resultRecord.attachment.placeholder === 'string'
      ? [
          {
            file_id: resultRecord.attachment.file_id,
            placeholder: resultRecord.attachment.placeholder,
          },
        ]
      : []
  attachments.push(...singleAttachment)
  if (attachments.length > 0) echo.attachments = attachments
  if (typeof resultRecord.bytes === 'number') echo.bytes = resultRecord.bytes
  if (
    action.kind === 'file_review' &&
    typeof resultRecord.file_id === 'string' &&
    typeof resultRecord.decision === 'string'
  ) {
    echo.fileReview = {
      ...(typeof resultRecord.comment === 'string' ? { comment: resultRecord.comment } : {}),
      decision: resultRecord.decision,
      file_id: resultRecord.file_id,
      ...(typeof resultRecord.name === 'string' ? { name: resultRecord.name } : {}),
      ...(typeof resultRecord.workspace_path === 'string'
        ? { workspace_path: resultRecord.workspace_path }
        : {}),
    }
  }
  if (typeof resultRecord.run_id === 'string') {
    echo.runId = resultRecord.run_id
  } else if (typeof action.target.run_id === 'string') {
    echo.runId = action.target.run_id
  }
  return echo
}

export const mobileRoutes: RouteDefinition[] = [
  route('POST', '/api/mobile/push-tokens', async ({ request, response, store }) => {
    const access = requireMobileOrUiTokenFromRequest(request, store)
    const registrationInput = parseMobilePushToken(await readJsonBody<MobilePushTokenBody>(request))
    const workspaceIds = registrationInput.workspaceIds ?? access.workspaceIds
    for (const workspaceId of workspaceIds ?? []) {
      assertMobileWorkspaceAccess(access, workspaceId)
    }
    const registration = store.registerMobilePushToken({
      ...(registrationInput.appId !== undefined ? { appId: registrationInput.appId } : {}),
      ...(registrationInput.deviceId !== undefined ? { deviceId: registrationInput.deviceId } : {}),
      platform: registrationInput.platform,
      token: registrationInput.token,
      ...(workspaceIds !== undefined ? { workspaceIds } : {}),
    })

    sendJson(response, 201, {
      ok: true,
      push_token: {
        app_id: registration.app_id ?? null,
        created_at: registration.created_at,
        device_id: registration.device_id ?? null,
        id: registration.id,
        platform: registration.platform,
        updated_at: registration.updated_at,
        workspace_ids: registration.workspace_ids ?? null,
      },
    })
  }),
  route('POST', '/api/mobile/notifications', async ({ request, response, store }) => {
    const access = requireMobileOrUiTokenFromRequest(request, store)
    const notificationInput = parseMobileNotification(
      await readJsonBody<MobileNotificationBody>(request)
    )
    assertMobileWorkspaceAccess(access, notificationInput.workspaceId)
    const { feishu, fcm, notification, wechat, xiaomi } = await sendMobileNotification({
      body: notificationInput.body,
      ...(notificationInput.imagePath ? { imagePath: notificationInput.imagePath } : {}),
      store,
      title: notificationInput.title,
      workspaceId: notificationInput.workspaceId,
    })
    sendJson(response, 201, {
      feishu,
      fcm,
      ok: true,
      notification,
      wechat,
      workspace_id: notificationInput.workspaceId,
      xiaomi,
    })
  }),
  route('POST', '/api/mobile/confirmations', async ({ request, response, store }) => {
    const access = requireMobileOrUiTokenFromRequest(request, store)
    const confirmation = parseMobileConfirmation(
      await readJsonBody<MobileConfirmationBody>(request)
    )
    assertMobileWorkspaceAccess(access, confirmation.workspaceId)
    validateMobileConfirmationTarget(store, confirmation)
    const nonce = createMobileConfirmationNonce(confirmation)

    sendJson(response, 201, {
      expires_in_ms: MOBILE_CONFIRMATION_TTL_MS,
      kind: confirmation.kind,
      nonce,
      ok: true,
      workspace_id: confirmation.workspaceId,
    })
  }),
  route('POST', '/api/mobile/actions', async ({ request, response, store }) => {
    const access = requireMobileOrUiTokenFromRequest(request, store)
    const action = parseMobileAction(await readJsonBody<MobileActionBody>(request))
    assertMobileWorkspaceAccess(access, action.workspaceId)
    const { duplicate, result } = await runMobileActionOnce(action, () =>
      executeMobileAction(request, store, action)
    )
    const echo = duplicate ? null : buildMobileActionEcho(action, result)
    if (echo) recordMobileActionEcho(echo)

    sendJson(response, 202, {
      ok: true,
      action_id: action.actionId,
      ...(action.artifactContractVersion !== null
        ? { artifact_contract_version: action.artifactContractVersion }
        : {}),
      workspace_id: action.workspaceId,
      kind: action.kind,
      ...(duplicate ? { duplicate: true } : {}),
      result,
    })
  }),
  route('GET', '/api/mobile/transcript', ({ request, response, store }) => {
    const access = requireMobileOrUiTokenFromRequest(request, store)
    const query = getMobileTranscriptQuery(request)
    assertMobileWorkspaceAccess(access, query.workspaceId)
    sendJson(response, 200, buildMobileTranscript(store, query.workspaceId, query.runId))
  }),
  route(
    'GET',
    '/api/mobile/agents/:agentId/conversation',
    ({ params, request, response, store }) => {
      const access = requireMobileOrUiTokenFromRequest(request, store)
      const agentId = getRequiredParam(response, params, 'agentId', 'Agent id is required')
      if (!agentId) return
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const workspaceId = requireString(url.searchParams.get('workspace_id'), 'workspace_id')
      assertMobileWorkspaceAccess(access, workspaceId)
      sendJson(response, 200, {
        conversation: store.getCurrentAgentConversation(
          workspaceId,
          agentId,
          30,
          url.searchParams.get('cursor')
        ),
      })
    }
  ),
  route(
    'GET',
    '/api/mobile/agents/:agentId/conversations',
    ({ params, request, response, store }) => {
      const access = requireMobileOrUiTokenFromRequest(request, store)
      const agentId = getRequiredParam(response, params, 'agentId', 'Agent id is required')
      if (!agentId) return
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const workspaceId = requireString(url.searchParams.get('workspace_id'), 'workspace_id')
      assertMobileWorkspaceAccess(access, workspaceId)
      sendJson(
        response,
        200,
        store.listAgentConversations(workspaceId, agentId, url.searchParams.get('cursor'))
      )
    }
  ),
  route(
    'GET',
    '/api/mobile/agents/:agentId/conversations/:conversationId',
    ({ params, request, response, store }) => {
      const access = requireMobileOrUiTokenFromRequest(request, store)
      const agentId = getRequiredParam(response, params, 'agentId', 'Agent id is required')
      const conversationId = getRequiredParam(
        response,
        params,
        'conversationId',
        'Conversation id is required'
      )
      if (!agentId || !conversationId) return
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const workspaceId = requireString(url.searchParams.get('workspace_id'), 'workspace_id')
      assertMobileWorkspaceAccess(access, workspaceId)
      sendJson(response, 200, {
        conversation: store.getAgentConversation(
          workspaceId,
          agentId,
          conversationId,
          url.searchParams.get('cursor')
        ),
      })
    }
  ),
  route(
    'DELETE',
    '/api/mobile/agents/:agentId/conversations/:conversationId',
    ({ params, request, response, store }) => {
      const access = requireMobileOrUiTokenFromRequest(request, store)
      const agentId = getRequiredParam(response, params, 'agentId', 'Agent id is required')
      const conversationId = getRequiredParam(
        response,
        params,
        'conversationId',
        'Conversation id is required'
      )
      if (!agentId || !conversationId) return
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const workspaceId = requireString(url.searchParams.get('workspace_id'), 'workspace_id')
      assertMobileWorkspaceAccess(access, workspaceId)
      sendJson(response, 200, store.dismissAgentConversation(workspaceId, agentId, conversationId))
    }
  ),
  route('GET', '/api/mobile/dispatches', ({ request, response, store }) => {
    const access = requireMobileOrUiTokenFromRequest(request, store)
    const query = getMobileDispatchesQuery(request)
    assertMobileWorkspaceAccess(access, query.workspaceId)
    const dispatches = store.listDispatches(query.workspaceId, { limit: query.limit })
    const latestStatuses = store.getLatestStatuses(query.workspaceId, [
      ...new Set(dispatches.map((dispatch) => dispatch.toAgentId)),
    ])
    sendJson(
      response,
      200,
      dispatches.map((dispatch) =>
        serializeDispatchRecord(dispatch, latestStatuses.get(dispatch.toAgentId))
      )
    )
  }),
  route('GET', '/api/mobile/snapshot', ({ request, response, store }) => {
    const access = requireMobileOrUiTokenFromRequest(request, store)
    sendJson(response, 200, buildMobileSnapshot(request, store, access))
  }),
]

const getMobileDispatchesQuery = (request: IncomingMessage) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const rawLimit = url.searchParams.get('limit')
  return {
    limit: rawLimit && /^(0|[1-9][0-9]*)$/.test(rawLimit) ? Math.min(Number(rawLimit), 100) : 25,
    workspaceId: requireString(url.searchParams.get('workspace_id'), 'workspace_id'),
  }
}
