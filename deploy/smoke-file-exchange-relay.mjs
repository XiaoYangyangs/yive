#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const MOBILE_ARTIFACT_CONTRACT_VERSION = 2

const usage = `Usage: node deploy/smoke-file-exchange-relay.mjs --server <url> --token <admin-token> --desktop-id <id> [--device-id <id>] [--workspace-id <id> --workspace-file <relative-path>] [--workspace-id <id> --run-id <run-id> --verify-image-paste] [--timeout-ms <ms>]

Examples:
  node deploy/smoke-file-exchange-relay.mjs --server http://203.0.113.10 --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows
  node deploy/smoke-file-exchange-relay.mjs --server https://relay.example.com --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows --workspace-id workspace-1 --workspace-file README.md
  node deploy/smoke-file-exchange-relay.mjs --server https://relay.example.com --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows --workspace-id workspace-1 --run-id run-1 --verify-image-paste
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

const waitForEnvelope = (socket, requestId, expectedType, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${expectedType}`))
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
      cleanup()
      if (message.type === 'relay_error') {
        const code = message.payload?.code ?? 'relay_error'
        const detail = message.payload?.message ?? 'Relay returned an error'
        reject(new Error(`${code}: ${detail}`))
        return
      }
      if (message.type !== expectedType) {
        reject(new Error(`Unexpected response ${message.type}; expected ${expectedType}`))
        return
      }
      resolve(message.payload)
    }
    const onError = (error) => {
      cleanup()
      reject(error instanceof Error ? error : new Error(`${expectedType} failed`))
    }
    const onClose = (code, reason) => {
      cleanup()
      reject(
        new Error(
          `Relay socket closed before ${expectedType}: ${code}${
            reason.length ? ` ${reason.toString()}` : ''
          }`
        )
      )
    }
    socket.on('message', onMessage)
    socket.once('error', onError)
    socket.once('close', onClose)
  })

const sendRelayRequest = async ({ desktopId, deviceId, payload, socket, timeoutMs, type }) => {
  const requestId = `smoke-file-${Date.now()}-${Math.random().toString(16).slice(2)}`
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
  return waitForEnvelope(socket, requestId, `${type}_result`, timeoutMs)
}

const requireString = (value, field) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} missing from Relay response`)
  }
  return value
}

const assertSafeFileName = (name, label) => {
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`${label}.name must be a file name, not a path`)
  }
  for (const char of name) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f || '"<>:|?*'.includes(char)) {
      throw new Error(`${label}.name contains unsafe characters`)
    }
  }
}

const requireFileItem = (payload, label) => {
  if (!payload || typeof payload !== 'object') throw new Error(`${label} returned invalid payload`)
  assertNoSensitiveRelayPayload(payload, label)
  const item = {
    id: requireString(payload.id, `${label}.id`),
    mimeType: requireString(payload.mime_type, `${label}.mime_type`),
    name: requireString(payload.name, `${label}.name`),
    size: Number(payload.size),
  }
  assertSafeFileName(item.name, label)
  return item
}

const decodeBase64 = (value) => Buffer.from(requireString(value, 'content_base64'), 'base64')

const pngFixture = () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('png')])

const assertNoSensitiveRelayPayload = (value, label) => {
  const text = JSON.stringify(value)
  for (const secret of [
    'content_base64',
    'local_path',
    'registry_path',
    'hive-mobile-files',
    'HIVE_AGENT_TOKEN',
    'x-hive-agent-token',
    'agent_token',
  ]) {
    if (text.includes(secret)) throw new Error(`${label} leaked ${secret}`)
  }
}

const requireImageActionResult = (payload, uploadedFileId) => {
  if (!payload || typeof payload !== 'object') {
    throw new Error('mobile_action native_image_paste returned invalid payload')
  }
  if (payload.ok !== true)
    throw new Error('mobile_action native_image_paste did not return ok=true')
  const result = payload.result
  if (!result || typeof result !== 'object') {
    throw new Error('mobile_action native_image_paste returned no result')
  }
  const input = result.input
  if (input !== 'ctrl_v' && input !== 'server_attachment_prompt') {
    throw new Error(`Unexpected native image paste result input: ${String(input)}`)
  }
  const attachment = result.attachment
  if (!attachment || typeof attachment !== 'object') {
    throw new Error('native image paste result did not include attachment metadata')
  }
  if (attachment.file_id !== uploadedFileId) {
    throw new Error('native image paste attachment file_id mismatch')
  }
  if (attachment.placeholder !== '[Image #1]') {
    throw new Error('native image paste attachment placeholder mismatch')
  }
  if (typeof payload.action_id !== 'string' || payload.action_id.length === 0) {
    throw new Error('native image paste action_id is missing')
  }
  const expectedArtifact = `.hive/chat-attachments/${payload.action_id}/${uploadedFileId}.png`
  if (attachment.artifact !== expectedArtifact) {
    throw new Error('native image paste attachment Artifact mismatch')
  }
  return { input }
}

export const runRelayFileExchangeSmoke = async (
  argv = process.argv.slice(2),
  {
    now = () => new Date(),
    request = sendRelayRequest,
    socketFactory = (url) => new WebSocket(url),
  } = {}
) => {
  const serverUrl = normalizeServerUrl(readFlag(argv, '--server'))
  const token = readFlag(argv, '--token') ?? process.env.YIVE_RELAY_ADMIN_TOKEN
  const desktopId = readFlag(argv, '--desktop-id')
  const deviceId = readFlag(argv, '--device-id') ?? `smoke-file-${process.pid}`
  const workspaceId = readFlag(argv, '--workspace-id')
  const workspaceFile = readFlag(argv, '--workspace-file')
  const runId = readFlag(argv, '--run-id')
  const verifyImagePaste = argv.includes('--verify-image-paste')
  const timeoutMs = Number.parseInt(readFlag(argv, '--timeout-ms') ?? '15000', 10)

  if (!token || token.startsWith('--') || !desktopId || desktopId.startsWith('--')) {
    throw new Error(usage)
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be > 0')
  if (Boolean(workspaceId) !== Boolean(workspaceFile)) {
    if (!verifyImagePaste || !workspaceId || workspaceFile) {
      throw new Error('--workspace-id and --workspace-file must be provided together')
    }
  }
  if (verifyImagePaste && (!workspaceId || !runId || runId.startsWith('--'))) {
    throw new Error('--verify-image-paste requires --workspace-id and --run-id')
  }

  const socket = socketFactory(
    toWebSocketUrl(serverUrl, '/ws/mobile', {
      desktop_id: desktopId,
      device_id: deviceId,
      pairing_token: token,
    })
  )

  await waitForOpen(socket, timeoutMs, 'Relay mobile file exchange socket')

  const createdFileIds = []
  try {
    const text = `Yive relay file exchange smoke ${now().toISOString()}\n`
    const uploaded = requireFileItem(
      await request({
        desktopId,
        deviceId,
        payload: {
          content_base64: Buffer.from(text, 'utf8').toString('base64'),
          name: 'relay-smoke.md',
        },
        socket,
        timeoutMs,
        type: 'upload_mobile_file',
      }),
      'upload_mobile_file'
    )
    createdFileIds.push(uploaded.id)

    const listed = await request({
      desktopId,
      deviceId,
      payload: {},
      socket,
      timeoutMs,
      type: 'list_mobile_files',
    })
    if (!Array.isArray(listed) || !listed.some((item) => item?.id === uploaded.id)) {
      throw new Error('Uploaded file was not visible in list_mobile_files')
    }

    const downloaded = await request({
      desktopId,
      deviceId,
      payload: { file_id: uploaded.id },
      socket,
      timeoutMs,
      type: 'download_mobile_file',
    })
    for (const secret of ['local_path', 'hive-mobile-files', 'HIVE_AGENT_TOKEN', 'agent_token']) {
      if (JSON.stringify(downloaded).includes(secret)) {
        throw new Error(`download_mobile_file leaked ${secret}`)
      }
    }
    assertSafeFileName(
      requireString(downloaded.name, 'download_mobile_file.name'),
      'download_mobile_file'
    )
    const downloadedContent = decodeBase64(downloaded.content_base64).toString('utf8')
    if (downloadedContent !== text) throw new Error('Downloaded relay smoke file content mismatch')

    let workspaceItem = null
    if (workspaceId && workspaceFile) {
      workspaceItem = requireFileItem(
        await request({
          desktopId,
          deviceId,
          payload: { path: workspaceFile, workspace_id: workspaceId },
          socket,
          timeoutMs,
          type: 'send_workspace_file_to_mobile',
        }),
        'send_workspace_file_to_mobile'
      )
      createdFileIds.push(workspaceItem.id)
    }

    let imagePaste = null
    if (verifyImagePaste) {
      const image = requireFileItem(
        await request({
          desktopId,
          deviceId,
          payload: {
            content_base64: pngFixture().toString('base64'),
            name: 'relay-smoke-image.png',
          },
          socket,
          timeoutMs,
          type: 'upload_mobile_file',
        }),
        'upload_mobile_file(image)'
      )
      createdFileIds.push(image.id)

      const imageAction = await request({
        desktopId,
        deviceId,
        payload: {
          action_id: `smoke-image-paste-${Date.now()}`,
          artifact_contract_version: MOBILE_ARTIFACT_CONTRACT_VERSION,
          kind: 'native_image_paste',
          payload: { file_id: image.id, placeholder: '[Image #1]' },
          target: { run_id: runId },
          workspace_id: workspaceId,
        },
        socket,
        timeoutMs,
        type: 'mobile_action',
      })
      assertNoSensitiveRelayPayload(imageAction, 'native image paste Relay response')
      imagePaste = {
        file: image,
        ...requireImageActionResult(imageAction, image.id),
      }
    }

    return { downloaded: downloadedContent.length, imagePaste, uploaded, workspaceItem }
  } finally {
    for (const fileId of createdFileIds) {
      await request({
        desktopId,
        deviceId,
        payload: { file_id: fileId },
        socket,
        timeoutMs,
        type: 'delete_mobile_file',
      }).catch(() => {})
    }
    socket.close(1000, 'file exchange smoke complete')
  }
}

const main = async () => {
  const result = await runRelayFileExchangeSmoke()
  console.log('Yive relay file exchange smoke passed.')
  console.log(`- uploaded: ${result.uploaded.name} (${result.uploaded.size} bytes)`)
  console.log(`- downloaded bytes: ${result.downloaded}`)
  if (result.workspaceItem) {
    console.log(
      `- workspace file: ${result.workspaceItem.name} (${result.workspaceItem.size} bytes)`
    )
  }
  if (result.imagePaste) {
    console.log(
      `- image paste: ${result.imagePaste.file.name} (${result.imagePaste.file.size} bytes, ${result.imagePaste.input})`
    )
  }
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (isCliEntry) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
