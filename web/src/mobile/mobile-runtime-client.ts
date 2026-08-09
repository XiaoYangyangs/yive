import type {
  MobileChatSubmission,
  MobileRuntimeClientContract,
} from '../../../src/shared/types.js'
import { MOBILE_ARTIFACT_CONTRACT_VERSION } from '../../../src/shared/types.js'
import { fromTeamListItemPayload } from '../agent-payload.js'
import {
  bindMobileCurrentSession,
  cancelMobileChatSubmission,
  cancelMobileTeamTask,
  clearMobileFiles,
  continueMobileChatSubmission,
  deleteMobileFile,
  dismissMobileRecordedConversation,
  downloadMobileChatAttachment,
  downloadMobileFile,
  editMobileChatSubmission,
  fileToBase64,
  forceMobileChatSubmission,
  getCurrentMobileConversation,
  getMobileRecordedConversation,
  getMobileTranscript,
  listMobileDispatches,
  listMobileFiles,
  listMobileRecordedConversations,
  listTerminalRuns,
  listWorkers,
  listWorkspaces,
  type MobileFileReviewDecision,
  migrateMobileChatSubmission,
  pasteMobileImageAttachment,
  replaceMobileTeamTask,
  restartMobileAgentRun,
  sendMobileFileReview,
  sendMobileTeamNote,
  sendMobileTeamReport,
  sendMobileTeamStatus,
  sendMobileTeamTask,
  sendMobileTerminalInput,
  sendWorkspaceFileToMobile,
  startMobileAgentRun,
  stopMobileAgentRun,
  submitMobileChatMessage,
  uploadMobileFile,
} from '../api.js'
import { createBrowserId } from '../browser-id.js'
import type { RelayMobileClient } from '../relay-api.js'
import { createMobileEventsClient } from './mobile-events-client.js'
import {
  readRelayActionResult,
  readRelayAgentStopResult,
  readRelayConfirmationNonce,
  readRelayRunId,
  readRelayTeamResult,
} from './mobile-relay-action-results.js'

export type MobileRuntimeClient = MobileRuntimeClientContract<File, Blob>

export const createLocalMobileRuntimeClient = (): MobileRuntimeClient => ({
  cancelChatSubmission: cancelMobileChatSubmission,
  continueChatSubmission: continueMobileChatSubmission,
  cancelTeamTask: cancelMobileTeamTask,
  replaceTeamTask: replaceMobileTeamTask,
  clearFiles: clearMobileFiles,
  bindCurrentSession: bindMobileCurrentSession,
  deleteFile: deleteMobileFile,
  downloadFile: downloadMobileFile,
  downloadChatAttachment: downloadMobileChatAttachment,
  editChatSubmission: editMobileChatSubmission,
  dismissRecordedConversation: dismissMobileRecordedConversation,
  forceChatSubmission: forceMobileChatSubmission,
  getTranscript: getMobileTranscript,
  getCurrentConversation: getCurrentMobileConversation,
  getRecordedConversation: getMobileRecordedConversation,
  listDispatches: listMobileDispatches,
  listRecordedConversations: listMobileRecordedConversations,
  listFiles: listMobileFiles,
  async listDashboard(workspaceId) {
    const [workers, runs] = await Promise.all([
      listWorkers(workspaceId),
      listTerminalRuns(workspaceId),
    ])
    return { runs, workers }
  },
  listWorkspaces,
  migrateChatSubmission: migrateMobileChatSubmission,
  pasteImageAttachment: pasteMobileImageAttachment,
  reviewFile: sendMobileFileReview,
  restartAgentRun: restartMobileAgentRun,
  sendTeamNote: sendMobileTeamNote,
  sendTeamReport: sendMobileTeamReport,
  sendTeamStatus: sendMobileTeamStatus,
  sendTeamTask: sendMobileTeamTask,
  sendTerminalInput: sendMobileTerminalInput,
  sendWorkspaceFileToMobile,
  submitChatMessage: submitMobileChatMessage,
  startAgentRun: startMobileAgentRun,
  stopAgentRun: stopMobileAgentRun,
  subscribeMobileEvents: (options) => {
    const client = createMobileEventsClient({
      ...(options.onConversationInvalidated
        ? { onConversationInvalidated: options.onConversationInvalidated }
        : {}),
      ...(options.onError ? { onError: options.onError } : {}),
      ...(options.onHeartbeat ? { onHeartbeat: options.onHeartbeat } : {}),
      ...(options.onClose
        ? {
            onReconnect: (meta) =>
              options.onClose?.('Local mobile events disconnected', {
                attempt: meta.attempt,
                nextDelayMs: meta.nextDelayMs,
              }),
          }
        : {}),
      onSnapshot: options.onSnapshot,
    })
    client.connect()
    return { dispose: client.dispose }
  },
  uploadFile: uploadMobileFile,
})

export const createRelayMobileRuntimeClient = (
  relayClient: Pick<
    RelayMobileClient,
    | 'clearMobileFiles'
    | 'createMobileConfirmation'
    | 'deleteMobileFile'
    | 'downloadMobileFile'
    | 'getMobileTranscript'
    | 'getMobileConversation'
    | 'getMobileConversations'
    | 'getMobileRecordedConversation'
    | 'listAgentsAndRuns'
    | 'listDispatches'
    | 'listMobileFiles'
    | 'listWorkspaces'
    | 'sendMobileAction'
    | 'sendWorkspaceFileToMobile'
    | 'subscribeMobileEvents'
    | 'uploadMobileFile'
  >
): MobileRuntimeClient => ({
  async cancelChatSubmission(workspaceId, submissionId) {
    return readRelayActionResult(
      await relayClient.sendMobileAction({
        action_id: createBrowserId('chat-cancel'),
        kind: 'chat_cancel',
        target: { submission_id: submissionId },
        workspace_id: workspaceId,
      })
    ) as MobileChatSubmission
  },
  async continueChatSubmission(workspaceId, submissionId) {
    return readRelayActionResult(
      await relayClient.sendMobileAction({
        action_id: createBrowserId('chat-continue'),
        kind: 'chat_continue',
        target: { submission_id: submissionId },
        workspace_id: workspaceId,
      })
    ) as MobileChatSubmission
  },
  clearFiles: () => relayClient.clearMobileFiles(),
  async bindCurrentSession(workspaceId, agentId) {
    const response = await relayClient.sendMobileAction({
      action_id: createBrowserId('bind-session'),
      kind: 'bind_current_session',
      target: { agent_id: agentId },
      workspace_id: workspaceId,
    })
    if (
      typeof response === 'object' &&
      response !== null &&
      'result' in response &&
      typeof response.result === 'object' &&
      response.result !== null
    ) {
      return response.result as Awaited<ReturnType<MobileRuntimeClient['bindCurrentSession']>>
    }
    throw new Error('Relay bind session action did not return a result')
  },
  deleteFile: (fileId) => relayClient.deleteMobileFile(fileId),
  downloadFile: (fileId, onProgress) => relayClient.downloadMobileFile(fileId, onProgress),
  downloadChatAttachment: (workspaceId, submissionId, fileId, onProgress) =>
    relayClient.downloadMobileFile(fileId, onProgress, { submissionId, workspaceId }),
  async editChatSubmission(workspaceId, submissionId, body) {
    return readRelayActionResult(
      await relayClient.sendMobileAction({
        action_id: createBrowserId('chat-edit'),
        kind: 'chat_edit',
        payload: { body },
        target: { submission_id: submissionId },
        workspace_id: workspaceId,
      })
    ) as MobileChatSubmission
  },
  async forceChatSubmission(workspaceId, submissionId, expectedSkippedCount) {
    return readRelayActionResult(
      await relayClient.sendMobileAction({
        action_id: createBrowserId('chat-force'),
        kind: 'chat_force',
        payload: { skipped_count: expectedSkippedCount },
        target: { submission_id: submissionId },
        workspace_id: workspaceId,
      })
    ) as MobileChatSubmission
  },
  getTranscript: (workspaceId, runId) => relayClient.getMobileTranscript(workspaceId, runId),
  async getCurrentConversation(workspaceId, agentId, cursor) {
    const response = (await (cursor === undefined
      ? relayClient.getMobileConversation(workspaceId, agentId)
      : relayClient.getMobileConversation(workspaceId, agentId, cursor))) as {
      conversation: Awaited<ReturnType<MobileRuntimeClient['getCurrentConversation']>>
    }
    return response.conversation
  },
  async getRecordedConversation(workspaceId, agentId, conversationId, cursor) {
    const response = (await relayClient.getMobileRecordedConversation(
      workspaceId,
      agentId,
      conversationId,
      cursor
    )) as { conversation: Awaited<ReturnType<MobileRuntimeClient['getRecordedConversation']>> }
    return response.conversation
  },
  async listRecordedConversations(workspaceId, agentId, cursor) {
    return relayClient.getMobileConversations(workspaceId, agentId, cursor) as ReturnType<
      MobileRuntimeClient['listRecordedConversations']
    >
  },
  async dismissRecordedConversation(workspaceId, agentId, conversationId) {
    await relayClient.sendMobileAction({
      action_id: createBrowserId('chat-dismiss'),
      kind: 'chat_dismiss_conversation',
      target: { agent_id: agentId, conversation_id: conversationId },
      workspace_id: workspaceId,
    })
  },
  listDispatches: (workspaceId) => relayClient.listDispatches(workspaceId),
  listFiles: () => relayClient.listMobileFiles(),
  async listDashboard(workspaceId) {
    const snapshot = await relayClient.listAgentsAndRuns(workspaceId)
    return {
      runs: snapshot.runs,
      workers: snapshot.agents.map(fromTeamListItemPayload),
    }
  },
  listWorkspaces: () => relayClient.listWorkspaces(),
  async migrateChatSubmission(workspaceId, submissionId, targetConversationId) {
    return readRelayActionResult(
      await relayClient.sendMobileAction({
        action_id: globalThis.crypto.randomUUID(),
        kind: 'chat_migrate',
        target: { conversation_id: targetConversationId, submission_id: submissionId },
        workspace_id: workspaceId,
      })
    ) as MobileChatSubmission
  },
  async pasteImageAttachment(workspaceId, runId, fileId, placeholder) {
    return readRelayActionResult(
      await relayClient.sendMobileAction({
        action_id: createBrowserId('native-image-paste'),
        artifact_contract_version: MOBILE_ARTIFACT_CONTRACT_VERSION,
        kind: 'native_image_paste',
        payload: { file_id: fileId, placeholder },
        target: { run_id: runId },
        workspace_id: workspaceId,
      })
    )
  },
  async reviewFile(workspaceId, fileId, decision, input = {}) {
    const response = await relayClient.sendMobileAction({
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
    })
    if (
      typeof response === 'object' &&
      response !== null &&
      'result' in response &&
      typeof response.result === 'object' &&
      response.result !== null
    ) {
      return response.result as {
        decision: MobileFileReviewDecision
        file_id: string
        run_id?: string
      }
    }
    return { decision, file_id: fileId }
  },
  async restartAgentRun(workspaceId, agentId, runId) {
    const target = { agent_id: agentId, run_id: runId }
    const nonce = readRelayConfirmationNonce(
      await relayClient.createMobileConfirmation({
        kind: 'restart_run',
        target,
        workspace_id: workspaceId,
      })
    )
    const response = await relayClient.sendMobileAction({
      action_id: createBrowserId('restart-run'),
      kind: 'restart_run',
      payload: { confirmation_nonce: nonce },
      target,
      workspace_id: workspaceId,
    })
    return { runId: readRelayRunId(response, 'Relay restart action did not return a run id') }
  },
  async sendTerminalInput(workspaceId, runId, input, attachments = [], actionId) {
    await relayClient.sendMobileAction({
      action_id: actionId ?? createBrowserId('terminal-input'),
      ...(attachments.length > 0
        ? { artifact_contract_version: MOBILE_ARTIFACT_CONTRACT_VERSION }
        : {}),
      kind: 'terminal_input',
      payload: attachments.length > 0 ? { attachments, input } : { input },
      target: { run_id: runId },
      workspace_id: workspaceId,
    })
  },
  async sendTeamTask(workspaceId, to, text, actionId) {
    return readRelayTeamResult(
      await relayClient.sendMobileAction({
        action_id: actionId ?? createBrowserId('team-send'),
        kind: 'team_send',
        payload: { text },
        target: { to },
        workspace_id: workspaceId,
      })
    )
  },
  async sendTeamNote(workspaceId, dispatchId, text, input = {}) {
    return readRelayTeamResult(
      await relayClient.sendMobileAction({
        action_id: input.actionId ?? createBrowserId('team-note'),
        kind: 'team_note',
        payload: {
          ...(input.artifacts && input.artifacts.length > 0 ? { artifacts: input.artifacts } : {}),
          text,
        },
        target: { dispatch_id: dispatchId },
        workspace_id: workspaceId,
      })
    )
  },
  async submitChatMessage(workspaceId, conversationId, body, submissionId, attachments = []) {
    return readRelayActionResult(
      await relayClient.sendMobileAction({
        action_id: submissionId,
        kind: 'chat_submit',
        payload: {
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(body === undefined ? {} : { body }),
        },
        target: { conversation_id: conversationId },
        workspace_id: workspaceId,
      })
    ) as Awaited<ReturnType<MobileRuntimeClient['submitChatMessage']>>
  },
  async sendTeamStatus(workspaceId, agentId, text, input = {}) {
    return readRelayTeamResult(
      await relayClient.sendMobileAction({
        action_id: input.actionId ?? createBrowserId('team-status'),
        kind: 'team_status',
        payload: {
          ...(input.artifacts && input.artifacts.length > 0 ? { artifacts: input.artifacts } : {}),
          ...(input.notify ? { notify: true } : {}),
          text,
        },
        target: { agent_id: agentId },
        workspace_id: workspaceId,
      })
    )
  },
  async sendTeamReport(workspaceId, agentId, text, input = {}) {
    return readRelayTeamResult(
      await relayClient.sendMobileAction({
        action_id: input.actionId ?? createBrowserId('team-report'),
        kind: 'team_report',
        payload: {
          ...(input.artifacts && input.artifacts.length > 0 ? { artifacts: input.artifacts } : {}),
          ...(input.outcome ? { outcome: input.outcome } : {}),
          text,
        },
        target: { agent_id: agentId },
        workspace_id: workspaceId,
      })
    )
  },
  async cancelTeamTask(workspaceId, dispatchId, reason, actionId) {
    const target = { dispatch_id: dispatchId }
    const nonce = readRelayConfirmationNonce(
      await relayClient.createMobileConfirmation({
        kind: 'team_cancel',
        target,
        workspace_id: workspaceId,
      })
    )
    return readRelayTeamResult(
      await relayClient.sendMobileAction({
        action_id: actionId ?? createBrowserId('team-cancel'),
        kind: 'team_cancel',
        payload: { confirmation_nonce: nonce, reason },
        target,
        workspace_id: workspaceId,
      })
    )
  },
  async replaceTeamTask(workspaceId, dispatchId, text, input = {}) {
    const target = { dispatch_id: dispatchId }
    const nonce = readRelayConfirmationNonce(
      await relayClient.createMobileConfirmation({
        kind: 'team_replace',
        target,
        workspace_id: workspaceId,
      })
    )
    return readRelayTeamResult(
      await relayClient.sendMobileAction({
        action_id: input.actionId ?? createBrowserId('team-replace'),
        kind: 'team_replace',
        payload: {
          ...(input.artifacts && input.artifacts.length > 0 ? { artifacts: input.artifacts } : {}),
          confirmation_nonce: nonce,
          ...(input.interrupt ? { interrupt: true } : {}),
          text,
        },
        target,
        workspace_id: workspaceId,
      })
    )
  },
  sendWorkspaceFileToMobile: (workspaceId, path) =>
    relayClient.sendWorkspaceFileToMobile(workspaceId, path),
  async startAgentRun(workspaceId, agentId) {
    const response = await relayClient.sendMobileAction({
      action_id: createBrowserId('start-run'),
      kind: 'start_run',
      target: { agent_id: agentId },
      workspace_id: workspaceId,
    })
    return { runId: readRelayRunId(response, 'Relay start action did not return a run id') }
  },
  async stopAgentRun(workspaceId, runId, mode = 'safe') {
    const target = mode === 'safe' ? { run_id: runId } : { mode, run_id: runId }
    const nonce = readRelayConfirmationNonce(
      await relayClient.createMobileConfirmation({
        kind: 'stop_run',
        target,
        workspace_id: workspaceId,
      })
    )
    return readRelayAgentStopResult(
      await relayClient.sendMobileAction({
        action_id: createBrowserId('stop-run'),
        kind: 'stop_run',
        payload: { confirmation_nonce: nonce },
        target,
        workspace_id: workspaceId,
      }),
      mode
    )
  },
  subscribeMobileEvents: (options) => relayClient.subscribeMobileEvents(options),
  async uploadFile(workspaceId, file) {
    return relayClient.uploadMobileFile({
      content_base64: await fileToBase64(file),
      name: file.name,
      workspace_id: workspaceId,
    })
  },
})
