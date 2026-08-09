import { MoreVertical, Settings } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type {
  AgentProvider,
  AgentRuntimeState,
  ConversationProvider,
} from '../../../src/shared/types.js'
import type { MobileTerminalAttachment, TerminalRunSummary } from '../api.js'
import { createBrowserId } from '../browser-id.js'
import { buildPendingImageArtifactPrompt } from '../image-attachment-prompt.js'
import { describeSessionSaveResult, waitForSessionSaveResult } from '../session-save-polling.js'
import { TerminalView } from '../terminal/TerminalView.js'
import type { TerminalOwnershipState } from '../terminal/terminal-client.js'
import type { TerminalScrollFrameRatePreference } from '../terminal/useTerminalRun.js'
import { presentAgentStatus } from '../worker/worker-status.js'
import { MobileAgentComposer } from './MobileAgentComposer.js'
import { IMAGE_FILE_PATTERN, validateMobileImageReferenceFile } from './mobile-file-transfer.js'
import type { MobileRuntimeClient } from './mobile-runtime-client.js'
import { getMobileTerminalOwnershipPresentation } from './mobile-terminal-ownership.js'

type MobileConnectionTone = 'error' | 'ok' | 'warn'

export type MobileTerminalAgent = AgentRuntimeState & {
  provider?: AgentProvider
  conversationProvider?: ConversationProvider
  id: string
  kind: 'orchestrator' | 'worker'
  name: string
  run?: TerminalRunSummary
  runStatus: string
}

type MobileWakeLockSentinel = {
  addEventListener?: (type: 'release', listener: () => void) => void
  release: () => Promise<void>
  removeEventListener?: (type: 'release', listener: () => void) => void
}

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request: (type: 'screen') => Promise<MobileWakeLockSentinel>
  }
}

const AUX_KEYS: Array<{ chunk: string; label: string }> = [
  { label: 'Esc', chunk: '\x1b' },
  { label: 'Tab', chunk: '\t' },
  { label: 'Ctrl+C', chunk: '\x03' },
  { label: 'Enter', chunk: '\r' },
  { label: 'Left', chunk: '\x1b[D' },
  { label: 'Up', chunk: '\x1b[A' },
  { label: 'Down', chunk: '\x1b[B' },
  { label: 'Right', chunk: '\x1b[C' },
]
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const TERMINAL_SCROLL_FRAME_RATE_STORAGE_KEY = 'yive.mobile.terminal.scrollFrameRate'
const TERMINAL_SCROLL_FRAME_RATE_OPTIONS: Array<{
  description: string
  label: string
  value: TerminalScrollFrameRatePreference
}> = [
  { value: 'auto', label: 'Auto', description: '跟随设备刷新' },
  { value: '60', label: '60fps', description: '省电稳定' },
  { value: '90', label: '90fps', description: '更顺滑' },
  { value: '120', label: '120fps', description: '最高帧率' },
]

const isTerminalScrollFrameRatePreference = (
  value: string | null
): value is TerminalScrollFrameRatePreference =>
  value === 'auto' || value === '60' || value === '90' || value === '120'

const readTerminalScrollFrameRatePreference = (): TerminalScrollFrameRatePreference => {
  if (typeof window === 'undefined') return 'auto'
  try {
    const stored = window.localStorage.getItem(TERMINAL_SCROLL_FRAME_RATE_STORAGE_KEY)
    if (isTerminalScrollFrameRatePreference(stored)) return stored
  } catch {
    // Storage may be unavailable in private browsing or locked-down WebViews.
  }
  return 'auto'
}

const saveTerminalScrollFrameRatePreference = (
  preference: TerminalScrollFrameRatePreference
): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(TERMINAL_SCROLL_FRAME_RATE_STORAGE_KEY, preference)
  } catch {
    // Keep the in-memory setting if the WebView denies local storage.
  }
}

const requestMobileScreenWakeLock = async (): Promise<MobileWakeLockSentinel | null> => {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return null
  if (document.visibilityState === 'hidden') return null
  const wakeLock = (navigator as NavigatorWithWakeLock).wakeLock
  if (!wakeLock?.request) return null
  try {
    return await wakeLock.request('screen')
  } catch {
    return null
  }
}

const buildImageAttachmentPlaceholder = (index: number): string => `[Image #${index}]`
const wrapTerminalPaste = (text: string): string =>
  `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`
const runStatusLabel = (status: string): string => {
  if (status === 'running') return '运行中'
  if (status === 'starting') return '启动中'
  if (status === 'stopped') return '已停止'
  if (status === 'error') return '错误'
  return status
}

const MobileMirrorTerminal = ({
  inputProfile,
  onError,
  onOwnershipChange,
  onSyncStatusChange,
  portalId,
  runId,
  scrollFrameRatePreference,
  terminalConnectionParams,
  title,
  workspaceId,
}: {
  inputProfile: TerminalRunSummary['terminal_input_profile']
  onError: (message: string) => void
  onOwnershipChange: (state: TerminalOwnershipState) => void
  onSyncStatusChange?: ((state: 'complete' | 'pending') => void) | undefined
  portalId: string
  runId: string
  scrollFrameRatePreference: TerminalScrollFrameRatePreference
  terminalConnectionParams?: Record<string, number | string | undefined> | undefined
  title: string
  workspaceId: string
}) => {
  const [frameNode, setFrameNode] = useState<HTMLDivElement | null>(null)
  const [syncStatus, setSyncStatus] = useState<'complete' | 'pending'>('pending')
  const handleSyncStatusChange = (nextStatus: 'complete' | 'pending') => {
    setSyncStatus(nextStatus)
    onSyncStatusChange?.(nextStatus)
  }

  return (
    <>
      <div className="mobile-terminal__stream">
        <div className="mobile-terminal__frame" id={portalId} ref={setFrameNode} />
        {syncStatus !== 'complete' ? (
          <div className="mobile-terminal__sync" role="status">
            正在同步最新终端...
          </div>
        ) : null}
      </div>
      {frameNode ? (
        <TerminalView
          autoTakeover
          connectionParams={terminalConnectionParams}
          fitToContainer
          inputProfile={inputProfile ?? 'default'}
          minimumSize={{ cols: 24, rows: 10 }}
          onError={onError}
          onOwnershipChange={onOwnershipChange}
          onSyncStatusChange={handleSyncStatusChange}
          portalId={portalId}
          propagateResize
          runId={runId}
          scrollFrameRatePreference={scrollFrameRatePreference}
          title={title}
          touchScrollTarget={frameNode}
          viewerMode="takeover"
          workspaceId={workspaceId}
        />
      ) : null}
    </>
  )
}

const TerminalFreshnessWatchdog = ({
  onRefresh,
  restoreStarted,
  syncStatus,
}: {
  onRefresh: () => void
  restoreStarted: boolean
  syncStatus: 'complete' | 'pending'
}) => {
  const firedRef = useRef(false)
  const syncStatusRef = useRef(syncStatus)
  useEffect(() => {
    syncStatusRef.current = syncStatus
  }, [syncStatus])
  useEffect(() => {
    if (!restoreStarted || syncStatus === 'complete') return
    firedRef.current = false
    const timer = window.setTimeout(() => {
      if (syncStatusRef.current === 'complete' || firedRef.current) return
      firedRef.current = true
      onRefresh()
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [onRefresh, restoreStarted, syncStatus])
  return null
}

export type MobileAgentTerminalProps = {
  agent: MobileTerminalAgent
  connectionTone: MobileConnectionTone
  connectionWarning: string | null
  dangerAction: 'checkpoint' | 'force' | 'restart' | 'stop' | null
  formatError: (error: unknown, fallback: string) => string
  message: string | null
  onBack: () => void
  onCancelDanger: () => void
  onConfirmDanger: () => void
  onFilesChanged: () => void
  onRefresh: () => void
  onRequestForceStop: () => void
  onRestart: () => void
  onRetryAgentAction: () => void
  onRetryConnection?: (() => void) | undefined
  onStart: () => void
  onStop: () => void
  onTerminalError: (runId: string, message: string) => void
  retryAgentActionLabel: string | null
  retryConnectionDisabled: boolean
  runtimeClient: MobileRuntimeClient
  staleRunId: string | null
  terminalConnectionParams?: Record<string, number | string | undefined> | undefined
  workspaceId: string
}

export const MobileAgentTerminal = ({
  agent,
  connectionTone,
  connectionWarning,
  dangerAction,
  formatError,
  message,
  onBack,
  onCancelDanger,
  onConfirmDanger,
  onFilesChanged,
  onRefresh,
  onRequestForceStop,
  onRestart,
  onRetryAgentAction,
  onRetryConnection,
  onStart,
  onStop,
  onTerminalError,
  retryAgentActionLabel,
  retryConnectionDisabled,
  runtimeClient,
  staleRunId,
  terminalConnectionParams,
  workspaceId,
}: MobileAgentTerminalProps) => {
  const [sendMessage, setSendMessage] = useState<string | null>(null)
  const [inputSending, setInputSending] = useState(false)
  const [pendingRetryInput, setPendingRetryInput] = useState<{
    actionId: string
    attachments?: MobileTerminalAttachment[]
    input: string
  } | null>(null)
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [terminalSettingsOpen, setTerminalSettingsOpen] = useState(false)
  const [scrollFrameRatePreference, setScrollFrameRatePreference] =
    useState<TerminalScrollFrameRatePreference>(readTerminalScrollFrameRatePreference)
  const [imageUploading, setImageUploading] = useState(false)
  const [sessionBinding, setSessionBinding] = useState(false)
  const sessionBindingAbortRef = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      sessionBindingAbortRef.current?.abort()
    },
    []
  )
  const [imageAttachmentCount, setImageAttachmentCount] = useState(0)
  const [terminalOwnership, setTerminalOwnership] = useState<TerminalOwnershipState | null>(null)
  const [terminalReconnectKey, setTerminalReconnectKey] = useState(0)
  const [terminalSyncStatus, setTerminalSyncStatus] = useState<'complete' | 'pending'>('pending')
  const [terminalAutoRefreshCount, setTerminalAutoRefreshCount] = useState(0)
  const [terminalRestoreStarted, setTerminalRestoreStarted] = useState(false)
  const status = presentAgentStatus(agent)
  const wakeLockRef = useRef<MobileWakeLockSentinel | null>(null)
  const run = agent.run && agent.run.status !== 'stopped' ? agent.run : null
  const activeRunId = run?.run_id ?? null
  const runIsStale = Boolean(run && staleRunId === run.run_id)
  const agentActionsDisabled = connectionTone === 'error'
  const terminalOwnershipPresentation = getMobileTerminalOwnershipPresentation({
    connectionTone,
    inputSending,
    runActive: Boolean(run),
    runIsStale,
    terminalOwnership,
  })
  const portalId = run
    ? `${agent.kind === 'orchestrator' ? 'orch' : 'worker'}-pty-${workspaceId}-${run.run_id}`
    : undefined

  useEffect(() => {
    if (agentActionsDisabled && dangerAction) onCancelDanger()
  }, [agentActionsDisabled, dangerAction, onCancelDanger])

  useEffect(() => {
    if (!activeRunId || runIsStale || typeof document === 'undefined') return
    let cancelled = false
    let releaseListener: (() => void) | null = null
    const clearWakeLockRef = () => {
      wakeLockRef.current = null
    }
    const detachWakeLock = (sentinel: MobileWakeLockSentinel | null) => {
      if (!sentinel || !releaseListener) return
      sentinel.removeEventListener?.('release', releaseListener)
      releaseListener = null
    }
    const acquireWakeLock = async () => {
      if (cancelled || wakeLockRef.current) return
      const sentinel = await requestMobileScreenWakeLock()
      if (!sentinel) return
      if (cancelled) {
        void sentinel.release().catch(() => {})
        return
      }
      releaseListener = clearWakeLockRef
      sentinel.addEventListener?.('release', releaseListener)
      wakeLockRef.current = sentinel
    }
    const releaseWakeLock = () => {
      const sentinel = wakeLockRef.current
      wakeLockRef.current = null
      detachWakeLock(sentinel)
      void sentinel?.release().catch(() => {})
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void acquireWakeLock()
      else releaseWakeLock()
    }
    void acquireWakeLock()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      releaseWakeLock()
    }
  }, [activeRunId, runIsStale])

  const sendChunk = async (
    chunk: string,
    actionId = createBrowserId('terminal-input'),
    attachments: MobileTerminalAttachment[] = []
  ) => {
    if (!run || terminalOwnershipPresentation.inputDisabled) return
    setInputSending(true)
    setSendMessage('正在发送到电脑端 PTY...')
    try {
      await runtimeClient.sendTerminalInput(workspaceId, run.run_id, chunk, attachments, actionId)
      setPendingRetryInput(null)
      setSendMessage('已发送到电脑端 PTY')
    } catch (error) {
      setPendingRetryInput({
        actionId,
        ...(attachments.length > 0 ? { attachments } : {}),
        input: chunk,
      })
      setSendMessage(`${formatError(error, '发送失败')}。这段输入未送达电脑端，可以手动重试。`)
    } finally {
      setInputSending(false)
    }
  }

  const bindCurrentSession = async () => {
    sessionBindingAbortRef.current?.abort()
    const abortController = new AbortController()
    sessionBindingAbortRef.current = abortController
    setSessionBinding(true)
    setSendMessage('正在保存当前会话绑定...')
    try {
      let result = await runtimeClient.bindCurrentSession(workspaceId, agent.id)
      if (result.state === 'waiting') {
        setSendMessage('等待 CLI 确认当前会话，确认后会自动保存')
        result = await waitForSessionSaveResult(
          result,
          () => runtimeClient.bindCurrentSession(workspaceId, agent.id),
          {
            onTick: () => {
              setSendMessage('等待 CLI 确认当前会话，确认后会自动保存')
            },
            signal: abortController.signal,
          }
        )
      }
      const presentation = describeSessionSaveResult(result, {
        missingSessionId: 'CLI session save completed without a session id',
        saved: (sessionId) => `已保存当前会话，下次启动会优先恢复 ${sessionId}`,
        unchanged: (sessionId) => `当前会话已是已保存会话（${sessionId}）`,
        unresolved: '当前没有运行中的 CLI 会话，无法保存',
        verificationFailed: 'CLI session verification failed',
      })
      if (!presentation) return
      if (presentation.kind === 'error') throw new Error(presentation.message)
      setSendMessage(presentation.message)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setSendMessage(formatError(error, '保存当前会话失败'))
    } finally {
      if (sessionBindingAbortRef.current === abortController) {
        sessionBindingAbortRef.current = null
      }
      setSessionBinding(false)
    }
  }

  const sendImageReference = async (file: File) => {
    if (!run || terminalOwnershipPresentation.inputDisabled) return
    const validation = validateMobileImageReferenceFile(file)
    if (!validation.ok) {
      setSendMessage(
        IMAGE_FILE_PATTERN.test(file.name)
          ? validation.message
          : '仅支持 .png、.jpg、.jpeg、.webp 图片'
      )
      return
    }
    setImageUploading(true)
    setSendMessage('正在上传图片...')
    try {
      const item = await runtimeClient.uploadFile(workspaceId, file)
      const placeholder = buildImageAttachmentPlaceholder(imageAttachmentCount + 1)
      setImageAttachmentCount((count) => count + 1)
      onFilesChanged()
      try {
        const result = await runtimeClient.pasteImageAttachment(
          workspaceId,
          run.run_id,
          item.id,
          placeholder
        )
        const successMessage =
          result.input === 'server_attachment_prompt'
            ? result.fallback_reason
              ? `电脑端暂时不能原生粘贴图片，已改为附件引用发给 AI（${result.fallback_reason}）`
              : '已将图片作为附件引用发给 AI'
            : '已尝试按电脑粘贴图片方式送入 CLI，请在编辑区确认图片附件'
        if (result.input === 'server_attachment_prompt') {
          setSendMessage(successMessage)
          return
        }
        try {
          await runtimeClient.deleteFile(item.id)
          onFilesChanged()
          setSendMessage(`${successMessage}，已从文件交换区移除。`)
        } catch (error) {
          setSendMessage(
            `${successMessage}，但从文件交换区删除失败：${formatError(error, '删除文件失败')}`
          )
        }
      } catch (pasteError) {
        const input = wrapTerminalPaste(buildPendingImageArtifactPrompt('Mobile', item.name))
        const attachments = [{ file_id: item.id, placeholder }]
        const actionId = createBrowserId('terminal-input')
        try {
          await runtimeClient.sendTerminalInput(
            workspaceId,
            run.run_id,
            input,
            attachments,
            actionId
          )
        } catch (error) {
          setPendingRetryInput({ actionId, attachments, input })
          setSendMessage(
            `${formatError(error, '发送图片引用失败')}。图片已上传到文件交换区，但引用未送达 CLI，可以手动重试。`
          )
          return
        }
        console.error(
          '[hive] native mobile image paste failed; sent server attachment prompt',
          pasteError
        )
        setSendMessage('已将图片作为服务器附件发送给 CLI')
      }
    } catch (error) {
      setSendMessage(formatError(error, '上传图片失败'))
    } finally {
      setImageUploading(false)
    }
  }

  const terminalSettingsView = terminalSettingsOpen ? (
    <div
      aria-labelledby="mobile-terminal-settings-title"
      className="mobile-terminal-settings"
      role="dialog"
    >
      <div className="mobile-terminal__header">
        <button
          className="mobile-text-button"
          onClick={() => setTerminalSettingsOpen(false)}
          type="button"
        >
          返回
        </button>
        <div className="mobile-terminal__identity">
          <div className="mobile-terminal__title-row">
            <h2 id="mobile-terminal-settings-title">终端设置</h2>
          </div>
          <p>{agent.name}</p>
        </div>
        <span className="mobile-terminal__header-spacer" aria-hidden />
      </div>
      <div className="mobile-terminal-settings__body">
        <fieldset className="mobile-terminal-settings__group">
          <legend>滚动帧率</legend>
          <div className="mobile-terminal-settings__options">
            {TERMINAL_SCROLL_FRAME_RATE_OPTIONS.map((option) => (
              <button
                aria-pressed={scrollFrameRatePreference === option.value}
                className="mobile-terminal-settings__option"
                data-selected={scrollFrameRatePreference === option.value ? 'true' : undefined}
                key={option.value}
                onClick={() => {
                  setScrollFrameRatePreference(option.value)
                  saveTerminalScrollFrameRatePreference(option.value)
                }}
                type="button"
              >
                <span>{option.label}</span>
                <small>{option.description}</small>
              </button>
            ))}
          </div>
        </fieldset>
      </div>
    </div>
  ) : null

  const runAgentAction = (action: () => void) => {
    setActionMenuOpen(false)
    action()
  }
  return (
    <section className="mobile-terminal" aria-labelledby="mobile-terminal-title">
      <div className="mobile-terminal__header">
        <button className="mobile-text-button" onClick={onBack} type="button">
          返回
        </button>
        <div className="mobile-terminal__identity">
          <div className="mobile-terminal__title-row">
            <h2 id="mobile-terminal-title">{agent.name}</h2>
            <span className="mobile-agent-status" data-status={status.kind}>
              <span className={status.dotClass} aria-hidden />
              {status.label}
            </span>
          </div>
          <p>
            {agent.kind === 'worker' ? 'Worker' : 'Orchestrator'}
            {' · '}
            {runStatusLabel(agent.runStatus)}
          </p>
        </div>
        <div className="mobile-terminal__header-actions">
          <button
            aria-label="打开终端设置"
            className="mobile-terminal__menu-button"
            onClick={() => {
              setActionMenuOpen(false)
              setTerminalSettingsOpen(true)
            }}
            type="button"
          >
            <Settings aria-hidden size={18} />
          </button>
          <div className="mobile-terminal__menu-wrap">
            <button
              aria-expanded={actionMenuOpen}
              aria-label={actionMenuOpen ? '收起 Agent 操作' : '打开 Agent 操作'}
              className="mobile-terminal__menu-button"
              onClick={() => setActionMenuOpen((open) => !open)}
              type="button"
            >
              <MoreVertical aria-hidden size={18} />
            </button>
            {actionMenuOpen ? (
              <div className="mobile-terminal__action-menu" role="menu">
                <button onClick={() => runAgentAction(onRefresh)} role="menuitem" type="button">
                  刷新
                </button>
                {run ? (
                  <>
                    <button
                      disabled={agentActionsDisabled || sessionBinding}
                      onClick={() => runAgentAction(() => void bindCurrentSession())}
                      role="menuitem"
                      type="button"
                    >
                      {sessionBinding ? '保存中...' : '保存当前会话绑定'}
                    </button>
                    <button
                      disabled={agentActionsDisabled}
                      onClick={() => runAgentAction(onRestart)}
                      role="menuitem"
                      type="button"
                    >
                      重启终端
                    </button>
                    <button
                      className="mobile-terminal__action-menu-danger"
                      disabled={agentActionsDisabled}
                      onClick={() => runAgentAction(onStop)}
                      role="menuitem"
                      type="button"
                    >
                      停止终端
                    </button>
                  </>
                ) : (
                  <button
                    disabled={agentActionsDisabled}
                    onClick={() => runAgentAction(onStart)}
                    role="menuitem"
                    type="button"
                  >
                    启动终端
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {connectionWarning ? (
        <div className="mobile-terminal__message" data-tone={connectionTone} role="status">
          <span>{connectionWarning}</span>
          {onRetryConnection ? (
            <button
              className="mobile-text-button"
              disabled={retryConnectionDisabled}
              onClick={onRetryConnection}
              type="button"
            >
              重试连接
            </button>
          ) : null}
        </div>
      ) : null}
      {message || sendMessage ? (
        <div className="mobile-terminal__message">
          <span>{sendMessage ?? message}</span>
          {pendingRetryInput && run ? (
            <button
              className="mobile-text-button"
              disabled={terminalOwnershipPresentation.retryDisabled}
              onClick={() =>
                void sendChunk(
                  pendingRetryInput.input,
                  pendingRetryInput.actionId,
                  pendingRetryInput.attachments ?? []
                )
              }
              type="button"
            >
              {inputSending ? '重发中...' : '重新发送'}
            </button>
          ) : retryAgentActionLabel ? (
            <button
              className="mobile-text-button"
              disabled={agentActionsDisabled}
              onClick={onRetryAgentAction}
              type="button"
            >
              {retryAgentActionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
      {dangerAction ? (
        <div className="mobile-approval-confirm" role="alert">
          <div>
            <strong>
              {dangerAction === 'stop'
                ? '确认安全停止'
                : dangerAction === 'checkpoint'
                  ? '最新会话状态尚未持久化'
                  : dangerAction === 'force'
                    ? '强制停止可能丢失进度'
                    : '确认重启'}
            </strong>
            <p>
              {dangerAction === 'stop'
                ? `Yive 会先检查 ${agent.name} 的同一 CLI 会话；这一步不会发送消息。`
                : dangerAction === 'checkpoint'
                  ? '创建恢复点会发送一条可见的最小消息，并等待同一 CLI 会话完成后再停止。'
                  : dangerAction === 'force'
                    ? '尚未提交的终端尾部可能永久丢失，且无法从保存的 CLI 会话精确恢复。'
                    : `这会影响电脑端 ${agent.name} 的真实 PTY。只有确定要中断当前 CLI 会话时才继续。`}
            </p>
          </div>
          <div className="mobile-approval-confirm__actions">
            <button className="mobile-text-button" onClick={onCancelDanger} type="button">
              取消
            </button>
            {dangerAction === 'checkpoint' ? (
              <>
                <button className="mobile-danger-button" onClick={onRequestForceStop} type="button">
                  强制停止
                </button>
                <button className="mobile-primary-button" onClick={onConfirmDanger} type="button">
                  创建恢复点并停止
                </button>
              </>
            ) : (
              <button className="mobile-danger-button" onClick={onConfirmDanger} type="button">
                {dangerAction === 'force' ? '仍然强制停止' : '确认'}
              </button>
            )}
          </div>
        </div>
      ) : null}
      {run && portalId && !runIsStale ? (
        <div className="mobile-agent-terminal">
          <MobileMirrorTerminal
            inputProfile={run.terminal_input_profile}
            key={`${run.run_id}:${terminalReconnectKey}`}
            onError={(error) => onTerminalError(run.run_id, error)}
            onOwnershipChange={setTerminalOwnership}
            onSyncStatusChange={(status) => {
              setTerminalSyncStatus(status)
              if (status === 'pending') setTerminalRestoreStarted(true)
            }}
            portalId={portalId}
            runId={run.run_id}
            scrollFrameRatePreference={scrollFrameRatePreference}
            terminalConnectionParams={terminalConnectionParams}
            title={agent.name}
            workspaceId={workspaceId}
          />
          <TerminalFreshnessWatchdog
            key={`${run.run_id}:${terminalReconnectKey}:freshness`}
            onRefresh={() => {
              if (terminalAutoRefreshCount >= 1) return
              setTerminalAutoRefreshCount((count) => count + 1)
              setTerminalReconnectKey((key) => key + 1)
              setTerminalSyncStatus('pending')
              setTerminalRestoreStarted(false)
              onRefresh()
            }}
            restoreStarted={terminalRestoreStarted}
            syncStatus={terminalSyncStatus}
          />
          <MobileAgentComposer
            auxKeys={AUX_KEYS}
            disabled={terminalOwnershipPresentation.inputDisabled}
            disabledMessage={terminalOwnershipPresentation.disabledMessage}
            imageUploading={imageUploading}
            onSendAuxKey={(chunk) => void sendChunk(chunk)}
            onUploadImage={(file) => void sendImageReference(file)}
          />
        </div>
      ) : runIsStale ? (
        <div className="mobile-terminal__empty" role="alert">
          <strong>终端会话已重启或失效。</strong>
          <p>手机端仍指向旧会话，重新连接会刷新当前工作区并绑定最新的 Agent 终端。</p>
          <button className="mobile-primary-button" onClick={onRefresh} type="button">
            重新连接
          </button>
        </div>
      ) : (
        <div className="mobile-terminal__empty">
          该 Agent 暂无运行中的终端。启动后手机端会连接到电脑端真实 PTY。
        </div>
      )}
      {terminalSettingsView}
    </section>
  )
}
