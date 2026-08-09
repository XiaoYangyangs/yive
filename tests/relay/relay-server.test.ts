import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'

import {
  attachRelayDesktopHandlers,
  formatRelayDesktopConnectedMessage,
  formatRelayDesktopReconnectMessage,
  normalizeRelayServerUrlForDesktop,
  openRelayDesktopSocket,
  readLocalRuntimeStatus,
  runRelayDesktopClient,
  toRelayDesktopWebSocketUrl,
} from '../../src/relay/desktop-client.js'
import { MAX_RELAY_DEVICE_ID_LENGTH } from '../../src/relay/pairing-store.js'
import type { RelayHub } from '../../src/relay/relay-hub.js'
import { createRelayServer, parseRelayServerArgs } from '../../src/relay/server.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { readPackageVersion } from '../../src/server/package-version.js'
import { writeProviderAdapterFixture } from '../helpers/provider-adapter-fixture.js'
import { startTestServer } from '../helpers/test-server.js'

interface StartedRelay {
  baseUrl: string
  close: () => Promise<void>
  hub: RelayHub
  wsUrl: (path: string) => string
}

const startedRelays: StartedRelay[] = []
const tempDirs: string[] = []

const startRelay = async (
  options: {
    accountLogin?: { password: string; username: string }
    heartbeatIntervalMs?: number
    heartbeatTimeoutMs?: number
    pairingStorePath?: string
    publicUrl?: string
    requireDesktopBinding?: boolean
    staticDir?: string
  } = {}
) => {
  const app = createRelayServer({
    accountLogin: options.accountLogin,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    pairingStorePath: options.pairingStorePath,
    pairingToken: 'test-token',
    publicUrl: options.publicUrl,
    requireDesktopBinding: options.requireDesktopBinding,
    staticDir: options.staticDir,
  })
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()))
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Relay did not bind')
  let closed = false
  const relay: StartedRelay = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      if (closed) return
      closed = true
      app.hub.close()
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
    },
    hub: app.hub,
    wsUrl(path) {
      return `ws://127.0.0.1:${address.port}${path}`
    },
  }
  startedRelays.push(relay)
  return relay
}

const createStaticFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'yive-relay-static-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  mkdirSync(join(dir, '.well-known'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root">Yive Mobile</div>')
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("relay mobile")')
  writeFileSync(
    join(dir, '.well-known', 'assetlinks.json'),
    JSON.stringify([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.example.yive',
          sha256_cert_fingerprints: [
            'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
          ],
        },
      },
    ])
  )
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Yive"}\n')
  writeFileSync(join(dir, 'sw.js'), "self.addEventListener('install', () => {})\n")
  return dir
}

const openSocket = async (url: string) => {
  const socket = new WebSocket(url)
  await once(socket, 'open')
  return socket
}

const readMessage = async (socket: WebSocket) => {
  const [raw] = (await once(socket, 'message')) as [WebSocket.RawData]
  return JSON.parse(raw.toString()) as Record<string, unknown>
}

const readMessages = async (socket: WebSocket, count: number, timeoutMs = 1_000) =>
  new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = []
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Expected ${count} relay messages, received ${messages.length}`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('message', onMessage)
      socket.off('error', onError)
    }
    const onMessage = (raw: WebSocket.RawData) => {
      messages.push(JSON.parse(raw.toString()) as Record<string, unknown>)
      if (messages.length < count) return
      cleanup()
      resolve(messages)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    socket.on('message', onMessage)
    socket.once('error', onError)
  })

const readRawMessages = async (socket: WebSocket, count: number, timeoutMs = 1_000) =>
  new Promise<string[]>((resolve, reject) => {
    const messages: string[] = []
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Expected ${count} websocket messages, received ${messages.length}`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('message', onMessage)
      socket.off('error', onError)
    }
    const onMessage = (raw: WebSocket.RawData) => {
      messages.push(raw.toString())
      if (messages.length < count) return
      cleanup()
      resolve(messages)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    socket.on('message', onMessage)
    socket.once('error', onError)
  })

const waitForMessageMatching = async (
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 1_000
) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for matching websocket message'))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('message', onMessage)
      socket.off('error', onError)
    }
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>
      if (!predicate(message)) return
      cleanup()
      resolve(message)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    socket.on('message', onMessage)
    socket.once('error', onError)
  })

const expectNoRelayMessage = async (socket: WebSocket, timeoutMs = 25) => {
  const result = await Promise.race([
    once(socket, 'message').then(() => 'message' as const),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ])
  expect(result).toBe('timeout')
}

const waitForRuntimeStatus = async (relay: StartedRelay, expectedStatus: string) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${relay.baseUrl}/devices`, {
      headers: { authorization: 'Bearer test-token' },
    })
    const body = (await response.json()) as {
      desktops?: Array<{ runtime_status?: string }>
    }
    if (body.desktops?.[0]?.runtime_status === expectedStatus) return body
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Expected runtime status ${expectedStatus}`)
}

const waitForDeviceCounts = async (
  relay: StartedRelay,
  expected: { desktops: number; mobiles: number }
) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${relay.baseUrl}/devices`, {
      headers: { authorization: 'Bearer test-token' },
    })
    const body = (await response.json()) as {
      desktops?: unknown[]
      mobiles?: unknown[]
    }
    if (body.desktops?.length === expected.desktops && body.mobiles?.length === expected.mobiles) {
      return body
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Expected ${expected.desktops} desktops and ${expected.mobiles} mobiles`)
}

const waitForDesktopReconnect = async (relay: StartedRelay, previousConnectedAt: number) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${relay.baseUrl}/devices`, {
      headers: { authorization: 'Bearer test-token' },
    })
    const body = (await response.json()) as {
      desktops?: Array<{ connected_at: number; device_id: string }>
    }
    const desktop = body.desktops?.find((entry) => entry.device_id === 'desktop-client-1')
    if (desktop && desktop.connected_at > previousConnectedAt) return desktop
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Expected desktop relay client to reconnect')
}

const pauseUnderlyingSocket = (socket: WebSocket) => {
  ;(socket as unknown as { _socket?: { pause: () => void } })._socket?.pause()
}

const readRequestJson = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

const UI_COOKIE = 'hive_ui_token=test-ui'
const MOBILE_COOKIE = 'hive_mobile_token=test-mobile'

const requireRuntimeCookie = (
  request: IncomingMessage,
  response: ServerResponse,
  expectedCookie: string,
  message: string
) => {
  if (request.headers.cookie === expectedCookie) return true
  response.statusCode = 403
  response.end(JSON.stringify({ error: message }))
  return false
}

const startLocalRuntimeStub = async (
  options: {
    handleTerminalMessage?: (socket: WebSocket, raw: WebSocket.RawData) => void
    mobileActionFailureKind?: string
    rejectTerminalUpgradeStatus?: number
    terminalReadyMessage?: string
    terminalUpgradeDelayMs?: number
    uiSessionDelayMs?: number
  } = {}
) => {
  const terminalWss = new WebSocketServer({ noServer: true })
  const mobileEventsWss = new WebSocketServer({ noServer: true })
  let mobileEventsConnectionCount = 0
  let mobileEventsCloseCount = 0
  const terminalRequests: string[] = []
  const mobileActionRequests: Array<Record<string, unknown>> = []
  const relayHeaderRecords: Array<Record<string, string | undefined>> = []
  const files = new Map<
    string,
    { content: Buffer; local_path: string; mime_type: string; name: string; size: number }
  >()
  const sendMobileSnapshot = (ws: WebSocket, name: string, generatedAt: number) => {
    ws.send(
      JSON.stringify({
        snapshot: {
          active_workspace: null,
          active_workspace_id: 'workspace-1',
          connection: { relay: false },
          generated_at: generatedAt,
          workspaces: [
            {
              id: 'workspace-1',
              is_active: true,
              name,
              path: '/work/local',
            },
          ],
        },
        type: 'mobile-snapshot',
      })
    )
  }
  const recordRelayHeaders = (request: IncomingMessage) => {
    relayHeaderRecords.push({
      desktopId: request.headers['x-yive-relay-desktop-id'] as string | undefined,
      mobileDeviceId: request.headers['x-yive-relay-mobile-device-id'] as string | undefined,
      workspaceIds: request.headers['x-yive-mobile-workspace-ids'] as string | undefined,
    })
  }
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/api/ui/session') {
        if (options.uiSessionDelayMs && options.uiSessionDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.uiSessionDelayMs))
        }
        response.setHeader('set-cookie', [
          'hive_ui_token=test-ui; Path=/; HttpOnly',
          'hive_mobile_token=test-mobile; Path=/; HttpOnly',
        ])
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ ok: true }))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/workspaces') {
        if (!requireRuntimeCookie(request, response, UI_COOKIE, 'missing ui cookie')) return
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify([{ id: 'workspace-1', name: 'Local Workspace', path: '/work/local' }])
        )
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/ui/workspaces/workspace-1/team') {
        if (!requireRuntimeCookie(request, response, UI_COOKIE, 'missing ui cookie')) return
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify([
            {
              active_dispatch_id: null,
              conversation_provider: 'codex',
              conversation_activity: 'busy',
              id: 'agent-1',
              kind: 'worker',
              last_observed_at: 1,
              last_pty_line: 'ready',
              name: 'Coder',
              process_state: 'running',
              provider: 'codex',
              queue_pause_reason: null,
              queued_dispatch_count: 0,
            },
          ])
        )
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/ui/workspaces/workspace-1/runs') {
        if (!requireRuntimeCookie(request, response, UI_COOKIE, 'missing ui cookie')) return
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify([
            {
              agent_id: 'agent-1',
              agent_name: 'Coder',
              run_id: 'run-1',
              status: 'running',
              terminal_input_profile: 'default',
            },
          ])
        )
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/mobile/actions') {
        if (!requireRuntimeCookie(request, response, MOBILE_COOKIE, 'missing mobile cookie')) return
        recordRelayHeaders(request)
        const body = await readRequestJson(request)
        const duplicate = mobileActionRequests.some((item) => item.action_id === body.action_id)
        mobileActionRequests.push(body)
        if (body.kind === options.mobileActionFailureKind) {
          response.statusCode = 409
          response.setHeader('content-type', 'application/json')
          response.end(
            JSON.stringify({
              code: 'worker_session_unverified',
              error: 'The resumed Provider Session could not be verified',
            })
          )
          return
        }
        if (body.kind === 'chat_submit' && body.workspace_id !== 'workspace-1') {
          response.statusCode = 400
          response.end(JSON.stringify({ error: 'Conversation not found' }))
          return
        }
        response.statusCode = 202
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            action_id: body.action_id,
            ...(duplicate ? { duplicate: true } : {}),
            kind: body.kind,
            ok: true,
            result:
              body.kind === 'chat_submit' || body.kind === 'chat_force'
                ? {
                    accepted_at: 1_700_000_100,
                    body: 'hello through relay [local path] HIVE_AGENT_TOKEN=[redacted]',
                    cancelled_at: null,
                    confirmed_at: null,
                    conversation_id: 'conversation-1',
                    delivered_at: 1_700_000_101,
                    error_code: null,
                    id:
                      body.kind === 'chat_force'
                        ? (body.target as { submission_id: string }).submission_id
                        : body.action_id,
                    provider_event_id: null,
                    provider_turn_sequence: null,
                    state: 'delivered',
                  }
                : { bytes: 5, run_id: 'run-1' },
            workspace_id: body.workspace_id,
          })
        )
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/mobile/agents/agent-1/conversation') {
        if (!requireRuntimeCookie(request, response, MOBILE_COOKIE, 'missing mobile cookie')) return
        recordRelayHeaders(request)
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            conversation: {
              activity_state: 'busy',
              agent_id: 'agent-1',
              cli_session_id: 'session-1',
              id: 'conversation-1',
              provider: 'codex',
              recording_boundary: 0,
              source_checkpoint: 100,
              stale: false,
              submissions: [
                {
                  body: 'hello through relay [local path] HIVE_AGENT_TOKEN=[redacted]',
                  conversation_id: 'conversation-1',
                  id: '55555555-5555-4555-8555-555555555555',
                  provider_event_id: 'provider-user-1',
                  provider_turn_sequence: 1,
                  state: 'confirmed',
                },
              ],
              turns: [],
              workspace_id: 'workspace-1',
            },
          })
        )
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/mobile/agents/agent-1/conversations') {
        if (!requireRuntimeCookie(request, response, MOBILE_COOKIE, 'missing mobile cookie')) return
        recordRelayHeaders(request)
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            items: [
              {
                active: false,
                cli_session_id: 'session-old',
                id: 'conversation-old',
                provider: 'codex',
                started_at: 1_700_000_000,
                title: 'Recorded work',
              },
            ],
            next_cursor: url.searchParams.get('cursor') === 'page-1' ? null : 'page-1',
          })
        )
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/mobile/transcript') {
        if (!requireRuntimeCookie(request, response, MOBILE_COOKIE, 'missing mobile cookie')) return
        recordRelayHeaders(request)
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            attachments: [],
            events: [
              {
                bytes: 5,
                created_at: 1_700_000_050,
                id: 'action:action-1',
                kind: 'terminal_input',
                run_id: url.searchParams.get('run_id'),
                type: 'mobile_action_echo',
              },
            ],
            generated_at: 1_700_000_051,
            run: {
              agent_id: 'agent-1',
              agent_name: 'Coder',
              exit_code: null,
              status: 'running',
              terminal_input_profile: 'default',
            },
            run_id: url.searchParams.get('run_id'),
            workspace_id: url.searchParams.get('workspace_id'),
          })
        )
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/mobile/confirmations') {
        if (!requireRuntimeCookie(request, response, MOBILE_COOKIE, 'missing mobile cookie')) return
        recordRelayHeaders(request)
        const body = await readRequestJson(request)
        response.statusCode = 201
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            expires_in_ms: 60000,
            kind: body.kind,
            nonce: 'nonce-relay-confirmation',
            ok: true,
            workspace_id: body.workspace_id,
          })
        )
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/mobile/files') {
        if (!requireRuntimeCookie(request, response, MOBILE_COOKIE, 'missing mobile cookie')) return
        recordRelayHeaders(request)
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify(
            Array.from(files.entries()).map(([id, file]) => ({
              created_at: 1_700_000_000,
              id,
              local_path: file.local_path,
              mime_type: file.mime_type,
              name: file.name,
              size: file.size,
            }))
          )
        )
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/mobile/files') {
        if (!requireRuntimeCookie(request, response, MOBILE_COOKIE, 'missing mobile cookie')) return
        recordRelayHeaders(request)
        const body = await readRequestJson(request)
        if (body.name === 'too-large.png') {
          response.statusCode = 413
          response.setHeader('content-type', 'application/json')
          response.end(
            JSON.stringify({
              content_base64: body.content_base64,
              error: 'Image exceeds 10MB limit',
              local_path: 'C:\\Temp\\hive-mobile-files\\too-large.png',
              token: 'HIVE_AGENT_TOKEN=secret',
            })
          )
          return
        }
        const content = Buffer.from(String(body.content_base64 ?? ''), 'base64')
        files.set('file-1', {
          content,
          local_path: 'C:\\Temp\\hive-mobile-files\\file-1.png',
          mime_type: 'image/png',
          name: String(body.name ?? 'file.png'),
          size: content.byteLength,
        })
        response.statusCode = 201
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            content_base64: String(body.content_base64 ?? ''),
            created_at: 1_700_000_000,
            id: 'file-1',
            local_path: 'C:\\Temp\\hive-mobile-files\\file-1.png',
            mime_type: 'image/png',
            name: String(body.name ?? 'file.png'),
            registry_path: '.hive/mobile-attachments.json',
            size: content.byteLength,
            token: 'HIVE_AGENT_TOKEN=secret',
          })
        )
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/mobile/files/from-workspace') {
        if (!requireRuntimeCookie(request, response, MOBILE_COOKIE, 'missing mobile cookie')) return
        recordRelayHeaders(request)
        files.set('file-workspace', {
          content: Buffer.from('workspace content'),
          local_path: 'C:\\work\\local\\dist\\demo.md',
          mime_type: 'text/markdown; charset=utf-8',
          name: 'demo.md',
          size: 'workspace content'.length,
        })
        response.statusCode = 201
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            created_at: 1_700_000_001,
            id: 'file-workspace',
            local_path: 'C:\\work\\local\\dist\\demo.md',
            mime_type: 'text/markdown; charset=utf-8',
            name: 'demo.md',
            registry_path: '.hive/mobile-attachments.json',
            size: 'workspace content'.length,
            token: 'agent_token=secret',
            workspace_path: 'dist/demo.md',
          })
        )
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/mobile/files/')) {
        if (!requireRuntimeCookie(request, response, MOBILE_COOKIE, 'missing mobile cookie')) return
        recordRelayHeaders(request)
        const fileId = decodeURIComponent(url.pathname.slice('/api/mobile/files/'.length))
        const file = files.get(fileId)
        if (!file) {
          response.statusCode = 404
          response.end(JSON.stringify({ error: 'not found' }))
          return
        }
        response.setHeader('content-type', file.mime_type)
        response.setHeader('content-disposition', `attachment; filename="${file.name}"`)
        response.end(file.content)
        return
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/api/mobile/files/')) {
        if (!requireRuntimeCookie(request, response, MOBILE_COOKIE, 'missing mobile cookie')) return
        recordRelayHeaders(request)
        const fileId = decodeURIComponent(url.pathname.slice('/api/mobile/files/'.length))
        files.delete(fileId)
        response.statusCode = 204
        response.end()
        return
      }
      if (request.method === 'DELETE' && url.pathname === '/api/mobile/files') {
        if (!requireRuntimeCookie(request, response, MOBILE_COOKIE, 'missing mobile cookie')) return
        recordRelayHeaders(request)
        files.clear()
        response.statusCode = 204
        response.end()
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'not found' }))
    })().catch((error) => {
      response.statusCode = 500
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : 'runtime stub error' })
      )
    })
  })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const isTerminalSocket = /^\/ws\/terminal\/[^/]+\/(?:io|control)$/.test(url.pathname)
    const isMobileEventsSocket = url.pathname === '/ws/mobile/events'
    if (!isTerminalSocket && !isMobileEventsSocket) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    const expectedCookie = isMobileEventsSocket ? MOBILE_COOKIE : UI_COOKIE
    if (request.headers.cookie !== expectedCookie) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    if (isMobileEventsSocket) {
      recordRelayHeaders(request)
      mobileEventsWss.handleUpgrade(request, socket, head, (ws) => {
        mobileEventsConnectionCount += 1
        ws.on('close', () => {
          mobileEventsCloseCount += 1
        })
        sendMobileSnapshot(ws, 'Local Workspace', 1_700_000_123)
        ws.send(JSON.stringify({ generated_at: 1_700_000_124, type: 'mobile-heartbeat' }))
      })
      return
    }
    const handleTerminalUpgrade = () => {
      if (options.rejectTerminalUpgradeStatus) {
        socket.write(`HTTP/1.1 ${options.rejectTerminalUpgradeStatus} Not Found\r\n\r\n`)
        socket.destroy()
        return
      }
      terminalWss.handleUpgrade(request, socket, head, (ws) => {
        terminalRequests.push(`${url.pathname}${url.search}`)
        ws.send(options.terminalReadyMessage ?? 'terminal-ready')
        ws.on('message', (raw) => {
          if (options.handleTerminalMessage) {
            options.handleTerminalMessage(ws, raw)
            return
          }
          ws.send(`runtime:${raw.toString()}`)
        })
      })
    }
    if (options.terminalUpgradeDelayMs && options.terminalUpgradeDelayMs > 0) {
      setTimeout(handleTerminalUpgrade, options.terminalUpgradeDelayMs)
    } else {
      handleTerminalUpgrade()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Runtime stub did not bind')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    getMobileEventsCloseCount: () => mobileEventsCloseCount,
    getMobileEventsConnectionCount: () => mobileEventsConnectionCount,
    getMobileActionRequests: () => mobileActionRequests.slice(),
    getRelayHeaderRecords: () => relayHeaderRecords.slice(),
    getTerminalRequests: () => terminalRequests.slice(),
    broadcastMobileSnapshot: (name: string, generatedAt = Date.now()) => {
      for (const client of mobileEventsWss.clients) {
        if (client.readyState === client.OPEN) sendMobileSnapshot(client, name, generatedAt)
      }
    },
    broadcastMobileEvent: (event: Record<string, unknown>) => {
      for (const client of mobileEventsWss.clients) {
        if (client.readyState === client.OPEN) client.send(JSON.stringify(event))
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of mobileEventsWss.clients) client.terminate()
        for (const client of terminalWss.clients) client.terminate()
        mobileEventsWss.close(() => terminalWss.close(() => server.close(() => resolve())))
      }),
  }
}

const startBrokenRuntimeStub = async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 500
    response.end(JSON.stringify({ error: 'runtime unavailable' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Runtime stub did not bind')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const startHangingRuntimeStub = async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/api/ui/session') {
      response.setHeader('set-cookie', [
        'hive_ui_token=test-ui; Path=/; HttpOnly',
        'hive_mobile_token=test-mobile; Path=/; HttpOnly',
      ])
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true }))
      return
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Runtime stub did not bind')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

afterEach(async () => {
  for (const relay of startedRelays.splice(0)) await relay.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('relay server prototype', () => {
  test('parses relay server heartbeat options from cli flags', () => {
    expect(
      parseRelayServerArgs([
        '--port',
        '0',
        '--host',
        '0.0.0.0',
        '--token',
        'admin',
        '--store-file',
        'pairings.json',
        '--static-dir',
        'web/dist',
        '--heartbeat-interval-ms',
        '5000',
        '--heartbeat-timeout-ms',
        '15000',
        '--require-desktop-binding',
      ])
    ).toEqual({
      heartbeatIntervalMs: 5000,
      heartbeatTimeoutMs: 15000,
      host: '0.0.0.0',
      pairingStorePath: 'pairings.json',
      pairingToken: 'admin',
      port: 0,
      requireDesktopBinding: true,
      staticDir: 'web/dist',
    })
  })

  test('parses relay server deployment options from environment variables', () => {
    expect(
      parseRelayServerArgs([], {
        YIVE_RELAY_ADMIN_TOKEN: 'env-admin',
        YIVE_RELAY_HEARTBEAT_INTERVAL_MS: '10000',
        YIVE_RELAY_HEARTBEAT_TIMEOUT_MS: '45000',
        YIVE_RELAY_HOST: '0.0.0.0',
        YIVE_RELAY_PAIRING_STORE: 'env-pairings.json',
        YIVE_RELAY_PUBLIC_URL: 'https://relay.example.com',
        YIVE_RELAY_REQUIRE_DESKTOP_BINDING: '1',
        YIVE_RELAY_STATIC_DIR: 'env-web-dist',
      })
    ).toEqual({
      heartbeatIntervalMs: 10000,
      heartbeatTimeoutMs: 45000,
      host: '0.0.0.0',
      pairingStorePath: 'env-pairings.json',
      pairingToken: 'env-admin',
      port: 4020,
      publicUrl: 'https://relay.example.com',
      requireDesktopBinding: true,
      staticDir: 'env-web-dist',
    })
  })

  test('lets relay server cli flags override environment variables', () => {
    expect(
      parseRelayServerArgs(
        [
          '--static-dir',
          'cli-web-dist',
          '--token',
          'cli-admin',
          '--heartbeat-interval-ms',
          '0',
          '--heartbeat-timeout-ms',
          '90000',
        ],
        {
          YIVE_RELAY_HEARTBEAT_INTERVAL_MS: '10000',
          YIVE_RELAY_HEARTBEAT_TIMEOUT_MS: '45000',
          YIVE_RELAY_ADMIN_TOKEN: 'env-admin',
          YIVE_RELAY_STATIC_DIR: 'env-web-dist',
        }
      )
    ).toMatchObject({
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 90000,
      pairingToken: 'cli-admin',
      requireDesktopBinding: false,
      staticDir: 'cli-web-dist',
    })
  })

  test('rejects invalid relay server heartbeat options', () => {
    expect(() => parseRelayServerArgs(['--heartbeat-interval-ms', '-1'])).toThrow(
      'heartbeat interval must be 0 or a positive integer'
    )
    expect(() => parseRelayServerArgs(['--heartbeat-timeout-ms', '0'])).toThrow(
      'heartbeat timeout must be a positive integer'
    )
    expect(() => parseRelayServerArgs([], { YIVE_RELAY_HEARTBEAT_TIMEOUT_MS: '15.5' })).toThrow(
      'heartbeat timeout must be a positive integer'
    )
  })

  test('rejects invalid relay server host options', () => {
    expect(() => parseRelayServerArgs(['--host', '0.0.0.0 extra'])).toThrow(
      'relay host must not be empty or contain whitespace'
    )
    expect(() => parseRelayServerArgs([], { YIVE_RELAY_HOST: ' ' })).toThrow(
      'relay host must not be empty or contain whitespace'
    )
  })

  test('serves health with connection counts', async () => {
    const staticDir = createStaticFixture()
    const relay = await startRelay({
      heartbeatIntervalMs: 5000,
      heartbeatTimeoutMs: 15000,
      staticDir,
    })

    const response = await fetch(`${relay.baseUrl}/health`)

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      service: 'hive-relay',
      version: readPackageVersion(),
      protocol_version: 2,
      features: ['mobile_confirmations', 'mobile_events', 'mobile_file_exchange', 'terminal_proxy'],
      desktop_count: 0,
      deployment: {
        public_url_configured: false,
      },
      heartbeat_interval_ms: 5000,
      heartbeat_timeout_ms: 15000,
      mobile_count: 0,
      pairing_store: {
        admin_token_default: false,
        device_token_count: 0,
        issued_token_count: 0,
        persistent: false,
        require_desktop_binding: false,
      },
      static: { mobile_app_available: true },
      terminal_proxy_count: 0,
    })
    expect(typeof body.started_at).toBe('number')
    expect(typeof body.uptime_ms).toBe('number')
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(body)).not.toContain(staticDir)
  })

  test('health reports whether a public smoke URL is configured without leaking it', async () => {
    const relay = await startRelay({ publicUrl: 'https://relay.example.com' })

    const response = await fetch(`${relay.baseUrl}/health`)
    const body = (await response.json()) as Record<string, unknown>

    expect(body).toMatchObject({
      deployment: {
        public_url_configured: true,
      },
    })
    expect(JSON.stringify(body)).not.toContain('https://relay.example.com')
  })

  test('health reports persistent pairing store diagnostics without leaking paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yive-relay-health-store-'))
    tempDirs.push(dir)
    const pairingStorePath = join(dir, 'pairings.json')
    const relay = await startRelay({ pairingStorePath })

    const pairingResponse = await fetch(`${relay.baseUrl}/pairings`, {
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
    })
    expect(pairingResponse.status).toBe(201)

    const response = await fetch(`${relay.baseUrl}/health`)
    const body = (await response.json()) as Record<string, unknown>

    expect(body).toMatchObject({
      pairing_store: {
        admin_token_default: false,
        device_token_count: 0,
        issued_token_count: 1,
        persistent: true,
      },
    })
    expect(JSON.stringify(body)).not.toContain(pairingStorePath)
  })

  test('health reports when the relay is using the development default admin token', async () => {
    const app = createRelayServer()
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()))
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('Relay did not bind')
    const relay: StartedRelay = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      async close() {
        app.hub.close()
        await new Promise<void>((resolve) => app.server.close(() => resolve()))
      },
      wsUrl(path) {
        return `ws://127.0.0.1:${address.port}${path}`
      },
    }
    startedRelays.push(relay)

    const response = await fetch(`${relay.baseUrl}/health`)
    const body = (await response.json()) as Record<string, unknown>

    expect(body).toMatchObject({
      pairing_store: {
        admin_token_default: true,
      },
    })
    expect(JSON.stringify(body)).not.toContain('dev-relay-token')
  })

  test('serves head health checks without a response body', async () => {
    const relay = await startRelay()

    const response = await fetch(`${relay.baseUrl}/health`, { method: 'HEAD' })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await response.text()).toBe('')
  })

  test('serves CORS preflight for browser relay clients', async () => {
    const relay = await startRelay()

    const response = await fetch(`${relay.baseUrl}/devices`, {
      headers: {
        'access-control-request-headers': 'authorization, content-type',
        'access-control-request-method': 'GET',
        origin: 'https://app.yive.test',
      },
      method: 'OPTIONS',
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-methods')).toContain('GET')
    expect(response.headers.get('access-control-allow-methods')).toContain('HEAD')
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
    expect(response.headers.get('access-control-allow-methods')).toContain('DELETE')
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization')
    expect(response.headers.get('access-control-allow-headers')).toContain('x-yive-relay-token')
  })

  test('rejects pairing token creation without the relay admin token', async () => {
    const relay = await startRelay()

    const response = await fetch(`${relay.baseUrl}/pairings`, { method: 'POST' })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Invalid relay admin token' })
  })

  test('short-lived pairing tokens must be claimed before opening sockets', async () => {
    const relay = await startRelay()

    const pairingResponse = await fetch(`${relay.baseUrl}/pairings`, {
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
    })
    const pairing = (await pairingResponse.json()) as {
      expires_at: number
      token: string
      ttl_ms: number
    }

    expect(pairingResponse.status).toBe(201)
    expect(pairing.token).not.toBe('test-token')
    expect(pairing.expires_at).toBeGreaterThan(Date.now())
    expect(pairing.ttl_ms).toBeGreaterThan(0)

    const unclaimedDesktop = new WebSocket(
      relay.wsUrl(`/ws/desktop?device_id=desktop-issued&pairing_token=${pairing.token}`)
    )
    const [, unclaimedResponse] = (await once(
      unclaimedDesktop,
      'unexpected-response'
    )) as unknown as [unknown, { statusCode: number }]
    const claimResponse = await fetch(`${relay.baseUrl}/pairings/claim`, {
      body: JSON.stringify({ device_id: 'desktop-issued', token: pairing.token }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const claimed = (await claimResponse.json()) as { token: string }
    const desktop = await openSocket(
      relay.wsUrl(`/ws/desktop?device_id=desktop-issued&pairing_token=${claimed.token}`)
    )
    const devicesResponse = await fetch(`${relay.baseUrl}/devices`, {
      headers: { authorization: 'Bearer test-token' },
    })

    expect(unclaimedResponse.statusCode).toBe(401)
    expect(claimResponse.status).toBe(201)
    expect(await devicesResponse.json()).toEqual({
      desktops: [
        {
          connected_at: expect.any(Number),
          device_id: 'desktop-issued',
          last_seen_at: expect.any(Number),
          runtime_status: 'unknown',
          runtime_updated_at: expect.any(Number),
        },
      ],
      mobiles: [],
    })
    desktop.close()
  })

  test('claims a short-lived pairing token into a reusable device token', async () => {
    const relay = await startRelay()
    const pairingResponse = await fetch(`${relay.baseUrl}/pairings`, {
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
    })
    const pairing = (await pairingResponse.json()) as { token: string }

    const claimResponse = await fetch(`${relay.baseUrl}/pairings/claim`, {
      body: JSON.stringify({ device_id: 'phone-1', token: pairing.token }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const claimed = (await claimResponse.json()) as { device_id: string; token: string }

    expect(claimResponse.status).toBe(201)
    expect(claimed.device_id).toBe('phone-1')
    expect(claimed.token).not.toBe(pairing.token)

    const mobile = await openSocket(
      relay.wsUrl(
        `/ws/mobile?device_id=phone-1&desktop_id=desktop-device-token&pairing_token=${claimed.token}`
      )
    )
    const mismatchedSocket = new WebSocket(
      relay.wsUrl(
        `/ws/mobile?device_id=phone-2&desktop_id=desktop-device-token&pairing_token=${claimed.token}`
      )
    )
    const [, mismatchResponse] = (await once(
      mismatchedSocket,
      'unexpected-response'
    )) as unknown as [unknown, { statusCode: number }]
    const reuseResponse = await fetch(`${relay.baseUrl}/pairings/claim`, {
      body: JSON.stringify({ device_id: 'phone-1', token: pairing.token }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(mismatchResponse.statusCode).toBe(401)
    expect(reuseResponse.status).toBe(401)
    mobile.close()
  })

  test('strict desktop binding rejects unbound mobile device tokens', async () => {
    const relay = await startRelay({ requireDesktopBinding: true })
    const pairingResponse = await fetch(`${relay.baseUrl}/pairings`, {
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
    })
    const pairing = (await pairingResponse.json()) as { token: string }

    const claimResponse = await fetch(`${relay.baseUrl}/pairings/claim`, {
      body: JSON.stringify({ device_id: 'phone-1', token: pairing.token }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const claimed = (await claimResponse.json()) as { token: string }
    const devicesResponse = await fetch(`${relay.baseUrl}/devices`, {
      headers: { authorization: `Bearer ${claimed.token}` },
    })
    const mobileSocket = new WebSocket(
      relay.wsUrl(
        `/ws/mobile?device_id=phone-1&desktop_id=desktop-1&pairing_token=${claimed.token}`
      )
    )
    const [, mobileResponse] = (await once(mobileSocket, 'unexpected-response')) as unknown as [
      unknown,
      { statusCode: number },
    ]

    expect(claimResponse.status).toBe(201)
    expect(devicesResponse.status).toBe(403)
    expect(await devicesResponse.json()).toEqual({
      error: 'Relay device token is not bound to a desktop',
    })
    expect(mobileResponse.statusCode).toBe(401)
  })

  test('binds claimed mobile device tokens to a target desktop when requested', async () => {
    const relay = await startRelay()
    const pairingResponse = await fetch(`${relay.baseUrl}/pairings`, {
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
    })
    const pairing = (await pairingResponse.json()) as { token: string }

    const claimResponse = await fetch(`${relay.baseUrl}/pairings/claim`, {
      body: JSON.stringify({
        desktop_id: 'desktop-1',
        device_id: 'phone-1',
        device_kind: 'mobile',
        token: pairing.token,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const claimed = (await claimResponse.json()) as {
      desktop_id: string
      device_id: string
      token: string
    }

    expect(claimResponse.status).toBe(201)
    expect(claimed).toEqual({
      desktop_id: 'desktop-1',
      device_id: 'phone-1',
      device_kind: 'mobile',
      token: expect.any(String),
    })

    const mobile = await openSocket(
      relay.wsUrl(
        `/ws/mobile?device_id=phone-1&desktop_id=desktop-1&pairing_token=${claimed.token}`
      )
    )
    const mismatchedMobile = new WebSocket(
      relay.wsUrl(
        `/ws/mobile?device_id=phone-1&desktop_id=desktop-2&pairing_token=${claimed.token}`
      )
    )
    const [, mismatchResponse] = (await once(
      mismatchedMobile,
      'unexpected-response'
    )) as unknown as [unknown, { statusCode: number }]
    const mismatchedTerminal = new WebSocket(
      relay.wsUrl(
        `/ws/terminal/run-1/io?device_id=phone-1&desktop_id=desktop-2&pairing_token=${claimed.token}`
      )
    )
    const [, terminalMismatchResponse] = (await once(
      mismatchedTerminal,
      'unexpected-response'
    )) as unknown as [unknown, { statusCode: number }]
    const impersonatedDesktop = new WebSocket(
      relay.wsUrl(`/ws/desktop?device_id=phone-1&pairing_token=${claimed.token}`)
    )
    const [, impersonatedDesktopResponse] = (await once(
      impersonatedDesktop,
      'unexpected-response'
    )) as unknown as [unknown, { statusCode: number }]
    const listResponse = await fetch(`${relay.baseUrl}/pairings/devices`, {
      headers: { authorization: 'Bearer test-token' },
    })

    expect(mismatchResponse.statusCode).toBe(401)
    expect(terminalMismatchResponse.statusCode).toBe(401)
    expect(impersonatedDesktopResponse.statusCode).toBe(401)
    expect(await listResponse.json()).toEqual({
      devices: [
        {
          desktop_id: 'desktop-1',
          device_id: 'phone-1',
          device_kind: 'mobile',
          token_hint: expect.any(String),
        },
      ],
    })
    mobile.close()
  })

  test('rejects desktop websocket connections for claimed mobile device tokens', async () => {
    const relay = await startRelay()
    const pairingResponse = await fetch(`${relay.baseUrl}/pairings`, {
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
    })
    const pairing = (await pairingResponse.json()) as { token: string }
    const claimResponse = await fetch(`${relay.baseUrl}/pairings/claim`, {
      body: JSON.stringify({
        device_id: 'phone-1',
        device_kind: 'mobile',
        token: pairing.token,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const claimed = (await claimResponse.json()) as { token: string }
    const desktop = new WebSocket(
      relay.wsUrl(`/ws/desktop?device_id=phone-1&pairing_token=${claimed.token}`)
    )
    const [, response] = (await once(desktop, 'unexpected-response')) as unknown as [
      unknown,
      { statusCode: number },
    ]

    expect(claimResponse.status).toBe(201)
    expect(response.statusCode).toBe(401)
  })

  test('rejects mobile websocket connections for claimed desktop device tokens', async () => {
    const relay = await startRelay()
    const pairingResponse = await fetch(`${relay.baseUrl}/pairings`, {
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
    })
    const pairing = (await pairingResponse.json()) as { token: string }
    const claimResponse = await fetch(`${relay.baseUrl}/pairings/claim`, {
      body: JSON.stringify({
        device_id: 'desktop-1',
        device_kind: 'desktop',
        token: pairing.token,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const claimed = (await claimResponse.json()) as { token: string }
    const desktop = await openSocket(
      relay.wsUrl(`/ws/desktop?device_id=desktop-1&pairing_token=${claimed.token}`)
    )
    const mobile = new WebSocket(
      relay.wsUrl(
        `/ws/mobile?device_id=desktop-1&desktop_id=desktop-1&pairing_token=${claimed.token}`
      )
    )
    const terminal = new WebSocket(
      relay.wsUrl(
        `/ws/terminal/run-1/io?device_id=desktop-1&desktop_id=desktop-1&pairing_token=${claimed.token}`
      )
    )
    const [, mobileResponse] = (await once(mobile, 'unexpected-response')) as unknown as [
      unknown,
      { statusCode: number },
    ]
    const [, terminalResponse] = (await once(terminal, 'unexpected-response')) as unknown as [
      unknown,
      { statusCode: number },
    ]

    expect(claimResponse.status).toBe(201)
    expect(mobileResponse.statusCode).toBe(401)
    expect(terminalResponse.statusCode).toBe(401)
    desktop.close()
  })

  test('binds claimed mobile device tokens to selected workspace ids', async () => {
    const relay = await startRelay()
    const pairingResponse = await fetch(`${relay.baseUrl}/pairings`, {
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
    })
    const pairing = (await pairingResponse.json()) as { token: string }
    const claimResponse = await fetch(`${relay.baseUrl}/pairings/claim`, {
      body: JSON.stringify({
        desktop_id: 'desktop-1',
        device_id: 'phone-1',
        token: pairing.token,
        workspace_ids: ['workspace-alpha', 'workspace-beta', 'workspace-alpha'],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const claimed = (await claimResponse.json()) as {
      desktop_id: string
      device_id: string
      token: string
      workspace_ids: string[]
    }

    expect(claimResponse.status).toBe(201)
    expect(claimed).toEqual({
      desktop_id: 'desktop-1',
      device_id: 'phone-1',
      token: expect.any(String),
      workspace_ids: ['workspace-alpha', 'workspace-beta'],
    })

    const listResponse = await fetch(`${relay.baseUrl}/pairings/devices`, {
      headers: { authorization: 'Bearer test-token' },
    })
    expect(await listResponse.json()).toEqual({
      devices: [
        {
          desktop_id: 'desktop-1',
          device_id: 'phone-1',
          token_hint: expect.any(String),
          workspace_ids: ['workspace-alpha', 'workspace-beta'],
        },
      ],
    })
  })

  test('scopes /devices visibility for a mobile token bound to one desktop', async () => {
    const relay = await startRelay()
    const pairingResponse = await fetch(`${relay.baseUrl}/pairings`, {
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
    })
    const pairing = (await pairingResponse.json()) as { token: string }
    const claimResponse = await fetch(`${relay.baseUrl}/pairings/claim`, {
      body: JSON.stringify({
        desktop_id: 'desktop-1',
        device_id: 'phone-1',
        token: pairing.token,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const claimed = (await claimResponse.json()) as { token: string }
    const desktopOne = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=test-token')
    )
    const desktopTwo = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-2&pairing_token=test-token')
    )
    const mobile = await openSocket(
      relay.wsUrl(
        `/ws/mobile?device_id=phone-1&desktop_id=desktop-1&pairing_token=${claimed.token}`
      )
    )

    const mobileDevicesResponse = await fetch(`${relay.baseUrl}/devices`, {
      headers: { authorization: `Bearer ${claimed.token}` },
    })
    const adminDevicesResponse = await fetch(`${relay.baseUrl}/devices`, {
      headers: { authorization: 'Bearer test-token' },
    })

    expect(mobileDevicesResponse.status).toBe(200)
    expect(await mobileDevicesResponse.json()).toEqual({
      desktops: [
        expect.objectContaining({
          device_id: 'desktop-1',
          runtime_status: 'unknown',
        }),
      ],
      mobiles: [
        expect.objectContaining({
          desktop_id: 'desktop-1',
          device_id: 'phone-1',
        }),
      ],
    })
    expect(adminDevicesResponse.status).toBe(200)
    expect(await adminDevicesResponse.json()).toEqual({
      desktops: expect.arrayContaining([
        expect.objectContaining({ device_id: 'desktop-1' }),
        expect.objectContaining({ device_id: 'desktop-2' }),
      ]),
      mobiles: [
        expect.objectContaining({
          desktop_id: 'desktop-1',
          device_id: 'phone-1',
        }),
      ],
    })
    desktopOne.close()
    desktopTwo.close()
    mobile.close()
  })

  test('account login issues a desktop-bound mobile token without exposing the admin token', async () => {
    const relay = await startRelay({
      accountLogin: { password: 'secret-password', username: 'alice' },
      requireDesktopBinding: true,
    })
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-windows&pairing_token=test-token')
    )

    const loginResponse = await fetch(`${relay.baseUrl}/accounts/login`, {
      body: JSON.stringify({
        desktop_id: 'desktop-windows',
        device_id: 'phone-app',
        password: 'secret-password',
        username: 'alice',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const claimed = (await loginResponse.json()) as {
      desktop_id: string
      device_id: string
      token: string
    }

    expect(loginResponse.status).toBe(201)
    expect(claimed).toEqual({
      desktop_id: 'desktop-windows',
      device_id: 'phone-app',
      device_kind: 'mobile',
      token: expect.any(String),
    })
    expect(claimed.token).not.toBe('test-token')

    const devicesResponse = await fetch(`${relay.baseUrl}/devices`, {
      headers: { authorization: `Bearer ${claimed.token}` },
    })
    expect(devicesResponse.status).toBe(200)
    expect(await devicesResponse.json()).toEqual({
      desktops: [expect.objectContaining({ device_id: 'desktop-windows' })],
      mobiles: [],
    })

    const badPasswordResponse = await fetch(`${relay.baseUrl}/accounts/login`, {
      body: JSON.stringify({
        desktop_id: 'desktop-windows',
        device_id: 'phone-app-2',
        password: 'wrong',
        username: 'alice',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(badPasswordResponse.status).toBe(401)

    desktop.close()
  })

  test('account login can use a server-side desktop binding without a desktop field', async () => {
    const relay = await startRelay({
      accountLogin: {
        desktopId: 'desktop-bound',
        password: 'secret-password',
        username: 'alice',
      },
      requireDesktopBinding: true,
    })
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-bound&pairing_token=test-token')
    )

    const loginResponse = await fetch(`${relay.baseUrl}/accounts/login`, {
      body: JSON.stringify({
        device_id: 'phone-app',
        password: 'secret-password',
        username: 'alice',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const claimed = (await loginResponse.json()) as {
      desktop_id: string
      device_id: string
      token: string
    }

    expect(loginResponse.status).toBe(201)
    expect(claimed).toEqual({
      desktop_id: 'desktop-bound',
      device_id: 'phone-app',
      device_kind: 'mobile',
      token: expect.any(String),
    })

    desktop.close()
  })

  test('rejects malformed or oversized relay pairing claim bodies', async () => {
    const relay = await startRelay()

    const malformed = await fetch(`${relay.baseUrl}/pairings/claim`, {
      body: '{',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'Invalid JSON body' })

    const oversized = await fetch(`${relay.baseUrl}/pairings/claim`, {
      body: JSON.stringify({ device_id: 'phone-1', token: 'x'.repeat(20_000) }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toEqual({ error: 'Relay request body is too large' })
  })

  test('rejects invalid relay pairing claim device ids', async () => {
    const relay = await startRelay()
    const pairingResponse = await fetch(`${relay.baseUrl}/pairings`, {
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
    })
    const pairing = (await pairingResponse.json()) as { token: string }

    for (const deviceId of ['phone\n1', 'x'.repeat(MAX_RELAY_DEVICE_ID_LENGTH + 1)]) {
      const response = await fetch(`${relay.baseUrl}/pairings/claim`, {
        body: JSON.stringify({ device_id: deviceId, token: pairing.token }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Invalid device_id' })
    }

    const stillValid = await fetch(`${relay.baseUrl}/pairings/claim`, {
      body: JSON.stringify({ device_id: 'phone-1', token: pairing.token }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(stillValid.status).toBe(201)
  })

  test('rejects invalid relay pairing claim desktop ids without consuming the token', async () => {
    const relay = await startRelay()
    const pairingResponse = await fetch(`${relay.baseUrl}/pairings`, {
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
    })
    const pairing = (await pairingResponse.json()) as { token: string }

    for (const desktopId of ['desktop\n1', 'x'.repeat(MAX_RELAY_DEVICE_ID_LENGTH + 1)]) {
      const response = await fetch(`${relay.baseUrl}/pairings/claim`, {
        body: JSON.stringify({
          desktop_id: desktopId,
          device_id: 'phone-1',
          token: pairing.token,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Invalid desktop_id' })
    }

    const stillValid = await fetch(`${relay.baseUrl}/pairings/claim`, {
      body: JSON.stringify({
        desktop_id: 'desktop-1',
        device_id: 'phone-1',
        token: pairing.token,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(stillValid.status).toBe(201)
    expect(await stillValid.json()).toMatchObject({
      desktop_id: 'desktop-1',
      device_id: 'phone-1',
    })
  })

  test('lists and revokes claimed device tokens through admin endpoints', async () => {
    const relay = await startRelay()
    const pairingResponse = await fetch(`${relay.baseUrl}/pairings`, {
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
    })
    const pairing = (await pairingResponse.json()) as { token: string }
    const claimResponse = await fetch(`${relay.baseUrl}/pairings/claim`, {
      body: JSON.stringify({ device_id: 'phone-1', token: pairing.token }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const claimed = (await claimResponse.json()) as { token: string }

    const unauthorizedList = await fetch(`${relay.baseUrl}/pairings/devices`)
    expect(unauthorizedList.status).toBe(401)

    const listResponse = await fetch(`${relay.baseUrl}/pairings/devices`, {
      headers: { authorization: 'Bearer test-token' },
    })
    const listed = (await listResponse.json()) as {
      devices: Array<{ device_id: string; token_hint: string }>
    }

    expect(listResponse.status).toBe(200)
    expect(listed.devices).toHaveLength(1)
    expect(listed.devices[0]?.device_id).toBe('phone-1')
    expect(listed.devices[0]?.token_hint).not.toBe(claimed.token)

    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=test-token')
    )
    const mobile = await openSocket(
      relay.wsUrl(
        `/ws/mobile?device_id=phone-1&desktop_id=desktop-1&pairing_token=${claimed.token}`
      )
    )
    const mobileClose = once(mobile, 'close')

    const revokeResponse = await fetch(`${relay.baseUrl}/pairings/devices/phone-1`, {
      headers: { authorization: 'Bearer test-token' },
      method: 'DELETE',
    })
    expect(revokeResponse.status).toBe(200)
    expect(await revokeResponse.json()).toEqual({ device_id: 'phone-1', revoked: true })
    const [closeCode, closeReason] = (await mobileClose) as [number, Buffer]
    expect(closeCode).toBe(4001)
    expect(closeReason.toString()).toBe('Relay device token revoked')

    const devicesResponse = await fetch(`${relay.baseUrl}/devices`, {
      headers: { authorization: 'Bearer test-token' },
    })
    expect(await devicesResponse.json()).toEqual({
      desktops: [
        {
          connected_at: expect.any(Number),
          device_id: 'desktop-1',
          last_seen_at: expect.any(Number),
          runtime_status: 'unknown',
          runtime_updated_at: expect.any(Number),
        },
      ],
      mobiles: [],
    })

    const socket = new WebSocket(
      relay.wsUrl(
        `/ws/mobile?device_id=phone-1&desktop_id=desktop-1&pairing_token=${claimed.token}`
      )
    )
    const [, response] = (await once(socket, 'unexpected-response')) as unknown as [
      unknown,
      { statusCode: number },
    ]
    expect(response.statusCode).toBe(401)
    desktop.close()
  })

  test('keeps claimed device tokens valid after relay restart when a store file is configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yive-relay-persistent-store-'))
    tempDirs.push(dir)
    const pairingStorePath = join(dir, 'pairings.json')
    const firstRelay = await startRelay({ pairingStorePath })
    const pairingResponse = await fetch(`${firstRelay.baseUrl}/pairings`, {
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
    })
    const pairing = (await pairingResponse.json()) as { token: string }
    const claimResponse = await fetch(`${firstRelay.baseUrl}/pairings/claim`, {
      body: JSON.stringify({ device_id: 'phone-1', token: pairing.token }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const claimed = (await claimResponse.json()) as { token: string }
    await firstRelay.close()

    const secondRelay = await startRelay({ pairingStorePath })
    const mobile = await openSocket(
      secondRelay.wsUrl(
        `/ws/mobile?device_id=phone-1&desktop_id=desktop-after-restart&pairing_token=${claimed.token}`
      )
    )
    const devicesResponse = await fetch(`${secondRelay.baseUrl}/devices`, {
      headers: { authorization: `Bearer ${claimed.token}` },
    })

    expect(await devicesResponse.json()).toEqual({
      desktops: [],
      mobiles: [
        {
          connected_at: expect.any(Number),
          desktop_id: 'desktop-after-restart',
          device_id: 'phone-1',
          last_seen_at: expect.any(Number),
        },
      ],
    })
    mobile.close()
  })

  test('serves the mobile web app from relay static assets', async () => {
    const relay = await startRelay({ staticDir: createStaticFixture() })

    const response = await fetch(`${relay.baseUrl}/mobile?relay=1`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toContain('Yive Mobile')
  })

  test('serves relay static assets with content types', async () => {
    const relay = await startRelay({ staticDir: createStaticFixture() })

    const response = await fetch(`${relay.baseUrl}/assets/app.js`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
    expect(response.headers.get('cache-control')).toBeNull()
    expect(await response.text()).toContain('relay mobile')
  })

  test('serves Android asset links from the well-known static path', async () => {
    const relay = await startRelay({ staticDir: createStaticFixture() })

    const response = await fetch(`${relay.baseUrl}/.well-known/assetlinks.json`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const assetLinks = (await response.json()) as Array<{
      target?: { namespace?: string; package_name?: string }
    }>
    expect(assetLinks[0]?.target).toMatchObject({
      namespace: 'android_app',
      package_name: 'com.example.yive',
    })
  })

  test('serves relay PWA boot files with conservative caching', async () => {
    const relay = await startRelay({ staticDir: createStaticFixture() })

    const manifestResponse = await fetch(`${relay.baseUrl}/manifest.webmanifest`)
    expect(manifestResponse.status).toBe(200)
    expect(manifestResponse.headers.get('content-type')).toBe(
      'application/manifest+json; charset=utf-8'
    )
    expect(manifestResponse.headers.get('cache-control')).toBe('max-age=0, must-revalidate')

    const swResponse = await fetch(`${relay.baseUrl}/sw.js`)
    expect(swResponse.status).toBe(200)
    expect(swResponse.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(swResponse.headers.get('cache-control')).toBe('no-store')
  })

  test('lists online desktop devices', async () => {
    const relay = await startRelay()
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=test-token')
    )

    const unauthorizedResponse = await fetch(`${relay.baseUrl}/devices`)
    const response = await fetch(`${relay.baseUrl}/devices`, {
      headers: { authorization: 'Bearer test-token' },
    })

    expect(unauthorizedResponse.status).toBe(401)
    expect(await unauthorizedResponse.json()).toEqual({ error: 'Invalid relay token' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      desktops: [
        {
          connected_at: expect.any(Number),
          device_id: 'desktop-1',
          last_seen_at: expect.any(Number),
          runtime_status: 'unknown',
          runtime_updated_at: expect.any(Number),
        },
      ],
      mobiles: [],
    })
    desktop.close()
  })

  test('reports desktop local runtime status in online devices', async () => {
    const relay = await startRelay()
    const desktop = await openSocket(
      relay.wsUrl(
        '/ws/desktop?device_id=desktop-1&pairing_token=test-token&runtime_status=offline&runtime_message=Local%20runtime%20down'
      )
    )

    const response = await fetch(`${relay.baseUrl}/devices`, {
      headers: { authorization: 'Bearer test-token' },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      desktops: [
        {
          connected_at: expect.any(Number),
          device_id: 'desktop-1',
          last_seen_at: expect.any(Number),
          runtime_message: 'Local runtime down',
          runtime_status: 'offline',
          runtime_updated_at: expect.any(Number),
        },
      ],
      mobiles: [],
    })
    desktop.close()
  })

  test('updates desktop last seen time from status heartbeats', async () => {
    const relay = await startRelay()
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=test-token')
    )
    const readDesktop = async () => {
      const response = await fetch(`${relay.baseUrl}/devices`, {
        headers: { authorization: 'Bearer test-token' },
      })
      const body = (await response.json()) as {
        desktops: Array<{ connected_at: number; last_seen_at: number; runtime_updated_at: number }>
      }
      const current = body.desktops[0]
      if (!current) throw new Error('Expected desktop snapshot')
      return current
    }
    const before = await readDesktop()
    await new Promise((resolve) => setTimeout(resolve, 5))

    desktop.send(
      JSON.stringify({
        channel: 'status',
        from: 'desktop-1',
        payload: { runtime_message: 'ready', runtime_status: 'online' },
        to: 'relay',
        type: 'desktop_status',
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    const after = await readDesktop()

    expect(after.connected_at).toBe(before.connected_at)
    expect(after.last_seen_at).toBeGreaterThan(before.last_seen_at)
    expect(after.runtime_updated_at).toBeGreaterThan(before.runtime_updated_at)
    desktop.close()
  })

  test('sanitizes desktop runtime status messages before exposing devices', async () => {
    const relay = await startRelay()
    const secretBase64 = `${'cGl4ZWxz'.repeat(12)}==`
    const runtimeMessage = [
      'Local runtime failed at C:\\Users\\dev\\AppData\\Local\\Temp\\hive-mobile-files\\abc.jpg',
      'HIVE_AGENT_TOKEN=secret-token',
      `content_base64=${secretBase64}`,
    ].join(' ')
    const desktop = await openSocket(
      relay.wsUrl(
        `/ws/desktop?device_id=desktop-1&pairing_token=test-token&runtime_status=offline&runtime_message=${encodeURIComponent(runtimeMessage)}`
      )
    )

    const response = await fetch(`${relay.baseUrl}/devices`, {
      headers: { authorization: 'Bearer test-token' },
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('C:\\Users\\dev')
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain(secretBase64)
    expect(body.desktops[0]).toMatchObject({
      device_id: 'desktop-1',
      runtime_message:
        'Local runtime failed at [local path] HIVE_AGENT_TOKEN=[redacted] content_base64=[redacted base64]',
      runtime_status: 'offline',
      runtime_updated_at: expect.any(Number),
    })
    desktop.close()
  })

  test('exposes sanitized desktop supervisor status summaries', async () => {
    const relay = await startRelay()
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=test-token')
    )

    desktop.send(
      JSON.stringify({
        channel: 'status',
        from: 'desktop-1',
        payload: {
          runtime_status: 'online',
          supervisor_phase: 'running; HIVE_AGENT_TOKEN=secret',
          supervisor_status: 'running',
          supervisor_updated_at: 1_700_000_000,
        },
        to: 'relay',
        type: 'desktop_status',
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 5))

    const response = await fetch(`${relay.baseUrl}/devices`, {
      headers: { authorization: 'Bearer test-token' },
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(JSON.stringify(body)).not.toContain('secret')
    expect(body.desktops[0]).toMatchObject({
      device_id: 'desktop-1',
      runtime_status: 'online',
      supervisor_status: 'running',
      supervisor_updated_at: 1_700_000_000,
    })
    expect(body.desktops[0]).not.toHaveProperty('supervisor_phase')
    desktop.close()
  })

  test('accepts the desktop connect client socket', async () => {
    const relay = await startRelay()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    await once(desktop, 'open')

    const response = await fetch(`${relay.baseUrl}/devices`, {
      headers: { authorization: 'Bearer test-token' },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      desktops: [
        {
          connected_at: expect.any(Number),
          device_id: 'desktop-client-1',
          features: [
            'mobile_confirmations',
            'mobile_events',
            'mobile_file_exchange',
            'terminal_proxy',
          ],
          last_seen_at: expect.any(Number),
          runtime_status: 'unknown',
          runtime_updated_at: expect.any(Number),
        },
      ],
      mobiles: [],
    })
    desktop.close()
  })

  test('normalizes relay desktop client server URLs', () => {
    expect(normalizeRelayServerUrlForDesktop('relay.example')).toBe('https://relay.example')
    expect(normalizeRelayServerUrlForDesktop('relay.example.com')).toBe('https://relay.example.com')
    expect(normalizeRelayServerUrlForDesktop('203.0.113.10:3001')).toBe('http://203.0.113.10:3001')
    expect(normalizeRelayServerUrlForDesktop('localhost:3001')).toBe('http://localhost:3001')

    const domainUrl = new URL(
      toRelayDesktopWebSocketUrl({
        deviceId: 'desktop-1',
        serverUrl: 'relay.example',
        token: 'test-token',
      })
    )
    expect(domainUrl.protocol).toBe('wss:')
    expect(domainUrl.host).toBe('relay.example')
    expect(domainUrl.pathname).toBe('/ws/desktop')
    expect(domainUrl.searchParams.get('device_id')).toBe('desktop-1')
    expect(domainUrl.searchParams.get('pairing_token')).toBe('test-token')
    expect(domainUrl.searchParams.get('features')).toBe(
      'mobile_confirmations,mobile_events,mobile_file_exchange,terminal_proxy'
    )

    const ipUrl = new URL(
      toRelayDesktopWebSocketUrl({
        deviceId: 'desktop-1',
        serverUrl: '203.0.113.10:3001',
        token: 'test-token',
      })
    )
    expect(ipUrl.protocol).toBe('ws:')
    expect(ipUrl.host).toBe('203.0.113.10:3001')
  })

  test('formats desktop connect lifecycle messages for operators', () => {
    expect(
      formatRelayDesktopConnectedMessage({
        deviceId: 'desktop-1',
        runtimeStatus: 'online',
        serverUrl: 'https://relay.example',
      })
    ).toBe('Yive desktop connected to https://relay.example as desktop-1 (runtime: online)')

    expect(
      formatRelayDesktopReconnectMessage({
        code: 1011,
        reason: Buffer.from('Relay restart'),
        reconnectDelayMs: 2_000,
        serverUrl: 'https://relay.example',
      })
    ).toBe(
      'Yive desktop relay closed with 1011 (Relay restart); reconnecting to https://relay.example in 2s.'
    )

    expect(
      formatRelayDesktopReconnectMessage({
        reconnectDelayMs: 750,
        serverUrl: 'https://relay.example',
      })
    ).toBe('Yive desktop relay closed; reconnecting to https://relay.example in 750ms.')
  })

  test('accepts desktop connect sockets with runtime status metadata', async () => {
    const relay = await startRelay()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      runtimeMessage: 'ready',
      runtimeStatus: 'online',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    await once(desktop, 'open')

    const response = await fetch(`${relay.baseUrl}/devices`, {
      headers: { authorization: 'Bearer test-token' },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      desktops: [
        {
          connected_at: expect.any(Number),
          device_id: 'desktop-client-1',
          features: [
            'mobile_confirmations',
            'mobile_events',
            'mobile_file_exchange',
            'terminal_proxy',
          ],
          last_seen_at: expect.any(Number),
          runtime_message: 'ready',
          runtime_status: 'online',
          runtime_updated_at: expect.any(Number),
        },
      ],
      mobiles: [],
    })
    desktop.close()
  })

  test('reads local runtime status for desktop relay diagnostics', async () => {
    const runtime = await startLocalRuntimeStub()
    try {
      await expect(readLocalRuntimeStatus(runtime.baseUrl)).resolves.toEqual({
        runtimeStatus: 'online',
      })
    } finally {
      await runtime.close()
    }

    const offlineStatus = await readLocalRuntimeStatus('http://127.0.0.1:1')
    expect(offlineStatus.runtimeStatus).toBe('offline')
    expect(offlineStatus.runtimeMessage).toBeTruthy()
  })

  test('desktop relay client refreshes runtime status after connecting', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
      runtimeStatusIntervalMs: 20,
    })
    await once(desktop, 'open')

    try {
      const body = await waitForRuntimeStatus(relay, 'online')
      expect(body.desktops?.[0]).toMatchObject({
        device_id: 'desktop-client-1',
        runtime_status: 'online',
      })
    } finally {
      desktop.close()
      await runtime.close()
    }
  })

  test('desktop relay client reports offline when the local runtime disappears', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRequestTimeoutMs: 50,
      localRuntimeUrl: runtime.baseUrl,
      runtimeStatusIntervalMs: 20,
    })
    await once(desktop, 'open')

    try {
      await waitForRuntimeStatus(relay, 'online')
      await runtime.close()
      const body = (await waitForRuntimeStatus(relay, 'offline')) as {
        desktops?: Array<{ runtime_message?: string; runtime_status?: string }>
      }
      expect(body.desktops?.[0]).toMatchObject({
        device_id: 'desktop-client-1',
        runtime_status: 'offline',
      })
      expect(body.desktops?.[0]?.runtime_message).toBeTruthy()
    } finally {
      desktop.close()
    }
  })

  test('desktop relay client reconnects after the relay closes its socket', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub()
    const controller = new AbortController()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = runRelayDesktopClient({
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
      reconnectDelayMs: 10,
      serverUrl: relay.baseUrl,
      signal: controller.signal,
      token: 'test-token',
    })

    try {
      const first = (await waitForDeviceCounts(relay, { desktops: 1, mobiles: 0 })) as {
        desktops: Array<{ connected_at: number; device_id: string }>
      }
      const firstDesktop = first.desktops.find(
        (desktop) => desktop.device_id === 'desktop-client-1'
      )
      if (!firstDesktop) throw new Error('Expected first desktop connection')

      relay.hub.disconnectDevice('desktop-client-1', 1011, 'Relay restart')

      const reconnected = await waitForDesktopReconnect(relay, firstDesktop.connected_at)
      expect(reconnected).toMatchObject({ device_id: 'desktop-client-1' })
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('reconnecting to '))
    } finally {
      controller.abort()
      await client
      logSpy.mockRestore()
      errorSpy.mockRestore()
      await runtime.close()
    }
  })

  test('forwards list_workspaces to the connected desktop runtime', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const mobile = await openSocket(
      relay.wsUrl(
        '/ws/mobile?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token'
      )
    )

    mobile.send(
      JSON.stringify({
        type: 'list_workspaces',
        request_id: 'req-workspaces',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: {},
      })
    )

    expect(await readMessage(mobile)).toEqual({
      type: 'list_workspaces_result',
      request_id: 'req-workspaces',
      from: 'desktop-client-1',
      to: 'mobile-1',
      channel: 'runtime',
      payload: {
        workspaces: [{ id: 'workspace-1', name: 'Local Workspace', path: '/work/local' }],
      },
    })
    desktop.close()
    mobile.close()
    await runtime.close()
  })

  test('forwards list_agents_and_runs to the connected desktop runtime', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const mobile = await openSocket(
      relay.wsUrl(
        '/ws/mobile?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token'
      )
    )

    mobile.send(
      JSON.stringify({
        type: 'list_agents_and_runs',
        request_id: 'req-agents-runs',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: { workspace_id: 'workspace-1' },
      })
    )

    expect(await readMessage(mobile)).toEqual({
      type: 'list_agents_and_runs_result',
      request_id: 'req-agents-runs',
      from: 'desktop-client-1',
      to: 'mobile-1',
      channel: 'runtime',
      payload: {
        agents: [
          {
            active_dispatch_id: null,
            conversation_provider: 'codex',
            conversation_activity: 'busy',
            id: 'agent-1',
            kind: 'worker',
            last_observed_at: 1,
            last_pty_line: 'ready',
            name: 'Coder',
            process_state: 'running',
            provider: 'codex',
            queue_pause_reason: null,
            queued_dispatch_count: 0,
          },
        ],
        runs: [
          {
            agent_id: 'agent-1',
            agent_name: 'Coder',
            run_id: 'run-1',
            status: 'running',
            terminal_input_profile: 'default',
          },
        ],
        workspace_id: 'workspace-1',
      },
    })
    desktop.close()
    mobile.close()
    await runtime.close()
  })

  test.each([
    'list_workspace_tasks',
    'save_workspace_tasks',
  ])('rejects retired %s envelopes at the Relay boundary', async (type) => {
    const relay = await startRelay()
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-client-1&pairing_token=test-token')
    )
    const mobile = await openSocket(
      relay.wsUrl(
        '/ws/mobile?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token'
      )
    )

    mobile.send(
      JSON.stringify({
        type,
        request_id: 'req-tasks',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: { workspace_id: 'workspace-1' },
      })
    )

    expect(await readMessage(mobile)).toEqual({
      type: 'relay_error',
      request_id: 'req-tasks',
      from: 'relay',
      to: 'mobile-1',
      channel: 'runtime',
      payload: {
        code: 'not_implemented',
        desktop_id: 'desktop-client-1',
        message: `Relay request is not implemented: ${type}`,
      },
    })
    await expectNoRelayMessage(desktop)
    desktop.close()
    mobile.close()
  })

  test.each([
    'list_workspace_tasks_result',
    'save_workspace_tasks_result',
  ])('rejects retired %s envelopes from desktop at the Relay boundary', async (type) => {
    const relay = await startRelay()
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-client-1&pairing_token=test-token')
    )
    const mobile = await openSocket(
      relay.wsUrl(
        '/ws/mobile?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token'
      )
    )

    desktop.send(
      JSON.stringify({
        type,
        request_id: 'req-tasks-result',
        from: 'desktop-client-1',
        to: 'mobile-1',
        channel: 'runtime',
        payload: {},
      })
    )

    expect(await readMessage(desktop)).toEqual({
      type: 'relay_error',
      request_id: 'req-tasks-result',
      from: 'relay',
      to: 'desktop-client-1',
      channel: 'runtime',
      payload: {
        code: 'not_implemented',
        message: `Relay request is not implemented: ${type}`,
      },
    })
    await expectNoRelayMessage(mobile)
    desktop.close()
    mobile.close()
  })

  test('forwards mobile events snapshots from the connected desktop runtime', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const mobile = await openSocket(
      relay.wsUrl(
        '/ws/mobile?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token'
      )
    )

    const mobileEvents = readMessages(mobile, 2)
    mobile.send(
      JSON.stringify({
        type: 'subscribe_mobile_events',
        request_id: 'sub-mobile-events',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'mobile_events',
        payload: { subscription_id: 'sub-mobile-events' },
      })
    )

    expect(await mobileEvents).toEqual([
      {
        type: 'mobile_events_message',
        request_id: 'sub-mobile-events',
        from: 'desktop-client-1',
        to: 'mobile-1',
        channel: 'mobile_events',
        payload: {
          snapshot: {
            active_workspace: null,
            active_workspace_id: 'workspace-1',
            connection: { relay: false },
            generated_at: 1_700_000_123,
            workspaces: [
              { id: 'workspace-1', is_active: true, name: 'Local Workspace', path: '/work/local' },
            ],
          },
          type: 'mobile-snapshot',
        },
      },
      {
        type: 'mobile_events_message',
        request_id: 'sub-mobile-events',
        from: 'desktop-client-1',
        to: 'mobile-1',
        channel: 'mobile_events',
        payload: {
          generated_at: 1_700_000_124,
          type: 'mobile-heartbeat',
        },
      },
    ])
    expect(runtime.getMobileEventsConnectionCount()).toBe(1)
    expect(runtime.getRelayHeaderRecords()).toContainEqual({
      desktopId: 'desktop-client-1',
      mobileDeviceId: 'mobile-1',
      workspaceIds: undefined,
    })

    const invalidationMessage = readMessage(mobile)
    runtime.broadcastMobileEvent({
      activity_state: 'idle',
      agent_id: 'agent-1',
      conversation_id: 'conversation-1',
      cursor: 42,
      type: 'conversation-invalidated',
      workspace_id: 'workspace-1',
    })
    await expect(invalidationMessage).resolves.toMatchObject({
      channel: 'mobile_events',
      payload: {
        activity_state: 'idle',
        agent_id: 'agent-1',
        conversation_id: 'conversation-1',
        cursor: 42,
        type: 'conversation-invalidated',
        workspace_id: 'workspace-1',
      },
      type: 'mobile_events_message',
    })

    mobile.send(
      JSON.stringify({
        type: 'unsubscribe_mobile_events',
        request_id: 'sub-mobile-events',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'mobile_events',
        payload: { subscription_id: 'sub-mobile-events' },
      })
    )

    await vi.waitFor(() => expect(runtime.getMobileEventsCloseCount()).toBe(1))
    desktop.close()
    mobile.close()
    await runtime.close()
  })

  test('forwards live mobile event snapshot updates after local runtime changes', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const mobile = await openSocket(
      relay.wsUrl(
        '/ws/mobile?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token'
      )
    )

    const initialMessages = readMessages(mobile, 2)
    mobile.send(
      JSON.stringify({
        type: 'subscribe_mobile_events',
        request_id: 'sub-live-mobile-events',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'mobile_events',
        payload: { subscription_id: 'sub-live-mobile-events' },
      })
    )

    const [initial] = await initialMessages
    expect(initial).toMatchObject({
      type: 'mobile_events_message',
      request_id: 'sub-live-mobile-events',
      payload: {
        snapshot: {
          generated_at: 1_700_000_123,
          workspaces: [expect.objectContaining({ name: 'Local Workspace' })],
        },
        type: 'mobile-snapshot',
      },
    })

    const updated = readMessage(mobile)
    runtime.broadcastMobileSnapshot('Updated Local Workspace', 1_700_000_999)

    expect(await updated).toMatchObject({
      type: 'mobile_events_message',
      request_id: 'sub-live-mobile-events',
      from: 'desktop-client-1',
      to: 'mobile-1',
      channel: 'mobile_events',
      payload: {
        snapshot: {
          generated_at: 1_700_000_999,
          workspaces: [expect.objectContaining({ name: 'Updated Local Workspace' })],
        },
        type: 'mobile-snapshot',
      },
    })

    desktop.close()
    mobile.close()
    await runtime.close()
  })

  test('forwards chat_submit unchanged to the connected desktop runtime', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub()
    const pairingResponse = await fetch(`${relay.baseUrl}/pairings`, {
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
    })
    const pairing = (await pairingResponse.json()) as { token: string }
    const claimResponse = await fetch(`${relay.baseUrl}/pairings/claim`, {
      body: JSON.stringify({
        desktop_id: 'desktop-client-1',
        device_id: 'mobile-1',
        token: pairing.token,
        workspace_ids: ['workspace-1'],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const claimed = (await claimResponse.json()) as { token: string }
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const mobileUrl = relay.wsUrl(
      `/ws/mobile?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=${claimed.token}`
    )
    let mobile = await openSocket(mobileUrl)

    mobile.send(
      JSON.stringify({
        type: 'mobile_action',
        request_id: 'req-mobile-action',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: {
          action_id: '55555555-5555-4555-8555-555555555555',
          kind: 'chat_submit',
          payload: {
            attachments: [{ file_id: 'file-relay-image' }],
            body: 'hello through relay C:/private HIVE_AGENT_TOKEN=secret',
          },
          target: { conversation_id: 'conversation-1' },
          workspace_id: 'workspace-1',
        },
      })
    )

    expect(await readMessage(mobile)).toEqual({
      type: 'mobile_action_result',
      request_id: 'req-mobile-action',
      from: 'desktop-client-1',
      to: 'mobile-1',
      channel: 'runtime',
      payload: {
        action_id: '55555555-5555-4555-8555-555555555555',
        kind: 'chat_submit',
        ok: true,
        result: {
          accepted_at: 1_700_000_100,
          body: 'hello through relay [local path] HIVE_AGENT_TOKEN=[redacted]',
          cancelled_at: null,
          confirmed_at: null,
          conversation_id: 'conversation-1',
          delivered_at: 1_700_000_101,
          error_code: null,
          id: '55555555-5555-4555-8555-555555555555',
          provider_event_id: null,
          provider_turn_sequence: null,
          state: 'delivered',
        },
        workspace_id: 'workspace-1',
      },
    })
    expect(runtime.getMobileActionRequests()).toEqual([
      {
        action_id: '55555555-5555-4555-8555-555555555555',
        kind: 'chat_submit',
        payload: {
          attachments: [{ file_id: 'file-relay-image' }],
          body: 'hello through relay C:/private HIVE_AGENT_TOKEN=secret',
        },
        target: { conversation_id: 'conversation-1' },
        workspace_id: 'workspace-1',
      },
    ])
    mobile.send(
      JSON.stringify({
        type: 'mobile_action',
        request_id: 'req-mobile-action-duplicate',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: runtime.getMobileActionRequests()[0],
      })
    )
    expect(await readMessage(mobile)).toMatchObject({
      type: 'mobile_action_result',
      request_id: 'req-mobile-action-duplicate',
      payload: { duplicate: true },
    })

    mobile.send(
      JSON.stringify({
        type: 'mobile_action',
        request_id: 'req-mobile-action-cross-workspace',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: {
          ...runtime.getMobileActionRequests()[0],
          action_id: '66666666-6666-4666-8666-666666666666',
          workspace_id: 'workspace-2',
        },
      })
    )
    expect(await readMessage(mobile)).toMatchObject({
      type: 'relay_error',
      request_id: 'req-mobile-action-cross-workspace',
      payload: { code: 'local_runtime_error' },
    })

    mobile.send(
      JSON.stringify({
        type: 'get_mobile_conversation',
        request_id: 'req-mobile-conversation-confirmed',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: { agent_id: 'agent-1', workspace_id: 'workspace-1' },
      })
    )
    expect(await readMessage(mobile)).toMatchObject({
      type: 'get_mobile_conversation_result',
      payload: {
        conversation: {
          submissions: [
            {
              body: 'hello through relay [local path] HIVE_AGENT_TOKEN=[redacted]',
              provider_event_id: 'provider-user-1',
              state: 'confirmed',
            },
          ],
        },
      },
    })

    mobile.send(
      JSON.stringify({
        type: 'get_mobile_conversations',
        request_id: 'req-mobile-conversations',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: { agent_id: 'agent-1', cursor: 'page-1', workspace_id: 'workspace-1' },
      })
    )
    expect(await readMessage(mobile)).toMatchObject({
      type: 'get_mobile_conversations_result',
      request_id: 'req-mobile-conversations',
      payload: {
        items: [{ id: 'conversation-old', title: 'Recorded work' }],
        next_cursor: null,
      },
    })

    mobile.send(
      JSON.stringify({
        type: 'mobile_action',
        request_id: 'req-mobile-action-force-chat',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: {
          action_id: 'force-chat-action',
          kind: 'chat_force',
          payload: { skipped_count: 1 },
          target: { submission_id: '88888888-8888-4888-8888-888888888888' },
          workspace_id: 'workspace-1',
        },
      })
    )
    expect(await readMessage(mobile)).toMatchObject({
      type: 'mobile_action_result',
      request_id: 'req-mobile-action-force-chat',
      payload: {
        kind: 'chat_force',
        result: {
          id: '88888888-8888-4888-8888-888888888888',
          state: 'delivered',
        },
      },
    })

    const lostAckAction = {
      ...runtime.getMobileActionRequests()[0],
      action_id: '77777777-7777-4777-8777-777777777777',
    }
    mobile.send(
      JSON.stringify({
        type: 'mobile_action',
        request_id: 'req-mobile-action-lost-ack',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: lostAckAction,
      })
    )
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (runtime.getMobileActionRequests().length >= 5) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const mobileClosed = once(mobile, 'close')
    mobile.close()
    await mobileClosed
    mobile = await openSocket(mobileUrl)
    mobile.send(
      JSON.stringify({
        type: 'mobile_action',
        request_id: 'req-mobile-action-after-lost-ack',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: { ...lostAckAction, payload: {} },
      })
    )
    expect(await readMessage(mobile)).toMatchObject({
      type: 'mobile_action_result',
      request_id: 'req-mobile-action-after-lost-ack',
      payload: { duplicate: true },
    })
    expect(runtime.getRelayHeaderRecords()).toContainEqual({
      desktopId: 'desktop-client-1',
      mobileDeviceId: 'mobile-1',
      workspaceIds: undefined,
    })
    desktop.close()
    mobile.close()
    await runtime.close()
  })

  test('forwards lifecycle success and typed recovery failure through Relay', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub({ mobileActionFailureKind: 'restart_run' })
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const mobile = await openSocket(
      relay.wsUrl(
        '/ws/mobile?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token'
      )
    )

    mobile.send(
      JSON.stringify({
        channel: 'runtime',
        from: 'mobile-1',
        payload: {
          action_id: 'relay-start-worker',
          kind: 'start_run',
          payload: {},
          target: { agent_id: 'agent-1' },
          workspace_id: 'workspace-1',
        },
        request_id: 'req-relay-start-worker',
        to: 'desktop-client-1',
        type: 'mobile_action',
      })
    )
    expect(await readMessage(mobile)).toMatchObject({
      payload: {
        action_id: 'relay-start-worker',
        kind: 'start_run',
        ok: true,
        result: { run_id: 'run-1' },
      },
      request_id: 'req-relay-start-worker',
      type: 'mobile_action_result',
    })

    mobile.send(
      JSON.stringify({
        channel: 'runtime',
        from: 'mobile-1',
        payload: {
          action_id: 'relay-restart-worker',
          kind: 'restart_run',
          payload: { confirmation_nonce: 'nonce-relay-confirmation' },
          target: { agent_id: 'agent-1', run_id: 'run-1' },
          workspace_id: 'workspace-1',
        },
        request_id: 'req-relay-restart-worker',
        to: 'desktop-client-1',
        type: 'mobile_action',
      })
    )
    expect(await readMessage(mobile)).toEqual({
      channel: 'runtime',
      from: 'desktop-client-1',
      payload: {
        code: 'worker_session_unverified',
        message: 'Local runtime request failed: /api/mobile/actions (409)',
      },
      request_id: 'req-relay-restart-worker',
      to: 'mobile-1',
      type: 'relay_error',
    })
    expect(runtime.getMobileActionRequests()).toEqual([
      expect.objectContaining({ kind: 'start_run' }),
      expect.objectContaining({ kind: 'restart_run' }),
    ])

    desktop.close()
    mobile.close()
    await runtime.close()
  })

  test('forwards a real Runtime Provider recovery failure through mobile and Relay', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const root = mkdtempSync(join(tmpdir(), 'yive-relay-lifecycle-'))
    tempDirs.push(root)
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    process.env.CODEX_HOME = join(root, 'codex-home')
    const providerFixture = writeProviderAdapterFixture({
      fixtureId: 'relay-lifecycle-source-loss',
      provider: 'codex',
      root,
      workspacePath,
    })
    const runtime = await startTestServer({ dataDir: join(root, 'runtime') })
    const workspace = runtime.store.createWorkspace(workspacePath, 'Relay lifecycle')
    const worker = runtime.store.addWorker(workspace.id, { name: 'Alice' })
    runtime.store.configureAgentLaunch(workspace.id, worker.id, {
      ...buildManagedProviderLaunchConfig('codex'),
      args: [],
      command: providerFixture.command,
      interactiveCommand: providerFixture.command,
    })
    const relay = await startRelay()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-lifecycle',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-lifecycle',
      localRuntimeUrl: runtime.baseUrl,
    })
    let mobile: WebSocket | undefined

    try {
      await once(desktop, 'open')
      mobile = await openSocket(
        relay.wsUrl(
          '/ws/mobile?device_id=mobile-lifecycle&desktop_id=desktop-lifecycle&pairing_token=test-token'
        )
      )
      mobile.send(
        JSON.stringify({
          channel: 'runtime',
          from: 'mobile-lifecycle',
          payload: {
            action_id: 'relay-real-start-worker',
            kind: 'start_run',
            payload: {},
            target: { agent_id: worker.id },
            workspace_id: workspace.id,
          },
          request_id: 'req-relay-real-start-worker',
          to: 'desktop-lifecycle',
          type: 'mobile_action',
        })
      )
      await expect(
        waitForMessageMatching(
          mobile,
          (message) => message.request_id === 'req-relay-real-start-worker',
          10_000
        )
      ).resolves.toMatchObject({
        payload: {
          action_id: 'relay-real-start-worker',
          kind: 'start_run',
          ok: true,
          result: { agent_id: worker.id, run_id: expect.any(String) },
        },
        type: 'mobile_action_result',
      })
      await vi.waitFor(
        () => {
          expect(runtime.store.getCurrentAgentConversation(workspace.id, worker.id)).toMatchObject({
            activity_state: 'idle',
            cli_session_id: providerFixture.sessionId,
          })
        },
        { timeout: 10_000 }
      )

      providerFixture.crash()
      await vi.waitFor(
        () => {
          expect(runtime.store.getAgentState(workspace.id, worker.id).processState).toBe('crashed')
        },
        { timeout: 10_000 }
      )
      providerFixture.clearCrash()
      rmSync(providerFixture.sessionPath, { force: true })

      mobile.send(
        JSON.stringify({
          channel: 'runtime',
          from: 'mobile-lifecycle',
          payload: {
            action_id: 'relay-real-recover-worker',
            kind: 'start_run',
            payload: {},
            target: { agent_id: worker.id },
            workspace_id: workspace.id,
          },
          request_id: 'req-relay-real-recover-worker',
          to: 'desktop-lifecycle',
          type: 'mobile_action',
        })
      )
      await expect(
        waitForMessageMatching(
          mobile,
          (message) => message.request_id === 'req-relay-real-recover-worker',
          10_000
        )
      ).resolves.toMatchObject({
        payload: {
          code: 'worker_session_unverified',
          message: 'Local runtime request failed: /api/mobile/actions (409)',
        },
        type: 'relay_error',
      })
      expect(runtime.store.getAgentState(workspace.id, worker.id).processState).not.toBe('running')
    } finally {
      desktop.close()
      mobile?.close()
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      await runtime.close()
    }
  }, 30_000)

  test('forwards mobile transcript requests to the connected desktop runtime', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const mobile = await openSocket(
      relay.wsUrl(
        '/ws/mobile?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token'
      )
    )

    mobile.send(
      JSON.stringify({
        type: 'get_mobile_transcript',
        request_id: 'req-mobile-transcript',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: {
          run_id: 'run-1',
          workspace_id: 'workspace-1',
        },
      })
    )

    expect(await readMessage(mobile)).toEqual({
      type: 'get_mobile_transcript_result',
      request_id: 'req-mobile-transcript',
      from: 'desktop-client-1',
      to: 'mobile-1',
      channel: 'runtime',
      payload: expect.objectContaining({
        events: [
          expect.objectContaining({
            id: 'action:action-1',
            kind: 'terminal_input',
            run_id: 'run-1',
            type: 'mobile_action_echo',
          }),
        ],
        run_id: 'run-1',
        workspace_id: 'workspace-1',
      }),
    })
    desktop.close()
    mobile.close()
    await runtime.close()
  })

  test('forwards mobile confirmation creation to the connected desktop runtime', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const mobile = await openSocket(
      relay.wsUrl(
        '/ws/mobile?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token'
      )
    )

    mobile.send(
      JSON.stringify({
        type: 'create_mobile_confirmation',
        request_id: 'req-mobile-confirmation',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: {
          kind: 'stop_run',
          target: { run_id: 'run-1' },
          workspace_id: 'workspace-1',
        },
      })
    )

    expect(await readMessage(mobile)).toEqual({
      type: 'create_mobile_confirmation_result',
      request_id: 'req-mobile-confirmation',
      from: 'desktop-client-1',
      to: 'mobile-1',
      channel: 'runtime',
      payload: {
        expires_in_ms: 60000,
        kind: 'stop_run',
        nonce: 'nonce-relay-confirmation',
        ok: true,
        workspace_id: 'workspace-1',
      },
    })
    desktop.close()
    mobile.close()
    await runtime.close()
  })

  test('returns a local runtime error when desktop runtime forwarding times out', async () => {
    const relay = await startRelay()
    const runtime = await startHangingRuntimeStub()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      runtimeStatus: 'online',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRequestTimeoutMs: 25,
      localRuntimeUrl: runtime.baseUrl,
      runtimeStatusIntervalMs: 0,
    })
    await once(desktop, 'open')
    const mobile = await openSocket(
      relay.wsUrl(
        '/ws/mobile?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token'
      )
    )

    mobile.send(
      JSON.stringify({
        type: 'list_workspaces',
        request_id: 'req-runtime-timeout',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: {},
      })
    )

    expect(await readMessage(mobile)).toEqual({
      type: 'relay_error',
      request_id: 'req-runtime-timeout',
      from: 'desktop-client-1',
      to: 'mobile-1',
      channel: 'runtime',
      payload: {
        code: 'local_runtime_error',
        message: 'Local runtime request timed out: /api/workspaces (25ms)',
      },
    })
    desktop.close()
    mobile.close()
    await runtime.close()
  })

  test('rejects runtime requests when the desktop runtime is offline without forwarding', async () => {
    const relay = await startRelay()
    const desktop = await openSocket(
      relay.wsUrl(
        '/ws/desktop?device_id=desktop-1&pairing_token=test-token&runtime_status=offline&runtime_message=Local%20runtime%20down'
      )
    )
    const mobile = await openSocket(
      relay.wsUrl('/ws/mobile?device_id=mobile-1&desktop_id=desktop-1&pairing_token=test-token')
    )

    mobile.send(
      JSON.stringify({
        type: 'mobile_action',
        request_id: 'req-runtime-offline',
        from: 'mobile-1',
        to: 'desktop-1',
        channel: 'runtime',
        payload: {
          action_id: 'action-offline',
          kind: 'terminal_input',
          payload: { input: 'hello' },
          target: { run_id: 'run-1' },
          workspace_id: 'workspace-1',
        },
      })
    )

    expect(await readMessage(mobile)).toEqual({
      type: 'relay_error',
      request_id: 'req-runtime-offline',
      from: 'relay',
      to: 'mobile-1',
      channel: 'runtime',
      payload: {
        code: 'desktop_runtime_unavailable',
        desktop_id: 'desktop-1',
        message: 'Local runtime down',
      },
    })
    await expectNoRelayMessage(desktop)
    desktop.close()
    mobile.close()
  })

  test('forwards mobile file exchange requests without leaking desktop paths', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const mobile = await openSocket(
      relay.wsUrl(
        '/ws/mobile?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token'
      )
    )

    mobile.send(
      JSON.stringify({
        type: 'upload_mobile_file',
        request_id: 'req-upload',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: { content_base64: Buffer.from('pixels').toString('base64'), name: 'shot.png' },
      })
    )
    const uploadResult = await readMessage(mobile)
    expect(uploadResult).toEqual({
      type: 'upload_mobile_file_result',
      request_id: 'req-upload',
      from: 'desktop-client-1',
      to: 'mobile-1',
      channel: 'runtime',
      payload: {
        created_at: 1_700_000_000,
        id: 'file-1',
        mime_type: 'image/png',
        name: 'shot.png',
        size: 6,
      },
    })
    expect(JSON.stringify(uploadResult)).not.toContain('hive-mobile-files')
    expect(JSON.stringify(uploadResult)).not.toContain('content_base64')
    expect(JSON.stringify(uploadResult)).not.toContain('registry_path')
    expect(JSON.stringify(uploadResult)).not.toContain('HIVE_AGENT_TOKEN')

    mobile.send(
      JSON.stringify({
        type: 'list_mobile_files',
        request_id: 'req-list-files',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: {},
      })
    )
    const listResult = await readMessage(mobile)
    expect(listResult).toEqual(
      expect.objectContaining({
        payload: [
          {
            created_at: 1_700_000_000,
            id: 'file-1',
            mime_type: 'image/png',
            name: 'shot.png',
            size: 6,
          },
        ],
      })
    )
    expect(JSON.stringify(listResult)).not.toContain('C:\\Temp')
    expect(JSON.stringify(listResult)).not.toContain('content_base64')
    expect(JSON.stringify(listResult)).not.toContain('registry_path')
    expect(JSON.stringify(listResult)).not.toContain('HIVE_AGENT_TOKEN')

    mobile.send(
      JSON.stringify({
        type: 'download_mobile_file',
        request_id: 'req-download',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: { file_id: 'file-1' },
      })
    )
    expect(await readMessage(mobile)).toEqual({
      type: 'download_mobile_file_result',
      request_id: 'req-download',
      from: 'desktop-client-1',
      to: 'mobile-1',
      channel: 'runtime',
      payload: {
        content_base64: Buffer.from('pixels').toString('base64'),
        mime_type: 'image/png',
        name: 'shot.png',
      },
    })

    mobile.send(
      JSON.stringify({
        type: 'delete_mobile_file',
        request_id: 'req-delete-file',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: { file_id: 'file-1' },
      })
    )
    expect(await readMessage(mobile)).toEqual(
      expect.objectContaining({
        payload: { ok: true },
        request_id: 'req-delete-file',
        type: 'delete_mobile_file_result',
      })
    )

    mobile.send(
      JSON.stringify({
        type: 'send_workspace_file_to_mobile',
        request_id: 'req-workspace-file',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: { path: 'dist/demo.md', workspace_id: 'workspace-1' },
      })
    )
    const workspaceFileResult = await readMessage(mobile)
    expect(workspaceFileResult).toEqual({
      type: 'send_workspace_file_to_mobile_result',
      request_id: 'req-workspace-file',
      from: 'desktop-client-1',
      to: 'mobile-1',
      channel: 'runtime',
      payload: {
        created_at: 1_700_000_001,
        id: 'file-workspace',
        mime_type: 'text/markdown; charset=utf-8',
        name: 'demo.md',
        size: 'workspace content'.length,
        workspace_path: 'dist/demo.md',
      },
    })
    expect(JSON.stringify(workspaceFileResult)).not.toContain('C:\\work')
    expect(JSON.stringify(workspaceFileResult)).not.toContain('registry_path')
    expect(JSON.stringify(workspaceFileResult)).not.toContain('agent_token')

    mobile.send(
      JSON.stringify({
        type: 'download_mobile_file',
        request_id: 'req-download-workspace-file',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: { file_id: 'file-workspace' },
      })
    )
    expect(await readMessage(mobile)).toEqual({
      type: 'download_mobile_file_result',
      request_id: 'req-download-workspace-file',
      from: 'desktop-client-1',
      to: 'mobile-1',
      channel: 'runtime',
      payload: {
        content_base64: Buffer.from('workspace content').toString('base64'),
        mime_type: 'text/markdown; charset=utf-8',
        name: 'demo.md',
      },
    })

    mobile.send(
      JSON.stringify({
        type: 'clear_mobile_files',
        request_id: 'req-clear-files',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: {},
      })
    )
    expect(await readMessage(mobile)).toEqual(
      expect.objectContaining({
        payload: { ok: true },
        request_id: 'req-clear-files',
        type: 'clear_mobile_files_result',
      })
    )

    desktop.close()
    mobile.close()
    await runtime.close()
  })

  test('returns token-safe relay errors when local file upload validation fails', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const mobile = await openSocket(
      relay.wsUrl(
        '/ws/mobile?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token'
      )
    )

    mobile.send(
      JSON.stringify({
        type: 'upload_mobile_file',
        request_id: 'req-oversized-upload',
        from: 'mobile-1',
        to: 'desktop-client-1',
        channel: 'runtime',
        payload: {
          content_base64: 'c2VjcmV0LWJhc2U2NA==',
          name: 'too-large.png',
        },
      })
    )

    const result = await readMessage(mobile)
    expect(result).toEqual({
      type: 'relay_error',
      request_id: 'req-oversized-upload',
      from: 'desktop-client-1',
      to: 'mobile-1',
      channel: 'runtime',
      payload: {
        code: 'local_runtime_error',
        message: 'Local runtime request failed: /api/mobile/files (413)',
      },
    })
    expect(JSON.stringify(result)).not.toContain('c2VjcmV0LWJhc2U2NA')
    expect(JSON.stringify(result)).not.toContain('hive-mobile-files')
    expect(JSON.stringify(result)).not.toContain('HIVE_AGENT_TOKEN')

    desktop.close()
    mobile.close()
    await runtime.close()
  })

  test('proxies terminal websocket traffic through the connected desktop runtime', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const terminal = await openSocket(
      relay.wsUrl(
        '/ws/terminal/run-1/io?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token&clientId=mobile-terminal&mode=takeover'
      )
    )

    const [readyRaw] = (await once(terminal, 'message')) as [WebSocket.RawData]
    expect(readyRaw.toString()).toBe('terminal-ready')

    terminal.send('hello')

    const [echoRaw] = (await once(terminal, 'message')) as [WebSocket.RawData]
    expect(echoRaw.toString()).toBe('runtime:hello')

    terminal.close()
    desktop.close()
    await runtime.close()
  })

  test('preserves terminal control data sent before the local runtime websocket opens', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub({ terminalUpgradeDelayMs: 100 })
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const terminal = await openSocket(
      relay.wsUrl(
        '/ws/terminal/run-1/control?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token&clientId=mobile-terminal&mode=takeover&cols=48&rows=16'
      )
    )

    const restoreRequest = JSON.stringify({
      cols: 48,
      request_id: 'restore-before-open',
      rows: 16,
      scrollback: 20,
      type: 'restore_request',
    })
    const messages = readRawMessages(terminal, 2)
    terminal.send(restoreRequest)

    expect(await messages).toEqual(['terminal-ready', `runtime:${restoreRequest}`])

    terminal.close()
    desktop.close()
    await runtime.close()
  })

  test('flushes early control and io frames once in order without crossing proxies', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub({ terminalUpgradeDelayMs: 100 })
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const control = await openSocket(
      relay.wsUrl(
        '/ws/terminal/run-1/control?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token&clientId=mobile-control&mode=takeover'
      )
    )
    const io = await openSocket(
      relay.wsUrl(
        '/ws/terminal/run-1/io?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token&clientId=mobile-io&mode=takeover'
      )
    )
    const controlMessages = readRawMessages(control, 3)
    const ioMessages = readRawMessages(io, 3)

    control.send('control-1')
    io.send('io-1')
    control.send('control-2')
    io.send('io-2')

    expect(await controlMessages).toEqual([
      'terminal-ready',
      'runtime:control-1',
      'runtime:control-2',
    ])
    expect(await ioMessages).toEqual(['terminal-ready', 'runtime:io-1', 'runtime:io-2'])

    control.close()
    io.close()
    desktop.close()
    await runtime.close()
  })

  test('closes a terminal proxy when early input exceeds its bounded buffer', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub({ terminalUpgradeDelayMs: 300 })
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const terminal = await openSocket(
      relay.wsUrl(
        '/ws/terminal/run-1/io?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token&clientId=mobile-terminal&mode=takeover'
      )
    )
    const closed = once(terminal, 'close')

    for (let index = 0; index < 65; index += 1) terminal.send(`early-${index}`)

    const [code, reason] = (await closed) as [number, Buffer]
    expect(code).toBe(1009)
    expect(reason.toString()).toBe(
      'Terminal proxy input buffer exceeded while local runtime was connecting'
    )

    desktop.close()
    await runtime.close()
  })

  test('discards early input when the mobile terminal proxy closes before runtime setup', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub({ uiSessionDelayMs: 100 })
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const closingTerminal = await openSocket(
      relay.wsUrl(
        '/ws/terminal/run-1/io?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token&clientId=closing-terminal&mode=takeover'
      )
    )
    const closingTerminalClosed = once(closingTerminal, 'close')

    closingTerminal.send('discard-me')
    closingTerminal.close()
    await closingTerminalClosed

    const probeTerminal = await openSocket(
      relay.wsUrl(
        '/ws/terminal/run-1/io?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token&clientId=probe-terminal&mode=takeover'
      )
    )
    const probeMessages = readRawMessages(probeTerminal, 2)
    probeTerminal.send('probe')

    expect(await probeMessages).toEqual(['terminal-ready', 'runtime:probe'])
    expect(runtime.getTerminalRequests()).toEqual([
      '/ws/terminal/run-1/io?clientId=probe-terminal&mode=takeover',
    ])

    probeTerminal.close()
    desktop.close()
    await runtime.close()
  })

  test('proxies terminal control websocket traffic without forwarding relay credentials', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const terminal = await openSocket(
      relay.wsUrl(
        '/ws/terminal/run-1/control?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token&clientId=mobile-terminal&mode=takeover&cols=48&rows=16'
      )
    )

    const [readyRaw] = (await once(terminal, 'message')) as [WebSocket.RawData]
    expect(readyRaw.toString()).toBe('terminal-ready')
    expect(runtime.getTerminalRequests()).toEqual([
      '/ws/terminal/run-1/control?clientId=mobile-terminal&mode=takeover&cols=48&rows=16',
    ])

    terminal.send(
      JSON.stringify({
        type: 'takeover_request',
        cols: 48,
        restore_on_release: true,
        rows: 16,
      })
    )

    const [echoRaw] = (await once(terminal, 'message')) as [WebSocket.RawData]
    expect(echoRaw.toString()).toBe(
      'runtime:{"type":"takeover_request","cols":48,"restore_on_release":true,"rows":16}'
    )

    terminal.close()
    desktop.close()
    await runtime.close()
  })

  test('forwards terminal takeover release size owner changes back to the mobile socket', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub({
      handleTerminalMessage(socket, raw) {
        const message = JSON.parse(raw.toString()) as { type?: string }
        if (message.type === 'takeover_request') {
          socket.send(
            JSON.stringify({
              cols: 48,
              previousSize: { cols: 120, rows: 40 },
              rows: 16,
              type: 'takeover_granted',
            })
          )
          return
        }
        if (message.type === 'takeover_release') {
          socket.send(
            JSON.stringify({
              cols: 120,
              mode: 'active',
              ownerClientId: null,
              rows: 40,
              type: 'size_owner_changed',
            })
          )
        }
      },
    })
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const terminal = await openSocket(
      relay.wsUrl(
        '/ws/terminal/run-1/control?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token&clientId=mobile-terminal&mode=takeover&cols=48&rows=16'
      )
    )

    expect((await once(terminal, 'message'))[0].toString()).toBe('terminal-ready')
    terminal.send(
      JSON.stringify({
        type: 'takeover_request',
        cols: 48,
        restore_on_release: true,
        rows: 16,
      })
    )
    expect(
      await waitForMessageMatching(terminal, (message) => message.type === 'takeover_granted')
    ).toEqual({
      cols: 48,
      previousSize: { cols: 120, rows: 40 },
      rows: 16,
      type: 'takeover_granted',
    })
    terminal.send(JSON.stringify({ type: 'takeover_release' }))
    expect(
      await waitForMessageMatching(terminal, (message) => message.type === 'size_owner_changed')
    ).toEqual({
      cols: 120,
      mode: 'active',
      ownerClientId: null,
      rows: 40,
      type: 'size_owner_changed',
    })

    terminal.close()
    desktop.close()
    await runtime.close()
  })

  test('closes terminal proxy sockets when the desktop disconnects', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const terminal = await openSocket(
      relay.wsUrl(
        '/ws/terminal/run-1/io?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token&clientId=mobile-terminal&mode=takeover'
      )
    )
    await once(terminal, 'message')

    desktop.close()

    const [code, reason] = (await once(terminal, 'close')) as [number, Buffer]
    expect(code).toBe(1011)
    expect(reason.toString()).toBe('Desktop peer disconnected')
    await runtime.close()
  })

  test('closes terminal proxy sockets with a local runtime error when session setup fails', async () => {
    const relay = await startRelay()
    const runtime = await startBrokenRuntimeStub()
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const terminal = await openSocket(
      relay.wsUrl(
        '/ws/terminal/run-1/io?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token&clientId=mobile-terminal&mode=takeover'
      )
    )

    const [code, reason] = (await once(terminal, 'close')) as [number, Buffer]
    expect(code).toBe(1011)
    expect(reason.toString()).toContain('Local runtime session failed: 500')
    desktop.close()
    await runtime.close()
  })

  test('closes terminal proxy sockets when the local terminal websocket upgrade fails', async () => {
    const relay = await startRelay()
    const runtime = await startLocalRuntimeStub({
      rejectTerminalUpgradeStatus: 404,
      terminalUpgradeDelayMs: 100,
    })
    const desktop = openRelayDesktopSocket({
      deviceId: 'desktop-client-1',
      serverUrl: relay.baseUrl,
      token: 'test-token',
    })
    attachRelayDesktopHandlers(desktop, {
      deviceId: 'desktop-client-1',
      localRuntimeUrl: runtime.baseUrl,
    })
    await once(desktop, 'open')
    const terminal = await openSocket(
      relay.wsUrl(
        '/ws/terminal/missing-run/io?device_id=mobile-1&desktop_id=desktop-client-1&pairing_token=test-token&clientId=mobile-terminal&mode=takeover'
      )
    )
    const closed = once(terminal, 'close')

    terminal.send('input-before-upgrade-failure')

    const [code, reason] = (await closed) as [number, Buffer]
    expect(code).toBe(1011)
    expect(reason.toString()).toContain('Local terminal io websocket upgrade failed: 404')
    desktop.close()
    await runtime.close()
  })

  test('rejects websocket connections with an invalid development pairing token', async () => {
    const relay = await startRelay()
    const socket = new WebSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=wrong-token')
    )

    const [, response] = (await once(socket, 'unexpected-response')) as unknown as [
      unknown,
      { statusCode: number },
    ]

    expect(response.statusCode).toBe(401)
  })

  test('rejects websocket connections with invalid relay device ids', async () => {
    const relay = await startRelay()
    const overlongId = 'x'.repeat(MAX_RELAY_DEVICE_ID_LENGTH + 1)
    const invalidDesktop = new WebSocket(
      relay.wsUrl(`/ws/desktop?device_id=${overlongId}&pairing_token=test-token`)
    )
    const invalidMobile = new WebSocket(
      relay.wsUrl(`/ws/mobile?device_id=mobile-1&desktop_id=${overlongId}&pairing_token=test-token`)
    )

    const [, desktopResponse] = (await once(invalidDesktop, 'unexpected-response')) as unknown as [
      unknown,
      { statusCode: number },
    ]
    const [, mobileResponse] = (await once(invalidMobile, 'unexpected-response')) as unknown as [
      unknown,
      { statusCode: number },
    ]

    expect(desktopResponse.statusCode).toBe(400)
    expect(mobileResponse.statusCode).toBe(400)
  })

  test('forwards a mobile envelope to its paired desktop', async () => {
    const relay = await startRelay()
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=test-token')
    )
    const mobile = await openSocket(
      relay.wsUrl('/ws/mobile?device_id=mobile-1&desktop_id=desktop-1&pairing_token=test-token')
    )

    mobile.send(
      JSON.stringify({
        type: 'team_send',
        request_id: 'req-1',
        from: 'mobile-1',
        to: 'desktop-1',
        channel: 'team',
        payload: { text: 'hello' },
      })
    )

    expect(await readMessage(desktop)).toEqual({
      type: 'team_send',
      request_id: 'req-1',
      from: 'mobile-1',
      to: 'desktop-1',
      channel: 'team',
      payload: { text: 'hello' },
    })
    desktop.close()
    mobile.close()
  })

  test('forwards a team_note mobile action unchanged to its paired desktop', async () => {
    const relay = await startRelay()
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=test-token')
    )
    const mobile = await openSocket(
      relay.wsUrl('/ws/mobile?device_id=mobile-1&desktop_id=desktop-1&pairing_token=test-token')
    )
    const envelope = {
      channel: 'runtime',
      from: 'mobile-1',
      payload: {
        action_id: 'team-note-relay-1',
        kind: 'team_note',
        payload: { artifacts: ['context.md'], text: 'Supplemental context.' },
        target: { dispatch_id: 'dispatch-1' },
        workspace_id: 'workspace-1',
      },
      request_id: 'req-team-note',
      to: 'desktop-1',
      type: 'mobile_action',
    }

    mobile.send(JSON.stringify(envelope))

    expect(await readMessage(desktop)).toEqual(envelope)
    desktop.close()
    mobile.close()
  })

  test('keeps duplicate mobile device sockets alive and routes replies by request id', async () => {
    const relay = await startRelay()
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=test-token')
    )
    const firstMobile = await openSocket(
      relay.wsUrl('/ws/mobile?device_id=mobile-1&desktop_id=desktop-1&pairing_token=test-token')
    )
    const secondMobile = await openSocket(
      relay.wsUrl('/ws/mobile?device_id=mobile-1&desktop_id=desktop-1&pairing_token=test-token')
    )

    const desktopRequests = readMessages(desktop, 2)
    firstMobile.send(
      JSON.stringify({
        channel: 'runtime',
        from: 'mobile-1',
        payload: { workspace_id: 'workspace-1' },
        request_id: 'req-first-mobile',
        to: 'desktop-1',
        type: 'list_agents_and_runs',
      })
    )
    secondMobile.send(
      JSON.stringify({
        channel: 'runtime',
        from: 'mobile-1',
        payload: { workspace_id: 'workspace-1' },
        request_id: 'req-second-mobile',
        to: 'desktop-1',
        type: 'list_agents_and_runs',
      })
    )

    await desktopRequests
    desktop.send(
      JSON.stringify({
        channel: 'runtime',
        from: 'desktop-1',
        payload: { ok: 'first' },
        request_id: 'req-first-mobile',
        to: 'mobile-1',
        type: 'list_agents_and_runs_result',
      })
    )
    desktop.send(
      JSON.stringify({
        channel: 'runtime',
        from: 'desktop-1',
        payload: { ok: 'second' },
        request_id: 'req-second-mobile',
        to: 'mobile-1',
        type: 'list_agents_and_runs_result',
      })
    )

    expect(await readMessage(firstMobile)).toMatchObject({
      payload: { ok: 'first' },
      request_id: 'req-first-mobile',
    })
    expect(await readMessage(secondMobile)).toMatchObject({
      payload: { ok: 'second' },
      request_id: 'req-second-mobile',
    })

    desktop.close()
    firstMobile.close()
    secondMobile.close()
  })

  test('rejects unknown mobile relay channels before forwarding to desktop', async () => {
    const relay = await startRelay()
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=test-token')
    )
    const mobile = await openSocket(
      relay.wsUrl('/ws/mobile?device_id=mobile-1&desktop_id=desktop-1&pairing_token=test-token')
    )

    mobile.send(
      JSON.stringify({
        type: 'run_plugin',
        request_id: 'req-unknown-mobile-channel',
        from: 'mobile-1',
        to: 'desktop-1',
        channel: 'plugin',
        payload: { text: 'hello' },
      })
    )

    expect(await readMessage(mobile)).toEqual({
      type: 'relay_error',
      request_id: 'req-unknown-mobile-channel',
      from: 'relay',
      to: 'mobile-1',
      channel: 'plugin',
      payload: {
        code: 'unknown_channel',
        desktop_id: 'desktop-1',
        message: 'Relay channel is not supported: plugin',
      },
    })
    await expectNoRelayMessage(desktop)
    desktop.close()
    mobile.close()
  })

  test('rejects mobile relay messages without request ids before forwarding to desktop', async () => {
    const relay = await startRelay()
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=test-token')
    )
    const mobile = await openSocket(
      relay.wsUrl('/ws/mobile?device_id=mobile-1&desktop_id=desktop-1&pairing_token=test-token')
    )

    mobile.send(
      JSON.stringify({
        type: 'team_send',
        from: 'mobile-1',
        to: 'desktop-1',
        channel: 'team',
        payload: { text: 'hello' },
      })
    )

    expect(await readMessage(mobile)).toEqual({
      type: 'relay_error',
      from: 'relay',
      to: 'mobile-1',
      channel: 'team',
      payload: {
        code: 'missing_request_id',
        desktop_id: 'desktop-1',
        message: 'Relay envelope request_id is required',
      },
    })
    await expectNoRelayMessage(desktop)
    desktop.close()
    mobile.close()
  })

  test('rejects unknown desktop relay channels before forwarding to mobile', async () => {
    const relay = await startRelay()
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=test-token')
    )
    const mobile = await openSocket(
      relay.wsUrl('/ws/mobile?device_id=mobile-1&desktop_id=desktop-1&pairing_token=test-token')
    )

    desktop.send(
      JSON.stringify({
        type: 'plugin_result',
        request_id: 'req-unknown-desktop-channel',
        from: 'desktop-1',
        to: 'mobile-1',
        channel: 'plugin',
        payload: { ok: true },
      })
    )

    expect(await readMessage(desktop)).toEqual({
      type: 'relay_error',
      request_id: 'req-unknown-desktop-channel',
      from: 'relay',
      to: 'desktop-1',
      channel: 'plugin',
      payload: {
        code: 'unknown_channel',
        message: 'Relay channel is not supported: plugin',
      },
    })
    await expectNoRelayMessage(mobile)
    desktop.close()
    mobile.close()
  })

  test('rejects desktop relay messages without request ids before forwarding to mobile', async () => {
    const relay = await startRelay()
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=test-token')
    )
    const mobile = await openSocket(
      relay.wsUrl('/ws/mobile?device_id=mobile-1&desktop_id=desktop-1&pairing_token=test-token')
    )

    desktop.send(
      JSON.stringify({
        type: 'team_result',
        from: 'desktop-1',
        to: 'mobile-1',
        channel: 'team',
        payload: { ok: true },
      })
    )

    expect(await readMessage(desktop)).toEqual({
      type: 'relay_error',
      from: 'relay',
      to: 'desktop-1',
      channel: 'team',
      payload: {
        code: 'missing_request_id',
        message: 'Relay envelope request_id is required',
      },
    })
    await expectNoRelayMessage(mobile)
    desktop.close()
    mobile.close()
  })

  test('updates mobile last seen time from forwarded messages', async () => {
    const relay = await startRelay()
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=test-token')
    )
    const mobile = await openSocket(
      relay.wsUrl('/ws/mobile?device_id=mobile-1&desktop_id=desktop-1&pairing_token=test-token')
    )
    const readMobile = async () => {
      const response = await fetch(`${relay.baseUrl}/devices`, {
        headers: { authorization: 'Bearer test-token' },
      })
      const body = (await response.json()) as {
        mobiles: Array<{ connected_at: number; last_seen_at: number }>
      }
      const current = body.mobiles[0]
      if (!current) throw new Error('Expected mobile snapshot')
      return current
    }
    const before = await readMobile()
    await new Promise((resolve) => setTimeout(resolve, 5))

    mobile.send(
      JSON.stringify({
        channel: 'team',
        from: 'mobile-1',
        payload: { text: 'hello' },
        request_id: 'req-last-seen',
        to: 'desktop-1',
        type: 'team_send',
      })
    )
    await readMessage(desktop)
    const after = await readMobile()

    expect(after.connected_at).toBe(before.connected_at)
    expect(after.last_seen_at).toBeGreaterThan(before.last_seen_at)
    desktop.close()
    mobile.close()
  })

  test('heartbeat removes stale desktop sockets and dependent mobile sockets', async () => {
    const relay = await startRelay({ heartbeatIntervalMs: 10, heartbeatTimeoutMs: 20 })
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=test-token')
    )
    const mobile = await openSocket(
      relay.wsUrl('/ws/mobile?device_id=mobile-1&desktop_id=desktop-1&pairing_token=test-token')
    )
    await waitForDeviceCounts(relay, { desktops: 1, mobiles: 1 })

    pauseUnderlyingSocket(desktop)

    await waitForDeviceCounts(relay, { desktops: 0, mobiles: 0 })
    desktop.terminate()
    mobile.terminate()
  })

  test('desktop disconnect closes dependent mobile sockets and clears device state', async () => {
    const relay = await startRelay()
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=test-token')
    )
    const mobile = await openSocket(
      relay.wsUrl('/ws/mobile?device_id=mobile-1&desktop_id=desktop-1&pairing_token=test-token')
    )
    await waitForDeviceCounts(relay, { desktops: 1, mobiles: 1 })

    desktop.close()

    const [code, reason] = (await once(mobile, 'close')) as [number, Buffer]
    expect(code).toBe(1011)
    expect(reason.toString()).toBe('Desktop peer disconnected')
    await waitForDeviceCounts(relay, { desktops: 0, mobiles: 0 })
  })

  test('heartbeat removes stale mobile sockets without dropping the desktop', async () => {
    const relay = await startRelay({ heartbeatIntervalMs: 10, heartbeatTimeoutMs: 20 })
    const desktop = await openSocket(
      relay.wsUrl('/ws/desktop?device_id=desktop-1&pairing_token=test-token')
    )
    const mobile = await openSocket(
      relay.wsUrl('/ws/mobile?device_id=mobile-1&desktop_id=desktop-1&pairing_token=test-token')
    )
    await waitForDeviceCounts(relay, { desktops: 1, mobiles: 1 })

    pauseUnderlyingSocket(mobile)

    await waitForDeviceCounts(relay, { desktops: 1, mobiles: 0 })
    desktop.terminate()
    mobile.terminate()
  })

  test('returns desktop_offline when mobile sends without a connected desktop', async () => {
    const relay = await startRelay()
    const mobile = await openSocket(
      relay.wsUrl(
        '/ws/mobile?device_id=mobile-1&desktop_id=desktop-missing&pairing_token=test-token'
      )
    )

    mobile.send(
      JSON.stringify({
        type: 'team_send',
        request_id: 'req-offline',
        from: 'mobile-1',
        to: 'desktop-missing',
        channel: 'team',
        payload: { text: 'hello' },
      })
    )

    expect(await readMessage(mobile)).toEqual({
      type: 'relay_error',
      request_id: 'req-offline',
      from: 'relay',
      to: 'mobile-1',
      channel: 'team',
      payload: {
        code: 'desktop_offline',
        desktop_id: 'desktop-missing',
        message: 'Desktop peer is offline',
      },
    })
    mobile.close()
  })
})
