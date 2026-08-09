import { MobileAgentTerminal, type MobileAgentTerminalProps } from './MobileAgentTerminal.js'
import {
  type MobileAgentDetailMode,
  readInitialMobileAgentDetailMode,
} from './mobile-agent-detail-preference.js'

export type { MobileAgentDetailMode } from './mobile-agent-detail-preference.js'

export const MobileAgentDetail = (props: MobileAgentTerminalProps) => {
  const [mode, setMode] = useState<MobileAgentDetailMode>(readInitialMobileAgentDetailMode)

  return (
    <div className="mobile-agent-detail" data-mode={mode}>
      {mode === 'chat' ? (
        <MobileAgentChat
          agent={props.agent}
          connection={{
            onRetry: props.onRetryConnection,
            retryDisabled: props.retryConnectionDisabled,
            tone: props.connectionTone,
            warning: props.connectionWarning,
          }}
          onBack={props.onBack}
          onOpenTerminal={() => setMode('raw-terminal')}
          runtimeClient={props.runtimeClient}
          workspaceId={props.workspaceId}
        />
      ) : (
        <>
          <button
            className="mobile-agent-detail__chat-return mobile-text-button"
            onClick={() => setMode('chat')}
            type="button"
          >
            返回聊天
          </button>
          <MobileAgentTerminal {...props} key={props.agent.run?.run_id ?? 'no-run'} />
        </>
      )}
    </div>
  )
}

import { useState } from 'react'

import { MobileAgentChat } from './MobileAgentChat.js'
