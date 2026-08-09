// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { Topbar } from '../../web/src/layout/Topbar.js'

afterEach(() => {
  cleanup()
})

describe('Topbar version update hint', () => {
  test('shows an update badge and install hint when a newer version is available', () => {
    render(
      <Topbar
        hideActions
        version="0.6.0-alpha.3"
        versionInfo={{
          currentVersion: '0.6.0-alpha.3',
          installHint: 'yive update',
          latestVersion: '0.6.0-alpha.4',
          packageName: 'yive',
          releaseUrl: 'https://www.npmjs.com/package/yive/v/0.6.0-alpha.4',
          updateAvailable: true,
        }}
      />
    )

    expect(screen.getByTestId('topbar-logo')).toHaveAttribute('src', '/logo.png')
    expect(screen.getByTestId('topbar-update-badge')).toHaveTextContent('Update available')
    expect(screen.getByText('v0.6.0-alpha.3 → v0.6.0-alpha.4')).toBeInTheDocument()
    expect(screen.getByText('yive update')).toBeInTheDocument()
  })
})
