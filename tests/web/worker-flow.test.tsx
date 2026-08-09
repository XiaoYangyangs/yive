// @vitest-environment jsdom

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { writeProviderAdapterFixture } from '../helpers/provider-adapter-fixture.js'
import { startTestServer } from '../helpers/test-server.js'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    unicode = { activeVersion: '' }
    dispose() {}
    loadAddon() {}
    onData() {
      return { dispose() {} }
    }
    open() {}
    write(_chunk?: string, callback?: () => void) {
      callback?.()
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    dispose() {}
    fit() {}
  },
}))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    dispose() {}
    onContextLoss() {}
  },
}))
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

const nativeFetch = globalThis.fetch
let server: Awaited<ReturnType<typeof startTestServer>> | undefined
let workspaceId = ''
let uiCookie = ''
let originalPath: string | undefined
let originalCodexHome: string | undefined
let originalClaudeProjectsDir: string | undefined
let tempRoot: string | undefined

const WORKER_FLOW_TIMEOUT_MS = 5000

const fetchThroughServer = (input: RequestInfo | URL, init?: RequestInit) => {
  const value =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const url = value.startsWith('http') ? value : `${server?.baseUrl}${value}`
  const headers = new Headers(init?.headers)
  headers.set('cookie', uiCookie)
  return nativeFetch(url, { ...init, headers })
}

const openAddWorkerDialog = async () => {
  fireEvent.click(
    await screen.findByTestId('add-worker-trigger', {}, { timeout: WORKER_FLOW_TIMEOUT_MS })
  )
  return screen.findByRole('form', { name: 'Add team member' })
}

beforeEach(async () => {
  window.localStorage.clear()
  window.matchMedia =
    window.matchMedia ??
    ((query: string) =>
      ({
        addEventListener: () => {},
        addListener: () => {},
        dispatchEvent: () => false,
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: () => {},
        removeListener: () => {},
      }) as MediaQueryList)

  tempRoot = mkdtempSync(join(tmpdir(), 'yive-worker-flow-'))
  const workspacePath = join(tempRoot, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  const codexFixture = writeProviderAdapterFixture({
    fixtureId: 'codex-ui',
    provider: 'codex',
    root: tempRoot,
    workspacePath,
  })
  const claudeFixture = writeProviderAdapterFixture({
    fixtureId: 'claude-ui',
    provider: 'claude',
    root: tempRoot,
    workspacePath,
  })
  originalPath = process.env.PATH
  originalCodexHome = process.env.CODEX_HOME
  originalClaudeProjectsDir = process.env.HIVE_CLAUDE_PROJECTS_DIR
  process.env.PATH = [
    dirname(codexFixture.command),
    dirname(claudeFixture.command),
    originalPath ?? '',
  ].join(delimiter)
  process.env.CODEX_HOME = join(tempRoot, 'codex-home')
  process.env.HIVE_CLAUDE_PROJECTS_DIR = join(tempRoot, 'claude-projects')

  server = await startTestServer({ dataDir: join(tempRoot, 'data') })
  const sessionResponse = await nativeFetch(`${server.baseUrl}/api/ui/session`)
  uiCookie = sessionResponse.headers.get('set-cookie') ?? ''
  const workspaceResponse = await nativeFetch(`${server.baseUrl}/api/workspaces`, {
    body: JSON.stringify({
      autostart_orchestrator: false,
      name: 'Alpha',
      path: workspacePath,
      provider: 'codex',
    }),
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    method: 'POST',
  })
  workspaceId = ((await workspaceResponse.json()) as { id: string }).id
  vi.stubGlobal('fetch', fetchThroughServer)
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  if (originalClaudeProjectsDir === undefined) delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  else process.env.HIVE_CLAUDE_PROJECTS_DIR = originalClaudeProjectsDir
  await server?.close()
  if (tempRoot) rmSync(tempRoot, { force: true, recursive: true })
  server = undefined
  workspaceId = ''
  uiCookie = ''
  originalPath = undefined
  originalCodexHome = undefined
  originalClaudeProjectsDir = undefined
  tempRoot = undefined
})

describe('worker flow with real server', () => {
  test('creates a flat cross-Provider Worker card through the Provider-only dialog', async () => {
    render(<App />)

    const dialog = await openAddWorkerDialog()
    expect(within(dialog).getByTestId('agent-radio-inherit')).toBeInTheDocument()
    expect(within(dialog).getByTestId('agent-radio-codex')).toBeInTheDocument()
    expect(within(dialog).getByTestId('agent-radio-claude')).toBeInTheDocument()
    expect(within(dialog).queryByTestId('agent-radio-generic')).toBeNull()
    expect(within(dialog).queryByText(/startup command/i)).toBeNull()

    fireEvent.change(within(dialog).getByPlaceholderText('e.g. Alice'), {
      target: { value: 'Alice' },
    })
    fireEvent.click(within(dialog).getByTestId('agent-radio-claude'))
    fireEvent.click(within(dialog).getByTestId('add-worker-submit'))

    await waitFor(
      () => {
        expect(screen.queryByRole('form', { name: 'Add team member' })).toBeNull()
      },
      { timeout: WORKER_FLOW_TIMEOUT_MS }
    )
    const card = await screen.findByRole(
      'button',
      { name: /^Open Alice$/ },
      { timeout: WORKER_FLOW_TIMEOUT_MS }
    )
    expect(within(card).getByText('Alice')).toBeInTheDocument()
    expect(within(card).getByText('claude')).toBeInTheDocument()
    expect(within(card).getByText('idle')).toBeInTheDocument()

    const worker = server?.store
      .getWorkspaceSnapshot(workspaceId)
      .agents.find((agent) => agent.name === 'Alice')
    expect(worker).toMatchObject({ kind: 'worker', name: 'Alice' })
    expect(server?.store.peekAgentLaunchConfig(workspaceId, worker?.id ?? '')).toMatchObject({
      command: 'claude',
      provider: 'claude',
    })
  })

  test('creates an inherited Provider Worker without permanent Role fields', async () => {
    render(<App />)

    const dialog = await openAddWorkerDialog()
    expect(within(dialog).queryByLabelText('Role instructions')).toBeNull()
    expect(within(dialog).queryByTestId('role-card-coder')).toBeNull()
    fireEvent.change(within(dialog).getByPlaceholderText('e.g. Alice'), {
      target: { value: 'FlatWorker' },
    })
    fireEvent.click(within(dialog).getByTestId('add-worker-submit'))

    await waitFor(
      () => {
        expect(screen.queryByRole('form', { name: 'Add team member' })).toBeNull()
      },
      { timeout: WORKER_FLOW_TIMEOUT_MS }
    )
    const worker = server?.store
      .getWorkspaceSnapshot(workspaceId)
      .agents.find((agent) => agent.name === 'FlatWorker')
    expect(worker).toMatchObject({ kind: 'worker', name: 'FlatWorker' })
    expect(worker).not.toHaveProperty('role')
    expect(worker).not.toHaveProperty('description')
    expect(server?.store.peekAgentLaunchConfig(workspaceId, worker?.id ?? '')).toMatchObject({
      provider: 'codex',
    })
  })
})
