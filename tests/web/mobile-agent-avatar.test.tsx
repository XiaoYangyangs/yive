// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { MobileAgentAvatar, MobileUserAvatar } from '../../web/src/mobile/MobileAgentAvatar.js'

afterEach(() => cleanup())

describe('mobile chat avatars', () => {
  test('reuses the CLI avatar for a worker and the list avatar for the orchestrator', () => {
    const view = render(
      <>
        <MobileAgentAvatar provider="codex" kind="worker" status="busy" />
        <MobileAgentAvatar kind="orchestrator" status="idle" />
      </>
    )

    expect(view.container.querySelector('[data-testid="cli-agent-avatar"]')).toBeInTheDocument()
    expect(view.container.querySelector('.mobile-orchestrator-avatar')).toHaveAttribute(
      'data-status-ring',
      'idle'
    )
  })

  test('renders a dedicated user avatar', () => {
    render(<MobileUserAvatar />)

    expect(screen.getByTestId('mobile-user-avatar')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-user-avatar').querySelector('svg')).toBeInTheDocument()
  })
})
