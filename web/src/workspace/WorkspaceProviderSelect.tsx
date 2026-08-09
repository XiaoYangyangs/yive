import { Check, ChevronDown, Terminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { AgentProvider } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'

type WorkspaceProviderSelectProps = {
  onChange: (value: AgentProvider) => void
  value: AgentProvider
}

const options = [
  { command: 'codex', id: 'codex', label: 'Codex' },
  { command: 'claude', id: 'claude', label: 'Claude Code' },
] as const

export const WorkspaceProviderSelect = ({ onChange, value }: WorkspaceProviderSelectProps) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.id === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium uppercase tracking-wider text-ter">
        {t('workspace.provider.label')}
      </span>
      <div ref={containerRef} className="cli-select group relative">
        <Terminal size={14} aria-hidden className="cli-select__leading" />
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          className="cli-select__field cli-select__field--button text-left"
          data-testid="workspace-provider"
          data-value={value}
          onClick={() => setOpen((current) => !current)}
        >
          {selected.label}
        </button>
        <ChevronDown size={14} aria-hidden className="cli-select__trailing" />
        {open ? (
          <div
            role="listbox"
            aria-label={t('workspace.provider.optionsAria')}
            className="cli-select__menu"
            data-testid="workspace-provider-menu"
          >
            {options.map((option) => {
              const isSelected = option.id === value
              return (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-testid={`workspace-provider-option-${option.id}`}
                  className="cli-select__option"
                  onClick={() => {
                    onChange(option.id)
                    setOpen(false)
                  }}
                >
                  <Check
                    size={12}
                    aria-hidden
                    className="cli-select__check"
                    style={{ opacity: isSelected ? 1 : 0 }}
                  />
                  <span>{option.label}</span>
                </button>
              )
            })}
          </div>
        ) : null}
      </div>
      <div className="mono flex items-center gap-1.5 truncate text-xs text-ter">
        <span className="text-sec">$</span>
        <span className="truncate">{selected.command}</span>
      </div>
    </div>
  )
}
