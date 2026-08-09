import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const normalizePathSeparators = (value: string) => value.replaceAll('\\', '/')

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 1500,
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('hive bin dir', () => {
  test('dummy agent can resolve team via injected HIVE_BIN_DIR on PATH', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-bin-dir-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const scriptPath = join(workspacePath, 'which-team.js')
    writeFileSync(
      scriptPath,
      "import { execSync } from 'node:child_process'\nconst lookup = process.platform === 'win32' ? 'where team' : 'which team'\nconsole.log(execSync(lookup, { encoding: 'utf8' }).trim())\nsetTimeout(() => process.exit(0), 10)\n"
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
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      hive.store.configureAgentLaunch(workspace.id, orchestratorId, {
        args: [scriptPath],
        command: process.execPath,
        provider: 'codex',
      })

      const teamResponse = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
        headers: { cookie: uiCookie },
      })
      expect(teamResponse.status).toBe(200)

      const payload = await hive.store.startAgent(workspace.id, orchestratorId, {
        hivePort: String(hive.port),
        suppressStartupInstructions: true,
      })

      await waitFor(async () => {
        const runResponse = await fetch(`${baseUrl}/api/runtime/runs/${payload.runId}`, {
          headers: { cookie: uiCookie },
        })

        expect(runResponse.status).toBe(200)
        const run = (await runResponse.json()) as {
          output: string
          runId: string
          status: string
        }
        expect(normalizePathSeparators(run.output)).toContain('/dist/bin/team')
        expect(run).toMatchObject({ runId: payload.runId, status: 'exited' })
      })

      const runResponse = await fetch(`${baseUrl}/api/runtime/runs/${payload.runId}`, {
        headers: { cookie: uiCookie },
      })

      expect(runResponse.status).toBe(200)
      const run = (await runResponse.json()) as {
        output: string
        runId: string
        status: string
      }
      expect(normalizePathSeparators(run.output)).toContain('/dist/bin/team')
      expect(run).toMatchObject({ runId: payload.runId, status: 'exited' })
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }
  })

  test('dummy agent can execute team list via injected HIVE_BIN_DIR and HIVE env', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-bin-dir-team-list-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const scriptPath = join(workspacePath, 'team-list.js')
    writeFileSync(
      scriptPath,
      [
        "import { execFileSync } from 'node:child_process'",
        "const output = execFileSync('team', ['list'], { encoding: 'utf8', shell: process.platform === 'win32' })",
        "console.log('TEAM_LIST:' + output.trim())",
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
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alice' }),
      })
      expect(workerResponse.status).toBe(201)

      hive.store.configureAgentLaunch(workspace.id, orchestratorId, {
        args: [scriptPath],
        command: process.execPath,
        provider: 'codex',
      })
      const payload = await hive.store.startAgent(workspace.id, orchestratorId, {
        hivePort: String(hive.port),
        suppressStartupInstructions: true,
      })

      await waitFor(async () => {
        const runResponse = await fetch(`${baseUrl}/api/runtime/runs/${payload.runId}`, {
          headers: { cookie: uiCookie },
        })
        expect(runResponse.status).toBe(200)
        const run = (await runResponse.json()) as { output: string; status: string }
        expect(run.status).toBe('exited')
        expect(run.output).toContain('TEAM_LIST:')
        expect(run.output).toContain('"name":"Alice"')
        expect(run.output).toContain('"queued_dispatch_count":0')
        expect(run.output).toContain('"process_state":"stopped"')
      })
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }
  })
})
