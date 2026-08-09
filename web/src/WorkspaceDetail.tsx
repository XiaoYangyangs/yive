import { lazy, Suspense, useEffect, useRef, useState } from 'react'

import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import {
  bindAgentCurrentSession,
  getAgentSummary,
  isWorkspaceShellRun,
  type OrchestratorStartResult,
  renameAgent,
  stopAgentRun,
  type TerminalRunSummary,
} from './api.js'
import { useI18n } from './i18n.js'
import { WorkspaceNotifications } from './notifications/WorkspaceNotifications.js'
import { describeSessionSaveResult, waitForSessionSaveResult } from './session-save-polling.js'
import { TerminalBottomPanel } from './terminal/TerminalBottomPanel.js'
import { useTerminalPanelTabs } from './terminal/useTerminalPanelTabs.js'
import { findRunByAgentId, orchestratorAgentId } from './terminal/useTerminalRuns.js'
import { useWorkspaceShellLauncher } from './terminal/useWorkspaceShellLauncher.js'
import { useToast } from './ui/useToast.js'
import { usePaneSplit } from './usePaneSplit.js'
import { AgentSafeStopDialog, type AgentSafeStopDialogState } from './worker/AgentSafeStopDialog.js'
import { OrchestratorPane } from './worker/OrchestratorPane.js'
import { useOrchestratorPaneState } from './worker/useOrchestratorPaneState.js'
import type { WorkerActions } from './worker/useWorkerActions.js'
import { useWorkerComposer } from './worker/useWorkerComposer.js'
import { WelcomePane } from './worker/WelcomePane.js'
import { WorkersPane } from './worker/WorkersPane.js'

const AddWorkerDialog = lazy(() =>
  import('./worker/AddWorkerDialog.js').then((module) => ({ default: module.AddWorkerDialog }))
)
const WorkerModal = lazy(() =>
  import('./worker/WorkerModal.js').then((module) => ({ default: module.WorkerModal }))
)

type WorkspaceDetailProps = {
  onCreateWorker: WorkerActions['createWorker']
  onDeleteWorker: (workerId: string) => Promise<void>
  onDeleteWorkspace: (workspace: WorkspaceSummary) => Promise<void>
  onStartWorker: (workerId: string) => Promise<{ error: string | null; runId: string | null }>
  onStopWorker: (workerId: string) => Promise<{ error: string | null }>
  onOrchestratorResult: (workspaceId: string, result: OrchestratorStartResult) => void
  onRequestAddWorkspace: () => void
  onShellRunClosed?: (workspaceId: string, runId: string) => void
  onShellRunStarted?: (workspaceId: string, run: TerminalRunSummary) => void
  onTryDemo?: () => void
  welcomeDisabledReason?: string
  orchestratorAutostartError: string | null
  orchestratorAutostartRunId: string | null
  terminalRuns: TerminalRunSummary[]
  workers: TeamListItem[]
  workspace: WorkspaceSummary | undefined
}

export const WorkspaceDetail = ({
  onCreateWorker,
  onDeleteWorker,
  onDeleteWorkspace,
  onStartWorker,
  onStopWorker,
  onOrchestratorResult,
  onRequestAddWorkspace,
  onShellRunClosed,
  onShellRunStarted,
  onTryDemo,
  welcomeDisabledReason,
  orchestratorAutostartError,
  orchestratorAutostartRunId,
  terminalRuns,
  workers,
  workspace,
}: WorkspaceDetailProps) => {
  const { t } = useI18n()
  const [activeWorkerId, setActiveWorkerId] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [deleteWorkerError, setDeleteWorkerError] = useState<string | null>(null)
  const [startWorkerError, setStartWorkerError] = useState<string | null>(null)
  const [stopWorkerError, setStopWorkerError] = useState<string | null>(null)
  const [startingWorkerId, setStartingWorkerId] = useState<string | null>(null)
  const [stoppingWorkerId, setStoppingWorkerId] = useState<string | null>(null)
  const [sessionBindingAgentId, setSessionBindingAgentId] = useState<string | null>(null)
  const [orchestratorName, setOrchestratorName] = useState('Orchestrator')
  const sessionBindingAbortRef = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      sessionBindingAbortRef.current?.abort()
    },
    []
  )
  const [safeStop, setSafeStop] = useState<{
    dialog: AgentSafeStopDialogState
    target: { agentId: string; agentName: string; runId: string }
  } | null>(null)
  const [terminalPanelHidden, setTerminalPanelHidden] = useState(false)
  const toast = useToast()
  const workspaceId = workspace?.id
  useEffect(() => {
    setOrchestratorName('Orchestrator')
    if (!workspaceId) return
    let cancelled = false
    void getAgentSummary(workspaceId, orchestratorAgentId(workspaceId))
      .then((agent) => {
        if (!cancelled) setOrchestratorName(agent.name)
      })
      .catch((error: unknown) => {
        // Keep the migration default visible while making an unexpected lookup failure diagnosable.
        console.warn('[hive] orchestrator identity lookup failed', error)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])
  const composer = useWorkerComposer({
    createWorker: onCreateWorker,
    open: composerOpen,
    workers,
  })
  const orchestrator = useOrchestratorPaneState({
    workspaceId: workspace?.id ?? '',
    terminalRuns,
    autostartError: orchestratorAutostartError,
    suppressAutostartRunId: orchestratorAutostartRunId,
    onClearAutostartError: () => {
      if (workspace) onOrchestratorResult(workspace.id, { ok: true, error: null, run_id: null })
    },
    onAfterStart: (result) => {
      if (workspace) onOrchestratorResult(workspace.id, result)
    },
  })
  const split = usePaneSplit()
  const activeWorker: TeamListItem | null =
    workers.find((worker) => worker.id === activeWorkerId) ?? null
  useEffect(() => {
    if (activeWorkerId && !activeWorker) setActiveWorkerId(null)
  }, [activeWorkerId, activeWorker])
  const panelTabs = useTerminalPanelTabs({
    workspaceId: workspace?.id ?? '',
    workers,
    terminalRuns,
  })
  const shellPanelTabs = panelTabs.tabs.filter((tab) => tab.kind === 'shell')
  const shellRuns = workspace
    ? terminalRuns.filter((run) => isWorkspaceShellRun(run, workspace.id))
    : []
  const { closeShellTab, openShell, shellError, shellStarting, startNewShell } =
    useWorkspaceShellLauncher({
      onCloseFailed: (message) =>
        toast.show({ kind: 'error', message: t('shellTerminal.closeFailed', { message }) }),
      onShellRunClosed,
      onShellRunStarted,
      panelTabs,
      shellRuns,
      workspaceId: workspace?.id ?? null,
    })

  // Surface composer / delete errors as toasts instead of inline alert bands.
  useEffect(() => {
    if (composer.createWorkerError)
      toast.show({ kind: 'error', message: composer.createWorkerError })
  }, [composer.createWorkerError, toast])

  useEffect(() => {
    if (deleteWorkerError) toast.show({ kind: 'error', message: deleteWorkerError })
  }, [deleteWorkerError, toast])

  // Start failures no longer have a modal banner to display them — surface
  // via toast to keep parity with delete-error feedback.
  useEffect(() => {
    if (startWorkerError) toast.show({ kind: 'error', message: startWorkerError })
  }, [startWorkerError, toast])

  useEffect(() => {
    if (stopWorkerError) toast.show({ kind: 'error', message: stopWorkerError })
  }, [stopWorkerError, toast])

  // Shell-start failures no longer have a dialog banner — surface via toast.
  useEffect(() => {
    if (shellError) toast.show({ kind: 'error', message: shellError })
  }, [shellError, toast])

  // B2: when the user switches workspace, clear local error state so we don't
  // surface a stale error from the previous workspace as a fresh toast.
  // biome-ignore lint/correctness/useExhaustiveDependencies: effect intentionally fires only on workspace switch
  useEffect(() => {
    setActiveWorkerId(null)
    setDeleteWorkerError(null)
    setStartWorkerError(null)
    setStopWorkerError(null)
    setStartingWorkerId(null)
    setStoppingWorkerId(null)
    setSessionBindingAgentId(null)
    setSafeStop(null)
    setTerminalPanelHidden(false)
  }, [workspace?.id])

  if (!workspace) {
    const welcomeProps: {
      onAddWorkspace: () => void
      onTryDemo?: () => void
      disabledReason?: string
    } = { onAddWorkspace: onRequestAddWorkspace }
    if (onTryDemo) welcomeProps.onTryDemo = onTryDemo
    if (welcomeDisabledReason) welcomeProps.disabledReason = welcomeDisabledReason
    return <WelcomePane {...welcomeProps} />
  }

  const activeWorkerRun = activeWorker ? findRunByAgentId(terminalRuns, activeWorker.id) : undefined

  const bindCurrentSession = async (agentId: string) => {
    if (sessionBindingAgentId) return
    sessionBindingAbortRef.current?.abort()
    const abortController = new AbortController()
    sessionBindingAbortRef.current = abortController
    setSessionBindingAgentId(agentId)
    try {
      let result = await bindAgentCurrentSession(workspace.id, agentId)
      if (result.state === 'waiting') {
        toast.show({
          kind: 'warning',
          message: '等待 CLI 确认当前会话，确认后会自动保存',
        })
        result = await waitForSessionSaveResult(
          result,
          () => bindAgentCurrentSession(workspace.id, agentId),
          { signal: abortController.signal }
        )
      }
      const presentation = describeSessionSaveResult(result, {
        missingSessionId: 'CLI session save completed without a session id',
        saved: (sessionId) => `已保存当前会话绑定：${sessionId}`,
        unchanged: (sessionId) => `当前会话绑定已保存：${sessionId}`,
        unresolved: '当前没有运行中的 CLI 会话，无法保存',
        verificationFailed: 'CLI session verification failed',
      })
      if (!presentation) return
      if (presentation.kind === 'error') throw new Error(presentation.message)
      toast.show({
        kind: presentation.kind === 'success' ? 'success' : 'warning',
        message: presentation.message,
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      const message = error instanceof Error ? error.message : String(error)
      toast.show({ kind: 'error', message: `保存当前会话绑定失败：${message}` })
    } finally {
      if (sessionBindingAbortRef.current === abortController) {
        sessionBindingAbortRef.current = null
      }
      setSessionBindingAgentId(null)
    }
  }

  const handleDeleteWorker = (worker: TeamListItem) => {
    setDeleteWorkerError(null)
    void onDeleteWorker(worker.id)
      .then(() => setActiveWorkerId(null))
      .catch((error) => {
        setDeleteWorkerError(error instanceof Error ? error.message : String(error))
      })
  }

  const handleStartWorker = (worker: TeamListItem) => {
    setStartWorkerError(null)
    setStartingWorkerId(worker.id)
    void onStartWorker(worker.id)
      .then(({ error }) => {
        if (error) setStartWorkerError(error)
      })
      .catch((error) => {
        setStartWorkerError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setStartingWorkerId(null))
  }

  const handleStopWorker = (worker: TeamListItem) => {
    const run = findRunByAgentId(terminalRuns, worker.id)
    if (run) {
      requestSafeStop({ agentId: worker.id, agentName: worker.name, runId: run.run_id })
      return
    }
    setStopWorkerError(null)
    setStoppingWorkerId(worker.id)
    void onStopWorker(worker.id)
      .then(({ error }) => {
        if (error) setStopWorkerError(error)
      })
      .catch((error) => {
        setStopWorkerError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setStoppingWorkerId(null))
  }

  const executeSafeStop = async (
    target: { agentId: string; agentName: string; runId: string },
    mode: 'checkpoint' | 'force' | 'safe'
  ) => {
    setSafeStop({
      dialog: {
        agentName: target.agentName,
        kind: mode === 'checkpoint' ? 'synchronizing' : 'checking',
      },
      target,
    })
    setStoppingWorkerId(target.agentId)
    try {
      const result = await stopAgentRun(target.runId, mode)
      if (result.state === 'stopped') {
        setSafeStop(null)
        toast.show({
          kind: 'success',
          message: `${target.agentName} ${mode === 'force' ? '已强制停止' : '已安全停止'}`,
        })
        return
      }
      const checkpointUnavailable =
        result.reason === 'provider_unsupported' || result.reason === 'session_changed'
      setSafeStop({
        dialog: {
          agentName: target.agentName,
          kind:
            result.state === 'checkpoint_required' && mode === 'safe' && !checkpointUnavailable
              ? 'confirmation_required'
              : 'failed',
        },
        target,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSafeStop({ dialog: { agentName: target.agentName, kind: 'failed' }, target })
      toast.show({ kind: 'error', message: `安全停止失败：${message}` })
    } finally {
      setStoppingWorkerId(null)
    }
  }

  const requestSafeStop = (target: { agentId: string; agentName: string; runId: string }) => {
    void executeSafeStop(target, 'safe')
  }

  const handleRenameWorker = async (
    worker: TeamListItem,
    newName: string
  ): Promise<{ error: string | null }> => {
    try {
      await renameAgent(workspace.id, worker.id, newName)
      toast.show({
        kind: 'success',
        message: t('worker.renameSuccess', { name: newName }),
      })
      return { error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.show({ kind: 'error', message: t('worker.renameFailed', { message }) })
      return { error: message }
    }
  }

  const handleRenameOrchestrator = async (newName: string) => {
    try {
      const renamed = await renameAgent(workspace.id, orchestratorAgentId(workspace.id), newName)
      setOrchestratorName(renamed.name)
      toast.show({ kind: 'success', message: `Renamed to "${renamed.name}".` })
      return { error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.show({ kind: 'error', message: `Rename failed: ${message}` })
      return { error: message }
    }
  }

  const orchWidth = `${(split.orchPct * 100).toFixed(2)}%`
  const openShellTerminal = () => {
    setTerminalPanelHidden(false)
    openShell()
  }
  const startNewShellFromPanel = () => {
    setTerminalPanelHidden(false)
    startNewShell()
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-2)' }}>
      <WorkspaceNotifications terminalRuns={terminalRuns} workers={workers} workspace={workspace} />
      <div ref={split.containerRef} className="relative flex min-h-0 flex-1">
        <div
          className="flex min-w-[480px] shrink-0 flex-col"
          style={{ width: orchWidth }}
          data-testid="orchestrator-pane-shell"
        >
          <OrchestratorPane
            name={orchestratorName}
            state={orchestrator.state}
            onStop={() => {
              if (orchestrator.state.kind !== 'running') return
              requestSafeStop({
                agentId: orchestratorAgentId(workspace.id),
                agentName: orchestratorName,
                runId: orchestrator.state.runId,
              })
            }}
            onRemoveWorkspace={() => {
              void onDeleteWorkspace(workspace).catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error)
                toast.show({ kind: 'error', message: `Delete failed: ${message}` })
              })
            }}
            onStart={orchestrator.start}
            onRestart={orchestrator.restart}
            onRename={handleRenameOrchestrator}
            onBindCurrentSession={() => void bindCurrentSession(orchestratorAgentId(workspace.id))}
            sessionBinding={sessionBindingAgentId === orchestratorAgentId(workspace.id)}
          />
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: <hr> can't host pointer/keyboard handlers and the visible accent line; aria role="separator" is the canonical resize-handle role */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('workerPane.resize')}
          aria-valuenow={Math.round(split.orchPct * 100)}
          aria-valuemin={30}
          aria-valuemax={78}
          tabIndex={0}
          className="pane-splitter"
          style={{ left: `calc(${orchWidth} - 4px)` }}
          data-dragging={split.dragging || undefined}
          data-testid="pane-splitter"
          onPointerDown={split.beginDrag}
          onKeyDown={split.onKeyDown}
        />
        <div className="relative flex min-w-0 flex-1 flex-col">
          <WorkersPane
            onAddWorkerClick={() => setComposerOpen(true)}
            onDeleteWorker={handleDeleteWorker}
            onOpenShellTerminal={openShellTerminal}
            onOpenWorker={(worker) => setActiveWorkerId(worker.id)}
            onRenameWorker={handleRenameWorker}
            onStartWorker={handleStartWorker}
            onStopWorker={handleStopWorker}
            startingWorkerId={startingWorkerId ?? stoppingWorkerId}
            terminalRuns={terminalRuns}
            workers={workers}
          />
          {terminalPanelHidden ? null : (
            <TerminalBottomPanel
              tabs={shellPanelTabs}
              activeId={panelTabs.activeId}
              scopeKey={workspace.id}
              onSelect={panelTabs.setActive}
              onClose={(tabId) => {
                if (tabId.startsWith('shell:')) {
                  closeShellTab(tabId.slice('shell:'.length))
                }
                panelTabs.closeTab(tabId)
              }}
              onClosePanel={() => setTerminalPanelHidden(true)}
              onNewShell={startNewShellFromPanel}
              newShellPending={shellStarting}
              onStartWorker={(workerId) => {
                const worker = workers.find((w) => w.id === workerId)
                if (worker) handleStartWorker(worker)
              }}
              startingWorkerId={startingWorkerId}
            />
          )}
        </div>
      </div>
      {activeWorker ? (
        <Suspense fallback={null}>
          <WorkerModal
            onClose={() => setActiveWorkerId(null)}
            onBindCurrentSession={(worker) => void bindCurrentSession(worker.id)}
            onStart={handleStartWorker}
            runId={activeWorkerRun?.run_id ?? null}
            sessionBinding={sessionBindingAgentId === activeWorker.id}
            startError={startWorkerError}
            starting={startingWorkerId === activeWorker.id}
            worker={activeWorker}
          />
        </Suspense>
      ) : null}
      {composerOpen ? (
        <Suspense fallback={null}>
          <AddWorkerDialog
            creating={composer.creating}
            onClose={() => setComposerOpen(false)}
            onNameChange={composer.setWorkerName}
            onProviderChange={composer.setProvider}
            onRandomName={composer.randomizeWorkerName}
            onSubmit={(event) => composer.submit(event, () => setComposerOpen(false))}
            provider={composer.provider}
            workerName={composer.workerName}
          />
        </Suspense>
      ) : null}
      {safeStop ? (
        <AgentSafeStopDialog
          state={safeStop.dialog}
          onCancel={() => setSafeStop(null)}
          onCheckpoint={() => void executeSafeStop(safeStop.target, 'checkpoint')}
          onForce={() => void executeSafeStop(safeStop.target, 'force')}
        />
      ) : null}
    </div>
  )
}
