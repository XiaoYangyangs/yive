import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'

// Server-level integration test for PWA static assets. The fixture mimics the
// shape emitted by `pnpm build`; build-time SW substitution is covered by
// tests/unit/build-sw-plugin.test.ts.

let staticDir: string
let savedStaticDirEnv: string | undefined
let server: Awaited<ReturnType<typeof startTestServer>>

const FIXTURE_SW_BODY = [
  '// Fixture SW for static-pwa.test.ts.',
  "const VERSION = '0.0.0-static-pwa-fixture'",
  "self.addEventListener('install', () => {})",
  "self.addEventListener('fetch', () => {})",
  '',
].join('\n')

beforeAll(async () => {
  staticDir = mkdtempSync(join(tmpdir(), 'hive-static-pwa-'))

  writeFileSync(
    join(staticDir, 'index.html'),
    '<!doctype html><html><body><div id="root"></div></body></html>'
  )

  copyFileSync(
    join(process.cwd(), 'web/public/manifest.webmanifest'),
    join(staticDir, 'manifest.webmanifest')
  )

  writeFileSync(join(staticDir, 'sw.js'), FIXTURE_SW_BODY)

  mkdirSync(join(staticDir, 'icons'), { recursive: true })
  for (const name of [
    'icon-32.png',
    'icon-192.png',
    'icon-512.png',
    'icon-512-maskable.png',
    'apple-touch-icon-180.png',
  ]) {
    copyFileSync(join(process.cwd(), 'web/public/icons', name), join(staticDir, 'icons', name))
  }

  mkdirSync(join(staticDir, 'screenshots'), { recursive: true })
  for (const name of ['mobile-runtime.png', 'wide-overview.png']) {
    copyFileSync(
      join(process.cwd(), 'web/public/screenshots', name),
      join(staticDir, 'screenshots', name)
    )
  }

  savedStaticDirEnv = process.env.HIVE_STATIC_DIR
  process.env.HIVE_STATIC_DIR = staticDir
  server = await startTestServer()
})

afterAll(async () => {
  await server.close()
  if (savedStaticDirEnv === undefined) delete process.env.HIVE_STATIC_DIR
  else process.env.HIVE_STATIC_DIR = savedStaticDirEnv
  rmSync(staticDir, { force: true, recursive: true })
})

describe('PWA static assets over HTTP', () => {
  test('app shell entry points bypass HTTP cache so UI updates are visible after rebuilds', async () => {
    for (const path of ['/', '/index.html', '/mobile?relay=1']) {
      const response = await fetch(`${server.baseUrl}${path}`)
      expect(response.status, path).toBe(200)
      expect(response.headers.get('content-type'), path).toBe('text/html; charset=utf-8')
      expect(response.headers.get('cache-control'), path).toBe('no-store')
    }
  })

  test('manifest is served as application/manifest+json with conservative caching', async () => {
    const response = await fetch(`${server.baseUrl}/manifest.webmanifest`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/manifest+json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('max-age=0, must-revalidate')
    const manifest = (await response.json()) as Record<string, unknown>
    expect(manifest.id).toBe('/mobile?relay=1')
    expect(manifest.name).toBe('Yive Remote Agent')
    expect(manifest.short_name).toBe('Yive')
    expect(manifest.start_url).toBe('/mobile?relay=1')
    expect(manifest.scope).toBe('/')
    expect(manifest.display).toBe('standalone')
    const icons = manifest.icons as Array<Record<string, unknown>>
    expect(icons).toHaveLength(3)
    expect(icons.some((icon) => icon.purpose === 'maskable')).toBe(true)
    const screenshots = manifest.screenshots as Array<Record<string, unknown>>
    expect(screenshots.map((screenshot) => screenshot.form_factor)).toEqual(['narrow', 'wide'])
    expect(screenshots.map((screenshot) => screenshot.src)).toEqual([
      '/screenshots/mobile-runtime.png',
      '/screenshots/wide-overview.png',
    ])
    const shortcuts = manifest.shortcuts as Array<Record<string, unknown>>
    expect(shortcuts.map((s) => s.url)).toEqual([
      '/mobile?relay=1',
      '/mobile?relay=1&tab=dispatches',
      '/mobile?relay=1&tab=files',
      '/mobile?relay=1&tab=notifications',
      '/',
      '/?action=try-demo',
    ])
  })

  test('sw.js is served as javascript with no-store and unchanged body', async () => {
    const response = await fetch(`${server.baseUrl}/sw.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.text()
    expect(body).toBe(FIXTURE_SW_BODY)
  })

  test('icon assets are served as image/png at non-zero size', async () => {
    for (const name of [
      'icon-32.png',
      'icon-192.png',
      'icon-512.png',
      'icon-512-maskable.png',
      'apple-touch-icon-180.png',
    ]) {
      const response = await fetch(`${server.baseUrl}/icons/${name}`)
      expect(response.status, name).toBe(200)
      expect(response.headers.get('content-type'), name).toBe('image/png')
      const buffer = await response.arrayBuffer()
      expect(buffer.byteLength, name).toBeGreaterThan(0)
    }
  })

  test('screenshot assets are served as image/png', async () => {
    for (const name of ['mobile-runtime.png', 'wide-overview.png']) {
      const response = await fetch(`${server.baseUrl}/screenshots/${name}`)
      expect(response.status, name).toBe(200)
      expect(response.headers.get('content-type'), name).toBe('image/png')
      const buffer = await response.arrayBuffer()
      expect(buffer.byteLength, name).toBeGreaterThan(0)
    }
  })

  test('non-PWA static assets carry no cache-control header', async () => {
    const response = await fetch(`${server.baseUrl}/icons/icon-192.png`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBeNull()
  })
})
