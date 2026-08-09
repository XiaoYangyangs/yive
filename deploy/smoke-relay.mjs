#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

import { validateAndroidAssetLinks } from './check-domain-readiness.mjs'

const usage = `Usage: node deploy/smoke-relay.mjs --server <url> [--token <admin-token>] [--allow-http-only] [--android-package <id> --android-sha256 <fingerprint>]

Examples:
  node deploy/smoke-relay.mjs --server http://127.0.0.1:4020 --token "$YIVE_RELAY_ADMIN_TOKEN"
  node deploy/smoke-relay.mjs --server http://203.0.113.10 --token "$YIVE_RELAY_ADMIN_TOKEN" --allow-http-only
  node deploy/smoke-relay.mjs --server https://relay.example.com --token "$YIVE_RELAY_ADMIN_TOKEN"
  node deploy/smoke-relay.mjs --server https://relay.example.com --android-package com.example.yive --android-sha256 AA:BB:...
`

const readFlag = (argv, name) => {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  return argv[index + 1]
}

const hasFlag = (argv, name) => argv.includes(name)

const normalizeServerUrl = (value) => {
  if (!value || value.startsWith('--')) throw new Error(usage)
  const trimmed = value.trim().replace(/\/+$/u, '')
  if (!trimmed) throw new Error(usage)
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

const isLoopbackOrPrivateHost = (host) => {
  const normalized = host.toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('10.') ||
    normalized.startsWith('192.168.') ||
    /^172\.(?:1[6-9]|2\d|3[0-1])\./u.test(normalized)
  )
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const readJson = async (response, label) => {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} did not return JSON: ${text.slice(0, 120)}`)
  }
}

const request = async (url, options = {}) => {
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'manual',
    ...options,
  })
  return response
}

const buildSmokeMobileDeviceId = () =>
  `smoke-mobile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

const assertRelayMobileSelfBootstrapPairing = async ({
  adminToken,
  checks,
  desktopId,
  serverUrl,
}) => {
  const deviceId = buildSmokeMobileDeviceId()
  try {
    const pairingResponse = await request(`${serverUrl}/pairings`, {
      headers: { authorization: `Bearer ${adminToken}` },
      method: 'POST',
    })
    assert(
      pairingResponse.status === 201,
      `/pairings with admin token expected 201, got ${pairingResponse.status}`
    )
    const pairing = await readJson(pairingResponse, '/pairings')
    assert(
      pairing && typeof pairing.token === 'string' && pairing.token.trim(),
      '/pairings did not return a pairing token'
    )

    const claimResponse = await request(`${serverUrl}/pairings/claim`, {
      body: JSON.stringify({
        ...(desktopId ? { desktop_id: desktopId } : {}),
        device_id: deviceId,
        device_kind: 'mobile',
        token: pairing.token,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    assert(
      claimResponse.status === 201,
      `/pairings/claim expected 201, got ${claimResponse.status}`
    )
    const claimed = await readJson(claimResponse, '/pairings/claim')
    assert(
      claimed && typeof claimed.token === 'string' && claimed.token.trim(),
      '/pairings/claim did not return a device token'
    )
    assert(claimed.token !== pairing.token, '/pairings/claim must exchange the short token')
    assert(claimed.device_id === deviceId, '/pairings/claim returned the wrong device_id')
    assert(claimed.device_kind === 'mobile', '/pairings/claim returned the wrong device_kind')
    if (desktopId) {
      assert(claimed.desktop_id === desktopId, '/pairings/claim returned the wrong desktop_id')
      const mobileDevicesResponse = await request(`${serverUrl}/devices`, {
        headers: { authorization: `Bearer ${claimed.token}` },
      })
      assert(
        mobileDevicesResponse.status === 200,
        `/devices with claimed mobile token expected 200, got ${mobileDevicesResponse.status}`
      )
      const mobileDevices = await readJson(mobileDevicesResponse, '/devices')
      assert(Array.isArray(mobileDevices.desktops), '/devices mobile desktops must be an array')
      assert(Array.isArray(mobileDevices.mobiles), '/devices mobile mobiles must be an array')
      assert(
        mobileDevices.desktops.some((desktop) => desktop?.device_id === desktopId),
        '/devices with claimed mobile token did not include the bound desktop'
      )
      checks.push('mobile self-bootstrap pairing ok')
      checks.push('claimed mobile token can list the bound desktop')
    } else {
      checks.push('mobile self-bootstrap pairing ok')
      checks.push('claimed mobile token devices check skipped: no online desktop to bind')
    }
  } finally {
    const cleanupResponse = await request(
      `${serverUrl}/pairings/devices/${encodeURIComponent(deviceId)}`,
      {
        headers: { authorization: `Bearer ${adminToken}` },
        method: 'DELETE',
      }
    ).catch(() => null)
    if (cleanupResponse?.status === 200 || cleanupResponse?.status === 404) {
      checks.push('mobile smoke device cleaned up')
    }
  }
}

const assertHeaderIncludes = (response, name, expected, label) => {
  const value = response.headers.get(name) ?? ''
  assert(
    value.toLowerCase().includes(expected.toLowerCase()),
    `${label} expected ${name}: ${expected}, got ${value || 'missing'}`
  )
  return value
}

export const assertRelayTransportSecurity = (
  serverUrl,
  { allowHttpOnly = false, checks = [] } = {}
) => {
  const url = new URL(serverUrl)
  if (url.protocol === 'https:') {
    checks.push('relay transport is HTTPS/WSS ready')
    return checks
  }
  if (url.protocol !== 'http:') {
    throw new Error(`Relay server URL must use http or https, got ${url.protocol}`)
  }
  if (isLoopbackOrPrivateHost(url.hostname)) {
    checks.push('relay transport is local HTTP only')
    return checks
  }
  if (!allowHttpOnly) {
    throw new Error(
      'Production Relay smoke requires HTTPS/WSS for public hosts. Re-run with --allow-http-only only for temporary IP/HTTP testing.'
    )
  }
  checks.push('temporary public HTTP allowed by --allow-http-only')
  return checks
}

const assertPwaManifest = (manifest) => {
  assert(manifest.id === '/mobile?relay=1', '/manifest id must target mobile relay')
  assert(manifest.start_url === '/mobile?relay=1', '/manifest start_url must target mobile relay')
  assert(manifest.scope === '/', '/manifest scope must be /')
  assert(manifest.display === 'standalone', '/manifest display must be standalone')
  assert(Array.isArray(manifest.icons), '/manifest icons must be an array')
  assert(
    manifest.icons.some(
      (icon) =>
        icon &&
        typeof icon.src === 'string' &&
        icon.src.includes('/icons/icon-192.png') &&
        icon.sizes === '192x192'
    ),
    '/manifest must include the 192px app icon'
  )
  assert(
    manifest.icons.some(
      (icon) =>
        icon &&
        typeof icon.src === 'string' &&
        icon.src.includes('/icons/icon-512-maskable.png') &&
        String(icon.purpose ?? '').includes('maskable')
    ),
    '/manifest must include a maskable 512px icon'
  )
  assert(Array.isArray(manifest.screenshots), '/manifest screenshots must be an array')
  assert(
    manifest.screenshots.some((screenshot) => screenshot?.form_factor === 'narrow'),
    '/manifest must include a narrow mobile screenshot'
  )
}

const assertPwaAsset = async (serverUrl, path, expectedContentType) => {
  const response = await request(`${serverUrl}${path}`)
  assert(response.status === 200, `${path} expected 200, got ${response.status}`)
  assertHeaderIncludes(response, 'content-type', expectedContentType, path)
  const body = await response.arrayBuffer()
  assert(body.byteLength > 0, `${path} must not be empty`)
}

const assertAndroidAssetLinks = async ({
  androidPackage,
  checks,
  serverUrl,
  sha256Fingerprint,
}) => {
  const url = new URL(serverUrl)
  assert(url.protocol === 'https:', 'Android TWA asset links require an HTTPS Relay origin')
  const response = await request(`${serverUrl}/.well-known/assetlinks.json`)
  assert(
    response.status === 200,
    `/.well-known/assetlinks.json expected 200, got ${response.status}`
  )
  assertHeaderIncludes(response, 'content-type', 'application/json', '/.well-known/assetlinks.json')
  validateAndroidAssetLinks(await readJson(response, '/.well-known/assetlinks.json'), {
    packageName: androidPackage,
    sha256Fingerprint,
  })
  checks.push(`android asset links ok: ${androidPackage}`)
}

export const assertRelayDeploymentHealth = (health, checks = []) => {
  assert(health.ok === true, '/health ok must be true')
  assert(health.service === 'hive-relay', '/health service must be hive-relay')
  assert(Number.isInteger(health.protocol_version), '/health protocol_version must be an integer')
  assert(Number.isInteger(health.desktop_count), '/health desktop_count must be an integer')
  assert(Number.isInteger(health.mobile_count), '/health mobile_count must be an integer')
  checks.push(`health ok: ${health.desktop_count} desktop, ${health.mobile_count} mobile`)
  assert(
    health.deployment && typeof health.deployment.public_url_configured === 'boolean',
    '/health deployment.public_url_configured must be a boolean'
  )
  assert(
    health.deployment.public_url_configured === true,
    '/health deployment.public_url_configured must be true for deployment'
  )
  checks.push('relay public URL is configured')
  if (health.static) {
    assert(
      health.static.mobile_app_available === true,
      '/health static.mobile_app_available expected true'
    )
    checks.push('health static app ok')
  }
  if (health.pairing_store) {
    assert(
      typeof health.pairing_store.device_token_count === 'number',
      '/health pairing_store.device_token_count must be a number'
    )
    assert(
      typeof health.pairing_store.issued_token_count === 'number',
      '/health pairing_store.issued_token_count must be a number'
    )
    assert(
      typeof health.pairing_store.persistent === 'boolean',
      '/health pairing_store.persistent must be a boolean'
    )
    assert(
      health.pairing_store.persistent === true,
      '/health pairing_store.persistent must be true for deployment'
    )
    if (typeof health.pairing_store.admin_token_default === 'boolean') {
      assert(
        health.pairing_store.admin_token_default === false,
        '/health pairing_store.admin_token_default must be false for deployment'
      )
      checks.push('relay admin token is configured')
    }
    assert(
      typeof health.pairing_store.require_desktop_binding === 'boolean',
      '/health pairing_store.require_desktop_binding must be a boolean'
    )
    assert(
      health.pairing_store.require_desktop_binding === true,
      '/health pairing_store.require_desktop_binding must be true for deployment'
    )
    checks.push('relay desktop binding is required')
    checks.push(
      `pairing store ${health.pairing_store.persistent ? 'persistent' : 'in-memory'}: ${
        health.pairing_store.device_token_count
      } device token, ${health.pairing_store.issued_token_count} pending pairing token`
    )
  }
  if (
    Number.isInteger(health.heartbeat_interval_ms) &&
    Number.isInteger(health.heartbeat_timeout_ms)
  ) {
    checks.push(
      `heartbeat ok: ${health.heartbeat_interval_ms}ms interval, ${health.heartbeat_timeout_ms}ms timeout`
    )
  }
  if (Number.isInteger(health.terminal_proxy_count)) {
    checks.push(`terminal proxies: ${health.terminal_proxy_count}`)
  }
  return checks
}

export const runRelaySmoke = async ({ argv = process.argv.slice(2), env = process.env } = {}) => {
  const serverUrl = normalizeServerUrl(readFlag(argv, '--server'))
  const token = readFlag(argv, '--token') ?? env.YIVE_RELAY_ADMIN_TOKEN
  const allowHttpOnly = hasFlag(argv, '--allow-http-only')
  const androidPackage = readFlag(argv, '--android-package')?.trim()
  const androidSha256 = readFlag(argv, '--android-sha256')?.trim()
  const checks = []

  if (Boolean(androidPackage) !== Boolean(androidSha256)) {
    throw new Error('--android-package and --android-sha256 must be provided together')
  }

  assertRelayTransportSecurity(serverUrl, { allowHttpOnly, checks })

  const healthResponse = await request(`${serverUrl}/health`)
  assert(healthResponse.status === 200, `/health expected 200, got ${healthResponse.status}`)
  assertRelayDeploymentHealth(await readJson(healthResponse, '/health'), checks)

  const headResponse = await request(`${serverUrl}/health`, { method: 'HEAD' })
  assert(headResponse.status === 200, `HEAD /health expected 200, got ${headResponse.status}`)
  checks.push('head health ok')

  const mobileResponse = await request(`${serverUrl}/mobile?relay=1`)
  assert(mobileResponse.status === 200, `/mobile expected 200, got ${mobileResponse.status}`)
  const mobileContentType = mobileResponse.headers.get('content-type') ?? ''
  assert(
    mobileContentType.includes('text/html'),
    `/mobile expected text/html, got ${mobileContentType || 'no content-type'}`
  )
  const mobileHtml = await mobileResponse.text()
  assert(
    /<html|<!doctype html|id=["']root["']/iu.test(mobileHtml),
    '/mobile did not look like the built web app'
  )
  checks.push('mobile static app ok')

  const manifestResponse = await request(`${serverUrl}/manifest.webmanifest`)
  assert(
    manifestResponse.status === 200,
    `/manifest.webmanifest expected 200, got ${manifestResponse.status}`
  )
  assertHeaderIncludes(
    manifestResponse,
    'content-type',
    'application/manifest+json',
    '/manifest.webmanifest'
  )
  assertHeaderIncludes(manifestResponse, 'cache-control', 'max-age=0', '/manifest.webmanifest')
  assertPwaManifest(await readJson(manifestResponse, '/manifest.webmanifest'))
  checks.push('pwa manifest ok')

  const swResponse = await request(`${serverUrl}/sw.js`)
  assert(swResponse.status === 200, `/sw.js expected 200, got ${swResponse.status}`)
  assertHeaderIncludes(swResponse, 'content-type', 'javascript', '/sw.js')
  assertHeaderIncludes(swResponse, 'cache-control', 'no-store', '/sw.js')
  const swBody = await swResponse.text()
  assert(swBody.includes('self.addEventListener'), '/sw.js did not look like a service worker')
  checks.push('service worker cache policy ok')

  await Promise.all([
    assertPwaAsset(serverUrl, '/icons/icon-192.png', 'image/png'),
    assertPwaAsset(serverUrl, '/icons/icon-512.png', 'image/png'),
    assertPwaAsset(serverUrl, '/icons/icon-512-maskable.png', 'image/png'),
    assertPwaAsset(serverUrl, '/screenshots/mobile-runtime.png', 'image/png'),
  ])
  checks.push('pwa install assets ok')

  if (androidPackage && androidSha256) {
    await assertAndroidAssetLinks({
      androidPackage,
      checks,
      serverUrl,
      sha256Fingerprint: androidSha256,
    })
  }

  const unauthorizedDevices = await request(`${serverUrl}/devices`)
  assert(
    unauthorizedDevices.status === 401,
    `/devices without token expected 401, got ${unauthorizedDevices.status}`
  )
  checks.push('unauthorized devices protected')

  if (token) {
    const devicesResponse = await request(`${serverUrl}/devices`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert(
      devicesResponse.status === 200,
      `/devices with token expected 200, got ${devicesResponse.status}`
    )
    const devices = await readJson(devicesResponse, '/devices')
    assert(Array.isArray(devices.desktops), '/devices desktops must be an array')
    assert(Array.isArray(devices.mobiles), '/devices mobiles must be an array')
    checks.push(
      `authorized devices ok: ${devices.desktops.length} desktop, ${devices.mobiles.length} mobile`
    )
    await assertRelayMobileSelfBootstrapPairing({
      adminToken: token,
      checks,
      desktopId:
        devices.desktops.find((desktop) => typeof desktop?.device_id === 'string')?.device_id ??
        null,
      serverUrl,
    })
  } else {
    checks.push('authorized devices skipped: no --token or YIVE_RELAY_ADMIN_TOKEN')
    checks.push('mobile self-bootstrap pairing skipped: no --token or YIVE_RELAY_ADMIN_TOKEN')
  }

  console.log(`Yive Relay smoke test passed for ${serverUrl}`)
  for (const check of checks) console.log(`- ${check}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRelaySmoke().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
