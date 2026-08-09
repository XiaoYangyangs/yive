import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'
import WebSocket from 'ws'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createPtyOutputBus } from '../../src/server/pty-output-bus.js'
import type { RuntimeStore } from '../../src/server/runtime-store.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { createTerminalWebSocketServer } from '../../src/server/terminal-ws-server.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const restoreEnv: Array<[string, string | undefined]> = []

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 3000,
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

const toWsUrl = (baseUrl: string, suffix: string) => baseUrl.replace('http://', 'ws://') + suffix

const openSocket = async (url: string, cookie: string) => {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie } })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

const openTerminalViewer = async (
  baseUrl: string,
  cookie: string,
  runId: string,
  clientId: string,
  mode: 'active' | 'passive' | 'takeover' = 'active'
) => {
  const control = new WebSocket(
    toWsUrl(
      baseUrl,
      `/ws/terminal/${runId}/control?clientId=${encodeURIComponent(clientId)}&mode=${mode}`
    ),
    { headers: { cookie } }
  )
  const restoreReceived = new Promise<string>((resolve) => {
    control.on('message', (chunk) => {
      const message = JSON.parse(chunk.toString()) as Record<string, unknown>
      if (message.type === 'restore') resolve(String(message.snapshot ?? ''))
    })
  })
  await new Promise<void>((resolve, reject) => {
    control.once('open', () => resolve())
    control.once('error', reject)
  })
  const io = await openSocket(
    toWsUrl(
      baseUrl,
      `/ws/terminal/${runId}/io?clientId=${encodeURIComponent(clientId)}&mode=${mode}`
    ),
    cookie
  )
  const restoreSnapshot = await restoreReceived
  control.send(JSON.stringify({ type: 'restore_complete' }))
  return { control, io, restoreSnapshot }
}

const expectUpgradeStatus = async (
  url: string,
  cookie: string,
  statusCode: number,
  headers: Record<string, string> = {}
) => {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie, ...headers } })
    socket.once('unexpected-response', (_request, response) => {
      try {
        expect(response.statusCode).toBe(statusCode)
        response.resume()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    socket.once('open', () => reject(new Error('Expected websocket upgrade to fail')))
    socket.once('error', () => {})
  })
}

const createWorkspace = async (baseUrl: string, cookie: string, workspacePath: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
  })
  return (await response.json()) as { id: string }
}

const createWorker = async (baseUrl: string, cookie: string, workspaceId: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alice' }),
  })
  return (await response.json()) as { id: string }
}

const configureAgent = async (
  store: RuntimeStore,
  workspaceId: string,
  agentId: string,
  command: string,
  args: string[]
) => {
  store.configureAgentLaunch(workspaceId, agentId, { args, command, provider: 'codex' })
}

const startAgent = async (
  store: RuntimeStore,
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

afterEach(() => {
  vi.restoreAllMocks()
  while (restoreEnv.length > 0) {
    const [key, value] = restoreEnv.pop() ?? ['', undefined]
    if (!key) continue
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const setEnv = (key: string, value: string | undefined) => {
  restoreEnv.push([key, process.env[key]])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

const testWithRealPty = process.platform === 'win32' ? test.skip : test

describe('terminal websocket server', () => {
  test('forwards io socket messages to the runtime PTY input writer', async () => {
    const writes: Array<Buffer | string> = []
    const outputBus = createPtyOutputBus()
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: '',
        runId: 'run-mobile-input',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun: () => {},
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: (_runId: string, input: Buffer | string) => {
        writes.push(input)
      },
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`

    try {
      const viewer = await openTerminalViewer(
        baseUrl,
        'hive_ui_token=test',
        'run-mobile-input',
        'mobile-input'
      )
      viewer.io.send('hello from mobile\r')

      await waitFor(() => {
        expect(writes).toEqual(['hello from mobile\r'])
      })

      viewer.control.close()
      viewer.io.close()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('reports inactive PTY input errors without crashing the runtime', async () => {
    const outputBus = createPtyOutputBus()
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: '',
        runId: 'run-inactive-input',
        status: 'exited',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun: () => {},
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {
        throw new Error('PTY is not active for run: run-inactive-input')
      },
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`

    try {
      const viewer = await openTerminalViewer(
        baseUrl,
        'hive_ui_token=test',
        'run-inactive-input',
        'inactive-input'
      )
      const messages: string[] = []
      viewer.io.on('message', (message) => messages.push(message.toString()))
      viewer.io.send('\x03')

      await waitFor(() => {
        expect(messages.map((message) => JSON.parse(message))).toContainEqual({
          message: 'PTY is not active for run: run-inactive-input',
          type: 'error',
        })
      })

      expect(server.listening).toBe(true)
      viewer.control.close()
      viewer.io.close()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('uses the desktop canonical restore size for passive mobile viewers', async () => {
    const outputBus = createPtyOutputBus()
    const resizeAgentRun = vi.fn()
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: 'LEFT\x1b[100CRIGHT',
        runId: 'run-restore-size',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun,
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`

    const readRestore = async (cols: number, clientId: string, passive = false) => {
      const passiveParam = passive ? '&passive=1' : ''
      const control = new WebSocket(
        toWsUrl(
          baseUrl,
          `/ws/terminal/run-restore-size/control?clientId=${clientId}&cols=${cols}&rows=5${passiveParam}`
        ),
        { headers: { cookie: 'hive_ui_token=test' } }
      )
      try {
        return await new Promise<{ cols?: number; rows?: number; snapshot: string }>(
          (resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timed out waiting for restore')), 1000)
            control.once('error', reject)
            control.on('message', (chunk) => {
              const message = JSON.parse(chunk.toString()) as {
                cols?: number
                rows?: number
                snapshot?: string
                type: string
              }
              if (message.type !== 'restore') return
              clearTimeout(timer)
              resolve({
                cols: message.cols,
                rows: message.rows,
                snapshot: String(message.snapshot ?? ''),
              })
            })
          }
        )
      } finally {
        control.close()
      }
    }

    try {
      const wideRestore = await readRestore(120, 'wide')
      const mobileRestore = await readRestore(40, 'mobile', true)

      expect(wideRestore.cols).toBe(120)
      expect(wideRestore.rows).toBe(5)
      expect(wideRestore.snapshot).toContain('LEFT')
      expect(wideRestore.snapshot).toContain('RIGHT')
      expect(mobileRestore.cols).toBe(120)
      expect(mobileRestore.rows).toBe(5)
      expect(mobileRestore.snapshot).toBe(wideRestore.snapshot)
      const passiveControl = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-restore-size/control?clientId=mobile-resize&cols=40&rows=5&passive=1'
        ),
        'hive_ui_token=test'
      )
      passiveControl.send(JSON.stringify({ type: 'resize', cols: 40, rows: 12 }))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(resizeAgentRun).not.toHaveBeenCalled()
      passiveControl.close()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('rehydrates passive mobile restore snapshots at the requested mirror width without resizing the PTY', async () => {
    const outputBus = createPtyOutputBus()
    const resizeAgentRun = vi.fn()
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: 'alpha beta gamma delta epsilon zeta eta theta iota kappa\r\n',
        runId: 'run-passive-wide-restore',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun,
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = 'hive_ui_token=test'

    const readRestore = async (suffix: string) => {
      const control = new WebSocket(
        toWsUrl(baseUrl, `/ws/terminal/run-passive-wide-restore/control?${suffix}`),
        { headers: { cookie } }
      )
      try {
        return await new Promise<{ cols?: number; rows?: number; snapshot: string }>(
          (resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timed out waiting for restore')), 1000)
            control.on('message', (chunk) => {
              const message = JSON.parse(chunk.toString()) as {
                cols?: number
                rows?: number
                snapshot?: string
                type: string
              }
              if (message.type !== 'restore') return
              clearTimeout(timer)
              resolve({
                cols: message.cols,
                rows: message.rows,
                snapshot: String(message.snapshot ?? ''),
              })
            })
          }
        )
      } finally {
        control.close()
      }
    }

    try {
      const narrowRestore = await readRestore('clientId=desktop&mode=active&cols=48&rows=16')
      const widePassiveRestore = await readRestore('clientId=mobile&mode=passive&cols=120&rows=40')

      expect(narrowRestore.cols).toBe(48)
      expect(widePassiveRestore.cols).toBe(120)
      expect(widePassiveRestore.rows).toBe(40)
      expect(widePassiveRestore.snapshot).not.toBe(narrowRestore.snapshot)
      expect(widePassiveRestore.snapshot).toContain('alpha beta gamma')
      expect(resizeAgentRun).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('limits takeover restore snapshots to recent scrollback for faster mobile reconnects', async () => {
    const outputBus = createPtyOutputBus()
    const server = createServer()
    const longOutput = Array.from(
      { length: 350 },
      (_, index) => `line-${String(index + 1).padStart(3, '0')}\r\n`
    ).join('')
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: longOutput,
        runId: 'run-mobile-light-restore',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun: () => {},
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`

    const readRestore = async (mode: 'active' | 'takeover', clientId: string) => {
      const control = new WebSocket(
        toWsUrl(
          baseUrl,
          `/ws/terminal/run-mobile-light-restore/control?clientId=${clientId}&mode=${mode}&cols=120&rows=40`
        ),
        { headers: { cookie: 'hive_ui_token=test' } }
      )
      try {
        return await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Timed out waiting for restore')), 1000)
          control.once('error', reject)
          control.on('message', (chunk) => {
            const message = JSON.parse(chunk.toString()) as { snapshot?: string; type: string }
            if (message.type !== 'restore') return
            clearTimeout(timer)
            resolve(String(message.snapshot ?? ''))
          })
        })
      } finally {
        control.close()
      }
    }

    try {
      const activeSnapshot = await readRestore('active', 'desktop')
      const takeoverSnapshot = await readRestore('takeover', 'mobile')

      expect(activeSnapshot).toContain('line-001')
      expect(activeSnapshot).toContain('line-350')
      expect(takeoverSnapshot).not.toContain('line-001')
      expect(takeoverSnapshot).not.toContain('line-050')
      expect(takeoverSnapshot).not.toContain('line-250')
      expect(takeoverSnapshot).not.toContain('line-300')
      expect(takeoverSnapshot).toContain('line-350')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('returns a fresh phone-sized restore without resizing the real PTY', async () => {
    const outputBus = createPtyOutputBus()
    const resizeAgentRun = vi.fn()
    const server = createServer()
    const longOutput = Array.from(
      { length: 120 },
      (_, index) => `requested-line-${String(index + 1).padStart(3, '0')} alpha beta gamma\r\n`
    ).join('')
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: longOutput,
        runId: 'run-requested-restore',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun,
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`

    let control: WebSocket | undefined
    let io: WebSocket | undefined
    try {
      control = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-requested-restore/control?clientId=mobile&mode=takeover&defer_restore=1'
        ),
        'hive_ui_token=test'
      )
      io = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-requested-restore/io?clientId=mobile&mode=takeover&defer_restore=1'
        ),
        'hive_ui_token=test'
      )
      const automaticRestores: Array<Record<string, unknown>> = []
      control.on('message', (chunk) => {
        const message = JSON.parse(chunk.toString()) as Record<string, unknown>
        if (message.type === 'restore' && !message.request_id) automaticRestores.push(message)
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(automaticRestores).toEqual([])
      const requestedRestore = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for restore')), 1000)
        control.on('message', (chunk) => {
          const message = JSON.parse(chunk.toString()) as Record<string, unknown>
          if (message.type !== 'restore' || message.request_id !== 'phone-restore-1') return
          clearTimeout(timer)
          resolve(message)
        })
      })
      control.send(
        JSON.stringify({
          type: 'restore_request',
          cols: 48,
          request_id: 'phone-restore-1',
          rows: 16,
          scrollback: 20,
        })
      )

      const restore = await requestedRestore
      const liveOutput: string[] = []
      io.on('message', (chunk) => liveOutput.push(chunk.toString()))
      outputBus.publish('run-requested-restore', 'live-after-restore-request')
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(liveOutput).toEqual([])
      expect(restore).toMatchObject({
        cols: 48,
        request_id: 'phone-restore-1',
        rows: 16,
        type: 'restore',
      })
      expect(String(restore.snapshot)).not.toContain('requested-line-001')
      expect(String(restore.snapshot)).not.toContain('requested-line-080')
      expect(String(restore.snapshot)).toContain('requested-line-120')
      expect(resizeAgentRun).not.toHaveBeenCalled()
      control.send(JSON.stringify({ type: 'restore_complete' }))
      await waitFor(() => expect(liveOutput).toEqual(['live-after-restore-request']))
    } finally {
      control?.close()
      io?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('holds active desktop output until its automatic restore completes', async () => {
    const outputBus = createPtyOutputBus()
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: 'RESTORED_HISTORY\r\n',
        runId: 'run-active-restore-barrier',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun: () => {},
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = 'hive_ui_token=test'
    const control = await openSocket(
      toWsUrl(baseUrl, '/ws/terminal/run-active-restore-barrier/control?clientId=desktop'),
      cookie
    )
    const restoreReceived = new Promise<void>((resolve) => {
      control.on('message', (chunk) => {
        const message = JSON.parse(chunk.toString()) as Record<string, unknown>
        if (message.type === 'restore') resolve()
      })
    })
    const io = await openSocket(
      toWsUrl(baseUrl, '/ws/terminal/run-active-restore-barrier/io?clientId=desktop'),
      cookie
    )
    const liveOutput: string[] = []
    io.on('message', (chunk) => liveOutput.push(chunk.toString()))

    try {
      await restoreReceived
      outputBus.publish('run-active-restore-barrier', 'LIVE_DURING_RESTORE\r\n')
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(liveOutput).toEqual([])

      control.send(JSON.stringify({ type: 'restore_complete' }))
      await waitFor(() => expect(liveOutput).toEqual(['LIVE_DURING_RESTORE\r\n']))
    } finally {
      control.close()
      io.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('disconnects a stalled deferred-restore viewer without pausing the terminal', async () => {
    const outputBus = createPtyOutputBus()
    const pauseTerminalRun = vi.fn()
    const resumeTerminalRun = vi.fn()
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: '',
        runId: 'run-disconnected-restore',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun,
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun: () => {},
      resumeTerminalRun,
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`

    const control = await openSocket(
      toWsUrl(
        baseUrl,
        '/ws/terminal/run-disconnected-restore/control?clientId=mobile&mode=takeover&defer_restore=1'
      ),
      'hive_ui_token=test'
    )
    const io = await openSocket(
      toWsUrl(
        baseUrl,
        '/ws/terminal/run-disconnected-restore/io?clientId=mobile&mode=takeover&defer_restore=1'
      ),
      'hive_ui_token=test'
    )

    try {
      const restoreReceived = new Promise<void>((resolve) => {
        control.on('message', (chunk) => {
          const message = JSON.parse(chunk.toString()) as Record<string, unknown>
          if (message.request_id === 'disconnect-restore') resolve()
        })
      })
      control.send(
        JSON.stringify({
          type: 'restore_request',
          cols: 48,
          request_id: 'disconnect-restore',
          rows: 16,
          scrollback: 20,
        })
      )
      await restoreReceived
      outputBus.publish('run-disconnected-restore', 'x'.repeat(256 * 1024))
      await waitFor(() => {
        expect(control.readyState).toBe(WebSocket.CLOSED)
        expect(io.readyState).toBe(WebSocket.CLOSED)
      })
      expect(pauseTerminalRun).not.toHaveBeenCalled()
      expect(resumeTerminalRun).not.toHaveBeenCalled()
    } finally {
      control.close()
      io.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('returns a bounded restore when a stalled deferred viewer reconnects', async () => {
    const outputBus = createPtyOutputBus()
    const pauseTerminalRun = vi.fn()
    const resumeTerminalRun = vi.fn()
    const server = createServer()
    let liveOutput = ''
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: liveOutput,
        runId: 'run-replaced-restore',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun,
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun: () => {},
      resumeTerminalRun,
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const controlUrl = toWsUrl(
      baseUrl,
      '/ws/terminal/run-replaced-restore/control?clientId=mobile&mode=takeover&defer_restore=1'
    )
    const ioUrl = toWsUrl(
      baseUrl,
      '/ws/terminal/run-replaced-restore/io?clientId=mobile&mode=takeover&defer_restore=1'
    )

    const control = await openSocket(controlUrl, 'hive_ui_token=test')
    const io = await openSocket(ioUrl, 'hive_ui_token=test')
    let reconnectControl: WebSocket | undefined
    let reconnectIo: WebSocket | undefined

    try {
      const firstRestoreReceived = new Promise<void>((resolve) => {
        control.on('message', (chunk) => {
          const message = JSON.parse(chunk.toString()) as Record<string, unknown>
          if (message.request_id === 'first-restore') resolve()
        })
      })
      control.send(
        JSON.stringify({
          type: 'restore_request',
          cols: 48,
          request_id: 'first-restore',
          rows: 16,
          scrollback: 20,
        })
      )
      await firstRestoreReceived
      liveOutput = Array.from(
        { length: 600 },
        (_, index) => `restore-line-${String(index + 1).padStart(3, '0')}:${'x'.repeat(500)}\r\n`
      ).join('')
      outputBus.publish('run-replaced-restore', liveOutput)
      await waitFor(() => {
        expect(control.readyState).toBe(WebSocket.CLOSED)
        expect(io.readyState).toBe(WebSocket.CLOSED)
      })

      reconnectControl = await openSocket(controlUrl, 'hive_ui_token=test')
      reconnectIo = await openSocket(ioUrl, 'hive_ui_token=test')
      const reconnectRestore = new Promise<Record<string, unknown>>((resolve) => {
        reconnectControl?.on('message', (chunk) => {
          const message = JSON.parse(chunk.toString()) as Record<string, unknown>
          if (message.request_id === 'reconnect-restore') resolve(message)
        })
      })
      reconnectControl.send(
        JSON.stringify({
          type: 'restore_request',
          cols: 48,
          request_id: 'reconnect-restore',
          rows: 16,
          scrollback: 20,
        })
      )
      const restore = await reconnectRestore
      expect(String(restore.snapshot)).not.toContain('restore-line-001')
      expect(String(restore.snapshot)).toContain('restore-line-600')

      const liveAfterRestore = new Promise<string>((resolve) => {
        reconnectIo?.on('message', (chunk) => resolve(chunk.toString()))
      })
      reconnectControl.send(JSON.stringify({ type: 'restore_complete' }))
      liveOutput += 'LIVE_AFTER_RESTORE\r\n'
      outputBus.publish('run-replaced-restore', 'LIVE_AFTER_RESTORE\r\n')
      await expect(liveAfterRestore).resolves.toContain('LIVE_AFTER_RESTORE')
      expect(pauseTerminalRun).not.toHaveBeenCalled()
      expect(resumeTerminalRun).not.toHaveBeenCalled()
    } finally {
      control.close()
      io.close()
      reconnectControl?.close()
      reconnectIo?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('rehydrates only recent output when the first terminal viewer is mobile takeover', async () => {
    const outputBus = createPtyOutputBus()
    const server = createServer()
    const longOutput = Array.from(
      { length: 1200 },
      (_, index) => `takeover-first-line-${String(index + 1).padStart(4, '0')}\r\n`
    ).join('')
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: longOutput,
        runId: 'run-mobile-first-light-restore',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun: () => {},
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`

    try {
      const control = new WebSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-mobile-first-light-restore/control?clientId=mobile&mode=takeover&cols=120&rows=40'
        ),
        { headers: { cookie: 'hive_ui_token=test' } }
      )
      const snapshot = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for restore')), 1000)
        control.once('error', reject)
        control.on('message', (chunk) => {
          const message = JSON.parse(chunk.toString()) as { snapshot?: string; type: string }
          if (message.type !== 'restore') return
          clearTimeout(timer)
          resolve(String(message.snapshot ?? ''))
        })
      })
      control.close()

      expect(snapshot).not.toContain('takeover-first-line-0001')
      expect(snapshot).not.toContain('takeover-first-line-0900')
      expect(snapshot).not.toContain('takeover-first-line-0500')
      expect(snapshot).not.toContain('takeover-first-line-1100')
      expect(snapshot).not.toContain('takeover-first-line-1150')
      expect(snapshot).toContain('takeover-first-line-1200')
      expect(snapshot.length).toBeLessThan(longOutput.length)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('grants takeover resize ownership and restores the previous desktop size on release', async () => {
    const outputBus = createPtyOutputBus()
    const resizeAgentRun = vi.fn()
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: '',
        runId: 'run-takeover',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun,
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = 'hive_ui_token=test'
    const messages: Array<Record<string, unknown>> = []
    let desktop: WebSocket | undefined
    let mobile: WebSocket | undefined

    try {
      desktop = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-takeover/control?clientId=desktop&mode=active&cols=120&rows=40'
        ),
        cookie
      )
      desktop.on('message', (chunk) => {
        messages.push(JSON.parse(chunk.toString()) as Record<string, unknown>)
      })
      mobile = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-takeover/control?clientId=mobile&mode=takeover&cols=40&rows=12'
        ),
        cookie
      )
      mobile.on('message', (chunk) => {
        messages.push(JSON.parse(chunk.toString()) as Record<string, unknown>)
      })

      mobile.send(
        JSON.stringify({
          type: 'takeover_request',
          cols: 48,
          rows: 16,
          restore_on_release: true,
        })
      )
      await waitFor(() => {
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: 'takeover_granted',
            cols: 48,
            rows: 16,
            previousSize: { cols: 120, rows: 40 },
          })
        )
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: 'size_owner_changed',
            mode: 'takeover',
            ownerClientId: 'mobile',
            cols: 48,
            rows: 16,
          })
        )
        expect(resizeAgentRun).toHaveBeenCalledWith('run-takeover', 48, 16)
      })

      desktop.send(JSON.stringify({ type: 'resize', cols: 140, rows: 45 }))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(resizeAgentRun).not.toHaveBeenCalledWith('run-takeover', 140, 45)

      mobile.send(JSON.stringify({ type: 'takeover_release' }))
      await waitFor(() => {
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: 'size_owner_changed',
            mode: 'active',
            ownerClientId: 'desktop',
            cols: 48,
            rows: 16,
          })
        )
        expect(resizeAgentRun).toHaveBeenCalledWith('run-takeover', 120, 40)
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: 'size_owner_changed',
            mode: 'active',
            ownerClientId: 'desktop',
            cols: 120,
            rows: 40,
          })
        )
      })
    } finally {
      desktop?.close()
      mobile?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('notifies takeover release even if restoring the previous desktop size fails', async () => {
    const outputBus = createPtyOutputBus()
    const resizeAgentRun = vi.fn((runId: string, cols: number, rows: number) => {
      if (cols === 120 && rows === 40) throw new Error(`restore failed for ${runId}`)
    })
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: '',
        runId: 'run-release-notify-first',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun,
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = 'hive_ui_token=test'
    const messages: Array<Record<string, unknown>> = []
    let desktop: WebSocket | undefined
    let mobile: WebSocket | undefined

    try {
      desktop = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-release-notify-first/control?clientId=desktop&mode=active&cols=120&rows=40'
        ),
        cookie
      )
      desktop.on('message', (chunk) => {
        messages.push(JSON.parse(chunk.toString()) as Record<string, unknown>)
      })
      mobile = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-release-notify-first/control?clientId=mobile&mode=takeover&cols=40&rows=12'
        ),
        cookie
      )
      mobile.on('message', (chunk) => {
        messages.push(JSON.parse(chunk.toString()) as Record<string, unknown>)
      })

      mobile.send(
        JSON.stringify({
          type: 'takeover_request',
          cols: 48,
          rows: 16,
          restore_on_release: true,
        })
      )
      await waitFor(() => {
        expect(resizeAgentRun).toHaveBeenCalledWith('run-release-notify-first', 48, 16)
      })

      mobile.send(JSON.stringify({ type: 'takeover_release' }))
      await waitFor(() => {
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: 'size_owner_changed',
            mode: 'active',
            ownerClientId: 'desktop',
            cols: 48,
            rows: 16,
          })
        )
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: 'error',
            message: 'restore failed for run-release-notify-first',
          })
        )
      })
    } finally {
      desktop?.close()
      mobile?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('changes ownership only after takeover and reclaim resize succeeds', async () => {
    const outputBus = createPtyOutputBus()
    const resizeAgentRun = vi.fn((runId: string, cols: number, rows: number) => {
      if ((cols === 48 && rows === 16) || (cols === 132 && rows === 44)) {
        throw new Error(`resize failed for ${runId} at ${cols}x${rows}`)
      }
    })
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: '',
        runId: 'run-ownership-resize-failure',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun,
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = 'hive_ui_token=test'
    const messages: Array<Record<string, unknown>> = []
    let desktop: WebSocket | undefined
    let mobile: WebSocket | undefined

    try {
      desktop = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-ownership-resize-failure/control?clientId=desktop&mode=active&cols=120&rows=40'
        ),
        cookie
      )
      mobile = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-ownership-resize-failure/control?clientId=mobile&mode=takeover&cols=40&rows=12'
        ),
        cookie
      )
      for (const socket of [desktop, mobile]) {
        socket.on('message', (chunk) => {
          messages.push(JSON.parse(chunk.toString()) as Record<string, unknown>)
        })
      }

      mobile.send(
        JSON.stringify({
          type: 'takeover_request',
          cols: 48,
          rows: 16,
          restore_on_release: true,
        })
      )
      await waitFor(() => {
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: 'error',
            message: 'resize failed for run-ownership-resize-failure at 48x16',
          })
        )
      })

      desktop.send(JSON.stringify({ type: 'resize', cols: 125, rows: 41 }))
      await waitFor(() => {
        expect(resizeAgentRun).toHaveBeenCalledWith('run-ownership-resize-failure', 125, 41)
      })

      mobile.send(
        JSON.stringify({
          type: 'takeover_request',
          cols: 50,
          rows: 18,
          restore_on_release: true,
        })
      )
      await waitFor(() => {
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: 'size_owner_changed',
            mode: 'takeover',
            ownerClientId: 'mobile',
            cols: 50,
            rows: 18,
          })
        )
      })

      desktop.send(JSON.stringify({ type: 'takeover_reclaim', cols: 132, rows: 44 }))
      await waitFor(() => {
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: 'error',
            message: 'resize failed for run-ownership-resize-failure at 132x44',
          })
        )
      })

      mobile.send(JSON.stringify({ type: 'resize', cols: 52, rows: 20 }))
      await waitFor(() => {
        expect(resizeAgentRun).toHaveBeenCalledWith('run-ownership-resize-failure', 52, 20)
      })
      expect(messages).not.toContainEqual(
        expect.objectContaining({
          type: 'size_owner_changed',
          mode: 'active',
          ownerClientId: 'desktop',
          cols: 132,
          rows: 44,
        })
      )
    } finally {
      desktop?.close()
      mobile?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('lets the active desktop viewer reclaim terminal ownership from mobile takeover', async () => {
    const outputBus = createPtyOutputBus()
    const resizeAgentRun = vi.fn()
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: '',
        runId: 'run-reclaim',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun,
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = 'hive_ui_token=test'
    const messages: Array<Record<string, unknown>> = []

    try {
      const desktop = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-reclaim/control?clientId=desktop&mode=active&cols=120&rows=40'
        ),
        cookie
      )
      desktop.on('message', (chunk) => {
        messages.push(JSON.parse(chunk.toString()) as Record<string, unknown>)
      })
      const mobile = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-reclaim/control?clientId=mobile&mode=takeover&cols=40&rows=12'
        ),
        cookie
      )
      mobile.on('message', (chunk) => {
        messages.push(JSON.parse(chunk.toString()) as Record<string, unknown>)
      })

      mobile.send(
        JSON.stringify({
          type: 'takeover_request',
          cols: 48,
          rows: 16,
          restore_on_release: true,
        })
      )
      await waitFor(() => {
        expect(resizeAgentRun).toHaveBeenCalledWith('run-reclaim', 48, 16)
      })

      desktop.send(JSON.stringify({ type: 'takeover_reclaim', cols: 132, rows: 44 }))
      await waitFor(() => {
        expect(resizeAgentRun).toHaveBeenCalledWith('run-reclaim', 132, 44)
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: 'size_owner_changed',
            mode: 'active',
            ownerClientId: 'desktop',
            cols: 132,
            rows: 44,
          })
        )
      })

      mobile.send(JSON.stringify({ type: 'resize', cols: 50, rows: 18 }))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(resizeAgentRun).not.toHaveBeenCalledWith('run-reclaim', 50, 18)

      desktop.close()
      mobile.close()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('grants input and resize only to the current active desktop owner', async () => {
    const outputBus = createPtyOutputBus()
    const resizeAgentRun = vi.fn()
    const writeRunInput = vi.fn()
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: '',
        runId: 'run-desktop-owner-authority',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun,
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput,
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = 'hive_ui_token=test'
    const ownerControl = await openSocket(
      toWsUrl(baseUrl, '/ws/terminal/run-desktop-owner-authority/control?clientId=owner'),
      cookie
    )
    const ownerIo = await openSocket(
      toWsUrl(baseUrl, '/ws/terminal/run-desktop-owner-authority/io?clientId=owner'),
      cookie
    )
    const nextControl = await openSocket(
      toWsUrl(baseUrl, '/ws/terminal/run-desktop-owner-authority/control?clientId=next'),
      cookie
    )
    const ownerChanges: Array<Record<string, unknown>> = []
    nextControl.on('message', (chunk) => {
      ownerChanges.push(JSON.parse(chunk.toString()) as Record<string, unknown>)
    })
    const nextIo = await openSocket(
      toWsUrl(baseUrl, '/ws/terminal/run-desktop-owner-authority/io?clientId=next'),
      cookie
    )

    try {
      nextControl.send(JSON.stringify({ type: 'resize', cols: 90, rows: 30 }))
      nextIo.send('blocked input')
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(resizeAgentRun).not.toHaveBeenCalled()
      expect(writeRunInput).not.toHaveBeenCalled()

      ownerControl.close()
      ownerIo.close()
      await waitFor(() => {
        expect(ownerChanges).toContainEqual(
          expect.objectContaining({
            type: 'size_owner_changed',
            mode: 'active',
            ownerClientId: 'next',
          })
        )
      })

      nextControl.send(JSON.stringify({ type: 'resize', cols: 100, rows: 32 }))
      nextIo.send('accepted input')
      await waitFor(() => {
        expect(resizeAgentRun).toHaveBeenCalledWith('run-desktop-owner-authority', 100, 32)
        expect(writeRunInput).toHaveBeenCalledWith('run-desktop-owner-authority', 'accepted input')
      })
    } finally {
      ownerControl.close()
      ownerIo.close()
      nextControl.close()
      nextIo.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('ignores stale socket closes after the same viewer reconnects', async () => {
    const outputBus = createPtyOutputBus()
    const resizeAgentRun = vi.fn()
    const writeRunInput = vi.fn()
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: '',
        runId: 'run-stale-socket-close',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun,
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput,
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = 'hive_ui_token=test'
    const controlUrl = toWsUrl(
      baseUrl,
      '/ws/terminal/run-stale-socket-close/control?clientId=desktop&mode=active&cols=120&rows=40'
    )
    const ioUrl = toWsUrl(
      baseUrl,
      '/ws/terminal/run-stale-socket-close/io?clientId=desktop&mode=active'
    )
    let oldControl: WebSocket | undefined
    let oldIo: WebSocket | undefined
    let newControl: WebSocket | undefined
    let newIo: WebSocket | undefined

    try {
      oldControl = await openSocket(controlUrl, cookie)
      oldIo = await openSocket(ioUrl, cookie)

      newControl = new WebSocket(controlUrl, { headers: { cookie } })
      const restoreReceived = new Promise<void>((resolve) => {
        newControl?.on('message', (chunk) => {
          const message = JSON.parse(chunk.toString()) as Record<string, unknown>
          if (message.type === 'restore') resolve()
        })
      })
      await new Promise<void>((resolve, reject) => {
        newControl?.once('open', () => resolve())
        newControl?.once('error', reject)
      })
      newIo = await openSocket(ioUrl, cookie)
      const newOutput: string[] = []
      newIo.on('message', (chunk) => newOutput.push(chunk.toString()))
      await restoreReceived

      oldControl.close()
      oldIo.close()
      await waitFor(() => {
        expect(oldControl?.readyState).toBe(WebSocket.CLOSED)
        expect(oldIo?.readyState).toBe(WebSocket.CLOSED)
      })

      outputBus.publish('run-stale-socket-close', 'queued-after-reconnect\r\n')
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(newOutput).toEqual([])

      newControl.send(JSON.stringify({ type: 'restore_complete' }))
      await waitFor(() => expect(newOutput).toEqual(['queued-after-reconnect\r\n']))

      newControl.send(JSON.stringify({ type: 'resize', cols: 132, rows: 44 }))
      newIo.send('new viewer input')
      await waitFor(() => {
        expect(resizeAgentRun).toHaveBeenCalledWith('run-stale-socket-close', 132, 44)
        expect(writeRunInput).toHaveBeenCalledWith('run-stale-socket-close', 'new viewer input')
      })
    } finally {
      oldControl?.close()
      oldIo?.close()
      newControl?.close()
      newIo?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('restores the previous desktop size when the takeover control socket disconnects', async () => {
    const outputBus = createPtyOutputBus()
    const resizeAgentRun = vi.fn()
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: '',
        runId: 'run-takeover-disconnect',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun,
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = 'hive_ui_token=test'

    try {
      const desktop = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-takeover-disconnect/control?clientId=desktop&mode=active&cols=120&rows=40'
        ),
        cookie
      )
      const mobileControl = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-takeover-disconnect/control?clientId=mobile&mode=takeover&cols=40&rows=12'
        ),
        cookie
      )
      const mobileIo = await openSocket(
        toWsUrl(baseUrl, '/ws/terminal/run-takeover-disconnect/io?clientId=mobile'),
        cookie
      )

      mobileControl.send(
        JSON.stringify({
          type: 'takeover_request',
          cols: 50,
          rows: 18,
          restore_on_release: true,
        })
      )
      await waitFor(() => {
        expect(resizeAgentRun).toHaveBeenCalledWith('run-takeover-disconnect', 50, 18)
      })

      mobileControl.close()
      await waitFor(() => {
        expect(resizeAgentRun).toHaveBeenCalledWith('run-takeover-disconnect', 120, 40)
      })

      desktop.send(JSON.stringify({ type: 'resize', cols: 132, rows: 44 }))
      await waitFor(() => {
        expect(resizeAgentRun).toHaveBeenCalledWith('run-takeover-disconnect', 132, 44)
      })

      desktop.close()
      mobileIo.close()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('renews mobile takeover ownership with heartbeats and restores after lease expiry', async () => {
    const outputBus = createPtyOutputBus()
    const resizeAgentRun = vi.fn()
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: '',
        runId: 'run-takeover-lease',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun,
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store, { takeoverLeaseCheckMs: 10, takeoverLeaseMs: 80 })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = 'hive_ui_token=test'
    const messages: Array<Record<string, unknown>> = []
    let desktop: WebSocket | undefined
    let mobile: WebSocket | undefined

    try {
      desktop = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-takeover-lease/control?clientId=desktop&mode=active&cols=120&rows=40'
        ),
        cookie
      )
      desktop.on('message', (chunk) => {
        messages.push(JSON.parse(chunk.toString()) as Record<string, unknown>)
      })
      mobile = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-takeover-lease/control?clientId=mobile&mode=takeover&cols=40&rows=12'
        ),
        cookie
      )

      mobile.send(
        JSON.stringify({
          type: 'takeover_request',
          cols: 50,
          rows: 18,
          restore_on_release: true,
        })
      )
      await waitFor(() => {
        expect(resizeAgentRun).toHaveBeenCalledWith('run-takeover-lease', 50, 18)
      })

      await new Promise((resolve) => setTimeout(resolve, 45))
      mobile.send(JSON.stringify({ type: 'takeover_heartbeat' }))
      await new Promise((resolve) => setTimeout(resolve, 45))
      expect(resizeAgentRun).not.toHaveBeenCalledWith('run-takeover-lease', 120, 40)

      await waitFor(
        () => {
          expect(messages).toContainEqual(
            expect.objectContaining({
              type: 'size_owner_changed',
              mode: 'active',
              ownerClientId: 'desktop',
              cols: 50,
              rows: 18,
            })
          )
          expect(resizeAgentRun).toHaveBeenCalledWith('run-takeover-lease', 120, 40)
          expect(messages).toContainEqual(
            expect.objectContaining({
              type: 'size_owner_changed',
              mode: 'active',
              ownerClientId: 'desktop',
              cols: 120,
              rows: 40,
            })
          )
        },
        500,
        10
      )
    } finally {
      desktop?.close()
      mobile?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('rejects invalid takeover and resize dimensions without resizing the PTY', async () => {
    const outputBus = createPtyOutputBus()
    const resizeAgentRun = vi.fn()
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: '',
        runId: 'run-invalid-size',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun,
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = 'hive_ui_token=test'
    const messages: Array<Record<string, unknown>> = []

    try {
      const desktop = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-invalid-size/control?clientId=desktop&mode=active&cols=120&rows=40'
        ),
        cookie
      )
      desktop.on('message', (chunk) => {
        messages.push(JSON.parse(chunk.toString()) as Record<string, unknown>)
      })
      const mobile = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-invalid-size/control?clientId=mobile&mode=takeover&cols=40&rows=12'
        ),
        cookie
      )
      mobile.on('message', (chunk) => {
        messages.push(JSON.parse(chunk.toString()) as Record<string, unknown>)
      })

      mobile.send(
        JSON.stringify({
          type: 'takeover_request',
          cols: 0,
          rows: 12,
          restore_on_release: true,
        })
      )
      desktop.send(JSON.stringify({ type: 'resize', cols: -1, rows: 20 }))

      await waitFor(() => {
        expect(messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ message: 'Invalid terminal control message', type: 'error' }),
          ])
        )
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(resizeAgentRun).not.toHaveBeenCalled()

      desktop.close()
      mobile.close()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('ignores takeover release and resize from non-owner viewers', async () => {
    const outputBus = createPtyOutputBus()
    const resizeAgentRun = vi.fn()
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: '',
        runId: 'run-non-owner',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun: () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun,
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = 'hive_ui_token=test'

    try {
      const desktop = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-non-owner/control?clientId=desktop&mode=active&cols=120&rows=40'
        ),
        cookie
      )
      const owner = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-non-owner/control?clientId=owner&mode=takeover&cols=40&rows=12'
        ),
        cookie
      )
      const intruder = await openSocket(
        toWsUrl(
          baseUrl,
          '/ws/terminal/run-non-owner/control?clientId=intruder&mode=takeover&cols=42&rows=14'
        ),
        cookie
      )

      owner.send(
        JSON.stringify({
          type: 'takeover_request',
          cols: 50,
          rows: 18,
          restore_on_release: true,
        })
      )
      await waitFor(() => {
        expect(resizeAgentRun).toHaveBeenCalledWith('run-non-owner', 50, 18)
      })

      intruder.send(JSON.stringify({ type: 'takeover_release' }))
      intruder.send(JSON.stringify({ type: 'resize', cols: 88, rows: 22 }))
      desktop.send(JSON.stringify({ type: 'resize', cols: 140, rows: 45 }))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(resizeAgentRun).not.toHaveBeenCalledWith('run-non-owner', 88, 22)
      expect(resizeAgentRun).not.toHaveBeenCalledWith('run-non-owner', 140, 45)

      owner.send(JSON.stringify({ type: 'resize', cols: 52, rows: 19 }))
      await waitFor(() => {
        expect(resizeAgentRun).toHaveBeenCalledWith('run-non-owner', 52, 19)
      })
      owner.send(JSON.stringify({ type: 'takeover_release' }))
      await waitFor(() => {
        expect(resizeAgentRun).toHaveBeenCalledWith('run-non-owner', 120, 40)
      })

      desktop.close()
      owner.close()
      intruder.close()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('bounds a stalled passive viewer without resizing or pausing the PTY', async () => {
    const outputBus = createPtyOutputBus()
    const pauseTerminalRun = vi.fn()
    const resizeAgentRun = vi.fn()
    const server = createServer()
    const store = {
      getLiveRun: () => ({
        agentId: 'worker-1',
        exitCode: null,
        output: '',
        runId: 'run-passive-backpressure',
        status: 'running',
      }),
      getPtyOutputBus: () => outputBus,
      pauseTerminalRun,
      registerTasksListener: () => () => {},
      registerRuntimeChangeListener: () => () => {},
      resizeAgentRun,
      resumeTerminalRun: () => {},
      stopAgentRun: () => {},
      validateUiToken: () => true,
      writeRunInput: () => {},
    } as Pick<
      RuntimeStore,
      | 'getLiveRun'
      | 'getPtyOutputBus'
      | 'pauseTerminalRun'
      | 'registerRuntimeChangeListener'
      | 'resizeAgentRun'
      | 'resumeTerminalRun'
      | 'stopAgentRun'
      | 'validateUiToken'
      | 'writeRunInput'
    > as RuntimeStore
    createTerminalWebSocketServer(server, store)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = 'hive_ui_token=test'

    try {
      const passiveViewer = await openTerminalViewer(
        baseUrl,
        cookie,
        'run-passive-backpressure',
        'mobile',
        'passive'
      )

      passiveViewer.control.send(JSON.stringify({ type: 'resize', cols: 60, rows: 20 }))
      outputBus.publish('run-passive-backpressure', 'x'.repeat(120 * 1024))
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(resizeAgentRun).not.toHaveBeenCalled()
      expect(pauseTerminalRun).not.toHaveBeenCalled()
      await waitFor(() => {
        expect(passiveViewer.control.readyState).toBe(WebSocket.CLOSED)
        expect(passiveViewer.io.readyState).toBe(WebSocket.CLOSED)
      })

      passiveViewer.control.close()
      passiveViewer.io.close()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  testWithRealPty(
    'streams PTY output over the io socket',
    async () => {
      const workspacePath = join(tmpdir(), `hive-terminal-output-${Date.now()}`)
      mkdirSync(workspacePath, { recursive: true })
      tempDirs.push(workspacePath)
      const script = join(workspacePath, 'ready.js')
      writeFileSync(
        script,
        [
          'let count = 0',
          'const interval = setInterval(() => {',
          '  count += 1',
          "  console.log('ready:' + count)",
          '  if (count >= 20) clearInterval(interval)',
          '}, 50)',
          'process.stdin.resume()',
        ].join('\n')
      )

      const server = await startTestServer()
      try {
        const cookie = await getUiCookie(server.baseUrl)
        const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
        const worker = await createWorker(server.baseUrl, cookie, workspace.id)
        await configureAgent(server.store, workspace.id, worker.id, process.execPath, [script])
        const run = await startAgent(server.store, server.baseUrl, workspace.id, worker.id)
        const viewer = await openTerminalViewer(server.baseUrl, cookie, run.runId, 'output-viewer')
        const received: string[] = [viewer.restoreSnapshot]

        viewer.io.on('message', (chunk) => {
          received.push(chunk.toString())
        })

        await waitFor(() => {
          expect(received.join('')).toContain('ready:')
        })

        viewer.control.close()
        viewer.io.close()
      } finally {
        await server.close()
      }
    },
    60000
  )

  testWithRealPty(
    'forwards stdin from io socket into the PTY',
    async () => {
      const workspacePath = join(tmpdir(), `hive-terminal-stdin-${Date.now()}`)
      mkdirSync(workspacePath, { recursive: true })
      tempDirs.push(workspacePath)
      const script = join(workspacePath, 'echo.js')
      writeFileSync(
        script,
        [
          "process.stdin.setEncoding('utf8')",
          "process.stdin.on('data', (chunk) => {",
          "  process.stdout.write('IN:' + chunk)",
          '})',
        ].join('\n')
      )

      const server = await startTestServer()
      try {
        const cookie = await getUiCookie(server.baseUrl)
        const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
        const worker = await createWorker(server.baseUrl, cookie, workspace.id)
        await configureAgent(server.store, workspace.id, worker.id, process.execPath, [script])
        const run = await startAgent(server.store, server.baseUrl, workspace.id, worker.id)
        const viewer = await openTerminalViewer(server.baseUrl, cookie, run.runId, 'stdin-viewer')
        const received: string[] = [viewer.restoreSnapshot]

        viewer.io.on('message', (chunk) => {
          received.push(chunk.toString())
        })
        viewer.io.send('hello from terminal\n')

        await waitFor(() => {
          expect(received.join('')).toContain('IN:hello from terminal')
        })

        viewer.control.close()
        viewer.io.close()
      } finally {
        await server.close()
      }
    },
    60000
  )

  testWithRealPty(
    'forwards binary stdin from io socket into the PTY',
    async () => {
      const workspacePath = join(tmpdir(), `hive-terminal-binary-stdin-${Date.now()}`)
      mkdirSync(workspacePath, { recursive: true })
      tempDirs.push(workspacePath)
      const script = join(workspacePath, 'hex.js')
      writeFileSync(
        script,
        [
          'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
          'process.stdin.resume()',
          "console.log('READY')",
          "process.stdin.on('data', (chunk) => {",
          "  process.stdout.write('HEX:' + chunk.toString('hex') + '\\n')",
          '})',
        ].join('\n')
      )

      const server = await startTestServer()
      try {
        const cookie = await getUiCookie(server.baseUrl)
        const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
        const worker = await createWorker(server.baseUrl, cookie, workspace.id)
        await configureAgent(server.store, workspace.id, worker.id, process.execPath, [script])
        const run = await startAgent(server.store, server.baseUrl, workspace.id, worker.id)
        const viewer = await openTerminalViewer(
          server.baseUrl,
          cookie,
          run.runId,
          'binary-input-viewer'
        )
        const received: string[] = [viewer.restoreSnapshot]

        viewer.io.on('message', (chunk) => {
          received.push(chunk.toString())
        })

        await waitFor(() => {
          expect(received.join('')).toContain('READY')
        })
        viewer.io.send(Buffer.from([0x1b, 0x5b, 0x4d, 0xc8, 0x21, 0x21]))

        await waitFor(() => {
          expect(received.join('')).toContain('HEX:1b5b4dc82121')
        })

        viewer.control.close()
        viewer.io.close()
      } finally {
        await server.close()
      }
    },
    60000
  )

  test('rejects websocket upgrades for a missing run id', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      await expectUpgradeStatus(toWsUrl(server.baseUrl, '/ws/terminal/missing-run/io'), cookie, 404)
    } finally {
      await server.close()
    }
  })

  test('rejects terminal websocket upgrades from non-local origins', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      await expectUpgradeStatus(
        toWsUrl(server.baseUrl, '/ws/terminal/missing-run/io'),
        cookie,
        403,
        {
          Origin: 'https://attacker.example',
        }
      )
    } finally {
      await server.close()
    }
  })

  test('allows terminal websocket upgrades from a local origin before run lookup', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      await expectUpgradeStatus(
        toWsUrl(server.baseUrl, '/ws/terminal/missing-run/io'),
        cookie,
        404,
        {
          Origin: server.baseUrl,
        }
      )
    } finally {
      await server.close()
    }
  })

  test('rejects terminal websocket upgrades from non-local hosts', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      await expectUpgradeStatus(
        toWsUrl(server.baseUrl, '/ws/terminal/missing-run/io'),
        cookie,
        403,
        {
          Host: 'attacker.example',
        }
      )
    } finally {
      await server.close()
    }
  })

  testWithRealPty('applies resize requests sent over the control socket', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-resize-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)

    const agentManager = createAgentManager()
    const resizeSpy = vi.spyOn(agentManager, 'resizeRun')
    const store = createRuntimeStore({ agentManager })
    const app = createApp({ store })
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = app.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to an inet port')
    }
    const baseUrl = `http://127.0.0.1:${address.port}`

    try {
      const cookie = await getUiCookie(baseUrl)
      const workspace = await createWorkspace(baseUrl, cookie, workspacePath)
      const worker = await createWorker(baseUrl, cookie, workspace.id)
      await configureAgent(store, workspace.id, worker.id, '/bin/bash', [
        '-lc',
        "trap 'stty size' WINCH; echo ready; while true; do sleep 1; done",
      ])
      const run = await startAgent(store, baseUrl, workspace.id, worker.id)
      const control = await openSocket(
        toWsUrl(baseUrl, `/ws/terminal/${run.runId}/control`),
        cookie
      )
      control.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))

      await waitFor(() => {
        expect(resizeSpy).toHaveBeenCalledWith(run.runId, 120, 40)
      })

      control.close()
    } finally {
      await store.close()
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
    }
  })

  testWithRealPty('control socket receives an exit event when the PTY exits', async () => {
    const workspacePath = join(tmpdir(), `hive-terminal-exit-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(workspacePath)
    const script = join(workspacePath, 'exit.js')
    writeFileSync(script, 'setTimeout(() => process.exit(0), 20)\n')

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
      const worker = await createWorker(server.baseUrl, cookie, workspace.id)
      await configureAgent(server.store, workspace.id, worker.id, process.execPath, [script])
      const run = await startAgent(server.store, server.baseUrl, workspace.id, worker.id)
      const control = await openSocket(
        toWsUrl(server.baseUrl, `/ws/terminal/${run.runId}/control`),
        cookie
      )
      const messages: Array<{ code: number | null; type: string }> = []

      control.on('message', (chunk) => {
        messages.push(JSON.parse(chunk.toString()) as { code: number | null; type: string })
      })

      await waitFor(() => {
        expect(messages).toContainEqual({ type: 'exit', code: 0 })
      })

      control.close()
    } finally {
      await server.close()
    }
  })

  testWithRealPty(
    'workspace shell control socket receives an exit event when the shell exits',
    async () => {
      const workspacePath = join(tmpdir(), `hive-terminal-shell-exit-${Date.now()}`)
      mkdirSync(workspacePath, { recursive: true })
      tempDirs.push(workspacePath)
      const fakeShell = join(workspacePath, 'fake-shell')
      writeFileSync(
        fakeShell,
        [
          '#!/usr/bin/env node',
          "process.stdout.write('shell ready\\n')",
          'setTimeout(() => process.exit(0), 150)',
        ].join('\n')
      )
      chmodSync(fakeShell, 0o755)
      setEnv('SHELL', fakeShell)

      const server = await startTestServer()
      try {
        const cookie = await getUiCookie(server.baseUrl)
        const workspace = await createWorkspace(server.baseUrl, cookie, workspacePath)
        const startResponse = await fetch(
          `${server.baseUrl}/api/workspaces/${workspace.id}/shell/start`,
          { method: 'POST', headers: { cookie } }
        )
        expect(startResponse.status).toBe(201)
        const shell = (await startResponse.json()) as { run_id: string }
        const control = await openSocket(
          toWsUrl(server.baseUrl, `/ws/terminal/${shell.run_id}/control`),
          cookie
        )
        const messages: Array<{ code: number | null; type: string }> = []

        control.on('message', (chunk) => {
          messages.push(JSON.parse(chunk.toString()) as { code: number | null; type: string })
        })

        await waitFor(() => {
          expect(messages).toContainEqual({ type: 'exit', code: 0 })
        })

        control.close()
      } finally {
        await server.close()
      }
    }
  )
})
