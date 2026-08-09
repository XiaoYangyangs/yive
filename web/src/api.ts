import type { OpenTargetId, OpenWorkspaceErrorCode } from '../../src/shared/open-targets.js'
import type {
  AgentProvider,
  AgentSessionSaveState,
  AgentStopMode,
  AgentStopResultPayload,
  AgentSummary,
  AgentSummaryPayload,
  MobileChatSubmission,
  MobileConversationHistoryPage,
  MobileConversationPage,
  MobileDispatchItem,
  MobileFileDownloadProgressHandler,
  MobileFileExchangeItem,
  MobileFileReviewDecision,
  MobileRecordedConversationPage,
  MobileTeamActionResult,
  MobileTerminalAttachment,
  MobileTranscript,
  MobileFileDownload as SharedMobileFileDownload,
  MobileFileDownloadProgress as SharedMobileFileDownloadProgress,
  TeamListItem,
  TeamListItemPayload,
  TerminalRunSummary,
  WorkspaceSummary,
} from '../../src/shared/types.js'
import { MOBILE_ARTIFACT_CONTRACT_VERSION } from '../../src/shared/types.js'
import { fromAgentSummaryPayload, fromTeamListItemPayload } from './agent-payload.js'
import { createBrowserId } from './browser-id.js'

export type {
  MobileConversationPage,
  MobileDispatchItem,
  MobileFileExchangeItem,
  MobileFileReviewDecision,
  MobileTeamActionResult,
  MobileTerminalAttachment,
  MobileTranscript,
  MobileTranscriptEvent,
  OpenTargetId,
  OpenWorkspaceErrorCode,
  TerminalInputProfile,
  TerminalRunSummary,
} from '../../src/shared/types.js'

export type MobileFileDownload = SharedMobileFileDownload<Blob>
export type MobileFileDownloadProgress = SharedMobileFileDownloadProgress
export type { MobileFileDownloadProgressHandler }

const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error.trim()) return body.error
  } catch {
    // Keep the original fallback when the server did not send a JSON error body.
  }
  return fallback
}

export class MobileActionRequestError extends Error {
  readonly code: string | undefined
  readonly statusCode: number

  constructor(statusCode: number, code: string | undefined, message: string) {
    super(message)
    this.name = 'MobileActionRequestError'
    this.code = code
    this.statusCode = statusCode
  }
}

const readErrorCode = async (response: Response): Promise<string | undefined> => {
  try {
    const body = (await response.json()) as { code?: unknown }
    return typeof body.code === 'string' ? body.code : undefined
  } catch {
    return undefined
  }
}

const isStaleUiSession = async (response: Response): Promise<boolean> => {
  if (response.status !== 403) return false
  try {
    const body = (await response.clone().json()) as { error?: unknown }
    return body.error === 'UI endpoint requires valid UI token'
  } catch {
    return false
  }
}

export const initializeUiSession = async (): Promise<void> => {
  const response = await fetch('/api/ui/session', { mode: 'same-origin' })
  if (!response.ok) {
    throw new Error('Failed to initialize UI session')
  }
  await response.json()
}

let uiSessionRefreshPromise: Promise<void> | null = null

const refreshUiSession = (): Promise<void> => {
  uiSessionRefreshPromise ??= initializeUiSession().finally(() => {
    uiSessionRefreshPromise = null
  })
  return uiSessionRefreshPromise
}

const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await fetch(input, init)
  if (!(await isStaleUiSession(response))) return response

  await refreshUiSession()
  return fetch(input, init)
}

const parseContentLength = (response: Response): number | null => {
  const value = response.headers.get('content-length')
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export const readResponseBlobWithProgress = async (
  response: Response,
  mimeType: string,
  onProgress?: MobileFileDownloadProgressHandler
): Promise<Blob> => {
  const totalBytes = parseContentLength(response)
  onProgress?.({ loadedBytes: 0, totalBytes })

  if (!response.body) {
    const blob = await response.blob()
    onProgress?.({ loadedBytes: blob.size, totalBytes: totalBytes ?? blob.size })
    return blob
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let loadedBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    loadedBytes += value.byteLength
    onProgress?.({ loadedBytes, totalBytes })
  }

  onProgress?.({ loadedBytes, totalBytes: totalBytes ?? loadedBytes })
  return new Blob(chunks, { type: mimeType })
}

export const listWorkspaces = async (): Promise<WorkspaceSummary[]> => {
  const response = await apiFetch('/api/workspaces')

  if (!response.ok) {
    throw new Error('Failed to load workspaces')
  }

  return (await response.json()) as WorkspaceSummary[]
}

export interface VersionInfo {
  currentVersion: string
  installHint: string
  latestVersion: string
  packageName: string
  releaseUrl: string
  updateAvailable: boolean
}

interface VersionInfoPayload {
  current_version: string
  install_hint: string
  latest_version: string
  package_name: string
  release_url: string
  update_available: boolean
}

export const getVersionInfo = async (): Promise<VersionInfo> => {
  const response = await apiFetch('/api/version')

  if (!response.ok) {
    throw new Error('Failed to load version info')
  }

  const payload = (await response.json()) as VersionInfoPayload
  return {
    currentVersion: payload.current_version,
    installHint: payload.install_hint,
    latestVersion: payload.latest_version,
    packageName: payload.package_name,
    releaseUrl: payload.release_url,
    updateAvailable: payload.update_available,
  }
}

export interface OrchestratorStartResult {
  ok: boolean
  error: string | null
  run_id: string | null
}

export interface AgentStartResult {
  error: string | null
  ok: boolean
  runId: string | null
}

interface AgentStartPayload {
  error: string | null
  ok: boolean
  run_id: string | null
}

export interface CreateWorkerResult {
  agentStart: AgentStartResult
  worker: TeamListItem
}

type CreateWorkerPayload = TeamListItemPayload & { agent_start?: AgentStartPayload }

export interface CreateWorkspaceResponse extends WorkspaceSummary {
  orchestrator_start: OrchestratorStartResult
}

export const createWorkspace = async (input: {
  name: string
  path: string
  autostart_orchestrator?: boolean
  provider?: AgentProvider
}): Promise<CreateWorkspaceResponse> => {
  const response = await apiFetch('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create workspace'))
  }

  return (await response.json()) as CreateWorkspaceResponse
}

export const deleteWorkspace = async (workspaceId: string): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}`, { method: 'DELETE' })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete workspace'))
  }
}

export const startAgentRun = async (
  workspaceId: string,
  agentId: string
): Promise<{ runId: string }> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/agents/${agentId}/start`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to start agent run'))
  }
  const body = (await response.json()) as { run_id: string }
  return { runId: body.run_id }
}

export const stopAgentRun = async (
  runId: string,
  mode: AgentStopMode = 'safe'
): Promise<AgentStopResultPayload> => {
  const response = await apiFetch(`/api/runtime/runs/${runId}/stop`, {
    body: JSON.stringify({ mode }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to stop agent run'))
  }
  return (await response.json()) as AgentStopResultPayload
}

export const restartAgentRun = async (
  workspaceId: string,
  agentId: string,
  runId: string
): Promise<{ runId: string }> => {
  // Best-effort stop: a 404 here often means the run already exited on its
  // own; either way we proceed to start a fresh one. Swallowed errors land in
  // the dev console for diagnosis.
  const stopped = await stopAgentRun(runId).catch((error: unknown) => {
    console.error('[hive] swallowed:restartAgentRun.stop', error)
    return null
  })
  if (stopped && stopped.state !== 'stopped') {
    throw new Error('Agent must be safely stopped before it can restart')
  }
  return startAgentRun(workspaceId, agentId)
}

export interface AgentSessionBindResult {
  capture_source: string | null
  failure_reason: string | null
  previous_session_id: string | null
  request_id: string | null
  run_id: string | null
  session_id: string | null
  state: AgentSessionSaveState
  unchanged: boolean
}

export const bindAgentCurrentSession = async (
  workspaceId: string,
  agentId: string
): Promise<AgentSessionBindResult> => {
  const response = await apiFetch(
    `/api/workspaces/${workspaceId}/agents/${agentId}/session/refresh`,
    { method: 'POST' }
  )
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to bind current session'))
  }
  return (await response.json()) as AgentSessionBindResult
}

export const startMobileAgentRun = async (
  workspaceId: string,
  agentId: string
): Promise<{ runId: string }> => {
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: createBrowserId('start-run'),
      kind: 'start_run',
      target: { agent_id: agentId },
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to start agent run'))
  }
  const body = (await response.json()) as { result: { run_id: string } }
  return { runId: body.result.run_id }
}

export const createMobileConfirmation = async (
  workspaceId: string,
  kind: 'restart_run' | 'stop_run' | 'team_cancel' | 'team_replace',
  target: Record<string, unknown>
): Promise<{ nonce: string }> => {
  const response = await apiFetch('/api/mobile/confirmations', {
    body: JSON.stringify({
      kind,
      target,
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to confirm mobile action'))
  }
  const body = (await response.json()) as { nonce: string }
  return { nonce: body.nonce }
}

export const stopMobileAgentRun = async (
  workspaceId: string,
  runId: string,
  mode: AgentStopMode = 'safe'
): Promise<AgentStopResultPayload> => {
  const target = mode === 'safe' ? { run_id: runId } : { mode, run_id: runId }
  const { nonce } = await createMobileConfirmation(workspaceId, 'stop_run', target)
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: createBrowserId('stop-run'),
      kind: 'stop_run',
      payload: { confirmation_nonce: nonce },
      target,
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to stop agent run'))
  }
  const body = (await response.json()) as {
    result?: AgentStopResultPayload | { run_id?: string }
  }
  if (body.result && 'state' in body.result) return body.result
  if (body.result?.run_id) {
    return {
      mode,
      reason: null,
      run_id: body.result.run_id,
      session_id: null,
      state: 'stopped',
    }
  }
  throw new Error('Stop action did not return a run result')
}

export const restartMobileAgentRun = async (
  workspaceId: string,
  agentId: string,
  runId: string
): Promise<{ runId: string }> => {
  const target = { agent_id: agentId, run_id: runId }
  const { nonce } = await createMobileConfirmation(workspaceId, 'restart_run', target)
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: createBrowserId('restart-run'),
      kind: 'restart_run',
      payload: { confirmation_nonce: nonce },
      target,
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to restart agent run'))
  }
  const body = (await response.json()) as { result: { run_id: string } }
  return { runId: body.result.run_id }
}

export interface MobileSessionBindResult {
  agent_id: string
  capture_source: string | null
  failure_reason: string | null
  previous_session_id: string | null
  request_id: string | null
  run_id: string | null
  session_id: string | null
  state: AgentSessionSaveState
  unchanged: boolean
}

export const bindMobileCurrentSession = async (
  workspaceId: string,
  agentId: string
): Promise<MobileSessionBindResult> => {
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: createBrowserId('bind-session'),
      kind: 'bind_current_session',
      target: { agent_id: agentId },
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to bind current session'))
  }
  const body = (await response.json()) as { result: MobileSessionBindResult }
  return body.result
}

export const getActiveWorkspaceId = async (): Promise<string | null> => {
  const response = await apiFetch('/api/settings/app-state/active_workspace_id')

  if (!response.ok) {
    throw new Error('Failed to load active workspace')
  }

  const payload = (await response.json()) as { key: string; value: string | null }
  return payload.value
}

export const saveActiveWorkspaceId = async (workspaceId: string | null): Promise<void> => {
  const response = await apiFetch('/api/settings/app-state/active_workspace_id', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: workspaceId }),
  })

  if (!response.ok) {
    throw new Error('Failed to save active workspace')
  }
}

export const listWorkers = async (workspaceId: string): Promise<TeamListItem[]> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/team`, {
    mode: 'same-origin',
  })

  if (!response.ok) {
    throw new Error('Failed to load workers')
  }

  const payload = (await response.json()) as TeamListItemPayload[]
  return payload.map(fromTeamListItemPayload)
}

export const getAgentSummary = async (
  workspaceId: string,
  agentId: string
): Promise<AgentSummary> => {
  const response = await apiFetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`
  )
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to load agent'))
  return fromAgentSummaryPayload((await response.json()) as AgentSummaryPayload)
}

export const renameAgent = async (
  workspaceId: string,
  agentId: string,
  name: string
): Promise<AgentSummary> => {
  const response = await apiFetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`,
    {
      body: JSON.stringify({ name }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
    }
  )
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to rename agent'))
  return fromAgentSummaryPayload((await response.json()) as AgentSummaryPayload)
}

export const listMobileDispatches = async (
  workspaceId: string,
  limit = 25
): Promise<MobileDispatchItem[]> => {
  const response = await apiFetch(
    `/api/mobile/dispatches?workspace_id=${encodeURIComponent(workspaceId)}&limit=${encodeURIComponent(
      String(limit)
    )}`,
    { mode: 'same-origin' }
  )

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load mobile dispatches'))
  }

  return (await response.json()) as MobileDispatchItem[]
}

export const getMobileTranscript = async (
  workspaceId: string,
  runId: string
): Promise<MobileTranscript> => {
  const response = await apiFetch(
    `/api/mobile/transcript?workspace_id=${encodeURIComponent(
      workspaceId
    )}&run_id=${encodeURIComponent(runId)}`,
    { mode: 'same-origin' }
  )

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load mobile transcript'))
  }

  return (await response.json()) as MobileTranscript
}

export const getCurrentMobileConversation = async (
  workspaceId: string,
  agentId: string,
  cursor?: number
): Promise<MobileConversationPage | null> => {
  const query = new URLSearchParams({ workspace_id: workspaceId })
  if (cursor !== undefined) query.set('cursor', String(cursor))
  const response = await apiFetch(
    `/api/mobile/agents/${encodeURIComponent(agentId)}/conversation?${query}`,
    { mode: 'same-origin' }
  )
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load mobile conversation'))
  }
  const body = (await response.json()) as { conversation: MobileConversationPage | null }
  return body.conversation
}

export const listMobileRecordedConversations = async (
  workspaceId: string,
  agentId: string,
  cursor?: string
): Promise<MobileConversationHistoryPage> => {
  const query = new URLSearchParams({ workspace_id: workspaceId })
  if (cursor) query.set('cursor', cursor)
  const response = await apiFetch(
    `/api/mobile/agents/${encodeURIComponent(agentId)}/conversations?${query}`
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to load conversations'))
  return response.json() as Promise<MobileConversationHistoryPage>
}

export const getMobileRecordedConversation = async (
  workspaceId: string,
  agentId: string,
  conversationId: string,
  cursor?: string
): Promise<MobileRecordedConversationPage | null> => {
  const query = new URLSearchParams({ workspace_id: workspaceId })
  if (cursor) query.set('cursor', cursor)
  const response = await apiFetch(
    `/api/mobile/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}?${query}`
  )
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to load conversation'))
  return ((await response.json()) as { conversation: MobileRecordedConversationPage | null })
    .conversation
}

export const dismissMobileRecordedConversation = async (
  workspaceId: string,
  agentId: string,
  conversationId: string
) => {
  const response = await apiFetch(
    `/api/mobile/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}?workspace_id=${encodeURIComponent(workspaceId)}`,
    { method: 'DELETE' }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to remove conversation'))
}

export const submitMobileChatMessage = async (
  workspaceId: string,
  conversationId: string,
  body: string | undefined,
  submissionId: string,
  attachments: Array<{ file_id: string }> = []
): Promise<MobileChatSubmission> => {
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: submissionId,
      kind: 'chat_submit',
      payload: {
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(body === undefined ? {} : { body }),
      },
      target: { conversation_id: conversationId },
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    const [message, code] = await Promise.all([
      readErrorMessage(response.clone(), 'Failed to submit Chat message'),
      readErrorCode(response),
    ])
    throw new MobileActionRequestError(response.status, code, message)
  }
  const result = (await response.json()) as {
    result: MobileChatSubmission
  }
  return result.result
}

const updateMobileChatSubmission = async (
  workspaceId: string,
  submissionId: string,
  kind: 'chat_cancel' | 'chat_edit',
  body?: string
): Promise<MobileChatSubmission> => {
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: createBrowserId(kind),
      kind,
      ...(body === undefined ? {} : { payload: { body } }),
      target: { submission_id: submissionId },
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update Chat submission'))
  }
  return ((await response.json()) as { result: MobileChatSubmission }).result
}

export const cancelMobileChatSubmission = (workspaceId: string, submissionId: string) =>
  updateMobileChatSubmission(workspaceId, submissionId, 'chat_cancel')

export const continueMobileChatSubmission = async (
  workspaceId: string,
  submissionId: string
): Promise<MobileChatSubmission> => {
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: createBrowserId('chat-continue'),
      kind: 'chat_continue',
      target: { submission_id: submissionId },
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to continue Chat submission'))
  }
  return ((await response.json()) as { result: MobileChatSubmission }).result
}

export const migrateMobileChatSubmission = async (
  workspaceId: string,
  submissionId: string,
  targetConversationId: string
): Promise<MobileChatSubmission> => {
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: globalThis.crypto.randomUUID(),
      kind: 'chat_migrate',
      target: { conversation_id: targetConversationId, submission_id: submissionId },
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to migrate Chat submission'))
  }
  return ((await response.json()) as { result: MobileChatSubmission }).result
}

export const editMobileChatSubmission = (workspaceId: string, submissionId: string, body: string) =>
  updateMobileChatSubmission(workspaceId, submissionId, 'chat_edit', body)

export const forceMobileChatSubmission = async (
  workspaceId: string,
  submissionId: string,
  expectedSkippedCount: number
): Promise<MobileChatSubmission> => {
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: createBrowserId('chat-force'),
      kind: 'chat_force',
      payload: { skipped_count: expectedSkippedCount },
      target: { submission_id: submissionId },
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to force Chat submission'))
  }
  return ((await response.json()) as { result: MobileChatSubmission }).result
}

export const sendMobileTerminalInput = async (
  workspaceId: string,
  runId: string,
  input: string,
  attachments: MobileTerminalAttachment[] = [],
  actionId = createBrowserId('terminal-input')
): Promise<void> => {
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: actionId,
      ...(attachments.length > 0
        ? { artifact_contract_version: MOBILE_ARTIFACT_CONTRACT_VERSION }
        : {}),
      kind: 'terminal_input',
      payload: attachments.length > 0 ? { attachments, input } : { input },
      target: { run_id: runId },
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to send terminal input'))
  }
}

export const sendMobileFileReview = async (
  workspaceId: string,
  fileId: string,
  decision: MobileFileReviewDecision,
  input: {
    actionId?: string
    comment?: string
    runId?: string
  } = {}
): Promise<{ decision: MobileFileReviewDecision; file_id: string; run_id?: string }> => {
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: input.actionId ?? createBrowserId('file-review'),
      kind: 'file_review',
      payload: {
        ...(input.comment ? { comment: input.comment } : {}),
        decision,
      },
      target: {
        file_id: fileId,
        ...(input.runId ? { run_id: input.runId } : {}),
      },
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to send file review'))
  }

  const body = (await response.json()) as {
    result?: { decision: MobileFileReviewDecision; file_id: string; run_id?: string }
  }
  return body.result ?? { decision, file_id: fileId }
}

const readMobileActionResult = async (response: Response, fallback: string) => {
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, fallback))
  }
  const body = (await response.json()) as { result?: MobileTeamActionResult }
  return body.result ?? { dispatch_id: null }
}

export const sendMobileTeamTask = async (
  workspaceId: string,
  to: string,
  text: string,
  actionId = createBrowserId('team-send')
): Promise<MobileTeamActionResult> => {
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: actionId,
      kind: 'team_send',
      payload: { text },
      target: { to },
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  return readMobileActionResult(response, 'Failed to send team task')
}

export const sendMobileTeamNote = async (
  workspaceId: string,
  dispatchId: string,
  text: string,
  input: {
    actionId?: string
    artifacts?: string[]
  } = {}
): Promise<MobileTeamActionResult> => {
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: input.actionId ?? createBrowserId('team-note'),
      kind: 'team_note',
      payload: {
        ...(input.artifacts && input.artifacts.length > 0 ? { artifacts: input.artifacts } : {}),
        text,
      },
      target: { dispatch_id: dispatchId },
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  return readMobileActionResult(response, 'Failed to send Dispatch Note')
}

export const sendMobileTeamStatus = async (
  workspaceId: string,
  agentId: string,
  text: string,
  input: {
    actionId?: string
    artifacts?: string[]
    notify?: boolean
  } = {}
): Promise<MobileTeamActionResult> => {
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: input.actionId ?? createBrowserId('team-status'),
      kind: 'team_status',
      payload: {
        ...(input.artifacts && input.artifacts.length > 0 ? { artifacts: input.artifacts } : {}),
        ...(input.notify ? { notify: true } : {}),
        text,
      },
      target: { agent_id: agentId },
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  return readMobileActionResult(response, 'Failed to send team status')
}

export const sendMobileTeamReport = async (
  workspaceId: string,
  agentId: string,
  text: string,
  input: {
    actionId?: string
    artifacts?: string[]
    outcome?: 'completed' | 'failed'
  } = {}
): Promise<MobileTeamActionResult> => {
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: input.actionId ?? createBrowserId('team-report'),
      kind: 'team_report',
      payload: {
        ...(input.artifacts && input.artifacts.length > 0 ? { artifacts: input.artifacts } : {}),
        ...(input.outcome ? { outcome: input.outcome } : {}),
        text,
      },
      target: { agent_id: agentId },
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  return readMobileActionResult(response, 'Failed to send team report')
}

export const cancelMobileTeamTask = async (
  workspaceId: string,
  dispatchId: string,
  reason: string,
  actionId = createBrowserId('team-cancel')
): Promise<MobileTeamActionResult> => {
  const target = { dispatch_id: dispatchId }
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: actionId,
      kind: 'team_cancel',
      payload: {
        confirmation_nonce: (await createMobileConfirmation(workspaceId, 'team_cancel', target))
          .nonce,
        reason,
      },
      target,
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  return readMobileActionResult(response, 'Failed to cancel team task')
}

export const replaceMobileTeamTask = async (
  workspaceId: string,
  dispatchId: string,
  text: string,
  input: { actionId?: string; artifacts?: string[]; interrupt?: boolean } = {}
): Promise<MobileTeamActionResult> => {
  const target = { dispatch_id: dispatchId }
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: input.actionId ?? createBrowserId('team-replace'),
      kind: 'team_replace',
      payload: {
        ...(input.artifacts && input.artifacts.length > 0 ? { artifacts: input.artifacts } : {}),
        confirmation_nonce: (await createMobileConfirmation(workspaceId, 'team_replace', target))
          .nonce,
        ...(input.interrupt ? { interrupt: true } : {}),
        text,
      },
      target,
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  return readMobileActionResult(response, 'Failed to replace team task')
}

export const pasteMobileImageAttachment = async (
  workspaceId: string,
  runId: string,
  fileId: string,
  placeholder: string
): Promise<{
  fallback_reason?: string
  input?: 'ctrl_v' | 'server_attachment_prompt' | string
}> => {
  const response = await apiFetch('/api/mobile/actions', {
    body: JSON.stringify({
      action_id: createBrowserId('native-image-paste'),
      artifact_contract_version: MOBILE_ARTIFACT_CONTRACT_VERSION,
      kind: 'native_image_paste',
      payload: { file_id: fileId, placeholder },
      target: { run_id: runId },
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to paste image attachment'))
  }
  const body = (await response.json()) as {
    result?: { fallback_reason?: string; input?: 'ctrl_v' | 'server_attachment_prompt' | string }
  }
  return body.result ?? {}
}

export const workspaceShellAgentId = (workspaceId: string): string => `${workspaceId}:shell`

export const isWorkspaceShellRun = (run: TerminalRunSummary, workspaceId: string): boolean =>
  run.agent_id === workspaceShellAgentId(workspaceId)

export const startWorkspaceShell = async (workspaceId: string): Promise<TerminalRunSummary> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/shell/start`, {
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to start workspace terminal'))
  }

  return (await response.json()) as TerminalRunSummary
}

export const closeWorkspaceShell = async (workspaceId: string, runId: string): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/shell/${runId}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to close workspace terminal'))
  }
}

export const listTerminalRuns = async (workspaceId: string): Promise<TerminalRunSummary[]> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/runs`, {
    mode: 'same-origin',
  })

  if (!response.ok) {
    throw new Error('Failed to load terminal runs')
  }

  return (await response.json()) as TerminalRunSummary[]
}

export const createWorker = async (
  workspaceId: string,
  input: Pick<AgentSummary, 'name'> & {
    autostart?: boolean
    provider?: AgentProvider
  }
): Promise<CreateWorkerResult> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create worker'))
  }

  const payload = (await response.json()) as CreateWorkerPayload
  return {
    agentStart: {
      error: payload.agent_start?.error ?? null,
      ok: payload.agent_start?.ok ?? false,
      runId: payload.agent_start?.run_id ?? null,
    },
    worker: fromTeamListItemPayload(payload),
  }
}

export const deleteWorker = async (workspaceId: string, workerId: string): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers/${workerId}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete worker'))
  }
}

export const stopWorker = async (workspaceId: string, workerId: string): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers/${workerId}/stop`, {
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to stop worker'))
  }
}

export const renameWorker = async (
  workspaceId: string,
  workerId: string,
  name: string
): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers/${workerId}`, {
    body: JSON.stringify({ name }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to rename worker'))
  }
}

export interface FsBrowseEntryPayload {
  is_dir: true
  is_git_repository: boolean
  name: string
  path: string
}

export interface FsBrowseResponse {
  current_path: string
  entries: FsBrowseEntryPayload[]
  error: string | null
  ok: boolean
  parent_path: string | null
  root_path: string
}

export interface FsProbeResponse {
  current_branch: string | null
  exists: boolean
  is_dir: boolean
  is_git_repository: boolean
  ok: boolean
  path: string
  suggested_name: string
}

export const browseFs = async (path: string): Promise<FsBrowseResponse> => {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const response = await apiFetch(`/api/fs/browse${query}`, { mode: 'same-origin' })
  const body = (await response.json()) as FsBrowseResponse
  return body
}

export const probeFs = async (path: string): Promise<FsProbeResponse> => {
  const response = await apiFetch(`/api/fs/probe?path=${encodeURIComponent(path)}`, {
    mode: 'same-origin',
  })
  return (await response.json()) as FsProbeResponse
}

export interface PickFolderResponse {
  canceled: boolean
  error: string | null
  path: string | null
  probe: FsProbeResponse | null
  supported: boolean
}

export const pickFolder = async (): Promise<PickFolderResponse> => {
  const response = await apiFetch('/api/fs/pick-folder', {
    method: 'POST',
    mode: 'same-origin',
  })
  return (await response.json()) as PickFolderResponse
}

export type OpenWorkspaceResult =
  | { ok: true; effectiveTargetId: OpenTargetId }
  | { ok: false; effectiveTargetId: OpenTargetId; errorCode: OpenWorkspaceErrorCode }

interface OpenWorkspaceSuccessPayload {
  ok: true
  effective_target_id: OpenTargetId
}

interface OpenWorkspaceFailurePayload {
  ok: false
  effective_target_id: OpenTargetId
  error_code: OpenWorkspaceErrorCode
}

export const openWorkspaceInEditor = async (
  workspaceId: string,
  targetId: OpenTargetId
): Promise<OpenWorkspaceResult> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/open`, {
    body: JSON.stringify({ target_id: targetId }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  // 200 success and 502 service failure both return structured JSON we can
  // surface; only true transport / 4xx failures (workspace gone, target id
  // tampered) throw.
  if (response.status === 200) {
    const body = (await response.json()) as OpenWorkspaceSuccessPayload
    return { ok: true, effectiveTargetId: body.effective_target_id }
  }
  if (response.status === 502) {
    const body = (await response.json()) as OpenWorkspaceFailurePayload
    return {
      ok: false,
      effectiveTargetId: body.effective_target_id,
      errorCode: body.error_code,
    }
  }
  throw new Error(await readErrorMessage(response, 'Failed to open workspace'))
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export const fileToBase64 = async (file: File): Promise<string> => {
  if (typeof file.arrayBuffer === 'function') {
    return bytesToBase64(new Uint8Array(await file.arrayBuffer()))
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const commaIndex = result.indexOf(',')
      resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1))
    }
    reader.readAsDataURL(file)
  })
}

export const listMobileFiles = async (): Promise<MobileFileExchangeItem[]> => {
  const response = await apiFetch('/api/mobile/files', { mode: 'same-origin' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load mobile files'))
  }
  return (await response.json()) as MobileFileExchangeItem[]
}

export const uploadMobileFile = async (
  workspaceId: string,
  file: File
): Promise<MobileFileExchangeItem> => {
  const contentBase64 = await fileToBase64(file)
  const response = await apiFetch('/api/mobile/files', {
    body: JSON.stringify({
      content_base64: contentBase64,
      name: file.name,
      workspace_id: workspaceId,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to upload mobile file'))
  }
  return (await response.json()) as MobileFileExchangeItem
}

export const sendWorkspaceFileToMobile = async (
  workspaceId: string,
  path: string
): Promise<MobileFileExchangeItem> => {
  const response = await apiFetch('/api/mobile/files/from-workspace', {
    body: JSON.stringify({ path, workspace_id: workspaceId }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to send workspace file to mobile'))
  }
  return (await response.json()) as MobileFileExchangeItem
}

export const deleteMobileFile = async (fileId: string): Promise<void> => {
  const response = await apiFetch(`/api/mobile/files/${fileId}`, { method: 'DELETE' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete mobile file'))
  }
}

export const clearMobileFiles = async (): Promise<void> => {
  const response = await apiFetch('/api/mobile/files', { method: 'DELETE' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to clear mobile files'))
  }
}

export const downloadMobileFile = async (
  fileId: string,
  onProgress?: MobileFileDownloadProgressHandler
): Promise<MobileFileDownload> => {
  const response = await apiFetch(`/api/mobile/files/${fileId}`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to download mobile file'))
  }
  const disposition = response.headers.get('content-disposition') ?? ''
  const nameMatch = /filename="([^"]+)"/u.exec(disposition)
  const mimeType = response.headers.get('content-type') ?? 'application/octet-stream'
  return {
    content: await readResponseBlobWithProgress(response, mimeType, onProgress),
    mime_type: mimeType,
    name: nameMatch?.[1] ?? fileId,
  }
}

export const downloadMobileChatAttachment = async (
  workspaceId: string,
  submissionId: string,
  fileId: string,
  onProgress?: MobileFileDownloadProgressHandler
): Promise<MobileFileDownload> => {
  const query = new URLSearchParams({
    submission_id: submissionId,
    workspace_id: workspaceId,
  })
  const response = await apiFetch(`/api/mobile/files/${fileId}?${query.toString()}`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to download Chat attachment'))
  }
  const disposition = response.headers.get('content-disposition') ?? ''
  const nameMatch = /filename="([^"]+)"/u.exec(disposition)
  const mimeType = response.headers.get('content-type') ?? 'application/octet-stream'
  return {
    content: await readResponseBlobWithProgress(response, mimeType, onProgress),
    mime_type: mimeType,
    name: nameMatch?.[1] ?? fileId,
  }
}
