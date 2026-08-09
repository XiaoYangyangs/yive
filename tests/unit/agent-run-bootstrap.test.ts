import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { buildAgentRunBootstrap } from '../../src/server/agent-run-bootstrap.js'
import type { AgentSessionStore } from '../../src/server/agent-session-store.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { ProviderCapabilityError } from '../../src/server/provider-adapter.js'

const createSessionStore = (sessionId?: string): AgentSessionStore => ({
  beginSaveIntent: () => {
    throw new Error('Unexpected save intent')
  },
  clearLastSessionId: () => {},
  clearLastSessionIdIfMatches: () => false,
  completeSaveIntent: () => undefined,
  failPendingSaveIntent: () => undefined,
  failPendingSaveIntentsForRuntimeRestart: () => 0,
  getLastSessionId: () => sessionId,
  getSaveIntent: () => undefined,
  getSessionBinding: () => (sessionId ? { provider: 'codex', savedAt: 1, sessionId } : undefined),
  saveLastSessionId: () => {},
  setLastSessionId: () => {},
})

describe('agent run bootstrap', () => {
  test('snapshots Provider checkpoints even when a preset resume id is available', () => {
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    const bootstrap = buildAgentRunBootstrap(
      {
        id: 'workspace-1',
        name: 'Workspace',
        path: '/tmp/no-such-codex-workspace',
      },
      'agent-1',
      buildManagedProviderLaunchConfig('codex'),
      createSessionStore(sessionId),
      undefined
    )

    expect(bootstrap.startConfig.resumedSessionId).toBe(sessionId)
    const args = bootstrap.startConfig.args ?? []
    expect(args.slice(0, 2)).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
    ])
    expect(args.slice(-2)).toEqual(['resume', sessionId])
    expect(args).toContain('shell_environment_policy.inherit=all')
    const includeOnlyConfig = args.find((arg) =>
      arg.startsWith('shell_environment_policy.include_only=')
    )
    expect(
      JSON.parse(
        includeOnlyConfig?.slice('shell_environment_policy.include_only='.length) ?? 'null'
      )
    ).toEqual(
      expect.arrayContaining([
        'HIVE_AGENT_ID',
        'HIVE_AGENT_TOKEN',
        'HIVE_PORT',
        'HIVE_PROJECT_ID',
        'PATH',
      ])
    )
    expect(includeOnlyConfig).not.toContain('YIVE_FEISHU_APP_SECRET')
    const pathConfig = args.find((arg) => arg.startsWith('shell_environment_policy.set.PATH='))
    expect(pathConfig).toBeDefined()
    expect(
      JSON.parse(pathConfig?.slice('shell_environment_policy.set.PATH='.length) ?? 'null')
    ).toBe(bootstrap.startEnv.PATH)
    expect(bootstrap.sessionCaptureSnapshot).toMatchObject({
      checkpoints: expect.any(Map),
      knownSessionIds: expect.any(Set),
    })
  })

  test.runIf(process.platform === 'win32')(
    'keeps a direct native Provider command compatible when preset augmentation is disabled',
    async () => {
      const fixtureDir = await mkdtemp(join(tmpdir(), 'yive-native-bootstrap-'))
      const command = join(fixtureDir, 'codex.cmd')
      try {
        await writeFile(
          command,
          [
            '@echo off',
            'if "%~1"=="debug" (',
            '  echo [{"role":"developer","content":[{"text":"Yive managed Agent contract"}]}]',
            '  exit /b 0',
            ')',
            'if "%~1"=="--help" (',
            '  echo resume',
            '  exit /b 0',
            ')',
            'exit /b 1',
          ].join('\r\n')
        )

        const bootstrap = buildAgentRunBootstrap(
          { id: 'workspace-1', name: 'Workspace', path: fixtureDir },
          'agent-1',
          { command, provider: 'codex' },
          createSessionStore(),
          undefined,
          'Yive managed Agent contract'
        )

        expect(bootstrap.startConfig.args?.slice(0, 2)).toEqual([
          '-c',
          'developer_instructions=Yive managed Agent contract',
        ])
        expect(bootstrap.startConfig.args).toContain('shell_environment_policy.inherit=all')
        expect(bootstrap.startConfig.args).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^shell_environment_policy\.include_only=/u),
            expect.stringMatching(/^shell_environment_policy\.set\.PATH=/u),
          ])
        )
      } finally {
        await rm(fixtureDir, { force: true, recursive: true })
      }
    }
  )

  test('fails closed when a custom shell wrapper cannot accept native Provider arguments', () => {
    expect(() =>
      buildAgentRunBootstrap(
        { id: 'workspace-1', name: 'Workspace', path: process.cwd() },
        'agent-1',
        {
          command: process.execPath,
          interactiveCommand: 'codex',
          provider: 'codex',
        },
        createSessionStore(),
        undefined,
        'Yive managed Agent contract'
      )
    ).toThrowError(ProviderCapabilityError)
  })
})
