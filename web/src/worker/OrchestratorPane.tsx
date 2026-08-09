import { Copy, Crown, LoaderCircle, Pencil, Play, RotateCcw, Save, Square } from 'lucide-react'
import { useState } from 'react'
import { useI18n } from '../i18n.js'
import { EmptyState } from '../ui/EmptyState.js'
import { Tooltip } from '../ui/Tooltip.js'
import { RenameAgentDialog } from './RenameAgentDialog.js'

export type OrchestratorPaneState =
  | { kind: 'starting' }
  | { kind: 'running'; runId: string }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: string }

type OrchestratorPaneProps = {
  name: string
  state: OrchestratorPaneState
  /** Kept for API stability; M6-B will surface stop via the ⌘K palette. */
  onStop: () => void
  onRemoveWorkspace: () => void
  onRename: (name: string) => Promise<{ error: string | null }>
  onStart: () => void
  onRestart: () => void
  onBindCurrentSession: () => void
  sessionBinding: boolean
}

const StartingBody = () => {
  const { t } = useI18n()
  return (
    <div data-testid="orchestrator-starting-body" className="flex flex-1">
      <EmptyState
        icon={<LoaderCircle size={24} className="animate-spin" />}
        title={t('orchestrator.startingTitle')}
        description={t('orchestrator.startingDesc')}
      />
    </div>
  )
}

const StoppedBody = ({ onStart }: { onStart: () => void }) => {
  const { t } = useI18n()
  return (
    <div data-testid="orchestrator-stopped-body" className="flex flex-1">
      <EmptyState
        icon={<Crown size={24} />}
        title={t('orchestrator.stoppedTitle')}
        description={t('orchestrator.stoppedDesc')}
        action={
          <button
            type="button"
            onClick={onStart}
            className="icon-btn icon-btn--primary"
            data-testid="orchestrator-start"
          >
            <Play size={12} aria-hidden /> {t('orchestrator.start')}
          </button>
        }
      />
    </div>
  )
}

const FailedBody = ({
  error,
  onRemoveWorkspace,
  onRestart,
}: {
  error: string
  onRemoveWorkspace: () => void
  onRestart: () => void
}) => {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const copyError = () => {
    void navigator.clipboard
      ?.writeText(error)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  return (
    <div
      data-testid="orchestrator-failed-body"
      className="m-auto flex max-w-[480px] flex-col items-center gap-3 px-6 py-8"
    >
      <div
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded text-sec"
        style={{ background: 'var(--bg-2)', border: '1px solid var(--border-bright)' }}
      >
        <Crown size={24} />
      </div>
      <div className="text-lg font-semibold text-pri">{t('orchestrator.failed')}</div>
      <div className="relative w-full">
        <pre
          data-testid="orchestrator-error-message"
          className="mono w-full max-h-40 overflow-auto whitespace-pre-wrap break-all rounded p-3 text-left text-xs"
          style={{
            background: 'color-mix(in oklab, var(--status-red) 8%, var(--bg-2))',
            border: '1px solid color-mix(in oklab, var(--status-red) 24%, transparent)',
            color: 'var(--text-secondary)',
          }}
        >
          {error}
        </pre>
        <Tooltip label={copied ? t('common.copied') : t('common.copyError')}>
          <button
            type="button"
            onClick={copyError}
            aria-label={t('orchestrator.copyErrorAria')}
            className="icon-btn icon-btn--ghost absolute right-1 top-1 h-6 px-1.5"
            data-testid="orchestrator-copy-error"
          >
            <Copy size={12} aria-hidden />
          </button>
        </Tooltip>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onRestart}
          className="icon-btn icon-btn--primary"
          data-testid="orchestrator-retry"
        >
          <RotateCcw size={12} aria-hidden /> {t('common.retry')}
        </button>
        <button
          type="button"
          onClick={onRemoveWorkspace}
          className="icon-btn icon-btn--danger"
          data-testid="orchestrator-remove-workspace"
        >
          {t('orchestrator.removeWorkspace')}
        </button>
      </div>
      {/* Header retry was a duplicate; alias kept for back-compat. */}
      <span data-testid="orchestrator-retry-header" className="sr-only">
        {t('common.retry')}
      </span>
    </div>
  )
}

export const OrchestratorPane = ({
  name,
  state,
  onRemoveWorkspace,
  onRename,
  onBindCurrentSession,
  onRestart,
  onStart,
  onStop,
  sessionBinding,
}: OrchestratorPaneProps) => {
  const { t } = useI18n()
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameBusy, setRenameBusy] = useState(false)
  const submitRename = async (_agent: { id: string; name: string }, newName: string) => {
    setRenameBusy(true)
    try {
      const result = await onRename(newName)
      if (!result.error) setRenameOpen(false)
    } finally {
      setRenameBusy(false)
    }
  }

  return (
    <div
      className="relative flex h-full w-full min-w-0 flex-col"
      style={{
        background: 'var(--bg-crust)',
        borderRight: '1px solid var(--border)',
      }}
      data-testid="orchestrator-terminal-slot"
    >
      <div
        className="absolute left-3 top-3 z-30 flex max-w-[220px] items-center gap-1 rounded-md border border-[var(--border-bright)] bg-[color-mix(in_oklab,var(--bg-1)_92%,transparent)] p-1 shadow-lg backdrop-blur"
        data-testid="orchestrator-identity"
      >
        <Crown size={13} aria-hidden className="shrink-0 text-sec" />
        <span className="truncate px-1 text-xs font-medium text-pri" title={name}>
          {name}
        </span>
        <Tooltip label={t('orchestrator.rename')}>
          <button
            type="button"
            onClick={() => setRenameOpen(true)}
            aria-label={t('orchestrator.renameAria', { name })}
            className="icon-btn icon-btn--ghost h-6 w-6 p-0"
            data-testid="orchestrator-rename"
          >
            <Pencil size={12} aria-hidden />
          </button>
        </Tooltip>
      </div>
      {state.kind === 'running' ? (
        <>
          <div
            id={`orch-pty-${state.runId}`}
            className="flex h-full w-full"
            data-pty-slot="orchestrator"
          />
          <div
            className="absolute right-3 top-3 z-30 flex items-center gap-1 rounded-md border border-[var(--border-bright)] bg-[color-mix(in_oklab,var(--bg-1)_92%,transparent)] p-1 shadow-lg backdrop-blur"
            data-testid="orchestrator-running-actions"
          >
            <Tooltip label="保存当前会话绑定">
              <button
                type="button"
                onClick={onBindCurrentSession}
                aria-label="保存当前会话绑定"
                disabled={sessionBinding}
                className="icon-btn icon-btn--tertiary h-7 px-2 text-xs"
                data-testid="orchestrator-bind-current-session"
              >
                {sessionBinding ? (
                  <LoaderCircle size={12} className="animate-spin" aria-hidden />
                ) : (
                  <Save size={12} aria-hidden />
                )}
                保存
              </button>
            </Tooltip>
            <Tooltip label={t('common.stop')}>
              <button
                type="button"
                onClick={onStop}
                aria-label={t('common.stop')}
                className="icon-btn icon-btn--danger h-7 px-2 text-xs"
                data-testid="orchestrator-stop"
              >
                <Square size={12} aria-hidden /> {t('common.stop')}
              </button>
            </Tooltip>
            <Tooltip label={t('common.retry')}>
              <button
                type="button"
                onClick={onRestart}
                aria-label={t('common.retry')}
                className="icon-btn icon-btn--tertiary h-7 px-2 text-xs"
                data-testid="orchestrator-restart"
              >
                <RotateCcw size={12} aria-hidden /> {t('common.retry')}
              </button>
            </Tooltip>
          </div>
        </>
      ) : state.kind === 'failed' ? (
        <FailedBody
          error={state.error}
          onRemoveWorkspace={onRemoveWorkspace}
          onRestart={onRestart}
        />
      ) : state.kind === 'stopped' ? (
        <StoppedBody onStart={onStart} />
      ) : (
        <StartingBody />
      )}
      <RenameAgentDialog
        agent={renameOpen ? { id: 'orchestrator', name } : null}
        busy={renameBusy}
        description={t('orchestrator.renameDesc')}
        inputTestId="rename-orchestrator-input"
        onClose={() => setRenameOpen(false)}
        onSubmit={submitRename}
        saveTestId="rename-orchestrator-save"
        title={t('orchestrator.renameTitle')}
      />
    </div>
  )
}
