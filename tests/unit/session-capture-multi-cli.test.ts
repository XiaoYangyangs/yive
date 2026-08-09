import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  doesCapturedSessionExist,
  snapshotSessionIdsForCapture,
} from '../../src/server/session-capture.js'
import {
  encodeClaudeProjectPath,
  findLatestClaudeSessionForAgent,
} from '../../src/server/session-capture-claude.js'
import {
  findLatestCodexSessionForAgent,
  readCodexSessionFirstLine,
  snapshotCodexAgentSessionCheckpoints,
} from '../../src/server/session-capture-codex.js'

const tempDirs: string[] = []
const originalCodexHome = process.env.CODEX_HOME

const makeTempDir = (prefix: string) => {
  const dir = join(tmpdir(), `${prefix}-${crypto.randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('multi-CLI session capture', () => {
  test('captures Codex sessions by cwd from CODEX_HOME session jsonl files', () => {
    const codexHome = makeTempDir('hive-codex-home')
    const cwd = join(codexHome, 'workspace')
    mkdirSync(cwd, { recursive: true })
    process.env.CODEX_HOME = codexHome
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    const sessionDir = join(codexHome, 'sessions', '2026', '04', '30')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, `rollout-2026-04-30T00-00-00-${sessionId}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { cwd, id: sessionId } })}\n`
    )

    const capture = {
      pattern: '~/.codex/sessions/**/*.jsonl',
      source: 'codex_session_jsonl_dir' as const,
    }

    expect(snapshotSessionIdsForCapture(cwd, capture)?.knownSessionIds).toEqual(
      new Set([sessionId])
    )
    expect(doesCapturedSessionExist(cwd, capture, sessionId)).toBe(true)
    expect(doesCapturedSessionExist(join(codexHome, 'other'), capture, sessionId)).toBe(false)
  })

  test('reads only the bounded Codex jsonl header line instead of decoding the full rollout', () => {
    const codexHome = makeTempDir('hive-codex-header')
    const filePath = join(codexHome, 'rollout-large.jsonl')
    const firstLine = JSON.stringify({
      payload: { cwd: join(codexHome, 'workspace'), id: '019dc277-0e8e-75c1-9794-94929426288e' },
      type: 'session_meta',
    })
    writeFileSync(filePath, `${firstLine}\n${'x'.repeat(256 * 1024)}`)

    expect(readCodexSessionFirstLine(filePath, firstLine.length + 8)).toBe(firstLine)
    expect(readCodexSessionFirstLine(filePath, firstLine.length - 1)).toBeNull()
  })

  test('detects the latest interactive Codex session for the same Yive agent', () => {
    const codexHome = makeTempDir('hive-codex-switch')
    const cwd = join(codexHome, 'workspace')
    const sessionDir = join(codexHome, 'sessions', '2026', '07', '11')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(sessionDir, { recursive: true })
    const writeSession = (id: string, agentId: string) =>
      writeFileSync(
        join(sessionDir, `rollout-${id}.jsonl`),
        `${JSON.stringify({ type: 'session_meta', payload: { cwd, id } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Hive session binding: workspace_id=workspace-1; agent_id=${agentId}` }] } })}\n`
      )
    writeSession('session-a', 'agent-1')
    writeSession('session-b', 'agent-1')
    writeSession('session-z', 'other-agent')

    expect(findLatestCodexSessionForAgent(cwd, 'workspace-1', 'agent-1', codexHome)).toMatchObject({
      id: 'session-b',
    })
  })

  test('ignores empty and malformed Codex rollout files while indexing agent sessions', () => {
    const codexHome = makeTempDir('hive-codex-invalid-rollouts')
    const cwd = join(codexHome, 'workspace')
    const sessionDir = join(codexHome, 'sessions', '2026', '07', '29')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'rollout-empty.jsonl'), '')
    writeFileSync(join(sessionDir, 'rollout-truncated.jsonl'), '{"type":"session_meta"')

    const sessionId = 'session-valid'
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { cwd, id: sessionId } })}\nHive session binding: workspace_id=workspace-1; agent_id=agent-1\n`
    )

    expect(snapshotCodexAgentSessionCheckpoints(cwd, 'workspace-1', 'agent-1', codexHome)).toEqual([
      expect.objectContaining({
        id: sessionId,
      }),
    ])
  })

  test('detects the latest interactive Claude session for the same Yive agent', () => {
    const projectsRoot = makeTempDir('hive-claude-switch')
    const cwd = join(projectsRoot, 'workspace')
    const projectDirectory = join(projectsRoot, encodeClaudeProjectPath(cwd))
    mkdirSync(cwd, { recursive: true })
    mkdirSync(projectDirectory, { recursive: true })
    const writeSession = (id: string, agentId: string) =>
      writeFileSync(
        join(projectDirectory, `${id}.jsonl`),
        `${JSON.stringify({ type: 'user', uuid: `turn-${id}`, message: { role: 'user', content: `Hive session binding: workspace_id=workspace-1; agent_id=${agentId}` } })}\n`
      )
    writeSession('11111111-1111-4111-8111-111111111111', 'agent-1')
    writeSession('22222222-2222-4222-8222-222222222222', 'agent-1')
    writeSession('99999999-9999-4999-8999-999999999999', 'other-agent')

    expect(
      findLatestClaudeSessionForAgent(cwd, 'workspace-1', 'agent-1', projectsRoot)
    ).toMatchObject({ id: '22222222-2222-4222-8222-222222222222' })
  })
})
