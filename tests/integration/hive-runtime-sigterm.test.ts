import { execSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import { writeCrossPlatformNodeCli } from '../helpers/node-cli-fixtures.js'

const tempDirs: string[] = []
const describeUnixOnly = process.platform === 'win32' ? describe.skip : describe

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 5000,
  intervalMs = 50
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

describeUnixOnly('hive runtime SIGTERM shutdown', () => {
  test('SIGTERM exits runtime and cleans up active PTY child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-sigterm-test-'))
    const workspacePath = join(root, 'workspace')
    tempDirs.push(root)
    mkdirSync(workspacePath, { recursive: true })
    const marker = `hive-sigterm-marker-${crypto.randomUUID()}`
    const fixtureBinDir = join(root, marker, 'bin')
    mkdirSync(fixtureBinDir, { recursive: true })
    const fixtureCommand = writeCrossPlatformNodeCli(
      fixtureBinDir,
      'codex',
      `const args = process.argv.slice(2)
if (args[0] === 'debug' && args[1] === 'prompt-input') {
  const configIndex = args.indexOf('-c')
  const instruction = args[configIndex + 1]?.replace(/^developer_instructions=/, '') ?? ''
  process.stdout.write(JSON.stringify([{ role: 'developer', content: [{ text: instruction }] }]))
  process.exit(0)
}
if (args.includes('--help')) {
  process.stdout.write('resume <session-id>\\n')
  process.exit(0)
}
process.stdin.resume()
setInterval(() => {}, 1000)
`
    )

    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        '--input-type=module',
        '-e',
        "import { runHiveCommand } from './src/cli/hive.ts'; await runHiveCommand(['--port','40128']);",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HIVE_DATA_DIR: join(root, 'data'),
          PATH: [dirname(fixtureCommand), process.env.PATH].filter(Boolean).join(delimiter),
        },
        stdio: 'ignore',
      }
    )

    const baseUrl = 'http://127.0.0.1:40128'
    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/ui/session`)
      expect(response.status).toBe(200)
    })

    const cookieResponse = await fetch(`${baseUrl}/api/ui/session`)
    const cookie = cookieResponse.headers.get('set-cookie')
    if (!cookie) {
      throw new Error('Expected UI session cookie')
    }

    const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        autostart_orchestrator: false,
        name: 'Alpha',
        path: workspacePath,
        provider: 'codex',
      }),
    })
    const workspace = (await workspaceResponse.json()) as { id: string }
    const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart: true, name: 'Alice', provider: 'codex' }),
    })
    expect(workerResponse.status).toBe(201)
    await expect(workerResponse.json()).resolves.toMatchObject({ agent_start: { ok: true } })

    await waitFor(() => {
      const output = execSync(`ps aux | grep ${marker} | grep -v grep`, { encoding: 'utf8' })
      expect(output).toContain(marker)
    })

    child.kill('SIGTERM')

    await new Promise<void>((resolve, reject) => {
      child.once('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Expected exit code 0, got ${code}`))
          return
        }

        resolve()
      })
    })

    const output = execSync(`ps aux | grep ${marker} | grep -v grep || true`, { encoding: 'utf8' })
    expect(output.trim()).toBe('')
  }, 15000)
})
