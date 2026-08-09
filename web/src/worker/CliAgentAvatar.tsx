import type { ReactNode } from 'react'

import type { AgentProvider } from '../../../src/shared/types.js'
import { Avatar } from '../ui/Avatar.js'

import type { AgentStatusPresentationKind } from './worker-status.js'

type StatusRing = AgentStatusPresentationKind | 'none'

type CliAgentAvatarProps = {
  /** Managed Provider from the team list payload. */
  provider?: AgentProvider | undefined
  size?: number
  statusRing?: StatusRing
}

type CliAgentLogoProps = {
  provider?: AgentProvider | undefined
  fallback?: ReactNode
  size?: number
  testId?: string
}

interface LogoSpec {
  src: string
  /** Pale background keeps monochrome Provider logos legible in either theme. */
  surface: string
}

const LOGO_REGISTRY: Record<string, LogoSpec> = {
  claude: { src: '/cli-icons/claude.png', surface: '#f7f5f2' },
  codex: { src: '/cli-icons/codex.png', surface: '#f4f4f4' },
}

const ringColorByStatus: Record<Exclude<StatusRing, 'none'>, string> = {
  'awaiting-report': 'var(--status-orange)',
  busy: 'var(--status-green)',
  crashed: 'var(--status-red)',
  idle: 'var(--text-tertiary)',
  stopped: 'var(--text-tertiary)',
  unknown: 'var(--status-orange)',
}

const getKnownLogo = (provider: AgentProvider | undefined): LogoSpec | null =>
  provider ? (LOGO_REGISTRY[provider] ?? null) : null

export const CliAgentLogo = ({
  provider,
  fallback = null,
  size = 20,
  testId = 'cli-agent-logo',
}: CliAgentLogoProps) => {
  const logo = getKnownLogo(provider)
  if (!logo) return fallback
  const innerSize = Math.round(size * 0.78)
  return (
    <span
      data-testid={testId}
      data-provider={provider}
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded"
      aria-hidden
      style={{
        width: `${size}px`,
        height: `${size}px`,
        background: logo.surface,
        border: '1px solid color-mix(in oklab, var(--text-primary) 12%, transparent)',
      }}
    >
      <img
        src={logo.src}
        alt=""
        decoding="sync"
        width={innerSize}
        height={innerSize}
        style={{ width: `${innerSize}px`, height: `${innerSize}px`, objectFit: 'contain' }}
      />
    </span>
  )
}

/**
 * Shows the managed Provider's brand logo when available; otherwise renders
 * one neutral Worker avatar. Geometry mirrors
 * `Avatar` (square + small radius +
 * two-band status halo via box-shadow) so cards mixing the two avatar kinds
 * stay visually aligned.
 */
export const CliAgentAvatar = ({
  provider,
  size = 32,
  statusRing = 'none',
}: CliAgentAvatarProps) => {
  const logo = getKnownLogo(provider)
  if (!logo) {
    return (
      <Avatar
        size={size}
        color="var(--text-secondary)"
        fontRatio={0.34}
        mono
        ringColor={statusRing === 'none' ? null : ringColorByStatus[statusRing]}
        ringSurface="var(--bg-2)"
        testId="worker-avatar"
        data={{ 'status-ring': statusRing }}
      >
        W
      </Avatar>
    )
  }

  const ring = statusRing === 'none' ? null : ringColorByStatus[statusRing]
  const innerSize = Math.round(size * 0.78)
  return (
    <span
      data-testid="cli-agent-avatar"
      data-provider={provider}
      data-status-ring={statusRing}
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded"
      aria-hidden
      style={{
        width: `${size}px`,
        height: `${size}px`,
        background: logo.surface,
        border: '1px solid color-mix(in oklab, var(--text-primary) 12%, transparent)',
        boxShadow: ring ? `0 0 0 2px var(--bg-1), 0 0 0 4px ${ring}` : undefined,
      }}
    >
      <img
        src={logo.src}
        alt=""
        decoding="sync"
        width={innerSize}
        height={innerSize}
        style={{ width: `${innerSize}px`, height: `${innerSize}px`, objectFit: 'contain' }}
      />
    </span>
  )
}
