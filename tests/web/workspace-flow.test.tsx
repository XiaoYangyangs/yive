// @vitest-environment jsdom

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { seedOrchestratorLaunchConfig } from '../../src/server/orchestrator-launch.js'
import { App } from '../../web/src/app.js'
import {
  type ProviderAdapterFixture,
  writeProviderAdapterFixture,
} from '../helpers/provider-adapter-fixture.js'
import { startTestServer } from '../helpers/test-server.js'

let cleanupServer: (() => Promise<void>) | undefined
let serverContext: Awaited<ReturnType<typeof startTestServer>> | undefined
let sandboxRoot = ''
let providerFixture: ProviderAdapterFixture | undefined
const nativeFetch = globalThis.fetch
const originalPath = process.env.PATH
const tempDirs: string[] = []

beforeEach(async () => {
  window.localStorage.setItem('hive.first-run-seen', '1')
  sandboxRoot = mkdtempSync(join(tmpdir(), 'hive-fs-sandbox-'))
  mkdirSync(join(sandboxRoot, 'alpha-project'), { recursive: true })
  tempDirs.push(sandboxRoot)
  process.env.HIVE_FS_BROWSE_ROOT = sandboxRoot
  providerFixture = writeProviderAdapterFixture({
    provider: 'codex',
    root: sandboxRoot,
    workspacePath: join(sandboxRoot, 'alpha-project'),
  })
  process.env.PATH = [dirname(providerFixture.command), originalPath]
    .filter(Boolean)
    .join(delimiter)
  const server = await startTestServer({
    pickFolderPath: join(sandboxRoot, 'alpha-project'),
  })
  serverContext = server
  cleanupServer = server.close
  let cookie = ''
  await nativeFetch(`${server.baseUrl}/api/ui/session`).then((response) => {
    cookie = response.headers.get('set-cookie') ?? ''
  })
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const value =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = value.startsWith('http') ? value : `${server.baseUrl}${value}`
    const headers = new Headers(init?.headers)
    headers.set('cookie', cookie)
    return nativeFetch(url, { ...init, headers })
  })
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await cleanupServer?.()
  cleanupServer = undefined
  serverContext = undefined
  delete process.env.HIVE_FS_BROWSE_ROOT
  process.env.PATH = originalPath
  providerFixture = undefined
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('workspace flow with real server', () => {
  test('Add Workspace native-picker flow: compact confirm → create → sidebar + sub-header', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('No Workspaces')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'New Workspace' }))

    // User-triggered pick-folder → mock returns the sandbox dir → compact confirm opens.
    const confirm = await screen.findByTestId('confirm-workspace-dialog')
    expect(within(confirm).getByTestId('confirm-workspace-path')).toHaveValue(
      join(sandboxRoot, 'alpha-project')
    )
    fireEvent.change(within(confirm).getByTestId('confirm-workspace-name'), {
      target: { value: 'Alpha' },
    })
    fireEvent.click(within(confirm).getByTestId('workspace-provider'))
    fireEvent.click(within(confirm).getByTestId('workspace-provider-option-codex'))
    fireEvent.click(within(confirm).getByTestId('confirm-workspace-create'))

    await waitFor(
      () => {
        expect(
          screen
            .getAllByRole('button', { name: 'Alpha' })
            .find((b) => b.classList.contains('ws-row'))
        ).toHaveAttribute('aria-current', 'true')
      },
      { timeout: 10_000 }
    )

    // Workspace name + path live in the sidebar (workspace row); the canvas
    // sub-header was removed in M6-A polish. Assert the orchestrator slot
    // mounted as the canonical "workspace canvas is loaded" signal.
    expect(screen.getByTestId('orchestrator-terminal-slot')).toBeInTheDocument()
    // After autostart the pane should land in the running state — PTY slot
    // mounted, idle/failed bodies absent. Stop/Restart actions are no longer
    // surfaced inline (M6-B palette will own them); the only running-state
    // signal is the data-pty-slot element. Polling is 500ms; allow time.
    await waitFor(
      () => {
        expect(document.querySelector('[data-pty-slot="orchestrator"]')).not.toBeNull()
      },
      { timeout: 10_000 }
    )
    expect(screen.queryByTestId('orchestrator-starting-body')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()
    const workspace = serverContext?.store.listWorkspaces()[0]
    if (!workspace) throw new Error('Expected created workspace')
    await waitFor(() => {
      const orchestratorRuns = serverContext?.store
        .listTerminalRuns(workspace.id)
        .filter((item) => item.agent_id.endsWith(':orchestrator'))
      expect(orchestratorRuns).toHaveLength(1)
      expect(
        providerFixture?.readEvents().some((event) => event.kind === 'launch_invocation')
      ).toBe(true)
    })
    // 0 workers in a fresh workspace → EmptyState (no worker-grid until ≥1).
    expect(screen.getByTestId('add-worker-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('topbar-blueprint')).toBeNull()
    expect(screen.queryByTestId('task-graph-drawer')).toBeNull()
  }, 20_000)

  test('existing workspace stays stopped until the user starts Queen', async () => {
    const existingPath = join(sandboxRoot, 'existing-project')
    mkdirSync(existingPath, { recursive: true })
    const existing = serverContext?.store.createWorkspace(existingPath, 'Existing')
    if (!serverContext || !existing) throw new Error('Expected test server')
    seedOrchestratorLaunchConfig(serverContext.store, existing.id, 'codex')

    render(<App />)

    await waitFor(
      () => {
        expect(
          screen
            .getAllByRole('button', { name: 'Existing' })
            .find((b) => b.classList.contains('ws-row'))
        ).toHaveAttribute('aria-current', 'true')
      },
      { timeout: 10_000 }
    )

    expect(screen.getByTestId('orchestrator-start')).toHaveTextContent('Start Orchestrator')
    expect(screen.queryByText('Orchestrator is offline')).toBeNull()
    expect(document.querySelector('[data-pty-slot="orchestrator"]')).toBeNull()
    expect(serverContext.store.listTerminalRuns(existing.id)).toEqual([])
    expect(screen.queryByTestId('orchestrator-starting-body')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()
  }, 20_000)
})
