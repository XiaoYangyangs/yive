import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  getProviderAdapter,
  ProviderCapabilityError,
  type ProviderCapabilityProbe,
} from '../../src/server/provider-adapter.js'
import { runProviderCapabilityProbe } from '../../src/server/provider-command-probe.js'
import { buildYiveStartupContract } from '../../src/server/yive-startup-contract.js'

const instruction = [
  'You are Alice, a Yive Worker.',
  'Workspace root: C:\\work\\alpha',
  'Default write boundary: modify files only inside the Workspace.',
  'Authority: durable responsibility belongs to the Yive Worker assigned by the Orchestrator.',
  'Provider Subagents are turn-scoped assistance; the calling Yive Agent retains responsibility.',
  'Discovery: team --help; team context; yive agent --help.',
].join('\n')

const probe = (result: ProviderCapabilityProbe): ProviderCapabilityProbe => result
const nativeInstruction = instruction.replace(/\n/gu, ' ')

describe('native provider adapters', () => {
  test('builds only the approved model-visible startup contract', () => {
    const contract = buildYiveStartupContract({
      agent: {
        id: 'workspace-secret:worker-secret',
        kind: 'worker',
        name: 'Alice',
        pendingTaskCount: 0,
        status: 'idle',
        workspaceId: 'workspace-secret',
      },
      workspace: {
        id: 'workspace-secret',
        name: 'Alpha',
        path: 'C:\\work\\alpha',
      },
    })

    expect(contract).toContain('Agent name: Alice')
    expect(contract).toContain('Agent kind: Worker')
    expect(contract).toContain('Workspace root: C:\\work\\alpha')
    expect(contract).toContain('team --help')
    expect(contract).toContain('team context')
    expect(contract).toContain('yive agent --help')
    expect(contract).not.toMatch(
      /workspace-secret|worker-secret|session[_ -]?id|token|credential/iu
    )
    expect(contract).not.toContain('.hive/')
    expect(contract).not.toContain('team send')
    expect(contract).not.toContain('team report')
  })

  test('constructs Codex developer instructions before a durable resume command', () => {
    const adapter = getProviderAdapter('codex')
    if (!adapter) throw new Error('Codex adapter is not registered')

    const launch = adapter.prepareLaunch(
      { args: ['--no-alt-screen'], command: 'codex', resumedSessionId: 'session-1' },
      instruction
    )

    expect(launch.args).toEqual([
      '--no-alt-screen',
      '-c',
      `developer_instructions=${nativeInstruction}`,
      'resume',
      'session-1',
    ])
    expect(launch.args?.join(' ')).not.toContain('Hive session binding:')
    expect(adapter.nativeInstructionRole).toBe('developer')
    expect(adapter.sessionCapture.source).toBe('codex_session_jsonl_dir')
  })

  test('constructs Claude system prompt without a bootstrap User turn', () => {
    const adapter = getProviderAdapter('claude')
    if (!adapter) throw new Error('Claude adapter is not registered')

    const launch = adapter.prepareLaunch(
      { args: ['--resume', 'session-1'], command: 'claude', resumedSessionId: 'session-1' },
      instruction
    )

    expect(launch.args).toEqual([
      '--append-system-prompt',
      nativeInstruction,
      '--resume',
      'session-1',
    ])
    expect(adapter.nativeInstructionRole).toBe('system')
    expect(adapter.sessionCapture.source).toBe('claude_project_jsonl_dir')
  })

  test('fails closed when a native capability probe cannot prove the contract', () => {
    const adapter = getProviderAdapter('codex')
    if (!adapter) throw new Error('Codex adapter is not registered')
    const failingProbe = probe({
      status: 1,
      stderr: 'unknown option',
      stdout: '',
    })

    expect(() =>
      adapter.assertCapabilities({
        command: 'codex',
        cwd: process.cwd(),
        env: process.env,
        probe: () => failingProbe,
      })
    ).toThrowError(ProviderCapabilityError)
  })

  test.runIf(process.platform === 'win32')(
    'preserves spaced native instructions when probing a Windows command shim',
    async () => {
      const fixtureDir = await mkdtemp(join(tmpdir(), 'yive-provider-probe-'))
      const command = join(fixtureDir, 'provider.cmd')
      try {
        await writeFile(
          command,
          [
            '@echo off',
            'if "%~1"=="-c" if "%~2"=="developer_instructions=Yive managed Agent contract" (',
            '  echo supported',
            '  exit /b 0',
            ')',
            'echo unexpected argument: %* 1>&2',
            'exit /b 1',
          ].join('\r\n')
        )

        const result = runProviderCapabilityProbe({
          args: ['-c', 'developer_instructions=Yive managed Agent contract'],
          command,
          cwd: fixtureDir,
          env: process.env,
        })

        expect(result).toMatchObject({ status: 0, stderr: '', stdout: 'supported\r\n' })
      } finally {
        await rm(fixtureDir, { force: true, recursive: true })
      }
    }
  )

  test('keeps current-turn interruption semantic and distinct from Ctrl+C', () => {
    const adapter = getProviderAdapter('claude')
    if (!adapter) throw new Error('Claude adapter is not registered')
    const writes: string[] = []

    adapter.interruptCurrentTurn(
      {
        writeInput: (_runId, text) => writes.push(text),
      },
      'run-1'
    )

    expect(writes).toEqual(['\u001b'])
    expect(writes).not.toContain('\u0003')
  })
})
