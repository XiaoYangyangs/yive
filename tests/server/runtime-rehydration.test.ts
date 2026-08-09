import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []
const originalPath = process.env.PATH
const stores: Array<ReturnType<typeof createRuntimeStore>> = []
const FAKE_CLAUDE_EXIT_MS = 1_000

const waitFor = async (assertion: () => void, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastError
}

const writeFakeClaudeCli = (binDir: string) => {
  const scriptPath = join(binDir, 'fake-claude.js')
  writeFileSync(
    scriptPath,
    [
      'const args = process.argv.slice(2)',
      "if (args.includes('--help')) {",
      "  process.stdout.write('--append-system-prompt <prompt>\\n--resume <session-id>\\n')",
      '  process.exit(0)',
      '}',
      "process.stdout.write('❯ ')",
      'process.stdin.resume()',
      `setTimeout(() => process.exit(0), ${FAKE_CLAUDE_EXIT_MS})`,
    ].join('\n')
  )

  const unixCli = join(binDir, 'claude')
  writeFileSync(unixCli, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`)
  chmodSync(unixCli, 0o755)

  const winCli = join(binDir, 'claude.cmd')
  writeFileSync(winCli, `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.js" %*\r\n`)
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close()
  }
  process.env.PATH = originalPath
  delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('runtime rehydration', () => {
  test('restores workers and Dispatch state from sqlite state', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-runtime-'))
    tempDirs.push(dataDir)

    const firstStore = createRuntimeStore({ dataDir })
    stores.push(firstStore)
    const workspace = firstStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const alice = firstStore.addWorker(workspace.id, { name: 'Alice' })
    const bob = firstStore.addWorker(workspace.id, { name: 'Bob' })

    firstStore.dispatchTask(workspace.id, alice.id, 'Implement login')
    firstStore.dispatchTask(workspace.id, bob.id, 'Write tests')

    const secondStore = createRuntimeStore({ dataDir })
    stores.push(secondStore)

    expect(secondStore.listWorkers(workspace.id)).toEqual([
      {
        id: alice.id,
        kind: 'worker',
        name: 'Alice',
        activeDispatchId: null,
        conversationActivity: 'unknown',
        lastObservedAt: 0,
        processState: 'stopped',
        queuePauseReason: null,
        queuedDispatchCount: 1,
      },
      {
        id: bob.id,
        kind: 'worker',
        name: 'Bob',
        activeDispatchId: null,
        conversationActivity: 'unknown',
        lastObservedAt: 0,
        processState: 'stopped',
        queuePauseReason: null,
        queuedDispatchCount: 1,
      },
    ])
  })

  test('restores queued Dispatch count from the ledger instead of legacy message replay', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-runtime-dispatch-pending-'))
    tempDirs.push(dataDir)

    const firstStore = createRuntimeStore({ dataDir })
    stores.push(firstStore)
    const workspace = firstStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const alice = firstStore.addWorker(workspace.id, { name: 'Alice' })

    firstStore.dispatchTask(workspace.id, alice.id, 'First')
    firstStore.dispatchTask(workspace.id, alice.id, 'Second')

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.prepare(
      `INSERT INTO messages (
         workspace_id,
         worker_id,
         type,
         from_agent_id,
         to_agent_id,
         text,
         status,
         artifacts,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      workspace.id,
      alice.id,
      'report',
      alice.id,
      null,
      'legacy orphan report',
      null,
      '[]',
      Date.now()
    )
    db.close()

    const secondStore = createRuntimeStore({ dataDir })
    stores.push(secondStore)

    expect(secondStore.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        activeDispatchId: null,
        id: alice.id,
        processState: 'stopped',
        queuedDispatchCount: 2,
      })
    )
  })

  test('captures Claude session id into sqlite and reuses it on next start', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-runtime-session-'))
    const workspacePath = join(dataDir, 'workspace')
    const claudeProjectsDir = join(dataDir, 'claude-projects')
    const binDir = join(dataDir, 'bin')
    tempDirs.push(dataDir)
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    mkdirSync(join(claudeProjectsDir, '-tmp-hive-alpha'), { recursive: true })
    writeFakeClaudeCli(binDir)
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`

    const firstStore = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(firstStore)
    const workspace = firstStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = firstStore.addWorker(workspace.id, { name: 'Alice' })
    firstStore.configureAgentLaunch(
      workspace.id,
      worker.id,
      buildManagedProviderLaunchConfig('claude')
    )

    process.env.HIVE_CLAUDE_PROJECTS_DIR = claudeProjectsDir
    const sessionFile = join(
      claudeProjectsDir,
      '-tmp-hive-alpha',
      '11111111-1111-4111-8111-111111111111.jsonl'
    )
    const manager = createAgentManager()
    const startSpy = vi.spyOn(manager, 'startAgent')

    const secondStore = createRuntimeStore({ agentManager: manager, dataDir })
    stores.push(secondStore)
    secondStore.configureAgentLaunch(
      workspace.id,
      worker.id,
      buildManagedProviderLaunchConfig('claude')
    )

    const startPromise = secondStore.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    const launchedArgs = startSpy.mock.calls[0]?.[0]?.args ?? []
    const nativeInstruction = launchedArgs[launchedArgs.indexOf('--append-system-prompt') + 1]
    if (!nativeInstruction) throw new Error('Expected native Claude startup instructions')
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'system', subtype: 'system_prompt', content: nativeInstruction })}\n${JSON.stringify({ type: 'system', subtype: 'turn_duration' })}\n`
    )
    await startPromise

    let persistedSession: { last_session_id: string } | undefined
    let mirroredWorkerSession: { last_session_id: string | null } | undefined
    await waitFor(() => {
      const db = new Database(join(dataDir, 'runtime.sqlite'))
      try {
        persistedSession = db
          .prepare('SELECT last_session_id FROM agent_sessions WHERE agent_id = ?')
          .get(worker.id) as { last_session_id: string } | undefined
        mirroredWorkerSession = db
          .prepare('SELECT last_session_id FROM workers WHERE id = ?')
          .get(worker.id) as { last_session_id: string | null } | undefined
      } finally {
        db.close()
      }
      expect(persistedSession).toEqual({
        last_session_id: '11111111-1111-4111-8111-111111111111',
      })
    })

    const thirdStore = createRuntimeStore({ agentManager: manager, dataDir })
    stores.push(thirdStore)
    thirdStore.configureAgentLaunch(
      workspace.id,
      worker.id,
      buildManagedProviderLaunchConfig('claude')
    )
    await thirdStore.startAgent(workspace.id, worker.id, { hivePort: '4010' })

    const firstCallArgs = startSpy.mock.calls[0]?.[0]?.args ?? []
    const secondCallArgs = startSpy.mock.calls[1]?.[0]?.args ?? []
    expect(firstCallArgs).toEqual(
      expect.arrayContaining([
        '--append-system-prompt',
        '--dangerously-skip-permissions',
        '--permission-mode=bypassPermissions',
      ])
    )
    expect(secondCallArgs).toEqual(
      expect.arrayContaining([
        '--dangerously-skip-permissions',
        '--permission-mode=bypassPermissions',
        '--resume',
        '11111111-1111-4111-8111-111111111111',
      ])
    )
    expect(secondCallArgs).not.toContain('--append-system-prompt')
    const firstInstruction = firstCallArgs[firstCallArgs.indexOf('--append-system-prompt') + 1]
    expect(firstInstruction).toContain('Agent name: Alice')
    expect(firstInstruction).toContain('Agent kind: Worker')
    expect(firstCallArgs).not.toContain('--name')
    expect(secondCallArgs).not.toContain('--name')
    expect(firstCallArgs.join(' ')).not.toContain(workspace.id)
    expect(firstCallArgs.join(' ')).not.toContain(worker.id)
    expect(persistedSession).toEqual({ last_session_id: '11111111-1111-4111-8111-111111111111' })
    expect(mirroredWorkerSession).toEqual({
      last_session_id: '11111111-1111-4111-8111-111111111111',
    })

    // The fake CLI only needs to stay up long enough for spawn + session capture.
    // Let it exit naturally so Windows ConPTY cleanup does not need a forced kill.
    await new Promise((resolve) => setTimeout(resolve, FAKE_CLAUDE_EXIT_MS + 250))

    delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  })

  test('does not save a session by file recency when the agent has no active terminal run', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-runtime-session-rebind-'))
    const claudeProjectsDir = join(dataDir, 'claude-projects')
    const projectDir = join(claudeProjectsDir, '-tmp-hive-alpha')
    tempDirs.push(dataDir)
    mkdirSync(projectDir, { recursive: true })
    process.env.HIVE_CLAUDE_PROJECTS_DIR = claudeProjectsDir

    const store = createRuntimeStore({ dataDir })
    stores.push(store)
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: 'claude',
      args: [],
      provider: 'claude',
      resumeArgsTemplate: '--resume {session_id}',
      sessionIdCapture: {
        pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
        source: 'claude_project_jsonl_dir',
      },
    })

    const marker = `Hive session binding: workspace_id=${workspace.id}; agent_id=${worker.id}`
    const staleFile = join(projectDir, '11111111-1111-4111-8111-111111111111.jsonl')
    const latestFile = join(projectDir, '22222222-2222-4222-8222-222222222222.jsonl')
    const otherAgentFile = join(projectDir, '33333333-3333-4333-8333-333333333333.jsonl')
    writeFileSync(staleFile, `${JSON.stringify({ message: { content: marker } })}\n`)
    writeFileSync(latestFile, `${JSON.stringify({ message: { content: marker } })}\n`)
    writeFileSync(
      otherAgentFile,
      `${JSON.stringify({ message: { content: 'Hive session binding: other' } })}\n`
    )
    utimesSync(staleFile, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
    utimesSync(latestFile, new Date(1_700_000_100_000), new Date(1_700_000_100_000))
    utimesSync(otherAgentFile, new Date(1_700_000_200_000), new Date(1_700_000_200_000))

    expect(store.refreshAgentSessionBinding(workspace.id, worker.id)).toMatchObject({
      sessionId: null,
      state: 'unresolved',
      unchanged: true,
    })

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    const persistedSession = db
      .prepare('SELECT last_session_id FROM agent_sessions WHERE agent_id = ?')
      .get(worker.id) as { last_session_id: string } | undefined
    db.close()

    expect(persistedSession).toBeUndefined()
  })
})
