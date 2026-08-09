import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'
import WebSocket from 'ws'

import { resetFcmNotifierForTests } from '../../src/server/fcm-notifier.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { resetXiaomiNotifierForTests } from '../../src/server/xiaomi-notifier.js'
import { writeProviderAdapterFixture } from '../helpers/provider-adapter-fixture.js'
import { startTestServer } from '../helpers/test-server.js'
import { getMobileCookie, getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex'
)

const toWsUrl = (baseUrl: string, suffix: string) => baseUrl.replace('http://', 'ws://') + suffix

const openSocketAndReadFirstMessage = async (
  url: string,
  cookie: string,
  headers: Record<string, string> = {}
) =>
  await new Promise<{ message: string; socket: WebSocket }>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie, ...headers } })
    socket.once('message', (chunk) => resolve({ message: chunk.toString(), socket }))
    socket.once('error', reject)
  })

const readNextSocketMessage = async (socket: WebSocket) =>
  await new Promise<string>((resolve, reject) => {
    socket.once('message', (chunk) => resolve(chunk.toString()))
    socket.once('error', reject)
  })

const postMobileNotification = (
  baseUrl: string,
  cookie: string | undefined,
  body: Record<string, unknown>
) =>
  fetch(`${baseUrl}/api/mobile/notifications`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })

const expectUpgradeStatus = async (
  url: string,
  cookie: string,
  statusCode: number,
  headers: Record<string, string> = {}
) => {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie, ...headers } })
    socket.once('unexpected-response', (_request, response) => {
      try {
        expect(response.statusCode).toBe(statusCode)
        response.resume()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    socket.once('open', () => reject(new Error('Expected websocket upgrade to fail')))
    socket.once('error', () => {})
  })
}

afterEach(() => {
  delete process.env.HIVE_DEV_LAN
  delete process.env.YIVE_FCM_PROJECT_ID
  delete process.env.YIVE_FCM_SERVICE_ACCOUNT_FILE
  delete process.env.YIVE_FCM_SERVICE_ACCOUNT_JSON
  delete process.env.YIVE_FEISHU_WEBHOOK_SECRET
  delete process.env.YIVE_FEISHU_WEBHOOK_URL
  delete process.env.YIVE_WECHAT_SERVERCHAN_SENDKEY
  delete process.env.YIVE_XIAOMI_API_ORIGIN
  delete process.env.YIVE_XIAOMI_APP_SECRET
  delete process.env.YIVE_XIAOMI_PACKAGE_NAME
  resetFcmNotifierForTests()
  resetXiaomiNotifierForTests()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('mobile snapshot api', () => {
  test('rejects anonymous callers without exposing runtime state', async () => {
    const server = await startTestServer()
    try {
      const response = await fetch(`${server.baseUrl}/api/mobile/snapshot`)

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        error: 'Mobile endpoint requires valid mobile token',
      })
    } finally {
      await server.close()
    }
  })

  test('returns active workspace dashboard data without CLI agent tokens', async () => {
    process.env.HIVE_DEV_LAN = '1'
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-mobile-snapshot-'))
    tempDirs.push(dataDir)
    const alphaPath = join(dataDir, 'alpha')
    const betaPath = join(dataDir, 'beta')
    mkdirSync(alphaPath, { recursive: true })
    mkdirSync(betaPath, { recursive: true })

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)

      const alpha = server.store.createWorkspace(alphaPath, 'Alpha')
      const beta = server.store.createWorkspace(betaPath, 'Beta')
      const alice = server.store.addWorker(beta.id, { name: 'Alice' })
      server.store.configureAgentLaunch(
        beta.id,
        alice.id,
        buildManagedProviderLaunchConfig('codex')
      )
      await server.store.dispatchTask(beta.id, alice.id, 'Implement mobile snapshot')
      server.store.settings.setAppState('active_workspace_id', beta.id)
      const getAgentState = vi.spyOn(server.store, 'getAgentState')

      const response = await fetch(`${server.baseUrl}/api/mobile/snapshot`, {
        headers: { cookie },
      })

      expect(response.status).toBe(200)
      const snapshotText = await response.text()
      expect(snapshotText).not.toContain('HIVE_AGENT_TOKEN')
      expect(snapshotText).not.toContain(server.store.peekAgentToken(alice.id) ?? 'missing-token')

      const snapshot = JSON.parse(snapshotText) as {
        active_workspace: {
          dispatch_summary: {
            counts: Record<string, number>
            pending_count: number
            recent: Array<{ state: string; text: string }>
            total_count: number
          }
          orchestrator: { active_run_id: string | null; kind: string }
          terminal_runs: unknown[]
          workers: Array<{
            active_dispatch_id: string | null
            active_run_id: string | null
            conversation_activity: 'busy' | 'idle' | 'unknown'
            conversation_provider: 'claude' | 'codex' | null
            id: string
            last_observed_at: number
            last_pty_line: string | null
            name: string
            kind: string
            process_state: 'crashed' | 'running' | 'stopped'
            queue_pause_reason: string | null
            queued_dispatch_count: number
          }>
          workspace: { id: string; name: string; path: string }
        }
        active_workspace_id: string
        connection: {
          auth: { http: string; websocket: string; workspace_scope: string }
          health: {
            heartbeat_interval_ms: number
            stale_after_ms: number
            version_endpoint: string
          }
          lan: {
            dev_lan_enabled: boolean
            private_network_only: boolean
            relay_enabled: boolean
          }
          request: { host: string | null; origin: string | null; remote_address: string | null }
          websocket: {
            mobile_events_path: string
            terminal_control_path_template: string
            terminal_io_path_template: string
          }
        }
        generated_at: number
        workspaces: Array<{ id: string; is_active: boolean; name: string; path: string }>
      }

      expect(snapshot.generated_at).toEqual(expect.any(Number))
      expect(snapshot.connection).toEqual({
        auth: {
          http: 'ui-cookie',
          websocket: 'ui-cookie',
          workspace_scope: 'all',
        },
        health: {
          heartbeat_interval_ms: 15_000,
          stale_after_ms: 45_000,
          version_endpoint: '/api/version',
        },
        lan: {
          dev_lan_enabled: true,
          private_network_only: true,
          relay_enabled: false,
        },
        request: {
          host: new URL(server.baseUrl).host,
          origin: null,
          remote_address: expect.any(String),
        },
        websocket: {
          mobile_events_path: '/ws/mobile/events',
          terminal_control_path_template: '/ws/terminal/:runId/control',
          terminal_io_path_template: '/ws/terminal/:runId/io',
        },
      })
      expect(snapshot.active_workspace_id).toBe(beta.id)
      expect(snapshot.workspaces).toEqual([
        { ...alpha, is_active: false },
        { ...beta, is_active: true },
      ])
      expect(snapshot.active_workspace.workspace).toEqual(beta)
      expect(snapshot.active_workspace.orchestrator).toEqual(
        expect.objectContaining({
          active_run_id: null,
          kind: 'orchestrator',
        })
      )
      expect(snapshot.active_workspace.workers).toEqual([
        expect.objectContaining({
          active_dispatch_id: null,
          active_run_id: null,
          conversation_activity: 'unknown',
          conversation_provider: 'codex',
          id: alice.id,
          kind: 'worker',
          last_observed_at: 0,
          last_pty_line: null,
          name: 'Alice',
          process_state: 'stopped',
          queue_pause_reason: null,
          queued_dispatch_count: 1,
        }),
      ])
      expect(getAgentState).not.toHaveBeenCalledWith(beta.id, alice.id)
      expect(snapshot.active_workspace.terminal_runs).toEqual([])
      expect(snapshot.active_workspace.dispatch_summary).toEqual({
        counts: {
          cancelled: 0,
          queued: 1,
          replaced: 0,
          replacement_pending: 0,
          reported: 0,
          submitted: 0,
        },
        pending_count: 1,
        recent: [
          expect.objectContaining({
            state: 'queued',
            text: 'Implement mobile snapshot',
          }),
        ],
        total_count: 1,
      })
    } finally {
      await server.close()
    }
  })

  test('reports LAN preview connection metadata while still requiring a UI session', async () => {
    const previousLan = process.env.HIVE_DEV_LAN
    process.env.HIVE_DEV_LAN = '1'
    const server = await startTestServer()
    try {
      const anonymousResponse = await fetch(`${server.baseUrl}/api/mobile/snapshot`)
      expect(anonymousResponse.status).toBe(403)
      await expect(anonymousResponse.json()).resolves.toEqual({
        error: 'Mobile endpoint requires valid mobile token',
      })

      const cookie = await getMobileCookie(server.baseUrl)
      const response = await fetch(`${server.baseUrl}/api/mobile/snapshot`, {
        headers: {
          cookie,
          origin: server.baseUrl,
        },
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          connection: expect.objectContaining({
            auth: {
              http: 'mobile-token',
              websocket: 'mobile-token',
              workspace_scope: 'all',
            },
            lan: {
              dev_lan_enabled: true,
              private_network_only: true,
              relay_enabled: false,
            },
            request: expect.objectContaining({
              host: expect.stringContaining('127.0.0.1'),
              origin: server.baseUrl,
            }),
            websocket: {
              mobile_events_path: '/ws/mobile/events',
              terminal_control_path_template: '/ws/terminal/:runId/control',
              terminal_io_path_template: '/ws/terminal/:runId/io',
            },
          }),
        })
      )
    } finally {
      if (previousLan === undefined) delete process.env.HIVE_DEV_LAN
      else process.env.HIVE_DEV_LAN = previousLan
      await server.close()
    }
  })

  test('rejects mobile events websocket upgrades without a valid mobile session', async () => {
    const server = await startTestServer()
    try {
      await expectUpgradeStatus(toWsUrl(server.baseUrl, '/ws/mobile/events'), '', 401)
    } finally {
      await server.close()
    }
  })

  test('accepts agent-authored notifications and includes them in mobile snapshots', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-mobile-notifications-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Notify Lab')

      const anonymous = await postMobileNotification(server.baseUrl, undefined, {
        body: 'Need review.',
        title: 'Review needed',
        workspace_id: workspace.id,
      })
      expect(anonymous.status).toBe(403)

      const response = await postMobileNotification(server.baseUrl, cookie, {
        body: 'Need review.',
        title: 'Review needed',
        workspace_id: workspace.id,
      })
      expect(response.status).toBe(201)
      const result = (await response.json()) as {
        notification: { body: string; id: string; title: string; workspace_id: string }
        ok: boolean
      }
      expect(result).toMatchObject({
        feishu: { channel: 'feishu', ok: false, reason: 'not_configured' },
        fcm: { channel: 'fcm', failed: 0, ok: false, reason: 'no_tokens', sent: 0 },
        notification: {
          body: 'Need review.',
          title: 'Review needed',
          workspace_id: workspace.id,
        },
        ok: true,
        wechat: { channel: 'serverchan', ok: false, reason: 'not_configured' },
        xiaomi: { channel: 'xiaomi', failed: 0, ok: false, reason: 'no_tokens', sent: 0 },
      })

      const snapshotResponse = await fetch(`${server.baseUrl}/api/mobile/snapshot`, {
        headers: { cookie },
      })
      expect(snapshotResponse.status).toBe(200)
      const snapshot = (await snapshotResponse.json()) as {
        notifications: Array<{ body: string; id: string; title: string; workspace_id: string }>
      }
      expect(snapshot.notifications).toEqual([
        expect.objectContaining({
          body: 'Need review.',
          id: result.notification.id,
          title: 'Review needed',
          workspace_id: workspace.id,
        }),
      ])
    } finally {
      await server.close()
    }
  })

  test('accepts agent-authored notifications with image attachments and includes them in snapshots', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-mobile-notification-images-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(join(workspacePath, 'dist'), { recursive: true })
    writeFileSync(join(workspacePath, 'dist', 'preview.png'), PNG_BYTES)

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Notify Image Lab')

      const response = await postMobileNotification(server.baseUrl, cookie, {
        body: 'Open preview.',
        image_path: 'dist/preview.png',
        title: 'Preview ready',
        workspace_id: workspace.id,
      })
      expect(response.status).toBe(201)
      const result = (await response.json()) as {
        notification: {
          image?: { file_id: string; mime_type: string; name: string; size: number }
        }
        ok: boolean
      }
      expect(result.notification.image).toMatchObject({
        mime_type: 'image/png',
        name: 'preview.png',
        size: PNG_BYTES.byteLength,
      })

      const snapshotResponse = await fetch(`${server.baseUrl}/api/mobile/snapshot`, {
        headers: { cookie },
      })
      expect(snapshotResponse.status).toBe(200)
      const snapshot = (await snapshotResponse.json()) as {
        notifications: Array<{
          image?: { file_id: string; mime_type: string; name: string; size: number }
        }>
      }
      expect(snapshot.notifications[0]?.image).toEqual(result.notification.image)
    } finally {
      await server.close()
    }
  })

  test('accepts Android push token registrations for native notifications', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-mobile-push-tokens-'))
    tempDirs.push(dataDir)
    const alphaPath = join(dataDir, 'alpha')
    const betaPath = join(dataDir, 'beta')
    mkdirSync(alphaPath, { recursive: true })
    mkdirSync(betaPath, { recursive: true })

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getMobileCookie(server.baseUrl)
      const alpha = server.store.createWorkspace(alphaPath, 'Alpha Push')
      const beta = server.store.createWorkspace(betaPath, 'Beta Push')
      const relayHeaders = {
        'x-yive-mobile-workspace-ids': alpha.id,
        'x-yive-relay-mobile-device-id': 'phone-dev',
      }

      const forbidden = await fetch(`${server.baseUrl}/api/mobile/push-tokens`, {
        body: JSON.stringify({
          platform: 'android',
          token: 'fcm-token-12345678901234567890',
          workspace_ids: [beta.id],
        }),
        headers: { ...relayHeaders, 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(forbidden.status).toBe(403)

      const registerResponse = await fetch(`${server.baseUrl}/api/mobile/push-tokens`, {
        body: JSON.stringify({
          app_id: 'xin.yive.dev',
          device_id: 'phone-dev',
          platform: 'fcm',
          token: 'fcm-token-12345678901234567890',
        }),
        headers: { ...relayHeaders, 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(registerResponse.status).toBe(201)
      await expect(registerResponse.json()).resolves.toEqual({
        ok: true,
        push_token: expect.objectContaining({
          app_id: 'xin.yive.dev',
          device_id: 'phone-dev',
          platform: 'fcm',
          workspace_ids: [alpha.id],
        }),
      })
      const xiaomiRegisterResponse = await fetch(`${server.baseUrl}/api/mobile/push-tokens`, {
        body: JSON.stringify({
          app_id: 'xin.yive.dev',
          device_id: 'phone-dev',
          platform: 'xiaomi',
          token: 'xiaomi-regid-12345678901234567890',
        }),
        headers: { ...relayHeaders, 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(xiaomiRegisterResponse.status).toBe(201)
      await expect(xiaomiRegisterResponse.json()).resolves.toEqual({
        ok: true,
        push_token: expect.objectContaining({
          app_id: 'xin.yive.dev',
          device_id: 'phone-dev',
          platform: 'xiaomi',
          workspace_ids: [alpha.id],
        }),
      })

      const response = await postMobileNotification(server.baseUrl, cookie, {
        body: 'Open the phone.',
        title: 'Native push',
        workspace_id: alpha.id,
      })
      expect(response.status).toBe(201)
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          fcm: { channel: 'fcm', failed: 0, ok: false, reason: 'not_configured', sent: 0 },
          ok: true,
          xiaomi: {
            channel: 'xiaomi',
            failed: 0,
            ok: false,
            reason: 'not_configured',
            sent: 0,
          },
        })
      )
    } finally {
      await server.close()
    }
  })

  test('accepts mobile-token cookies without the UI cookie for snapshot and events', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getMobileCookie(server.baseUrl)

      const response = await fetch(`${server.baseUrl}/api/mobile/snapshot`, {
        headers: { cookie },
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          connection: expect.objectContaining({
            auth: { http: 'mobile-token', websocket: 'mobile-token', workspace_scope: 'all' },
          }),
        })
      )

      const { message, socket } = await openSocketAndReadFirstMessage(
        toWsUrl(server.baseUrl, '/ws/mobile/events'),
        cookie
      )
      expect(JSON.parse(message)).toEqual(
        expect.objectContaining({
          snapshot: expect.objectContaining({
            connection: expect.objectContaining({
              auth: { http: 'mobile-token', websocket: 'mobile-token', workspace_scope: 'all' },
            }),
          }),
          type: 'mobile-snapshot',
        })
      )
      socket.close()
    } finally {
      await server.close()
    }
  })

  test('reports relay device context and selected workspace scope for snapshot and events', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-mobile-relay-context-'))
    tempDirs.push(dataDir)
    const alphaPath = join(dataDir, 'alpha')
    const betaPath = join(dataDir, 'beta')
    mkdirSync(alphaPath, { recursive: true })
    mkdirSync(betaPath, { recursive: true })

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getMobileCookie(server.baseUrl)
      const alpha = server.store.createWorkspace(alphaPath, 'Alpha Relay')
      const beta = server.store.createWorkspace(betaPath, 'Beta Relay')
      server.store.settings.setAppState('active_workspace_id', beta.id)
      const relayHeaders = {
        'x-yive-mobile-workspace-ids': alpha.id,
        'x-yive-relay-desktop-id': 'desktop-1',
        'x-yive-relay-mobile-device-id': 'phone-1',
      }

      const response = await fetch(`${server.baseUrl}/api/mobile/snapshot`, {
        headers: { ...relayHeaders, cookie },
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          connection: expect.objectContaining({
            auth: {
              http: 'mobile-token',
              websocket: 'mobile-token',
              workspace_ids: [alpha.id],
              workspace_scope: 'selected',
            },
            relay: {
              desktop_id: 'desktop-1',
              mobile_device_id: 'phone-1',
            },
          }),
          active_workspace_id: alpha.id,
          workspaces: [{ ...alpha, is_active: true }],
        })
      )

      const { message, socket } = await openSocketAndReadFirstMessage(
        toWsUrl(server.baseUrl, '/ws/mobile/events'),
        cookie,
        relayHeaders
      )
      expect(JSON.parse(message)).toEqual(
        expect.objectContaining({
          snapshot: expect.objectContaining({
            connection: expect.objectContaining({
              auth: {
                http: 'mobile-token',
                websocket: 'mobile-token',
                workspace_ids: [alpha.id],
                workspace_scope: 'selected',
              },
              relay: {
                desktop_id: 'desktop-1',
                mobile_device_id: 'phone-1',
              },
            }),
          }),
          type: 'mobile-snapshot',
        })
      )
      socket.close()
    } finally {
      await server.close()
    }
  })

  test('rejects mobile events websocket upgrades from non-local origins', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      await expectUpgradeStatus(toWsUrl(server.baseUrl, '/ws/mobile/events'), cookie, 403, {
        Origin: 'https://attacker.example',
      })
    } finally {
      await server.close()
    }
  })

  test('mobile events websocket sends a fresh snapshot on reconnect', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-mobile-events-'))
    tempDirs.push(dataDir)
    const alphaPath = join(dataDir, 'alpha')
    const betaPath = join(dataDir, 'beta')
    mkdirSync(alphaPath, { recursive: true })
    mkdirSync(betaPath, { recursive: true })

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const alpha = server.store.createWorkspace(alphaPath, 'Alpha Events')
      const { message: firstMessage, socket: firstSocket } = await openSocketAndReadFirstMessage(
        toWsUrl(server.baseUrl, '/ws/mobile/events'),
        cookie
      )
      const firstPayload = JSON.parse(firstMessage) as {
        snapshot: { active_workspace_id: string | null; workspaces: Array<{ name: string }> }
        type: string
      }
      expect(firstPayload.type).toBe('mobile-snapshot')
      expect(firstPayload.snapshot.active_workspace_id).toBe(alpha.id)
      expect(firstPayload.snapshot.workspaces).toEqual([
        expect.objectContaining({ name: 'Alpha Events' }),
      ])
      firstSocket.close()

      const beta = server.store.createWorkspace(betaPath, 'Beta Events')
      server.store.settings.setAppState('active_workspace_id', beta.id)
      const { message: secondMessage, socket: secondSocket } = await openSocketAndReadFirstMessage(
        toWsUrl(server.baseUrl, '/ws/mobile/events'),
        cookie
      )
      const secondPayload = JSON.parse(secondMessage) as {
        snapshot: { active_workspace_id: string | null; workspaces: Array<{ name: string }> }
        type: string
      }
      expect(secondPayload.type).toBe('mobile-snapshot')
      expect(secondPayload.snapshot.active_workspace_id).toBe(beta.id)
      expect(secondPayload.snapshot.workspaces).toEqual([
        expect.objectContaining({ name: 'Alpha Events' }),
        expect.objectContaining({ name: 'Beta Events' }),
      ])
      secondSocket.close()
    } finally {
      await server.close()
    }
  })

  test('mobile events websocket broadcasts a fresh snapshot after runtime changes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-mobile-events-broadcast-'))
    tempDirs.push(dataDir)
    const alphaPath = join(dataDir, 'alpha')
    const betaPath = join(dataDir, 'beta')
    mkdirSync(alphaPath, { recursive: true })
    mkdirSync(betaPath, { recursive: true })

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const alpha = server.store.createWorkspace(alphaPath, 'Alpha Broadcast')
      server.store.settings.setAppState('active_workspace_id', alpha.id)
      const { message: initialMessage, socket } = await openSocketAndReadFirstMessage(
        toWsUrl(server.baseUrl, '/ws/mobile/events'),
        cookie
      )
      const initialPayload = JSON.parse(initialMessage) as {
        snapshot: { active_workspace_id: string | null; workspaces: Array<{ name: string }> }
        type: string
      }
      expect(initialPayload.type).toBe('mobile-snapshot')
      expect(initialPayload.snapshot.workspaces).toEqual([
        expect.objectContaining({ name: 'Alpha Broadcast' }),
      ])

      const beta = server.store.createWorkspace(betaPath, 'Beta Broadcast')
      server.store.settings.setAppState('active_workspace_id', beta.id)

      const updateMessage = await readNextSocketMessage(socket)
      const updatePayload = JSON.parse(updateMessage) as {
        snapshot: { active_workspace_id: string | null; workspaces: Array<{ name: string }> }
        type: string
      }
      expect(updatePayload.type).toBe('mobile-snapshot')
      expect(updatePayload.snapshot.active_workspace_id).toBe(beta.id)
      expect(updatePayload.snapshot.workspaces).toEqual([
        expect.objectContaining({ name: 'Alpha Broadcast' }),
        expect.objectContaining({ name: 'Beta Broadcast' }),
      ])
      socket.close()
    } finally {
      await server.close()
    }
  })

  test('includes active run ids and terminal run summaries for mobile terminal selection', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-mobile-snapshot-runs-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    const providerFixture = writeProviderAdapterFixture({
      fixtureId: 'mobile-snapshot',
      provider: 'codex',
      root: dataDir,
      workspacePath,
    })

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Terminal Workspace')
      const alice = server.store.addWorker(workspace.id, { name: 'Alice' })
      server.store.configureAgentLaunch(workspace.id, alice.id, {
        ...buildManagedProviderLaunchConfig('codex'),
        args: [],
        command: providerFixture.command,
        interactiveCommand: providerFixture.command,
      })
      server.store.settings.setAppState('active_workspace_id', workspace.id)

      const startResponse = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${alice.id}/start`,
        { method: 'POST', headers: { cookie } }
      )
      expect(startResponse.status).toBe(201)
      const started = (await startResponse.json()) as { run_id: string }

      const response = await fetch(`${server.baseUrl}/api/mobile/snapshot`, {
        headers: { cookie },
      })

      expect(response.status).toBe(200)
      const snapshot = (await response.json()) as {
        active_workspace: {
          terminal_runs: Array<{
            agent_id: string
            agent_name: string
            run_id: string
            status: string
            terminal_input_profile: string
          }>
          workers: Array<{ active_run_id: string | null; id: string }>
        }
      }

      expect(snapshot.active_workspace.workers).toEqual([
        expect.objectContaining({
          active_run_id: started.run_id,
          id: alice.id,
        }),
      ])
      expect(snapshot.active_workspace.terminal_runs).toEqual([
        expect.objectContaining({
          agent_id: alice.id,
          agent_name: 'Alice',
          run_id: started.run_id,
          status: expect.stringMatching(/^(running|starting)$/),
          terminal_input_profile: 'default',
        }),
      ])
    } finally {
      await server.close()
    }
  }, 60000)

  test('includes recent dispatch records for mobile approval surfaces', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-mobile-snapshot-dispatches-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Approval Workspace')
      const alice = server.store.addWorker(workspace.id, { name: 'Alice' })
      const dispatch = await server.store.dispatchTask(workspace.id, alice.id, 'Retry build')
      server.store.settings.setAppState('active_workspace_id', workspace.id)

      const response = await fetch(`${server.baseUrl}/api/mobile/snapshot`, {
        headers: { cookie },
      })

      expect(response.status).toBe(200)
      const snapshot = (await response.json()) as {
        active_workspace: {
          dispatch_summary: {
            counts: Record<string, number>
            pending_count: number
            recent: Array<{
              from_agent_id: string | null
              id: string
              state: string
              text: string
              to_agent_id: string
            }>
            total_count: number
          }
        }
      }

      expect(snapshot.active_workspace.dispatch_summary).toEqual({
        counts: {
          cancelled: 0,
          queued: 1,
          replaced: 0,
          replacement_pending: 0,
          reported: 0,
          submitted: 0,
        },
        pending_count: 1,
        recent: [
          expect.objectContaining({
            from_agent_id: null,
            id: dispatch.id,
            state: 'queued',
            text: 'Retry build',
            to_agent_id: alice.id,
          }),
        ],
        total_count: 1,
      })
    } finally {
      await server.close()
    }
  })

  test('falls back to the first workspace when active workspace state is stale', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-mobile-snapshot-fallback-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
      server.store.settings.setAppState('active_workspace_id', 'missing-workspace')

      const response = await fetch(`${server.baseUrl}/api/mobile/snapshot`, {
        headers: { cookie },
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          active_workspace_id: workspace.id,
          workspaces: [{ ...workspace, is_active: true }],
        })
      )
    } finally {
      await server.close()
    }
  })
})
