import { History, MoreHorizontal, SquareTerminal } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  MobileChatAttachment,
  MobileChatSubmission,
  MobileConversationHistoryItem,
  MobileConversationPage,
  MobileRecordedConversationPage,
} from '../../../src/shared/types.js'
import { presentAgentStatus } from '../worker/worker-status.js'
import { MobileAgentAvatar, MobileUserAvatar } from './MobileAgentAvatar.js'
import {
  MobileAgentChatAvailability,
  type MobileAgentChatConnection,
  MobileAgentChatConnectionStatus,
} from './MobileAgentChatStatus.js'
import type { MobileTerminalAgent } from './MobileAgentTerminal.js'
import {
  MobileChatAttachmentCards,
  MobileChatAttachmentPicker,
  type MobileChatDraftAttachment,
} from './MobileChatAttachments.js'
import { MobileConversationContent } from './MobileConversationContent.js'
import { MobileConversationToolActivity } from './MobileConversationToolActivity.js'
import { readMobileChatDeepLink } from './mobile-chat-completion.js'
import {
  clearMobileConversationUnread,
  emitMobileChatUnreadChanged,
  MOBILE_CHAT_UNREAD_CHANGED_EVENT,
} from './mobile-chat-unread.js'
import { validateMobileImageReferenceFile } from './mobile-file-transfer.js'
import type { MobileRuntimeClient } from './mobile-runtime-client.js'
import { useMobileConversationLiveUpdates } from './useMobileConversationLiveUpdates.js'

const getRuntimeErrorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

const conversationActivityLabel = (
  activity: MobileConversationPage['activity_state'],
  loading: boolean
) => {
  if (loading) return '检测中'
  if (activity === 'busy') return '工作中'
  if (activity === 'idle') return '空闲'
  return '状态未知'
}

export const MobileAgentChat = ({
  agent,
  connection,
  onBack,
  onOpenTerminal,
  runtimeClient,
  workspaceId,
}: {
  agent: MobileTerminalAgent
  connection: MobileAgentChatConnection
  onBack: () => void
  onOpenTerminal: () => void
  runtimeClient: MobileRuntimeClient
  workspaceId: string
}) => {
  const [conversation, setConversation] = useState<MobileConversationPage | null>(null)
  const supportsConversationProvider = agent.conversationProvider !== undefined
  const shouldProbeOrchestrator =
    agent.kind === 'orchestrator' && !agent.conversationProvider && !agent.provider
  const canLoadCurrentConversation = supportsConversationProvider || shouldProbeOrchestrator
  const supportsLiveChat =
    supportsConversationProvider || (shouldProbeOrchestrator && conversation !== null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [draftAttachments, setDraftAttachments] = useState<MobileChatDraftAttachment[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [editingSubmissionId, setEditingSubmissionId] = useState<string | null>(null)
  const [optimisticSubmissions, setOptimisticSubmissions] = useState<MobileChatSubmission[]>([])
  const [historyItems, setHistoryItems] = useState<MobileConversationHistoryItem[]>([])
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
  const [selectedHistoricalId, setSelectedHistoricalId] = useState<string | null>(null)
  const status = presentAgentStatus(agent)
  const headerMenuRef = useRef<HTMLDivElement>(null)
  const requestRevisionRef = useRef(0)
  const timelineRef = useRef<HTMLDivElement>(null)
  const followLatestRef = useRef(true)
  const deepLinkConversationIdRef = useRef(readMobileChatDeepLink()?.conversationId ?? null)

  useEffect(() => {
    if (!headerMenuOpen) return

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHeaderMenuOpen(false)
    }
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!headerMenuRef.current?.contains(event.target as Node)) setHeaderMenuOpen(false)
    }

    document.addEventListener('keydown', closeOnEscape)
    document.addEventListener('pointerdown', closeOnOutsidePress)
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      document.removeEventListener('pointerdown', closeOnOutsidePress)
    }
  }, [headerMenuOpen])

  const markConversationRead = useCallback((value: MobileConversationPage | null) => {
    if (!value || !followLatestRef.current) return
    if (clearMobileConversationUnread(window.localStorage, value)) {
      emitMobileChatUnreadChanged()
    }
  }, [])
  const loadConversation = useCallback(async () => {
    const requestRevision = requestRevisionRef.current + 1
    requestRevisionRef.current = requestRevision
    try {
      const next = selectedHistoricalId
        ? await runtimeClient.getRecordedConversation(workspaceId, agent.id, selectedHistoricalId)
        : canLoadCurrentConversation
          ? await runtimeClient.getCurrentConversation(workspaceId, agent.id)
          : null
      if (requestRevision !== requestRevisionRef.current) return
      setConversation(next)
      setError(null)
    } catch (loadError) {
      if (requestRevision !== requestRevisionRef.current) return
      setError(loadError instanceof Error ? loadError.message : '对话加载失败')
    } finally {
      if (requestRevision === requestRevisionRef.current) setLoading(false)
    }
  }, [agent.id, canLoadCurrentConversation, runtimeClient, selectedHistoricalId, workspaceId])

  useMobileConversationLiveUpdates({
    agentId: agent.id,
    conversation,
    loadConversation,
    onError: setError,
    runtimeClient,
    selectedHistoricalId,
    setConversation,
    workspaceId,
  })

  useEffect(() => {
    void loadConversation()
    return () => {
      requestRevisionRef.current += 1
    }
  }, [loadConversation])

  useEffect(() => {
    if (!conversation || selectedHistoricalId || !followLatestRef.current) return
    if (timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight
    }
    markConversationRead(conversation)
  }, [conversation, markConversationRead, selectedHistoricalId])

  useEffect(() => {
    const targetConversationId = deepLinkConversationIdRef.current
    if (!conversation || selectedHistoricalId || !targetConversationId) return
    deepLinkConversationIdRef.current = null
    if (conversation.id !== targetConversationId) {
      setSelectedHistoricalId(targetConversationId)
      setLoading(true)
    }
  }, [conversation, selectedHistoricalId])

  useEffect(() => {
    const clearIfReadingLatest = () => {
      if (!conversation || selectedHistoricalId || !followLatestRef.current) return
      markConversationRead(conversation)
    }
    window.addEventListener(MOBILE_CHAT_UNREAD_CHANGED_EVENT, clearIfReadingLatest)
    return () => window.removeEventListener(MOBILE_CHAT_UNREAD_CHANGED_EVENT, clearIfReadingLatest)
  }, [conversation, markConversationRead, selectedHistoricalId])

  const loadHistory = async (cursor?: string) => {
    try {
      const page = await runtimeClient.listRecordedConversations(workspaceId, agent.id, cursor)
      setHistoryItems((current) => (cursor ? [...current, ...page.items] : page.items))
      setHistoryCursor(page.next_cursor)
      setHistoryOpen(true)
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : '对话历史加载失败')
    }
  }

  const openHistoricalConversation = (item: MobileConversationHistoryItem) => {
    if (item.active) {
      setSelectedHistoricalId(null)
    } else {
      setSelectedHistoricalId(item.id)
    }
    setHistoryOpen(false)
    setLoading(true)
  }

  const loadOlderTurns = async () => {
    if (!selectedHistoricalId || !conversation || !('next_cursor' in conversation)) return
    const cursor = (conversation as MobileRecordedConversationPage).next_cursor
    if (!cursor) return
    const timeline = timelineRef.current
    const previousHeight = timeline?.scrollHeight ?? 0
    const older = await runtimeClient.getRecordedConversation(
      workspaceId,
      agent.id,
      selectedHistoricalId,
      cursor
    )
    if (!older) return
    setConversation((current) =>
      current
        ? {
            ...current,
            next_cursor: older.next_cursor,
            turns: [...older.turns, ...current.turns],
          }
        : older
    )
    requestAnimationFrame(() => {
      if (timeline) timeline.scrollTop += timeline.scrollHeight - previousHeight
    })
  }

  const dismissHistoricalConversation = async (item: MobileConversationHistoryItem) => {
    if (item.active || !window.confirm(`移除“${item.title}”的 Yive 记录？`)) return
    try {
      await runtimeClient.dismissRecordedConversation(workspaceId, agent.id, item.id)
      setHistoryItems((current) => current.filter((candidate) => candidate.id !== item.id))
      if (selectedHistoricalId === item.id) setSelectedHistoricalId(null)
    } catch (dismissError) {
      setError(dismissError instanceof Error ? dismissError.message : '移除对话失败')
    }
  }

  const draftKey = conversation
    ? `yive.mobile.chat-draft:${workspaceId}:${agent.id}:${conversation.provider}:${conversation.cli_session_id}`
    : null
  const undeliveredKey = conversation
    ? `yive.mobile.chat-undelivered:${workspaceId}:${agent.id}:${conversation.provider}:${conversation.cli_session_id}`
    : null
  useEffect(() => {
    if (!draftKey) return
    setDraft(window.localStorage.getItem(draftKey) ?? '')
    setDraftAttachments((items) => {
      for (const item of items) URL.revokeObjectURL(item.previewUrl)
      return []
    })
  }, [draftKey])

  useEffect(() => {
    if (!undeliveredKey) return
    const stored = window.localStorage.getItem(undeliveredKey)
    if (!stored) return
    try {
      const submissions = JSON.parse(stored) as MobileChatSubmission[]
      setOptimisticSubmissions((current) => [
        ...current.filter((item) => item.conversation_id !== conversation?.id),
        ...submissions.filter(
          (item) => item.conversation_id === conversation?.id && item.state === 'undelivered'
        ),
      ])
    } catch {
      window.localStorage.removeItem(undeliveredKey)
    }
  }, [conversation?.id, undeliveredKey])

  useEffect(() => {
    if (!undeliveredKey || !conversation) return
    const acceptedIds = new Set((conversation.submissions ?? []).map((submission) => submission.id))
    const recoverable = optimisticSubmissions.filter(
      (submission) =>
        submission.conversation_id === conversation.id &&
        submission.state === 'undelivered' &&
        !acceptedIds.has(submission.id)
    )
    if (recoverable.length > 0) {
      window.localStorage.setItem(undeliveredKey, JSON.stringify(recoverable))
    } else {
      window.localStorage.removeItem(undeliveredKey)
    }
  }, [conversation, optimisticSubmissions, undeliveredKey])

  const updateDraft = (value: string) => {
    setDraft(value)
    if (!draftKey) return
    if (value) window.localStorage.setItem(draftKey, value)
    else window.localStorage.removeItem(draftKey)
  }

  const uploadDraftAttachment = async (clientId: string, file: File) => {
    setDraftAttachments((items) =>
      items.map((item) =>
        item.clientId === clientId ? { ...item, error: undefined, status: 'uploading' } : item
      )
    )
    try {
      const uploaded = await runtimeClient.uploadFile(workspaceId, file)
      const remote: MobileChatAttachment = {
        file_id: uploaded.id,
        mime_type: uploaded.mime_type,
        name: uploaded.name,
        placeholder: '',
        size: uploaded.size,
      }
      setDraftAttachments((items) =>
        items.map((item) =>
          item.clientId === clientId ? { ...item, remote, status: 'uploaded' } : item
        )
      )
    } catch (uploadError) {
      setDraftAttachments((items) =>
        items.map((item) =>
          item.clientId === clientId
            ? {
                ...item,
                error: uploadError instanceof Error ? uploadError.message : '上传失败',
                status: 'error',
              }
            : item
        )
      )
    }
  }

  const addDraftAttachments = (files: File[]) => {
    const accepted: MobileChatDraftAttachment[] = []
    for (const file of files) {
      const validation = validateMobileImageReferenceFile(file)
      if (!validation.ok) {
        setError(validation.message)
        continue
      }
      accepted.push({
        clientId: globalThis.crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
        status: 'uploading',
      })
    }
    if (accepted.length === 0) return
    setDraftAttachments((items) => [...items, ...accepted])
    for (const item of accepted) void uploadDraftAttachment(item.clientId, item.file)
  }

  const removeDraftAttachment = (clientId: string) => {
    setDraftAttachments((items) => {
      const removed = items.find((item) => item.clientId === clientId)
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      return items.filter((item) => item.clientId !== clientId)
    })
  }

  const clearDraftAttachments = () => {
    setDraftAttachments((items) => {
      for (const item of items) URL.revokeObjectURL(item.previewUrl)
      return []
    })
  }

  const downloadAttachment = async (submissionId: string, attachment: MobileChatAttachment) => {
    try {
      const downloaded = await runtimeClient.downloadChatAttachment(
        workspaceId,
        submissionId,
        attachment.file_id
      )
      const url = URL.createObjectURL(downloaded.content)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = downloaded.name
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : '附件下载失败')
    }
  }

  const submit = async (submission?: MobileChatSubmission) => {
    if (!conversation) return
    const body = submission?.body ?? draft
    const attachments =
      submission?.attachments ??
      draftAttachments.flatMap((item) => (item.remote ? [item.remote] : []))
    if (!body.trim() && attachments.length === 0) return
    const id = submission?.id ?? globalThis.crypto.randomUUID()
    const optimisticState =
      agent.conversationActivity === 'idle' && queuedSubmissions.length === 0
        ? ('sending' as const)
        : ('queued' as const)
    const optimistic: MobileChatSubmission = {
      accepted_at: submission?.accepted_at ?? Date.now(),
      attachments,
      body,
      cancelled_at: null,
      confirmed_at: null,
      conversation_id: conversation.id,
      delivered_at: null,
      error_code: null,
      id,
      provider_event_id: null,
      provider_turn_sequence: null,
      paused_at: null,
      pause_reason: null,
      queue_sequence: submission?.queue_sequence ?? null,
      state: submission?.state === 'queued' ? 'queued' : optimisticState,
    }
    setOptimisticSubmissions((current) => [...current.filter((item) => item.id !== id), optimistic])
    setSubmitting(true)
    try {
      const accepted = await runtimeClient.submitChatMessage(
        workspaceId,
        conversation.id,
        body || undefined,
        id,
        attachments.map(({ file_id }) => ({ file_id }))
      )
      setOptimisticSubmissions((current) => [...current.filter((item) => item.id !== id), accepted])
      if (!submission) {
        updateDraft('')
        clearDraftAttachments()
      }
    } catch (submitError) {
      if (!submission && getRuntimeErrorCode(submitError) === 'chat_queue_capacity') {
        setOptimisticSubmissions((current) => current.filter((item) => item.id !== id))
        updateDraft(body)
        setError(submitError.message)
        return
      }
      setOptimisticSubmissions((current) => [
        ...current.filter((item) => item.id !== id),
        { ...optimistic, error_code: 'runtime_unaccepted', state: 'undelivered' },
      ])
      if (!submission) {
        updateDraft('')
        clearDraftAttachments()
      }
    } finally {
      setSubmitting(false)
    }
  }

  const submitDraft = async () => {
    if (!editingSubmissionId) {
      await submit()
      return
    }
    const current = submissions.get(editingSubmissionId)
    if (!current || !draft.trim()) return
    try {
      const edited = await runtimeClient.editChatSubmission(workspaceId, editingSubmissionId, draft)
      setEditingSubmissionId(null)
      updateDraft('')
      if (current.state === 'undelivered') await submit(edited)
      else {
        setOptimisticSubmissions((items) => [
          ...items.filter((item) => item.id !== edited.id),
          edited,
        ])
      }
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : '消息编辑失败')
      return
    }
  }

  const cancelSubmission = async (submission: MobileChatSubmission) => {
    try {
      const cancelled = await runtimeClient.cancelChatSubmission(workspaceId, submission.id)
      setOptimisticSubmissions((current) => [
        ...current.filter((item) => item.id !== submission.id),
        cancelled,
      ])
      if (editingSubmissionId === submission.id) {
        setEditingSubmissionId(null)
        updateDraft('')
      }
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : '消息取消失败')
      return
    }
  }

  const forceSubmission = async (
    submission: MobileChatSubmission,
    expectedSkippedCount: number
  ) => {
    const confirmed = window.confirm(
      expectedSkippedCount === 0
        ? '立即发送这条消息？'
        : `立即发送这条消息并跳过前面的 ${expectedSkippedCount} 条排队消息？`
    )
    if (!confirmed) return
    try {
      const forced = await runtimeClient.forceChatSubmission(
        workspaceId,
        submission.id,
        expectedSkippedCount
      )
      setOptimisticSubmissions((current) => [
        ...current.filter((item) => item.id !== submission.id),
        forced,
      ])
    } catch (forceError) {
      setError(forceError instanceof Error ? forceError.message : '消息强制发送失败')
    }
  }

  const continueSubmission = async (submission: MobileChatSubmission) => {
    try {
      const continued = await runtimeClient.continueChatSubmission(workspaceId, submission.id)
      setOptimisticSubmissions((current) => [
        ...current.filter((item) => item.id !== submission.id),
        continued,
      ])
    } catch (continueError) {
      setError(
        continueError instanceof Error ? continueError.message : 'Failed to continue message'
      )
    }
  }

  const migrateSubmission = async (submission: MobileChatSubmission) => {
    try {
      const targetConversation = selectedHistoricalId
        ? await runtimeClient.getCurrentConversation(workspaceId, agent.id)
        : conversation
      if (!targetConversation || targetConversation.id === submission.conversation_id) {
        throw new Error('Migration requires a different active conversation')
      }
      const migrated = await runtimeClient.migrateChatSubmission(
        workspaceId,
        submission.id,
        targetConversation.id
      )
      setOptimisticSubmissions((current) => [
        ...current.filter((item) => item.id !== migrated.id),
        migrated,
      ])
      setSelectedHistoricalId(null)
      setConversation({
        ...targetConversation,
        submissions: [
          ...targetConversation.submissions.filter((item) => item.id !== migrated.id),
          migrated,
        ],
      })
    } catch (migrateError) {
      setError(migrateError instanceof Error ? migrateError.message : 'Failed to migrate message')
    }
  }

  const submissions = new Map(
    optimisticSubmissions
      .filter((submission) => submission.conversation_id === conversation?.id)
      .map((submission) => [submission.id, submission] as const)
  )
  for (const submission of conversation?.submissions ?? [])
    submissions.set(submission.id, submission)
  const confirmedProviderEvents = new Set(
    Array.from(submissions.values()).flatMap((submission) =>
      submission.provider_event_id ? [submission.provider_event_id] : []
    )
  )
  const queuedSubmissions = Array.from(submissions.values())
    .filter((submission) => submission.state === 'queued' || submission.state === 'paused')
    .sort((left, right) => left.accepted_at - right.accepted_at || left.id.localeCompare(right.id))
  const queuedPositions = new Map(
    queuedSubmissions.map((submission, index) => [submission.id, index] as const)
  )
  const canSubmit = Boolean(
    conversation &&
      supportsLiveChat &&
      selectedHistoricalId === null &&
      agent.processState === 'running' &&
      (editingSubmissionId !== null || queuedSubmissions.length < 3) &&
      !submitting &&
      draftAttachments.every((item) => item.status === 'uploaded') &&
      (draft.trim() || draftAttachments.length > 0)
  )
  const submissionLabel = (state: MobileChatSubmission['state']) => {
    if (state === 'sending') return '发送中'
    if (state === 'queued') return '排队中'
    if (state === 'paused') return '已暂停'
    if (state === 'delivered') return '已送达'
    if (state === 'confirmed') return '已确认'
    if (state === 'undelivered') return '未送达'
    return '已取消'
  }
  const timelineItems = [
    ...(conversation?.turns
      .filter(
        (turn) => turn.role !== 'user' || !confirmedProviderEvents.has(turn.provider_event_id)
      )
      .map((turn) => ({ kind: 'turn' as const, order: turn.sequence, turn })) ?? []),
    ...Array.from(submissions.values()).map((submission, index) => ({
      kind: 'submission' as const,
      order: submission.provider_turn_sequence ?? Number.MAX_SAFE_INTEGER - 1000 + index,
      submission,
    })),
  ].sort((left, right) => left.order - right.order)
  const lastAssistantEventId = conversation?.turns.findLast(
    (turn) => turn.role === 'assistant'
  )?.provider_event_id
  const conversationActivity = agent.conversationActivity
  const showConversationActivity = canLoadCurrentConversation && selectedHistoricalId === null

  return (
    <section className="mobile-agent-chat" aria-labelledby="mobile-agent-chat-title">
      <div className="mobile-terminal__header mobile-agent-chat__header">
        <button
          className="mobile-text-button"
          onClick={() => {
            if (selectedHistoricalId) {
              setSelectedHistoricalId(null)
              setLoading(true)
            } else onBack()
          }}
          type="button"
        >
          {selectedHistoricalId ? '当前会话' : '返回'}
        </button>
        <div className="mobile-terminal__identity mobile-agent-chat__identity">
          <h2 id="mobile-agent-chat-title">{agent.name}</h2>
          <div className="mobile-agent-chat__subtitle">
            <p>
              {conversation
                ? `${conversation.provider === 'claude' ? 'Claude Code' : 'Codex'} · ${conversation.cli_session_id.slice(0, 8)}`
                : 'Chat'}
            </p>
            {showConversationActivity ? (
              <span
                aria-live="polite"
                className="mobile-agent-chat__activity"
                data-activity={conversationActivity}
                data-testid="mobile-agent-chat-activity"
                title="CLI Agent 当前活动状态"
              >
                <span
                  aria-hidden
                  className={`status-dot ${
                    conversationActivity === 'busy' ? 'status-dot--working' : 'status-dot--idle'
                  }`}
                />
                {conversationActivityLabel(conversationActivity, loading && conversation === null)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="mobile-agent-chat__header-actions" ref={headerMenuRef}>
          <button
            aria-expanded={headerMenuOpen}
            aria-haspopup="menu"
            aria-label={headerMenuOpen ? '收起更多操作' : '打开更多操作'}
            className="mobile-terminal__menu-button"
            onClick={() => setHeaderMenuOpen((open) => !open)}
            title="更多操作"
            type="button"
          >
            <MoreHorizontal aria-hidden size={20} />
          </button>
          {headerMenuOpen ? (
            <div
              aria-label="Agent 聊天操作"
              className="mobile-terminal__action-menu mobile-agent-chat__header-menu"
              role="menu"
            >
              <button
                onClick={() => {
                  setHeaderMenuOpen(false)
                  void loadHistory()
                }}
                role="menuitem"
                type="button"
              >
                <History aria-hidden size={17} />
                历史
              </button>
              <button
                onClick={() => {
                  setHeaderMenuOpen(false)
                  onOpenTerminal()
                }}
                role="menuitem"
                type="button"
              >
                <SquareTerminal aria-hidden size={17} />
                终端
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {historyOpen ? (
        <div className="mobile-agent-chat__history" role="dialog" aria-label="对话历史">
          <header>
            <h3>对话历史</h3>
            <button
              className="mobile-text-button"
              onClick={() => setHistoryOpen(false)}
              type="button"
            >
              关闭
            </button>
          </header>
          {historyItems.map((item) => (
            <div className="mobile-agent-chat__history-row" key={item.id}>
              <button onClick={() => openHistoricalConversation(item)} type="button">
                <strong>{item.title}</strong>
                <span>
                  {item.provider === 'claude' ? 'Claude Code' : 'Codex'} ·{' '}
                  {new Date(item.started_at).toLocaleString()}
                  {item.active ? ' · 当前' : ''}
                </span>
              </button>
              {!item.active ? (
                <button onClick={() => void dismissHistoricalConversation(item)} type="button">
                  移除
                </button>
              ) : null}
            </div>
          ))}
          {historyCursor ? (
            <button
              className="mobile-text-button"
              onClick={() => void loadHistory(historyCursor)}
              type="button"
            >
              加载更多
            </button>
          ) : null}
        </div>
      ) : null}
      <MobileAgentChatConnectionStatus connection={connection} />
      <div
        className="mobile-agent-chat__timeline"
        onScroll={(event) => {
          const target = event.currentTarget
          followLatestRef.current =
            target.scrollHeight - target.scrollTop - target.clientHeight <= 96
          if (followLatestRef.current && conversation) {
            markConversationRead(conversation)
          }
        }}
        ref={timelineRef}
      >
        {selectedHistoricalId &&
        conversation &&
        'next_cursor' in conversation &&
        conversation.next_cursor ? (
          <button
            className="mobile-text-button"
            onClick={() => void loadOlderTurns()}
            type="button"
          >
            加载更早消息
          </button>
        ) : null}
        <MobileAgentChatAvailability
          processState={agent.processState}
          conversation={conversation}
          error={error}
          loading={loading}
          onLoadHistory={() => void loadHistory()}
          onOpenTerminal={onOpenTerminal}
          onReload={() => void loadConversation()}
          selectedHistorical={selectedHistoricalId !== null}
          supportsLiveChat={supportsLiveChat}
        />
        {timelineItems.map((item) => {
          if (item.kind === 'turn') {
            return (
              <div
                className="mobile-agent-chat__message"
                data-role={item.turn.role}
                key={`${conversation?.id}:${item.turn.sequence}`}
              >
                {item.turn.role === 'assistant' ? (
                  <MobileAgentAvatar
                    provider={agent.provider}
                    kind={agent.kind}
                    size={32}
                    status={status.kind}
                  />
                ) : null}
                <article
                  className="mobile-agent-chat__bubble"
                  data-role={item.turn.role}
                  data-working={
                    item.turn.role === 'assistant' &&
                    conversationActivity === 'busy' &&
                    selectedHistoricalId === null &&
                    item.turn.provider_event_id === lastAssistantEventId
                      ? 'true'
                      : undefined
                  }
                >
                  <span>{item.turn.role === 'user' ? '你' : agent.name}</span>
                  {item.turn.role === 'assistant' ? (
                    <MobileConversationContent text={item.turn.text} />
                  ) : (
                    <p>{item.turn.text}</p>
                  )}
                </article>
                {item.turn.role === 'user' ? <MobileUserAvatar size={32} /> : null}
              </div>
            )
          }
          const submission = item.submission
          return (
            <div className="mobile-agent-chat__message" data-role="user" key={submission.id}>
              <article
                className="mobile-agent-chat__bubble"
                data-role="user"
                data-state={submission.state}
              >
                <span>你</span>
                <p>{submission.body}</p>
                <MobileChatAttachmentCards
                  attachments={
                    submission.state === 'cancelled' ? [] : (submission.attachments ?? [])
                  }
                  onDownload={(attachment) => void downloadAttachment(submission.id, attachment)}
                />
                <footer>
                  <span>{submissionLabel(submission.state)}</span>
                  {selectedHistoricalId !== null && submission.state === 'paused' ? (
                    <button onClick={() => void migrateSubmission(submission)} type="button">
                      迁移到当前会话
                    </button>
                  ) : null}
                  {selectedHistoricalId === null &&
                  (submission.state === 'queued' ||
                    submission.state === 'paused' ||
                    submission.state === 'sending' ||
                    submission.state === 'undelivered') ? (
                    <>
                      <button
                        onClick={() => {
                          setEditingSubmissionId(submission.id)
                          updateDraft(submission.body)
                          clearDraftAttachments()
                        }}
                        type="button"
                      >
                        编辑
                      </button>
                      {submission.state === 'undelivered' ? (
                        <button onClick={() => void submit(submission)} type="button">
                          重试
                        </button>
                      ) : null}
                      {submission.state === 'queued' ? (
                        <button
                          onClick={() =>
                            void forceSubmission(
                              submission,
                              queuedPositions.get(submission.id) ?? 0
                            )
                          }
                          type="button"
                        >
                          立即发送
                        </button>
                      ) : null}
                      {submission.state === 'paused' &&
                      submission.conversation_id === conversation?.id ? (
                        <>
                          <button onClick={() => void continueSubmission(submission)} type="button">
                            继续
                          </button>
                          <button
                            onClick={() =>
                              void forceSubmission(
                                submission,
                                queuedPositions.get(submission.id) ?? 0
                              )
                            }
                            type="button"
                          >
                            立即发送
                          </button>
                        </>
                      ) : null}
                      {submission.state === 'paused' &&
                      submission.conversation_id !== conversation?.id ? (
                        <button onClick={() => void migrateSubmission(submission)} type="button">
                          迁移到当前会话
                        </button>
                      ) : null}
                      <button onClick={() => void cancelSubmission(submission)} type="button">
                        取消
                      </button>
                    </>
                  ) : null}
                </footer>
              </article>
              <MobileUserAvatar size={32} />
            </div>
          )
        })}
        <MobileConversationToolActivity
          items={conversation?.tool_activity ?? []}
          key={conversation?.id ?? 'no-conversation-tools'}
        />
        {conversationActivity === 'busy' && selectedHistoricalId === null ? (
          <div
            aria-label={`${agent.name} 工作中`}
            aria-live="polite"
            className="mobile-agent-chat__message mobile-agent-chat__working-message"
            data-role="assistant"
            data-testid="mobile-agent-chat-working-message"
            role="status"
          >
            <MobileAgentAvatar
              provider={agent.provider}
              kind={agent.kind}
              size={32}
              status={status.kind}
            />
            <article
              className="mobile-agent-chat__bubble mobile-agent-chat__working-bubble"
              data-role="assistant"
            >
              <p>
                <span>工作中</span>
                <span className="mobile-agent-chat__typing-dots" aria-hidden>
                  <span />
                  <span />
                  <span />
                </span>
              </p>
            </article>
          </div>
        ) : null}
      </div>
      {conversation && selectedHistoricalId === null ? (
        <form
          className="mobile-agent-chat__composer"
          onSubmit={(event) => {
            event.preventDefault()
            void submitDraft()
          }}
        >
          <MobileChatAttachmentPicker
            disabled={submitting || editingSubmissionId !== null}
            items={draftAttachments}
            onFiles={addDraftAttachments}
            onRemove={removeDraftAttachment}
            onRetry={(clientId) => {
              const item = draftAttachments.find((candidate) => candidate.clientId === clientId)
              if (item) void uploadDraftAttachment(item.clientId, item.file)
            }}
          />
          <textarea
            aria-label="消息"
            onChange={(event) => updateDraft(event.currentTarget.value)}
            placeholder="消息"
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            value={draft}
          />
          <button className="mobile-primary-button" disabled={!canSubmit} type="submit">
            {submitting
              ? '发送中…'
              : editingSubmissionId
                ? submissions.get(editingSubmissionId)?.state === 'undelivered'
                  ? '保存并重试'
                  : '保存'
                : '发送'}
          </button>
        </form>
      ) : null}
    </section>
  )
}
