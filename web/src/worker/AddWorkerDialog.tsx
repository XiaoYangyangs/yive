import * as Dialog from '@radix-ui/react-dialog'
import { Dices } from 'lucide-react'
import { type FormEvent, useEffect, useRef } from 'react'

import type { AgentProvider } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'
import { Tooltip } from '../ui/Tooltip.js'
import { useToast } from '../ui/useToast.js'
import { AgentCliPicker, SectionLabel } from './AddWorkerDialogFields.js'

type AddWorkerDialogProps = {
  creating?: boolean
  onClose: () => void
  onNameChange: (value: string) => void
  onProviderChange: (value: AgentProvider | undefined) => void
  onRandomName: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  provider: AgentProvider | undefined
  workerName: string
  writeDisabledReason?: string
}

export const AddWorkerDialog = ({
  creating = false,
  onClose,
  onNameChange,
  onProviderChange,
  onRandomName,
  onSubmit,
  provider,
  workerName,
  writeDisabledReason,
}: AddWorkerDialogProps) => {
  const { t } = useI18n()
  const toast = useToast()
  const nameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const id = window.setTimeout(() => nameInputRef.current?.focus(), 30)
    return () => window.clearTimeout(id)
  }, [])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    const reason = writeDisabledReason || (!workerName.trim() ? t('addWorker.enterName') : null)
    if (reason) {
      event.preventDefault()
      toast.show({ kind: 'warning', message: reason })
      return
    }
    onSubmit(event)
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="add-worker-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            data-testid="add-worker-content"
            className="dialog-scale-pop elev-2 pointer-events-auto flex max-h-[calc(100vh-32px)] w-[560px] max-w-full flex-col rounded-lg border"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
          >
            <form
              onSubmit={handleSubmit}
              aria-label={t('addWorker.title')}
              className="flex flex-col"
            >
              <div
                className="flex shrink-0 flex-col gap-0.5 border-b px-5 py-4"
                style={{ borderColor: 'var(--border)' }}
              >
                <Dialog.Title className="text-lg font-semibold text-pri">
                  {t('addWorker.title')}
                </Dialog.Title>
                <Dialog.Description className="text-sm text-ter">
                  {t('addWorker.description', { command: 'team send' })}
                </Dialog.Description>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
                <label className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <SectionLabel>{t('addWorker.name')}</SectionLabel>
                    <Tooltip label={t('addWorker.randomTooltip')}>
                      <button
                        type="button"
                        aria-label={t('addWorker.randomAria')}
                        className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-ter transition-colors hover:bg-3 hover:text-sec"
                        onClick={onRandomName}
                        data-testid="random-worker-name"
                      >
                        <Dices size={12} aria-hidden />
                        {t('addWorker.random')}
                      </button>
                    </Tooltip>
                  </div>
                  <input
                    ref={nameInputRef}
                    value={workerName}
                    onChange={(event) => onNameChange(event.target.value)}
                    placeholder={t('addWorker.namePlaceholder')}
                    className="input"
                  />
                </label>
                <AgentCliPicker onProviderChange={onProviderChange} provider={provider} />
              </div>
              <div
                className="flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3"
                style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
              >
                <button
                  type="button"
                  onClick={onClose}
                  className="icon-btn"
                  data-testid="add-worker-cancel"
                >
                  {t('addWorker.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={creating || Boolean(writeDisabledReason)}
                  title={writeDisabledReason}
                  className="icon-btn icon-btn--primary"
                  data-testid="add-worker-submit"
                >
                  {creating ? t('addWorker.creating') : t('addWorker.create')}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
