export type AgentProcessState = 'crashed' | 'running' | 'stopped'
export type AgentConversationActivity = 'busy' | 'idle' | 'unknown'

export interface AgentRuntimeState {
  activeDispatchId: string | null
  conversationActivity: AgentConversationActivity
  lastObservedAt: number
  processState: AgentProcessState
  queuePauseReason: string | null
  queuedDispatchCount: number
}

export type AgentKind = 'orchestrator' | 'worker'

export type ConversationProvider = 'claude' | 'codex'
export type AgentProvider = ConversationProvider

export type AgentStopMode = 'checkpoint' | 'force' | 'safe'

export type AgentSessionSaveState = 'failed' | 'saved' | 'unresolved' | 'waiting'

export interface AgentStopResultPayload {
  mode: AgentStopMode
  reason: string | null
  run_id: string
  session_id: string | null
  state: 'checkpoint_required' | 'failed' | 'stopped'
}

export interface WorkspaceSummary {
  id: string
  name: string
  path: string
}

export interface AgentIdentity {
  id: string
  workspaceId: string
  name: string
  kind: AgentKind
}

export interface AgentSummary extends AgentIdentity, AgentRuntimeState {}

export interface TeamListItem {
  id: string
  name: string
  kind: 'worker'
  activeDispatchId: string | null
  conversationActivity: AgentConversationActivity
  lastObservedAt: number
  processState: AgentProcessState
  queuePauseReason: string | null
  queuedDispatchCount: number
  /**
   * Last raw line printed to the worker's PTY. Surfaced on the worker card for UI hints only —
   * not a worker reply. Real replies arrive as [Hive 系统消息] entries on orchestrator stdin.
   */
  lastPtyLine?: string
  /** Managed Provider used to launch this Agent. */
  provider?: AgentProvider
  /** Verified conversation source used by mobile Chat. */
  conversationProvider?: ConversationProvider
}

/** Wire shape for one authenticated Agent identity outside the worker team list. */
export interface AgentSummaryPayload {
  active_dispatch_id: string | null
  conversation_activity: AgentConversationActivity
  id: string
  kind: AgentKind
  last_observed_at: number
  name: string
  process_state: AgentProcessState
  queue_pause_reason: string | null
  queued_dispatch_count: number
  workspace_id: string
}

/**
 * Wire payload shape for /api/workspaces/:id/team and worker-creation responses.
 * Per AGENTS.md §8 + spec §3.3 line 162-179, HTTP JSON is snake_case.
 * Internal TS code uses TeamListItem (camelCase); serializers/deserializers convert.
 */
export interface TeamListItemPayload {
  active_dispatch_id: string | null
  conversation_activity: AgentConversationActivity
  id: string
  name: string
  kind: 'worker'
  last_observed_at: number
  process_state: AgentProcessState
  queue_pause_reason: string | null
  queued_dispatch_count: number
  last_pty_line: string | null
  provider: AgentProvider | null
  conversation_provider?: ConversationProvider | null
}

export type TerminalInputProfile = 'default'

export interface TerminalRunSummary {
  agent_id: string
  agent_name: string
  run_id: string
  status: string
  terminal_input_profile?: TerminalInputProfile
}

export interface MobileSnapshotWorkspace extends WorkspaceSummary {
  is_active?: boolean
}

export interface MobileSnapshotAgentPayload {
  active_dispatch_id: string | null
  active_run_id: string | null
  provider?: AgentProvider | null
  conversation_provider?: ConversationProvider | null
  id: string
  last_pty_line: string | null
  name: string
  conversation_activity: AgentConversationActivity
  kind: AgentKind
  last_observed_at: number
  process_state: AgentProcessState
  queue_pause_reason: string | null
  queued_dispatch_count: number
}

export interface MobileDispatchSummary {
  counts: Record<
    'cancelled' | 'queued' | 'reported' | 'replaced' | 'replacement_pending' | 'submitted',
    number
  >
  pending_count: number
  recent: unknown[]
  total_count: number
}

export interface MobileConnectionSnapshot {
  auth: {
    http: string
    websocket: string
    workspace_ids?: string[]
    workspace_scope: 'all' | 'selected'
  }
  health: {
    heartbeat_interval_ms: number
    stale_after_ms: number
    version_endpoint: string
  }
  lan: {
    dev_lan_enabled: boolean
    private_network_only: boolean
    relay_enabled: boolean
  }
  relay?: {
    desktop_id?: string
    mobile_device_id?: string
  }
  request: {
    host: string | null
    origin: string | null
    remote_address: string | null
  }
  websocket: {
    mobile_events_path: string
    terminal_control_path_template: string
    terminal_io_path_template: string
  }
}

export interface MobileSnapshotActiveWorkspace {
  dispatch_summary: MobileDispatchSummary
  orchestrator: MobileSnapshotAgentPayload
  terminal_runs: TerminalRunSummary[]
  workspace: WorkspaceSummary
  workers: MobileSnapshotAgentPayload[]
}

export interface MobileSnapshot {
  active_workspace: MobileSnapshotActiveWorkspace | null
  active_workspace_id: string | null
  connection: MobileConnectionSnapshot
  generated_at: number
  notifications: MobileAgentNotification[]
  workspaces: MobileSnapshotWorkspace[]
}

export interface MobileAgentNotification {
  body: string
  created_at: number
  id: string
  image?: {
    file_id: string
    mime_type: string
    name: string
    size: number
  }
  source: 'agent'
  title: string
  workspace_id: string
}

export interface MobilePushTokenRegistration {
  app_id?: string
  created_at: number
  device_id?: string
  id: string
  platform: 'fcm' | 'xiaomi'
  token: string
  updated_at: number
  workspace_ids?: string[]
}

export interface MobileConversationInvalidation {
  activity_state: 'busy' | 'idle' | 'unknown'
  agent_id: string
  conversation_id: string
  cursor: number
  type: 'conversation-invalidated'
  workspace_id: string
}

export type MobileEventsServerMessage =
  | { snapshot: MobileSnapshot; type: 'mobile-snapshot' }
  | { generated_at: number; type: 'mobile-heartbeat' }
  | MobileConversationInvalidation

export interface MobileTerminalAttachment {
  file_id: string
  placeholder: string
}

export interface MobileTeamActionResult {
  agent_id?: string
  created?: boolean
  delivery_state?: 'delivered' | 'delivering' | 'failed' | 'queued'
  dispatch_id: string | null
  note_id?: string
  notify?: boolean
  outcome?: 'completed' | 'failed'
  reported_at?: number | null
  request_id?: string
  to?: string
  updated_at?: number
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

export type MobileFileReviewDecision = 'approved' | 'needs_changes' | 'rejected'

export interface MobileDispatchItem {
  artifacts: ArtifactReference[]
  created_at: number
  delivered_at: number | null
  from_agent_id: string | null
  id: string
  latest_status?: {
    artifacts: ArtifactReference[]
    notify: boolean
    request_id: string
    text: string
    updated_at: number
  } | null
  lifecycle?: {
    attempts: number
    error: string | null
    kind: 'cancel' | 'replace'
    request_id: string | null
    state: 'waiting_for_idle' | 'blocked' | 'delivering_replacement' | 'completed'
    updated_at: number | null
  }
  queue_position?: number
  reported_at: number | null
  report_outcome?: 'completed' | 'failed' | null
  report_text: string | null
  replaced_by?: string | null
  replaces_dispatch_id?: string | null
  state: 'cancelled' | 'queued' | 'reported' | 'replaced' | 'replacement_pending' | 'submitted'
  submitted_at: number | null
  text: string
  to_agent_id: string
  workspace_id: string
}

export type MobileTranscriptEventType =
  | 'attachment'
  | 'dispatch'
  | 'mobile_action_echo'
  | 'report'
  | 'status'
  | 'terminal_output'

export interface MobileTranscriptAttachment {
  created_at: number
  file_id: string
  mime_type: string
  name: string
  placeholder: string
  size: number
}

export interface MobileTranscriptRun {
  agent_id: string
  agent_name: string
  exit_code: number | null
  status: string
  terminal_input_profile: TerminalInputProfile
}

export interface MobileTranscriptEventBase {
  created_at: number
  id: string
  type: MobileTranscriptEventType
}

export interface MobileTranscriptStatusEvent extends MobileTranscriptEventBase {
  run_id: string
  status: string
  type: 'status'
}

export interface MobileTranscriptOutputEvent extends MobileTranscriptEventBase {
  raw_summary: string
  run_id: string
  text: string
  truncated: boolean
  type: 'terminal_output'
}

export interface MobileTranscriptActionEchoEvent extends MobileTranscriptEventBase {
  attachments: Array<Pick<MobileTranscriptAttachment, 'file_id' | 'placeholder'>>
  bytes: number | null
  confirmed: boolean
  file_review?: {
    comment?: string
    decision: MobileFileReviewDecision
    file_id: string
    name?: string
    workspace_path?: string
  }
  kind:
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
  run_id?: string
  text?: string
  truncated?: boolean
  type: 'mobile_action_echo'
}

export interface MobileTranscriptAttachmentEvent extends MobileTranscriptEventBase {
  attachment: MobileTranscriptAttachment
  run_id: string
  type: 'attachment'
}

export interface MobileTranscriptMessageEvent extends MobileTranscriptEventBase {
  artifacts?: ArtifactReference[]
  from_agent_id?: string | null
  outcome?: 'completed' | 'failed'
  text: string
  to_agent_id?: string
  truncated: boolean
  type: 'dispatch' | 'report' | 'status'
}

export type MobileTranscriptEvent =
  | MobileTranscriptActionEchoEvent
  | MobileTranscriptAttachmentEvent
  | MobileTranscriptMessageEvent
  | MobileTranscriptOutputEvent
  | MobileTranscriptStatusEvent

export interface MobileTranscript {
  attachments: MobileTranscriptAttachment[]
  events: MobileTranscriptEvent[]
  generated_at: number
  run: MobileTranscriptRun
  run_id: string
  workspace_id: string
}

export interface MobileFileExchangeItem {
  created_at: number
  expires_at?: number
  id: string
  mime_type: string
  name: string
  size: number
  source?: 'uploaded' | 'workspace'
  workspace_path?: string
}

export interface MobileFileDownload<TContent = unknown> {
  content: TContent
  mime_type: string
  name: string
}

export interface MobileFileDownloadProgress {
  loadedBytes: number
  totalBytes: number | null
}

export type MobileFileDownloadProgressHandler = (progress: MobileFileDownloadProgress) => void

export interface MobileRuntimeDashboard {
  orchestrator?: AgentSummary
  runs: TerminalRunSummary[]
  workers: TeamListItem[]
}

export interface MobileConversationTurn {
  provider_event_id: string
  role: 'assistant' | 'user'
  sequence: number
  source_checkpoint?: number
  text: string
}

export interface MobileConversationToolActivity {
  completed_at: number | null
  duration_ms: number | null
  label: string
  provider_event_id: string
  sequence: number
  source_checkpoint: number
  started_at: number
  status: 'completed' | 'failed' | 'running'
}

declare const artifactReferenceBrand: unique symbol
export type ArtifactReference = string & { readonly [artifactReferenceBrand]: true }
export const MOBILE_ARTIFACT_CONTRACT_VERSION = 2

export interface MobileChatAttachment {
  artifact: ArtifactReference
  file_id: string
  mime_type: string
  name: string
  placeholder: string
  size: number
}

export interface MobileChatSubmission {
  accepted_at: number
  attachments: MobileChatAttachment[]
  body: string
  cancelled_at: number | null
  confirmed_at: number | null
  conversation_id: string
  delivered_at: number | null
  error_code: string | null
  id: string
  provider_event_id: string | null
  provider_turn_sequence: number | null
  paused_at: number | null
  pause_reason: string | null
  queue_sequence: number | null
  state: 'cancelled' | 'confirmed' | 'delivered' | 'paused' | 'queued' | 'sending' | 'undelivered'
}

export interface MobileConversationPage {
  activity_state: 'busy' | 'idle' | 'unknown'
  agent_id: string
  cli_session_id: string
  cursor?: number
  id: string
  observed_at: number
  provider: 'claude' | 'codex'
  recording_boundary: number
  source_checkpoint: number
  stale: boolean
  submissions: MobileChatSubmission[]
  tool_activity?: MobileConversationToolActivity[]
  turns: MobileConversationTurn[]
  workspace_id: string
}

export interface MobileConversationHistoryItem {
  active: boolean
  cli_session_id: string
  id: string
  provider: 'claude' | 'codex'
  started_at: number
  title: string
}

export interface MobileConversationHistoryPage {
  items: MobileConversationHistoryItem[]
  next_cursor: string | null
}

export interface MobileRecordedConversationPage extends MobileConversationPage {
  active: boolean
  next_cursor: string | null
}

export interface MobileEventsSubscription {
  dispose: () => void
}

export interface MobileEventsReconnectMeta {
  attempt: number
  nextDelayMs: number
}

export interface MobileEventsSubscriptionOptions {
  onClose?: (message: string, meta?: MobileEventsReconnectMeta) => void
  onConversationInvalidated?: (invalidation: MobileConversationInvalidation) => void
  onError?: (error: Error) => void
  onHeartbeat?: (generatedAt: number) => void
  onSnapshot: (snapshot: MobileSnapshot) => void
}

export interface MobileRuntimeClientContract<TUploadFile = unknown, TDownloadContent = unknown> {
  cancelChatSubmission(workspaceId: string, submissionId: string): Promise<MobileChatSubmission>
  continueChatSubmission(workspaceId: string, submissionId: string): Promise<MobileChatSubmission>
  migrateChatSubmission(
    workspaceId: string,
    submissionId: string,
    targetConversationId: string
  ): Promise<MobileChatSubmission>
  cancelTeamTask(
    workspaceId: string,
    dispatchId: string,
    reason: string,
    actionId?: string
  ): Promise<MobileTeamActionResult>
  replaceTeamTask(
    workspaceId: string,
    dispatchId: string,
    text: string,
    input?: { actionId?: string; artifacts?: string[]; interrupt?: boolean }
  ): Promise<MobileTeamActionResult>
  clearFiles(): Promise<void>
  deleteFile(fileId: string): Promise<void>
  downloadFile(
    fileId: string,
    onProgress?: MobileFileDownloadProgressHandler
  ): Promise<MobileFileDownload<TDownloadContent>>
  downloadChatAttachment(
    workspaceId: string,
    submissionId: string,
    fileId: string,
    onProgress?: MobileFileDownloadProgressHandler
  ): Promise<MobileFileDownload<TDownloadContent>>
  editChatSubmission(
    workspaceId: string,
    submissionId: string,
    body: string
  ): Promise<MobileChatSubmission>
  forceChatSubmission(
    workspaceId: string,
    submissionId: string,
    expectedSkippedCount: number
  ): Promise<MobileChatSubmission>
  getTranscript(workspaceId: string, runId: string): Promise<MobileTranscript>
  getCurrentConversation(
    workspaceId: string,
    agentId: string,
    cursor?: number
  ): Promise<MobileConversationPage | null>
  getRecordedConversation(
    workspaceId: string,
    agentId: string,
    conversationId: string,
    cursor?: string
  ): Promise<MobileRecordedConversationPage | null>
  listRecordedConversations(
    workspaceId: string,
    agentId: string,
    cursor?: string
  ): Promise<MobileConversationHistoryPage>
  dismissRecordedConversation(
    workspaceId: string,
    agentId: string,
    conversationId: string
  ): Promise<void>
  listDashboard(workspaceId: string): Promise<MobileRuntimeDashboard>
  listDispatches(workspaceId: string): Promise<MobileDispatchItem[]>
  listFiles(): Promise<MobileFileExchangeItem[]>
  listWorkspaces(): Promise<WorkspaceSummary[]>
  pasteImageAttachment(
    workspaceId: string,
    runId: string,
    fileId: string,
    placeholder: string
  ): Promise<{ fallback_reason?: string; input?: 'ctrl_v' | 'server_attachment_prompt' | string }>
  restartAgentRun(workspaceId: string, agentId: string, runId: string): Promise<{ runId: string }>
  bindCurrentSession(workspaceId: string, agentId: string): Promise<MobileSessionBindResult>
  reviewFile(
    workspaceId: string,
    fileId: string,
    decision: MobileFileReviewDecision,
    input?: { actionId?: string; comment?: string; runId?: string }
  ): Promise<{ decision: MobileFileReviewDecision; file_id: string; run_id?: string }>
  sendTeamNote(
    workspaceId: string,
    dispatchId: string,
    text: string,
    input?: {
      actionId?: string
      artifacts?: string[]
    }
  ): Promise<MobileTeamActionResult>
  sendTeamReport(
    workspaceId: string,
    agentId: string,
    text: string,
    input?: {
      actionId?: string
      artifacts?: string[]
      outcome?: 'completed' | 'failed'
    }
  ): Promise<MobileTeamActionResult>
  sendTeamStatus(
    workspaceId: string,
    agentId: string,
    text: string,
    input?: {
      actionId?: string
      artifacts?: string[]
      notify?: boolean
    }
  ): Promise<MobileTeamActionResult>
  sendTeamTask(
    workspaceId: string,
    to: string,
    text: string,
    actionId?: string
  ): Promise<MobileTeamActionResult>
  submitChatMessage(
    workspaceId: string,
    conversationId: string,
    body: string | undefined,
    submissionId: string,
    attachments?: Array<Pick<MobileChatAttachment, 'file_id'>>
  ): Promise<MobileChatSubmission>
  sendTerminalInput(
    workspaceId: string,
    runId: string,
    input: string,
    attachments?: MobileTerminalAttachment[],
    actionId?: string
  ): Promise<void>
  sendWorkspaceFileToMobile(workspaceId: string, path: string): Promise<MobileFileExchangeItem>
  startAgentRun(workspaceId: string, agentId: string): Promise<{ runId: string }>
  stopAgentRun(
    workspaceId: string,
    runId: string,
    mode?: AgentStopMode
  ): Promise<AgentStopResultPayload>
  subscribeMobileEvents?(options: MobileEventsSubscriptionOptions): MobileEventsSubscription
  uploadFile(workspaceId: string, file: TUploadFile): Promise<MobileFileExchangeItem>
}
