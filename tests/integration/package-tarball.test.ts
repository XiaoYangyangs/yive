import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, test } from 'vitest'

interface PackFile {
  path: string
}

interface PackResult {
  files: PackFile[]
  name: string
  version: string
}

const execFileAsync = promisify(execFile)

const runCommand = async (
  file: string,
  args: string[],
  options: { timeout?: number | undefined } = {}
) => {
  const result = await execFileAsync(file, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeout,
  })
  return result.stdout
}

const runNpm = (args: string[]) =>
  runCommand(
    process.platform === 'win32' ? 'cmd.exe' : 'npm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', ...args] : args
  )

describe('npm package tarball', () => {
  test('publish dry-run exposes only runtime files and the yive bin', async () => {
    expect(existsSync(join(process.cwd(), 'dist', 'src', 'cli', 'hive.js'))).toBe(true)
    expect(existsSync(join(process.cwd(), 'web', 'dist', 'index.html'))).toBe(true)

    const output = await runNpm(['pack', '--dry-run', '--json'])
    const [result] = JSON.parse(output) as PackResult[]
    const paths = result.files.map((file) => file.path)

    expect(result.name).toBe('yive')
    expect(result.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    expect(paths).toContain('dist/src/cli/hive.js')
    expect(paths).toContain('dist/src/cli/team.js')
    expect(paths).toContain('dist/bin/yive')
    expect(paths).toContain('dist/bin/yive.cmd')
    expect(paths).toContain('dist/bin/team')
    expect(paths).toContain('dist/bin/team.cmd')
    expect(paths).toContain('deploy/check-relay-config.sh')
    expect(paths).toContain('deploy/deploy-relay.sh')
    expect(paths).toContain('deploy/enable-relay-https.sh')
    expect(paths).toContain('deploy/install-nginx-relay-site.sh')
    expect(paths).toContain('deploy/install-relay-service.sh')
    expect(paths).toContain('deploy/install-windows-desktop-relay-task.ps1')
    expect(paths).toContain('deploy/nginx-yive-relay-http.conf')
    expect(paths).toContain('deploy/nginx-yive-relay-https.conf')
    expect(paths).toContain('deploy/relay.env.example')
    expect(paths).toContain('deploy/rollback-relay.sh')
    expect(paths).toContain('deploy/run-relay.sh')
    expect(paths).toContain('deploy/run-windows-desktop-relay.ps1')
    expect(paths).toContain('deploy/smoke-file-exchange-relay.mjs')
    expect(paths).toContain('deploy/smoke-mobile-events-relay.mjs')
    expect(paths).toContain('deploy/smoke-relay-all.mjs')
    expect(paths).toContain('deploy/smoke-relay.mjs')
    expect(paths).toContain('deploy/smoke-terminal-relay.mjs')
    expect(paths).toContain('deploy/assetlinks.android.example.json')
    expect(paths).toContain('deploy/check-android-release-readiness.mjs')
    expect(paths).toContain('deploy/check-domain-readiness.mjs')
    expect(paths).toContain('deploy/prepare-android-twa.mjs')
    expect(paths).toContain('deploy/print-android-cert-sha256.mjs')
    expect(paths).toContain('deploy/verify-android-twa-kit.mjs')
    expect(paths).toContain('deploy/write-android-assetlinks.mjs')
    expect(paths).toContain('deploy/windows-desktop-relay.env.example')
    expect(paths).toContain('deploy/yive-relay.service')
    expect(paths).toContain('web/dist/index.html')
    expect(paths).toContain('scripts/fix-runtime-artifacts.mjs')
    expect(paths).toContain('CHANGELOG.md')
    expect(paths).toContain('LICENSE')
    expect(paths).toContain('README.md')
    expect(paths).toContain('SECURITY.md')

    expect(paths.some((path) => path.startsWith('src/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('tests/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('web/src/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('dist/tests/'))).toBe(false)
    expect(paths.some((path) => path.endsWith('.map'))).toBe(false)
    expect(paths).not.toContain('AGENTS.md')
    expect(paths).not.toContain('CLAUDE.md')
    expect(paths).not.toContain('TODO.md')
    expect(paths).not.toContain('bin/team')
    expect(paths).not.toContain('bin/yive')
  })

  test('published tarball installs and starts the packaged runtime', async () => {
    await runCommand(process.execPath, ['scripts/pack-smoke.mjs'], { timeout: 120_000 })
  }, 120_000)
})
