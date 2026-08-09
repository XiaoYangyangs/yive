// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  claimRelayPairingToken,
  createRelayPairingToken,
  getRelayHealth,
  isRelayHttpProtocolSupported,
  listRelayDevices,
  listRelayPairedDevices,
  normalizeRelayServerUrl,
  type RelayEnvelope,
  RelayMobileClient,
  type RelayRuntimeError,
  type RelayWebSocketConstructor,
  revokeRelayPairedDevice,
  toRelayMobileWebSocketUrl,
} from '../../web/src/relay-api.js'

class MockRelayWebSocket {
  static OPEN = 1
  readonly OPEN = 1
  static instances: MockRelayWebSocket[] = []
  static nextSendError: Error | null = null

  readyState = 0
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  constructor(readonly url: string) {
    MockRelayWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string): void {
    if (MockRelayWebSocket.nextSendError) {
      const error = MockRelayWebSocket.nextSendError
      MockRelayWebSocket.nextSendError = null
      throw error
    }
    this.sent.push(data)
  }

  close(reason = ''): void {
    this.readyState = 3
    this.dispatch(
      'close',
      new CloseEvent('close', {
        reason,
      })
    )
  }

  open(): void {
    this.readyState = MockRelayWebSocket.OPEN
    this.dispatch('open', new Event('open'))
  }

  receive(envelope: RelayEnvelope): void {
    this.dispatch('message', new MessageEvent('message', { data: JSON.stringify(envelope) }))
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const getFirstRelaySocket = (): MockRelayWebSocket => {
  const socket = MockRelayWebSocket.instances[0]
  if (!socket) throw new Error('Expected a relay websocket')
  return socket
}

const readSentRelayEnvelope = (socket: MockRelayWebSocket): RelayEnvelope => {
  const sent = socket.sent[0]
  if (!sent) throw new Error('Expected a sent relay envelope')
  return JSON.parse(sent) as RelayEnvelope
}

const getRequestId = (envelope: RelayEnvelope): string => {
  if (!envelope.request_id) throw new Error('Expected request_id')
  return envelope.request_id
}

const MockRelayWebSocketConstructor = MockRelayWebSocket as unknown as RelayWebSocketConstructor

afterEach(() => {
  MockRelayWebSocket.instances = []
  MockRelayWebSocket.nextSendError = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('relay browser api', () => {
  test('normalizes relay server URLs for browser clients', () => {
    expect(normalizeRelayServerUrl(undefined)).toBeUndefined()
    expect(normalizeRelayServerUrl('relay.example')).toBe('https://relay.example')
    expect(normalizeRelayServerUrl('relay.example.com')).toBe('https://relay.example.com')
    expect(normalizeRelayServerUrl('203.0.113.10:3001')).toBe('http://203.0.113.10:3001')
    expect(normalizeRelayServerUrl('localhost:3001')).toBe('http://localhost:3001')
    expect(normalizeRelayServerUrl('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001')
  })

  test('loads relay health over HTTP', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('https://relay.example/health')
        expect(init).toMatchObject({ cache: 'no-store' })
        return Response.json({
          desktop_count: 1,
          deployment: {
            public_url_configured: true,
          },
          features: [
            'mobile_confirmations',
            'mobile_events',
            'mobile_file_exchange',
            'terminal_proxy',
          ],
          heartbeat_interval_ms: 30000,
          heartbeat_timeout_ms: 75000,
          mobile_count: 2,
          ok: true,
          pairing_store: {
            admin_token_default: true,
            device_token_count: 3,
            issued_token_count: 1,
            persistent: true,
            require_desktop_binding: true,
          },
          protocol_version: 1,
          service: 'hive-relay',
          started_at: 1_700_000_000,
          static: { mobile_app_available: true },
          terminal_proxy_count: 4,
          uptime_ms: 12_345,
          version: '1.4.0',
        })
      })
    )

    await expect(getRelayHealth({ serverUrl: 'https://relay.example' })).resolves.toEqual({
      desktop_count: 1,
      deployment: {
        public_url_configured: true,
      },
      features: ['mobile_confirmations', 'mobile_events', 'mobile_file_exchange', 'terminal_proxy'],
      heartbeat_interval_ms: 30000,
      heartbeat_timeout_ms: 75000,
      mobile_count: 2,
      ok: true,
      pairing_store: {
        admin_token_default: true,
        device_token_count: 3,
        issued_token_count: 1,
        persistent: true,
        require_desktop_binding: true,
      },
      protocol_version: 1,
      service: 'hive-relay',
      started_at: 1_700_000_000,
      static: { mobile_app_available: true },
      terminal_proxy_count: 4,
      uptime_ms: 12_345,
      version: '1.4.0',
    })
  })

  test('normalizes bare relay domains for HTTP requests', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return Response.json({
          desktop_count: 0,
          mobile_count: 0,
          ok: true,
          service: 'hive-relay',
        })
      })
    )

    await expect(getRelayHealth({ serverUrl: 'relay.example' })).resolves.toMatchObject({
      ok: true,
      service: 'hive-relay',
    })

    expect(calls).toEqual(['https://relay.example/health'])
  })

  test('normalizes IP relay addresses to HTTP for HTTP requests', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return Response.json({
          desktop_count: 0,
          mobile_count: 0,
          ok: true,
          service: 'hive-relay',
        })
      })
    )

    await getRelayHealth({ serverUrl: '203.0.113.10:3001' })

    expect(calls).toEqual(['http://203.0.113.10:3001/health'])
  })

  test('times out hanging relay HTTP requests and allows a later retry', async () => {
    vi.useFakeTimers()
    let attempts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempts += 1
        if (attempts === 1) {
          return await new Promise<Response>(() => {})
        }
        return Response.json({
          desktop_count: 0,
          mobile_count: 0,
          ok: true,
          service: 'hive-relay',
        })
      })
    )

    const timedOut = getRelayHealth({
      requestTimeoutMs: 25,
      serverUrl: 'https://relay.example',
    })
    const rejection = expect(timedOut).rejects.toThrow('Relay HTTP request timed out: /health')
    await vi.advanceTimersByTimeAsync(25)
    await rejection

    await expect(
      getRelayHealth({ requestTimeoutMs: 25, serverUrl: 'https://relay.example' })
    ).resolves.toMatchObject({
      ok: true,
      service: 'hive-relay',
    })
  })

  test('rejects malformed relay health snapshots', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, service: 'hive-relay' }))
    )

    await expect(getRelayHealth({ serverUrl: 'https://relay.example' })).rejects.toThrow(
      'Invalid relay health response: ok=true, service=hive-relay, desktop_count, and mobile_count are required'
    )
  })

  test('rejects health snapshots from non-relay services', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          desktop_count: 0,
          mobile_count: 0,
          ok: true,
          service: 'other-service',
        })
      )
    )

    await expect(getRelayHealth({ serverUrl: 'https://relay.example' })).rejects.toThrow(
      'Invalid relay health response: ok=true, service=hive-relay, desktop_count, and mobile_count are required'
    )
  })

  test('classifies relay HTTP protocol compatibility', () => {
    expect(
      isRelayHttpProtocolSupported({
        desktop_count: 0,
        mobile_count: 0,
        ok: true,
        service: 'hive-relay',
      })
    ).toBe(true)
    expect(
      isRelayHttpProtocolSupported({
        desktop_count: 0,
        mobile_count: 0,
        ok: true,
        protocol_version: 1,
        service: 'hive-relay',
      })
    ).toBe(true)
    expect(
      isRelayHttpProtocolSupported({
        desktop_count: 0,
        mobile_count: 0,
        ok: true,
        protocol_version: 2,
        service: 'hive-relay',
      })
    ).toBe(true)
    expect(
      isRelayHttpProtocolSupported({
        desktop_count: 0,
        mobile_count: 0,
        ok: true,
        protocol_version: 3,
        service: 'hive-relay',
      })
    ).toBe(false)
  })

  test('lists relay devices over HTTP', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('https://relay.example/devices')
        expect(init).toMatchObject({
          cache: 'no-store',
          headers: { authorization: 'Bearer device-token' },
        })
        return Response.json({
          desktops: [
            {
              connected_at: 1_699_999_000,
              device_id: 'desktop-1',
              features: [
                'mobile_confirmations',
                'mobile_events',
                'mobile_file_exchange',
                'terminal_proxy',
              ],
              last_seen_at: 1_700_000_500,
              runtime_message: 'ready',
              runtime_status: 'online',
              runtime_updated_at: 1_700_000_000,
            },
          ],
          mobiles: [
            {
              connected_at: 1_699_999_500,
              desktop_id: 'desktop-1',
              device_id: 'mobile-1',
              last_seen_at: 1_700_000_600,
            },
          ],
        })
      })
    )

    await expect(
      listRelayDevices({ serverUrl: 'https://relay.example', token: 'device-token' })
    ).resolves.toEqual({
      desktops: [
        {
          connected_at: 1_699_999_000,
          device_id: 'desktop-1',
          features: [
            'mobile_confirmations',
            'mobile_events',
            'mobile_file_exchange',
            'terminal_proxy',
          ],
          last_seen_at: 1_700_000_500,
          runtime_message: 'ready',
          runtime_status: 'online',
          runtime_updated_at: 1_700_000_000,
        },
      ],
      mobiles: [
        {
          connected_at: 1_699_999_500,
          desktop_id: 'desktop-1',
          device_id: 'mobile-1',
          last_seen_at: 1_700_000_600,
        },
      ],
    })
  })

  test('rejects malformed relay device snapshots', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ desktops: [{ id: 'bad' }] }))
    )

    await expect(
      listRelayDevices({ serverUrl: 'https://relay.example', token: 'device-token' })
    ).rejects.toThrow('Invalid relay devices response: desktops and mobiles must be arrays')
  })

  test('rejects malformed relay desktop runtime status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'broken' }],
          mobiles: [],
        })
      )
    )

    await expect(
      listRelayDevices({ serverUrl: 'https://relay.example', token: 'device-token' })
    ).rejects.toThrow('Invalid relay devices response: desktop runtime_status is invalid')
  })

  test('claims a short pairing token for a persistent device token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('https://relay.example/pairings/claim')
        expect(init).toMatchObject({
          body: JSON.stringify({
            desktop_id: 'desktop-1',
            device_id: 'phone-1',
            device_kind: 'mobile',
            token: 'short-token',
            workspace_ids: ['workspace-alpha'],
          }),
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
        return Response.json(
          {
            desktop_id: 'desktop-1',
            device_id: 'phone-1',
            device_kind: 'mobile',
            token: 'device-token',
            workspace_ids: ['workspace-alpha'],
          },
          { status: 201 }
        )
      })
    )

    await expect(
      claimRelayPairingToken({
        desktopId: 'desktop-1',
        deviceKind: 'mobile',
        deviceId: 'phone-1',
        serverUrl: 'https://relay.example',
        token: 'short-token',
        workspaceIds: ['workspace-alpha'],
      })
    ).resolves.toEqual({
      desktop_id: 'desktop-1',
      device_id: 'phone-1',
      device_kind: 'mobile',
      token: 'device-token',
      workspace_ids: ['workspace-alpha'],
    })
  })

  test('rejects malformed relay pairing claim responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ device_id: 'phone-1' }))
    )

    await expect(
      claimRelayPairingToken({
        deviceId: 'phone-1',
        serverUrl: 'https://relay.example',
        token: 'short-token',
      })
    ).rejects.toThrow('Invalid relay pairing response: device_id and token are required')
  })

  test('creates a short relay pairing token with an admin token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('https://relay.example/pairings')
        expect(init).toMatchObject({
          cache: 'no-store',
          headers: { authorization: 'Bearer admin-token' },
          method: 'POST',
        })
        return Response.json(
          { expires_at: 1_780_000_600_000, token: 'short-token', ttl_ms: 600_000 },
          { status: 201 }
        )
      })
    )

    await expect(
      createRelayPairingToken({
        adminToken: 'admin-token',
        serverUrl: 'https://relay.example',
      })
    ).resolves.toEqual({
      expires_at: 1_780_000_600_000,
      token: 'short-token',
      ttl_ms: 600_000,
    })
  })

  test('keeps relay pairing token metadata optional for older relays', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ token: 'short-token' }, { status: 201 }))
    )

    await expect(
      createRelayPairingToken({
        adminToken: 'admin-token',
        serverUrl: 'https://relay.example',
      })
    ).resolves.toEqual({ token: 'short-token' })
  })

  test('rejects malformed relay pairing token responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}))
    )

    await expect(
      createRelayPairingToken({
        adminToken: 'admin-token',
        serverUrl: 'https://relay.example',
      })
    ).rejects.toThrow('Invalid relay pairing token response: token is required')
  })

  test('lists paired relay devices with an admin token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('https://relay.example/pairings/devices')
        expect(init).toMatchObject({
          cache: 'no-store',
          headers: { authorization: 'Bearer admin-token' },
        })
        return Response.json({
          devices: [{ desktop_id: 'desktop-1', device_id: 'phone-1', token_hint: 'abc123...wxyz' }],
        })
      })
    )

    await expect(
      listRelayPairedDevices({
        adminToken: 'admin-token',
        serverUrl: 'https://relay.example',
      })
    ).resolves.toEqual({
      devices: [{ desktop_id: 'desktop-1', device_id: 'phone-1', token_hint: 'abc123...wxyz' }],
    })
  })

  test('rejects malformed paired device lists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ devices: [{ device_id: 123 }] }))
    )

    await expect(
      listRelayPairedDevices({
        adminToken: 'admin-token',
        serverUrl: 'https://relay.example',
      })
    ).rejects.toThrow(
      'Invalid relay paired devices response: device_id and token_hint are required'
    )
  })

  test('revokes a paired relay device with an admin token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('https://relay.example/pairings/devices/phone%201')
        expect(init).toMatchObject({
          cache: 'no-store',
          headers: { authorization: 'Bearer admin-token' },
          method: 'DELETE',
        })
        return Response.json({ device_id: 'phone 1', revoked: true })
      })
    )

    await expect(
      revokeRelayPairedDevice({
        adminToken: 'admin-token',
        deviceId: 'phone 1',
        serverUrl: 'https://relay.example',
      })
    ).resolves.toEqual({ device_id: 'phone 1', revoked: true })
  })

  test('rejects malformed paired device revoke responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ device_id: 'phone-1' }))
    )

    await expect(
      revokeRelayPairedDevice({
        adminToken: 'admin-token',
        deviceId: 'phone-1',
        serverUrl: 'https://relay.example',
      })
    ).rejects.toThrow('Invalid relay revoke response: device_id and revoked=true are required')
  })

  test('builds the mobile websocket URL for a relay server', () => {
    const url = new URL(
      toRelayMobileWebSocketUrl({
        desktopId: 'desktop-1',
        deviceId: 'mobile-1',
        serverUrl: 'https://relay.example',
        token: 'pair-token',
      })
    )

    expect(url.protocol).toBe('wss:')
    expect(url.host).toBe('relay.example')
    expect(url.pathname).toBe('/ws/mobile')
    expect(url.searchParams.get('desktop_id')).toBe('desktop-1')
    expect(url.searchParams.get('device_id')).toBe('mobile-1')
    expect(url.searchParams.get('pairing_token')).toBe('pair-token')
  })

  test('normalizes bare relay domains for mobile websocket URLs', () => {
    const url = new URL(
      toRelayMobileWebSocketUrl({
        desktopId: 'desktop-1',
        deviceId: 'mobile-1',
        serverUrl: 'relay.example',
        token: 'pair-token',
      })
    )

    expect(url.protocol).toBe('wss:')
    expect(url.host).toBe('relay.example')
    expect(url.pathname).toBe('/ws/mobile')
  })

  test('requests agents and runs through the paired desktop socket', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const response = client.listAgentsAndRuns('workspace-1')
    await Promise.resolve()
    const sent = readSentRelayEnvelope(socket)
    expect(sent).toMatchObject({
      channel: 'runtime',
      from: 'mobile-1',
      payload: { workspace_id: 'workspace-1' },
      to: 'desktop-1',
      type: 'list_agents_and_runs',
    })

    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: {
        agents: [
          {
            active_dispatch_id: 'dispatch-1',
            conversation_activity: 'unknown',
            provider: 'codex',
            id: 'agent-1',
            last_observed_at: 1_754_360_000_000,
            last_pty_line: 'ready',
            name: 'Coder',
            kind: 'worker',
            process_state: 'crashed',
            queue_pause_reason: 'worker_crashed',
            queued_dispatch_count: 0,
          },
        ],
        runs: [],
        workspace_id: 'workspace-1',
      },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'list_agents_and_runs_result',
    })

    await expect(response).resolves.toEqual({
      agents: [
        {
          active_dispatch_id: 'dispatch-1',
          conversation_activity: 'unknown',
          provider: 'codex',
          id: 'agent-1',
          last_observed_at: 1_754_360_000_000,
          last_pty_line: 'ready',
          name: 'Coder',
          kind: 'worker',
          process_state: 'crashed',
          queue_pause_reason: 'worker_crashed',
          queued_dispatch_count: 0,
        },
      ],
      runs: [],
      workspace_id: 'workspace-1',
    })
  })

  test('reconnects the mobile relay socket before requests after a disconnect', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const firstSocket = getFirstRelaySocket()
    firstSocket.open()
    await connected
    firstSocket.close()

    const response = client.listWorkspaces()
    const secondSocket = MockRelayWebSocket.instances[1]
    if (!secondSocket) throw new Error('Expected reconnect websocket')
    secondSocket.open()
    await Promise.resolve()

    const sent = readSentRelayEnvelope(secondSocket)
    expect(sent).toMatchObject({
      channel: 'runtime',
      from: 'mobile-1',
      payload: {},
      to: 'desktop-1',
      type: 'list_workspaces',
    })

    secondSocket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: {
        workspaces: [{ id: 'workspace-1', name: 'Relay Workspace', path: '/work/relay' }],
      },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'list_workspaces_result',
    })

    await expect(response).resolves.toEqual([
      { id: 'workspace-1', name: 'Relay Workspace', path: '/work/relay' },
    ])
  })

  test('includes relay socket close reasons while requests are pending', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const response = client.listWorkspaces()
    await Promise.resolve()
    const sent = readSentRelayEnvelope(socket)
    expect(sent).toMatchObject({
      channel: 'runtime',
      from: 'mobile-1',
      to: 'desktop-1',
      type: 'list_workspaces',
    })

    socket.close('Desktop peer disconnected')

    await expect(response).rejects.toThrow(
      `Relay socket closed before response: ${getRequestId(sent)}: Desktop peer disconnected`
    )
  })

  test('recovers future requests after a pending relay request is interrupted', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const firstSocket = getFirstRelaySocket()
    firstSocket.open()
    await connected

    const interrupted = client.listWorkspaces()
    await Promise.resolve()
    const interruptedEnvelope = readSentRelayEnvelope(firstSocket)
    firstSocket.close('network changed')

    await expect(interrupted).rejects.toThrow(
      `Relay socket closed before response: ${getRequestId(interruptedEnvelope)}: network changed`
    )

    const recovered = client.listWorkspaces()
    const secondSocket = MockRelayWebSocket.instances[1]
    if (!secondSocket) throw new Error('Expected reconnect websocket after interrupted request')
    secondSocket.open()
    await Promise.resolve()
    const recoveredEnvelope = readSentRelayEnvelope(secondSocket)
    expect(recoveredEnvelope).toMatchObject({
      channel: 'runtime',
      from: 'mobile-1',
      payload: {},
      to: 'desktop-1',
      type: 'list_workspaces',
    })

    secondSocket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: {
        workspaces: [{ id: 'workspace-1', name: 'Recovered Relay', path: '/work/recovered' }],
      },
      request_id: getRequestId(recoveredEnvelope),
      to: 'mobile-1',
      type: 'list_workspaces_result',
    })

    await expect(recovered).resolves.toEqual([
      { id: 'workspace-1', name: 'Recovered Relay', path: '/work/recovered' },
    ])
  })

  test('resubscribes mobile events after the relay mobile socket reconnects', async () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const onSnapshot = vi.fn()
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      mobileEventsReconnectDelayMs: 25,
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })

    const subscription = client.subscribeMobileEvents({ onClose, onSnapshot })
    const firstSocket = getFirstRelaySocket()
    firstSocket.open()
    await Promise.resolve()
    const firstSubscribe = readSentRelayEnvelope(firstSocket)
    expect(firstSubscribe).toMatchObject({
      channel: 'mobile_events',
      from: 'mobile-1',
      payload: { subscription_id: firstSubscribe.request_id },
      to: 'desktop-1',
      type: 'subscribe_mobile_events',
    })

    firstSocket.close('network changed')
    expect(onClose).toHaveBeenCalledWith('Relay mobile socket closed: network changed', {
      attempt: 1,
      nextDelayMs: 25,
    })
    expect(MockRelayWebSocket.instances).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(25)
    const secondSocket = MockRelayWebSocket.instances[1]
    if (!secondSocket) throw new Error('Expected mobile events reconnect websocket')
    secondSocket.open()
    await Promise.resolve()
    const secondSubscribe = readSentRelayEnvelope(secondSocket)
    expect(secondSubscribe).toMatchObject({
      channel: 'mobile_events',
      from: 'mobile-1',
      payload: { subscription_id: firstSubscribe.request_id },
      request_id: firstSubscribe.request_id,
      to: 'desktop-1',
      type: 'subscribe_mobile_events',
    })

    secondSocket.receive({
      channel: 'mobile_events',
      from: 'desktop-1',
      payload: {
        snapshot: {
          active_workspace: null,
          active_workspace_id: null,
          connection: {},
          generated_at: 1,
          workspaces: [],
        },
        type: 'mobile-snapshot',
      },
      request_id: getRequestId(secondSubscribe),
      to: 'mobile-1',
      type: 'mobile_events_message',
    })

    expect(onSnapshot).toHaveBeenCalledWith({
      active_workspace: null,
      active_workspace_id: null,
      connection: {},
      generated_at: 1,
      workspaces: [],
    })
    subscription.dispose()
  })

  test('resets mobile events reconnect backoff after the relay socket reopens', async () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      mobileEventsReconnectDelayMs: 25,
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })

    const subscription = client.subscribeMobileEvents({ onClose, onSnapshot: vi.fn() })
    const firstSocket = getFirstRelaySocket()
    firstSocket.open()
    await Promise.resolve()
    firstSocket.close('network changed')
    expect(onClose).toHaveBeenLastCalledWith('Relay mobile socket closed: network changed', {
      attempt: 1,
      nextDelayMs: 25,
    })

    await vi.advanceTimersByTimeAsync(25)
    const secondSocket = MockRelayWebSocket.instances[1]
    if (!secondSocket) throw new Error('Expected mobile events reconnect websocket')
    secondSocket.open()
    await Promise.resolve()
    secondSocket.close('network changed again')

    expect(onClose).toHaveBeenLastCalledWith('Relay mobile socket closed: network changed again', {
      attempt: 1,
      nextDelayMs: 25,
    })
    subscription.dispose()
  })

  test('resubscribes mobile events when the desktop runtime events proxy closes', async () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const onSnapshot = vi.fn()
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      mobileEventsReconnectDelayMs: 25,
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })

    const subscription = client.subscribeMobileEvents({ onClose, onSnapshot })
    const socket = getFirstRelaySocket()
    socket.open()
    await Promise.resolve()
    const firstSubscribe = readSentRelayEnvelope(socket)

    socket.receive({
      channel: 'mobile_events',
      from: 'desktop-1',
      payload: {
        code: 1011,
        reason: 'Local mobile events websocket closed',
        subscription_id: firstSubscribe.request_id,
      },
      request_id: getRequestId(firstSubscribe),
      to: 'mobile-1',
      type: 'mobile_events_close',
    })

    expect(onClose).toHaveBeenCalledWith('Local mobile events websocket closed', {
      attempt: 1,
      nextDelayMs: 25,
    })
    await vi.advanceTimersByTimeAsync(25)

    const secondSubscribe = JSON.parse(socket.sent[1] ?? '') as RelayEnvelope
    expect(secondSubscribe).toMatchObject({
      channel: 'mobile_events',
      from: 'mobile-1',
      payload: { subscription_id: firstSubscribe.request_id },
      request_id: firstSubscribe.request_id,
      to: 'desktop-1',
      type: 'subscribe_mobile_events',
    })

    socket.receive({
      channel: 'mobile_events',
      from: 'desktop-1',
      payload: {
        snapshot: {
          active_workspace: null,
          active_workspace_id: null,
          connection: {},
          generated_at: 2,
          workspaces: [],
        },
        type: 'mobile-snapshot',
      },
      request_id: getRequestId(secondSubscribe),
      to: 'mobile-1',
      type: 'mobile_events_message',
    })

    expect(onSnapshot).toHaveBeenCalledWith({
      active_workspace: null,
      active_workspace_id: null,
      connection: {},
      generated_at: 2,
      workspaces: [],
    })
    socket.receive({
      channel: 'mobile_events',
      from: 'desktop-1',
      payload: {
        code: 1011,
        reason: 'Local mobile events websocket closed again',
        subscription_id: firstSubscribe.request_id,
      },
      request_id: getRequestId(firstSubscribe),
      to: 'mobile-1',
      type: 'mobile_events_close',
    })
    expect(onClose).toHaveBeenLastCalledWith('Local mobile events websocket closed again', {
      attempt: 1,
      nextDelayMs: 25,
    })
    subscription.dispose()
  })

  test('reconnects mobile events when subscribe send fails on an open socket', async () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const onError = vi.fn()
    const onSnapshot = vi.fn()
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      mobileEventsReconnectDelayMs: 25,
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })

    MockRelayWebSocket.nextSendError = new Error('socket write failed')
    const subscription = client.subscribeMobileEvents({ onClose, onError, onSnapshot })
    const firstSocket = getFirstRelaySocket()
    firstSocket.open()
    await Promise.resolve()

    expect(firstSocket.readyState).toBe(3)
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Relay mobile events send failed: socket write failed' })
    )
    expect(onClose).toHaveBeenCalledWith('Relay mobile socket closed', undefined)

    await vi.advanceTimersByTimeAsync(25)
    const secondSocket = MockRelayWebSocket.instances[1]
    if (!secondSocket) throw new Error('Expected mobile events reconnect after send failure')
    secondSocket.open()
    await Promise.resolve()
    const secondSubscribe = readSentRelayEnvelope(secondSocket)
    expect(secondSubscribe).toMatchObject({
      channel: 'mobile_events',
      from: 'mobile-1',
      payload: { subscription_id: secondSubscribe.request_id },
      to: 'desktop-1',
      type: 'subscribe_mobile_events',
    })

    subscription.dispose()
  })

  test('parses relay mobile event payloads with the shared mobile events protocol', async () => {
    const onSnapshot = vi.fn()
    const onHeartbeat = vi.fn()
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })

    client.subscribeMobileEvents({ onHeartbeat, onSnapshot })
    const socket = getFirstRelaySocket()
    socket.open()
    await Promise.resolve()
    const subscribe = readSentRelayEnvelope(socket)

    socket.receive({
      channel: 'mobile_events',
      from: 'desktop-1',
      payload: {
        snapshot: {
          active_workspace: null,
          active_workspace_id: 'workspace-1',
          connection: {},
          generated_at: 1,
          workspaces: [],
        },
        type: 'mobile-snapshot',
      },
      request_id: getRequestId(subscribe),
      to: 'mobile-1',
      type: 'mobile_events_message',
    })
    socket.receive({
      channel: 'mobile_events',
      from: 'desktop-1',
      payload: { generated_at: 2, type: 'mobile-heartbeat' },
      request_id: getRequestId(subscribe),
      to: 'mobile-1',
      type: 'mobile_events_message',
    })
    socket.receive({
      channel: 'mobile_events',
      from: 'desktop-1',
      payload: { type: 'unknown' },
      request_id: getRequestId(subscribe),
      to: 'mobile-1',
      type: 'mobile_events_message',
    })

    expect(onSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ active_workspace_id: 'workspace-1' })
    )
    expect(onHeartbeat).toHaveBeenCalledWith(2)
  })

  test('does not resubscribe mobile events after explicit dispose', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })

    const subscription = client.subscribeMobileEvents({ onSnapshot: vi.fn() })
    const socket = getFirstRelaySocket()
    socket.open()
    await Promise.resolve()
    expect(readSentRelayEnvelope(socket)).toMatchObject({ type: 'subscribe_mobile_events' })

    subscription.dispose()
    const unsubscribe = JSON.parse(socket.sent[1] ?? '') as RelayEnvelope
    expect(unsubscribe).toMatchObject({ type: 'unsubscribe_mobile_events' })
    socket.close('manual cleanup')
    await Promise.resolve()

    expect(MockRelayWebSocket.instances).toHaveLength(1)
  })

  test('clears pending mobile events reconnect work when the client closes after disconnect', async () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      mobileEventsReconnectDelayMs: 25,
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })

    client.subscribeMobileEvents({ onClose, onSnapshot: vi.fn() })
    const socket = getFirstRelaySocket()
    socket.open()
    await Promise.resolve()
    expect(readSentRelayEnvelope(socket)).toMatchObject({ type: 'subscribe_mobile_events' })

    socket.close('network changed')
    expect(onClose).toHaveBeenCalledWith('Relay mobile socket closed: network changed', {
      attempt: 1,
      nextDelayMs: 25,
    })
    client.close()

    await vi.advanceTimersByTimeAsync(25)
    expect(MockRelayWebSocket.instances).toHaveLength(1)
  })

  test('ignores relay responses that do not belong to the requested desktop or type', async () => {
    vi.useFakeTimers()
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      requestTimeoutMs: 25,
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const response = client.listWorkspaces()
    await Promise.resolve()
    const sent = readSentRelayEnvelope(socket)
    socket.receive({
      channel: 'runtime',
      from: 'desktop-2',
      payload: {
        workspaces: [{ id: 'workspace-1', name: 'Wrong Desktop', path: '/work/wrong' }],
      },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'list_workspaces_result',
    })
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: {
        workspaces: [{ id: 'workspace-1', name: 'Wrong Type', path: '/work/wrong-type' }],
      },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'list_agents_and_runs_result',
    })

    const rejection = expect(response).rejects.toThrow('Relay request timed out: list_workspaces')
    await vi.advanceTimersByTimeAsync(25)
    await rejection
  })

  test('rejects immediately when sending a relay request fails and allows another request', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    MockRelayWebSocket.nextSendError = new Error('socket buffer full')
    await expect(client.listWorkspaces()).rejects.toThrow(
      'Relay request send failed: socket buffer full'
    )
    expect(socket.sent).toEqual([])

    const response = client.listWorkspaces()
    await Promise.resolve()
    const sent = readSentRelayEnvelope(socket)
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: {
        workspaces: [{ id: 'workspace-1', name: 'Relay Workspace', path: '/work/relay' }],
      },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'list_workspaces_result',
    })

    await expect(response).resolves.toEqual([
      { id: 'workspace-1', name: 'Relay Workspace', path: '/work/relay' },
    ])
  })

  test('rejects malformed relay workspace payloads from the desktop socket', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const response = client.listWorkspaces()
    await Promise.resolve()
    const sent = readSentRelayEnvelope(socket)
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: { workspaces: [{ id: 'workspace-1', name: 'Broken Workspace' }] },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'list_workspaces_result',
    })

    await expect(response).rejects.toThrow(
      'Invalid relay workspace response: id, name, and path are required'
    )
  })

  test('preserves relay error codes from runtime proxy failures', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const response = client.listWorkspaces()
    await Promise.resolve()
    const sent = readSentRelayEnvelope(socket)
    socket.receive({
      channel: 'runtime',
      from: 'relay',
      payload: {
        code: 'desktop_runtime_unavailable',
        desktop_id: 'desktop-1',
        message: 'Desktop runtime unavailable',
      },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'relay_error',
    })

    await expect(response).rejects.toMatchObject({
      code: 'desktop_runtime_unavailable',
      desktopId: 'desktop-1',
      message: 'Desktop runtime unavailable',
      name: 'RelayRuntimeError',
    } satisfies Partial<RelayRuntimeError>)
  })

  test('preserves desktop-origin runtime proxy error codes', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const response = client.listWorkspaces()
    await Promise.resolve()
    const sent = readSentRelayEnvelope(socket)
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: {
        code: 'local_runtime_error',
        desktop_id: 'desktop-1',
        message: 'Local runtime request timed out after 15000ms',
      },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'relay_error',
    })

    await expect(response).rejects.toMatchObject({
      code: 'local_runtime_error',
      desktopId: 'desktop-1',
      message: 'Local runtime request timed out after 15000ms',
      name: 'RelayRuntimeError',
    } satisfies Partial<RelayRuntimeError>)
  })

  test('rejects malformed relay agents payloads from the desktop socket', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const response = client.listAgentsAndRuns('workspace-1')
    await Promise.resolve()
    const sent = readSentRelayEnvelope(socket)
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: { agents: [] },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'list_agents_and_runs_result',
    })

    await expect(response).rejects.toThrow(
      'Invalid relay agents response: workspace_id, agents, and runs are required'
    )
  })

  test('rejects legacy Role-bearing agents at the Relay payload boundary', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const response = client.listAgentsAndRuns('workspace-1')
    await Promise.resolve()
    const sent = readSentRelayEnvelope(socket)
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: {
        agents: [
          {
            conversation_provider: 'codex',
            id: 'agent-1',
            kind: 'worker',
            last_pty_line: null,
            name: 'Legacy Specialist',
            pending_task_count: 0,
            provider: 'codex',
            role: 'tester',
            status: 'idle',
          },
        ],
        runs: [],
        workspace_id: 'workspace-1',
      },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'list_agents_and_runs_result',
    })

    await expect(response).rejects.toThrow(/role|identity|kind/i)
  })

  test('rejects Team Help or Runtime Context in Relay Agent snapshots', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const response = client.listAgentsAndRuns('workspace-1')
    await Promise.resolve()
    const sent = readSentRelayEnvelope(socket)
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: {
        agents: [
          {
            active_dispatch_id: null,
            conversation_activity: 'idle',
            id: 'agent-1',
            kind: 'worker',
            last_observed_at: 1,
            last_pty_line: null,
            name: 'Bounded Worker',
            process_state: 'running',
            provider: 'codex',
            queue_pause_reason: null,
            queued_dispatch_count: 0,
            runtime_context: { task: 'private' },
            team_help: 'private command tutorial',
          },
        ],
        runs: [],
        workspace_id: 'workspace-1',
      },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'list_agents_and_runs_result',
    })

    await expect(response).rejects.toThrow(/runtime_context|unsupported field/i)
  })

  test('rejects legacy aggregate Agent state at the Relay payload boundary', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const response = client.listAgentsAndRuns('workspace-1')
    await Promise.resolve()
    const sent = readSentRelayEnvelope(socket)
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: {
        agents: [
          {
            id: 'agent-1',
            kind: 'worker',
            last_pty_line: null,
            name: 'Legacy State Worker',
            pending_task_count: 1,
            provider: 'codex',
            status: 'working',
          },
        ],
        runs: [],
        workspace_id: 'workspace-1',
      },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'list_agents_and_runs_result',
    })

    await expect(response).rejects.toThrow(/pending_task_count|status|identity/i)
  })

  test('rejects unsupported managed Agent Providers at the Relay payload boundary', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const response = client.listAgentsAndRuns('workspace-1')
    await Promise.resolve()
    const sent = readSentRelayEnvelope(socket)
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: {
        agents: [
          {
            id: 'agent-1',
            kind: 'worker',
            last_pty_line: null,
            name: 'Unsupported Agent',
            pending_task_count: 0,
            provider: 'gemini',
            status: 'idle',
          },
        ],
        runs: [],
        workspace_id: 'workspace-1',
      },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'list_agents_and_runs_result',
    })

    await expect(response).rejects.toThrow(/provider|identity/i)
  })

  test('rejects when the relay socket closes before opening and allows a later retry', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'revoked-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const firstConnect = client.connect()
    const firstSocket = getFirstRelaySocket()
    firstSocket.close('Invalid or expired pairing token')

    await expect(firstConnect).rejects.toThrow(
      'Relay mobile socket closed before connecting: Invalid or expired pairing token'
    )

    const secondConnect = client.connect()
    const secondSocket = MockRelayWebSocket.instances[1]
    if (!secondSocket) throw new Error('Expected retry websocket')
    secondSocket.open()

    await expect(secondConnect).resolves.toBeUndefined()
  })

  test('times out when the relay socket never opens and allows a later retry', async () => {
    vi.useFakeTimers()
    const client = new RelayMobileClient({
      connectTimeoutMs: 25,
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const firstConnect = client.connect()
    const firstRejection = expect(firstConnect).rejects.toThrow(
      'Relay mobile socket connection timed out'
    )

    await vi.advanceTimersByTimeAsync(25)
    await firstRejection
    expect(MockRelayWebSocket.instances[0]?.readyState).toBe(3)

    const secondConnect = client.connect()
    const secondSocket = MockRelayWebSocket.instances[1]
    if (!secondSocket) throw new Error('Expected retry websocket')
    secondSocket.open()

    await expect(secondConnect).resolves.toBeUndefined()
  })

  test('sends mobile actions through the paired desktop socket', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const response = client.sendMobileAction({
      action_id: 'action-1',
      kind: 'terminal_input',
      payload: { input: 'hello' },
      target: { run_id: 'run-1' },
      workspace_id: 'workspace-1',
    })
    await Promise.resolve()
    const sent = readSentRelayEnvelope(socket)
    expect(sent).toMatchObject({
      channel: 'runtime',
      from: 'mobile-1',
      payload: {
        action_id: 'action-1',
        kind: 'terminal_input',
        payload: { input: 'hello' },
        target: { run_id: 'run-1' },
        workspace_id: 'workspace-1',
      },
      to: 'desktop-1',
      type: 'mobile_action',
    })

    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: { action_id: 'action-1', ok: true, result: { bytes: 5 } },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'mobile_action_result',
    })

    await expect(response).resolves.toEqual({
      action_id: 'action-1',
      ok: true,
      result: { bytes: 5 },
    })
  })

  test('relays a normal Chat turn byte-for-byte without Team guidance', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const response = client.sendMobileAction({
      action_id: 'chat-action-1',
      kind: 'chat_submit',
      payload: { body: 'RELAY_NORMAL_TURN' },
      target: { conversation_id: 'conversation-1' },
      workspace_id: 'workspace-1',
    })
    await Promise.resolve()
    const sent = readSentRelayEnvelope(socket)

    expect(sent.payload).toEqual({
      action_id: 'chat-action-1',
      kind: 'chat_submit',
      payload: { body: 'RELAY_NORMAL_TURN' },
      target: { conversation_id: 'conversation-1' },
      workspace_id: 'workspace-1',
    })
    expect(JSON.stringify(sent)).not.toContain('team context')
    expect(JSON.stringify(sent)).not.toContain('reminder')
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: { action_id: 'chat-action-1', ok: true },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'mobile_action_result',
    })
    await expect(response).resolves.toEqual({ action_id: 'chat-action-1', ok: true })
  })

  test('requests mobile transcript through the paired desktop socket', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const response = client.getMobileTranscript('workspace-1', 'run-1')
    await Promise.resolve()
    const sent = readSentRelayEnvelope(socket)
    expect(sent).toMatchObject({
      channel: 'runtime',
      from: 'mobile-1',
      payload: {
        run_id: 'run-1',
        workspace_id: 'workspace-1',
      },
      to: 'desktop-1',
      type: 'get_mobile_transcript',
    })

    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: {
        attachments: [],
        events: [
          {
            bytes: 5,
            created_at: 1,
            id: 'action:action-1',
            kind: 'terminal_input',
            type: 'mobile_action_echo',
          },
        ],
        generated_at: 2,
        run: {
          agent_id: 'agent-1',
          agent_name: 'Coder',
          exit_code: null,
          status: 'running',
          terminal_input_profile: 'default',
        },
        run_id: 'run-1',
        workspace_id: 'workspace-1',
      },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'get_mobile_transcript_result',
    })

    await expect(response).resolves.toMatchObject({
      events: [expect.objectContaining({ id: 'action:action-1' })],
      run_id: 'run-1',
      workspace_id: 'workspace-1',
    })
  })

  test('requests the current conversation through the paired desktop socket', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const response = client.getMobileConversation('workspace-1', 'agent-1', 42)
    await Promise.resolve()
    const sent = readSentRelayEnvelope(socket)
    expect(sent).toMatchObject({
      channel: 'runtime',
      from: 'mobile-1',
      payload: { agent_id: 'agent-1', cursor: '42', workspace_id: 'workspace-1' },
      to: 'desktop-1',
      type: 'get_mobile_conversation',
    })

    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: { conversation: null },
      request_id: getRequestId(sent),
      to: 'mobile-1',
      type: 'get_mobile_conversation_result',
    })

    await expect(response).resolves.toEqual({ conversation: null })
  })

  test('requests mobile file exchange operations through the paired desktop socket', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const upload = client.uploadMobileFile({
      content_base64: 'cGl4ZWxz',
      name: 'shot.png',
      workspace_id: 'workspace-1',
    })
    await Promise.resolve()
    const uploadEnvelope = readSentRelayEnvelope(socket)
    expect(uploadEnvelope).toMatchObject({
      channel: 'runtime',
      from: 'mobile-1',
      payload: {
        content_base64: 'cGl4ZWxz',
        name: 'shot.png',
        workspace_id: 'workspace-1',
      },
      to: 'desktop-1',
      type: 'upload_mobile_file',
    })
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: {
        content_base64: 'cGl4ZWxz',
        created_at: 1,
        expires_at: 1_000,
        id: 'file-1',
        local_path: 'C:\\Temp\\hive-mobile-files\\file-1.png',
        mime_type: 'image/png',
        name: 'shot.png',
        registry_path: '.hive/mobile-attachments.json',
        size: 6,
        token: 'HIVE_AGENT_TOKEN=secret',
      },
      request_id: getRequestId(uploadEnvelope),
      to: 'mobile-1',
      type: 'upload_mobile_file_result',
    })
    await expect(upload).resolves.toEqual({
      created_at: 1,
      expires_at: 1_000,
      id: 'file-1',
      mime_type: 'image/png',
      name: 'shot.png',
      size: 6,
    })

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.toString()).toBe(
        'http://relay.example/api/relay/mobile-files/file-1?desktop_id=desktop-1&device_id=mobile-1&token=pair-token&submission_id=submission-1&workspace_id=workspace-1'
      )
      expect(init?.headers).toEqual({ authorization: 'Bearer pair-token' })
      return new Response('pixels', {
        headers: {
          'content-disposition': 'attachment; filename="shot.png"',
          'content-type': 'image/png',
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const download = client.downloadMobileFile('file-1', undefined, {
      submissionId: 'submission-1',
      workspaceId: 'workspace-1',
    })
    const downloaded = await download
    expect(downloaded.name).toBe('shot.png')
    expect(downloaded.mime_type).toBe('image/png')
    expect(downloaded.content.size).toBe(6)
    expect(downloaded.content.type).toBe('image/png')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(socket.sent).toHaveLength(1)

    const workspaceFile = client.sendWorkspaceFileToMobile('workspace-1', 'dist/demo.mp4')
    await Promise.resolve()
    const workspaceFileEnvelope = JSON.parse(socket.sent[1] ?? '') as RelayEnvelope
    expect(workspaceFileEnvelope).toMatchObject({
      payload: { path: 'dist/demo.mp4', workspace_id: 'workspace-1' },
      type: 'send_workspace_file_to_mobile',
    })
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: {
        created_at: 2,
        local_path: 'C:\\work\\project\\dist\\demo.mp4',
        id: 'file-workspace',
        mime_type: 'video/mp4',
        name: 'demo.mp4',
        registry_path: '.hive/mobile-attachments.json',
        size: 11,
        source: 'workspace',
        token: 'agent_token=secret',
        workspace_path: 'dist/demo.mp4',
      },
      request_id: getRequestId(workspaceFileEnvelope),
      to: 'mobile-1',
      type: 'send_workspace_file_to_mobile_result',
    })
    await expect(workspaceFile).resolves.toEqual({
      created_at: 2,
      id: 'file-workspace',
      mime_type: 'video/mp4',
      name: 'demo.mp4',
      size: 11,
      source: 'workspace',
      workspace_path: 'dist/demo.mp4',
    })

    const clear = client.clearMobileFiles()
    await Promise.resolve()
    const clearEnvelope = JSON.parse(socket.sent[2] ?? '') as RelayEnvelope
    expect(clearEnvelope).toMatchObject({
      payload: {},
      type: 'clear_mobile_files',
    })
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: { ok: true },
      request_id: getRequestId(clearEnvelope),
      to: 'mobile-1',
      type: 'clear_mobile_files_result',
    })
    await expect(clear).resolves.toBeUndefined()
  })

  test('rejects malformed relay mobile file payloads from the desktop socket', async () => {
    const client = new RelayMobileClient({
      desktopId: 'desktop-1',
      deviceId: 'mobile-1',
      serverUrl: 'http://relay.example',
      token: 'pair-token',
      webSocketConstructor: MockRelayWebSocketConstructor,
    })
    const connected = client.connect()
    const socket = getFirstRelaySocket()
    socket.open()
    await connected

    const list = client.listMobileFiles()
    await Promise.resolve()
    const listEnvelope = readSentRelayEnvelope(socket)
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: [{ id: 'file-1', name: 'shot.png' }],
      request_id: getRequestId(listEnvelope),
      to: 'mobile-1',
      type: 'list_mobile_files_result',
    })
    await expect(list).rejects.toThrow(
      'Invalid relay mobile file response: id, name, mime_type, size, and created_at are required'
    )

    const upload = client.uploadMobileFile({
      content_base64: 'cGl4ZWxz',
      name: 'shot.png',
      workspace_id: 'workspace-1',
    })
    await Promise.resolve()
    const uploadEnvelope = JSON.parse(socket.sent[1] ?? '') as RelayEnvelope
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: {
        created_at: 1,
        id: 'file-1',
        local_path: 42,
        mime_type: 'image/png',
        name: 'shot.png',
        size: 6,
      },
      request_id: getRequestId(uploadEnvelope),
      to: 'mobile-1',
      type: 'upload_mobile_file_result',
    })
    await expect(upload).rejects.toThrow(
      'Invalid relay mobile file response: local_path must be a string'
    )

    const expiredUpload = client.uploadMobileFile({
      content_base64: 'cGl4ZWxz',
      name: 'shot.png',
      workspace_id: 'workspace-1',
    })
    await Promise.resolve()
    const expiredUploadEnvelope = JSON.parse(socket.sent[2] ?? '') as RelayEnvelope
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: {
        created_at: 1,
        expires_at: 'soon',
        id: 'file-1',
        mime_type: 'image/png',
        name: 'shot.png',
        size: 6,
      },
      request_id: getRequestId(expiredUploadEnvelope),
      to: 'mobile-1',
      type: 'upload_mobile_file_result',
    })
    await expect(expiredUpload).rejects.toThrow(
      'Invalid relay mobile file response: expires_at must be a number'
    )

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('streaming endpoint unavailable')
      })
    )
    const download = client.downloadMobileFile('file-1', undefined, {
      submissionId: 'submission-1',
      workspaceId: 'workspace-1',
    })
    for (let index = 0; index < 5 && socket.sent.length < 4; index += 1) {
      await Promise.resolve()
    }
    const downloadEnvelope = JSON.parse(socket.sent[3] ?? '') as RelayEnvelope
    expect(downloadEnvelope.payload).toEqual({
      file_id: 'file-1',
      submission_id: 'submission-1',
      workspace_id: 'workspace-1',
    })
    socket.receive({
      channel: 'runtime',
      from: 'desktop-1',
      payload: { mime_type: 'image/png', name: 'shot.png' },
      request_id: getRequestId(downloadEnvelope),
      to: 'mobile-1',
      type: 'download_mobile_file_result',
    })
    await expect(download).rejects.toThrow(
      'Invalid relay mobile file download response: content_base64, mime_type, and name are required'
    )
  })
})
