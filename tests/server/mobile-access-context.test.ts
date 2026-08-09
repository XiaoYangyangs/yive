import { describe, expect, test } from 'vitest'

import { ForbiddenError } from '../../src/server/http-errors.js'
import {
  assertMobileWorkspaceAccess,
  readMobileRelayAccessContext,
} from '../../src/server/ui-auth-helpers.js'

describe('mobile access context', () => {
  test('allows legacy all-workspace mobile sessions', () => {
    expect(() =>
      assertMobileWorkspaceAccess(
        { kind: 'mobile-token', workspaceScope: 'all' },
        'workspace-alpha'
      )
    ).not.toThrow()
  })

  test('allows selected workspace sessions only for their bound workspaces', () => {
    expect(() =>
      assertMobileWorkspaceAccess(
        {
          kind: 'mobile-token',
          workspaceIds: ['workspace-alpha'],
          workspaceScope: 'selected',
        },
        'workspace-alpha'
      )
    ).not.toThrow()

    expect(() =>
      assertMobileWorkspaceAccess(
        {
          kind: 'mobile-token',
          workspaceIds: ['workspace-alpha'],
          workspaceScope: 'selected',
        },
        'workspace-beta'
      )
    ).toThrow(ForbiddenError)
  })

  test('reads relay device headers and selected workspace scope', () => {
    expect(
      readMobileRelayAccessContext({
        headers: {
          'x-yive-mobile-workspace-ids': 'workspace-alpha, workspace-beta, workspace-alpha',
          'x-yive-relay-desktop-id': 'desktop-1',
          'x-yive-relay-mobile-device-id': 'phone-1',
        },
      } as never)
    ).toEqual({
      relay: {
        desktopId: 'desktop-1',
        mobileDeviceId: 'phone-1',
      },
      workspaceIds: ['workspace-alpha', 'workspace-beta'],
      workspaceScope: 'selected',
    })
  })

  test('ignores unsafe relay header values', () => {
    expect(
      readMobileRelayAccessContext({
        headers: {
          'x-yive-mobile-workspace-ids': '',
          'x-yive-relay-desktop-id': 'desktop\n1',
          'x-yive-relay-mobile-device-id': 'x'.repeat(81),
        },
      } as never)
    ).toEqual({ workspaceScope: 'all' })
  })
})
