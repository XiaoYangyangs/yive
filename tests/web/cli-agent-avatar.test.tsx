// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { CliAgentAvatar } from '../../web/src/worker/CliAgentAvatar.js'

afterEach(() => cleanup())

describe('CliAgentAvatar - managed Provider logos', () => {
  test.each([
    ['claude', '/cli-icons/claude.png'],
    ['codex', '/cli-icons/codex.png'],
  ] as const)('Provider %s renders %s', (provider, expectedSrc) => {
    render(<CliAgentAvatar provider={provider} />)
    const avatar = screen.getByTestId('cli-agent-avatar')
    expect(avatar.getAttribute('data-provider')).toBe(provider)
    const img = avatar.querySelector('img')
    expect(img?.getAttribute('src')).toBe(expectedSrc)
    expect(img?.getAttribute('decoding')).toBe('sync')
  })
})

describe('CliAgentAvatar - fallback path', () => {
  test('undefined provider falls back (historical workers without a launch config row)', () => {
    // Older workers created before the launch_config table was populated
    // arrive at the UI with provider === undefined. The route layer
    // returns null, the deserializer drops the field, and the avatar must
    // still render something rather than throwing.
    render(<CliAgentAvatar />)
    expect(screen.queryByTestId('cli-agent-avatar')).toBeNull()
    expect(screen.getByTestId('worker-avatar')).toBeInTheDocument()
  })
})

describe('CliAgentAvatar - status halo', () => {
  test('status ring color is wired through to the rendered box-shadow', () => {
    // The halo is the only piece that visually changes between runtime states,
    // so wiring it correctly is the single most testable thing on
    // this component. We assert on the data attribute (semantic) rather than
    // the exact box-shadow string, so a future swap to a CSS variable
    // doesn't break the test for no reason.
    render(<CliAgentAvatar provider="claude" statusRing="busy" />)
    const avatar = screen.getByTestId('cli-agent-avatar')
    expect(avatar.getAttribute('data-status-ring')).toBe('busy')
    expect(avatar.getAttribute('style')).toContain('box-shadow')
  })

  test('statusRing="none" omits the halo entirely', () => {
    render(<CliAgentAvatar provider="codex" statusRing="none" />)
    const avatar = screen.getByTestId('cli-agent-avatar')
    expect(avatar.getAttribute('data-status-ring')).toBe('none')
    // Inline style writes `box-shadow: undefined` as no `box-shadow` declaration
    // at all; assert the negative shape so we catch the regression where the
    // halo paints even when no status is supplied.
    expect(avatar.getAttribute('style') ?? '').not.toContain('box-shadow')
  })
})

describe('CliAgentAvatar - a11y', () => {
  test('decorative avatar exposes nothing to assistive tech (parent button owns the label)', () => {
    // The worker card's outer <button> already carries `aria-label="Open
    // <name>"`. Letting the logo announce "Claude Code" too would create a
    // double-read; keeping the avatar `aria-hidden` and the <img alt=""> is
    // the documented pattern in the repo's Avatar primitive.
    render(<CliAgentAvatar provider="claude" />)
    const avatar = screen.getByTestId('cli-agent-avatar')
    expect(avatar.getAttribute('aria-hidden')).toBe('true')
    const img = avatar.querySelector('img')
    expect(img?.getAttribute('alt')).toBe('')
  })
})
