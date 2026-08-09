import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, LoaderCircle, Play, Save, X } from 'lucide-react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'
import { Tooltip } from '../ui/Tooltip.js'
import { CliAgentAvatar } from './CliAgentAvatar.js'
import { useWorkerModalResize, WORKER_MODAL_MIN } from './useWorkerModalResize.js'
import { presentAgentStatus } from './worker-status.js'

type WorkerModalProps = {
  onClose: () => void
  onBindCurrentSession: (worker: TeamListItem) => void
  onStart: (worker: TeamListItem) => void
  runId: string | null
  sessionBinding: boolean
  startError: string | null
  starting: boolean
  worker: TeamListItem
}

/**
 * Worker detail dialog — pure PTY view. All control actions (Stop / Restart /
 * Delete / Start) live on the WorkerCard's hover cluster now; this dialog
 * only handles "watch the terminal" + "close". The empty-state Start button
 * is the lone exception so a stopped agent is restartable from inside.
 */
export const WorkerModal = ({
  onClose,
  onBindCurrentSession,
  onStart,
  runId,
  sessionBinding,
  startError,
  starting,
  worker,
}: WorkerModalProps) => {
  const { t } = useI18n()
  const ptyRunning = !!runId
  const status = presentAgentStatus(worker)
  const resize = useWorkerModalResize()

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose()
  }

  return (
    <Dialog.Root open onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="worker-modal-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center">
          <Dialog.Content
            data-testid="worker-modal"
            aria-label={t('worker.detail', { name: worker.name })}
            className="dialog-scale-pop pointer-events-auto relative flex h-screen max-h-screen max-w-full flex-col overflow-hidden"
            onEscapeKeyDown={(event) => event.preventDefault()}
            style={{
              background: 'var(--bg-1)',
              width: `${resize.width}px`,
            }}
          >
            {/* biome-ignore lint/a11y/useSemanticElements: aria role="separator" is the canonical resize-handle role */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('worker.widthResize')}
              aria-valuemin={WORKER_MODAL_MIN}
              aria-valuenow={Math.round(resize.width)}
              className="modal-resize-handle modal-resize-handle--left"
              tabIndex={-1}
              data-resizing={resize.resizing || undefined}
              onPointerDown={resize.beginResize('left')}
            />
            {/* biome-ignore lint/a11y/useSemanticElements: aria role="separator" is the canonical resize-handle role */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('worker.widthResize')}
              aria-valuemin={WORKER_MODAL_MIN}
              aria-valuenow={Math.round(resize.width)}
              className="modal-resize-handle modal-resize-handle--right"
              tabIndex={-1}
              data-resizing={resize.resizing || undefined}
              onPointerDown={resize.beginResize('right')}
            />
            <Dialog.Title className="sr-only">{worker.name}</Dialog.Title>
            <Dialog.Description className="sr-only">
              Worker agent — status {status.label}
            </Dialog.Description>

            {startError ? (
              <div
                role="alert"
                className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs"
                style={{
                  background: 'color-mix(in oklab, var(--status-red) 10%, transparent)',
                  borderColor: 'color-mix(in oklab, var(--status-red) 30%, var(--border))',
                  color: 'var(--status-red)',
                }}
              >
                <AlertTriangle size={12} aria-hidden />
                <span className="break-words">{startError}</span>
              </div>
            ) : null}

            <div
              className="relative flex min-h-0 flex-1 flex-col p-3"
              data-testid="worker-modal-terminal-slot"
            >
              <Tooltip label={t('common.close')}>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Close worker detail"
                    className="float-action absolute top-4 right-4 z-10"
                  >
                    <X size={14} aria-hidden />
                  </button>
                </Dialog.Close>
              </Tooltip>
              {ptyRunning ? (
                <Tooltip label="保存当前会话绑定">
                  <button
                    type="button"
                    aria-label="保存当前会话绑定"
                    className="float-action absolute right-14 top-4 z-10"
                    disabled={sessionBinding}
                    onClick={() => onBindCurrentSession(worker)}
                    data-testid="worker-bind-current-session"
                  >
                    {sessionBinding ? (
                      <LoaderCircle size={14} className="animate-spin" aria-hidden />
                    ) : (
                      <Save size={14} aria-hidden />
                    )}
                  </button>
                </Tooltip>
              ) : null}

              <div
                className="flex min-h-0 flex-1 rounded-lg border"
                style={{ background: 'var(--bg-crust)', borderColor: 'var(--border)' }}
              >
                {ptyRunning ? (
                  <div
                    id={`worker-pty-${runId}`}
                    className="flex h-full w-full"
                    data-pty-slot="worker"
                  />
                ) : (
                  <div className="m-auto flex max-w-[400px] flex-col items-center gap-3 px-6 text-center">
                    <CliAgentAvatar provider={worker.provider} size={48} />
                    <div className="text-sm text-pri">{worker.name}</div>
                    <div className="text-xs text-ter">
                      {worker.processState !== 'running'
                        ? t('worker.terminalStopped')
                        : t('worker.terminalNotStarted')}
                      {worker.queuedDispatchCount > 0
                        ? t('worker.pendingResume', { count: worker.queuedDispatchCount })
                        : t('worker.startAgent')}
                    </div>
                    <button
                      type="button"
                      onClick={() => onStart(worker)}
                      disabled={starting}
                      className="icon-btn icon-btn--primary"
                      data-testid="worker-start-empty"
                    >
                      <Play size={12} aria-hidden />{' '}
                      {starting ? t('common.starting') : t('common.start')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
