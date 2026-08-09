#!/usr/bin/env node

import { once } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir, hostname, type NetworkInterfaceInfo, networkInterfaces } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import BetterSqlite3 from 'better-sqlite3'

import {
  type RelayDesktopRuntimeSnapshot,
  readLocalRuntimeStatus,
  runRelayDesktopClient,
} from '../relay/desktop-client.js'
import { runRelayServer } from '../relay/server.js'
import { createAgentManager } from '../server/agent-manager.js'
import { createApp } from '../server/app.js'
import { readPackageVersion } from '../server/package-version.js'
import { createRuntimeStore, type RuntimeStore } from '../server/runtime-store.js'
import { createVersionService, type VersionService } from '../server/version-service.js'
import { runAgentCommand } from './agent.js'
import { runHiveUpdateCommand } from './hive-update.js'
import { runTeamCommand } from './team.js'

interface RunHiveCommandResult {
  port: number
  close: () => Promise<void>
  store: RuntimeStore
}

type RunHiveCommandOptions = {
  versionService?: VersionService
}

type ListenError = Error & {
  address?: string
  code?: string
  port?: number
}

export const SUPPORTED_RELAY_HTTP_PROTOCOL_VERSION = 2
const RELAY_RUNTIME_STALE_MS = 30_000
const REQUIRED_RELAY_DESKTOP_FEATURES = [
  ['mobile_confirmations', 'mobile confirmations'],
  ['mobile_events', 'mobile events'],
  ['mobile_file_exchange', 'mobile file exchange'],
  ['terminal_proxy', 'terminal proxy'],
] as const
type RelayDesktopFeatureLabel = (typeof REQUIRED_RELAY_DESKTOP_FEATURES)[number][1]
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/u

type RelayAndroidAppLinksDiagnostics = {
  checked: boolean
  error?: string
  package_name?: string
  sha256_fingerprint?: string
  status: 'failed' | 'ok' | 'skipped'
}

type RelayDoctorDiagnostics = {
  android_app_links?: RelayAndroidAppLinksDiagnostics
  generated_at: string
  lines: string[]
  ok: boolean
  server: string
}

const normalizeAndroidFingerprintForCli = (value: string): string => value.trim().toUpperCase()

const validateAndroidAssetLinksForCli = (
  assetLinks: unknown,
  {
    packageName,
    sha256Fingerprint,
  }: {
    packageName: string
    sha256Fingerprint: string
  }
): void => {
  const expectedFingerprint = normalizeAndroidFingerprintForCli(sha256Fingerprint)
  if (!Array.isArray(assetLinks)) {
    throw new Error('/.well-known/assetlinks.json must be a JSON array')
  }

  const matched = assetLinks.some((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const candidate = entry as Record<string, unknown>
    const relations = Array.isArray(candidate.relation) ? candidate.relation : []
    const target =
      candidate.target && typeof candidate.target === 'object'
        ? (candidate.target as Record<string, unknown>)
        : null
    const fingerprints = Array.isArray(target?.sha256_cert_fingerprints)
      ? target.sha256_cert_fingerprints
      : []

    return (
      relations.includes('delegate_permission/common.handle_all_urls') &&
      target?.namespace === 'android_app' &&
      target.package_name === packageName &&
      fingerprints
        .map((fingerprint) => normalizeAndroidFingerprintForCli(String(fingerprint)))
        .includes(expectedFingerprint)
    )
  })

  if (!matched) {
    throw new Error(
      `/.well-known/assetlinks.json does not authorize Android package ${packageName} with the supplied SHA-256 fingerprint`
    )
  }
}

export const HIVE_USAGE = [
  'Usage:',
  '  yive [--port <port>]',
  '  yive update',
  '',
  'Options:',
  '  --port <port>   Bind the local runtime to a specific port (default: 3001).',
  '  HIVE_RUNTIME_HOST=0.0.0.0 HIVE_DEV_LAN=1 enables LAN preview for development.',
  '  -h, --help      Print this help.',
  '  -v, --version   Print the installed Yive version.',
  '',
  'Commands:',
  '  update          Upgrade Yive in place via `npm install -g`.',
  '  team --help     Show Hive team command usage from the yive entrypoint.',
  '  agent --help    Show role-aware Agent-safe mobile tools inside a managed Agent session.',
  '  mobile lan      Print and diagnose local LAN mobile URLs: yive mobile lan [--port <port>] [--json].',
  '  mobile notify <title> --body <text>  Send a notification to the phone: yive mobile notify "Build done" --body "Open Files tab" [--image <relative-path>].',
  '  mobile send-file <path>  Send a workspace file to the phone file exchange: yive mobile send-file <relative-path> [--port <port>] [--workspace-id <id>] [--json].',
  '  relay           Run the cloud relay server: yive relay [--port <port>] [--token <token>] [--store-file <path>] [--static-dir <path>] [--heartbeat-interval-ms <ms>] [--heartbeat-timeout-ms <ms>].',
  '  relay status    Show relay health and, with --token, online device counts. Add --json for machine output.',
  '  relay doctor    Diagnose relay reachability, token access, desktop connection, local runtime status, and optional Android app links. Add --json for machine output.',
  '  relay checklist Generate a token-safe public relay acceptance checklist: yive relay checklist --server <url> --desktop-id <id> [--workspace-id <id>] [--run-id <id>] [--workspace-file <path>] [--android-package <id> --android-sha256 <fingerprint>].',
  '  relay pair      Create a short-lived mobile pairing URL: yive relay pair --server <url> --token <admin-token> [--desktop-id <id>] [--workspace-id <id>] [--mobile-url <url>].',
  '  relay devices   List paired mobile devices: yive relay devices --server <url> --token <admin-token>.',
  '  relay revoke    Revoke a paired device: yive relay revoke <device-id> --server <url> --token <admin-token>.',
  '  connect         Connect this desktop to a relay: yive connect --server <url> --token <token> [--device-id <id>] [--runtime <url>] [--mobile-url <url>] [--local-request-timeout-ms <ms>] [--require-runtime].',
  '  connect status  Check local runtime and relay registration without opening a long-lived relay socket. Add --status-file <path> for the Windows supervisor and --json for machine output.',
  '',
  'Agent-facing discovery:',
  '  yive team --help  Show role-aware Team Help inside an authenticated Yive Agent session.',
  '  yive agent --help Show role-aware Agent tools without human administration commands.',
  '',
  'Run `yive team --help` inside a managed Agent session for available Team commands.',
].join('\n')

export const MOBILE_LAN_USAGE = [
  'Usage:',
  '  yive mobile lan [--port <port>] [--timeout-ms <ms>] [--json]',
  '',
  'Print local phone URLs for /mobile and diagnose whether the first LAN URL is reachable.',
  '',
  'Options:',
  '  --port <port>        Web/mobile port to check (default: 5180 for dev web).',
  '  --timeout-ms <ms>    Per-probe timeout in milliseconds (default: 1200).',
  '  --json               Print token-safe machine-readable output.',
  '  -h, --help           Print this help.',
].join('\n')

export const MOBILE_USAGE = [
  'Usage:',
  '  yive mobile <command> [options]',
  '',
  'Human mobile tools:',
  '  notify <title> --body <text>    Alert the phone when work completes, blocks, or needs user attention.',
  '  send-file <relative-path>       Send a workspace artifact to the phone Files tab.',
  '',
  'Diagnostics:',
  '  lan                             Print and diagnose local LAN mobile URLs.',
  '',
  'Examples:',
  '  yive mobile notify "Build done" --body "Open the Files tab to download demo.mp4"',
  '  yive mobile notify "Preview ready" --body "Tap the image preview" --image dist/preview.png',
  '  yive mobile notify "Need review" --body "The agent is blocked and needs your confirmation"',
  '  yive mobile send-file dist/demo.mp4',
  '',
  'Run `yive mobile <command> --help` for command-specific options.',
].join('\n')

export const MOBILE_SEND_FILE_USAGE = [
  'Usage:',
  '  yive mobile send-file <relative-path> [--port <port>] [--workspace-id <id>] [--timeout-ms <ms>] [--json]',
  '',
  'Send a file from the current Hive workspace to the phone file exchange.',
  'The path must be relative to the workspace and must pass the mobile file exchange type/size checks.',
  '',
  'Options:',
  '  --port <port>          Local Yive runtime port (default: HIVE_PORT, then 3001).',
  '  --workspace-id <id>    Workspace id to use. If omitted, Yive matches the current directory.',
  '  --timeout-ms <ms>      Request timeout in milliseconds (default: 5000).',
  '  --json                 Print machine-readable output.',
  '  -h, --help             Print this help.',
].join('\n')

export const MOBILE_NOTIFY_USAGE = [
  'Usage:',
  '  yive mobile notify <title> --body <text> [--image <relative-path>] [--port <port>] [--workspace-id <id>] [--timeout-ms <ms>] [--json]',
  '',
  'Send an agent-authored notification to the Yive mobile Notifications tab.',
  'Use this when a long task completes, the agent is blocked, or a generated artifact needs attention.',
  'If a paired Android app has registered native push, the same message is also delivered through FCM and/or Xiaomi Push.',
  'Set YIVE_WECHAT_SERVERCHAN_SENDKEY=<ServerChan SendKey> on the runtime process to also push it into WeChat.',
  'Set YIVE_FEISHU_WEBHOOK_URL=<Feishu bot webhook URL> on the runtime process to also push it into Feishu.',
  'For --image Feishu pushes, also set YIVE_FEISHU_APP_ID and YIVE_FEISHU_APP_SECRET on the runtime process.',
  '',
  'Examples:',
  '  yive mobile notify "Build done" --body "Open the Files tab to download demo.mp4"',
  '  yive mobile notify "Preview ready" --body "Tap the image preview" --image dist/preview.png',
  '  yive mobile notify "Need review" --body "The agent is blocked and needs your confirmation"',
  '  yive mobile notify "File ready" --body "demo.mp4 has been sent to the phone Files tab" --json',
  '',
  'Options:',
  '  --body <text>         Notification body text.',
  '  --image <path>        Optional workspace-relative image attachment (.png, .jpg, .jpeg, .webp).',
  '  --port <port>         Local Yive runtime port (default: HIVE_PORT, then 3001).',
  '  --workspace-id <id>   Workspace id to use. If omitted, Yive matches the current directory.',
  '  --timeout-ms <ms>     Request timeout in milliseconds (default: 5000).',
  '  --json                Print machine-readable output.',
  '  -h, --help            Print this help.',
].join('\n')

export const handleHiveInfoCommand = (argv: string[]) => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HIVE_USAGE)
    return true
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(readPackageVersion())
    return true
  }
  return false
}

const parsePort = (argv: string[]) => {
  let parsedPort: number | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg !== '--port') {
      if (arg?.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
      if (arg) throw new Error(`Unknown argument: ${arg}`)
      continue
    }

    const value = argv[index + 1]
    if (!value) {
      throw new Error('Usage: yive [--port <port>]')
    }

    const port = Number.parseInt(value, 10)
    if (Number.isNaN(port) || port < 0) {
      throw new Error(`Invalid port: ${value}`)
    }

    parsedPort = port
    index += 1
  }

  return parsedPort ?? 3001
}

const readFlag = (argv: string[], name: string) => {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  return argv[index + 1]
}

const readRepeatedFlag = (argv: string[], name: string): string[] => {
  const values: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue
    const value = argv[index + 1]?.trim()
    if (value) values.push(value)
  }
  return Array.from(new Set(values))
}

const hasFlagValue = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0 && !value.startsWith('--')

const parsePositiveIntegerOption = (
  value: string | undefined,
  label: string
): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || String(parsed) !== value.trim() || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, got '${value}'.`)
  }
  return parsed
}

const parseRequiredPositiveIntegerOption = (value: string, label: string): number =>
  parsePositiveIntegerOption(value, label) as number

const resolveLocalRuntimePortForMobileCli = (portValue: string | undefined): number => {
  if (portValue) return parseRequiredPositiveIntegerOption(portValue, 'port')
  const hivePort = parsePositiveIntegerOption(process.env.HIVE_PORT, 'HIVE_PORT')
  return hivePort ?? 3001
}

const isPrivateLanIpv4 = (address: string): boolean =>
  address.startsWith('10.') ||
  address.startsWith('192.168.') ||
  /^172\.(?:1[6-9]|2\d|3[0-1])\./u.test(address)

const isUsableLanIpv4 = (address: string): boolean =>
  IPV4_PATTERN.test(address) &&
  isPrivateLanIpv4(address) &&
  !address.startsWith('127.') &&
  !address.startsWith('169.254.') &&
  address !== '0.0.0.0'

const scoreLanInterfaceForCli = (name: string) => {
  const normalized = name.toLowerCase()
  if (/\b(wi-?fi|wlan|wireless|ethernet|en\d*)\b/u.test(normalized)) return 0
  if (
    /\b(vmware|virtualbox|vbox|hyper-v|docker|wsl|tap|teredo|loopback|pseudo)\b/u.test(normalized)
  ) {
    return 2
  }
  return 1
}

export const listLanIpv4AddressesForCli = (
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): string[] => {
  const addresses = new Map<string, number>()
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isUsableLanIpv4(entry.address)) continue
      const score = scoreLanInterfaceForCli(name)
      addresses.set(entry.address, Math.min(addresses.get(entry.address) ?? score, score))
    }
  }
  return [...addresses.entries()]
    .sort(([left, leftScore], [right, rightScore]) => {
      const leftPrivate = isPrivateLanIpv4(left) ? 0 : 1
      const rightPrivate = isPrivateLanIpv4(right) ? 0 : 1
      return leftScore - rightScore || leftPrivate - rightPrivate || left.localeCompare(right)
    })
    .map(([address]) => address)
}

type MobileLanProbeStatus = 'offline' | 'online' | 'unknown'

type MobileFileExchangeItemForCli = {
  created_at?: number
  download_url?: string
  expires_at?: number
  id: string
  mime_type?: string
  name: string
  size: number
  source?: string
  workspace_path?: string
}

type MobileNotificationForCli = {
  body: string
  created_at: number
  id: string
  image?: {
    file_id: string
    mime_type: string
    name: string
    size: number
  }
  title: string
  workspace_id: string
}

type WorkspaceSummaryForCli = {
  id: string
  name: string
  path: string
}

type MobileLanReport = {
  addresses: string[]
  checks: {
    lan: MobileLanProbeStatus
    localhost: MobileLanProbeStatus
  }
  localhost_url: string
  mobile_urls: string[]
  next_commands: string[]
  ok: boolean
  port: number
}

const createMobileLanUrl = (host: string, port: number) => `http://${host}:${port}/mobile`

const parseSetCookieHeader = (headers: Headers, cookieName: string): string | null => {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const rawCookies =
    typeof getSetCookie === 'function'
      ? getSetCookie.call(headers)
      : [headers.get('set-cookie')].filter((value): value is string => Boolean(value))
  for (const rawCookie of rawCookies) {
    const firstPart = rawCookie.split(';')[0]?.trim()
    if (!firstPart?.startsWith(`${cookieName}=`)) continue
    return firstPart
  }
  return null
}

const fetchLocalRuntimeJsonForCli = async <T>({
  cookie,
  fetchImpl,
  method = 'GET',
  path,
  port,
  body,
  timeoutMs,
}: {
  body?: unknown
  cookie: string
  fetchImpl: typeof fetch
  method?: string
  path: string
  port: number
  timeoutMs: number
}): Promise<T> => {
  const headers: Record<string, string> = { cookie }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const init: RequestInit = {
    headers,
    method,
    signal: AbortSignal.timeout(timeoutMs),
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  const response = await fetchImpl(`http://127.0.0.1:${port}${path}`, init)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `Local Yive runtime request failed: ${method} ${path} (${response.status})${
        text ? ` ${text}` : ''
      }`
    )
  }
  return (await response.json()) as T
}

const getLocalRuntimeCookieForCli = async ({
  fetchImpl,
  port,
  timeoutMs,
}: {
  fetchImpl: typeof fetch
  port: number
  timeoutMs: number
}): Promise<string> => {
  const response = await fetchImpl(`http://127.0.0.1:${port}/api/ui/session`, {
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`Local Yive runtime is not available on port ${port} (${response.status}).`)
  }
  const cookie = parseSetCookieHeader(response.headers, 'hive_ui_token')
  if (!cookie) {
    throw new Error('Local Yive runtime did not return a UI session cookie.')
  }
  return cookie
}

const isPathInsideOrEqual = (root: string, candidate: string): boolean => {
  const relativePath = relative(root, candidate)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

const normalizeWorkspaceFilePathForCli = (workspacePath: string, inputPath: string): string => {
  const workspaceRoot = realpathSync(workspacePath)
  const absolutePath = realpathSync(resolve(process.cwd(), inputPath))
  if (!isPathInsideOrEqual(workspaceRoot, absolutePath)) {
    throw new Error('File must be inside the selected Yive workspace.')
  }
  const relativePath = relative(workspaceRoot, absolutePath)
  if (!relativePath || relativePath.startsWith('..')) {
    throw new Error('Path must point to a file inside the selected Yive workspace.')
  }
  return relativePath.split(sep).join('/')
}

const pickWorkspaceForFileCli = ({
  cwd = process.cwd(),
  inputPath,
  workspaceId,
  workspaces,
}: {
  cwd?: string
  inputPath: string
  workspaceId?: string
  workspaces: WorkspaceSummaryForCli[]
}): WorkspaceSummaryForCli => {
  if (workspaceId) {
    const workspace = workspaces.find((item) => item.id === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    return workspace
  }

  const candidate = resolve(cwd, inputPath)
  const matches = workspaces
    .map((workspace) => ({ root: realpathSync(workspace.path), workspace }))
    .filter(({ root }) => {
      try {
        return isPathInsideOrEqual(root, realpathSync(candidate))
      } catch {
        return isPathInsideOrEqual(root, resolve(cwd))
      }
    })
    .sort((left, right) => right.root.length - left.root.length)

  const match = matches[0]?.workspace
  if (!match) {
    throw new Error('Could not infer workspace from current directory; pass --workspace-id <id>.')
  }
  return match
}

const probeMobileUrlForCli = async ({
  fetchImpl,
  timeoutMs,
  url,
}: {
  fetchImpl: typeof fetch
  timeoutMs: number
  url: string
}): Promise<MobileLanProbeStatus> => {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok ? 'online' : 'offline'
  } catch {
    return 'offline'
  }
}

export const buildMobileLanReportForCli = async ({
  addresses = listLanIpv4AddressesForCli(),
  fetchImpl = fetch,
  port = 5180,
  timeoutMs = 1200,
}: {
  addresses?: string[]
  fetchImpl?: typeof fetch
  port?: number
  timeoutMs?: number
} = {}): Promise<MobileLanReport> => {
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid port: ${port}`)
  }

  const localhostUrl = createMobileLanUrl('127.0.0.1', port)
  const mobileUrls = addresses.map((address) => createMobileLanUrl(address, port))
  const localhost = await probeMobileUrlForCli({ fetchImpl, timeoutMs, url: localhostUrl })
  const lan =
    mobileUrls.length === 0
      ? 'unknown'
      : mobileUrls.includes(localhostUrl)
        ? localhost
        : await probeMobileUrlForCli({ fetchImpl, timeoutMs, url: mobileUrls[0] ?? localhostUrl })

  const nextCommands = [
    ...(port === 5180
      ? [
          '$env:HIVE_RUNTIME_HOST="0.0.0.0"; $env:HIVE_DEV_LAN="1"; pnpm dev:runtime',
          '$env:HIVE_WEB_HOST="0.0.0.0"; $env:HIVE_WEB_PORT="5180"; pnpm dev:web',
        ]
      : [`$env:HIVE_RUNTIME_HOST="0.0.0.0"; $env:HIVE_DEV_LAN="1"; yive --port ${port}`]),
  ]

  return {
    addresses,
    checks: { lan, localhost },
    localhost_url: localhostUrl,
    mobile_urls: mobileUrls,
    next_commands: nextCommands,
    ok: addresses.length > 0 && lan === 'online',
    port,
  }
}

export const formatMobileLanReportForCli = (report: MobileLanReport): string[] => {
  const lines = ['Yive mobile LAN:']
  lines.push(`Port: ${report.port}`)
  lines.push(`Localhost: ${report.localhost_url} (${report.checks.localhost})`)

  if (report.mobile_urls.length === 0) {
    lines.push('[warn] No LAN IPv4 address was found.')
  } else {
    lines.push('Mobile URL candidates:')
    for (const url of report.mobile_urls) lines.push(`  ${url}`)
    lines.push(
      report.checks.lan === 'online'
        ? '[ok] First mobile URL is reachable from this computer.'
        : '[warn] First mobile URL is not reachable from this computer.'
    )
  }

  if (report.checks.localhost === 'online' && report.checks.lan !== 'online') {
    lines.push(
      'Likely cause: Yive is listening on 127.0.0.1 only, so phones on the same Wi-Fi cannot reach it.'
    )
  }

  lines.push('Next commands for LAN preview:')
  for (const command of report.next_commands) lines.push(`  ${command}`)
  lines.push('Then open the first Mobile URL candidate on the phone.')

  return lines
}

export const runMobileLanCommand = async (argv: string[]) => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(MOBILE_LAN_USAGE)
    return true
  }
  const allowedOptions = new Set(['--json', '--port', '--timeout-ms'])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg) continue
    if (!arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`)
    if (!allowedOptions.has(arg)) throw new Error(`Unknown option: ${arg}`)
    if (arg === '--port' || arg === '--timeout-ms') {
      const value = argv[index + 1]
      if (!value || value.startsWith('-')) {
        throw new Error('Usage: yive mobile lan [--port <port>] [--timeout-ms <ms>] [--json]')
      }
      index += 1
    }
  }
  const port = readFlag(argv, '--port')
  const timeout = readFlag(argv, '--timeout-ms')
  const mobileLanOptions: { port?: number; timeoutMs?: number } = {
    port: port ? parseRequiredPositiveIntegerOption(port, 'port') : 5180,
    timeoutMs: timeout ? parseRequiredPositiveIntegerOption(timeout, 'timeout') : 1200,
  }
  const report = await buildMobileLanReportForCli(mobileLanOptions)
  if (argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    for (const line of formatMobileLanReportForCli(report)) console.log(line)
  }
  return true
}

export const runMobileSendFileCommand = async (
  argv: string[],
  {
    cwd = process.cwd(),
    fetchImpl = fetch,
  }: {
    cwd?: string
    fetchImpl?: typeof fetch
  } = {}
) => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(MOBILE_SEND_FILE_USAGE)
    return true
  }

  const allowedOptions = new Set(['--json', '--port', '--timeout-ms', '--workspace-id'])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg?.startsWith('-')) continue
    if (!allowedOptions.has(arg)) throw new Error(`Unknown option: ${arg}`)
    if (arg === '--port' || arg === '--timeout-ms' || arg === '--workspace-id') {
      const value = argv[index + 1]
      if (!value || value.startsWith('-')) {
        throw new Error('Usage: yive mobile send-file <relative-path> [--port <port>]')
      }
      index += 1
    }
  }

  const filePath = argv.find((arg, index) => {
    if (!arg || arg.startsWith('-')) return false
    const previous = argv[index - 1]
    return previous !== '--port' && previous !== '--timeout-ms' && previous !== '--workspace-id'
  })
  if (!filePath) {
    throw new Error('Usage: yive mobile send-file <relative-path> [--port <port>]')
  }

  const portValue = readFlag(argv, '--port')
  const timeoutValue = readFlag(argv, '--timeout-ms')
  const workspaceId = readFlag(argv, '--workspace-id')
  const port = resolveLocalRuntimePortForMobileCli(portValue)
  const timeoutMs = timeoutValue
    ? parseRequiredPositiveIntegerOption(timeoutValue, 'timeout')
    : 5000
  const cookie = await getLocalRuntimeCookieForCli({ fetchImpl, port, timeoutMs })
  const workspaces = await fetchLocalRuntimeJsonForCli<WorkspaceSummaryForCli[]>({
    cookie,
    fetchImpl,
    path: '/api/workspaces',
    port,
    timeoutMs,
  })
  const workspaceInput: {
    cwd: string
    inputPath: string
    workspaceId?: string
    workspaces: WorkspaceSummaryForCli[]
  } = {
    cwd,
    inputPath: filePath,
    workspaces,
  }
  if (workspaceId) workspaceInput.workspaceId = workspaceId
  const workspace = pickWorkspaceForFileCli(workspaceInput)
  const normalizedPath = normalizeWorkspaceFilePathForCli(workspace.path, resolve(cwd, filePath))
  const item = await fetchLocalRuntimeJsonForCli<MobileFileExchangeItemForCli>({
    body: { path: normalizedPath, workspace_id: workspace.id },
    cookie,
    fetchImpl,
    method: 'POST',
    path: '/api/mobile/files/from-workspace',
    port,
    timeoutMs,
  })
  const downloadUrl = `http://127.0.0.1:${port}/api/mobile/files/${encodeURIComponent(item.id)}`

  if (argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          download_url: downloadUrl,
          file_id: item.id,
          name: item.name,
          ok: true,
          path: normalizedPath,
          size: item.size,
          workspace_id: workspace.id,
          workspace_name: workspace.name,
        },
        null,
        2
      )
    )
    return true
  }

  console.log(`Sent to mobile file exchange: ${item.name}`)
  console.log(`Workspace: ${workspace.name}`)
  console.log(`Path: ${normalizedPath}`)
  console.log(`File id: ${item.id}`)
  console.log('Phone: open the Yive mobile Files tab to download it.')
  console.log(`Local download URL: ${downloadUrl}`)
  return true
}

export const runMobileNotifyCommand = async (
  argv: string[],
  {
    cwd = process.cwd(),
    fetchImpl = fetch,
  }: {
    cwd?: string
    fetchImpl?: typeof fetch
  } = {}
) => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(MOBILE_NOTIFY_USAGE)
    return true
  }

  const allowedOptions = new Set([
    '--body',
    '--image',
    '--json',
    '--port',
    '--timeout-ms',
    '--workspace-id',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg?.startsWith('-')) continue
    if (!allowedOptions.has(arg)) throw new Error(`Unknown option: ${arg}`)
    if (arg !== '--json') {
      const value = argv[index + 1]
      if (!value || value.startsWith('-')) {
        throw new Error('Usage: yive mobile notify <title> --body <text> [--port <port>]')
      }
      index += 1
    }
  }

  const title = argv.find((arg, index) => {
    if (!arg || arg.startsWith('-')) return false
    const previous = argv[index - 1]
    return (
      previous !== '--body' &&
      previous !== '--image' &&
      previous !== '--port' &&
      previous !== '--timeout-ms' &&
      previous !== '--workspace-id'
    )
  })
  const body = readFlag(argv, '--body')
  if (!title || !hasFlagValue(body)) {
    throw new Error('Usage: yive mobile notify <title> --body <text> [--port <port>]')
  }

  const portValue = readFlag(argv, '--port')
  const timeoutValue = readFlag(argv, '--timeout-ms')
  const workspaceId = readFlag(argv, '--workspace-id')
  const imagePath = readFlag(argv, '--image')
  const port = resolveLocalRuntimePortForMobileCli(portValue)
  const timeoutMs = timeoutValue
    ? parseRequiredPositiveIntegerOption(timeoutValue, 'timeout')
    : 5000
  const cookie = await getLocalRuntimeCookieForCli({ fetchImpl, port, timeoutMs })
  const workspaces = await fetchLocalRuntimeJsonForCli<WorkspaceSummaryForCli[]>({
    cookie,
    fetchImpl,
    path: '/api/workspaces',
    port,
    timeoutMs,
  })
  const workspaceInput: {
    cwd: string
    inputPath: string
    workspaceId?: string
    workspaces: WorkspaceSummaryForCli[]
  } = {
    cwd,
    inputPath: '.',
    workspaces,
  }
  if (workspaceId) workspaceInput.workspaceId = workspaceId
  const workspace = pickWorkspaceForFileCli(workspaceInput)
  const response = await fetchLocalRuntimeJsonForCli<{
    feishu?: { channel: string; ok: boolean; reason?: string }
    fcm?: { channel: string; failed?: number; ok: boolean; reason?: string; sent?: number }
    notification: MobileNotificationForCli
    ok: boolean
    wechat?: { channel: string; ok: boolean; reason?: string }
    workspace_id: string
    xiaomi?: { channel: string; failed?: number; ok: boolean; reason?: string; sent?: number }
  }>({
    body: {
      body,
      ...(hasFlagValue(imagePath) ? { image_path: imagePath.trim() } : {}),
      title,
      workspace_id: workspace.id,
    },
    cookie,
    fetchImpl,
    method: 'POST',
    path: '/api/mobile/notifications',
    port,
    timeoutMs,
  })

  if (argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          notification: response.notification,
          ok: true,
          workspace_id: workspace.id,
          workspace_name: workspace.name,
        },
        null,
        2
      )
    )
    return true
  }

  console.log(`Sent mobile notification: ${response.notification.title}`)
  console.log(`Workspace: ${workspace.name}`)
  console.log(`Notification id: ${response.notification.id}`)
  if (response.notification.image) {
    console.log(`Image attachment: ${response.notification.image.name}`)
  }
  if (response.wechat?.ok) {
    console.log('WeChat: pushed via ServerChan.')
  } else if (response.wechat?.reason === 'not_configured') {
    console.log('WeChat: not configured. Set YIVE_WECHAT_SERVERCHAN_SENDKEY to enable it.')
  } else if (response.wechat) {
    console.log(`WeChat: push failed (${response.wechat.reason ?? 'unknown'}).`)
  }
  if (response.feishu?.ok) {
    console.log('Feishu: pushed via bot webhook.')
  } else if (response.feishu?.reason === 'not_configured') {
    console.log('Feishu: not configured. Set YIVE_FEISHU_WEBHOOK_URL to enable it.')
  } else if (response.feishu) {
    console.log(`Feishu: push failed (${response.feishu.reason ?? 'unknown'}).`)
  }
  if (response.fcm?.ok) {
    console.log(`Native push: sent to ${response.fcm.sent ?? 1} Android device(s).`)
  } else if (response.fcm?.reason === 'no_tokens') {
    console.log('Native push: no Android app token registered yet.')
  } else if (response.fcm?.reason === 'not_configured') {
    console.log('Native push: Firebase is not configured on this runtime.')
  } else if (response.fcm) {
    console.log(`Native push: failed (${response.fcm.reason ?? 'unknown'}).`)
  }
  if (response.xiaomi?.ok) {
    console.log(`Xiaomi push: sent to ${response.xiaomi.sent ?? 1} device(s).`)
  } else if (response.xiaomi?.reason === 'no_tokens') {
    console.log('Xiaomi push: no Mi Push RegID registered yet.')
  } else if (response.xiaomi?.reason === 'not_configured') {
    console.log(
      'Xiaomi push: not configured. Set YIVE_XIAOMI_APP_SECRET and YIVE_XIAOMI_PACKAGE_NAME.'
    )
  } else if (response.xiaomi) {
    console.log(`Xiaomi push: failed (${response.xiaomi.reason ?? 'unknown'}).`)
  }
  console.log('Phone: open the Yive mobile Notifications tab to view it.')
  return true
}

export const normalizeRelayServerUrlForCli = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('Relay server URL is required')
  if (URL_SCHEME_PATTERN.test(trimmed)) return trimmed

  const authority = trimmed.split(/[/?#]/u, 1)[0]?.split('@').pop() ?? trimmed
  const host = authority.replace(/:\d+$/u, '').replace(/^\[/u, '').replace(/\]$/u, '')
  const shouldUseHttp =
    host === 'localhost' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(?:1[6-9]|2\d|3[0-1])\./u.test(host) ||
    IPV4_PATTERN.test(host)

  return `${shouldUseHttp ? 'http' : 'https'}://${trimmed}`
}

export const runHiveMobileCommand = (argv: string[]) => {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') {
    console.log(MOBILE_USAGE)
    return Promise.resolve(true)
  }
  if (command === 'lan') return runMobileLanCommand(argv.slice(1))
  if (command === 'notify') return runMobileNotifyCommand(argv.slice(1))
  if (command === 'send-file') return runMobileSendFileCommand(argv.slice(1))
  return Promise.reject(new Error('Usage: yive mobile <lan|notify|send-file>'))
}

export const buildMobileRelayPairingUrl = ({
  mobileUrl,
  serverUrl,
  token,
  workspaceIds,
}: {
  mobileUrl?: string | undefined
  serverUrl: string
  token: string
  workspaceIds?: string[] | undefined
}): string => {
  const normalizedServerUrl = normalizeRelayServerUrlForCli(serverUrl)
  const baseUrl = mobileUrl ? normalizeRelayServerUrlForCli(mobileUrl) : normalizedServerUrl
  const pairingUrl = new URL('/mobile', baseUrl)
  pairingUrl.searchParams.set('relay', '1')
  pairingUrl.searchParams.set('token', token)
  pairingUrl.searchParams.set('server', normalizedServerUrl)
  for (const workspaceId of workspaceIds ?? [])
    pairingUrl.searchParams.append('workspace_id', workspaceId)
  return pairingUrl.toString()
}

export const buildMobileRelayUrls = ({
  deviceId,
  mobileUrl,
  serverUrl,
  token,
  workspaceIds,
}: {
  deviceId: string
  mobileUrl?: string | undefined
  serverUrl: string
  token: string
  workspaceIds?: string[] | undefined
}) => {
  const pairingUrl = buildMobileRelayPairingUrl({ mobileUrl, serverUrl, token, workspaceIds })
  const directUrl = new URL(pairingUrl)
  directUrl.searchParams.set('claim', '1')
  directUrl.searchParams.set('desktop_id', deviceId)

  return {
    directUrl: directUrl.toString(),
    pairingUrl,
  }
}

export const requestRelayPairingToken = async ({
  adminToken,
  fetchImpl = fetch,
  serverUrl,
}: {
  adminToken: string
  fetchImpl?: typeof fetch
  serverUrl: string
}): Promise<string> => {
  const normalizedServerUrl = normalizeRelayServerUrlForCli(serverUrl)
  const response = await fetchImpl(new URL('/pairings', normalizedServerUrl), {
    headers: { authorization: `Bearer ${adminToken}` },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(`Relay pairing request failed: ${response.status}`)
  }
  const body = (await response.json()) as { token?: unknown }
  if (typeof body.token !== 'string' || body.token.trim().length === 0) {
    throw new Error('Relay pairing response did not include a token')
  }
  return body.token
}

export const assertRelayPairingCanBeUnboundForCli = async ({
  fetchImpl = fetch,
  serverUrl,
}: {
  fetchImpl?: typeof fetch
  serverUrl: string
}): Promise<void> => {
  const health = await readRelayHealthForCli({ fetchImpl, serverUrl })
  if (health.pairing_store?.require_desktop_binding !== true) return
  throw new Error(
    'Relay requires desktop-bound mobile tokens. Re-run with --desktop-id <desktop-id> so the phone link can control that computer.'
  )
}

export const createMobileRelayUrlsForConnect = async ({
  adminToken,
  deviceId,
  fetchImpl = fetch,
  mobileUrl,
  onError = console.error,
  serverUrl,
}: {
  adminToken: string
  deviceId: string
  fetchImpl?: typeof fetch
  mobileUrl?: string | undefined
  onError?: (message: string) => void
  serverUrl: string
}): Promise<ReturnType<typeof buildMobileRelayUrls> | null> => {
  const normalizedServerUrl = normalizeRelayServerUrlForCli(serverUrl)
  try {
    const mobileToken = await requestRelayPairingToken({
      adminToken,
      fetchImpl,
      serverUrl: normalizedServerUrl,
    })
    return buildMobileRelayUrls({
      deviceId,
      mobileUrl,
      serverUrl: normalizedServerUrl,
      token: mobileToken,
    })
  } catch (error) {
    onError(
      `Could not create a short-lived mobile pairing token: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    onError(
      'Mobile pairing URL was not printed because Yive will not put a long-lived relay token in a mobile URL.'
    )
    onError(
      `Check relay status with: yive relay status --server ${normalizedServerUrl} --token <token>`
    )
    return null
  }
}

export const listRelayPairedDevicesForCli = async ({
  adminToken,
  fetchImpl = fetch,
  serverUrl,
}: {
  adminToken: string
  fetchImpl?: typeof fetch
  serverUrl: string
}): Promise<
  Array<{
    desktop_id?: string
    device_id: string
    device_kind?: 'desktop' | 'mobile'
    token_hint: string
    workspace_ids?: string[]
  }>
> => {
  const normalizedServerUrl = normalizeRelayServerUrlForCli(serverUrl)
  const response = await fetchImpl(new URL('/pairings/devices', normalizedServerUrl), {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  if (!response.ok) {
    throw new Error(`Relay paired devices request failed: ${response.status}`)
  }
  const body = (await response.json()) as { devices?: unknown }
  if (!Array.isArray(body.devices)) {
    throw new Error('Relay paired devices response did not include a devices list')
  }
  return body.devices.map((device) => {
    if (
      typeof device !== 'object' ||
      device === null ||
      typeof (device as Record<string, unknown>).device_id !== 'string' ||
      typeof (device as Record<string, unknown>).token_hint !== 'string'
    ) {
      throw new Error('Relay paired devices response included an invalid device')
    }
    const parsed = device as {
      desktop_id?: unknown
      device_id: string
      device_kind?: unknown
      token_hint: string
      workspace_ids?: unknown
    }
    if (parsed.desktop_id !== undefined && typeof parsed.desktop_id !== 'string') {
      throw new Error('Relay paired devices response included an invalid device')
    }
    if (
      parsed.device_kind !== undefined &&
      parsed.device_kind !== 'desktop' &&
      parsed.device_kind !== 'mobile'
    ) {
      throw new Error('Relay paired devices response included an invalid device')
    }
    if (
      parsed.workspace_ids !== undefined &&
      (!Array.isArray(parsed.workspace_ids) ||
        !parsed.workspace_ids.every((workspaceId) => typeof workspaceId === 'string'))
    ) {
      throw new Error('Relay paired devices response included an invalid device')
    }
    return {
      ...(parsed.desktop_id ? { desktop_id: parsed.desktop_id } : {}),
      device_id: parsed.device_id,
      ...(parsed.device_kind ? { device_kind: parsed.device_kind } : {}),
      token_hint: parsed.token_hint,
      ...(Array.isArray(parsed.workspace_ids) ? { workspace_ids: parsed.workspace_ids } : {}),
    }
  })
}

export const revokeRelayPairedDeviceForCli = async ({
  adminToken,
  deviceId,
  fetchImpl = fetch,
  serverUrl,
}: {
  adminToken: string
  deviceId: string
  fetchImpl?: typeof fetch
  serverUrl: string
}): Promise<{ device_id: string; revoked: true }> => {
  const normalizedServerUrl = normalizeRelayServerUrlForCli(serverUrl)
  const response = await fetchImpl(
    new URL(`/pairings/devices/${encodeURIComponent(deviceId)}`, normalizedServerUrl),
    {
      headers: { authorization: `Bearer ${adminToken}` },
      method: 'DELETE',
    }
  )
  if (!response.ok) {
    throw new Error(`Relay paired device revoke failed: ${response.status}`)
  }
  return (await response.json()) as { device_id: string; revoked: true }
}

export const readRelayHealthForCli = async ({
  fetchImpl = fetch,
  serverUrl,
}: {
  fetchImpl?: typeof fetch
  serverUrl: string
}): Promise<{
  desktop_count: number
  deployment?: {
    public_url_configured?: boolean
  }
  heartbeat_interval_ms?: number
  heartbeat_timeout_ms?: number
  mobile_count: number
  ok: boolean
  pairing_store?: {
    admin_token_default?: boolean
    device_token_count: number
    issued_token_count: number
    persistent: boolean
    require_desktop_binding?: boolean
  }
  protocol_version?: number
  service: string
  started_at?: number
  static?: {
    mobile_app_available: boolean
  }
  terminal_proxy_count?: number
  uptime_ms?: number
  version?: string
}> => {
  const normalizedServerUrl = normalizeRelayServerUrlForCli(serverUrl)
  const response = await fetchImpl(new URL('/health', normalizedServerUrl))
  if (!response.ok) {
    throw new Error(`Relay health request failed: ${response.status}`)
  }
  const body = (await response.json()) as Record<string, unknown>
  if (
    body.ok !== true ||
    body.service !== 'hive-relay' ||
    typeof body.desktop_count !== 'number' ||
    typeof body.mobile_count !== 'number'
  ) {
    throw new Error('Relay health response was invalid: expected service=hive-relay')
  }
  return {
    desktop_count: body.desktop_count,
    ...(typeof body.deployment === 'object' &&
    body.deployment !== null &&
    typeof (body.deployment as Record<string, unknown>).public_url_configured === 'boolean'
      ? {
          deployment: {
            public_url_configured: (body.deployment as Record<string, unknown>)
              .public_url_configured as boolean,
          },
        }
      : {}),
    ...(typeof body.heartbeat_interval_ms === 'number'
      ? { heartbeat_interval_ms: body.heartbeat_interval_ms }
      : {}),
    ...(typeof body.heartbeat_timeout_ms === 'number'
      ? { heartbeat_timeout_ms: body.heartbeat_timeout_ms }
      : {}),
    mobile_count: body.mobile_count,
    ok: body.ok,
    ...(typeof body.pairing_store === 'object' &&
    body.pairing_store !== null &&
    typeof (body.pairing_store as Record<string, unknown>).device_token_count === 'number' &&
    typeof (body.pairing_store as Record<string, unknown>).issued_token_count === 'number' &&
    typeof (body.pairing_store as Record<string, unknown>).persistent === 'boolean'
      ? {
          pairing_store: {
            ...(typeof (body.pairing_store as Record<string, unknown>).admin_token_default ===
            'boolean'
              ? {
                  admin_token_default: (body.pairing_store as Record<string, unknown>)
                    .admin_token_default as boolean,
                }
              : {}),
            device_token_count: (body.pairing_store as Record<string, unknown>)
              .device_token_count as number,
            issued_token_count: (body.pairing_store as Record<string, unknown>)
              .issued_token_count as number,
            persistent: (body.pairing_store as Record<string, unknown>).persistent as boolean,
            ...(typeof (body.pairing_store as Record<string, unknown>).require_desktop_binding ===
            'boolean'
              ? {
                  require_desktop_binding: (body.pairing_store as Record<string, unknown>)
                    .require_desktop_binding as boolean,
                }
              : {}),
          },
        }
      : {}),
    ...(typeof body.protocol_version === 'number'
      ? { protocol_version: body.protocol_version }
      : {}),
    service: body.service,
    ...(typeof body.started_at === 'number' ? { started_at: body.started_at } : {}),
    ...(typeof body.static === 'object' &&
    body.static !== null &&
    typeof (body.static as Record<string, unknown>).mobile_app_available === 'boolean'
      ? {
          static: {
            mobile_app_available: (body.static as Record<string, unknown>)
              .mobile_app_available as boolean,
          },
        }
      : {}),
    ...(typeof body.terminal_proxy_count === 'number'
      ? { terminal_proxy_count: body.terminal_proxy_count }
      : {}),
    ...(typeof body.uptime_ms === 'number' ? { uptime_ms: body.uptime_ms } : {}),
    ...(typeof body.version === 'string' && body.version.trim()
      ? { version: body.version.trim() }
      : {}),
  }
}

export const isRelayHttpProtocolSupportedForCli = (health: {
  protocol_version?: number
}): boolean =>
  typeof health.protocol_version !== 'number' ||
  health.protocol_version <= SUPPORTED_RELAY_HTTP_PROTOCOL_VERSION

export const listRelayOnlineDevicesForCli = async ({
  fetchImpl = fetch,
  serverUrl,
  token,
}: {
  fetchImpl?: typeof fetch
  serverUrl: string
  token: string
}): Promise<{
  desktops: Array<{
    connected_at?: number
    device_id: string
    features?: string[]
    last_seen_at?: number
    runtime_message?: string
    runtime_status?: 'offline' | 'online' | 'unknown'
    runtime_updated_at?: number
  }>
  mobiles: Array<{
    connected_at?: number
    desktop_id: string
    device_id: string
    last_seen_at?: number
  }>
}> => {
  const normalizedServerUrl = normalizeRelayServerUrlForCli(serverUrl)
  const response = await fetchImpl(new URL('/devices', normalizedServerUrl), {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        'Relay devices request failed: 401 (invalid token; use a paired device token or relay admin token)'
      )
    }
    throw new Error(`Relay devices request failed: ${response.status}`)
  }
  const body = (await response.json()) as Record<string, unknown>
  if (!Array.isArray(body.desktops) || !Array.isArray(body.mobiles)) {
    throw new Error('Relay devices response was invalid')
  }
  return {
    desktops: body.desktops.map((desktop) => {
      if (
        typeof desktop !== 'object' ||
        desktop === null ||
        typeof (desktop as Record<string, unknown>).device_id !== 'string'
      ) {
        throw new Error('Relay devices response included an invalid desktop')
      }
      const record = desktop as Record<string, unknown>
      const runtimeStatus = record.runtime_status
      if (
        runtimeStatus !== undefined &&
        runtimeStatus !== 'online' &&
        runtimeStatus !== 'offline' &&
        runtimeStatus !== 'unknown'
      ) {
        throw new Error('Relay devices response included an invalid desktop runtime_status')
      }
      return {
        ...(typeof record.connected_at === 'number' ? { connected_at: record.connected_at } : {}),
        device_id: record.device_id as string,
        ...(Array.isArray(record.features)
          ? {
              features: record.features.filter(
                (feature): feature is string => typeof feature === 'string'
              ),
            }
          : {}),
        ...(typeof record.last_seen_at === 'number' ? { last_seen_at: record.last_seen_at } : {}),
        ...(typeof record.runtime_message === 'string' && record.runtime_message.trim()
          ? { runtime_message: record.runtime_message.trim() }
          : {}),
        ...(runtimeStatus ? { runtime_status: runtimeStatus } : {}),
        ...(typeof record.runtime_updated_at === 'number'
          ? { runtime_updated_at: record.runtime_updated_at }
          : {}),
      }
    }),
    mobiles: body.mobiles.map((mobile) => {
      if (
        typeof mobile !== 'object' ||
        mobile === null ||
        typeof (mobile as Record<string, unknown>).desktop_id !== 'string' ||
        typeof (mobile as Record<string, unknown>).device_id !== 'string'
      ) {
        throw new Error('Relay devices response included an invalid mobile')
      }
      const record = mobile as Record<string, unknown>
      return {
        ...(typeof record.connected_at === 'number' ? { connected_at: record.connected_at } : {}),
        desktop_id: record.desktop_id as string,
        device_id: record.device_id as string,
        ...(typeof record.last_seen_at === 'number' ? { last_seen_at: record.last_seen_at } : {}),
      }
    }),
  }
}

export const formatRelayDesktopStatusForCli = (
  desktop: {
    connected_at?: number | undefined
    device_id: string
    last_seen_at?: number | undefined
    runtime_message?: string | undefined
    runtime_status?: 'offline' | 'online' | 'unknown' | undefined
    runtime_updated_at?: number | undefined
  },
  now = Date.now()
): string => {
  const runtimeStatus = desktop.runtime_status
  if (!runtimeStatus) return desktop.device_id
  const runtimeMessage = desktop.runtime_message?.replace(/\s+/gu, ' ').trim()
  const runtimeAge = formatRelayRuntimeAgeForCli(desktop.runtime_updated_at, now)
  const parts = [
    runtimeStatus,
    ...(runtimeMessage ? [runtimeMessage.slice(0, 120)] : []),
    ...(runtimeAge ? [runtimeAge] : []),
    ...(typeof desktop.connected_at === 'number'
      ? [`connected ${formatRelayElapsedAgeForCli(desktop.connected_at, now)}`]
      : []),
    ...(typeof desktop.last_seen_at === 'number'
      ? [`seen ${formatRelayElapsedAgeForCli(desktop.last_seen_at, now)}`]
      : []),
  ]
  return `${desktop.device_id} (${parts.join('; ')})`
}

export const formatRelayMobileStatusForCli = (
  mobile: {
    connected_at?: number | undefined
    desktop_id: string
    device_id: string
    last_seen_at?: number | undefined
  },
  now = Date.now()
): string => {
  const parts = [
    `${mobile.device_id} -> ${mobile.desktop_id}`,
    ...(typeof mobile.connected_at === 'number'
      ? [`connected ${formatRelayElapsedAgeForCli(mobile.connected_at, now)}`]
      : []),
    ...(typeof mobile.last_seen_at === 'number'
      ? [`seen ${formatRelayElapsedAgeForCli(mobile.last_seen_at, now)}`]
      : []),
  ]
  if (parts.length === 1) return parts[0] ?? mobile.device_id
  const [route, ...meta] = parts
  return `${route} (${meta.join('; ')})`
}

export const formatRelayPairedDeviceStatusForCli = (device: {
  desktop_id?: string | undefined
  device_id: string
  device_kind?: 'desktop' | 'mobile' | undefined
  token_hint: string
  workspace_ids?: string[] | undefined
}): string => {
  const desktop = device.desktop_id ? `desktop ${device.desktop_id}` : 'desktop any'
  const kind = device.device_kind ? `kind ${device.device_kind}` : 'kind any'
  const workspaces =
    device.workspace_ids && device.workspace_ids.length > 0
      ? `workspaces ${device.workspace_ids.join(',')}`
      : 'workspaces all'
  return `${device.device_id} (${desktop}; ${kind}; ${workspaces}; token ${device.token_hint})`
}

const diagnoseRelayDeviceFreshnessForCli = (
  devices: Awaited<ReturnType<typeof listRelayOnlineDevicesForCli>>,
  now = Date.now()
): { lines: string[]; ok: boolean } => {
  const staleDesktops = devices.desktops.filter(
    (desktop) =>
      (typeof desktop.last_seen_at === 'number' &&
        now - desktop.last_seen_at > RELAY_RUNTIME_STALE_MS) ||
      (desktop.runtime_status === 'online' &&
        typeof desktop.runtime_updated_at === 'number' &&
        now - desktop.runtime_updated_at > RELAY_RUNTIME_STALE_MS)
  )
  const staleMobiles = devices.mobiles.filter(
    (mobile) =>
      typeof mobile.last_seen_at === 'number' && now - mobile.last_seen_at > RELAY_RUNTIME_STALE_MS
  )
  if (staleDesktops.length === 0 && staleMobiles.length === 0) return { lines: [], ok: true }

  const lines = [
    `[warn] Device freshness: ${[
      ...staleDesktops.map(
        (desktop) =>
          `${desktop.device_id} seen ${formatRelayElapsedAgeForCli(desktop.last_seen_at, now)}`
      ),
      ...staleMobiles.map(
        (mobile) =>
          `${mobile.device_id} seen ${formatRelayElapsedAgeForCli(mobile.last_seen_at, now)}`
      ),
    ].join(', ')}.`,
    'Next: rerun yive connect on stale desktops, reopen the phone page, then verify with smoke:relay-all -- --max-stale-ms 30000.',
  ]
  return { lines, ok: false }
}

const diagnoseRelayDesktopFeaturesForCli = (
  devices: Awaited<ReturnType<typeof listRelayOnlineDevicesForCli>>
): { lines: string[]; ok: boolean } => {
  const desktopsWithoutFeatures = devices.desktops.filter((desktop) => !desktop.features)
  const desktopsMissingFeatures = devices.desktops
    .map((desktop) => {
      if (!desktop.features) return null
      const available = new Set(desktop.features)
      const missing = REQUIRED_RELAY_DESKTOP_FEATURES.filter(
        ([feature]) => !available.has(feature)
      ).map(([, label]) => label)
      return missing.length > 0 ? { desktop, missing } : null
    })
    .filter(
      (item): item is { desktop: { device_id: string }; missing: RelayDesktopFeatureLabel[] } =>
        item !== null
    )

  if (desktopsWithoutFeatures.length === 0 && desktopsMissingFeatures.length === 0) {
    return {
      lines: ['[ok] Desktop features: all online desktops declare remote mobile support.'],
      ok: true,
    }
  }

  const lines: string[] = []
  if (desktopsWithoutFeatures.length > 0) {
    lines.push(
      `[warn] Desktop features: ${desktopsWithoutFeatures
        .map((desktop) => desktop.device_id)
        .join(', ')} did not declare remote capability metadata.`
    )
  }
  for (const { desktop, missing } of desktopsMissingFeatures) {
    lines.push(`[warn] Desktop features: ${desktop.device_id} is missing ${missing.join(', ')}.`)
  }
  lines.push('Next: update yive on those desktops and reconnect them to Relay.')
  return { lines, ok: desktopsMissingFeatures.length === 0 }
}

const buildRelayAllSmokeCommandForCli = ({
  desktopId,
  expectedOutput,
  serverUrl,
  terminalInput,
  verifyTerminalOutput,
  workspaceFile,
  workspaceId,
}: {
  desktopId: string
  expectedOutput?: string | undefined
  serverUrl: string
  terminalInput?: string | undefined
  verifyTerminalOutput?: boolean | undefined
  workspaceFile?: string | undefined
  workspaceId?: string | undefined
}): string =>
  [
    'pnpm smoke:relay-all --',
    `--server ${serverUrl}`,
    '--token <admin-token>',
    `--desktop-id ${desktopId}`,
    '--max-stale-ms 30000',
    ...(workspaceId ? [`--workspace-id ${workspaceId}`] : []),
    ...(workspaceFile ? [`--workspace-file ${workspaceFile}`] : []),
    ...(terminalInput ? [`--terminal-input ${JSON.stringify(terminalInput)}`] : []),
    ...(expectedOutput ? [`--expect-output ${JSON.stringify(expectedOutput)}`] : []),
    ...(verifyTerminalOutput ? ['--verify-terminal-output'] : []),
  ].join(' ')

const quoteRelayCliArg = (value: string): string => {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) return value
  return JSON.stringify(value)
}

export const buildRelayChecklistForCli = (argv: string[]): string[] => {
  const serverUrlValue = readFlag(argv, '--server') ?? process.env.YIVE_RELAY_SERVER
  const desktopId = readFlag(argv, '--desktop-id')
  if (!serverUrlValue || !hasFlagValue(desktopId)) {
    throw new Error(
      'Usage: yive relay checklist --server <relay-url> --desktop-id <id> [--workspace-id <id>] [--run-id <id>] [--workspace-file <relative-path>] [--allow-http-only] [--android-package <id> --android-sha256 <fingerprint>]'
    )
  }
  const serverUrl = normalizeRelayServerUrlForCli(serverUrlValue)
  const workspaceId = readFlag(argv, '--workspace-id')
  const runId = readFlag(argv, '--run-id')
  const workspaceFile = readFlag(argv, '--workspace-file')
  const androidPackage = readFlag(argv, '--android-package')
  const androidSha256 = readFlag(argv, '--android-sha256')
  if (Boolean(androidPackage) !== Boolean(androidSha256)) {
    throw new Error('--android-package and --android-sha256 must be provided together')
  }
  const maxStaleMs = readFlag(argv, '--max-stale-ms') ?? '30000'
  const timeoutMs = readFlag(argv, '--timeout-ms') ?? '60000'
  const hasTerminalTarget = hasFlagValue(workspaceId) && hasFlagValue(runId)
  const hasWorkspaceFileTarget = hasFlagValue(workspaceId) && hasFlagValue(workspaceFile)
  const hasAndroidTarget = hasFlagValue(androidPackage) && hasFlagValue(androidSha256)
  const relayOrigin = new URL(serverUrl).origin
  const relayHost = new URL(serverUrl).host
  const terminalTargetArgs = hasTerminalTarget
    ? `--workspace-id ${quoteRelayCliArg(workspaceId)} --run-id ${quoteRelayCliArg(runId)}`
    : '--workspace-id <workspace-id> --run-id <run-id>'
  const workspaceFileArgs = hasWorkspaceFileTarget
    ? `--workspace-id ${quoteRelayCliArg(workspaceId)} --workspace-file ${quoteRelayCliArg(
        workspaceFile
      )}`
    : '--workspace-id <workspace-id> --workspace-file <relative-file>'
  const baseSmoke = `pnpm smoke:relay-all -- --server ${quoteRelayCliArg(
    serverUrl
  )} --token <admin-token> --desktop-id ${quoteRelayCliArg(desktopId)}`
  const fullSmoke = `${baseSmoke}${
    argv.includes('--allow-http-only') ? ' --allow-http-only' : ''
  } --timeout-ms ${timeoutMs} --max-stale-ms ${maxStaleMs}`

  return [
    'Yive public relay acceptance checklist:',
    `Relay: ${serverUrl}`,
    `Desktop: ${desktopId}`,
    hasTerminalTarget
      ? `Terminal target: ${workspaceId} / ${runId}`
      : 'Terminal target: replace <workspace-id> and <run-id> after opening an Agent.',
    hasWorkspaceFileTarget
      ? `Workspace file: ${workspaceFile}`
      : 'Workspace file: replace <relative-file> with a real workspace path, for example README.md or demo.mp4.',
    '',
    '1. Diagnose Relay and device authorization:',
    `   yive relay doctor --server ${quoteRelayCliArg(serverUrl)} --token <admin-token> --json`,
    '',
    '2. Confirm the local desktop bridge is registered:',
    `   yive connect status --server ${quoteRelayCliArg(
      serverUrl
    )} --token <admin-or-device-token> --device-id ${quoteRelayCliArg(desktopId)}`,
    '',
    '3. Create a phone pairing link:',
    `   yive relay pair --server ${quoteRelayCliArg(
      serverUrl
    )} --token <admin-token> --desktop-id ${quoteRelayCliArg(desktopId)}`,
    '',
    '4. Run the full public relay smoke suite:',
    `   ${fullSmoke}`,
    '',
    '5. Verify terminal takeover and output:',
    `   ${baseSmoke} --max-stale-ms ${maxStaleMs} ${terminalTargetArgs} --verify-terminal-output`,
    '',
    '6. Verify desktop workspace file download on the phone:',
    `   ${baseSmoke} --max-stale-ms ${maxStaleMs} ${workspaceFileArgs}`,
    '',
    '7. Verify phone image upload and paste:',
    `   ${baseSmoke} --max-stale-ms ${maxStaleMs} ${terminalTargetArgs} --verify-image-paste`,
    '',
    ...(hasAndroidTarget
      ? [
          '8. Prepare and verify the Android/TWA app shell:',
          `   pnpm build`,
          `   pnpm mobile:android:assetlinks -- --out-dir web/dist --android-package ${quoteRelayCliArg(
            androidPackage
          )} --android-sha256 ${quoteRelayCliArg(androidSha256)}`,
          `   pnpm mobile:android:twa -- --domain ${quoteRelayCliArg(
            relayOrigin
          )} --static-dir web/dist --out-dir android-twa --android-package ${quoteRelayCliArg(
            androidPackage
          )} --android-sha256 ${quoteRelayCliArg(androidSha256)}`,
          `   pnpm mobile:android:verify -- --domain ${quoteRelayCliArg(
            relayOrigin
          )} --static-dir web/dist --twa-dir android-twa --android-package ${quoteRelayCliArg(
            androidPackage
          )} --android-sha256 ${quoteRelayCliArg(androidSha256)}`,
          `   pnpm smoke:relay-domain -- --domain ${quoteRelayCliArg(
            relayHost
          )} --android-package ${quoteRelayCliArg(
            androidPackage
          )} --android-sha256 ${quoteRelayCliArg(androidSha256)}`,
          '',
          '9. Manual check: install/open the Android/TWA shell or PWA, enter the workspace, take over the raw terminal, and let desktop reclaim control.',
        ]
      : [
          '8. Manual check: phone opens /mobile, enters the workspace, takes over the raw terminal, and desktop can reclaim control.',
        ]),
    '',
    'Security: commands use placeholders only; do not share a real relay token.',
  ]
}

const formatRelayDeploymentStatusForCli = (
  health: Awaited<ReturnType<typeof readRelayHealthForCli>>,
  options: { serverUrl?: string; strict?: boolean } = {}
): { lines: string[]; ok: boolean } => {
  const lines: string[] = []
  let ok = true

  if (health.deployment) {
    const publicUrlReady = health.deployment.public_url_configured === true
    lines.push(
      `${publicUrlReady ? '[ok]' : options.strict ? '[warn]' : '[warn]'} Public URL: ${
        publicUrlReady
          ? 'configured for deployment smoke checks'
          : 'YIVE_RELAY_PUBLIC_URL is not configured'
      }`
    )
    if (!publicUrlReady && options.strict) {
      ok = false
      lines.push(
        `Next: add YIVE_RELAY_PUBLIC_URL=${options.serverUrl ?? '<relay-public-url>'} to /etc/yive/relay.env, then run sudo systemctl restart yive-relay.`
      )
    }
  }

  if (health.static) {
    const healthy = health.static.mobile_app_available
    lines.push(
      `${healthy ? '[ok]' : '[fail]'} Mobile app: ${healthy ? 'static build available' : 'static build missing'}`
    )
    if (!healthy) ok = false
  }

  if (health.pairing_store) {
    const status = health.pairing_store.persistent ? '[ok]' : options.strict ? '[warn]' : '[warn]'
    lines.push(
      `${status} Pairing store: ${
        health.pairing_store.persistent ? 'persistent' : 'in-memory only'
      }; ${health.pairing_store.device_token_count} paired device token; ${
        health.pairing_store.issued_token_count
      } pending pairing token`
    )
    if (!health.pairing_store.persistent && options.strict) ok = false
    if (health.pairing_store.require_desktop_binding !== undefined) {
      lines.push(
        `${health.pairing_store.require_desktop_binding ? '[ok]' : options.strict ? '[warn]' : '[warn]'} Desktop binding: ${
          health.pairing_store.require_desktop_binding
            ? 'device tokens are scoped to one desktop'
            : 'unbound device tokens can target any desktop'
        }`
      )
      if (!health.pairing_store.require_desktop_binding && options.strict) ok = false
      if (!health.pairing_store.require_desktop_binding && options.strict) {
        lines.push(
          'Next: add YIVE_RELAY_REQUIRE_DESKTOP_BINDING=1 to /etc/yive/relay.env, then run sudo systemctl restart yive-relay.'
        )
      }
    }
    if (health.pairing_store.admin_token_default) {
      lines.push(
        '[fail] Relay admin token: using development default; set --token or HIVE_RELAY_DEV_TOKEN.'
      )
      if (options.strict) ok = false
      if (options.strict) {
        lines.push(
          'Next: set YIVE_RELAY_ADMIN_TOKEN=<strong-admin-token> in /etc/yive/relay.env, then restart yive-relay.'
        )
      }
    }
  }

  if (
    typeof health.heartbeat_interval_ms === 'number' &&
    typeof health.heartbeat_timeout_ms === 'number'
  ) {
    lines.push(
      `[ok] Heartbeat: ping every ${formatDurationForCli(
        health.heartbeat_interval_ms
      )}, timeout ${formatDurationForCli(health.heartbeat_timeout_ms)}`
    )
  }

  if (typeof health.terminal_proxy_count === 'number') {
    lines.push(`[ok] Terminal proxies: ${health.terminal_proxy_count}`)
  }

  return { lines, ok }
}

const isRemoteInsecureHttpRelay = (serverUrl: string) => {
  try {
    const url = new URL(serverUrl)
    if (url.protocol !== 'http:') return false
    const host = url.hostname.toLowerCase()
    return (
      host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && !host.startsWith('127.')
    )
  } catch {
    return false
  }
}

const diagnoseRelayPwaForCli = async ({
  fetchImpl,
  serverUrl,
}: {
  fetchImpl: typeof fetch
  serverUrl: string
}): Promise<{ lines: string[]; ok: boolean }> => {
  const lines: string[] = []
  let ok = true

  if (isRemoteInsecureHttpRelay(serverUrl)) {
    lines.push('[warn] HTTPS: remote Relay is using HTTP; browsers may refuse PWA install.')
  }

  try {
    const response = await fetchImpl(new URL('/manifest.webmanifest', serverUrl))
    if (!response.ok) throw new Error(`request failed: ${response.status}`)
    const cacheControl = response.headers.get('cache-control') ?? ''
    const manifest = (await response.json()) as Record<string, unknown>
    const icons = Array.isArray(manifest.icons) ? manifest.icons : []
    const screenshots = Array.isArray(manifest.screenshots) ? manifest.screenshots : []
    const installReady =
      manifest.start_url === '/mobile?relay=1' &&
      manifest.display === 'standalone' &&
      icons.some(
        (icon) =>
          typeof icon === 'object' &&
          icon !== null &&
          String((icon as Record<string, unknown>).src ?? '').includes('/icons/icon-192.png')
      ) &&
      icons.some(
        (icon) =>
          typeof icon === 'object' &&
          icon !== null &&
          String((icon as Record<string, unknown>).purpose ?? '').includes('maskable')
      ) &&
      screenshots.some(
        (screenshot) =>
          typeof screenshot === 'object' &&
          screenshot !== null &&
          (screenshot as Record<string, unknown>).form_factor === 'narrow'
      )
    const cacheReady = cacheControl.includes('max-age=0')
    lines.push(
      `${installReady ? '[ok]' : '[fail]'} PWA manifest: ${
        installReady ? 'mobile relay standalone app' : 'missing mobile install metadata'
      }`
    )
    if (!installReady) ok = false
    if (!cacheReady) {
      lines.push('[warn] PWA manifest cache: expected max-age=0 so installed phones see updates.')
    }
  } catch (error) {
    lines.push(`[fail] PWA manifest: ${error instanceof Error ? error.message : String(error)}`)
    ok = false
  }

  try {
    const response = await fetchImpl(new URL('/sw.js', serverUrl))
    if (!response.ok) throw new Error(`request failed: ${response.status}`)
    const cacheControl = response.headers.get('cache-control') ?? ''
    const body = await response.text()
    const ready = body.includes('self.addEventListener')
    const cacheReady = cacheControl.includes('no-store')
    lines.push(
      `${ready && cacheReady ? '[ok]' : '[fail]'} Service worker: ${
        ready && cacheReady
          ? 'available with no-store update checks'
          : 'missing or cache policy is unsafe'
      }`
    )
    if (!ready || !cacheReady) ok = false
  } catch (error) {
    lines.push(`[fail] Service worker: ${error instanceof Error ? error.message : String(error)}`)
    ok = false
  }

  return { lines, ok }
}

const diagnoseRelayAndroidAssetLinksForCli = async ({
  androidPackage,
  fetchImpl,
  serverUrl,
  sha256Fingerprint,
}: {
  androidPackage: string
  fetchImpl: typeof fetch
  serverUrl: string
  sha256Fingerprint: string
}): Promise<{
  diagnostics: RelayAndroidAppLinksDiagnostics
  lines: string[]
  ok: boolean
}> => {
  const lines: string[] = []
  const baseDiagnostics = {
    checked: true,
    package_name: androidPackage,
    sha256_fingerprint: normalizeAndroidFingerprintForCli(sha256Fingerprint),
  }
  try {
    const origin = new URL(serverUrl)
    if (origin.protocol !== 'https:') {
      throw new Error('Android TWA app links require an HTTPS Relay origin')
    }
    const response = await fetchImpl(new URL('/.well-known/assetlinks.json', serverUrl))
    if (!response.ok) throw new Error(`request failed: ${response.status}`)
    validateAndroidAssetLinksForCli(await response.json(), {
      packageName: androidPackage,
      sha256Fingerprint,
    })
    lines.push(`[ok] Android app links: ${androidPackage} is authorized`)
    return {
      diagnostics: {
        ...baseDiagnostics,
        status: 'ok',
      },
      lines,
      ok: true,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    lines.push(`[fail] Android app links: ${message}`)
    lines.push(
      'Next: publish web/dist/.well-known/assetlinks.json, confirm the release signing fingerprint, then rerun relay doctor.'
    )
    return {
      diagnostics: {
        ...baseDiagnostics,
        error: message,
        status: 'failed',
      },
      lines,
      ok: false,
    }
  }
}

export const diagnoseRelayForCli = async ({
  androidPackage,
  androidSha256,
  fetchImpl = fetch,
  now = Date.now(),
  serverUrl,
  token,
}: {
  androidPackage?: string | undefined
  androidSha256?: string | undefined
  fetchImpl?: typeof fetch
  now?: number
  serverUrl: string
  token?: string | undefined
}): Promise<RelayDoctorDiagnostics> => {
  if (Boolean(androidPackage) !== Boolean(androidSha256)) {
    throw new Error('--android-package and --android-sha256 must be provided together')
  }
  const normalizedServerUrl = normalizeRelayServerUrlForCli(serverUrl)
  const generatedAt = new Date(now).toISOString()
  const lines = [`Relay doctor: ${normalizedServerUrl}`]
  let androidAppLinksDiagnostics: RelayAndroidAppLinksDiagnostics | undefined
  let ok = true

  let health: Awaited<ReturnType<typeof readRelayHealthForCli>>
  try {
    health = await readRelayHealthForCli({ fetchImpl, serverUrl: normalizedServerUrl })
  } catch (error) {
    lines.push(
      `[fail] Relay HTTP: ${error instanceof Error ? error.message : String(error)}`,
      'Next: check DNS/IP, firewall, Nginx, and whether yive relay is running.'
    )
    return { generated_at: generatedAt, lines, ok: false, server: normalizedServerUrl }
  }

  const version = health.version ? ` ${health.version}` : ''
  lines.push(`[ok] Relay HTTP: ${health.service}${version}`)
  if (typeof health.protocol_version === 'number') {
    const protocolSupported = isRelayHttpProtocolSupportedForCli(health)
    lines.push(
      `${protocolSupported ? '[ok]' : '[warn]'} Protocol: relay v${
        health.protocol_version
      }, CLI supports v${SUPPORTED_RELAY_HTTP_PROTOCOL_VERSION}`
    )
    if (!protocolSupported) {
      lines.push('Next: update yive locally or deploy a matching relay version.')
      ok = false
    }
  }
  if (typeof health.uptime_ms === 'number') {
    lines.push(`[ok] Uptime: ${formatDurationForCli(health.uptime_ms)}`)
  }
  const deployment = formatRelayDeploymentStatusForCli(health, {
    serverUrl: normalizedServerUrl,
    strict: true,
  })
  lines.push(...deployment.lines)
  if (!deployment.ok) ok = false
  const pwa = await diagnoseRelayPwaForCli({ fetchImpl, serverUrl: normalizedServerUrl })
  lines.push(...pwa.lines)
  if (!pwa.ok) ok = false
  if (androidPackage && androidSha256) {
    const android = await diagnoseRelayAndroidAssetLinksForCli({
      androidPackage,
      fetchImpl,
      serverUrl: normalizedServerUrl,
      sha256Fingerprint: androidSha256,
    })
    lines.push(...android.lines)
    androidAppLinksDiagnostics = android.diagnostics
    if (!android.ok) ok = false
  }
  lines.push(`[ok] Connections: ${health.desktop_count} desktop, ${health.mobile_count} mobile`)

  if (!token) {
    lines.push(
      '[warn] Token: not provided; cannot inspect online device ids or desktop runtime status.',
      `Next: run yive relay doctor --server ${normalizedServerUrl} --token <admin-or-device-token>.`
    )
    return {
      ...(androidAppLinksDiagnostics ? { android_app_links: androidAppLinksDiagnostics } : {}),
      generated_at: generatedAt,
      lines,
      ok: false,
      server: normalizedServerUrl,
    }
  }

  let devices: Awaited<ReturnType<typeof listRelayOnlineDevicesForCli>>
  try {
    devices = await listRelayOnlineDevicesForCli({
      fetchImpl,
      serverUrl: normalizedServerUrl,
      token,
    })
  } catch (error) {
    lines.push(
      `[fail] Token/devices: ${error instanceof Error ? error.message : String(error)}`,
      'Next: verify the relay admin token or pair this phone again.'
    )
    return {
      ...(androidAppLinksDiagnostics ? { android_app_links: androidAppLinksDiagnostics } : {}),
      generated_at: generatedAt,
      lines,
      ok: false,
      server: normalizedServerUrl,
    }
  }

  lines.push(`[ok] Token: accepted`)
  if (devices.desktops.length === 0) {
    lines.push(
      '[fail] Desktop: none online.',
      `Next: start local yive and connect it with yive connect --server ${normalizedServerUrl} --token <admin-token> --runtime http://127.0.0.1:3001.`
    )
    ok = false
  } else {
    lines.push(
      `[ok] Desktop: ${devices.desktops
        .map((desktop) => formatRelayDesktopStatusForCli(desktop, now))
        .join(', ')}`
    )
    const desktopFeatures = diagnoseRelayDesktopFeaturesForCli(devices)
    lines.push(...desktopFeatures.lines)
    if (!desktopFeatures.ok) ok = false
    const unavailableRuntimeDesktops = devices.desktops.filter(
      (desktop) => desktop.runtime_status !== 'online'
    )
    if (unavailableRuntimeDesktops.length > 0) {
      lines.push(
        '[warn] Local runtime: at least one desktop is connected to Relay but does not report runtime online.',
        'Next: start or restart the local yive runtime on that computer, then rerun relay doctor.'
      )
      ok = false
    }
  }

  const freshness = diagnoseRelayDeviceFreshnessForCli(devices, now)
  lines.push(...freshness.lines)
  if (!freshness.ok) ok = false

  try {
    const pairedDevices = await listRelayPairedDevicesForCli({
      adminToken: token,
      fetchImpl,
      serverUrl: normalizedServerUrl,
    })
    if (pairedDevices.length === 0) {
      lines.push('[warn] Paired devices: none registered.')
    } else {
      lines.push(
        `[ok] Paired devices: ${pairedDevices
          .map((device) => formatRelayPairedDeviceStatusForCli(device))
          .join(', ')}`
      )
      const unrestrictedDevices = pairedDevices.filter(
        (device) => !device.workspace_ids || device.workspace_ids.length === 0
      )
      if (unrestrictedDevices.length > 0) {
        lines.push(
          `[warn] Workspace scope: ${unrestrictedDevices
            .map((device) => device.device_id)
            .join(', ')} can access all workspaces.`
        )
      }
    }
  } catch (error) {
    lines.push(
      `[warn] Paired devices: unavailable (${error instanceof Error ? error.message : String(error)}).`,
      'Next: rerun relay doctor with the Relay admin token to audit phone workspace access.'
    )
  }

  if (devices.mobiles.length === 0) {
    lines.push('[warn] Mobile: no phone currently connected.')
    const desktopId = devices.desktops[0]?.device_id
    if (desktopId) {
      lines.push(
        `Next: pair a phone with yive relay pair --server ${normalizedServerUrl} --token <admin-token> --desktop-id ${desktopId}.`
      )
    }
  } else {
    lines.push(
      `[ok] Mobile: ${devices.mobiles
        .map((mobile) => formatRelayMobileStatusForCli(mobile, now))
        .join(', ')}`
    )
    const onlineDesktopIds = new Set(devices.desktops.map((desktop) => desktop.device_id))
    const mobilesWithoutOnlineDesktop = devices.mobiles.filter(
      (mobile) => !onlineDesktopIds.has(mobile.desktop_id)
    )
    if (mobilesWithoutOnlineDesktop.length > 0) {
      lines.push(
        `[fail] Mobile routing: ${mobilesWithoutOnlineDesktop
          .map((mobile) => `${mobile.device_id} targets offline ${mobile.desktop_id}`)
          .join(', ')}.`,
        'Next: connect that desktop, or pair the phone again with the correct desktop id.'
      )
      ok = false
    } else {
      const desktopsById = new Map(devices.desktops.map((desktop) => [desktop.device_id, desktop]))
      const terminalReadyDesktopId = devices.mobiles
        .map((mobile) => desktopsById.get(mobile.desktop_id))
        .find((desktop) => desktop?.runtime_status === 'online')?.device_id
      if (terminalReadyDesktopId) {
        lines.push(
          `Next: verify the full relay path with ${buildRelayAllSmokeCommandForCli({
            desktopId: terminalReadyDesktopId,
            serverUrl: normalizedServerUrl,
          })}.`,
          `Next: verify real terminal input with ${buildRelayAllSmokeCommandForCli({
            desktopId: terminalReadyDesktopId,
            serverUrl: normalizedServerUrl,
            verifyTerminalOutput: true,
          })}.`,
          `Next: verify workspace file transfer with ${buildRelayAllSmokeCommandForCli({
            desktopId: terminalReadyDesktopId,
            serverUrl: normalizedServerUrl,
            workspaceFile: '<relative-file>',
            workspaceId: '<workspace-id>',
          })}.`
        )
      }
    }
  }

  return {
    ...(androidAppLinksDiagnostics ? { android_app_links: androidAppLinksDiagnostics } : {}),
    generated_at: generatedAt,
    lines,
    ok,
    server: normalizedServerUrl,
  }
}

function formatRelayElapsedAgeForCli(updatedAt: number | undefined, now = Date.now()): string {
  if (typeof updatedAt !== 'number' || updatedAt <= 0) return 'unknown'
  const elapsedMs = Math.max(0, now - updatedAt)
  const elapsedSeconds = Math.round(elapsedMs / 1000)
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`
  return `${Math.round(elapsedSeconds / 60)}m ago`
}

const formatRelayRuntimeAgeForCli = (
  updatedAt: number | undefined,
  now = Date.now()
): string | null => {
  if (typeof updatedAt !== 'number' || updatedAt <= 0) return null
  const elapsedMs = Math.max(0, now - updatedAt)
  const age = formatRelayElapsedAgeForCli(updatedAt, now)
  return elapsedMs > RELAY_RUNTIME_STALE_MS ? `stale ${age}` : `updated ${age}`
}

const formatDurationForCli = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export const runRelayAdminCommand = async (argv: string[]) => {
  const command = argv[0]
  if (
    command !== 'checklist' &&
    command !== 'devices' &&
    command !== 'doctor' &&
    command !== 'pair' &&
    command !== 'revoke' &&
    command !== 'status'
  ) {
    return false
  }
  const serverUrlValue = readFlag(argv, '--server') ?? process.env.YIVE_RELAY_SERVER
  const token = readFlag(argv, '--token') ?? process.env.YIVE_RELAY_TOKEN
  const jsonOutput = argv.includes('--json')
  if (command === 'checklist') {
    for (const line of buildRelayChecklistForCli(argv)) console.log(line)
    return true
  }
  if (!serverUrlValue || (!token && command !== 'doctor' && command !== 'status')) {
    throw new Error(
      command === 'devices'
        ? 'Usage: yive relay devices --server <relay-url> --token <admin-token>'
        : command === 'pair'
          ? 'Usage: yive relay pair --server <relay-url> --token <admin-token> [--desktop-id <id>] [--workspace-id <id>] [--mobile-url <url>]'
          : command === 'revoke'
            ? 'Usage: yive relay revoke <device-id> --server <relay-url> --token <admin-token>'
            : `Usage: yive relay ${command} --server <relay-url> [--token <relay-token>]${
                command === 'status' || command === 'doctor' ? ' [--json]' : ''
              }`
    )
  }
  if (!serverUrlValue) {
    throw new Error(
      `Usage: yive relay ${command} --server <relay-url> [--token <relay-token>]${
        command === 'status' || command === 'doctor' ? ' [--json]' : ''
      }`
    )
  }
  const serverUrl = normalizeRelayServerUrlForCli(serverUrlValue)
  if (command === 'doctor') {
    const androidPackage = readFlag(argv, '--android-package')?.trim()
    const androidSha256 = readFlag(argv, '--android-sha256')?.trim()
    const diagnosis = await diagnoseRelayForCli({
      ...(androidPackage ? { androidPackage } : {}),
      ...(androidSha256 ? { androidSha256 } : {}),
      serverUrl,
      token,
    })
    if (jsonOutput) {
      console.log(JSON.stringify(diagnosis))
      return true
    }
    for (const line of diagnosis.lines) console.log(line)
    return true
  }
  if (command === 'status') {
    const health = await readRelayHealthForCli({ serverUrl })
    const protocolSupported = isRelayHttpProtocolSupportedForCli(health)
    if (jsonOutput) {
      console.log(
        JSON.stringify({
          ...health,
          client_protocol_version: SUPPORTED_RELAY_HTTP_PROTOCOL_VERSION,
          devices: token ? await listRelayOnlineDevicesForCli({ serverUrl, token }) : null,
          protocol_supported: protocolSupported,
        })
      )
      return true
    }
    console.log(
      `Relay: ${health.ok ? 'online' : 'unhealthy'} (${health.service}${
        health.version ? ` ${health.version}` : ''
      })`
    )
    if (typeof health.protocol_version === 'number') {
      console.log(
        `Protocol: v${health.protocol_version} (CLI supports v${SUPPORTED_RELAY_HTTP_PROTOCOL_VERSION})`
      )
      if (!protocolSupported) {
        console.log(
          'Warning: relay protocol is newer than this CLI; update yive or use a matching relay version.'
        )
      }
    }
    if (typeof health.uptime_ms === 'number') {
      console.log(`Uptime: ${formatDurationForCli(health.uptime_ms)}`)
    }
    for (const line of formatRelayDeploymentStatusForCli(health).lines) console.log(line)
    console.log(`Connections: ${health.desktop_count} desktop, ${health.mobile_count} mobile`)
    if (!token) {
      console.log('Online devices: pass --token to include device ids.')
      return true
    }
    const devices = await listRelayOnlineDevicesForCli({ serverUrl, token })
    console.log(
      `Authenticated devices: ${devices.desktops.length} desktop, ${devices.mobiles.length} mobile`
    )
    if (devices.desktops.length === 0) {
      console.log('Desktops: none online')
    } else {
      console.log(
        `Desktops: ${devices.desktops
          .map((desktop) => formatRelayDesktopStatusForCli(desktop))
          .join(', ')}`
      )
    }
    if (devices.mobiles.length === 0) {
      console.log('Mobiles: none connected')
    } else {
      console.log(
        `Mobiles: ${devices.mobiles
          .map((mobile) => formatRelayMobileStatusForCli(mobile))
          .join(', ')}`
      )
    }
    return true
  }
  if (!token) {
    throw new Error('Usage: yive relay <command> --server <relay-url> --token <token>')
  }
  const relayToken = token
  if (command === 'pair') {
    const desktopId = readFlag(argv, '--desktop-id')
    const mobileUrl = readFlag(argv, '--mobile-url') ?? process.env.YIVE_MOBILE_URL
    const workspaceIds = readRepeatedFlag(argv, '--workspace-id')
    if (!desktopId) {
      await assertRelayPairingCanBeUnboundForCli({ serverUrl })
    }
    const mobileToken = await requestRelayPairingToken({ adminToken: relayToken, serverUrl })
    if (desktopId) {
      const urls = buildMobileRelayUrls({
        deviceId: desktopId,
        ...(mobileUrl ? { mobileUrl } : {}),
        serverUrl,
        token: mobileToken,
        ...(workspaceIds.length > 0 ? { workspaceIds } : {}),
      })
      console.log(`Mobile pairing URL: ${urls.directUrl}`)
      console.log(`Desktop binding: ${desktopId}`)
      if (workspaceIds.length > 0) console.log(`Workspace scope: ${workspaceIds.join(', ')}`)
      return true
    }
    const pairingUrl = buildMobileRelayPairingUrl({
      ...(mobileUrl ? { mobileUrl } : {}),
      serverUrl,
      token: mobileToken,
      ...(workspaceIds.length > 0 ? { workspaceIds } : {}),
    })
    console.log(`Mobile pairing URL: ${pairingUrl}`)
    if (workspaceIds.length > 0) console.log(`Workspace scope: ${workspaceIds.join(', ')}`)
    return true
  }
  if (command === 'devices') {
    const devices = await listRelayPairedDevicesForCli({ adminToken: relayToken, serverUrl })
    if (devices.length === 0) {
      console.log('No paired relay devices.')
      return true
    }
    for (const device of devices) {
      console.log(
        [
          device.device_id,
          device.token_hint,
          ...(device.desktop_id ? [device.desktop_id] : []),
          device.workspace_ids?.length
            ? `workspaces:${device.workspace_ids.join(',')}`
            : 'workspaces:all',
        ].join('\t')
      )
    }
    return true
  }

  const deviceId = argv[1]?.trim()
  if (!deviceId || deviceId.startsWith('-')) {
    throw new Error(
      'Usage: yive relay revoke <device-id> --server <relay-url> --token <admin-token>'
    )
  }
  const result = await revokeRelayPairedDeviceForCli({
    adminToken: relayToken,
    deviceId,
    serverUrl,
  })
  console.log(`Revoked relay device: ${result.device_id}`)
  return true
}

type DesktopRelaySupervisorProcessStatus = {
  exit_code?: number | null
  pid?: number | null
  status?: string | null
}

type DesktopRelaySupervisorStatus = {
  device_id?: string | null
  found: boolean
  local_request_timeout_ms?: number | null
  manage_runtime?: boolean | null
  message?: string | null
  phase?: string | null
  relay_connect?: DesktopRelaySupervisorProcessStatus | null
  relay_server?: string | null
  runtime?: DesktopRelaySupervisorProcessStatus | null
  runtime_url?: string | null
  stale?: boolean
  status_file: string
  updated_at?: string | null
}

const DESKTOP_SUPERVISOR_STALE_MS = 15_000
const DEFAULT_DESKTOP_SUPERVISOR_STATUS_FILE = join(
  homedir(),
  '.config',
  'yive',
  'desktop-relay-status.json'
)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readOptionalString = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

const readOptionalNumber = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const readOptionalBoolean = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  return typeof value === 'boolean' ? value : null
}

const readDesktopRelaySupervisorProcess = (
  value: unknown
): DesktopRelaySupervisorProcessStatus | null => {
  if (!isRecord(value)) return null
  return {
    exit_code: readOptionalNumber(value, 'exit_code'),
    pid: readOptionalNumber(value, 'pid'),
    status: readOptionalString(value, 'status'),
  }
}

export const readDesktopRelaySupervisorStatusForCli = (
  statusFile: string,
  nowMs = Date.now()
): DesktopRelaySupervisorStatus => {
  if (!existsSync(statusFile)) {
    return { found: false, status_file: statusFile }
  }

  const raw = readFileSync(statusFile, 'utf8').replace(/^\uFEFF/u, '')
  const parsed = JSON.parse(raw) as unknown
  if (!isRecord(parsed)) {
    throw new Error('Desktop relay supervisor status file is not a JSON object')
  }
  const updatedAt = readOptionalString(parsed, 'updated_at')
  const updatedAtMs = updatedAt ? Date.parse(updatedAt) : Number.NaN
  return {
    device_id: readOptionalString(parsed, 'device_id'),
    found: true,
    local_request_timeout_ms: readOptionalNumber(parsed, 'local_request_timeout_ms'),
    manage_runtime: readOptionalBoolean(parsed, 'manage_runtime'),
    message: readOptionalString(parsed, 'message'),
    phase: readOptionalString(parsed, 'phase'),
    relay_connect: readDesktopRelaySupervisorProcess(parsed.relay_connect),
    relay_server: readOptionalString(parsed, 'relay_server'),
    runtime: readDesktopRelaySupervisorProcess(parsed.runtime),
    runtime_url: readOptionalString(parsed, 'runtime_url'),
    stale:
      Number.isNaN(updatedAtMs) || Math.max(0, nowMs - updatedAtMs) > DESKTOP_SUPERVISOR_STALE_MS,
    status_file: statusFile,
    updated_at: updatedAt,
  }
}

const formatSupervisorProcessStatus = (
  label: string,
  processStatus: DesktopRelaySupervisorProcessStatus | null | undefined
) => {
  if (!processStatus?.status) return `${label}: unknown`
  const pid = processStatus.pid ? ` pid=${processStatus.pid}` : ''
  const exitCode =
    processStatus.exit_code === null || processStatus.exit_code === undefined
      ? ''
      : ` exit=${processStatus.exit_code}`
  return `${label}: ${processStatus.status}${pid}${exitCode}`
}

const formatDesktopRelaySupervisorStatusForCli = (
  status: DesktopRelaySupervisorStatus
): string[] => {
  if (!status.found) {
    return [
      `Desktop relay supervisor: status file not found (${status.status_file})`,
      'Hint: start or install deploy\\run-windows-desktop-relay.ps1 to keep this desktop connected.',
    ]
  }

  const phase = status.phase ?? 'unknown'
  const stale = status.stale ? ' stale' : ''
  const lines = [
    `Desktop relay supervisor: ${phase}${stale}`,
    ...(status.message ? [`Supervisor message: ${status.message}`] : []),
    ...(status.updated_at ? [`Supervisor updated: ${status.updated_at}`] : []),
    formatSupervisorProcessStatus('Supervisor runtime', status.runtime),
    formatSupervisorProcessStatus('Supervisor relay-connect', status.relay_connect),
  ]
  if (status.stale) {
    lines.push('Hint: restart the desktop relay supervisor if this timestamp is not changing.')
  }
  return lines
}

const runHiveConnectStatusCommand = async ({
  deviceId,
  jsonOutput = false,
  localRequestTimeoutMs,
  localRuntimeUrl,
  serverUrl,
  statusFile,
  token,
}: {
  deviceId: string
  jsonOutput?: boolean
  localRequestTimeoutMs?: number | undefined
  localRuntimeUrl: string
  serverUrl?: string | undefined
  statusFile?: string | undefined
  token?: string | undefined
}): Promise<true> => {
  const lines: string[] = []
  const checks: Array<{
    id: string
    label: string
    message: string
    tone: 'error' | 'ok' | 'warn'
  }> = []
  let ok = true
  const relayReport: Record<string, unknown> = {
    configured: Boolean(serverUrl),
    ...(serverUrl ? { server: serverUrl } : {}),
    token_provided: Boolean(token),
  }
  let supervisorStatus: DesktopRelaySupervisorStatus | null = null
  const pushLine = (line: string) => lines.push(line)
  const addCheck = (id: string, label: string, tone: 'error' | 'ok' | 'warn', message: string) => {
    checks.push({ id, label, message, tone })
    if (tone === 'error') ok = false
  }
  const finish = (): true => {
    if (jsonOutput) {
      console.log(
        JSON.stringify({
          checks,
          desktop_id: deviceId,
          generated_at: new Date().toISOString(),
          lines,
          local_runtime: runtime,
          ok,
          relay: relayReport,
          runtime_url: localRuntimeUrl,
          supervisor: supervisorStatus,
        })
      )
    } else {
      for (const line of lines) console.log(line)
    }
    return true
  }

  pushLine(`Yive connect status: ${deviceId}`)
  const supervisorStatusFile = statusFile ?? DEFAULT_DESKTOP_SUPERVISOR_STATUS_FILE
  if (statusFile || existsSync(supervisorStatusFile)) {
    try {
      supervisorStatus = readDesktopRelaySupervisorStatusForCli(supervisorStatusFile)
      for (const line of formatDesktopRelaySupervisorStatusForCli(supervisorStatus)) {
        pushLine(line)
      }
      if (!supervisorStatus.found) {
        addCheck('desktop_supervisor', 'Desktop supervisor', 'warn', 'Status file was not found')
      } else if (supervisorStatus.stale) {
        addCheck('desktop_supervisor', 'Desktop supervisor', 'warn', 'Status file is stale')
      } else {
        addCheck('desktop_supervisor', 'Desktop supervisor', 'ok', supervisorStatus.phase ?? 'ok')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      supervisorStatus = { found: false, message, status_file: supervisorStatusFile }
      pushLine(`[warn] Desktop relay supervisor: ${message}`)
      addCheck('desktop_supervisor', 'Desktop supervisor', 'warn', message)
    }
  }
  const runtime = await readLocalRuntimeStatus(localRuntimeUrl, localRequestTimeoutMs)
  for (const line of formatLocalRuntimeStatusForCli(runtime, localRuntimeUrl)) pushLine(line)
  addCheck(
    'local_runtime',
    'Local runtime',
    runtime.runtimeStatus === 'online' ? 'ok' : 'error',
    runtime.runtimeMessage ?? runtime.runtimeStatus
  )

  if (!serverUrl) {
    pushLine('Relay: not configured')
    pushLine('Next: pass --server <relay-url> and --token <token> to verify Relay routing.')
    addCheck('relay_config', 'Relay config', 'warn', 'Relay server URL is not configured')
    ok = false
    return finish()
  }

  pushLine(`Relay: ${serverUrl}`)
  let health: Awaited<ReturnType<typeof readRelayHealthForCli>>
  try {
    health = await readRelayHealthForCli({ serverUrl })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    relayReport.error = message
    pushLine(`[fail] Relay HTTP: ${message}`)
    pushLine('Next: check DNS/IP, firewall, Nginx, and whether yive relay is running.')
    addCheck('relay_http', 'Relay HTTP', 'error', message)
    return finish()
  }

  relayReport.health = health
  pushLine(`[ok] Relay HTTP: ${health.service}${health.version ? ` ${health.version}` : ''}`)
  addCheck('relay_http', 'Relay HTTP', 'ok', health.service)
  if (typeof health.protocol_version === 'number') {
    const protocolSupported = isRelayHttpProtocolSupportedForCli(health)
    pushLine(
      `${protocolSupported ? '[ok]' : '[warn]'} Protocol: relay v${
        health.protocol_version
      }, CLI supports v${SUPPORTED_RELAY_HTTP_PROTOCOL_VERSION}`
    )
    addCheck(
      'relay_protocol',
      'Relay protocol',
      protocolSupported ? 'ok' : 'warn',
      `relay v${health.protocol_version}, CLI supports v${SUPPORTED_RELAY_HTTP_PROTOCOL_VERSION}`
    )
  }
  pushLine(`[ok] Connections: ${health.desktop_count} desktop, ${health.mobile_count} mobile`)

  if (!token) {
    pushLine('[warn] Token: not provided; cannot verify desktop registration or phone routing.')
    pushLine(`Next: rerun yive connect status --server ${serverUrl} --token <token>.`)
    addCheck('relay_token', 'Relay token', 'warn', 'Token was not provided')
    ok = false
    return finish()
  }

  let devices: Awaited<ReturnType<typeof listRelayOnlineDevicesForCli>>
  try {
    devices = await listRelayOnlineDevicesForCli({ serverUrl, token })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    relayReport.devices_error = message
    pushLine(`[fail] Token/devices: ${message}`)
    pushLine('Next: verify the relay token or pair this phone/desktop again.')
    addCheck('relay_devices', 'Relay devices', 'error', message)
    return finish()
  }

  relayReport.devices = {
    desktop_count: devices.desktops.length,
    mobile_count: devices.mobiles.length,
  }
  pushLine('[ok] Token: accepted')
  addCheck('relay_token', 'Relay token', 'ok', 'Token accepted')
  const desktop = devices.desktops.find((entry) => entry.device_id === deviceId)
  if (desktop) {
    relayReport.desktop = desktop
    relayReport.desktop_registered = true
    pushLine(`[ok] Desktop registration: ${formatRelayDesktopStatusForCli(desktop)}`)
    addCheck('desktop_registration', 'Desktop registration', 'ok', desktop.device_id)
    if (desktop.runtime_status !== 'online') {
      pushLine(
        '[warn] Desktop runtime: Relay can see this desktop, but local runtime is not online.'
      )
      pushLine(`Next: start local yive on ${localRuntimeUrl}, then rerun this status check.`)
      addCheck(
        'desktop_runtime',
        'Desktop runtime',
        'error',
        desktop.runtime_message ?? desktop.runtime_status ?? 'runtime is not online'
      )
    }
  } else {
    relayReport.desktop_registered = false
    pushLine(`[warn] Desktop registration: ${deviceId} is not currently connected to Relay.`)
    pushLine(
      `Next: start yive connect --server ${serverUrl} --token <token> --device-id ${deviceId} --runtime ${localRuntimeUrl}.`
    )
    addCheck(
      'desktop_registration',
      'Desktop registration',
      'error',
      `${deviceId} is not connected to Relay`
    )
  }

  const phonesForDesktop = devices.mobiles.filter((mobile) => mobile.desktop_id === deviceId)
  relayReport.phones_for_desktop = phonesForDesktop.map((mobile) => mobile.device_id)
  if (phonesForDesktop.length === 0) {
    pushLine('[warn] Mobile routing: no phone is currently paired to this desktop.')
    pushLine(
      `Next: create a phone link with yive relay pair --server ${serverUrl} --token <admin-token> --desktop-id ${deviceId}.`
    )
    addCheck('mobile_routing', 'Mobile routing', 'warn', 'No phone targets this desktop')
    ok = false
  } else if (desktop) {
    pushLine(
      `[ok] Mobile routing: ${phonesForDesktop.length} phone${
        phonesForDesktop.length === 1 ? '' : 's'
      } targets this desktop.`
    )
    addCheck(
      'mobile_routing',
      'Mobile routing',
      'ok',
      `${phonesForDesktop.length} phone targets this desktop`
    )
  } else {
    pushLine(
      `[fail] Mobile routing: ${phonesForDesktop
        .map((mobile) => mobile.device_id)
        .join(', ')} targets this desktop, but it is offline.`
    )
    addCheck(
      'mobile_routing',
      'Mobile routing',
      'error',
      `${phonesForDesktop.map((mobile) => mobile.device_id).join(', ')} targets offline ${deviceId}`
    )
  }

  return finish()
}

export const runHiveConnectCommand = async (argv: string[]) => {
  const command = argv[0]
  const args = command === 'status' ? argv.slice(1) : argv
  const serverUrlValue = readFlag(argv, '--server') ?? process.env.YIVE_RELAY_SERVER
  const token = readFlag(args, '--token') ?? process.env.YIVE_RELAY_TOKEN
  const deviceId = readFlag(args, '--device-id') ?? process.env.YIVE_RELAY_DEVICE_ID ?? hostname()
  const localRuntimeUrl =
    readFlag(args, '--runtime') ?? process.env.YIVE_RELAY_RUNTIME_URL ?? 'http://127.0.0.1:3001'
  const statusFile = readFlag(args, '--status-file') ?? process.env.YIVE_RELAY_STATUS_FILE
  const mobileUrl = readFlag(argv, '--mobile-url') ?? process.env.YIVE_MOBILE_URL
  const localRequestTimeoutMs = parsePositiveIntegerOption(
    readFlag(args, '--local-request-timeout-ms') ?? process.env.YIVE_RELAY_LOCAL_REQUEST_TIMEOUT_MS,
    'local request timeout'
  )
  const requireRuntime =
    argv.includes('--require-runtime') || process.env.YIVE_RELAY_REQUIRE_RUNTIME === '1'
  const serverUrl = serverUrlValue ? normalizeRelayServerUrlForCli(serverUrlValue) : undefined
  if (command === 'status') {
    return runHiveConnectStatusCommand({
      deviceId,
      jsonOutput: args.includes('--json'),
      localRequestTimeoutMs,
      localRuntimeUrl,
      serverUrl,
      statusFile,
      token,
    })
  }
  if (!serverUrlValue || !token) {
    throw new Error(
      'Usage: yive connect --server <relay-url> --token <token> [--device-id <id>] [--runtime <url>] [--mobile-url <url>] [--local-request-timeout-ms <ms>] [--require-runtime]'
    )
  }
  if (!serverUrl) throw new Error('Relay server URL is required')
  const urls = await createMobileRelayUrlsForConnect({
    adminToken: token,
    deviceId,
    mobileUrl,
    serverUrl,
  })
  console.log(`Yive desktop relay device: ${deviceId}`)
  const runtime = await readLocalRuntimeStatus(localRuntimeUrl, localRequestTimeoutMs)
  for (const line of formatLocalRuntimeStatusForCli(runtime, localRuntimeUrl)) console.log(line)
  if (requireRuntime && runtime.runtimeStatus !== 'online') {
    throw new Error(`Local runtime is required before connecting this desktop to Relay.`)
  }
  if (urls) {
    console.log(`Mobile pairing URL: ${urls.pairingUrl}`)
    console.log(`Direct desktop URL: ${urls.directUrl}`)
  }
  await runRelayDesktopClient({
    deviceId,
    ...(localRequestTimeoutMs ? { localRequestTimeoutMs } : {}),
    localRuntimeUrl,
    serverUrl,
    token,
  })
}

export const formatLocalRuntimeStatusForCli = (
  runtime: RelayDesktopRuntimeSnapshot,
  localRuntimeUrl: string
): string[] => {
  const statusLine = `Local runtime: ${runtime.runtimeStatus}${
    runtime.runtimeMessage ? ` (${runtime.runtimeMessage})` : ''
  }`
  if (runtime.runtimeStatus !== 'offline') return [statusLine]
  return [
    statusLine,
    `Hint: start local yive on ${localRuntimeUrl} before using this desktop from mobile.`,
  ]
}

const resolveDataDir = () =>
  process.env.YIVE_DATA_DIR || process.env.HIVE_DATA_DIR || join(homedir(), '.config', 'yive')

const runtimeDatabaseHasWorkspaces = (databasePath: string): boolean => {
  if (!existsSync(databasePath)) return false
  let db: BetterSqlite3.Database | null = null
  try {
    db = new BetterSqlite3(databasePath, { readonly: true })
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'")
      .get()
    if (!table) return false
    const row = db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as
      | { count?: unknown }
      | undefined
    return typeof row?.count === 'number' && row.count > 0
  } catch {
    return false
  } finally {
    db?.close()
  }
}

export const migrateLegacyHiveDataDirIfNeeded = (
  dataDir: string,
  options: { homeDir?: string } = {}
): void => {
  if (process.env.YIVE_DATA_DIR || process.env.HIVE_DATA_DIR) return

  const homeDir = options.homeDir ?? homedir()
  const yiveDir = join(homeDir, '.config', 'yive')
  if (dataDir !== yiveDir) return

  const yiveDatabase = join(yiveDir, 'runtime.sqlite')
  if (runtimeDatabaseHasWorkspaces(yiveDatabase)) return

  const legacyDatabase = join(homeDir, '.config', 'hive', 'runtime.sqlite')
  if (!runtimeDatabaseHasWorkspaces(legacyDatabase)) return

  mkdirSync(yiveDir, { recursive: true })
  copyFileSync(legacyDatabase, yiveDatabase)
}

const resolveListenHost = () => process.env.HIVE_RUNTIME_HOST || '127.0.0.1'

const maybePrintUpdateHint = async (versionService: VersionService) => {
  const info = await versionService.getVersionInfo()
  if (!info.update_available) return
  console.log(
    `Yive update available: ${info.current_version} -> ${info.latest_version}. Run: ${info.install_hint}`
  )
}

const isListenError = (error: unknown): error is ListenError =>
  error instanceof Error && typeof (error as ListenError).code === 'string'

const formatPortInUseMessage = (port: number) =>
  [
    `Yive could not start because port ${port} is already in use.`,
    '',
    'Another Yive instance may already be running:',
    `  http://127.0.0.1:${port}`,
    '',
    'Options:',
    '  - Open the existing Yive window.',
    '  - Stop the process using that port:',
    `      lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill`,
    '  - Start Yive on another port:',
    `      yive --port ${port + 1}`,
  ].join('\n')

const formatListenError = (error: unknown, requestedPort: number) => {
  if (isListenError(error) && error.code === 'EADDRINUSE') {
    return new Error(formatPortInUseMessage(error.port ?? requestedPort))
  }
  return error
}

export const runHiveCommand = async (
  argv: string[],
  options: RunHiveCommandOptions = {}
): Promise<RunHiveCommandResult> => {
  const port = parsePort(argv)
  const dataDir = resolveDataDir()
  const host = resolveListenHost()
  const versionService = options.versionService ?? createVersionService()
  migrateLegacyHiveDataDirIfNeeded(dataDir)
  const app = createApp({
    store: createRuntimeStore({
      agentManager: createAgentManager(),
      dataDir,
    }),
    versionService,
  })

  try {
    app.server.listen(port, host)
    await Promise.race([
      once(app.server, 'listening'),
      once(app.server, 'error').then(([error]) => {
        throw error
      }),
    ])
  } catch (error) {
    await app.store.close()
    throw formatListenError(error, port)
  }

  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }

  let closePromise: Promise<void> | null = null
  const close = async () => {
    if (closePromise) {
      return closePromise
    }

    closePromise = (async () => {
      process.off('SIGTERM', gracefulShutdown)
      process.off('SIGINT', gracefulShutdown)
      await new Promise<void>((resolve, reject) => {
        app.server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
      await app.store.close()
    })()

    return closePromise
  }

  const gracefulShutdown = () => {
    void close()
      .then(() => {
        process.exit(0)
      })
      .catch((error) => {
        console.error(error)
        process.exit(1)
      })
  }

  process.once('SIGTERM', gracefulShutdown)
  process.once('SIGINT', gracefulShutdown)

  console.log(`Yive running at http://${host}:${address.port}`)
  void maybePrintUpdateHint(versionService).catch(() => {})

  return {
    port: address.port,
    close,
    store: app.store,
  }
}

export type { RunHiveCommandResult }

const isMainModule = process.argv[1]
  ? fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  : false

if (isMainModule) {
  const argv = process.argv.slice(2)
  if (argv[0] === 'update') {
    runHiveUpdateCommand(argv.slice(1))
      .then((code) => process.exit(code))
      .catch((error) => {
        console.error(error)
        process.exit(1)
      })
  } else if (argv[0] === 'team') {
    runTeamCommand(argv.slice(1))
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : error)
        process.exit(1)
      })
  } else if (argv[0] === 'agent') {
    runAgentCommand(argv.slice(1))
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : error)
        process.exit(1)
      })
  } else if (argv[0] === 'relay') {
    if (argv.slice(1).includes('--help') || argv.slice(1).includes('-h')) {
      console.log(HIVE_USAGE)
      process.exit(0)
    }
    runRelayAdminCommand(argv.slice(1))
      .then((handled) => {
        if (handled) return
        return runRelayServer(argv.slice(1))
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : error)
        process.exit(1)
      })
  } else if (argv[0] === 'connect') {
    runHiveConnectCommand(argv.slice(1)).catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
  } else if (argv[0] === 'mobile') {
    runHiveMobileCommand(argv.slice(1)).catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
  } else if (handleHiveInfoCommand(argv)) {
    process.exit(0)
  } else {
    runHiveCommand(argv).catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
  }
}
