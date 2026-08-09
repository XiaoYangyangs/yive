import type { WorkspaceSummary } from '../shared/types.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import type { SessionIdCaptureConfig } from './session-capture.js'

export interface AgentSessionRebindResult {
  captureSource: SessionIdCaptureConfig['source'] | null
  failureReason: string | null
  previousSessionId: string | null
  requestId: string | null
  runId: string | null
  sessionId: string | null
  state: 'failed' | 'saved' | 'unresolved' | 'waiting'
  unchanged: boolean
}

export const resolveAgentSessionCapture = (config: AgentLaunchConfigInput) =>
  config.sessionIdCapture ?? null

export const refreshAgentSessionBinding = ({
  agentId,
  config,
  activeRunId,
  activeSessionId,
  activeSessionCapture,
  sessionStore,
  workspace,
}: {
  activeRunId?: string
  activeSessionId: string | null
  activeSessionCapture?: SessionIdCaptureConfig
  agentId: string
  config: AgentLaunchConfigInput
  sessionStore: AgentSessionStorePort
  workspace: WorkspaceSummary
}): AgentSessionRebindResult => {
  const capture = resolveAgentSessionCapture(config)
  const previousSessionId = sessionStore.getLastSessionId(workspace.id, agentId) ?? null
  const existingIntent = sessionStore.getSaveIntent(workspace.id, agentId)
  if (!capture) {
    if (!activeRunId) {
      return {
        captureSource: existingIntent?.captureSource ?? null,
        failureReason: null,
        previousSessionId,
        requestId: null,
        runId: null,
        sessionId: null,
        state: 'unresolved',
        unchanged: true,
      }
    }
    return {
      captureSource: existingIntent?.captureSource ?? null,
      failureReason: 'capture_unavailable',
      previousSessionId,
      requestId: null,
      runId: activeRunId,
      sessionId: null,
      state: 'failed',
      unchanged: true,
    }
  }
  const provider =
    capture.source === 'codex_session_jsonl_dir'
      ? 'codex'
      : capture.source === 'claude_project_jsonl_dir'
        ? 'claude'
        : null
  const failedIntentResult = () => ({
    captureSource: existingIntent?.captureSource ?? capture.source,
    failureReason: existingIntent?.failureReason ?? 'session_verification_failed',
    previousSessionId: existingIntent?.previousSessionId ?? previousSessionId,
    requestId: existingIntent?.requestId ?? null,
    runId: existingIntent?.runId ?? activeRunId ?? null,
    sessionId: existingIntent?.sessionId ?? null,
    state: 'failed' as const,
    unchanged: true,
  })
  if (!activeRunId && existingIntent?.state === 'failed') return failedIntentResult()
  if (!activeRunId) {
    return {
      captureSource: capture.source,
      failureReason: null,
      previousSessionId,
      requestId: null,
      runId: null,
      sessionId: null,
      state: 'unresolved',
      unchanged: true,
    }
  }
  if (
    activeSessionCapture &&
    (activeSessionCapture.source !== capture.source ||
      activeSessionCapture.pattern !== capture.pattern)
  ) {
    return {
      captureSource: capture.source,
      failureReason: 'provider_changed',
      previousSessionId,
      requestId: null,
      runId: activeRunId,
      sessionId: null,
      state: 'failed',
      unchanged: true,
    }
  }
  if (!activeSessionId) {
    if (!provider) {
      return {
        captureSource: capture.source,
        failureReason: 'provider_unsupported',
        previousSessionId,
        requestId: null,
        runId: activeRunId,
        sessionId: null,
        state: 'failed',
        unchanged: true,
      }
    }
    if (existingIntent?.runId === activeRunId && existingIntent.state === 'failed') {
      return failedIntentResult()
    }
    const intent = sessionStore.beginSaveIntent({
      agentId,
      captureSource: capture.source,
      previousSessionId,
      provider,
      runId: activeRunId,
      workspaceId: workspace.id,
    })
    return {
      captureSource: capture.source,
      failureReason: null,
      previousSessionId,
      requestId: intent.requestId,
      runId: activeRunId,
      sessionId: null,
      state: 'waiting',
      unchanged: false,
    }
  }

  const intent = existingIntent
  if (
    activeRunId &&
    intent?.runId === activeRunId &&
    intent.state === 'saved' &&
    intent.sessionId === activeSessionId
  ) {
    return {
      captureSource: capture.source,
      failureReason: null,
      previousSessionId: intent.previousSessionId,
      requestId: intent.requestId,
      runId: activeRunId,
      sessionId: activeSessionId,
      state: 'saved',
      unchanged: intent.previousSessionId === activeSessionId,
    }
  }
  const completed =
    activeRunId && intent?.state === 'waiting' && intent.runId === activeRunId
      ? sessionStore.completeSaveIntent(workspace.id, agentId, activeRunId, activeSessionId)
      : undefined
  if (!completed) {
    if (!provider) {
      return {
        captureSource: capture.source,
        failureReason: 'provider_unsupported',
        previousSessionId,
        requestId: null,
        runId: activeRunId,
        sessionId: null,
        state: 'failed',
        unchanged: true,
      }
    }
    sessionStore.saveLastSessionId(workspace.id, agentId, activeSessionId, provider)
  }
  return {
    captureSource: capture.source,
    failureReason: null,
    previousSessionId: completed?.previousSessionId ?? previousSessionId,
    requestId: completed?.requestId ?? null,
    runId: activeRunId ?? null,
    sessionId: activeSessionId,
    state: 'saved',
    unchanged: previousSessionId === activeSessionId,
  }
}
