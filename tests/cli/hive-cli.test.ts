import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  assertRelayPairingCanBeUnboundForCli,
  buildMobileLanReportForCli,
  buildMobileRelayPairingUrl,
  buildMobileRelayUrls,
  buildRelayChecklistForCli,
  createMobileRelayUrlsForConnect,
  diagnoseRelayForCli,
  formatLocalRuntimeStatusForCli,
  formatMobileLanReportForCli,
  formatRelayDesktopStatusForCli,
  formatRelayMobileStatusForCli,
  HIVE_USAGE,
  handleHiveInfoCommand,
  listLanIpv4AddressesForCli,
  listRelayOnlineDevicesForCli,
  listRelayPairedDevicesForCli,
  MOBILE_LAN_USAGE,
  MOBILE_NOTIFY_USAGE,
  MOBILE_SEND_FILE_USAGE,
  MOBILE_USAGE,
  migrateLegacyHiveDataDirIfNeeded,
  normalizeRelayServerUrlForCli,
  readDesktopRelaySupervisorStatusForCli,
  readRelayHealthForCli,
  requestRelayPairingToken,
  revokeRelayPairedDeviceForCli,
  runHiveCommand,
  runHiveConnectCommand,
  runHiveMobileCommand,
  runMobileLanCommand,
  runMobileNotifyCommand,
  runMobileSendFileCommand,
  runRelayAdminCommand,
} from '../../src/cli/hive.js'
import {
  defaultRunUpdate,
  HIVE_UPDATE_USAGE,
  type RunUpdate,
  runHiveUpdateCommand,
} from '../../src/cli/hive-update.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

const relayPairedDevicesResponse = () => Response.json({ devices: [] })

const relayPwaManifestResponse = () =>
  Response.json(
    {
      display: 'standalone',
      icons: [
        { sizes: '192x192', src: '/icons/icon-192.png' },
        { purpose: 'maskable', sizes: '512x512', src: '/icons/icon-512-maskable.png' },
      ],
      screenshots: [{ form_factor: 'narrow', src: '/screenshots/mobile-runtime.png' }],
      start_url: '/mobile?relay=1',
    },
    { headers: { 'cache-control': 'max-age=0, must-revalidate' } }
  )

const relayServiceWorkerResponse = () =>
  new Response("self.addEventListener('install', () => {})\n", {
    headers: { 'cache-control': 'no-store', 'content-type': 'text/javascript' },
  })

describe('hive cli', () => {
  test('prints help without starting the runtime', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(handleHiveInfoCommand(['--help'])).toBe(true)

    expect(logSpy).toHaveBeenCalledWith(HIVE_USAGE)
    expect(HIVE_USAGE).toContain('yive relay')
    expect(HIVE_USAGE).toContain('mobile lan')
    expect(HIVE_USAGE).toContain('relay pair')
    expect(HIVE_USAGE).toContain('relay checklist')
    expect(HIVE_USAGE).toContain('--android-package <id>')
    expect(HIVE_USAGE).toContain('relay status')
    expect(HIVE_USAGE).toContain('relay doctor')
    expect(HIVE_USAGE).toContain('optional Android app links')
    expect(HIVE_USAGE).toContain('yive connect')
    expect(HIVE_USAGE).toContain('connect status')
    expect(HIVE_USAGE).toContain('--status-file <path>')
    expect(HIVE_USAGE).toContain('--mobile-url <url>')
    expect(HIVE_USAGE).toContain('--local-request-timeout-ms <ms>')
    expect(HIVE_USAGE).toContain('--require-runtime')
    expect(HIVE_USAGE).toContain('Agent-facing discovery')
    expect(HIVE_USAGE).toContain('yive team --help')
    expect(HIVE_USAGE).not.toMatch(/team (?:list|add|send|report|status|cancel)\b/u)
  })

  test('prints mobile tool help without contacting the runtime', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(runHiveMobileCommand(['--help'])).resolves.toBe(true)

    expect(logSpy).toHaveBeenCalledWith(MOBILE_USAGE)
    expect(MOBILE_USAGE).toContain('Human mobile tools')
    expect(MOBILE_USAGE).not.toContain('Agent-facing mobile tools')
    expect(MOBILE_USAGE).toContain('yive mobile notify "Build done"')
    expect(MOBILE_USAGE).toContain('yive mobile send-file dist/demo.mp4')
  })

  test('prints package version without starting the runtime', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string

    expect(handleHiveInfoCommand(['--version'])).toBe(true)

    expect(logSpy).toHaveBeenCalledWith(version)
  })

  test('rejects unknown arguments instead of ignoring them', async () => {
    await expect(runHiveCommand(['--bogus'])).rejects.toThrow('Unknown option: --bogus')
    await expect(runHiveCommand(['--port', '0', 'extra'])).rejects.toThrow(
      'Unknown argument: extra'
    )
  })

  test('rejects invalid local runtime forwarding timeouts for relay connect', async () => {
    await expect(runHiveConnectCommand(['--local-request-timeout-ms', '0'])).rejects.toThrow(
      "local request timeout must be a positive integer, got '0'."
    )
    await expect(runHiveConnectCommand(['--local-request-timeout-ms', '15.5'])).rejects.toThrow(
      "local request timeout must be a positive integer, got '15.5'."
    )
  })

  test('migrates legacy hive workspaces into the default yive data directory', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'yive-legacy-home-'))
    tempDirs.push(homeDir)
    const legacyDir = join(homeDir, '.config', 'hive')
    const yiveDir = join(homeDir, '.config', 'yive')
    mkdirSync(legacyDir, { recursive: true })
    mkdirSync(yiveDir, { recursive: true })

    const legacyDb = new BetterSqlite3(join(legacyDir, 'runtime.sqlite'))
    legacyDb.exec(
      'CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL)'
    )
    legacyDb
      .prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)')
      .run('workspace-1', 'Legacy Workspace', 'C:/work/legacy', 1)
    legacyDb.close()

    migrateLegacyHiveDataDirIfNeeded(yiveDir, { homeDir })

    expect(existsSync(join(yiveDir, 'runtime.sqlite'))).toBe(true)
    const yiveDb = new BetterSqlite3(join(yiveDir, 'runtime.sqlite'), { readonly: true })
    try {
      expect(yiveDb.prepare('SELECT name, path FROM workspaces').all()).toEqual([
        { name: 'Legacy Workspace', path: 'C:/work/legacy' },
      ])
    } finally {
      yiveDb.close()
    }
  })

  test('starts http server and prints listening address', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await runHiveCommand(['--port', '0'])

    try {
      expect(result.port).toBeGreaterThan(0)
      expect(logSpy).toHaveBeenCalledWith(`Yive running at http://127.0.0.1:${result.port}`)
    } finally {
      await result.close()
    }
  })

  test('filters local LAN IPv4 addresses for mobile URL diagnostics', () => {
    expect(
      listLanIpv4AddressesForCli({
        Docker: [
          {
            address: '172.17.0.1',
            cidr: '172.17.0.1/16',
            family: 'IPv4',
            internal: false,
            mac: '00:00:00:00:00:00',
            netmask: '255.255.0.0',
          },
        ],
        'VMware Network Adapter VMnet8': [
          {
            address: '192.168.33.1',
            cidr: '192.168.33.1/24',
            family: 'IPv4',
            internal: false,
            mac: '00:50:56:c0:00:08',
            netmask: '255.255.255.0',
          },
        ],
        Loopback: [
          {
            address: '127.0.0.1',
            cidr: '127.0.0.1/8',
            family: 'IPv4',
            internal: true,
            mac: '00:00:00:00:00:00',
            netmask: '255.0.0.0',
          },
        ],
        VPN: [
          {
            address: '2.0.0.1',
            cidr: '2.0.0.1/24',
            family: 'IPv4',
            internal: false,
            mac: '00:ff:4c:b7:be:6c',
            netmask: '255.255.255.0',
          },
        ],
        WiFi: [
          {
            address: '192.168.3.20',
            cidr: '192.168.3.20/24',
            family: 'IPv4',
            internal: false,
            mac: '00:00:00:00:00:01',
            netmask: '255.255.255.0',
          },
          {
            address: '169.254.1.2',
            cidr: '169.254.1.2/16',
            family: 'IPv4',
            internal: false,
            mac: '00:00:00:00:00:02',
            netmask: '255.255.0.0',
          },
        ],
      })
    ).toEqual(['192.168.3.20', '172.17.0.1', '192.168.33.1'])
  })

  test('diagnoses a localhost-only mobile LAN preview', async () => {
    const calls: string[] = []
    const report = await buildMobileLanReportForCli({
      addresses: ['192.168.3.20'],
      fetchImpl: async (input) => {
        const url = String(input)
        calls.push(url)
        if (url === 'http://127.0.0.1:5180/mobile') return new Response('ok')
        throw new Error(`Unexpected fetch: ${url}`)
      },
      port: 5180,
      timeoutMs: 1,
    })

    expect(calls).toEqual(['http://127.0.0.1:5180/mobile', 'http://192.168.3.20:5180/mobile'])
    expect(report).toMatchObject({
      checks: { lan: 'offline', localhost: 'online' },
      localhost_url: 'http://127.0.0.1:5180/mobile',
      mobile_urls: ['http://192.168.3.20:5180/mobile'],
      ok: false,
      port: 5180,
    })
    expect(formatMobileLanReportForCli(report)).toContain(
      'Likely cause: Yive is listening on 127.0.0.1 only, so phones on the same Wi-Fi cannot reach it.'
    )
    expect(JSON.stringify(report)).not.toContain('HIVE_AGENT_TOKEN')
  })

  test('prints token-safe JSON for mobile LAN diagnostics', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok'))
    )

    await expect(runMobileLanCommand(['--port', '3001', '--json'])).resolves.toBe(true)

    expect(logSpy).toHaveBeenCalledOnce()
    const report = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '{}')) as {
      next_commands: string[]
      port: number
    }
    expect(report.port).toBe(3001)
    expect(report.next_commands.join('\n')).toContain('yive --port 3001')
    expect(JSON.stringify(report)).not.toContain('secret')
  })

  test('prints mobile LAN help without probing the network', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchSpy = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(runMobileLanCommand(['--help'])).resolves.toBe(true)

    expect(logSpy).toHaveBeenCalledWith(MOBILE_LAN_USAGE)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('rejects unknown mobile LAN arguments', async () => {
    await expect(runMobileLanCommand(['--bogus'])).rejects.toThrow('Unknown option: --bogus')
    await expect(runMobileLanCommand(['extra'])).rejects.toThrow('Unknown argument: extra')
    await expect(runMobileLanCommand(['--port'])).rejects.toThrow('Usage: yive mobile lan')
  })

  test('sends a workspace file to the mobile file exchange from the CLI', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'yive-mobile-file-workspace-'))
    tempDirs.push(workspacePath)
    mkdirSync(join(workspacePath, 'dist'))
    writeFileSync(join(workspacePath, 'dist', 'demo.mp4'), 'demo video')
    const calls: Array<{ body?: unknown; headers?: HeadersInit; method?: string; url: string }> = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const call: { body?: unknown; headers?: HeadersInit; method?: string; url: string } = { url }
      if (typeof init?.body === 'string') call.body = JSON.parse(init.body)
      if (init?.headers) call.headers = init.headers
      if (init?.method) call.method = init.method
      calls.push(call)
      if (url === 'http://127.0.0.1:3001/api/ui/session') {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'set-cookie': 'hive_ui_token=test-cookie; Path=/' },
        })
      }
      if (url === 'http://127.0.0.1:3001/api/workspaces') {
        return Response.json([{ id: 'workspace-1', name: 'Demo Workspace', path: workspacePath }])
      }
      if (url === 'http://127.0.0.1:3001/api/mobile/files/from-workspace') {
        return Response.json(
          {
            id: 'file-1',
            mime_type: 'video/mp4',
            name: 'demo.mp4',
            size: 10,
          },
          { status: 201 }
        )
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    await expect(
      runMobileSendFileCommand(['dist/demo.mp4'], { cwd: workspacePath, fetchImpl })
    ).resolves.toBe(true)

    expect(calls).toEqual([
      expect.objectContaining({ url: 'http://127.0.0.1:3001/api/ui/session' }),
      expect.objectContaining({
        headers: { cookie: 'hive_ui_token=test-cookie' },
        url: 'http://127.0.0.1:3001/api/workspaces',
      }),
      expect.objectContaining({
        body: { path: 'dist/demo.mp4', workspace_id: 'workspace-1' },
        headers: { 'content-type': 'application/json', cookie: 'hive_ui_token=test-cookie' },
        method: 'POST',
        url: 'http://127.0.0.1:3001/api/mobile/files/from-workspace',
      }),
    ])
    expect(logSpy).toHaveBeenCalledWith('Sent to mobile file exchange: demo.mp4')
    expect(logSpy).toHaveBeenCalledWith('Phone: open the Yive mobile Files tab to download it.')
  })

  test('prints machine-readable mobile send-file output', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'yive-mobile-file-json-'))
    tempDirs.push(workspacePath)
    writeFileSync(join(workspacePath, 'report.md'), '# report\n')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'http://127.0.0.1:5180/api/ui/session') {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'set-cookie': 'hive_ui_token=test-cookie; Path=/' },
        })
      }
      if (url === 'http://127.0.0.1:5180/api/workspaces') {
        return Response.json([{ id: 'workspace-1', name: 'Demo Workspace', path: workspacePath }])
      }
      if (url === 'http://127.0.0.1:5180/api/mobile/files/from-workspace') {
        expect(JSON.parse(String(init?.body))).toEqual({
          path: 'report.md',
          workspace_id: 'workspace-1',
        })
        return Response.json({ id: 'file-report', name: 'report.md', size: 9 }, { status: 201 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    await expect(
      runMobileSendFileCommand(['report.md', '--port', '5180', '--json'], {
        cwd: workspacePath,
        fetchImpl,
      })
    ).resolves.toBe(true)

    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '{}')) as {
      download_url: string
      file_id: string
      ok: boolean
      path: string
    }
    expect(output).toMatchObject({
      download_url: 'http://127.0.0.1:5180/api/mobile/files/file-report',
      file_id: 'file-report',
      ok: true,
      path: 'report.md',
    })
  })

  test('uses HIVE_PORT for mobile send-file when no port flag is provided', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'yive-mobile-file-env-port-'))
    tempDirs.push(workspacePath)
    writeFileSync(join(workspacePath, 'report.md'), '# report\n')
    const previousHivePort = process.env.HIVE_PORT
    process.env.HIVE_PORT = '5180'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'http://127.0.0.1:5180/api/ui/session') {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'set-cookie': 'hive_ui_token=test-cookie; Path=/' },
        })
      }
      if (url === 'http://127.0.0.1:5180/api/workspaces') {
        return Response.json([{ id: 'workspace-1', name: 'Demo Workspace', path: workspacePath }])
      }
      if (url === 'http://127.0.0.1:5180/api/mobile/files/from-workspace') {
        expect(JSON.parse(String(init?.body))).toEqual({
          path: 'report.md',
          workspace_id: 'workspace-1',
        })
        return Response.json({ id: 'file-report', name: 'report.md', size: 9 }, { status: 201 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    try {
      await expect(
        runMobileSendFileCommand(['report.md', '--json'], {
          cwd: workspacePath,
          fetchImpl,
        })
      ).resolves.toBe(true)
    } finally {
      if (previousHivePort === undefined) delete process.env.HIVE_PORT
      else process.env.HIVE_PORT = previousHivePort
    }

    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '{}')) as {
      download_url: string
      ok: boolean
    }
    expect(output).toMatchObject({
      download_url: 'http://127.0.0.1:5180/api/mobile/files/file-report',
      ok: true,
    })
  })

  test('prints mobile send-file help without contacting the runtime', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => new Response('ok'))

    await expect(runMobileSendFileCommand(['--help'], { fetchImpl })).resolves.toBe(true)

    expect(logSpy).toHaveBeenCalledWith(MOBILE_SEND_FILE_USAGE)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('sends an agent-authored mobile notification from the CLI', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'yive-mobile-notify-workspace-'))
    tempDirs.push(workspacePath)
    const calls: Array<{ body?: unknown; headers?: HeadersInit; method?: string; url: string }> = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const call: { body?: unknown; headers?: HeadersInit; method?: string; url: string } = { url }
      if (typeof init?.body === 'string') call.body = JSON.parse(init.body)
      if (init?.headers) call.headers = init.headers
      if (init?.method) call.method = init.method
      calls.push(call)
      if (url === 'http://127.0.0.1:3001/api/ui/session') {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'set-cookie': 'hive_ui_token=test-cookie; Path=/' },
        })
      }
      if (url === 'http://127.0.0.1:3001/api/workspaces') {
        return Response.json([{ id: 'workspace-1', name: 'Demo Workspace', path: workspacePath }])
      }
      if (url === 'http://127.0.0.1:3001/api/mobile/notifications') {
        return Response.json(
          {
            notification: {
              body: 'Open Files tab.',
              created_at: 1_700_000_000,
              id: 'notification-1',
              source: 'agent',
              title: 'Build done',
              workspace_id: 'workspace-1',
            },
            feishu: { channel: 'feishu', ok: false, reason: 'not_configured' },
            ok: true,
            wechat: { channel: 'serverchan', ok: false, reason: 'not_configured' },
            workspace_id: 'workspace-1',
          },
          { status: 201 }
        )
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    await expect(
      runMobileNotifyCommand(['Build done', '--body', 'Open Files tab.'], {
        cwd: workspacePath,
        fetchImpl,
      })
    ).resolves.toBe(true)

    expect(calls).toEqual([
      expect.objectContaining({ url: 'http://127.0.0.1:3001/api/ui/session' }),
      expect.objectContaining({
        headers: { cookie: 'hive_ui_token=test-cookie' },
        url: 'http://127.0.0.1:3001/api/workspaces',
      }),
      expect.objectContaining({
        body: {
          body: 'Open Files tab.',
          title: 'Build done',
          workspace_id: 'workspace-1',
        },
        headers: { 'content-type': 'application/json', cookie: 'hive_ui_token=test-cookie' },
        method: 'POST',
        url: 'http://127.0.0.1:3001/api/mobile/notifications',
      }),
    ])
    expect(logSpy).toHaveBeenCalledWith('Sent mobile notification: Build done')
    expect(logSpy).toHaveBeenCalledWith(
      'WeChat: not configured. Set YIVE_WECHAT_SERVERCHAN_SENDKEY to enable it.'
    )
    expect(logSpy).toHaveBeenCalledWith(
      'Feishu: not configured. Set YIVE_FEISHU_WEBHOOK_URL to enable it.'
    )
    expect(logSpy).toHaveBeenCalledWith('Phone: open the Yive mobile Notifications tab to view it.')
  })

  test('sends an agent-authored mobile notification with an image attachment from the CLI', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'yive-mobile-notify-image-workspace-'))
    tempDirs.push(workspacePath)
    mkdirSync(join(workspacePath, 'dist'))
    writeFileSync(join(workspacePath, 'dist', 'preview.png'), 'pixels')
    const calls: Array<{ body?: unknown; headers?: HeadersInit; method?: string; url: string }> = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const call: { body?: unknown; headers?: HeadersInit; method?: string; url: string } = { url }
      if (typeof init?.body === 'string') call.body = JSON.parse(init.body)
      if (init?.headers) call.headers = init.headers
      if (init?.method) call.method = init.method
      calls.push(call)
      if (url === 'http://127.0.0.1:3001/api/ui/session') {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'set-cookie': 'hive_ui_token=test-cookie; Path=/' },
        })
      }
      if (url === 'http://127.0.0.1:3001/api/workspaces') {
        return Response.json([{ id: 'workspace-1', name: 'Demo Workspace', path: workspacePath }])
      }
      if (url === 'http://127.0.0.1:3001/api/mobile/notifications') {
        return Response.json(
          {
            notification: {
              body: 'Open preview.',
              created_at: 1_700_000_000,
              id: 'notification-image',
              image: {
                file_id: 'file-preview',
                mime_type: 'image/png',
                name: 'preview.png',
                size: 6,
              },
              source: 'agent',
              title: 'Preview ready',
              workspace_id: 'workspace-1',
            },
            feishu: { channel: 'feishu', ok: true },
            ok: true,
            workspace_id: 'workspace-1',
          },
          { status: 201 }
        )
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    await expect(
      runMobileNotifyCommand(
        ['Preview ready', '--body', 'Open preview.', '--image', 'dist/preview.png'],
        {
          cwd: workspacePath,
          fetchImpl,
        }
      )
    ).resolves.toBe(true)

    expect(calls).toContainEqual(
      expect.objectContaining({
        body: {
          body: 'Open preview.',
          image_path: 'dist/preview.png',
          title: 'Preview ready',
          workspace_id: 'workspace-1',
        },
        method: 'POST',
        url: 'http://127.0.0.1:3001/api/mobile/notifications',
      })
    )
    expect(logSpy).toHaveBeenCalledWith('Image attachment: preview.png')
    expect(logSpy).toHaveBeenCalledWith('Feishu: pushed via bot webhook.')
  })

  test('prints machine-readable mobile notify output', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'yive-mobile-notify-json-'))
    tempDirs.push(workspacePath)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'http://127.0.0.1:5180/api/ui/session') {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'set-cookie': 'hive_ui_token=test-cookie; Path=/' },
        })
      }
      if (url === 'http://127.0.0.1:5180/api/workspaces') {
        return Response.json([{ id: 'workspace-1', name: 'Demo Workspace', path: workspacePath }])
      }
      if (url === 'http://127.0.0.1:5180/api/mobile/notifications') {
        return Response.json(
          {
            notification: {
              body: 'Need review.',
              created_at: 1_700_000_000,
              id: 'notification-json',
              source: 'agent',
              title: 'Review needed',
              workspace_id: 'workspace-1',
            },
            ok: true,
            workspace_id: 'workspace-1',
          },
          { status: 201 }
        )
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    await expect(
      runMobileNotifyCommand(
        ['Review needed', '--body', 'Need review.', '--port', '5180', '--json'],
        {
          cwd: workspacePath,
          fetchImpl,
        }
      )
    ).resolves.toBe(true)

    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '{}')) as {
      notification: { id: string; title: string }
      ok: boolean
      workspace_id: string
    }
    expect(output).toMatchObject({
      notification: { id: 'notification-json', title: 'Review needed' },
      ok: true,
      workspace_id: 'workspace-1',
    })
  })

  test('prints mobile notify help without contacting the runtime', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => new Response('ok'))

    await expect(runMobileNotifyCommand(['--help'], { fetchImpl })).resolves.toBe(true)

    expect(logSpy).toHaveBeenCalledWith(MOBILE_NOTIFY_USAGE)
    expect(MOBILE_NOTIFY_USAGE).toContain('Use this when a long task completes')
    expect(MOBILE_NOTIFY_USAGE).toContain('YIVE_FEISHU_WEBHOOK_URL')
    expect(MOBILE_NOTIFY_USAGE).toContain('yive mobile notify "Need review"')
    expect(MOBILE_NOTIFY_USAGE).toContain('yive mobile notify "File ready"')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('prints a non-blocking update hint after startup when a newer npm version exists', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await runHiveCommand(['--port', '0'], {
      versionService: {
        getVersionInfo: async () => ({
          current_version: '0.6.0-alpha.3',
          install_hint: 'yive update',
          latest_version: '0.6.0-alpha.4',
          package_name: 'yive',
          release_url: 'https://www.npmjs.com/package/yive/v/0.6.0-alpha.4',
          update_available: true,
        }),
      },
    })

    try {
      await vi.waitFor(() => {
        expect(logSpy).toHaveBeenCalledWith(
          'Yive update available: 0.6.0-alpha.3 -> 0.6.0-alpha.4. Run: yive update'
        )
      })
    } finally {
      await result.close()
    }
  })
})

describe('yive connect cli', () => {
  test('normalizes bare relay addresses for CLI commands', () => {
    expect(normalizeRelayServerUrlForCli('relay.yive.test')).toBe('https://relay.yive.test')
    expect(normalizeRelayServerUrlForCli('relay.example.com')).toBe('https://relay.example.com')
    expect(normalizeRelayServerUrlForCli('203.0.113.10:3001')).toBe('http://203.0.113.10:3001')
    expect(normalizeRelayServerUrlForCli('localhost:3001')).toBe('http://localhost:3001')
    expect(normalizeRelayServerUrlForCli('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001')
  })

  test('formats local runtime diagnostics for relay connect', () => {
    expect(
      formatLocalRuntimeStatusForCli({ runtimeStatus: 'online' }, 'http://127.0.0.1:3001')
    ).toEqual(['Local runtime: online'])

    expect(
      formatLocalRuntimeStatusForCli(
        { runtimeMessage: 'Local runtime session failed: 500', runtimeStatus: 'offline' },
        'http://127.0.0.1:3001'
      )
    ).toEqual([
      'Local runtime: offline (Local runtime session failed: 500)',
      'Hint: start local yive on http://127.0.0.1:3001 before using this desktop from mobile.',
    ])
  })

  test('can require the local runtime before connecting this desktop to relay', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = String(input)
        calls.push(url)
        if (url === 'https://relay.example/pairings') return Response.json({ token: 'short-token' })
        throw new Error(`Unexpected fetch: ${url}`)
      })
    )

    await expect(
      runHiveConnectCommand([
        '--server',
        'https://relay.example',
        '--token',
        'admin',
        '--device-id',
        'desktop-1',
        '--runtime',
        'http://127.0.0.1:1',
        '--local-request-timeout-ms',
        '1000',
        '--require-runtime',
      ])
    ).rejects.toThrow('Local runtime is required before connecting this desktop to Relay.')

    expect(calls).toEqual(['https://relay.example/pairings', 'http://127.0.0.1:1/api/ui/session'])
    expect(calls.some((url) => url.includes('/ws/desktop'))).toBe(false)
    expect(logSpy).toHaveBeenCalledWith('Yive desktop relay device: desktop-1')
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Local runtime: offline'))
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('prints a read-only desktop relay readiness status without opening a relay socket', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = String(input)
        calls.push(url)
        if (url === 'http://127.0.0.1:3001/api/ui/session') {
          return new Response(null, { headers: { 'set-cookie': 'hive_ui_token=test; Path=/' } })
        }
        if (url === 'https://relay.example/health') {
          return Response.json({
            desktop_count: 1,
            mobile_count: 1,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
            version: '1.4.0',
          })
        }
        if (url === 'https://relay.example/devices') {
          return Response.json({
            desktops: [
              {
                device_id: 'desktop-1',
                runtime_status: 'online',
                runtime_updated_at: 1_700_000_000,
              },
            ],
            mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
          })
        }
        throw new Error(`Unexpected fetch: ${url}`)
      })
    )

    await expect(
      runHiveConnectCommand([
        'status',
        '--server',
        'relay.example',
        '--token',
        'admin-token',
        '--device-id',
        'desktop-1',
        '--runtime',
        'http://127.0.0.1:3001',
      ])
    ).resolves.toBe(true)

    expect(calls).toEqual([
      'http://127.0.0.1:3001/api/ui/session',
      'https://relay.example/health',
      'https://relay.example/devices',
    ])
    expect(calls.some((url) => url.includes('/ws/desktop'))).toBe(false)
    expect(logSpy).toHaveBeenCalledWith('Yive connect status: desktop-1')
    expect(logSpy).toHaveBeenCalledWith('Local runtime: online')
    expect(logSpy).toHaveBeenCalledWith('Relay: https://relay.example')
    expect(logSpy).toHaveBeenCalledWith('[ok] Relay HTTP: hive-relay 1.4.0')
    expect(logSpy).toHaveBeenCalledWith('[ok] Token: accepted')
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ok] Desktop registration: desktop-1 (online')
    )
    expect(logSpy).toHaveBeenCalledWith('[ok] Mobile routing: 1 phone targets this desktop.')
  })

  test('connect status can diagnose a missing relay desktop registration', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = String(input)
        if (url === 'http://127.0.0.1:3001/api/ui/session') {
          return new Response(null, { headers: { 'set-cookie': 'hive_ui_token=test; Path=/' } })
        }
        if (url === 'https://relay.example/health') {
          return Response.json({
            desktop_count: 0,
            mobile_count: 1,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url === 'https://relay.example/devices') {
          return Response.json({
            desktops: [],
            mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
          })
        }
        throw new Error(`Unexpected fetch: ${url}`)
      })
    )

    await expect(
      runHiveConnectCommand([
        'status',
        '--server',
        'https://relay.example',
        '--token',
        'admin-token',
        '--device-id',
        'desktop-1',
      ])
    ).resolves.toBe(true)

    expect(logSpy).toHaveBeenCalledWith(
      '[warn] Desktop registration: desktop-1 is not currently connected to Relay.'
    )
    expect(logSpy).toHaveBeenCalledWith(
      'Next: start yive connect --server https://relay.example --token <token> --device-id desktop-1 --runtime http://127.0.0.1:3001.'
    )
    expect(logSpy).toHaveBeenCalledWith(
      '[fail] Mobile routing: phone-1 targets this desktop, but it is offline.'
    )
  })

  test('connect status can print token-safe JSON for automation', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = String(input)
        calls.push(url)
        if (url === 'http://127.0.0.1:3001/api/ui/session') {
          return new Response(null, { headers: { 'set-cookie': 'hive_ui_token=test; Path=/' } })
        }
        if (url === 'https://relay.example/health') {
          return Response.json({
            desktop_count: 1,
            mobile_count: 1,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
            version: '1.4.0',
          })
        }
        if (url === 'https://relay.example/devices') {
          return Response.json({
            desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
            mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
          })
        }
        throw new Error(`Unexpected fetch: ${url}`)
      })
    )

    await expect(
      runHiveConnectCommand([
        'status',
        '--server',
        'https://relay.example',
        '--token',
        'secret-token',
        '--device-id',
        'desktop-1',
        '--json',
      ])
    ).resolves.toBe(true)

    expect(logSpy).toHaveBeenCalledOnce()
    const report = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '{}')) as {
      checks: Array<{ id: string; tone: string }>
      desktop_id: string
      local_runtime: { runtimeStatus: string }
      ok: boolean
      relay: {
        desktop_registered: boolean
        phones_for_desktop: string[]
        token_provided: boolean
      }
    }
    expect(report).toMatchObject({
      desktop_id: 'desktop-1',
      local_runtime: { runtimeStatus: 'online' },
      ok: true,
      relay: {
        desktop_registered: true,
        phones_for_desktop: ['phone-1'],
        token_provided: true,
      },
    })
    expect(report.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        'local_runtime',
        'relay_http',
        'relay_token',
        'desktop_registration',
        'mobile_routing',
      ])
    )
    expect(JSON.stringify(report)).not.toContain('secret-token')
    expect(calls.some((url) => url.includes('/ws/desktop'))).toBe(false)
  })

  test('connect status can include the Windows desktop relay supervisor status file', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'yive-connect-supervisor-status-'))
    tempDirs.push(dir)
    const statusFile = join(dir, 'desktop-relay-status.json')
    const updatedAt = new Date().toISOString()
    writeFileSync(
      statusFile,
      JSON.stringify({
        device_id: 'desktop-1',
        local_request_timeout_ms: 15000,
        manage_runtime: false,
        message: 'Desktop relay supervisor is running.',
        phase: 'running',
        relay_connect: { exit_code: null, pid: 456, status: 'running' },
        relay_server: 'https://relay.example',
        runtime: { exit_code: null, pid: null, status: 'external' },
        runtime_url: 'http://127.0.0.1:3001',
        updated_at: updatedAt,
      })
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = String(input)
        if (url === 'http://127.0.0.1:3001/api/ui/session') {
          return new Response(null, { headers: { 'set-cookie': 'hive_ui_token=test; Path=/' } })
        }
        if (url === 'https://relay.example/health') {
          return Response.json({
            desktop_count: 1,
            mobile_count: 1,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url === 'https://relay.example/devices') {
          return Response.json({
            desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
            mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
          })
        }
        throw new Error(`Unexpected fetch: ${url}`)
      })
    )

    await expect(
      runHiveConnectCommand([
        'status',
        '--server',
        'https://relay.example',
        '--token',
        'secret-token',
        '--device-id',
        'desktop-1',
        '--status-file',
        statusFile,
      ])
    ).resolves.toBe(true)

    expect(logSpy).toHaveBeenCalledWith('Desktop relay supervisor: running')
    expect(logSpy).toHaveBeenCalledWith('Supervisor runtime: external')
    expect(logSpy).toHaveBeenCalledWith('Supervisor relay-connect: running pid=456')
    expect(logSpy).toHaveBeenCalledWith('[ok] Mobile routing: 1 phone targets this desktop.')
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain('secret-token')

    expect(
      readDesktopRelaySupervisorStatusForCli(statusFile, Date.parse(updatedAt) + 16_000)
    ).toMatchObject({
      found: true,
      phase: 'running',
      stale: true,
      status_file: statusFile,
    })
  })

  test('connect status reads the supervisor status file from the environment by default', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'yive-connect-supervisor-env-'))
    tempDirs.push(dir)
    const statusFile = join(dir, 'desktop-relay-status.json')
    writeFileSync(
      statusFile,
      JSON.stringify({
        device_id: 'desktop-env',
        message: 'Relay connect process started.',
        phase: 'relay_connect_started',
        relay_connect: { exit_code: null, pid: 789, status: 'running' },
        runtime: { exit_code: null, pid: null, status: 'external' },
        updated_at: new Date().toISOString(),
      })
    )
    vi.stubEnv('YIVE_RELAY_STATUS_FILE', statusFile)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = String(input)
        if (url === 'http://127.0.0.1:3001/api/ui/session') {
          return new Response(null, { headers: { 'set-cookie': 'hive_ui_token=test; Path=/' } })
        }
        if (url === 'https://relay.example/health') {
          return Response.json({
            desktop_count: 1,
            mobile_count: 0,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url === 'https://relay.example/devices') {
          return Response.json({
            desktops: [{ device_id: 'desktop-env', runtime_status: 'online' }],
            mobiles: [],
          })
        }
        throw new Error(`Unexpected fetch: ${url}`)
      })
    )

    await expect(
      runHiveConnectCommand([
        'status',
        '--server',
        'https://relay.example',
        '--token',
        'secret-token',
        '--device-id',
        'desktop-env',
      ])
    ).resolves.toBe(true)

    expect(logSpy).toHaveBeenCalledWith('Desktop relay supervisor: relay_connect_started')
    expect(logSpy).toHaveBeenCalledWith('Supervisor relay-connect: running pid=789')
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain('secret-token')
  })

  test('formats relay desktop runtime status for CLI output', () => {
    expect(formatRelayDesktopStatusForCli({ device_id: 'desktop-1' })).toBe('desktop-1')
    expect(
      formatRelayDesktopStatusForCli({ device_id: 'desktop-1', runtime_status: 'online' })
    ).toBe('desktop-1 (online)')
    expect(
      formatRelayDesktopStatusForCli({
        device_id: 'desktop-1',
        runtime_message: 'Local runtime\nsession failed',
        runtime_status: 'offline',
      })
    ).toBe('desktop-1 (offline; Local runtime session failed)')
    expect(
      formatRelayDesktopStatusForCli(
        {
          connected_at: 1_699_990_000,
          device_id: 'desktop-1',
          last_seen_at: 1_700_009_000,
          runtime_status: 'online',
          runtime_updated_at: 1_700_000_000,
        },
        1_700_010_000
      )
    ).toBe('desktop-1 (online; updated 10s ago; connected 20s ago; seen 1s ago)')
    expect(
      formatRelayDesktopStatusForCli(
        {
          device_id: 'desktop-1',
          runtime_message: 'Local runtime down',
          runtime_status: 'offline',
          runtime_updated_at: 1_700_000_000,
        },
        1_700_061_000
      )
    ).toBe('desktop-1 (offline; Local runtime down; stale 1m ago)')
    expect(
      formatRelayMobileStatusForCli(
        {
          connected_at: 1_699_990_000,
          desktop_id: 'desktop-1',
          device_id: 'phone-1',
          last_seen_at: 1_700_009_000,
        },
        1_700_010_000
      )
    ).toBe('phone-1 -> desktop-1 (connected 20s ago; seen 1s ago)')
  })

  test('builds mobile pairing and direct desktop URLs for relay connections', () => {
    expect(
      buildMobileRelayPairingUrl({
        mobileUrl: 'https://app.yive.test',
        serverUrl: 'https://relay.yive.test',
        token: 'pair token',
      })
    ).toBe(
      'https://app.yive.test/mobile?relay=1&token=pair+token&server=https%3A%2F%2Frelay.yive.test'
    )
    expect(
      buildMobileRelayUrls({
        deviceId: 'desktop-1',
        mobileUrl: 'https://app.yive.test',
        serverUrl: 'https://relay.yive.test',
        token: 'pair token',
      })
    ).toEqual({
      directUrl:
        'https://app.yive.test/mobile?relay=1&token=pair+token&server=https%3A%2F%2Frelay.yive.test&claim=1&desktop_id=desktop-1',
      pairingUrl:
        'https://app.yive.test/mobile?relay=1&token=pair+token&server=https%3A%2F%2Frelay.yive.test',
    })
  })

  test('uses the relay server URL as the mobile URL by default', () => {
    expect(
      buildMobileRelayUrls({
        deviceId: 'desktop-1',
        serverUrl: 'http://203.0.113.10',
        token: 'pair-token',
      }).pairingUrl
    ).toBe('http://203.0.113.10/mobile?relay=1&token=pair-token&server=http%3A%2F%2F203.0.113.10')
  })

  test('normalizes bare relay and mobile URLs while building pairing links', () => {
    expect(
      buildMobileRelayUrls({
        deviceId: 'desktop-1',
        mobileUrl: 'app.yive.test',
        serverUrl: 'relay.yive.test',
        token: 'pair-token',
      })
    ).toEqual({
      directUrl:
        'https://app.yive.test/mobile?relay=1&token=pair-token&server=https%3A%2F%2Frelay.yive.test&claim=1&desktop_id=desktop-1',
      pairingUrl:
        'https://app.yive.test/mobile?relay=1&token=pair-token&server=https%3A%2F%2Frelay.yive.test',
    })
  })

  test('requests a short-lived mobile pairing token from the relay', async () => {
    const calls: Array<{ headers?: HeadersInit; method?: string; url: string }> = []
    const token = await requestRelayPairingToken({
      adminToken: 'admin-token',
      fetchImpl: async (input, init) => {
        calls.push({
          ...(init?.headers ? { headers: init.headers } : {}),
          ...(init?.method ? { method: init.method } : {}),
          url: String(input),
        })
        return Response.json({ expires_at: Date.now() + 600_000, token: 'short-token' })
      },
      serverUrl: 'https://relay.example',
    })

    expect(token).toBe('short-token')
    expect(calls).toEqual([
      {
        headers: { authorization: 'Bearer admin-token' },
        method: 'POST',
        url: 'https://relay.example/pairings',
      },
    ])
  })

  test('normalizes bare relay URLs before requesting pairing tokens', async () => {
    const calls: string[] = []
    const token = await requestRelayPairingToken({
      adminToken: 'admin-token',
      fetchImpl: async (input) => {
        calls.push(String(input))
        return Response.json({ expires_at: Date.now() + 600_000, token: 'short-token' })
      },
      serverUrl: 'relay.example',
    })

    expect(token).toBe('short-token')
    expect(calls).toEqual(['https://relay.example/pairings'])
  })

  test('creates connect mobile URLs only with short-lived pairing tokens', async () => {
    const urls = await createMobileRelayUrlsForConnect({
      adminToken: 'admin-token',
      deviceId: 'desktop-1',
      fetchImpl: async () => Response.json({ expires_at: Date.now() + 600_000, token: 'short' }),
      mobileUrl: 'https://app.yive.test',
      serverUrl: 'https://relay.yive.test',
    })

    expect(urls).toEqual({
      directUrl:
        'https://app.yive.test/mobile?relay=1&token=short&server=https%3A%2F%2Frelay.yive.test&claim=1&desktop_id=desktop-1',
      pairingUrl:
        'https://app.yive.test/mobile?relay=1&token=short&server=https%3A%2F%2Frelay.yive.test',
    })
  })

  test('refuses unbound relay pairing links when the relay requires desktop binding', async () => {
    await expect(
      assertRelayPairingCanBeUnboundForCli({
        fetchImpl: async (input) => {
          expect(String(input)).toBe('https://relay.yive.test/health')
          return Response.json({
            desktop_count: 1,
            mobile_count: 0,
            ok: true,
            pairing_store: {
              device_token_count: 0,
              issued_token_count: 0,
              persistent: true,
              require_desktop_binding: true,
            },
            protocol_version: 1,
            service: 'hive-relay',
          })
        },
        serverUrl: 'https://relay.yive.test',
      })
    ).rejects.toThrow(
      'Relay requires desktop-bound mobile tokens. Re-run with --desktop-id <desktop-id> so the phone link can control that computer.'
    )
  })

  test('allows unbound relay pairing links when desktop binding is not required', async () => {
    await expect(
      assertRelayPairingCanBeUnboundForCli({
        fetchImpl: async () =>
          Response.json({
            desktop_count: 1,
            mobile_count: 0,
            ok: true,
            pairing_store: {
              device_token_count: 0,
              issued_token_count: 0,
              persistent: true,
              require_desktop_binding: false,
            },
            protocol_version: 1,
            service: 'hive-relay',
          }),
        serverUrl: 'https://relay.yive.test',
      })
    ).resolves.toBeUndefined()
  })

  test('does not fall back to a long-lived relay token in connect mobile URLs', async () => {
    const errors: string[] = []
    const urls = await createMobileRelayUrlsForConnect({
      adminToken: 'admin-secret-token',
      deviceId: 'desktop-1',
      fetchImpl: async () => Response.json({ error: 'nope' }, { status: 401 }),
      onError: (message) => errors.push(message),
      serverUrl: 'https://relay.yive.test',
    })

    expect(urls).toBeNull()
    expect(errors).toEqual([
      'Could not create a short-lived mobile pairing token: Relay pairing request failed: 401',
      'Mobile pairing URL was not printed because Yive will not put a long-lived relay token in a mobile URL.',
      'Check relay status with: yive relay status --server https://relay.yive.test --token <token>',
    ])
    expect(JSON.stringify(errors)).not.toContain('admin-secret-token')
  })

  test('rejects malformed relay pairing responses', async () => {
    await expect(
      requestRelayPairingToken({
        adminToken: 'admin-token',
        fetchImpl: async () => Response.json({}),
        serverUrl: 'https://relay.example',
      })
    ).rejects.toThrow('Relay pairing response did not include a token')
  })
})

describe('yive relay admin cli', () => {
  test('reads relay health for status diagnostics', async () => {
    const calls: Array<{ url: string }> = []
    const health = await readRelayHealthForCli({
      fetchImpl: async (input) => {
        calls.push({ url: String(input) })
        return Response.json({
          desktop_count: 1,
          deployment: {
            public_url_configured: true,
          },
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
          uptime_ms: 12_345,
          version: '1.4.0',
        })
      },
      serverUrl: 'https://relay.example',
    })

    expect(health).toEqual({
      desktop_count: 1,
      deployment: {
        public_url_configured: true,
      },
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
      uptime_ms: 12_345,
      version: '1.4.0',
    })
    expect(calls).toEqual([{ url: 'https://relay.example/health' }])
  })

  test('rejects health responses from non-relay services', async () => {
    await expect(
      readRelayHealthForCli({
        fetchImpl: async () =>
          Response.json({
            desktop_count: 0,
            mobile_count: 0,
            ok: true,
            service: 'other-service',
          }),
        serverUrl: 'https://relay.example',
      })
    ).rejects.toThrow('Relay health response was invalid: expected service=hive-relay')
  })

  test('lists online relay devices for status diagnostics', async () => {
    const calls: Array<{ headers?: HeadersInit; url: string }> = []
    const devices = await listRelayOnlineDevicesForCli({
      fetchImpl: async (input, init) => {
        calls.push({
          ...(init?.headers ? { headers: init.headers } : {}),
          url: String(input),
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
              connected_at: 1_699_999_000,
              desktop_id: 'desktop-1',
              device_id: 'phone-1',
              last_seen_at: 1_700_000_500,
            },
          ],
        })
      },
      serverUrl: 'https://relay.example',
      token: 'admin-token',
    })

    expect(devices).toEqual({
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
          connected_at: 1_699_999_000,
          desktop_id: 'desktop-1',
          device_id: 'phone-1',
          last_seen_at: 1_700_000_500,
        },
      ],
    })
    expect(calls).toEqual([
      {
        headers: { authorization: 'Bearer admin-token' },
        url: 'https://relay.example/devices',
      },
    ])
  })

  test('lists paired relay devices through the admin API', async () => {
    const calls: Array<{ headers?: HeadersInit; url: string }> = []
    const devices = await listRelayPairedDevicesForCli({
      adminToken: 'admin-token',
      fetchImpl: async (input, init) => {
        calls.push({
          ...(init?.headers ? { headers: init.headers } : {}),
          url: String(input),
        })
        return Response.json({
          devices: [
            {
              desktop_id: 'desktop-1',
              device_id: 'phone-1',
              device_kind: 'mobile',
              token_hint: 'abc123...wxyz',
              workspace_ids: ['workspace-alpha'],
            },
          ],
        })
      },
      serverUrl: 'https://relay.example',
    })

    expect(devices).toEqual([
      {
        desktop_id: 'desktop-1',
        device_id: 'phone-1',
        device_kind: 'mobile',
        token_hint: 'abc123...wxyz',
        workspace_ids: ['workspace-alpha'],
      },
    ])
    expect(calls).toEqual([
      {
        headers: { authorization: 'Bearer admin-token' },
        url: 'https://relay.example/pairings/devices',
      },
    ])
  })

  test('revokes a paired relay device through the admin API', async () => {
    const calls: Array<{ headers?: HeadersInit; method?: string; url: string }> = []
    const result = await revokeRelayPairedDeviceForCli({
      adminToken: 'admin-token',
      deviceId: 'phone 1',
      fetchImpl: async (input, init) => {
        calls.push({
          ...(init?.headers ? { headers: init.headers } : {}),
          ...(init?.method ? { method: init.method } : {}),
          url: String(input),
        })
        return Response.json({ device_id: 'phone 1', revoked: true })
      },
      serverUrl: 'https://relay.example',
    })

    expect(result).toEqual({ device_id: 'phone 1', revoked: true })
    expect(calls).toEqual([
      {
        headers: { authorization: 'Bearer admin-token' },
        method: 'DELETE',
        url: 'https://relay.example/pairings/devices/phone%201',
      },
    ])
  })

  test('prints paired devices and empty device lists', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchResponses = [
      Response.json({
        devices: [
          {
            desktop_id: 'desktop-1',
            device_id: 'phone-1',
            token_hint: 'abc123...wxyz',
            workspace_ids: ['workspace-alpha', 'workspace-beta'],
          },
        ],
      }),
      Response.json({ devices: [] }),
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response = fetchResponses.shift()
        if (!response) throw new Error('unexpected fetch')
        return response
      })
    )

    await expect(
      runRelayAdminCommand(['devices', '--server', 'https://relay.example', '--token', 'admin'])
    ).resolves.toBe(true)
    await expect(
      runRelayAdminCommand(['devices', '--server', 'https://relay.example', '--token', 'admin'])
    ).resolves.toBe(true)

    expect(logSpy).toHaveBeenCalledWith(
      'phone-1\tabc123...wxyz\tdesktop-1\tworkspaces:workspace-alpha,workspace-beta'
    )
    expect(logSpy).toHaveBeenCalledWith('No paired relay devices.')
  })

  test('prints relay status with and without online device ids', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        calls.push(String(input))
        if (String(input).endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            deployment: {
              public_url_configured: true,
            },
            heartbeat_interval_ms: 30_000,
            heartbeat_timeout_ms: 75_000,
            mobile_count: 1,
            ok: true,
            pairing_store: {
              admin_token_default: false,
              device_token_count: 2,
              issued_token_count: 1,
              persistent: true,
              require_desktop_binding: true,
            },
            protocol_version: 1,
            service: 'hive-relay',
            started_at: Date.now() - 65_000,
            static: { mobile_app_available: true },
            terminal_proxy_count: 3,
            uptime_ms: 65_000,
            version: '1.4.0',
          })
        }
        return Response.json({
          desktops: [
            {
              device_id: 'desktop-1',
              runtime_message: 'Local runtime session failed: 500',
              runtime_status: 'offline',
              runtime_updated_at: Date.now() - 45_000,
            },
          ],
          mobiles: [
            {
              connected_at: Date.now() - 20_000,
              desktop_id: 'desktop-1',
              device_id: 'phone-1',
              last_seen_at: Date.now() - 1_000,
            },
          ],
        })
      })
    )

    await expect(
      runRelayAdminCommand(['status', '--server', 'https://relay.example'])
    ).resolves.toBe(true)
    await expect(
      runRelayAdminCommand(['status', '--server', 'https://relay.example', '--token', 'admin'])
    ).resolves.toBe(true)

    expect(calls).toEqual([
      'https://relay.example/health',
      'https://relay.example/health',
      'https://relay.example/devices',
    ])
    expect(logSpy).toHaveBeenCalledWith('Relay: online (hive-relay 1.4.0)')
    expect(logSpy).toHaveBeenCalledWith('Protocol: v1 (CLI supports v2)')
    expect(logSpy).toHaveBeenCalledWith('Uptime: 1m 5s')
    expect(logSpy).toHaveBeenCalledWith('[ok] Public URL: configured for deployment smoke checks')
    expect(logSpy).toHaveBeenCalledWith('[ok] Mobile app: static build available')
    expect(logSpy).toHaveBeenCalledWith(
      '[ok] Pairing store: persistent; 2 paired device token; 1 pending pairing token'
    )
    expect(logSpy).toHaveBeenCalledWith(
      '[ok] Desktop binding: device tokens are scoped to one desktop'
    )
    expect(logSpy).toHaveBeenCalledWith('[ok] Heartbeat: ping every 30s, timeout 1m 15s')
    expect(logSpy).toHaveBeenCalledWith('[ok] Terminal proxies: 3')
    expect(logSpy).toHaveBeenCalledWith('Connections: 1 desktop, 1 mobile')
    expect(logSpy).toHaveBeenCalledWith('Online devices: pass --token to include device ids.')
    expect(logSpy).toHaveBeenCalledWith('Authenticated devices: 1 desktop, 1 mobile')
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Desktops: desktop-1 \(offline; Local runtime session failed: 500; stale \d+s ago\)$/
      )
    )
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Mobiles: phone-1 -> desktop-1 \(connected \d+s ago; seen \d+s ago\)$/)
    )
  })

  test('diagnoses relay without a token', async () => {
    const diagnosis = await diagnoseRelayForCli({
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        return Response.json({
          desktop_count: 1,
          deployment: {
            public_url_configured: false,
          },
          heartbeat_interval_ms: 30_000,
          heartbeat_timeout_ms: 75_000,
          mobile_count: 0,
          ok: true,
          pairing_store: {
            admin_token_default: true,
            device_token_count: 0,
            issued_token_count: 0,
            persistent: false,
            require_desktop_binding: false,
          },
          protocol_version: 1,
          service: 'hive-relay',
          static: { mobile_app_available: false },
          terminal_proxy_count: 0,
          uptime_ms: 65_000,
          version: '1.4.0',
        })
      },
      serverUrl: 'relay.example',
    })

    expect(diagnosis.ok).toBe(false)
    expect(diagnosis.server).toBe('https://relay.example')
    expect(diagnosis.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
    expect(diagnosis.lines).toEqual([
      'Relay doctor: https://relay.example',
      '[ok] Relay HTTP: hive-relay 1.4.0',
      '[ok] Protocol: relay v1, CLI supports v2',
      '[ok] Uptime: 1m 5s',
      '[warn] Public URL: YIVE_RELAY_PUBLIC_URL is not configured',
      'Next: add YIVE_RELAY_PUBLIC_URL=https://relay.example to /etc/yive/relay.env, then run sudo systemctl restart yive-relay.',
      '[fail] Mobile app: static build missing',
      '[warn] Pairing store: in-memory only; 0 paired device token; 0 pending pairing token',
      '[warn] Desktop binding: unbound device tokens can target any desktop',
      'Next: add YIVE_RELAY_REQUIRE_DESKTOP_BINDING=1 to /etc/yive/relay.env, then run sudo systemctl restart yive-relay.',
      '[fail] Relay admin token: using development default; set --token or HIVE_RELAY_DEV_TOKEN.',
      'Next: set YIVE_RELAY_ADMIN_TOKEN=<strong-admin-token> in /etc/yive/relay.env, then restart yive-relay.',
      '[ok] Heartbeat: ping every 30s, timeout 1m 15s',
      '[ok] Terminal proxies: 0',
      '[ok] PWA manifest: mobile relay standalone app',
      '[ok] Service worker: available with no-store update checks',
      '[ok] Connections: 1 desktop, 0 mobile',
      '[warn] Token: not provided; cannot inspect online device ids or desktop runtime status.',
      'Next: run yive relay doctor --server https://relay.example --token <admin-or-device-token>.',
    ])
  })

  test('diagnoses offline desktops behind an online relay', async () => {
    const calls: string[] = []
    const diagnosis = await diagnoseRelayForCli({
      fetchImpl: async (input) => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/health')) {
          return Response.json({
            desktop_count: 0,
            mobile_count: 1,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        if (url.endsWith('/pairings/devices')) return relayPairedDevicesResponse()
        return Response.json({ desktops: [], mobiles: [] })
      },
      serverUrl: 'https://relay.example',
      token: 'admin',
    })

    expect(calls).toEqual([
      'https://relay.example/health',
      'https://relay.example/manifest.webmanifest',
      'https://relay.example/sw.js',
      'https://relay.example/devices',
      'https://relay.example/pairings/devices',
    ])
    expect(diagnosis.ok).toBe(false)
    expect(diagnosis.lines).toContain('[ok] Token: accepted')
    expect(diagnosis.lines).toContain('[fail] Desktop: none online.')
  })

  test('diagnoses Android app links when package details are supplied', async () => {
    const calls: string[] = []
    const diagnosis = await diagnoseRelayForCli({
      androidPackage: 'com.example.yive',
      androidSha256: 'AA:BB:CC',
      fetchImpl: async (input) => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            mobile_count: 0,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        if (url.endsWith('/.well-known/assetlinks.json')) {
          return Response.json([
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
        throw new Error(`Unexpected fetch in Android app links doctor test: ${url}`)
      },
      serverUrl: 'https://relay.example.com',
    })

    expect(calls).toContain('https://relay.example.com/.well-known/assetlinks.json')
    expect(diagnosis.lines).toContain('[ok] Android app links: com.example.yive is authorized')
  })

  test('reports Android app link failures in relay doctor output', async () => {
    const diagnosis = await diagnoseRelayForCli({
      androidPackage: 'com.example.yive',
      androidSha256: 'AA:BB:CC',
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            mobile_count: 0,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        if (url.endsWith('/.well-known/assetlinks.json')) {
          return Response.json([], { status: 200 })
        }
        throw new Error(`Unexpected fetch in Android app links failure test: ${url}`)
      },
      serverUrl: 'https://relay.example.com',
    })

    expect(diagnosis.ok).toBe(false)
    expect(diagnosis.lines).toContain(
      '[fail] Android app links: /.well-known/assetlinks.json does not authorize Android package com.example.yive with the supplied SHA-256 fingerprint'
    )
    expect(diagnosis.lines).toContain(
      'Next: publish web/dist/.well-known/assetlinks.json, confirm the release signing fingerprint, then rerun relay doctor.'
    )
  })

  test('requires Android package and signing fingerprint together in relay doctor', async () => {
    await expect(
      diagnoseRelayForCli({
        androidPackage: 'com.example.yive',
        fetchImpl: async () => Response.json({ ok: true, service: 'hive-relay' }),
        serverUrl: 'https://relay.example.com',
      })
    ).rejects.toThrow('--android-package and --android-sha256 must be provided together')
  })

  test('suggests a pairing command when a desktop is online but no phone is connected', async () => {
    const diagnosis = await diagnoseRelayForCli({
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            mobile_count: 0,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        if (url.endsWith('/pairings/devices')) return relayPairedDevicesResponse()
        return Response.json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
          mobiles: [],
        })
      },
      serverUrl: 'https://relay.example',
      token: 'admin',
    })

    expect(diagnosis.lines).toContain('[warn] Mobile: no phone currently connected.')
    expect(diagnosis.lines).toContain(
      'Next: pair a phone with yive relay pair --server https://relay.example --token <admin-token> --desktop-id desktop-1.'
    )
  })

  test('diagnoses connected desktops with offline local runtime', async () => {
    const now = 1_700_000_000_000
    const diagnosis = await diagnoseRelayForCli({
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            mobile_count: 1,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        if (url.endsWith('/pairings/devices')) return relayPairedDevicesResponse()
        return Response.json({
          desktops: [
            {
              connected_at: now - 10_000,
              device_id: 'desktop-1',
              last_seen_at: now - 1_000,
              runtime_message: 'Local runtime session failed: 500',
              runtime_status: 'offline',
              runtime_updated_at: now - 45_000,
            },
          ],
          mobiles: [
            {
              connected_at: now - 20_000,
              desktop_id: 'desktop-1',
              device_id: 'phone-1',
              last_seen_at: now - 1_000,
            },
          ],
        })
      },
      now,
      serverUrl: 'https://relay.example',
      token: 'admin',
    })

    expect(diagnosis.ok).toBe(false)
    expect(diagnosis.lines).toContain(
      '[ok] Desktop: desktop-1 (offline; Local runtime session failed: 500; stale 45s ago; connected 10s ago; seen 1s ago)'
    )
    expect(diagnosis.lines).toContain(
      '[warn] Local runtime: at least one desktop is connected to Relay but does not report runtime online.'
    )
    expect(diagnosis.lines).toContain(
      '[ok] Mobile: phone-1 -> desktop-1 (connected 20s ago; seen 1s ago)'
    )
    expect(diagnosis.lines).not.toContain(
      'Next: verify the full relay path with pnpm smoke:relay-all -- --server https://relay.example --token <admin-token> --desktop-id desktop-1 --max-stale-ms 30000.'
    )
  })

  test('warns when relay device freshness is stale', async () => {
    const now = 1_700_000_000_000
    const diagnosis = await diagnoseRelayForCli({
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            heartbeat_interval_ms: 30_000,
            heartbeat_timeout_ms: 75_000,
            mobile_count: 1,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        if (url.endsWith('/pairings/devices')) return relayPairedDevicesResponse()
        return Response.json({
          desktops: [
            {
              device_id: 'desktop-1',
              last_seen_at: now - 45_000,
              runtime_status: 'online',
              runtime_updated_at: now - 45_000,
            },
          ],
          mobiles: [
            {
              desktop_id: 'desktop-1',
              device_id: 'phone-1',
              last_seen_at: now - 45_000,
            },
          ],
        })
      },
      now,
      serverUrl: 'https://relay.example',
      token: 'admin',
    })

    expect(diagnosis.ok).toBe(false)
    expect(diagnosis.lines).toContain(
      '[warn] Device freshness: desktop-1 seen 45s ago, phone-1 seen 45s ago.'
    )
    expect(diagnosis.lines).toContain(
      'Next: rerun yive connect on stale desktops, reopen the phone page, then verify with smoke:relay-all -- --max-stale-ms 30000.'
    )
  })

  test('does not suggest terminal smoke testing for unknown desktop runtime status', async () => {
    const diagnosis = await diagnoseRelayForCli({
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            mobile_count: 1,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        if (url.endsWith('/pairings/devices')) return relayPairedDevicesResponse()
        return Response.json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'unknown' }],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      },
      serverUrl: 'https://relay.example',
      token: 'admin',
    })

    expect(diagnosis.ok).toBe(false)
    expect(diagnosis.lines).toContain('[ok] Desktop: desktop-1 (unknown)')
    expect(diagnosis.lines).toContain('[ok] Mobile: phone-1 -> desktop-1')
    expect(diagnosis.lines).toContain(
      '[warn] Local runtime: at least one desktop is connected to Relay but does not report runtime online.'
    )
    expect(diagnosis.lines).not.toContain(
      'Next: verify the full relay path with pnpm smoke:relay-all -- --server https://relay.example --token <admin-token> --desktop-id desktop-1 --max-stale-ms 30000.'
    )
  })

  test('suggests terminal takeover smoke testing when a phone targets an online desktop', async () => {
    const diagnosis = await diagnoseRelayForCli({
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            mobile_count: 1,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        if (url.endsWith('/pairings/devices')) return relayPairedDevicesResponse()
        return Response.json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      },
      serverUrl: 'https://relay.example',
      token: 'admin',
    })

    expect(diagnosis.ok).toBe(true)
    expect(diagnosis.lines).toContain('[ok] Desktop: desktop-1 (online)')
    expect(diagnosis.lines).toContain('[ok] Mobile: phone-1 -> desktop-1')
    expect(diagnosis.lines).toContain(
      'Next: verify the full relay path with pnpm smoke:relay-all -- --server https://relay.example --token <admin-token> --desktop-id desktop-1 --max-stale-ms 30000.'
    )
    expect(diagnosis.lines).toContain(
      'Next: verify real terminal input with pnpm smoke:relay-all -- --server https://relay.example --token <admin-token> --desktop-id desktop-1 --max-stale-ms 30000 --verify-terminal-output.'
    )
    expect(diagnosis.lines).toContain(
      'Next: verify workspace file transfer with pnpm smoke:relay-all -- --server https://relay.example --token <admin-token> --desktop-id desktop-1 --max-stale-ms 30000 --workspace-id <workspace-id> --workspace-file <relative-file>.'
    )
  })

  test('warns when an online desktop is missing mobile remote capabilities', async () => {
    const diagnosis = await diagnoseRelayForCli({
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            mobile_count: 1,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        if (url.endsWith('/pairings/devices')) return relayPairedDevicesResponse()
        return Response.json({
          desktops: [
            {
              device_id: 'desktop-old',
              features: ['mobile_confirmations', 'mobile_file_exchange', 'terminal_proxy'],
              runtime_status: 'online',
            },
          ],
          mobiles: [{ desktop_id: 'desktop-old', device_id: 'phone-1' }],
        })
      },
      serverUrl: 'https://relay.example',
      token: 'admin',
    })

    expect(diagnosis.ok).toBe(false)
    expect(diagnosis.lines).toContain(
      '[warn] Desktop features: desktop-old is missing mobile events.'
    )
    expect(diagnosis.lines).toContain(
      'Next: update yive on those desktops and reconnect them to Relay.'
    )
  })

  test('diagnoses phones that target an offline desktop id', async () => {
    const diagnosis = await diagnoseRelayForCli({
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            mobile_count: 1,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        if (url.endsWith('/pairings/devices')) return relayPairedDevicesResponse()
        return Response.json({
          desktops: [{ device_id: 'desktop-online', runtime_status: 'online' }],
          mobiles: [{ desktop_id: 'desktop-missing', device_id: 'phone-1' }],
        })
      },
      serverUrl: 'https://relay.example',
      token: 'admin',
    })

    expect(diagnosis.ok).toBe(false)
    expect(diagnosis.lines).toContain('[ok] Desktop: desktop-online (online)')
    expect(diagnosis.lines).toContain('[ok] Mobile: phone-1 -> desktop-missing')
    expect(diagnosis.lines).toContain(
      '[fail] Mobile routing: phone-1 targets offline desktop-missing.'
    )
    expect(diagnosis.lines).toContain(
      'Next: connect that desktop, or pair the phone again with the correct desktop id.'
    )
  })

  test('prints relay doctor output from the admin command', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = String(input)
        if (url.endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            mobile_count: 1,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
            version: '1.4.0',
          })
        }
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        if (url.endsWith('/pairings/devices')) return relayPairedDevicesResponse()
        return Response.json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      })
    )

    await expect(
      runRelayAdminCommand(['doctor', '--server', 'relay.example', '--token', 'admin'])
    ).resolves.toBe(true)

    expect(logSpy).toHaveBeenCalledWith('Relay doctor: https://relay.example')
    expect(logSpy).toHaveBeenCalledWith('[ok] Relay HTTP: hive-relay 1.4.0')
    expect(logSpy).toHaveBeenCalledWith('[ok] PWA manifest: mobile relay standalone app')
    expect(logSpy).toHaveBeenCalledWith(
      '[ok] Service worker: available with no-store update checks'
    )
    expect(logSpy).toHaveBeenCalledWith('[ok] Token: accepted')
    expect(logSpy).toHaveBeenCalledWith('[ok] Desktop: desktop-1 (online)')
    expect(logSpy).toHaveBeenCalledWith('[ok] Mobile: phone-1 -> desktop-1')
    expect(logSpy).toHaveBeenCalledWith(
      'Next: verify the full relay path with pnpm smoke:relay-all -- --server https://relay.example --token <admin-token> --desktop-id desktop-1 --max-stale-ms 30000.'
    )
    expect(logSpy).toHaveBeenCalledWith(
      'Next: verify real terminal input with pnpm smoke:relay-all -- --server https://relay.example --token <admin-token> --desktop-id desktop-1 --max-stale-ms 30000 --verify-terminal-output.'
    )
    expect(logSpy).toHaveBeenCalledWith(
      'Next: verify workspace file transfer with pnpm smoke:relay-all -- --server https://relay.example --token <admin-token> --desktop-id desktop-1 --max-stale-ms 30000 --workspace-id <workspace-id> --workspace-file <relative-file>.'
    )
  })

  test('prints Android app link diagnostics from relay doctor command', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = String(input)
        if (url.endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            mobile_count: 0,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        if (url.endsWith('/.well-known/assetlinks.json')) {
          return Response.json([
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
        return Response.json({ desktops: [], mobiles: [] })
      })
    )

    await expect(
      runRelayAdminCommand([
        'doctor',
        '--server',
        'relay.example.com',
        '--android-package',
        'com.example.yive',
        '--android-sha256',
        'AA:BB:CC',
      ])
    ).resolves.toBe(true)

    expect(logSpy).toHaveBeenCalledWith('[ok] Android app links: com.example.yive is authorized')
  })

  test('prints a token-safe public relay checklist from the admin command', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(
      runRelayAdminCommand([
        'checklist',
        '--server',
        'relay.example',
        '--token',
        'secret-token',
        '--desktop-id',
        'desktop-1',
        '--workspace-id',
        'workspace-1',
        '--run-id',
        'run-1',
        '--workspace-file',
        'README.md',
        '--allow-http-only',
      ])
    ).resolves.toBe(true)

    const output = logSpy.mock.calls.map(([line]) => String(line)).join('\n')
    expect(output).toContain('Yive public relay acceptance checklist:')
    expect(output).toContain('Relay: https://relay.example')
    expect(output).toContain('Desktop: desktop-1')
    expect(output).toContain(
      'yive relay doctor --server https://relay.example --token <admin-token> --json'
    )
    expect(output).toContain(
      'yive connect status --server https://relay.example --token <admin-or-device-token> --device-id desktop-1'
    )
    expect(output).toContain(
      'pnpm smoke:relay-all -- --server https://relay.example --token <admin-token> --desktop-id desktop-1 --allow-http-only --timeout-ms 60000 --max-stale-ms 30000'
    )
    expect(output).toContain(
      'pnpm smoke:relay-all -- --server https://relay.example --token <admin-token> --desktop-id desktop-1 --max-stale-ms 30000 --workspace-id workspace-1 --run-id run-1 --verify-terminal-output'
    )
    expect(output).toContain(
      'pnpm smoke:relay-all -- --server https://relay.example --token <admin-token> --desktop-id desktop-1 --max-stale-ms 30000 --workspace-id workspace-1 --workspace-file README.md'
    )
    expect(output).not.toContain('secret-token')
  })

  test('adds Android TWA verification steps to the relay checklist when package details are supplied', () => {
    const lines = buildRelayChecklistForCli([
      'checklist',
      '--server',
      'https://relay.example.com/mobile?relay=1',
      '--desktop-id',
      'desktop-1',
      '--android-package',
      'com.example.yive',
      '--android-sha256',
      'AA:BB:CC',
    ])
    const output = lines.join('\n')

    expect(output).toContain('8. Prepare and verify the Android/TWA app shell:')
    expect(output).toContain('pnpm build')
    expect(output).toContain(
      'pnpm mobile:android:assetlinks -- --out-dir web/dist --android-package com.example.yive --android-sha256 AA:BB:CC'
    )
    expect(output).toContain(
      'pnpm mobile:android:twa -- --domain https://relay.example.com --static-dir web/dist --out-dir android-twa --android-package com.example.yive --android-sha256 AA:BB:CC'
    )
    expect(output).toContain(
      'pnpm mobile:android:verify -- --domain https://relay.example.com --static-dir web/dist --twa-dir android-twa --android-package com.example.yive --android-sha256 AA:BB:CC'
    )
    expect(output).toContain(
      'pnpm smoke:relay-domain -- --domain relay.example.com --android-package com.example.yive --android-sha256 AA:BB:CC'
    )
    expect(output).toContain('9. Manual check: install/open the Android/TWA shell or PWA')
  })

  test('requires Android package and signing fingerprint together in the relay checklist', () => {
    expect(() =>
      buildRelayChecklistForCli([
        'checklist',
        '--server',
        'https://relay.example',
        '--desktop-id',
        'desktop-1',
        '--android-package',
        'com.example.yive',
      ])
    ).toThrow('--android-package and --android-sha256 must be provided together')
  })

  test('builds a relay checklist with placeholders before workspace details are known', () => {
    const lines = buildRelayChecklistForCli([
      'checklist',
      '--server',
      'https://relay.example',
      '--desktop-id',
      'desktop-1',
    ])

    expect(lines).toContain(
      'Terminal target: replace <workspace-id> and <run-id> after opening an Agent.'
    )
    expect(lines).toContain(
      'Workspace file: replace <relative-file> with a real workspace path, for example README.md or demo.mp4.'
    )
    expect(lines.join('\n')).toContain('--workspace-id <workspace-id> --run-id <run-id>')
    expect(lines.join('\n')).toContain(
      '--workspace-id <workspace-id> --workspace-file <relative-file>'
    )
  })

  test('prints paired phone workspace scope in relay doctor output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = String(input)
        if (url.endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            mobile_count: 1,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        if (url.endsWith('/pairings/devices')) {
          return Response.json({
            devices: [
              {
                desktop_id: 'desktop-1',
                device_id: 'phone-scoped',
                device_kind: 'mobile',
                token_hint: 'aaaa...1111',
                workspace_ids: ['workspace-alpha', 'workspace-beta'],
              },
              {
                desktop_id: 'desktop-1',
                device_id: 'phone-all',
                token_hint: 'bbbb...2222',
              },
            ],
          })
        }
        return Response.json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-scoped' }],
        })
      })
    )

    await expect(
      runRelayAdminCommand(['doctor', '--server', 'relay.example', '--token', 'admin'])
    ).resolves.toBe(true)

    expect(logSpy).toHaveBeenCalledWith(
      '[ok] Paired devices: phone-scoped (desktop desktop-1; kind mobile; workspaces workspace-alpha,workspace-beta; token aaaa...1111), phone-all (desktop desktop-1; kind any; workspaces all; token bbbb...2222)'
    )
    expect(logSpy).toHaveBeenCalledWith(
      '[warn] Workspace scope: phone-all can access all workspaces.'
    )
  })

  test('prints relay doctor JSON for App and admin diagnostics', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = String(input)
        if (url.endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            mobile_count: 1,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
            version: '1.4.0',
          })
        }
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        if (url.endsWith('/pairings/devices')) return relayPairedDevicesResponse()
        return Response.json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      })
    )

    await expect(
      runRelayAdminCommand([
        'doctor',
        '--server',
        'relay.example',
        '--token',
        'secret-token',
        '--json',
      ])
    ).resolves.toBe(true)

    expect(logSpy).toHaveBeenCalledOnce()
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '')) as {
      generated_at: string
      lines: string[]
      ok: boolean
      server: string
    }
    expect(payload.ok).toBe(true)
    expect(payload.server).toBe('https://relay.example')
    expect(payload.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
    expect(payload.lines).toContain('[ok] Desktop: desktop-1 (online)')
    expect(payload.lines).toContain(
      'Next: verify real terminal input with pnpm smoke:relay-all -- --server https://relay.example --token <admin-token> --desktop-id desktop-1 --max-stale-ms 30000 --verify-terminal-output.'
    )
    expect(JSON.stringify(payload)).not.toContain('secret-token')
  })

  test('prints structured Android app link diagnostics in relay doctor JSON', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = String(input)
        if (url.endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            mobile_count: 0,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        if (url.endsWith('/.well-known/assetlinks.json')) {
          return Response.json([
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
        return Response.json({ desktops: [], mobiles: [] })
      })
    )

    await expect(
      runRelayAdminCommand([
        'doctor',
        '--server',
        'relay.example.com',
        '--android-package',
        'com.example.yive',
        '--android-sha256',
        'aa:bb:cc',
        '--json',
      ])
    ).resolves.toBe(true)

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '')) as {
      android_app_links?: {
        checked: boolean
        package_name: string
        sha256_fingerprint: string
        status: string
      }
    }
    expect(payload.android_app_links).toEqual({
      checked: true,
      package_name: 'com.example.yive',
      sha256_fingerprint: 'AA:BB:CC',
      status: 'ok',
    })
  })

  test('prints structured Android app link failure details in relay doctor JSON', async () => {
    const diagnosis = await diagnoseRelayForCli({
      androidPackage: 'com.example.yive',
      androidSha256: 'AA:BB:CC',
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            mobile_count: 0,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        if (url.endsWith('/manifest.webmanifest')) return relayPwaManifestResponse()
        if (url.endsWith('/sw.js')) return relayServiceWorkerResponse()
        if (url.endsWith('/.well-known/assetlinks.json')) return Response.json([])
        return Response.json({ desktops: [], mobiles: [] })
      },
      serverUrl: 'https://relay.example.com',
    })

    expect(diagnosis.android_app_links).toMatchObject({
      checked: true,
      error:
        '/.well-known/assetlinks.json does not authorize Android package com.example.yive with the supplied SHA-256 fingerprint',
      package_name: 'com.example.yive',
      sha256_fingerprint: 'AA:BB:CC',
      status: 'failed',
    })
  })

  test('normalizes bare relay server URLs in admin commands', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        calls.push(String(input))
        return Response.json({
          desktop_count: 0,
          mobile_count: 0,
          ok: true,
          protocol_version: 1,
          service: 'hive-relay',
          version: '1.4.0',
        })
      })
    )

    await expect(runRelayAdminCommand(['status', '--server', 'relay.example'])).resolves.toBe(true)

    expect(calls).toEqual(['https://relay.example/health'])
  })

  test('prints relay status as json for automation', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        calls.push(String(input))
        if (String(input).endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            mobile_count: 1,
            ok: true,
            protocol_version: 1,
            service: 'hive-relay',
            started_at: 1_700_000_000,
            uptime_ms: 65_000,
            version: '1.4.0',
          })
        }
        return Response.json({
          desktops: [{ device_id: 'desktop-1' }],
          mobiles: [
            {
              connected_at: 1_699_999_000,
              desktop_id: 'desktop-1',
              device_id: 'phone-1',
              last_seen_at: 1_700_000_500,
            },
          ],
        })
      })
    )

    await expect(
      runRelayAdminCommand(['status', '--server', 'https://relay.example', '--json'])
    ).resolves.toBe(true)
    await expect(
      runRelayAdminCommand([
        'status',
        '--server',
        'https://relay.example',
        '--token',
        'admin',
        '--json',
      ])
    ).resolves.toBe(true)

    expect(calls).toEqual([
      'https://relay.example/health',
      'https://relay.example/health',
      'https://relay.example/devices',
    ])
    expect(logSpy).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({
      client_protocol_version: 2,
      desktop_count: 1,
      devices: null,
      mobile_count: 1,
      ok: true,
      protocol_version: 1,
      protocol_supported: true,
      service: 'hive-relay',
      started_at: 1_700_000_000,
      uptime_ms: 65_000,
      version: '1.4.0',
    })
    expect(JSON.parse(String(logSpy.mock.calls[1]?.[0]))).toEqual({
      client_protocol_version: 2,
      desktop_count: 1,
      devices: {
        desktops: [{ device_id: 'desktop-1' }],
        mobiles: [
          {
            connected_at: 1_699_999_000,
            desktop_id: 'desktop-1',
            device_id: 'phone-1',
            last_seen_at: 1_700_000_500,
          },
        ],
      },
      mobile_count: 1,
      ok: true,
      protocol_version: 1,
      protocol_supported: true,
      service: 'hive-relay',
      started_at: 1_700_000_000,
      uptime_ms: 65_000,
      version: '1.4.0',
    })
  })

  test('warns when relay status reports a newer protocol than the CLI supports', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          desktop_count: 0,
          mobile_count: 0,
          ok: true,
          protocol_version: 3,
          service: 'hive-relay',
          version: '1.5.0',
        })
      )
    )

    await expect(
      runRelayAdminCommand(['status', '--server', 'https://relay.example'])
    ).resolves.toBe(true)

    expect(logSpy).toHaveBeenCalledWith('Protocol: v3 (CLI supports v2)')
    expect(logSpy).toHaveBeenCalledWith(
      'Warning: relay protocol is newer than this CLI; update yive or use a matching relay version.'
    )
  })

  test('marks relay status json as unsupported when the relay protocol is newer', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          desktop_count: 0,
          mobile_count: 0,
          ok: true,
          protocol_version: 3,
          service: 'hive-relay',
          version: '1.5.0',
        })
      )
    )

    await expect(
      runRelayAdminCommand(['status', '--server', 'https://relay.example', '--json'])
    ).resolves.toBe(true)

    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      client_protocol_version: 2,
      protocol_version: 3,
      protocol_supported: false,
    })
  })

  test('prints a short-lived mobile pairing URL from the relay admin pair command', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const calls: Array<{ headers?: HeadersInit; method?: string; url: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        calls.push({
          ...(init?.headers ? { headers: init.headers } : {}),
          ...(init?.method ? { method: init.method } : {}),
          url: String(input),
        })
        return Response.json({ expires_at: Date.now() + 600_000, token: 'short-token' })
      })
    )

    await expect(
      runRelayAdminCommand([
        'pair',
        '--server',
        'https://relay.example',
        '--token',
        'admin-token',
        '--desktop-id',
        'desktop-1',
        '--workspace-id',
        'workspace-alpha',
        '--workspace-id',
        'workspace-beta',
        '--mobile-url',
        'https://app.yive.test',
      ])
    ).resolves.toBe(true)

    expect(calls).toEqual([
      {
        headers: { authorization: 'Bearer admin-token' },
        method: 'POST',
        url: 'https://relay.example/pairings',
      },
    ])
    expect(logSpy).toHaveBeenCalledWith(
      'Mobile pairing URL: https://app.yive.test/mobile?relay=1&token=short-token&server=https%3A%2F%2Frelay.example&workspace_id=workspace-alpha&workspace_id=workspace-beta&claim=1&desktop_id=desktop-1'
    )
    expect(logSpy).toHaveBeenCalledWith('Desktop binding: desktop-1')
    expect(logSpy).toHaveBeenCalledWith('Workspace scope: workspace-alpha, workspace-beta')
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain('Direct desktop URL')
  })

  test('rejects relay pair without desktop id when production binding is enabled', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = String(input)
        calls.push(url)
        if (url === 'https://relay.example/health') {
          return Response.json({
            desktop_count: 1,
            mobile_count: 0,
            ok: true,
            pairing_store: {
              device_token_count: 0,
              issued_token_count: 0,
              persistent: true,
              require_desktop_binding: true,
            },
            protocol_version: 1,
            service: 'hive-relay',
          })
        }
        throw new Error(`Unexpected fetch: ${url}`)
      })
    )

    await expect(
      runRelayAdminCommand(['pair', '--server', 'https://relay.example', '--token', 'admin-token'])
    ).rejects.toThrow(
      'Relay requires desktop-bound mobile tokens. Re-run with --desktop-id <desktop-id> so the phone link can control that computer.'
    )

    expect(calls).toEqual(['https://relay.example/health'])
  })

  test('explains invalid relay status tokens', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        if (String(input).endsWith('/health')) {
          return Response.json({
            desktop_count: 1,
            mobile_count: 0,
            ok: true,
            service: 'hive-relay',
          })
        }
        return Response.json({ error: 'Invalid relay token' }, { status: 401 })
      })
    )

    await expect(
      runRelayAdminCommand(['status', '--server', 'https://relay.example', '--token', 'bad-token'])
    ).rejects.toThrow(
      'Relay devices request failed: 401 (invalid token; use a paired device token or relay admin token)'
    )
  })

  test('prints revoked relay devices', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ device_id: 'phone-1', revoked: true }))
    )

    await expect(
      runRelayAdminCommand([
        'revoke',
        'phone-1',
        '--server',
        'https://relay.example',
        '--token',
        'admin',
      ])
    ).resolves.toBe(true)

    expect(logSpy).toHaveBeenCalledWith('Revoked relay device: phone-1')
  })
})

describe('yive update cli', () => {
  test('--help prints update usage and exits 0 without invoking npm', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let runUpdateInvoked = false
    const runUpdate: RunUpdate = async () => {
      runUpdateInvoked = true
      return { exitCode: 0 }
    }

    const code = await runHiveUpdateCommand(['--help'], { runUpdate })

    expect(code).toBe(0)
    expect(logSpy).toHaveBeenCalledWith(HIVE_UPDATE_USAGE)
    expect(runUpdateInvoked).toBe(false)
  })

  test('successful npm install exits 0 and prints a restart hint', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const runUpdate: RunUpdate = async (command, args) => {
      calls.push({ command, args })
      return { exitCode: 0 }
    }

    const code = await runHiveUpdateCommand([], { runUpdate })

    expect(code).toBe(0)
    expect(calls).toEqual([
      {
        command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        args: ['install', '-g', 'yive@latest'],
      },
    ])
    expect(logSpy).toHaveBeenCalledWith('Running: npm install -g yive@latest')
    expect(logSpy).toHaveBeenCalledWith(
      'Yive updated. Restart any running Yive process to pick up the new version.'
    )
  })

  test('non-zero npm exit propagates the code, prints an error, and offers the manual fallback', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const runUpdate: RunUpdate = async () => ({ exitCode: 7 })

    const code = await runHiveUpdateCommand([], { runUpdate })

    expect(code).toBe(7)
    expect(errorSpy).toHaveBeenCalledWith('npm install exited with code 7.')
    // EACCES / sudo-required installs land here; the recovery hint must be
    // surfaced on this path too, not only on spawn ENOENT.
    expect(errorSpy).toHaveBeenCalledWith(
      'You can run the upgrade manually: npm install -g yive@latest'
    )
  })

  test('spawn error (npm not on PATH) exits 1 and surfaces the manual fallback hint', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const runUpdate: RunUpdate = async () => ({
      exitCode: 1,
      spawnError: new Error('spawn npm ENOENT'),
    })

    const code = await runHiveUpdateCommand([], { runUpdate })

    expect(code).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('Failed to spawn npm: spawn npm ENOENT')
    expect(errorSpy).toHaveBeenCalledWith(
      'You can run the upgrade manually: npm install -g yive@latest'
    )
  })

  test('unknown arguments are rejected before invoking npm', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let runUpdateInvoked = false
    const runUpdate: RunUpdate = async () => {
      runUpdateInvoked = true
      return { exitCode: 0 }
    }

    const code = await runHiveUpdateCommand(['--bogus'], { runUpdate })

    expect(code).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('Unknown argument: --bogus')
    expect(runUpdateInvoked).toBe(false)
  })

  test('on Windows the spawned command is `npm.cmd`, not `npm`', async () => {
    // Without the `.cmd` suffix Node's child_process.spawn cannot resolve the
    // Windows batch shim, so every Windows user would land in the spawn-error
    // fallback. The cross-platform tests cover npm; this one nails Windows.
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const calls: Array<{ command: string }> = []
    const runUpdate: RunUpdate = async (command) => {
      calls.push({ command })
      return { exitCode: 0 }
    }

    await runHiveUpdateCommand([], { runUpdate, platform: 'win32' })

    expect(calls).toEqual([{ command: 'npm.cmd' }])
  })

  test('on darwin and linux the spawned command is `npm`', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    for (const platform of ['darwin', 'linux'] as const) {
      const calls: Array<{ command: string }> = []
      const runUpdate: RunUpdate = async (command) => {
        calls.push({ command })
        return { exitCode: 0 }
      }
      await runHiveUpdateCommand([], { runUpdate, platform })
      expect(calls).toEqual([{ command: 'npm' }])
    }
  })
})

describe('defaultRunUpdate (real spawn)', () => {
  test('translates a non-zero exit from a real child process into RunUpdateResult', async () => {
    // Use node itself as a stand-in for npm: it's guaranteed to be in PATH
    // wherever this test runs. `-e "process.exit(7)"` exercises the entire
    // spawn -> stdio close -> exit-code-translation path that the consumer
    // tests above mock away.
    const result = await defaultRunUpdate(process.execPath, ['-e', 'process.exit(7)'])

    expect(result.exitCode).toBe(7)
    expect(result.spawnError).toBeUndefined()
  })

  test('translates ENOENT from a missing binary into spawnError', async () => {
    const result = await defaultRunUpdate('definitely-not-a-binary-9f3a2c', ['arg'])

    expect(result.exitCode).toBe(1)
    expect(result.spawnError).toBeInstanceOf(Error)
    expect(result.spawnError?.message).toMatch(/ENOENT|spawn/i)
  })
})

describe('hive cli dispatch (real subprocess)', () => {
  // Pin the full chain `process.argv -> src/cli/hive.ts dispatch -> runHiveUpdateCommand`.
  // Every other test in this file stops short of the
  // dispatch glue; this one proves typing `yive update --help` actually
  // reaches the new subcommand rather than falling through to `runHiveCommand`.
  test('`yive update --help` exits 0 with the update usage on stdout', async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child =
          process.platform === 'win32'
            ? spawn(
                'cmd.exe',
                ['/d', '/s', '/c', 'pnpm', 'exec', 'tsx', 'src/cli/hive.ts', 'update', '--help'],
                {
                  stdio: ['ignore', 'pipe', 'pipe'],
                }
              )
            : spawn('pnpm', ['exec', 'tsx', 'src/cli/hive.ts', 'update', '--help'], {
                stdio: ['ignore', 'pipe', 'pipe'],
              })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', reject)
        child.on('close', (code) =>
          resolve({
            code,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          })
        )
      }
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Runs `npm install -g yive@latest`')
    expect(result.stdout).toContain('yive update')
    // Update help must NOT print the generic `hive` usage with `--port`.
    expect(result.stdout).not.toContain('--port <port>')
  })

  test('`yive relay --help` exits 0 without starting the relay server', async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child =
          process.platform === 'win32'
            ? spawn(
                'cmd.exe',
                ['/d', '/s', '/c', 'pnpm', 'exec', 'tsx', 'src/cli/hive.ts', 'relay', '--help'],
                {
                  stdio: ['ignore', 'pipe', 'pipe'],
                }
              )
            : spawn('pnpm', ['exec', 'tsx', 'src/cli/hive.ts', 'relay', '--help'], {
                stdio: ['ignore', 'pipe', 'pipe'],
              })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', reject)
        child.on('close', (code) =>
          resolve({
            code,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          })
        )
      }
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Run the cloud relay server')
    expect(result.stdout).toContain('relay status')
    expect(result.stdout).toContain('yive connect')
    expect(result.stderr).toBe('')
  })

  test('`yive mobile lan --help` exits 0 without starting the runtime', async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child =
          process.platform === 'win32'
            ? spawn(
                'cmd.exe',
                [
                  '/d',
                  '/s',
                  '/c',
                  'pnpm',
                  'exec',
                  'tsx',
                  'src/cli/hive.ts',
                  'mobile',
                  'lan',
                  '--help',
                ],
                {
                  stdio: ['ignore', 'pipe', 'pipe'],
                }
              )
            : spawn('pnpm', ['exec', 'tsx', 'src/cli/hive.ts', 'mobile', 'lan', '--help'], {
                stdio: ['ignore', 'pipe', 'pipe'],
              })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', reject)
        child.on('close', (code) =>
          resolve({
            code,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          })
        )
      }
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('yive mobile lan')
    expect(result.stdout).toContain('--timeout-ms <ms>')
    expect(result.stdout).not.toContain('Yive running at')
    expect(result.stderr).toBe('')
  })

  test('`yive team --help` without Agent authentication publishes only discovery guidance', async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child =
          process.platform === 'win32'
            ? spawn(
                'cmd.exe',
                ['/d', '/s', '/c', 'pnpm', 'exec', 'tsx', 'src/cli/hive.ts', 'team', '--help'],
                {
                  stdio: ['ignore', 'pipe', 'pipe'],
                }
              )
            : spawn('pnpm', ['exec', 'tsx', 'src/cli/hive.ts', 'team', '--help'], {
                stdio: ['ignore', 'pipe', 'pipe'],
              })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', reject)
        child.on('close', (code) =>
          resolve({
            code,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          })
        )
      }
    )

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(
      'Team Help is role-aware and available inside an authenticated Yive Agent session.'
    )
    expect(result.stdout).not.toMatch(/team (?:list|add|send|report|status|cancel)\b/u)
    expect(result.stderr).toBe('')
  })
})
