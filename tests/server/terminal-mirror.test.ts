import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import WebSocket from 'ws'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const passiveExitLine = 'setTimeout(() => process.exit(0), 120000)'
const echoAndExitScript = [
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', (chunk) => {",
  "  process.stdout.write('IN:' + chunk)",
  '  setTimeout(() => process.exit(0), 10)',
  '})',
  'process.stdin.resume()',
  "console.log('READY')",
  passiveExitLine,
].join('\n')

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 10_000,
  intervalMs = 20
) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  throw lastError
}

const toWsUrl = (baseUrl: string, suffix: string, clientId: string) => {
  return `${baseUrl.replace('http://', 'ws://')}${suffix}?clientId=${clientId}`
}

const createWorkspace = async (baseUrl: string, cookie: string, workspacePath: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
}

const createWorker = async (baseUrl: string, cookie: string, workspaceId: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alice' }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
}

const configureAgent = async (
  store: Awaited<ReturnType<typeof startTestServer>>['store'],
  workspaceId: string,
  agentId: string,
  command: string,
  args: string[]
) => {
  store.configureAgentLaunch(workspaceId, agentId, { args, command, provider: 'codex' })
}

const startAgent = async (
  store: Awaited<ReturnType<typeof startTestServer>>['store'],
  baseUrl: string,
  workspaceId: string,
  agentId: string
) => {
  const port = baseUrl.split(':').at(-1)
  const run = await store.startAgent(workspaceId, agentId, {
    hivePort: port ?? '',
    suppressStartupInstructions: true,
  })
  return { runId: run.runId }
}

const waitForRunOutput = async (
  baseUrl: string,
  cookie: string,
  runId: string,
  expected: string,
  timeoutMs = 30_000
) => {
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/runtime/runs/${runId}`, {
      headers: { cookie },
    })
    const body = (await response.json()) as { output: string }
    expect(body.output).toContain(expected)
  }, timeoutMs)
}

const openViewer = async (baseUrl: string, cookie: string, runId: string, clientId: string) => {
  const outputs: string[] = []
  const controlMessages: Array<{ [key: string]: unknown; type: string }> = []
  const io = new WebSocket(toWsUrl(baseUrl, `/ws/terminal/${runId}/io`, clientId), {
    headers: { cookie },
  })
  const control = new WebSocket(toWsUrl(baseUrl, `/ws/terminal/${runId}/control`, clientId), {
    headers: { cookie },
  })

  io.on('message', (chunk) => outputs.push(chunk.toString()))
  control.on('message', (chunk) => {
    const message = JSON.parse(chunk.toString()) as { [key: string]: unknown; type: string }
    controlMessages.push(message)
    if (message.type === 'restore') {
      control.send(JSON.stringify({ type: 'restore_complete' }))
    }
  })

  const waitForOpen = (socket: WebSocket, label: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} websocket did not open`)), 10_000)
      const cleanup = () => {
        clearTimeout(timer)
        socket.off('close', handleClose)
        socket.off('error', handleError)
        socket.off('open', handleOpen)
      }
      const handleClose = () => {
        cleanup()
        reject(new Error(`${label} websocket closed before open`))
      }
      const handleError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const handleOpen = () => {
        cleanup()
        resolve()
      }
      socket.once('close', handleClose)
      socket.once('error', handleError)
      socket.once('open', handleOpen)
    })

  await Promise.all([waitForOpen(io, 'io'), waitForOpen(control, 'control')])

  await waitFor(() => {
    expect(controlMessages).toContainEqual(expect.objectContaining({ type: 'restore' }))
  })

  return { io, control, outputs, controlMessages }
}

const closeSocket = async (socket: WebSocket) => {
  if (socket.readyState === WebSocket.CLOSED) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 500)
    socket.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.close()
  })
}

const closeViewer = async (viewer: Awaited<ReturnType<typeof openViewer>>) => {
  await Promise.all([closeSocket(viewer.io), closeSocket(viewer.control)])
}

const removeTempDir = async (dir: string) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { force: true, recursive: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM' || attempt === 19) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await removeTempDir(dir)
})

describe('terminal mirror', () => {
  test('T1 late attach gets a restore snapshot with prior output', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-mirror-restore-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'hello.js')
    writeFileSync(script, `console.log('HELLO'); process.stdin.resume(); ${passiveExitLine}\n`)

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.store, workspace.id, worker.id, process.execPath, [script])
      const run = await startAgent(server.store, server.baseUrl, workspace.id, worker.id)
      await waitForRunOutput(server.baseUrl, cookie, run.runId, 'HELLO')

      const secondViewer = await openViewer(server.baseUrl, cookie, run.runId, 'late-viewer')
      await waitFor(() => {
        const restore = secondViewer.controlMessages.find((message) => message.type === 'restore')
        expect(String(restore?.snapshot ?? '')).toContain('HELLO')
      })

      await closeViewer(secondViewer)
    } finally {
      await server.close()
    }
  }, 60_000)

  test('T1b restore mirror uses initial control socket dimensions before replaying output', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-mirror-wide-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'wide.js')
    writeFileSync(
      script,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', () => {",
        "  process.stdout.write('LEFT\\x1b[100CRIGHT')",
        '})',
        'process.stdin.resume()',
        passiveExitLine,
      ].join('\n')
    )

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.store, workspace.id, worker.id, process.execPath, [script])
      const run = await startAgent(server.store, server.baseUrl, workspace.id, worker.id)

      const control = new WebSocket(
        `${server.baseUrl.replace('http://', 'ws://')}/ws/terminal/${run.runId}/control?clientId=wide-viewer&cols=120&rows=5`,
        { headers: { cookie } }
      )
      await new Promise<void>((resolve, reject) => {
        control.once('open', () => resolve())
        control.once('error', reject)
      })
      control.send(JSON.stringify({ type: 'resize', cols: 120, rows: 5 }))
      await new Promise((resolve) => setTimeout(resolve, 100))

      const io = new WebSocket(
        `${server.baseUrl.replace('http://', 'ws://')}/ws/terminal/${run.runId}/io?clientId=wide-viewer`,
        { headers: { cookie } }
      )
      await new Promise<void>((resolve, reject) => {
        io.once('open', () => resolve())
        io.once('error', reject)
      })
      io.send('go\r')
      await waitForRunOutput(server.baseUrl, cookie, run.runId, 'RIGHT')

      const restoreMessages: Array<{ [key: string]: unknown; type: string }> = []
      const restoreControl = new WebSocket(
        `${server.baseUrl.replace('http://', 'ws://')}/ws/terminal/${run.runId}/control?clientId=wide-restore&cols=120&rows=5`,
        { headers: { cookie } }
      )
      restoreControl.on('message', (chunk) => {
        restoreMessages.push(
          JSON.parse(chunk.toString()) as { [key: string]: unknown; type: string }
        )
      })
      await new Promise<void>((resolve, reject) => {
        restoreControl.once('open', () => resolve())
        restoreControl.once('error', reject)
      })

      await waitFor(() => {
        const restore = restoreMessages.find((message) => message.type === 'restore')
        const snapshot = String(restore?.snapshot ?? '')
        expect(snapshot).toContain('LEFT')
        expect(snapshot).toContain('\u001b[100CRIGHT')
        expect(snapshot).not.toContain('\u001b[75CRIGHT')
      })

      await closeSocket(restoreControl)
      await closeSocket(io)
      await closeSocket(control)
    } finally {
      await server.close()
    }
  }, 60000)

  test('T2 multiple viewers each receive one copy of future PTY output', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-mirror-fanout-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'echo.js')
    writeFileSync(script, echoAndExitScript)

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.store, workspace.id, worker.id, process.execPath, [script])
      const run = await startAgent(server.store, server.baseUrl, workspace.id, worker.id)
      await waitForRunOutput(server.baseUrl, cookie, run.runId, 'READY')

      const viewerA = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-a')
      const viewerB = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-b')

      viewerA.io.send('world\r')

      await waitFor(() => {
        expect(viewerA.outputs.join('')).toContain('IN:world')
        expect(viewerB.outputs.join('')).toContain('IN:world')
      })

      expect(viewerA.outputs.join('').match(/IN:world/g)).toHaveLength(1)
      expect(viewerB.outputs.join('').match(/IN:world/g)).toHaveLength(1)

      await Promise.all([closeViewer(viewerA), closeViewer(viewerB)])
    } finally {
      await server.close()
    }
  }, 60000)

  test('T3 closing one viewer does not stop output for remaining viewers', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-mirror-detach-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'echo.js')
    writeFileSync(script, echoAndExitScript)

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.store, workspace.id, worker.id, process.execPath, [script])
      const run = await startAgent(server.store, server.baseUrl, workspace.id, worker.id)
      await waitForRunOutput(server.baseUrl, cookie, run.runId, 'READY')

      const viewerA = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-a')
      const viewerB = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-b')
      const viewerC = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-c')

      await closeViewer(viewerB)

      viewerA.io.send('after close\r')

      await waitFor(() => {
        expect(viewerA.outputs.join('')).toContain('IN:after close')
        expect(viewerC.outputs.join('')).toContain('IN:after close')
      })

      await Promise.all([closeViewer(viewerA), closeViewer(viewerC)])
    } finally {
      await server.close()
    }
  }, 120_000)

  test('T4 PTY transcript is not persisted into sqlite messages', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-mirror-db-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'secret.js')
    writeFileSync(
      script,
      [
        "process.stdin.once('data', () => console.log('SECRET_TEXT'))",
        'process.stdin.resume()',
        "console.log('READY')",
        passiveExitLine,
      ].join('\n')
    )

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.store, workspace.id, worker.id, process.execPath, [script])
      const run = await startAgent(server.store, server.baseUrl, workspace.id, worker.id)
      await waitForRunOutput(server.baseUrl, cookie, run.runId, 'READY', 30_000)
      const viewer = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-a')
      viewer.io.send('emit\r')

      await waitFor(() => {
        expect(viewer.outputs.join('')).toContain('SECRET_TEXT')
      })

      const db = new Database(join(server.dataDir, 'runtime.sqlite'), { readonly: true })
      const row = db
        .prepare('SELECT COUNT(*) AS count FROM messages WHERE text LIKE ?')
        .get('%SECRET_TEXT%') as { count: number }
      db.close()

      expect(row.count).toBe(0)

      await closeViewer(viewer)
    } finally {
      await server.close()
    }
  }, 120_000)
})
