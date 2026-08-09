import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 2000,
  intervalMs = 25
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('user input stdin injection', () => {
  test('user-input endpoint injects text into orchestrator PTY stdin', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-user-input-stdin-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const orchScript = join(workspacePath, 'orch-echo.js')
    writeFileSync(
      orchScript,
      [
        "process.stdin.setEncoding('utf8')",
        'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('ORCH:' + chunk)",
        '})',
      ].join('\n')
    )

    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])

    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      hive.store.configureAgentLaunch(workspace.id, orchestratorId, {
        args: [orchScript],
        command: process.execPath,
        provider: 'codex',
      })
      const startedRun = await hive.store.startAgent(workspace.id, orchestratorId, {
        hivePort: String(hive.port),
        suppressStartupInstructions: true,
      })

      const inputResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/user-input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ text: '请继续实现登录' }),
      })

      expect(inputResponse.status).toBe(202)

      await waitFor(async () => {
        const runResponse = await fetch(`${baseUrl}/api/runtime/runs/${startedRun.runId}`, {
          headers: { cookie: uiCookie },
        })
        const run = (await runResponse.json()) as { output: string }
        expect(run.output).toContain('ORCH:请继续实现登录')
        expect(run.output).not.toContain('team context')
        expect(run.output).not.toContain('.hive/PROTOCOL.md')
      })
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }
  })

  test('non-native restart skips Runtime Context without active Team state', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-runtime-context-restart-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const echoScript = join(workspacePath, 'restart-echo.js')
    writeFileSync(
      echoScript,
      [
        "process.stdin.setEncoding('utf8')",
        'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
        "process.stdin.on('data', (chunk) => process.stdout.write('RESTART:' + chunk))",
      ].join('\n')
    )

    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])

    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      hive.store.configureAgentLaunch(workspace.id, orchestratorId, {
        args: [echoScript],
        command: process.execPath,
        provider: 'codex',
      })
      const firstRun = await hive.store.startAgent(workspace.id, orchestratorId, {
        hivePort: String(hive.port),
        suppressStartupInstructions: true,
      })
      hive.store.stopAgentRun(firstRun.runId)
      await waitFor(() => {
        expect(hive.store.getLiveRun(firstRun.runId).status).toBe('exited')
      }, 10_000)

      const restartedRun = await hive.store.startAgent(workspace.id, orchestratorId, {
        hivePort: String(hive.port),
        suppressStartupInstructions: true,
      })
      await waitFor(async () => {
        const runResponse = await fetch(`${baseUrl}/api/runtime/runs/${restartedRun.runId}`, {
          headers: { cookie: uiCookie },
        })
        const run = (await runResponse.json()) as { output: string }
        expect(hive.store.getLiveRun(restartedRun.runId).status).toBe('running')
        expect(run.output).not.toContain('Current bounded Runtime Context:')
        expect(run.output).not.toContain('"scope":"team"')
        expect(run.output.length).toBeLessThan(20_000)
        expect(run.output).not.toContain('.hive/PROTOCOL.md')
        expect(run.output).not.toContain('team send')
      })
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }
  })
})
