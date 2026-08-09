// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../web/src/mobile/MobileAgentChat.js', () => ({
  MobileAgentChat: ({ onOpenTerminal }: { onOpenTerminal: () => void }) => (
    <div>
      <span>Chat view</span>
      <button onClick={onOpenTerminal} type="button">
        Open terminal
      </button>
    </div>
  ),
}))

const terminalLifecycle = vi.hoisted(() => ({ mounted: 0, released: 0 }))

vi.mock('../../web/src/mobile/MobileAgentTerminal.js', () => ({
  MobileAgentTerminal: () => {
    useEffect(() => {
      terminalLifecycle.mounted += 1
      return () => {
        terminalLifecycle.released += 1
      }
    }, [])
    return <div>Terminal view</div>
  },
}))

import { MobileAgentDetail } from '../../web/src/mobile/MobileAgentDetail.js'

const props = {
  agent: {
    id: 'agent-1',
    kind: 'worker' as const,
    name: 'Coder',
    runStatus: 'running',
    status: 'working' as const,
  },
  connectionTone: 'ok' as const,
  connectionWarning: null,
  dangerAction: null,
  formatError: () => 'error',
  message: null,
  onBack: vi.fn(),
  onCancelDanger: vi.fn(),
  onConfirmDanger: vi.fn(),
  onFilesChanged: vi.fn(),
  onRefresh: vi.fn(),
  onRestart: vi.fn(),
  onRetryAgentAction: vi.fn(),
  onStart: vi.fn(),
  onStop: vi.fn(),
  onTerminalError: vi.fn(),
  retryAgentActionLabel: null,
  retryConnectionDisabled: false,
  runtimeClient: {} as never,
  staleRunId: null,
  workspaceId: 'workspace-1',
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  window.history.replaceState({}, '', '/mobile')
  terminalLifecycle.mounted = 0
  terminalLifecycle.released = 0
})

describe('mobile Agent detail mode', () => {
  test('ignores the legacy Terminal preference and always starts in Chat', () => {
    localStorage.setItem('yive.mobile.agent-detail.default-view', 'raw-terminal')
    render(<MobileAgentDetail {...props} />)
    expect(screen.getByText('Chat view')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(screen.getByText('Terminal view')).toBeInTheDocument()
    expect(terminalLifecycle).toMatchObject({ mounted: 1, released: 0 })
    const returnButton = document.querySelector<HTMLButtonElement>(
      '.mobile-agent-detail__chat-return'
    )
    if (!returnButton) throw new Error('Expected return-to-Chat control')
    fireEvent.click(returnButton)
    expect(screen.getByText('Chat view')).toBeInTheDocument()
    expect(terminalLifecycle).toMatchObject({ mounted: 1, released: 1 })
  })

  test('keeps explicit Terminal links while conversation links always open Chat', () => {
    window.history.replaceState({}, '', '/mobile?view=chat')
    const view = render(<MobileAgentDetail {...props} />)
    expect(screen.getByText('Chat view')).toBeInTheDocument()

    view.unmount()
    window.history.replaceState({}, '', '/mobile?view=terminal')
    render(<MobileAgentDetail {...props} />)
    expect(screen.getByText('Terminal view')).toBeInTheDocument()

    cleanup()
    window.history.replaceState({}, '', '/mobile?view=terminal&conversation_id=conversation-1')
    render(<MobileAgentDetail {...props} />)
    expect(screen.getByText('Chat view')).toBeInTheDocument()
  })
})
