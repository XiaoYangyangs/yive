#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'

const usage = `Usage: node deploy/smoke-mobile-events-relay.mjs --server <url> --token <admin-token> --desktop-id <id> [--device-id <id>] [--timeout-ms <ms>] [--max-stale-ms <ms>] [--require-live-update]

Examples:
  node deploy/smoke-mobile-events-relay.mjs --server http://203.0.113.10 --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows
  node deploy/smoke-mobile-events-relay.mjs --server https://relay.example.com --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows
  node deploy/smoke-mobile-events-relay.mjs --server https://relay.example.com --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows --max-stale-ms 30000
  node deploy/smoke-mobile-events-relay.mjs --server https://relay.example.com --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows --require-live-update
`

const readFlag = (argv, name) => {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  return argv[index + 1]
}

const normalizeServerUrl = (value) => {
  if (!value || value.startsWith('--')) throw new Error(usage)
  const trimmed = value.trim().replace(/\/+$/u, '')
  if (!trimmed) throw new Error(usage)
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

const toWebSocketUrl = (serverUrl, path, params) => {
  const url = new URL(path, serverUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'manual',
    ...options,
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${url} returned non-JSON: ${text.slice(0, 120)}`)
  }
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && typeof body.error === 'string'
        ? body.error
        : `${response.status} ${response.statusText}`
    throw new Error(`${url} failed: ${message}`)
  }
  return body
}

const waitForOpen = (socket, timeoutMs, label) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      socket.close()
      reject(new Error(`${label} timed out while opening`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('open', onOpen)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (error) => {
      cleanup()
      reject(error instanceof Error ? error : new Error(`${label} failed`))
    }
    const onClose = (code, reason) => {
      cleanup()
      reject(
        new Error(
          `${label} closed before opening: ${code}${reason.length ? ` ${reason.toString()}` : ''}`
        )
      )
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
    socket.once('close', onClose)
  })

const describeRelayEnvelopeError = (message) => {
  if (!message || typeof message !== 'object') return null
  if (message.type === 'relay_error') {
    const payload = message.payload
    const code =
      payload && typeof payload === 'object' && typeof payload.code === 'string'
        ? payload.code
        : 'relay_error'
    const detail =
      payload && typeof payload === 'object' && typeof payload.message === 'string'
        ? payload.message
        : 'Relay returned an error'
    return `${code}: ${detail}`
  }
  if (message.type === 'mobile_events_close') {
    const payload = message.payload
    const reason =
      payload && typeof payload === 'object' && typeof payload.reason === 'string'
        ? payload.reason
        : 'Mobile events subscription closed'
    return `mobile_events_close: ${reason}`
  }
  return null
}

const getSnapshotGeneratedAt = (message) => {
  const generatedAt = message?.payload?.snapshot?.generated_at
  return typeof generatedAt === 'number' ? generatedAt : null
}

export const buildMobileEventsSmokeQuality = ({
  desktop,
  heartbeatAt,
  liveUpdateAt,
  now,
  snapshotAt,
}) => {
  const age = (value) => (typeof value === 'number' ? Math.max(0, now - value) : null)
  return {
    desktop_last_seen_age_ms: age(desktop?.last_seen_at),
    runtime_status_age_ms: age(desktop?.runtime_updated_at),
    supervisor_status: desktop?.supervisor_status ?? null,
    supervisor_status_age_ms: age(desktop?.supervisor_updated_at),
    heartbeat_age_ms: age(heartbeatAt),
    live_update_age_ms: age(liveUpdateAt),
    snapshot_age_ms: age(snapshotAt),
  }
}

export const assertMobileEventsSmokeFreshness = ({ maxStaleMs, quality, requireLiveUpdate }) => {
  if (!Number.isInteger(maxStaleMs) || maxStaleMs <= 0) {
    throw new Error('--max-stale-ms must be a positive integer')
  }
  const staleFields = [
    ['desktop_last_seen_age_ms', 'desktop last_seen'],
    ['runtime_status_age_ms', 'runtime status'],
    ['heartbeat_age_ms', 'mobile heartbeat'],
    ['snapshot_age_ms', 'mobile snapshot'],
    ...(requireLiveUpdate ? [['live_update_age_ms', 'mobile live update']] : []),
    ...(quality.supervisor_status && quality.supervisor_status !== 'missing'
      ? [['supervisor_status_age_ms', 'desktop supervisor status']]
      : []),
  ]
    .map(([key, label]) => ({ age: quality[key], key, label }))
    .filter((item) => typeof item.age !== 'number' || item.age > maxStaleMs)

  const supervisorStatus = quality.supervisor_status
  const supervisorFailure =
    supervisorStatus === 'error' || supervisorStatus === 'stale'
      ? `desktop supervisor status=${supervisorStatus}`
      : null

  if (staleFields.length === 0 && !supervisorFailure) return
  const details = staleFields
    .map((item) => `${item.label}=${typeof item.age === 'number' ? `${item.age}ms` : 'missing'}`)
    .join(', ')
  throw new Error(
    `Mobile events freshness check failed; max ${maxStaleMs}ms, ${[details, supervisorFailure]
      .filter(Boolean)
      .join(', ')}`
  )
}

export const waitForMobileEvents = (
  socket,
  timeoutMs,
  subscriptionId,
  { requireLiveUpdate = false } = {}
) =>
  new Promise((resolve, reject) => {
    let heartbeatMessage = null
    let snapshotMessage = null
    let liveUpdateMessage = null
    const timeout = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          `Timed out waiting for mobile events snapshot, heartbeat${
            requireLiveUpdate ? ', and live update' : ''
          }: snapshot=${snapshotMessage ? 'received' : 'missing'}, heartbeat=${
            heartbeatMessage ? 'received' : 'missing'
          }${
            requireLiveUpdate ? `, live_update=${liveUpdateMessage ? 'received' : 'missing'}` : ''
          }`
        )
      )
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('message', onMessage)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onMessage = (raw) => {
      let message
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      const relayError = describeRelayEnvelopeError(message)
      if (relayError) {
        cleanup()
        reject(new Error(relayError))
        return
      }
      if (
        message &&
        message.channel === 'mobile_events' &&
        message.type === 'mobile_events_message' &&
        message.request_id === subscriptionId
      ) {
        if (message.payload?.type === 'mobile-snapshot') {
          if (!snapshotMessage) {
            snapshotMessage = message
          } else if (
            requireLiveUpdate &&
            getSnapshotGeneratedAt(message) !== null &&
            getSnapshotGeneratedAt(message) !== getSnapshotGeneratedAt(snapshotMessage)
          ) {
            liveUpdateMessage = message
          }
        }
        if (
          message.payload?.type === 'mobile-heartbeat' &&
          typeof message.payload.generated_at === 'number'
        ) {
          heartbeatMessage = message
        }
      }
      if (!snapshotMessage || !heartbeatMessage) return
      if (requireLiveUpdate && !liveUpdateMessage) return
      cleanup()
      resolve({ heartbeatMessage, liveUpdateMessage, snapshotMessage })
    }
    const onError = (error) => {
      cleanup()
      reject(error instanceof Error ? error : new Error('Mobile relay socket failed'))
    }
    const onClose = (code, reason) => {
      cleanup()
      reject(
        new Error(
          `Mobile relay socket closed before snapshot: ${code}${
            reason.length ? ` ${reason.toString()}` : ''
          }`
        )
      )
    }
    socket.on('message', onMessage)
    socket.once('error', onError)
    socket.once('close', onClose)
  })

const checkDesktopReady = async (serverUrl, adminToken, desktopId) => {
  const devices = await requestJson(new URL('/devices', serverUrl), {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  const desktops = Array.isArray(devices?.desktops) ? devices.desktops : []
  const desktop = desktops.find((entry) => entry?.device_id === desktopId)
  if (!desktop) {
    throw new Error(
      `Desktop '${desktopId}' is not connected to Relay. Start the local desktop bridge with yive connect before running this smoke test.`
    )
  }
  if (desktop.runtime_status === 'offline') {
    const message =
      typeof desktop.runtime_message === 'string' && desktop.runtime_message.trim()
        ? ` (${desktop.runtime_message.trim()})`
        : ''
    throw new Error(
      `Desktop '${desktopId}' is connected to Relay, but its local Yive runtime is offline${message}. Start or restart local Yive before running this smoke test.`
    )
  }
  return desktop
}

export const buildSmokeMobileEventsRelayConfig = (argv, env = process.env, now = Date.now) => {
  const serverUrl = normalizeServerUrl(readFlag(argv, '--server'))
  const adminToken = readFlag(argv, '--token') ?? env.YIVE_RELAY_ADMIN_TOKEN
  const desktopId = readFlag(argv, '--desktop-id')
  const deviceId = readFlag(argv, '--device-id') ?? `smoke-mobile-${now()}`
  const maxStaleMs = Number.parseInt(readFlag(argv, '--max-stale-ms') ?? '120000', 10)
  const requireLiveUpdate = argv.includes('--require-live-update')
  const timeoutMs = Number.parseInt(readFlag(argv, '--timeout-ms') ?? '30000', 10)

  if (!adminToken || adminToken.startsWith('--') || !desktopId || desktopId.startsWith('--')) {
    throw new Error(usage)
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer')
  }
  if (!Number.isInteger(maxStaleMs) || maxStaleMs <= 0) {
    throw new Error('--max-stale-ms must be a positive integer')
  }

  return { adminToken, desktopId, deviceId, maxStaleMs, requireLiveUpdate, serverUrl, timeoutMs }
}

export const runSmokeMobileEventsRelay = async ({
  argv = process.argv.slice(2),
  env = process.env,
  now = Date.now,
} = {}) => {
  const { adminToken, desktopId, deviceId, maxStaleMs, requireLiveUpdate, serverUrl, timeoutMs } =
    buildSmokeMobileEventsRelayConfig(argv, env, now)
  let socket
  try {
    const desktop = await checkDesktopReady(serverUrl, adminToken, desktopId)
    const pairing = await requestJson(new URL('/pairings', serverUrl), {
      headers: { authorization: `Bearer ${adminToken}` },
      method: 'POST',
    })
    if (!pairing || typeof pairing.token !== 'string') {
      throw new Error('/pairings did not return a token')
    }

    const claimed = await requestJson(new URL('/pairings/claim', serverUrl), {
      body: JSON.stringify({
        desktop_id: desktopId,
        device_id: deviceId,
        token: pairing.token,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    if (!claimed || typeof claimed.token !== 'string') {
      throw new Error('/pairings/claim did not return a device token')
    }

    socket = new WebSocket(
      toWebSocketUrl(serverUrl, '/ws/mobile', {
        desktop_id: desktopId,
        device_id: deviceId,
        pairing_token: claimed.token,
      })
    )
    await waitForOpen(socket, timeoutMs, 'Mobile relay socket')

    const subscriptionId = `smoke-sub-${now()}`
    const mobileEvents = waitForMobileEvents(socket, timeoutMs, subscriptionId, {
      requireLiveUpdate,
    })
    socket.send(
      JSON.stringify({
        channel: 'mobile_events',
        from: deviceId,
        payload: { subscription_id: subscriptionId },
        request_id: subscriptionId,
        to: desktopId,
        type: 'subscribe_mobile_events',
      })
    )

    const { heartbeatMessage, liveUpdateMessage, snapshotMessage } = await mobileEvents

    socket.send(
      JSON.stringify({
        channel: 'mobile_events',
        from: deviceId,
        payload: { subscription_id: subscriptionId },
        request_id: subscriptionId,
        to: desktopId,
        type: 'unsubscribe_mobile_events',
      })
    )

    const snapshot = snapshotMessage.payload.snapshot
    const snapshotAt = snapshot?.generated_at
    const heartbeatAt = heartbeatMessage.payload.generated_at
    const liveUpdateAt = liveUpdateMessage?.payload?.snapshot?.generated_at ?? null
    const workspaceCount = Array.isArray(snapshot?.workspaces) ? snapshot.workspaces.length : 0
    const activeWorkspace = snapshot?.active_workspace?.workspace?.name ?? 'none'
    const quality = buildMobileEventsSmokeQuality({
      desktop,
      heartbeatAt,
      liveUpdateAt,
      now: now(),
      snapshotAt,
    })
    assertMobileEventsSmokeFreshness({ maxStaleMs, quality, requireLiveUpdate })
    return {
      activeWorkspace,
      desktopId,
      deviceId,
      heartbeatAt,
      liveUpdateAt,
      maxStaleMs,
      quality,
      requireLiveUpdate,
      runtimeStatus: desktop.runtime_status ?? 'unknown',
      serverUrl,
      snapshotAt,
      supervisorPhase: desktop.supervisor_phase ?? null,
      supervisorStatus: desktop.supervisor_status ?? 'unknown',
      supervisorUpdatedAt: desktop.supervisor_updated_at ?? null,
      workspaceCount,
    }
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close()
    await fetch(new URL(`/pairings/devices/${encodeURIComponent(deviceId)}`, serverUrl), {
      headers: { authorization: `Bearer ${adminToken}` },
      method: 'DELETE',
    }).catch(() => undefined)
  }
}

const main = async () => {
  const result = await runSmokeMobileEventsRelay()
  console.log(`Yive mobile events relay smoke test passed for ${result.serverUrl}`)
  console.log(`- desktop: ${result.desktopId}`)
  console.log(`- desktop runtime: ${result.runtimeStatus}`)
  console.log(
    `- desktop supervisor: ${result.supervisorStatus}${
      result.supervisorPhase ? ` (${result.supervisorPhase})` : ''
    }`
  )
  console.log(`- mobile test device: ${result.deviceId}`)
  console.log(`- workspaces: ${result.workspaceCount}`)
  console.log(`- active workspace: ${result.activeWorkspace}`)
  console.log(
    `- snapshot: ${typeof result.snapshotAt === 'number' ? new Date(result.snapshotAt).toISOString() : 'missing'}`
  )
  console.log(`- heartbeat: ${new Date(result.heartbeatAt).toISOString()}`)
  console.log(
    `- freshness: snapshot ${result.quality.snapshot_age_ms ?? 'unknown'}ms, heartbeat ${
      result.quality.heartbeat_age_ms ?? 'unknown'
    }ms, runtime ${result.quality.runtime_status_age_ms ?? 'unknown'}ms`
  )
  if (result.requireLiveUpdate) {
    console.log(
      `- live update: ${
        result.liveUpdateAt === null ? 'missing' : new Date(result.liveUpdateAt).toISOString()
      }`
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
