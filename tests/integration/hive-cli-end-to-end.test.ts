import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

const tempDirs: string[] = []
const tsxImportUrl = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('hive cli end to end', () => {
  test('prints a friendly message when the requested port is already in use', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'yive-port-in-use-'))
    tempDirs.push(dataDir)
    const occupiedServer = createServer()
    await new Promise<void>((resolve) => occupiedServer.listen(0, '127.0.0.1', () => resolve()))
    const address = occupiedServer.address()
    if (!address || typeof address === 'string') throw new Error('occupied server did not bind')

    const modulePath = fileURLToPath(new URL('../../src/cli/hive.ts', import.meta.url))
    const { spawn } = await import('node:child_process')
    const child = spawn(
      process.execPath,
      ['--import', tsxImportUrl, modulePath, '--port', String(address.port)],
      {
        env: { ...process.env, HIVE_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    try {
      const exitCode = await new Promise<number | null>((resolve) => child.once('exit', resolve))
      expect(exitCode).toBe(1)
      expect(stderr).toContain(
        `Yive could not start because port ${address.port} is already in use.`
      )
      expect(stderr).toContain(`yive --port ${address.port + 1}`)
      expect(stderr).not.toContain('at Server.setupListenHandle')
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupiedServer.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})
