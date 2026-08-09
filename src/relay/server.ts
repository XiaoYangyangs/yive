#!/usr/bin/env node

import { once } from 'node:events'
import { realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleRelayHttpRequest } from './http-routes.js'
import { createDevelopmentPairingStore, normalizeRelayDeviceId } from './pairing-store.js'
import { RelayHub } from './relay-hub.js'
import { createRelayWebSocketRouter } from './ws-router.js'

export interface CreateRelayServerOptions {
  accountLogin?: { desktopId?: string | undefined; password: string; username: string } | undefined
  heartbeatIntervalMs?: number | undefined
  heartbeatTimeoutMs?: number | undefined
  pairingStorePath?: string | undefined
  pairingToken?: string | undefined
  publicUrl?: string | undefined
  requireDesktopBinding?: boolean | undefined
  staticDir?: string | undefined
}

export interface RelayServerArgs {
  accountLogin?: { desktopId?: string | undefined; password: string; username: string } | undefined
  heartbeatIntervalMs?: number | undefined
  heartbeatTimeoutMs?: number | undefined
  host: string
  pairingStorePath?: string | undefined
  pairingToken?: string | undefined
  port: number
  publicUrl?: string | undefined
  requireDesktopBinding: boolean
  staticDir?: string | undefined
}

const RELAY_USAGE =
  'Usage: yive relay [--host <host>] [--port <port>] [--token <token>] [--store-file <path>] [--static-dir <path>] [--heartbeat-interval-ms <ms>] [--heartbeat-timeout-ms <ms>] [--require-desktop-binding]'

export const createRelayServer = (options: CreateRelayServerOptions = {}) => {
  const startedAt = Date.now()
  const hub = new RelayHub({
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
  })
  const pairingStore = createDevelopmentPairingStore({
    storagePath: options.pairingStorePath,
    token: options.pairingToken,
  })
  const server = createServer((request, response) => {
    void handleRelayHttpRequest(request, response, hub, pairingStore, {
      accountLogin: options.accountLogin,
      publicUrl: options.publicUrl,
      requireDesktopBinding: options.requireDesktopBinding,
      startedAt,
      staticDir: options.staticDir,
    }).catch((error) => {
      response.statusCode = 500
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Relay request failed' })
      )
    })
  })
  createRelayWebSocketRouter(server, hub, pairingStore, {
    requireDesktopBinding: options.requireDesktopBinding,
  })
  return { hub, server }
}

const readFlagValue = (argv: string[], flag: string, options: { requiredValue?: boolean } = {}) => {
  const flagIndex = argv.indexOf(flag)
  if (flagIndex === -1) return undefined
  const value = argv[flagIndex + 1]
  if (options.requiredValue && (!value || value.startsWith('--'))) throw new Error(RELAY_USAGE)
  return value
}

const parseOptionalMilliseconds = (
  value: string | undefined,
  name: string,
  options: { allowZero: boolean }
) => {
  if (value === undefined) return undefined
  const pattern = options.allowZero ? /^(?:0|[1-9]\d*)$/u : /^[1-9]\d*$/u
  if (!pattern.test(value)) {
    throw new Error(
      `${name} must be ${options.allowZero ? '0 or a positive' : 'a positive'} integer. ${RELAY_USAGE}`
    )
  }
  return Number.parseInt(value, 10)
}

const parseRelayHost = (value: string | undefined) => {
  if (value !== undefined && !value.trim()) {
    throw new Error(`relay host must not be empty or contain whitespace. ${RELAY_USAGE}`)
  }
  const host = value?.trim() || '127.0.0.1'
  if (/\s/u.test(host)) {
    throw new Error(`relay host must not be empty or contain whitespace. ${RELAY_USAGE}`)
  }
  return host
}

export const parseRelayServerArgs = (
  argv: string[],
  env: Record<string, string | undefined> = process.env
): RelayServerArgs => {
  const pairingStorePath =
    readFlagValue(argv, '--store-file', { requiredValue: true }) ?? env.YIVE_RELAY_PAIRING_STORE
  const staticDir =
    readFlagValue(argv, '--static-dir', { requiredValue: true }) ??
    env.YIVE_RELAY_STATIC_DIR ??
    env.HIVE_RELAY_STATIC_DIR ??
    env.HIVE_STATIC_DIR
  const token =
    readFlagValue(argv, '--token', { requiredValue: true }) ??
    env.YIVE_RELAY_ADMIN_TOKEN ??
    env.HIVE_RELAY_DEV_TOKEN
  const hostValue = readFlagValue(argv, '--host', { requiredValue: true }) ?? env.YIVE_RELAY_HOST
  const portValue = readFlagValue(argv, '--port', { requiredValue: true })
  const requireDesktopBinding =
    argv.includes('--require-desktop-binding') || env.YIVE_RELAY_REQUIRE_DESKTOP_BINDING === '1'
  const heartbeatIntervalValue =
    readFlagValue(argv, '--heartbeat-interval-ms', { requiredValue: true }) ??
    env.YIVE_RELAY_HEARTBEAT_INTERVAL_MS
  const heartbeatTimeoutValue =
    readFlagValue(argv, '--heartbeat-timeout-ms', { requiredValue: true }) ??
    env.YIVE_RELAY_HEARTBEAT_TIMEOUT_MS
  const publicUrl = env.YIVE_RELAY_PUBLIC_URL?.trim()
  const accountUsername = env.YIVE_RELAY_ACCOUNT_USERNAME?.trim()
  const accountPassword = env.YIVE_RELAY_ACCOUNT_PASSWORD?.trim()
  const accountDesktopIdInput = env.YIVE_RELAY_ACCOUNT_DESKTOP_ID?.trim()
  const accountDesktopId = accountDesktopIdInput
    ? normalizeRelayDeviceId(accountDesktopIdInput)
    : undefined
  if (accountDesktopIdInput && !accountDesktopId) {
    throw new Error(`YIVE_RELAY_ACCOUNT_DESKTOP_ID is invalid. ${RELAY_USAGE}`)
  }
  const accountLogin =
    accountUsername && accountPassword
      ? {
          ...(accountDesktopId ? { desktopId: accountDesktopId } : {}),
          password: accountPassword,
          username: accountUsername,
        }
      : undefined
  const port = portValue === undefined ? 4020 : Number.parseInt(portValue, 10)
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(RELAY_USAGE)
  }
  return {
    heartbeatIntervalMs: parseOptionalMilliseconds(heartbeatIntervalValue, 'heartbeat interval', {
      allowZero: true,
    }),
    heartbeatTimeoutMs: parseOptionalMilliseconds(heartbeatTimeoutValue, 'heartbeat timeout', {
      allowZero: false,
    }),
    ...(accountLogin ? { accountLogin } : {}),
    host: parseRelayHost(hostValue),
    pairingStorePath,
    pairingToken: token,
    port,
    ...(publicUrl ? { publicUrl } : {}),
    requireDesktopBinding,
    staticDir,
  }
}

const resolveDefaultPairingStorePath = () =>
  process.env.YIVE_RELAY_PAIRING_STORE || join(homedir(), '.config', 'yive', 'relay-pairings.json')

export const runRelayServer = async (argv: string[] = process.argv.slice(2)) => {
  const {
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    accountLogin,
    pairingStorePath,
    pairingToken,
    host,
    port,
    publicUrl,
    requireDesktopBinding,
    staticDir,
  } = parseRelayServerArgs(argv)
  const app = createRelayServer({
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    accountLogin,
    pairingStorePath: pairingStorePath ?? resolveDefaultPairingStorePath(),
    pairingToken,
    publicUrl,
    requireDesktopBinding,
    staticDir,
  })
  app.server.listen(port, host)
  await Promise.race([
    once(app.server, 'listening'),
    once(app.server, 'error').then(([error]) => {
      throw error
    }),
  ])

  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Relay did not bind to a port')
  console.log(`Hive Relay running at http://${host}:${address.port}`)
  return app
}

const isMainModule = process.argv[1]
  ? fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  : false

if (isMainModule) {
  runRelayServer().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
