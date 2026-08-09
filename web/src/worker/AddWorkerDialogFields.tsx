import { Check, SquareTerminal } from 'lucide-react'
import type { ReactNode } from 'react'

import type { AgentProvider } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'
import { CliAgentLogo } from './CliAgentAvatar.js'

export const SectionLabel = ({ children }: { children: ReactNode }) => (
  <span className="text-sm font-medium text-sec">{children}</span>
)

const ProviderChip = ({
  active,
  command,
  displayName,
  logoProvider,
  onSelect,
  testId,
}: {
  active: boolean
  command: string
  displayName: string
  logoProvider?: AgentProvider
  onSelect: () => void
  testId: string
}) => {
  const fallbackIcon = (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-surface-1 text-ter"
      data-testid={`${testId}-generic-icon`}
      aria-hidden
    >
      <SquareTerminal size={13} />
    </span>
  )
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      data-testid={testId}
      className="selectable-card flex items-center justify-between gap-3 px-3 py-2"
    >
      <span className="flex min-w-0 items-center gap-3">
        <CliAgentLogo provider={logoProvider} fallback={fallbackIcon} size={22} />
        <span className="flex min-w-0 flex-col items-start gap-0.5">
          <span className="truncate text-sm font-medium text-pri">{displayName}</span>
          <span className="mono truncate text-xs text-ter">{command}</span>
        </span>
      </span>
      {active ? <Check size={14} className="shrink-0 text-accent" aria-hidden /> : null}
    </button>
  )
}

export const AgentCliPicker = ({
  onProviderChange,
  provider,
}: {
  onProviderChange: (value: AgentProvider | undefined) => void
  provider: AgentProvider | undefined
}) => {
  const { t } = useI18n()
  const providers = [
    { command: 'codex', displayName: 'Codex', id: 'codex' },
    { command: 'claude', displayName: 'Claude Code', id: 'claude' },
  ] as const
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>{t('addWorker.agentCli')}</SectionLabel>
      <div className="grid grid-cols-3 gap-2">
        <ProviderChip
          active={provider === undefined}
          command={t('addWorker.inheritProvider')}
          displayName={t('addWorker.inheritProvider')}
          testId="agent-radio-inherit"
          onSelect={() => onProviderChange(undefined)}
        />
        {providers.map((option) => (
          <ProviderChip
            key={option.id}
            active={provider === option.id}
            command={option.command}
            displayName={option.displayName}
            logoProvider={option.id}
            testId={`agent-radio-${option.id}`}
            onSelect={() => onProviderChange(option.id)}
          />
        ))}
      </div>
    </div>
  )
}
