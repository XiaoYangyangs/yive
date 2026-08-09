import { UserRound } from 'lucide-react'

import type { AgentProvider } from '../../../src/shared/types.js'
import { Avatar } from '../ui/Avatar.js'
import { CliAgentAvatar } from '../worker/CliAgentAvatar.js'
import type { AgentStatusPresentationKind } from '../worker/worker-status.js'

type MobileAgentAvatarProps = {
  provider?: AgentProvider | undefined
  kind: 'orchestrator' | 'worker'
  size?: number
  status: AgentStatusPresentationKind
}

/** Reuses the same avatar treatment as the mobile Agent list. */
export const MobileAgentAvatar = ({
  provider,
  kind,
  size = 36,
  status,
}: MobileAgentAvatarProps) => {
  if (kind === 'orchestrator') {
    return (
      <span
        className="mobile-orchestrator-avatar"
        data-status-ring={status}
        aria-hidden
        style={{
          width: `${size}px`,
          height: `${size}px`,
          fontSize: `${Math.round(size * 0.33)}px`,
        }}
      >
        Or
      </span>
    )
  }

  return <CliAgentAvatar provider={provider} size={size} statusRing={status} />
}

export const MobileUserAvatar = ({ size = 32 }: { size?: number }) => (
  <Avatar
    size={size}
    color="var(--accent)"
    fontRatio={0.4}
    className="mobile-user-avatar"
    testId="mobile-user-avatar"
  >
    <UserRound aria-hidden size={Math.round(size * 0.5)} strokeWidth={2.2} />
  </Avatar>
)
