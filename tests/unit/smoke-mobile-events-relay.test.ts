import { EventEmitter } from 'node:events'

import { describe, expect, test } from 'vitest'

import {
  assertMobileEventsSmokeFreshness,
  buildMobileEventsSmokeQuality,
  buildSmokeMobileEventsRelayConfig,
  waitForMobileEvents,
} from '../../deploy/smoke-mobile-events-relay.mjs'

class FakeSocket extends EventEmitter {
  off(eventName: string, listener: (...args: unknown[]) => void): this {
    return super.off(eventName, listener)
  }

  sendMobileEvent(payload: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(payload)))
  }
}

const mobileEvent = (subscriptionId: string, payload: unknown) => ({
  channel: 'mobile_events',
  from: 'desktop-1',
  payload,
  request_id: subscriptionId,
  to: 'mobile-1',
  type: 'mobile_events_message',
})

describe('smoke-mobile-events-relay helpers', () => {
  test('parses live update smoke options', () => {
    expect(
      buildSmokeMobileEventsRelayConfig(
        [
          '--server',
          'relay.example.com',
          '--token',
          'secret',
          '--desktop-id',
          'desktop-windows',
          '--device-id',
          'phone-smoke',
          '--timeout-ms',
          '5000',
          '--max-stale-ms',
          '30000',
          '--require-live-update',
        ],
        {},
        () => 1_700_000_000
      )
    ).toEqual({
      adminToken: 'secret',
      desktopId: 'desktop-windows',
      deviceId: 'phone-smoke',
      maxStaleMs: 30000,
      requireLiveUpdate: true,
      serverUrl: 'https://relay.example.com',
      timeoutMs: 5000,
    })
  })

  test('waits for a second snapshot when live update verification is required', async () => {
    const socket = new FakeSocket()
    const result = waitForMobileEvents(socket, 1_000, 'sub-1', { requireLiveUpdate: true })

    socket.sendMobileEvent(
      mobileEvent('sub-1', {
        snapshot: {
          active_workspace: null,
          active_workspace_id: 'workspace-1',
          generated_at: 1,
          workspaces: [],
        },
        type: 'mobile-snapshot',
      })
    )
    socket.sendMobileEvent(
      mobileEvent('sub-1', {
        generated_at: 2,
        type: 'mobile-heartbeat',
      })
    )

    await Promise.resolve()
    socket.sendMobileEvent(
      mobileEvent('sub-1', {
        snapshot: {
          active_workspace: null,
          active_workspace_id: 'workspace-1',
          generated_at: 3,
          workspaces: [{ id: 'workspace-1', is_active: true, name: 'Updated', path: '/work' }],
        },
        type: 'mobile-snapshot',
      })
    )

    await expect(result).resolves.toEqual({
      heartbeatMessage: expect.objectContaining({
        payload: { generated_at: 2, type: 'mobile-heartbeat' },
      }),
      liveUpdateMessage: expect.objectContaining({
        payload: expect.objectContaining({
          snapshot: expect.objectContaining({ generated_at: 3 }),
        }),
      }),
      snapshotMessage: expect.objectContaining({
        payload: expect.objectContaining({
          snapshot: expect.objectContaining({ generated_at: 1 }),
        }),
      }),
    })
  })

  test('reports mobile events freshness without exposing connection secrets', () => {
    expect(
      buildMobileEventsSmokeQuality({
        desktop: {
          device_id: 'desktop-1',
          last_seen_at: 900,
          runtime_updated_at: 950,
          supervisor_status: 'running',
          supervisor_updated_at: 960,
        },
        heartbeatAt: 980,
        liveUpdateAt: 990,
        now: 1000,
        snapshotAt: 970,
      })
    ).toEqual({
      desktop_last_seen_age_ms: 100,
      heartbeat_age_ms: 20,
      live_update_age_ms: 10,
      runtime_status_age_ms: 50,
      snapshot_age_ms: 30,
      supervisor_status: 'running',
      supervisor_status_age_ms: 40,
    })
  })

  test('fails when mobile events freshness exceeds the accepted threshold', () => {
    expect(() =>
      assertMobileEventsSmokeFreshness({
        maxStaleMs: 1000,
        quality: {
          desktop_last_seen_age_ms: 100,
          heartbeat_age_ms: 2000,
          live_update_age_ms: null,
          runtime_status_age_ms: 50,
          snapshot_age_ms: 30,
          supervisor_status: null,
          supervisor_status_age_ms: null,
        },
        requireLiveUpdate: true,
      })
    ).toThrow(
      'Mobile events freshness check failed; max 1000ms, mobile heartbeat=2000ms, mobile live update=missing'
    )
  })

  test('keeps mobile events smoke compatible with desktops that do not report supervisor status', () => {
    expect(() =>
      assertMobileEventsSmokeFreshness({
        maxStaleMs: 1000,
        quality: {
          desktop_last_seen_age_ms: 100,
          heartbeat_age_ms: 20,
          live_update_age_ms: null,
          runtime_status_age_ms: 50,
          snapshot_age_ms: 30,
          supervisor_status: null,
          supervisor_status_age_ms: null,
        },
        requireLiveUpdate: false,
      })
    ).not.toThrow()
  })

  test('fails when the desktop relay supervisor reports an unhealthy status', () => {
    expect(() =>
      assertMobileEventsSmokeFreshness({
        maxStaleMs: 1000,
        quality: {
          desktop_last_seen_age_ms: 100,
          heartbeat_age_ms: 20,
          live_update_age_ms: null,
          runtime_status_age_ms: 50,
          snapshot_age_ms: 30,
          supervisor_status: 'stale',
          supervisor_status_age_ms: 40,
        },
        requireLiveUpdate: false,
      })
    ).toThrow('Mobile events freshness check failed; max 1000ms, desktop supervisor status=stale')
  })

  test('fails when reported desktop relay supervisor status is too old', () => {
    expect(() =>
      assertMobileEventsSmokeFreshness({
        maxStaleMs: 1000,
        quality: {
          desktop_last_seen_age_ms: 100,
          heartbeat_age_ms: 20,
          live_update_age_ms: null,
          runtime_status_age_ms: 50,
          snapshot_age_ms: 30,
          supervisor_status: 'running',
          supervisor_status_age_ms: 2000,
        },
        requireLiveUpdate: false,
      })
    ).toThrow('Mobile events freshness check failed; max 1000ms, desktop supervisor status=2000ms')
  })
})
