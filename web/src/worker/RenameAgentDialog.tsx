import * as Dialog from '@radix-ui/react-dialog'
import { Pencil } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'

type RenameAgentTarget = { id: string; name: string }

type RenameAgentDialogProps<T extends RenameAgentTarget> = {
  agent: T | null
  busy?: boolean
  description: string
  inputTestId: string
  onClose: () => void
  onSubmit: (agent: T, name: string) => void
  saveTestId: string
  title: string
}

export const RenameAgentDialog = <T extends RenameAgentTarget>({
  agent,
  busy = false,
  description,
  inputTestId,
  onClose,
  onSubmit,
  saveTestId,
  title,
}: RenameAgentDialogProps<T>) => {
  const [draft, setDraft] = useState(agent?.name ?? '')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!agent) return
    setDraft(agent.name)
    const id = window.setTimeout(() => inputRef.current?.select(), 30)
    return () => window.clearTimeout(id)
  }, [agent])

  if (!agent) return null
  const trimmed = draft.trim()
  const canSave = trimmed.length > 0 && trimmed !== agent.name && !busy

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (canSave) onSubmit(agent, trimmed)
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="rename-agent-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            data-testid="rename-agent-dialog"
            className="dialog-scale-pop elev-2 pointer-events-auto w-[420px] max-w-full rounded-lg border p-5"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
          >
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex items-start gap-3">
                <div
                  aria-hidden
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded"
                  style={{
                    background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
                    border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
                    color: 'var(--accent)',
                  }}
                >
                  <Pencil size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <Dialog.Title className="text-lg font-semibold text-pri">{title}</Dialog.Title>
                  <Dialog.Description className="mt-1 text-sm text-ter">
                    {description}
                  </Dialog.Description>
                </div>
              </div>
              <label className="flex flex-col gap-2">
                <span className="text-xs font-medium uppercase tracking-wider text-ter">Name</span>
                <input
                  ref={inputRef}
                  type="text"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  maxLength={64}
                  className="input"
                  data-testid={inputTestId}
                />
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={onClose} className="icon-btn">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!canSave}
                  className="icon-btn icon-btn--primary"
                  data-testid={saveTestId}
                >
                  {busy ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
