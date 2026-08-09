#!/usr/bin/env node

import { lookup, resolve4, resolve6 } from 'node:dns/promises'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const usage = `Usage: node deploy/check-domain-readiness.mjs --domain <host> [--server-ip <ip>] [--allow-http-only] [--android-package <id> --android-sha256 <fingerprint>]

Examples:
  node deploy/check-domain-readiness.mjs --domain relay.example.com --server-ip 203.0.113.10
  node deploy/check-domain-readiness.mjs --domain 203.0.113.10 --allow-http-only
  node deploy/check-domain-readiness.mjs --domain relay.example.com --android-package com.example.yive --android-sha256 AA:BB:...
`

const readFlag = (argv, name) => {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  return argv[index + 1]
}

const hasFlag = (argv, name) => argv.includes(name)

const normalizeAndroidFingerprint = (value) => value.trim().toUpperCase()

const normalizeHost = (value) => {
  if (!value || value.startsWith('--')) throw new Error(usage)
  const trimmed = value.trim().replace(/\/+$/u, '')
  if (!trimmed) throw new Error(usage)
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) return trimmed
  return new URL(trimmed).host
}

const request = async (url) =>
  fetch(url, {
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  })

const readJson = async (response, label) => {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} did not return JSON: ${text.slice(0, 120)}`)
  }
}

export const validateAndroidAssetLinks = (assetLinks, { packageName, sha256Fingerprint }) => {
  const expectedFingerprint = normalizeAndroidFingerprint(sha256Fingerprint)
  if (!Array.isArray(assetLinks)) {
    throw new Error('/.well-known/assetlinks.json must be a JSON array')
  }

  const matched = assetLinks.some((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const relations = Array.isArray(entry.relation) ? entry.relation : []
    const target = entry.target
    const fingerprints =
      target && Array.isArray(target.sha256_cert_fingerprints)
        ? target.sha256_cert_fingerprints
        : []

    return (
      relations.includes('delegate_permission/common.handle_all_urls') &&
      target?.namespace === 'android_app' &&
      target.package_name === packageName &&
      fingerprints
        .map((fingerprint) => normalizeAndroidFingerprint(String(fingerprint)))
        .includes(expectedFingerprint)
    )
  })

  if (!matched) {
    throw new Error(
      `/.well-known/assetlinks.json does not authorize Android package ${packageName} with the supplied SHA-256 fingerprint`
    )
  }
}

const createReporter = () => {
  const lines = []
  let failed = false
  const push = (tone, message) => {
    if (tone === 'fail') failed = true
    lines.push(`[${tone}] ${message}`)
  }
  return {
    fail: (message) => push('fail', message),
    ok: (message) => push('ok', message),
    print: () => {
      for (const line of lines) console.log(line)
    },
    warn: (message) => push('warn', message),
    get failed() {
      return failed
    },
  }
}

const resolveHostAddresses = async (host) => {
  if (isIP(host)) return [host]
  const results = await Promise.allSettled([
    resolve4(host),
    resolve6(host),
    lookup(host, { all: true }).then((items) => items.map((item) => item.address)),
  ])
  return Array.from(
    new Set(results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])))
  )
}

const checkRelayHealth = async (baseUrl) => {
  const response = await request(`${baseUrl}/health`)
  if (response.status !== 200) {
    const server = response.headers.get('server')
    const body = await response.text().catch(() => '')
    const details = [
      `/health returned ${response.status}`,
      ...(server ? [`server=${server}`] : []),
      ...(body ? [`body=${body.replace(/\s+/gu, ' ').slice(0, 120)}`] : []),
    ]
    const hint =
      server?.toLowerCase().includes('beaver') || body.toLowerCase().includes('beaver')
        ? ' This looks like an upstream cloud/provider block before Yive; on mainland China servers, confirm ICP filing and domain binding.'
        : ''
    throw new Error(`${details.join(', ')}.${hint}`)
  }
  const health = await readJson(response, `${baseUrl}/health`)
  if (health.ok !== true || health.service !== 'hive-relay') {
    throw new Error('/health is not a Yive Relay response')
  }
  return health
}

const checkPwa = async (baseUrl) => {
  const mobile = await request(`${baseUrl}/mobile?relay=1`)
  if (mobile.status !== 200) throw new Error(`/mobile?relay=1 returned ${mobile.status}`)
  if (!(mobile.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error('/mobile?relay=1 did not return HTML')
  }

  const manifestResponse = await request(`${baseUrl}/manifest.webmanifest`)
  if (manifestResponse.status !== 200) {
    throw new Error(`/manifest.webmanifest returned ${manifestResponse.status}`)
  }
  if (!(manifestResponse.headers.get('cache-control') ?? '').includes('max-age=0')) {
    throw new Error('/manifest.webmanifest should use max-age=0 cache policy')
  }
  const manifest = await readJson(manifestResponse, `${baseUrl}/manifest.webmanifest`)
  if (manifest.start_url !== '/mobile?relay=1' || manifest.display !== 'standalone') {
    throw new Error('/manifest.webmanifest is not configured for the mobile standalone app')
  }
  const icons = Array.isArray(manifest.icons) ? manifest.icons : []
  if (
    !icons.some(
      (icon) =>
        icon &&
        typeof icon.src === 'string' &&
        icon.src.includes('/icons/icon-512-maskable.png') &&
        String(icon.purpose ?? '').includes('maskable')
    )
  ) {
    throw new Error('/manifest.webmanifest is missing the maskable app icon')
  }

  const sw = await request(`${baseUrl}/sw.js`)
  if (sw.status !== 200) throw new Error(`/sw.js returned ${sw.status}`)
  if (!(sw.headers.get('cache-control') ?? '').includes('no-store')) {
    throw new Error('/sw.js should use no-store cache policy')
  }
  const swBody = await sw.text()
  if (!swBody.includes('self.addEventListener')) throw new Error('/sw.js is not a service worker')
}

const checkAndroidAssetLinks = async (baseUrl, options) => {
  const response = await request(`${baseUrl}/.well-known/assetlinks.json`)
  if (response.status !== 200) {
    throw new Error(`/.well-known/assetlinks.json returned ${response.status}`)
  }
  const assetLinks = await readJson(response, `${baseUrl}/.well-known/assetlinks.json`)
  validateAndroidAssetLinks(assetLinks, options)
}

const main = async () => {
  const argv = process.argv.slice(2)
  const host = normalizeHost(readFlag(argv, '--domain'))
  const expectedIp = readFlag(argv, '--server-ip')?.trim()
  const allowHttpOnly = hasFlag(argv, '--allow-http-only')
  const androidPackage = readFlag(argv, '--android-package')?.trim()
  const androidSha256 = readFlag(argv, '--android-sha256')?.trim()
  const report = createReporter()

  if (Boolean(androidPackage) !== Boolean(androidSha256)) {
    throw new Error('--android-package and --android-sha256 must be provided together')
  }

  console.log(`Yive domain readiness: ${host}`)

  try {
    const addresses = await resolveHostAddresses(host)
    if (addresses.length === 0) throw new Error('no A/AAAA records')
    report.ok(`DNS resolves to ${addresses.join(', ')}`)
    if (expectedIp) {
      if (addresses.includes(expectedIp)) {
        report.ok(`DNS includes expected server IP ${expectedIp}`)
      } else {
        report.fail(`DNS does not include expected server IP ${expectedIp}`)
      }
    }
  } catch (error) {
    report.fail(`DNS lookup failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  let httpOk = false
  let httpsOk = false
  for (const protocol of ['http', 'https']) {
    const baseUrl = `${protocol}://${host}`
    try {
      const health = await checkRelayHealth(baseUrl)
      report.ok(
        `${protocol.toUpperCase()} Relay health ok: ${health.desktop_count} desktop, ${health.mobile_count} mobile`
      )
      if (protocol === 'http') httpOk = true
      else httpsOk = true
    } catch (error) {
      const message = `${protocol.toUpperCase()} Relay health failed: ${
        error instanceof Error ? error.message : String(error)
      }`
      if (protocol === 'https' && allowHttpOnly) report.warn(message)
      else report.fail(message)
    }
  }

  const pwaBaseUrl = httpsOk ? `https://${host}` : httpOk && allowHttpOnly ? `http://${host}` : null
  if (pwaBaseUrl) {
    try {
      await checkPwa(pwaBaseUrl)
      report.ok(`PWA shell/install assets ok at ${pwaBaseUrl}`)
    } catch (error) {
      report.fail(`PWA readiness failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    report.fail('PWA readiness skipped because no acceptable HTTP(S) Relay endpoint is available')
  }

  if (!httpsOk && !allowHttpOnly) {
    report.fail('HTTPS is required for reliable mobile App/PWA installation.')
  }

  if (androidPackage && androidSha256) {
    if (!httpsOk) {
      report.fail('Android TWA asset links require a working HTTPS Relay origin.')
    } else {
      try {
        await checkAndroidAssetLinks(`https://${host}`, {
          packageName: androidPackage,
          sha256Fingerprint: androidSha256,
        })
        report.ok(
          `Android asset links authorize ${androidPackage} for the supplied signing certificate`
        )
      } catch (error) {
        report.fail(
          `Android asset links failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }

  report.print()
  if (report.failed) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
