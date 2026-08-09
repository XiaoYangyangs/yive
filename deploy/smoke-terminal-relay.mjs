#!/usr/bin/env node

import { fileURLToPath } from 'node:url'

import WebSocket from 'ws'

const usage = `Usage: node deploy/smoke-terminal-relay.mjs --server <url> --token <admin-token> --desktop-id <id> [--run-id <run-id>] [--workspace-id <id>] [--device-id <id>] [--stream io|control] [--open-only] [--takeover-cols <n>] [--takeover-rows <n>] [--terminal-input <text>] [--expect-output <text>] [--verify-terminal-output] [--no-terminal-enter] [--timeout-ms <ms>] [--settle-ms <ms>]

Examples:
  node deploy/smoke-terminal-relay.mjs --server http://203.0.113.10 --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows
  node deploy/smoke-terminal-relay.mjs --server https://relay.example.com --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows --run-id run-123
  node deploy/smoke-terminal-relay.mjs --server http://203.0.113.10 --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows --open-only --stream io
  node deploy/smoke-terminal-relay.mjs --server https://relay.example.com --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows --verify-terminal-output
  node deploy/smoke-terminal-relay.mjs --server https://relay.example.com --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows --terminal-input "node -e \\"console.log('YIVE_RELAY_OK')\\"" --expect-output "YIVE_RELAY_OK"
`

export const TERMINAL_OUTPUT_SMOKE_SENTINEL = 'YIVE_RELAY_OK'
export const TERMINAL_OUTPUT_SMOKE_COMMAND = `node -e "console.log('${TERMINAL_OUTPUT_SMOKE_SENTINEL}')"`

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

const assertSocketStaysOpen = (socket, settleMs, label) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, settleMs)
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onError = (error) => {
      cleanup()
      reject(error instanceof Error ? error : new Error(`${label} failed`))
    }
    const onClose = (code, reason) => {
      cleanup()
      reject(
        new Error(
          `${label} closed during setup: ${code}${reason.length ? ` ${reason.toString()}` : ''}`
        )
      )
    }
    socket.once('error', onError)
    socket.once('close', onClose)
  })

const waitForControlMessage = (socket, timeoutMs, predicate, label) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${label}`))
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
      if (message.type === 'error') {
        cleanup()
        reject(new Error(`Terminal control error: ${message.message ?? 'unknown error'}`))
        return
      }
      if (message.type === 'takeover_denied') {
        cleanup()
        reject(new Error(`Terminal takeover denied: ${message.reason ?? 'unknown reason'}`))
        return
      }
      if (!predicate(message)) return
      cleanup()
      resolve(message)
    }
    const onError = (error) => {
      cleanup()
      reject(error instanceof Error ? error : new Error(`${label} failed`))
    }
    const onClose = (code, reason) => {
      cleanup()
      reject(
        new Error(
          `Terminal control socket closed while waiting for ${label}: ${code}${
            reason.length ? ` ${reason.toString()}` : ''
          }`
        )
      )
    }
    socket.on('message', onMessage)
    socket.once('error', onError)
    socket.once('close', onClose)
  })

const verifyTakeoverHeartbeat = async ({ settleMs, socket }) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, settleMs)
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
      if (message.type === 'error') {
        cleanup()
        reject(new Error(`Terminal heartbeat error: ${message.message ?? 'unknown error'}`))
        return
      }
      if (message.type === 'takeover_denied') {
        cleanup()
        reject(
          new Error(
            `Terminal takeover denied during heartbeat: ${message.reason ?? 'unknown reason'}`
          )
        )
      }
    }
    const onError = (error) => {
      cleanup()
      reject(error instanceof Error ? error : new Error('Terminal heartbeat failed'))
    }
    const onClose = (code, reason) => {
      cleanup()
      reject(
        new Error(
          `Terminal control socket closed during heartbeat: ${code}${
            reason.length ? ` ${reason.toString()}` : ''
          }`
        )
      )
    }
    socket.on('message', onMessage)
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.send(JSON.stringify({ type: 'takeover_heartbeat' }))
  })

export const assertTakeoverGrantedForSmoke = (message, { cols, rows }) => {
  if (!message || typeof message !== 'object' || message.type !== 'takeover_granted') {
    throw new Error('Terminal takeover did not return takeover_granted')
  }
  if (message.cols !== cols || message.rows !== rows) {
    throw new Error(
      `Terminal takeover size mismatch: expected ${cols}x${rows}, got ${String(
        message.cols
      )}x${String(message.rows)}`
    )
  }
  if (message.previousSize !== undefined) {
    if (
      typeof message.previousSize !== 'object' ||
      !Number.isInteger(message.previousSize.cols) ||
      !Number.isInteger(message.previousSize.rows) ||
      message.previousSize.cols <= 0 ||
      message.previousSize.rows <= 0
    ) {
      throw new Error('Terminal takeover previousSize was invalid')
    }
  }
}

export const assertTakeoverReleasedForSmoke = (message) => {
  if (!message || typeof message !== 'object' || message.type !== 'size_owner_changed') {
    throw new Error('Terminal takeover release did not return size_owner_changed')
  }
  if (message.mode === 'takeover') {
    throw new Error('Terminal takeover release left the terminal in takeover mode')
  }
  if (message.ownerClientId !== null && typeof message.ownerClientId !== 'string') {
    throw new Error('Terminal takeover release returned invalid ownerClientId')
  }
}

const verifyTakeover = async ({ cols, heartbeatSettleMs, rows, socket, timeoutMs }) => {
  const grantedPromise = waitForControlMessage(
    socket,
    timeoutMs,
    (message) => message.type === 'takeover_granted',
    'takeover_granted'
  )
  socket.send(
    JSON.stringify({
      type: 'takeover_request',
      cols,
      restore_on_release: true,
      rows,
    })
  )
  const granted = await grantedPromise
  assertTakeoverGrantedForSmoke(granted, { cols, rows })
  await verifyTakeoverHeartbeat({ settleMs: heartbeatSettleMs, socket })
  const releasePromise = waitForControlMessage(
    socket,
    timeoutMs,
    (message) => message.type === 'size_owner_changed',
    'size_owner_changed after takeover_release'
  )
  socket.send(JSON.stringify({ type: 'takeover_release' }))
  const released = await releasePromise
  assertTakeoverReleasedForSmoke(released)
  return granted
}

const describeRelayEnvelopeError = (message) => {
  if (!message || typeof message !== 'object') return null
  if (message.type !== 'relay_error') return null
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

const requestRelayRuntime = ({ desktopId, deviceId, payload = {}, socket, timeoutMs, type }) =>
  new Promise((resolve, reject) => {
    const requestId = `smoke-${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${type}_result`))
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
      if (message.request_id !== requestId) return
      const relayError = describeRelayEnvelopeError(message)
      if (relayError) {
        cleanup()
        reject(new Error(relayError))
        return
      }
      if (
        message.channel !== 'runtime' ||
        message.from !== desktopId ||
        message.to !== deviceId ||
        message.type !== `${type}_result`
      ) {
        return
      }
      cleanup()
      resolve(message.payload)
    }
    const onError = (error) => {
      cleanup()
      reject(error instanceof Error ? error : new Error('Mobile relay socket failed'))
    }
    const onClose = (code, reason) => {
      cleanup()
      reject(
        new Error(
          `Mobile relay socket closed while waiting for ${type}: ${code}${
            reason.length ? ` ${reason.toString()}` : ''
          }`
        )
      )
    }
    socket.on('message', onMessage)
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.send(
      JSON.stringify({
        channel: 'runtime',
        from: deviceId,
        payload,
        request_id: requestId,
        to: desktopId,
        type,
      })
    )
  })

const verifyTerminalInput = async ({
  desktopId,
  deviceId,
  expectOutput,
  input,
  pairingToken,
  serverUrl,
  terminalRun,
  timeoutMs,
}) => {
  if (!terminalRun.workspaceId) {
    throw new Error('--terminal-input requires --workspace-id when --run-id is provided')
  }
  const actionId = `smoke-terminal-input-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const socket = new WebSocket(
    toWebSocketUrl(serverUrl, '/ws/mobile', {
      desktop_id: desktopId,
      device_id: deviceId,
      pairing_token: pairingToken,
    })
  )
  try {
    await waitForOpen(socket, timeoutMs, 'Mobile relay action socket')
    const result = await requestRelayRuntime({
      desktopId,
      deviceId,
      payload: {
        action_id: actionId,
        kind: 'terminal_input',
        payload: { input },
        target: { run_id: terminalRun.runId },
        workspace_id: terminalRun.workspaceId,
      },
      socket,
      timeoutMs,
      type: 'mobile_action',
    })
    if (!result || typeof result !== 'object' || result.ok !== true) {
      throw new Error('Relay terminal input action did not return ok=true')
    }
    let transcript = await requestRelayRuntime({
      desktopId,
      deviceId,
      payload: {
        run_id: terminalRun.runId,
        workspace_id: terminalRun.workspaceId,
      },
      socket,
      timeoutMs,
      type: 'get_mobile_transcript',
    })
    const events = Array.isArray(transcript?.events) ? transcript.events : []
    const hasActionEcho = events.some(
      (event) =>
        event &&
        typeof event === 'object' &&
        event.type === 'mobile_action_echo' &&
        event.id === `action:${actionId}`
    )
    if (!hasActionEcho) {
      throw new Error('Relay terminal input action was not visible in mobile transcript')
    }
    if (expectOutput) {
      transcript = await waitForTranscriptOutput({
        desktopId,
        deviceId,
        expectOutput,
        runId: terminalRun.runId,
        socket,
        timeoutMs,
        workspaceId: terminalRun.workspaceId,
      })
    }
    return { action: result, transcript }
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) socket.close()
  }
}

export const transcriptContainsOutput = (transcript, expectOutput) => {
  const events = Array.isArray(transcript?.events) ? transcript.events : []
  return events.some(
    (event) =>
      event &&
      typeof event === 'object' &&
      event.type === 'terminal_output' &&
      typeof event.text === 'string' &&
      event.text.includes(expectOutput)
  )
}

const waitForTranscriptOutput = async ({
  desktopId,
  deviceId,
  expectOutput,
  runId,
  socket,
  timeoutMs,
  workspaceId,
}) => {
  const deadline = Date.now() + timeoutMs
  let lastTranscript = null
  while (Date.now() < deadline) {
    lastTranscript = await requestRelayRuntime({
      desktopId,
      deviceId,
      payload: {
        run_id: runId,
        workspace_id: workspaceId,
      },
      socket,
      timeoutMs: Math.max(1000, Math.min(5000, deadline - Date.now())),
      type: 'get_mobile_transcript',
    })
    if (transcriptContainsOutput(lastTranscript, expectOutput)) return lastTranscript
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Expected terminal output was not visible in mobile transcript: ${expectOutput}`)
}

export const normalizeTerminalInputForSmoke = (input, { appendEnter }) =>
  appendEnter && !input.endsWith('\r') && !input.endsWith('\n') ? `${input}\r` : input

const checkDesktopReady = async (serverUrl, adminToken, desktopId) => {
  const devices = await requestJson(new URL('/devices', serverUrl), {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  const desktops = Array.isArray(devices?.desktops) ? devices.desktops : []
  const desktop = desktops.find((entry) => entry?.device_id === desktopId)
  if (!desktop) {
    throw new Error(
      `Desktop '${desktopId}' is not connected to Relay. Start yive connect on the local computer before running this smoke test.`
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

const resolveTerminalRun = async ({
  desktopId,
  deviceId,
  pairingToken,
  serverUrl,
  timeoutMs,
  workspaceId,
}) => {
  const socket = new WebSocket(
    toWebSocketUrl(serverUrl, '/ws/mobile', {
      desktop_id: desktopId,
      device_id: deviceId,
      pairing_token: pairingToken,
    })
  )
  try {
    await waitForOpen(socket, timeoutMs, 'Mobile relay socket')
    const workspacePayload = await requestRelayRuntime({
      desktopId,
      deviceId,
      socket,
      timeoutMs,
      type: 'list_workspaces',
    })
    const workspaces = Array.isArray(workspacePayload?.workspaces)
      ? workspacePayload.workspaces
      : []
    const workspace =
      (workspaceId
        ? workspaces.find((entry) => entry?.id === workspaceId)
        : (workspaces.find((entry) => entry?.is_active === true) ?? workspaces[0])) ?? null
    if (!workspace?.id) {
      throw new Error(
        workspaceId
          ? `Workspace '${workspaceId}' was not found through Relay.`
          : 'No workspace was available through Relay.'
      )
    }

    const runsPayload = await requestRelayRuntime({
      desktopId,
      deviceId,
      payload: { workspace_id: workspace.id },
      socket,
      timeoutMs,
      type: 'list_agents_and_runs',
    })
    const runs = Array.isArray(runsPayload?.runs) ? runsPayload.runs : []
    const run =
      runs.find((entry) => entry?.status === 'running' && typeof entry?.run_id === 'string') ??
      runs.find((entry) => typeof entry?.run_id === 'string')
    if (!run?.run_id) {
      throw new Error(
        `Workspace '${workspace.id}' has no terminal run to verify. Start an Agent first or pass --run-id.`
      )
    }
    return {
      agentName: typeof run.agent_name === 'string' ? run.agent_name : undefined,
      runId: run.run_id,
      workspaceId: workspace.id,
      workspaceName: typeof workspace.name === 'string' ? workspace.name : undefined,
    }
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) socket.close()
  }
}

const main = async () => {
  const argv = process.argv.slice(2)
  const serverUrl = normalizeServerUrl(readFlag(argv, '--server'))
  const adminToken = readFlag(argv, '--token') ?? process.env.YIVE_RELAY_ADMIN_TOKEN
  const desktopId = readFlag(argv, '--desktop-id')
  const explicitRunId = readFlag(argv, '--run-id')
  const workspaceId = readFlag(argv, '--workspace-id')
  const deviceId = readFlag(argv, '--device-id') ?? `smoke-terminal-${Date.now()}`
  const openOnly = argv.includes('--open-only')
  const stream = readFlag(argv, '--stream') ?? (openOnly ? 'io' : 'control')
  const takeoverCols = Number.parseInt(readFlag(argv, '--takeover-cols') ?? '48', 10)
  const takeoverRows = Number.parseInt(readFlag(argv, '--takeover-rows') ?? '16', 10)
  const verifyTerminalOutput = argv.includes('--verify-terminal-output')
  const terminalInput =
    readFlag(argv, '--terminal-input') ??
    (verifyTerminalOutput ? TERMINAL_OUTPUT_SMOKE_COMMAND : undefined)
  const expectOutput =
    readFlag(argv, '--expect-output') ??
    (verifyTerminalOutput ? TERMINAL_OUTPUT_SMOKE_SENTINEL : undefined)
  const appendTerminalEnter = !argv.includes('--no-terminal-enter')
  const timeoutMs = Number.parseInt(readFlag(argv, '--timeout-ms') ?? '15000', 10)
  const settleMs = Number.parseInt(readFlag(argv, '--settle-ms') ?? '1000', 10)

  if (
    !adminToken ||
    adminToken.startsWith('--') ||
    !desktopId ||
    desktopId.startsWith('--') ||
    explicitRunId?.startsWith('--') ||
    workspaceId?.startsWith('--') ||
    terminalInput?.startsWith('--') ||
    expectOutput?.startsWith('--')
  ) {
    throw new Error(usage)
  }
  if (expectOutput && terminalInput === undefined) {
    throw new Error('--expect-output requires --terminal-input')
  }
  if (stream !== 'io' && stream !== 'control') throw new Error('--stream must be io or control')
  if (!openOnly && stream !== 'control') {
    throw new Error('--stream io can only be used with --open-only')
  }
  if (!Number.isInteger(takeoverCols) || takeoverCols <= 0) {
    throw new Error('--takeover-cols must be a positive integer')
  }
  if (!Number.isInteger(takeoverRows) || takeoverRows <= 0) {
    throw new Error('--takeover-rows must be a positive integer')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer')
  }
  if (!Number.isInteger(settleMs) || settleMs <= 0) {
    throw new Error('--settle-ms must be a positive integer')
  }

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
    const terminalRun = explicitRunId
      ? { runId: explicitRunId, ...(workspaceId ? { workspaceId } : {}) }
      : await resolveTerminalRun({
          desktopId,
          deviceId,
          pairingToken: claimed.token,
          serverUrl,
          timeoutMs,
          workspaceId,
        })

    socket = new WebSocket(
      toWebSocketUrl(serverUrl, `/ws/terminal/${encodeURIComponent(terminalRun.runId)}/${stream}`, {
        clientId: `smoke-${deviceId}`,
        desktop_id: desktopId,
        device_id: deviceId,
        mode: 'takeover',
        pairing_token: claimed.token,
      })
    )
    await waitForOpen(socket, timeoutMs, 'Terminal relay socket')
    let takeoverGranted = null
    let terminalInputResult = null
    if (openOnly) {
      await assertSocketStaysOpen(socket, settleMs, 'Terminal relay socket')
    } else {
      takeoverGranted = await verifyTakeover({
        cols: takeoverCols,
        rows: takeoverRows,
        heartbeatSettleMs: Math.min(settleMs, 1000),
        socket,
        timeoutMs,
      })
    }
    if (terminalInput !== undefined) {
      const forwardedTerminalInput = normalizeTerminalInputForSmoke(terminalInput, {
        appendEnter: appendTerminalEnter,
      })
      terminalInputResult = await verifyTerminalInput({
        desktopId,
        deviceId,
        expectOutput,
        input: forwardedTerminalInput,
        pairingToken: claimed.token,
        serverUrl,
        terminalRun,
        timeoutMs,
      })
    }

    console.log(`Yive terminal relay smoke test passed for ${serverUrl}`)
    console.log(`- desktop: ${desktopId}`)
    console.log(`- desktop runtime: ${desktop.runtime_status ?? 'unknown'}`)
    if (terminalRun.workspaceId) {
      console.log(
        `- workspace: ${terminalRun.workspaceName ?? terminalRun.workspaceId} (${terminalRun.workspaceId})`
      )
    }
    if (terminalRun.agentName) console.log(`- agent: ${terminalRun.agentName}`)
    console.log(`- run: ${terminalRun.runId}`)
    console.log(`- stream: ${stream}`)
    console.log(`- verification: ${openOnly ? 'open-only' : 'takeover'}`)
    if (takeoverGranted) {
      console.log(`- takeover size: ${takeoverGranted.cols}x${takeoverGranted.rows}`)
      console.log('- takeover heartbeat: accepted')
      if (takeoverGranted.previousSize) {
        console.log(
          `- restored previous size: ${takeoverGranted.previousSize.cols}x${takeoverGranted.previousSize.rows}`
        )
      }
    }
    if (terminalInputResult) {
      const actionResult = terminalInputResult.action
      const bytes =
        typeof actionResult.result?.bytes === 'number'
          ? actionResult.result.bytes
          : normalizeTerminalInputForSmoke(terminalInput, {
              appendEnter: appendTerminalEnter,
            }).length
      console.log(
        `- terminal input: forwarded (${bytes} bytes${appendTerminalEnter ? ', Enter appended' : ''})`
      )
      console.log('- terminal input transcript: action echo visible')
      if (expectOutput) {
        console.log(`- terminal output transcript: matched ${JSON.stringify(expectOutput)}`)
      }
    }
    console.log(`- mobile test device: ${deviceId}`)
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close()
    if (adminToken && deviceId) {
      await fetch(new URL(`/pairings/devices/${encodeURIComponent(deviceId)}`, serverUrl), {
        headers: { authorization: `Bearer ${adminToken}` },
        method: 'DELETE',
      }).catch(() => undefined)
    }
  }
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (isCliEntry) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
