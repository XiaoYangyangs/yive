import { appendFileSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  inspectAgentSessionDurability,
  snapshotAgentSessionDurabilityCandidates,
  waitForAgentSessionDurable,
} from '../../src/server/agent-session-durability.js'
import { buildAgentSessionBindingMarkerFromIds } from '../../src/server/agent-startup-instructions.js'

const tempDirs: string[] = []

afterEach(() => {
  delete process.env.CODEX_HOME
  delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  for (const directory of tempDirs.splice(0)) rmSync(directory, { force: true, recursive: true })
})

const createCodexSession = (records: unknown[]) => {
  const root = join(tmpdir(), `yive-session-durability-${crypto.randomUUID()}`)
  const workspacePath = join(root, 'workspace')
  const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const sessionDirectory = join(root, '.codex', 'sessions', '2026', '07', '21')
  const filePath = join(sessionDirectory, `rollout-test-${sessionId}.jsonl`)
  tempDirs.push(root)
  mkdirSync(workspacePath, { recursive: true })
  mkdirSync(sessionDirectory, { recursive: true })
  process.env.CODEX_HOME = join(root, '.codex')
  writeFileSync(
    filePath,
    `${[{ type: 'session_meta', payload: { cwd: workspacePath, id: sessionId } }, ...records]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`
  )
  return { filePath, sessionId, workspacePath }
}

const createClaudeSession = (records: unknown[]) => {
  const root = join(tmpdir(), `yive-claude-session-durability-${crypto.randomUUID()}`)
  const workspacePath = join(root, 'workspace')
  const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const projectsRoot = join(root, '.claude', 'projects')
  const projectDirectory = join(projectsRoot, workspacePath.replace(/[\\/:\s]/g, '-'))
  const filePath = join(projectDirectory, `${sessionId}.jsonl`)
  tempDirs.push(root)
  mkdirSync(workspacePath, { recursive: true })
  mkdirSync(projectDirectory, { recursive: true })
  process.env.HIVE_CLAUDE_PROJECTS_DIR = projectsRoot
  writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return { filePath, sessionId, workspacePath }
}

describe('Agent session durability', () => {
  test('accepts an idle Codex session written after the latest PTY input', () => {
    const fixture = createCodexSession([{ type: 'event_msg', payload: { type: 'task_complete' } }])
    const modifiedAt = Date.now()
    utimesSync(fixture.filePath, modifiedAt / 1000, modifiedAt / 1000)

    expect(
      inspectAgentSessionDurability({
        capture: { pattern: '~/.codex/sessions/**/*.jsonl', source: 'codex_session_jsonl_dir' },
        lastInputAt: modifiedAt - 10,
        sessionId: fixture.sessionId,
        workspacePath: fixture.workspacePath,
      })
    ).toMatchObject({
      checkpoint: statSync(fixture.filePath).size,
      reason: null,
      state: 'durable',
    })
  })

  test('requires a checkpoint when terminal input is newer than the provider source', () => {
    const fixture = createCodexSession([{ type: 'event_msg', payload: { type: 'task_complete' } }])

    expect(
      inspectAgentSessionDurability({
        capture: { pattern: '~/.codex/sessions/**/*.jsonl', source: 'codex_session_jsonl_dir' },
        lastInputAt: statSync(fixture.filePath).mtimeMs + 1_000,
        sessionId: fixture.sessionId,
        workspacePath: fixture.workspacePath,
      })
    ).toMatchObject({ reason: 'uncommitted_input', state: 'checkpoint_required' })
  })

  test('requires a checkpoint while the Provider turn is busy', () => {
    const fixture = createCodexSession([
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'continue' }],
        },
      },
    ])

    expect(
      inspectAgentSessionDurability({
        capture: { pattern: '~/.codex/sessions/**/*.jsonl', source: 'codex_session_jsonl_dir' },
        lastInputAt: null,
        sessionId: fixture.sessionId,
        workspacePath: fixture.workspacePath,
      })
    ).toMatchObject({ reason: 'provider_busy', state: 'checkpoint_required' })
  })

  test('waits for the same Provider source to advance to a completed boundary', async () => {
    const fixture = createCodexSession([
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'checkpoint' }],
        },
      },
    ])
    const baselineCheckpoint = statSync(fixture.filePath).size
    const lastInputAt = Date.now()
    setTimeout(() => {
      appendFileSync(
        fixture.filePath,
        `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
      )
    }, 20)

    const result = await waitForAgentSessionDurable({
      baselineCheckpoint,
      capture: { pattern: '~/.codex/sessions/**/*.jsonl', source: 'codex_session_jsonl_dir' },
      lastInputAt,
      pollIntervalMs: 10,
      sessionId: fixture.sessionId,
      timeoutMs: 500,
      workspacePath: fixture.workspacePath,
    })

    expect(result.state).toBe('durable')
    expect(result.checkpoint).toBeGreaterThan(baselineCheckpoint)
  })

  test('accepts a new completed Provider boundary when the source mtime lags the PTY input', async () => {
    const fixture = createCodexSession([{ type: 'event_msg', payload: { type: 'task_complete' } }])
    const baselineCheckpoint = statSync(fixture.filePath).size
    const lastInputAt = Date.now()
    appendFileSync(
      fixture.filePath,
      `${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'recovery checkpoint' }],
        },
      })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
    )
    utimesSync(fixture.filePath, (lastInputAt - 1_000) / 1000, (lastInputAt - 1_000) / 1000)

    const result = await waitForAgentSessionDurable({
      baselineCheckpoint,
      capture: { pattern: '~/.codex/sessions/**/*.jsonl', source: 'codex_session_jsonl_dir' },
      lastInputAt,
      pollIntervalMs: 10,
      requiredUserText: 'recovery checkpoint',
      sessionId: fixture.sessionId,
      timeoutMs: 50,
      workspacePath: fixture.workspacePath,
    })

    expect(result.state).toBe('durable')
    expect(result.checkpoint).toBeGreaterThan(baselineCheckpoint)
  })

  test('does not accept an unrelated completion before the required checkpoint message', async () => {
    const fixture = createCodexSession([{ type: 'event_msg', payload: { type: 'task_complete' } }])
    const baselineCheckpoint = statSync(fixture.filePath).size
    const lastInputAt = Date.now()
    appendFileSync(
      fixture.filePath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
    )
    utimesSync(fixture.filePath, (lastInputAt - 1_000) / 1000, (lastInputAt - 1_000) / 1000)

    await expect(
      waitForAgentSessionDurable({
        baselineCheckpoint,
        capture: { pattern: '~/.codex/sessions/**/*.jsonl', source: 'codex_session_jsonl_dir' },
        lastInputAt,
        pollIntervalMs: 10,
        requiredUserText: 'recovery checkpoint',
        sessionId: fixture.sessionId,
        timeoutMs: 30,
        workspacePath: fixture.workspacePath,
      })
    ).rejects.toThrow('Timed out waiting for CLI session checkpoint')
  })

  test('accepts a completed Claude checkpoint turn when the source mtime lags', async () => {
    const fixture = createClaudeSession([{ type: 'system', subtype: 'turn_duration' }])
    const baselineCheckpoint = statSync(fixture.filePath).size
    const lastInputAt = Date.now()
    appendFileSync(
      fixture.filePath,
      `${[
        {
          isSidechain: false,
          message: { content: 'recovery checkpoint', role: 'user' },
          type: 'user',
          uuid: 'checkpoint-user',
        },
        { type: 'system', subtype: 'turn_duration' },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`
    )
    utimesSync(fixture.filePath, (lastInputAt - 1_000) / 1000, (lastInputAt - 1_000) / 1000)

    const result = await waitForAgentSessionDurable({
      baselineCheckpoint,
      capture: {
        pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
        source: 'claude_project_jsonl_dir',
      },
      lastInputAt,
      pollIntervalMs: 10,
      requiredUserText: 'recovery checkpoint',
      sessionId: fixture.sessionId,
      timeoutMs: 50,
      workspacePath: fixture.workspacePath,
    })

    expect(result).toMatchObject({ provider: 'claude', reason: null, state: 'durable' })
  })

  test('discovers a Claude checkpoint candidate without a previously saved session id', async () => {
    const fixture = createClaudeSession([
      {
        isSidechain: false,
        message: {
          content: buildAgentSessionBindingMarkerFromIds('workspace-1', 'workspace-1:orchestrator'),
          role: 'user',
        },
        type: 'user',
        uuid: 'binding',
      },
      { type: 'system', subtype: 'turn_duration' },
    ])
    const candidates = snapshotAgentSessionDurabilityCandidates({
      agentId: 'workspace-1:orchestrator',
      capture: {
        pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
        source: 'claude_project_jsonl_dir',
      },
      workspaceId: 'workspace-1',
      workspacePath: fixture.workspacePath,
    })
    expect(candidates).toEqual([
      expect.objectContaining({ id: fixture.sessionId, filePath: fixture.filePath }),
    ])

    const baselineCheckpoint = candidates[0]?.checkpoint ?? 0
    const lastInputAt = Date.now()
    appendFileSync(
      fixture.filePath,
      `${[
        {
          isSidechain: false,
          message: { content: 'recovery checkpoint', role: 'user' },
          type: 'user',
          uuid: 'checkpoint-user',
        },
        { type: 'system', subtype: 'turn_duration' },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`
    )
    utimesSync(fixture.filePath, (lastInputAt - 1_000) / 1000, (lastInputAt - 1_000) / 1000)

    const result = await waitForAgentSessionDurable({
      agentId: 'workspace-1:orchestrator',
      baselineCheckpoint,
      candidateCheckpoints: candidates,
      capture: {
        pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
        source: 'claude_project_jsonl_dir',
      },
      lastInputAt,
      pollIntervalMs: 10,
      requiredUserText: 'recovery checkpoint',
      sessionId: '',
      timeoutMs: 200,
      workspaceId: 'workspace-1',
      workspacePath: fixture.workspacePath,
    })

    expect(result).toMatchObject({
      provider: 'claude',
      sessionId: fixture.sessionId,
      state: 'durable',
    })
    expect(result.checkpoint).toBeGreaterThan(baselineCheckpoint)
  })
})
