import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  assertRelayDeploymentHealth,
  assertRelayTransportSecurity,
  runRelaySmoke,
} from '../../deploy/smoke-relay.mjs'

const deploymentHealth = (overrides: Record<string, unknown> = {}) => ({
  desktop_count: 0,
  deployment: {
    public_url_configured: true,
  },
  mobile_count: 0,
  ok: true,
  pairing_store: {
    admin_token_default: false,
    device_token_count: 0,
    issued_token_count: 0,
    persistent: true,
    require_desktop_binding: true,
  },
  protocol_version: 1,
  service: 'hive-relay',
  ...overrides,
})

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    status: init.status ?? 200,
  })

const assetResponse = (contentType: string) =>
  new Response(new Uint8Array([1, 2, 3]), {
    headers: { 'content-type': contentType },
    status: 200,
  })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runRelaySmoke', () => {
  test('verifies mobile self-bootstrap pairing and cleans up the smoke device', async () => {
    const calls: Array<{ body?: unknown; headers?: Headers; method: string; url: string }> = []
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message))
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const method = init.method ?? 'GET'
        const headers = new Headers(init.headers)
        const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : undefined
        calls.push({ ...(body ? { body } : {}), headers, method, url })

        if (url === 'https://relay.test/health' && method === 'GET') {
          return jsonResponse(deploymentHealth({ desktop_count: 1 }))
        }
        if (url === 'https://relay.test/health' && method === 'HEAD') {
          return new Response(null, { status: 200 })
        }
        if (url === 'https://relay.test/mobile?relay=1') {
          return new Response('<!doctype html><div id="root"></div>', {
            headers: { 'content-type': 'text/html; charset=utf-8' },
            status: 200,
          })
        }
        if (url === 'https://relay.test/manifest.webmanifest') {
          return jsonResponse(
            {
              display: 'standalone',
              icons: [
                { sizes: '192x192', src: '/icons/icon-192.png' },
                { purpose: 'maskable', sizes: '512x512', src: '/icons/icon-512-maskable.png' },
              ],
              id: '/mobile?relay=1',
              scope: '/',
              screenshots: [{ form_factor: 'narrow', src: '/screenshots/mobile-runtime.png' }],
              start_url: '/mobile?relay=1',
            },
            {
              headers: {
                'cache-control': 'max-age=0, must-revalidate',
                'content-type': 'application/manifest+json',
              },
            }
          )
        }
        if (url === 'https://relay.test/sw.js') {
          return new Response('self.addEventListener("install", () => {})', {
            headers: { 'cache-control': 'no-store', 'content-type': 'text/javascript' },
            status: 200,
          })
        }
        if (
          [
            'https://relay.test/icons/icon-192.png',
            'https://relay.test/icons/icon-512.png',
            'https://relay.test/icons/icon-512-maskable.png',
            'https://relay.test/screenshots/mobile-runtime.png',
          ].includes(url)
        ) {
          return assetResponse('image/png')
        }
        if (url === 'https://relay.test/devices' && method === 'GET') {
          const authorization = headers.get('authorization')
          if (!authorization) return jsonResponse({ error: 'Invalid relay token' }, { status: 401 })
          if (authorization === 'Bearer admin-token') {
            return jsonResponse({ desktops: [{ device_id: 'desktop-1' }], mobiles: [] })
          }
          if (authorization === 'Bearer claimed-mobile-token') {
            return jsonResponse({ desktops: [{ device_id: 'desktop-1' }], mobiles: [] })
          }
        }
        if (url === 'https://relay.test/pairings' && method === 'POST') {
          return jsonResponse({ token: 'short-pairing-token' }, { status: 201 })
        }
        if (url === 'https://relay.test/pairings/claim' && method === 'POST') {
          return jsonResponse(
            {
              desktop_id: body.desktop_id,
              device_id: body.device_id,
              device_kind: body.device_kind,
              token: 'claimed-mobile-token',
            },
            { status: 201 }
          )
        }
        if (
          url.startsWith('https://relay.test/pairings/devices/smoke-mobile-') &&
          method === 'DELETE'
        ) {
          return jsonResponse({
            device_id: decodeURIComponent(url.split('/').pop() ?? ''),
            revoked: true,
          })
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`)
      })
    )

    await runRelaySmoke({
      argv: ['--server', 'https://relay.test', '--token', 'admin-token'],
      env: {},
    })

    expect(logs).toContain('Yive Relay smoke test passed for https://relay.test')
    expect(logs).toContain('- mobile self-bootstrap pairing ok')
    expect(logs).toContain('- claimed mobile token can list the bound desktop')
    expect(logs).toContain('- mobile smoke device cleaned up')
    expect(logs.join('\n')).not.toContain('admin-token')
    expect(logs.join('\n')).not.toContain('short-pairing-token')
    expect(logs.join('\n')).not.toContain('claimed-mobile-token')

    const claimCall = calls.find((call) => call.url === 'https://relay.test/pairings/claim')
    expect(claimCall?.body).toMatchObject({
      desktop_id: 'desktop-1',
      device_kind: 'mobile',
      token: 'short-pairing-token',
    })
    expect(String((claimCall?.body as { device_id?: string } | undefined)?.device_id)).toMatch(
      /^smoke-mobile-/
    )
    expect(
      calls.some(
        (call) =>
          call.url.startsWith('https://relay.test/pairings/devices/smoke-mobile-') &&
          call.method === 'DELETE' &&
          call.headers?.get('authorization') === 'Bearer admin-token'
      )
    ).toBe(true)
    expect(
      calls.some(
        (call) =>
          call.url === 'https://relay.test/devices' &&
          call.headers?.get('authorization') === 'Bearer claimed-mobile-token'
      )
    ).toBe(true)
  })

  test('verifies Android asset links when app package details are supplied', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message))
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const method = init.method ?? 'GET'

        if (url === 'https://relay.test/health' && method === 'GET') {
          return jsonResponse(deploymentHealth())
        }
        if (url === 'https://relay.test/health' && method === 'HEAD') {
          return new Response(null, { status: 200 })
        }
        if (url === 'https://relay.test/mobile?relay=1') {
          return new Response('<!doctype html><div id="root"></div>', {
            headers: { 'content-type': 'text/html; charset=utf-8' },
            status: 200,
          })
        }
        if (url === 'https://relay.test/manifest.webmanifest') {
          return jsonResponse(
            {
              display: 'standalone',
              icons: [
                { sizes: '192x192', src: '/icons/icon-192.png' },
                { purpose: 'maskable', sizes: '512x512', src: '/icons/icon-512-maskable.png' },
              ],
              id: '/mobile?relay=1',
              scope: '/',
              screenshots: [{ form_factor: 'narrow', src: '/screenshots/mobile-runtime.png' }],
              start_url: '/mobile?relay=1',
            },
            {
              headers: {
                'cache-control': 'max-age=0, must-revalidate',
                'content-type': 'application/manifest+json',
              },
            }
          )
        }
        if (url === 'https://relay.test/sw.js') {
          return new Response('self.addEventListener("install", () => {})', {
            headers: { 'cache-control': 'no-store', 'content-type': 'text/javascript' },
            status: 200,
          })
        }
        if (
          [
            'https://relay.test/icons/icon-192.png',
            'https://relay.test/icons/icon-512.png',
            'https://relay.test/icons/icon-512-maskable.png',
            'https://relay.test/screenshots/mobile-runtime.png',
          ].includes(url)
        ) {
          return assetResponse('image/png')
        }
        if (url === 'https://relay.test/.well-known/assetlinks.json') {
          return jsonResponse([
            {
              relation: ['delegate_permission/common.handle_all_urls'],
              target: {
                namespace: 'android_app',
                package_name: 'com.example.yive',
                sha256_cert_fingerprints: ['AA:BB:CC'],
              },
            },
          ])
        }
        if (url === 'https://relay.test/devices' && method === 'GET') {
          return jsonResponse({ error: 'Invalid relay token' }, { status: 401 })
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`)
      })
    )

    await runRelaySmoke({
      argv: [
        '--server',
        'https://relay.test',
        '--android-package',
        'com.example.yive',
        '--android-sha256',
        'AA:BB:CC',
      ],
      env: {},
    })

    expect(logs).toContain('- android asset links ok: com.example.yive')
  })

  test('requires Android package and signing fingerprint together for relay smoke', async () => {
    await expect(
      runRelaySmoke({
        argv: ['--server', 'https://relay.test', '--android-package', 'com.example.yive'],
        env: {},
      })
    ).rejects.toThrow('--android-package and --android-sha256 must be provided together')
  })
})

describe('smoke-relay deployment health checks', () => {
  test('requires HTTPS for public production relay smoke checks', () => {
    expect(() => assertRelayTransportSecurity('http://relay.example.com')).toThrow(
      'Production Relay smoke requires HTTPS/WSS for public hosts'
    )
  })

  test('allows temporary public HTTP only when explicitly requested', () => {
    const checks: string[] = []

    expect(
      assertRelayTransportSecurity('http://203.0.113.10', { allowHttpOnly: true, checks })
    ).toBe(checks)

    expect(checks).toContain('temporary public HTTP allowed by --allow-http-only')
  })

  test('allows local HTTP for development smoke checks', () => {
    const checks: string[] = []

    expect(assertRelayTransportSecurity('http://127.0.0.1:4020', { checks })).toBe(checks)

    expect(checks).toContain('relay transport is local HTTP only')
  })

  test('accepts production relay health with persistent bound pairing store', () => {
    const checks: string[] = []

    expect(assertRelayDeploymentHealth(deploymentHealth(), checks)).toBe(checks)

    expect(checks).toContain('relay admin token is configured')
    expect(checks).toContain('relay desktop binding is required')
    expect(checks).toContain('relay public URL is configured')
    expect(checks).toContain('pairing store persistent: 0 device token, 0 pending pairing token')
  })

  test('rejects production relay health without a configured public smoke URL', () => {
    expect(() =>
      assertRelayDeploymentHealth(
        deploymentHealth({
          deployment: {
            public_url_configured: false,
          },
        })
      )
    ).toThrow('/health deployment.public_url_configured must be true for deployment')
  })

  test('rejects older health responses that do not expose public URL readiness', () => {
    const { deployment, ...health } = deploymentHealth()
    void deployment

    expect(() => assertRelayDeploymentHealth(health)).toThrow(
      '/health deployment.public_url_configured must be a boolean'
    )
  })

  test('rejects in-memory pairing stores for production deployment', () => {
    expect(() =>
      assertRelayDeploymentHealth(
        deploymentHealth({
          pairing_store: {
            admin_token_default: false,
            device_token_count: 0,
            issued_token_count: 0,
            persistent: false,
            require_desktop_binding: true,
          },
        })
      )
    ).toThrow('/health pairing_store.persistent must be true for deployment')
  })

  test('rejects production relay health without desktop-bound device tokens', () => {
    expect(() =>
      assertRelayDeploymentHealth(
        deploymentHealth({
          pairing_store: {
            admin_token_default: false,
            device_token_count: 0,
            issued_token_count: 0,
            persistent: true,
            require_desktop_binding: false,
          },
        })
      )
    ).toThrow('/health pairing_store.require_desktop_binding must be true for deployment')
  })

  test('rejects older health responses that do not expose desktop binding policy', () => {
    expect(() =>
      assertRelayDeploymentHealth(
        deploymentHealth({
          pairing_store: {
            admin_token_default: false,
            device_token_count: 0,
            issued_token_count: 0,
            persistent: true,
          },
        })
      )
    ).toThrow('/health pairing_store.require_desktop_binding must be a boolean')
  })
})
