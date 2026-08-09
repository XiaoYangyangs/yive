import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { createTerminalOutputFlow, FLOW_CONTROL } from '../../src/server/terminal-flow-control.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const defaultFlowControl = { ...FLOW_CONTROL }

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 5000,
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

const toWsUrl = (baseUrl: string, suffix: string, clientId: string) => {
  return `${baseUrl.replace('http://', 'ws://')}${suffix}?clientId=${clientId}`
}

const startSpyServer = async () => {
  const agentManager = createAgentManager()
  const pauseSpy = vi.spyOn(agentManager, 'pauseRun')
  const resumeSpy = vi.spyOn(agentManager, 'resumeRun')
  const store = createRuntimeStore({ agentManager })
  const app = createApp({ store })
  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }
  return {
    agentManager,
    baseUrl: `http://127.0.0.1:${address.port}`,
    pauseSpy,
    resumeSpy,
    store,
    close: async () => {
      app.close()
      await store.close()
      app.server.closeIdleConnections?.()
      app.server.closeAllConnections?.()
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
    },
  }
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
  store: ReturnType<typeof createRuntimeStore>,
  workspaceId: string,
  agentId: string,
  command: string,
  args: string[]
) => {
  store.configureAgentLaunch(workspaceId, agentId, { args, command, provider: 'codex' })
}

const startAgent = async (
  store: ReturnType<typeof createRuntimeStore>,
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
  expected: string
) => {
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/runtime/runs/${runId}`, {
      headers: { cookie },
    })
    const body = (await response.json()) as { output: string }
    expect(body.output).toContain(expected)
  })
}

const getRunOutput = async (baseUrl: string, cookie: string, runId: string) => {
  const response = await fetch(`${baseUrl}/api/runtime/runs/${runId}`, {
    headers: { cookie },
  })
  const body = (await response.json()) as { output: string }
  return body.output
}

const openViewer = async (
  baseUrl: string,
  cookie: string,
  runId: string,
  clientId: string,
  { acknowledgeOutput = false }: { acknowledgeOutput?: boolean } = {}
) => {
  const controlEvents: Array<Record<string, unknown>> = []
  const outputs: string[] = []
  const messageEvents: string[] = []
  const io = new WebSocket(toWsUrl(baseUrl, `/ws/terminal/${runId}/io`, clientId), {
    headers: { cookie },
  })
  const control = new WebSocket(toWsUrl(baseUrl, `/ws/terminal/${runId}/control`, clientId), {
    headers: { cookie },
  })

  control.on('message', (chunk) => {
    const message = JSON.parse(chunk.toString()) as Record<string, unknown>
    controlEvents.push(message)
    if (message.type === 'restore') {
      control.send(JSON.stringify({ type: 'restore_complete' }))
    }
  })

  io.on('message', (chunk) => {
    const text = chunk.toString()
    outputs.push(text)
    messageEvents.push(text)
    if (acknowledgeOutput && control.readyState === control.OPEN) {
      control.send(JSON.stringify({ type: 'output_ack', bytes: Buffer.byteLength(text) }))
    }
  })

  await Promise.all([
    new Promise<void>((resolve, reject) => {
      io.once('open', () => resolve())
      io.once('error', reject)
    }),
    new Promise<void>((resolve, reject) => {
      control.once('open', () => resolve())
      control.once('error', reject)
    }),
  ])

  await waitFor(() => {
    expect(controlEvents).toContainEqual(expect.objectContaining({ type: 'restore' }))
  })

  return { control, controlEvents, io, messageEvents, outputs }
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

afterEach(async () => {
  Object.assign(FLOW_CONTROL, defaultFlowControl)
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) await removeTempDir(dir)
})

describe('terminal flow control', () => {
  test('T1 low-latency small chunk is sent without waiting for batch timer', async () => {
    Object.assign(FLOW_CONTROL, { BATCH_INTERVAL_MS: 800 })
    const received: string[] = []
    const wss = new WebSocketServer({ port: 0 })
    let flow: ReturnType<typeof createTerminalOutputFlow> | undefined
    const socketReady = new Promise<void>((resolve) => {
      wss.once('connection', (socket) => {
        flow = createTerminalOutputFlow(socket, { onBackpressureChange() {} })
        resolve()
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    client.on('message', (chunk) => received.push(chunk.toString()))
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve())
        client.once('error', reject)
      })
      await socketReady
      await new Promise((resolve) => setTimeout(resolve, 20))
      const startAt = Date.now()
      flow?.enqueue('tiny')

      await waitFor(
        () => {
          expect(received.join('')).toContain('tiny')
        },
        300,
        10
      )
      expect(Date.now() - startAt).toBeLessThan(300)
    } finally {
      flow?.close()
      client.close()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  }, 15000)

  test('T2 multiple >256B chunks batch into one websocket send', async () => {
    Object.assign(FLOW_CONTROL, { BATCH_INTERVAL_MS: 50 })
    const workspacePath = join(tmpdir(), `hive-terminal-flow-batch-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'batch.js')
    const chunkA = `A:${'x'.repeat(300)}`
    const chunkB = `B:${'y'.repeat(300)}`
    const chunkC = `C:${'z'.repeat(300)}`
    writeFileSync(
      script,
      [
        `const chunks = ${JSON.stringify([chunkA, chunkB, chunkC])};`,
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', () => { for (const chunk of chunks) process.stdout.write(chunk) })",
        'process.stdin.resume()',
        "console.log('ready')",
        'setInterval(() => {}, 1000)',
      ].join('\n')
    )

    const server = await startSpyServer()
    let viewer: Awaited<ReturnType<typeof openViewer>> | undefined
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.store, workspace.id, worker.id, process.execPath, [script])
      const run = await startAgent(server.store, server.baseUrl, workspace.id, worker.id)
      await waitForRunOutput(server.baseUrl, cookie, run.runId, 'ready')
      viewer = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-a')
      viewer.io.send('go\r')

      await waitFor(
        () => {
          const dataEvents = viewer?.messageEvents.filter((event) => event.includes(chunkA)) ?? []
          expect(dataEvents).toHaveLength(1)
          expect(viewer?.outputs.join('')).toContain(chunkA)
          expect(viewer?.outputs.join('')).toContain(chunkB)
          expect(viewer?.outputs.join('')).toContain(chunkC)
        },
        10_000,
        20
      )
    } finally {
      if (viewer) await closeViewer(viewer)
      await server.close()
    }
  }, 60000)

  test('T3 unacked bytes above 100KB disconnect only the stalled viewer', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-flow-unacked-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'burst.js')
    writeFileSync(
      script,
      [
        "console.log('ready')",
        "process.stdin.once('data', () => {",
        "  const chunk = 'u'.repeat(4096)",
        '  let count = 0',
        '  const interval = setInterval(() => {',
        '    process.stdout.write(chunk)',
        '    count += 1',
        '    if (count < 40) return',
        '    clearInterval(interval)',
        "    process.stdout.write('\\nCOMPLETED\\n', () => process.exit(0))",
        '  }, 1)',
        '})',
        'process.stdin.resume()',
      ].join('\n')
    )

    const server = await startSpyServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.store, workspace.id, worker.id, process.execPath, [script])
      const run = await startAgent(server.store, server.baseUrl, workspace.id, worker.id)
      await waitForRunOutput(server.baseUrl, cookie, run.runId, 'ready')
      const viewer = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-a')
      viewer.io.send('go\r')

      await waitFor(
        () => {
          expect(viewer.io.readyState).toBe(WebSocket.CLOSED)
          expect(viewer.control.readyState).toBe(WebSocket.CLOSED)
        },
        8000,
        20
      )
      await waitForRunOutput(server.baseUrl, cookie, run.runId, 'COMPLETED')
      expect(server.pauseSpy).not.toHaveBeenCalled()
      expect(server.resumeSpy).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  }, 45000)

  test('T4 a stalled viewer cannot delay a healthy viewer on the same terminal run', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-flow-multi-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'multi.js')
    writeFileSync(
      script,
      [
        "console.log('ready')",
        "process.stdin.once('data', () => {",
        "  const chunk = 'm'.repeat(8192)",
        '  let count = 0',
        '  const interval = setInterval(() => {',
        '    process.stdout.write(chunk)',
        '    count += 1',
        '    if (count < 40) return',
        '    clearInterval(interval)',
        "    process.stdout.write('\\nHEALTHY_COMPLETED\\n', () => process.exit(0))",
        '  }, 100)',
        '})',
        'process.stdin.resume()',
      ].join('\n')
    )

    const server = await startSpyServer()
    let fastViewer: Awaited<ReturnType<typeof openViewer>> | undefined
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.store, workspace.id, worker.id, process.execPath, [script])
      const run = await startAgent(server.store, server.baseUrl, workspace.id, worker.id)
      await waitForRunOutput(server.baseUrl, cookie, run.runId, 'ready')
      const slowViewer = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-slow')
      fastViewer = await openViewer(server.baseUrl, cookie, run.runId, 'viewer-fast', {
        acknowledgeOutput: true,
      })
      slowViewer.io.send('go\r')

      await waitFor(
        () => {
          expect(slowViewer.io.readyState).toBe(WebSocket.CLOSED)
          expect(slowViewer.control.readyState).toBe(WebSocket.CLOSED)
        },
        8000,
        20
      )
      await waitForRunOutput(server.baseUrl, cookie, run.runId, 'HEALTHY_COMPLETED')
      await waitFor(
        () => {
          expect(fastViewer.outputs.join('')).toContain('HEALTHY_COMPLETED')
        },
        8000,
        20
      )
      await waitFor(() => {
        expect(fastViewer.controlEvents).toContainEqual(
          expect.objectContaining({
            type: 'size_owner_changed',
            mode: 'active',
            ownerClientId: 'viewer-fast',
          })
        )
      })
      expect(fastViewer.io.readyState).toBe(WebSocket.OPEN)
      expect(fastViewer.control.readyState).toBe(WebSocket.OPEN)
      expect(server.pauseSpy).not.toHaveBeenCalled()
      expect(server.resumeSpy).not.toHaveBeenCalled()
    } finally {
      if (fastViewer) await closeViewer(fastViewer)
      await server.close()
    }
  }, 45000)

  test('T5 bufferedAmount high water reports pressure only for its output flow', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-flow-buffered-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'buffered.js')
    writeFileSync(
      script,
      [
        "setTimeout(() => process.stdout.write('b'.repeat(20 * 1024)), 20)",
        'setInterval(() => {}, 1000)',
      ].join('\n')
    )

    const manager = createAgentManager()
    const wss = new WebSocketServer({ port: 0 })
    let flow: ReturnType<typeof createTerminalOutputFlow> | undefined
    let bufferedAmount = FLOW_CONTROL.WS_BUFFERED_HIGH_WATER
    const socketReady = new Promise<void>((resolve) => {
      wss.once('connection', (socket) => {
        Object.defineProperty(socket, 'bufferedAmount', {
          configurable: true,
          get: () => bufferedAmount,
        })
        flow = createTerminalOutputFlow(socket, {
          onBackpressureChange(backpressured) {
            pressureSpy(backpressured)
          },
        })
        resolve()
      })
    })

    const port = (wss.address() as { port: number }).port
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve())
      client.once('error', reject)
    })
    await socketReady

    const run = await manager.startAgent({
      agentId: 'worker-buffered',
      command: process.execPath,
      args: [script],
      cwd: workspacePath,
      env: {},
    })
    const pressureSpy = vi.fn()
    const unsubscribe = manager.getOutputBus().subscribe(run.runId, (chunk) => flow?.enqueue(chunk))

    try {
      await waitFor(
        () => {
          expect(pressureSpy).toHaveBeenCalledWith(true)
        },
        8000,
        20
      )

      bufferedAmount = 0

      await waitFor(
        () => {
          expect(pressureSpy).toHaveBeenCalledWith(false)
        },
        8000,
        20
      )
    } finally {
      unsubscribe()
      flow?.close()
      client.close()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      manager.stopRun(run.runId)
    }
  }, 15000)

  test('T6 explicit Runtime pause and resume still control the terminal run', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-flow-explicit-pause-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'explicit-pause.js')
    writeFileSync(
      script,
      [
        'let count = 0',
        'setInterval(() => {',
        '  count += 1',
        "  process.stdout.write('tick-' + count + '\\n')",
        '}, 20)',
      ].join('\n')
    )

    const server = await startSpyServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.store, workspace.id, worker.id, process.execPath, [script])
      const run = await startAgent(server.store, server.baseUrl, workspace.id, worker.id)
      await waitForRunOutput(server.baseUrl, cookie, run.runId, 'tick-3')

      server.store.pauseTerminalRun(run.runId)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const pausedOutput = await getRunOutput(server.baseUrl, cookie, run.runId)
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(await getRunOutput(server.baseUrl, cookie, run.runId)).toBe(pausedOutput)

      server.store.resumeTerminalRun(run.runId)
      await waitFor(async () => {
        expect((await getRunOutput(server.baseUrl, cookie, run.runId)).length).toBeGreaterThan(
          pausedOutput.length
        )
      })
    } finally {
      await server.close()
    }
  }, 30000)
})
