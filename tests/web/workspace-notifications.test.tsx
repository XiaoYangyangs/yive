// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import {
  NOTIFICATION_SETTINGS_KEY,
  NotificationProvider,
} from '../../web/src/notifications/NotificationProvider.js'
import { WorkspaceNotifications } from '../../web/src/notifications/WorkspaceNotifications.js'
import { Toaster } from '../../web/src/ui/toast.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'

const workspace: WorkspaceSummary = {
  id: 'workspace-1',
  name: 'mco',
  path: '/tmp/mco',
}
let storage = new Map<string, string>()

class FakeAudio {
  preload = ''
  volume = 1

  constructor(readonly src: string) {}

  play() {
    return Promise.resolve()
  }
}

const installLocalStorage = () => {
  storage = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  })
}

const member = (overrides: Partial<TeamListItem>): TeamListItem => ({
  activeDispatchId: null,
  conversationActivity: 'idle',
  id: 'member-1',
  kind: 'worker',
  lastObservedAt: 1_754_360_000_000,
  name: 'ember-check-23',
  processState: 'running',
  queuePauseReason: null,
  queuedDispatchCount: 0,
  ...overrides,
})

const renderNotifications = (workers: TeamListItem[]) =>
  render(
    <ToastProvider>
      <NotificationProvider>
        <WorkspaceNotifications terminalRuns={[]} workers={workers} workspace={workspace} />
        <Toaster />
      </NotificationProvider>
    </ToastProvider>
  )

beforeEach(() => {
  installLocalStorage()
  window.localStorage.removeItem(NOTIFICATION_SETTINGS_KEY)
  Object.defineProperty(window, 'Audio', {
    configurable: true,
    value: FakeAudio,
  })
})

afterEach(() => {
  cleanup()
})

describe('workspace notifications', () => {
  test('seeds initial member state without emitting startup toasts', () => {
    renderNotifications([member({ activeDispatchId: 'dispatch-1' })])

    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('does not infer a report when a member closes its active Dispatch', () => {
    const view = renderNotifications([member({ activeDispatchId: 'dispatch-1' })])

    view.rerender(
      <ToastProvider>
        <NotificationProvider>
          <WorkspaceNotifications
            terminalRuns={[]}
            workers={[member({ activeDispatchId: null })]}
            workspace={workspace}
          />
          <Toaster />
        </NotificationProvider>
      </ToastProvider>
    )

    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('reports a crashed process without collapsing it into stopped', async () => {
    const view = renderNotifications([member({ processState: 'running' })])

    view.rerender(
      <ToastProvider>
        <NotificationProvider>
          <WorkspaceNotifications
            terminalRuns={[]}
            workers={[member({ processState: 'crashed', queuedDispatchCount: 2 })]}
            workspace={workspace}
          />
          <Toaster />
        </NotificationProvider>
      </ToastProvider>
    )

    const toast = await screen.findByTestId('toast')
    expect(toast).toHaveTextContent('ember-check-23 crashed')
    expect(toast).not.toHaveTextContent('stopped')
  })
})
