import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  inspectSessionVerification,
  resolvePromptReadyResumeVerification,
  snapshotSessionIdsForCapture,
  watchSessionVerification,
} from '../../src/server/session-capture.js'
import { encodeClaudeProjectPath } from '../../src/server/session-capture-claude.js'

const tempDirs: string[] = []

afterEach(() => {
  delete process.env.CODEX_HOME
  delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('Provider session verification', () => {
  test('accepts an unchanged requested Codex Session at prompt readiness but rejects a competing native Session', () => {
    const root = join(tmpdir(), `yive-codex-prompt-resume-${crypto.randomUUID()}`)
    const workspacePath = join(root, 'workspace')
    const codexHome = join(root, '.codex')
    const sessionsDirectory = join(codexHome, 'sessions', '2026', '07', '22')
    const marker = 'Agent name: Alice'
    const expectedSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    tempDirs.push(root)
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(sessionsDirectory, { recursive: true })
    process.env.CODEX_HOME = codexHome
    const expectedSessionPath = join(sessionsDirectory, `rollout-${expectedSessionId}.jsonl`)
    writeFileSync(
      expectedSessionPath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspacePath, id: expectedSessionId } })}\n${marker}\n`
    )
    const capture = {
      pattern: '~/.codex/sessions/**/*.jsonl',
      source: 'codex_session_jsonl_dir' as const,
    }
    const baseSnapshot = snapshotSessionIdsForCapture(workspacePath, capture, {
      contentIncludes: marker,
    })
    if (!baseSnapshot) throw new Error('Expected a Codex session snapshot')
    const snapshot = { ...baseSnapshot, expectedSessionId }

    expect(resolvePromptReadyResumeVerification(workspacePath, capture, snapshot)).toEqual({
      sessionId: expectedSessionId,
      state: 'verified',
    })

    const competingSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const competingSessionPath = join(sessionsDirectory, `rollout-${competingSessionId}.jsonl`)
    writeFileSync(
      competingSessionPath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspacePath, id: competingSessionId } })}\n${marker}\n${JSON.stringify({ type: 'turn_context', payload: { cwd: workspacePath } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`
    )
    expect(resolvePromptReadyResumeVerification(workspacePath, capture, snapshot)).toEqual({
      state: 'rejected',
    })

    rmSync(competingSessionPath)
    writeFileSync(
      expectedSessionPath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspacePath, id: expectedSessionId } })}\n`
    )
    expect(resolvePromptReadyResumeVerification(workspacePath, capture, snapshot)).toEqual({
      state: 'rejected',
    })
  })

  test('rejects prompt-ready resume when the expected Codex Session source disappears or changes cwd', () => {
    const root = join(tmpdir(), `yive-codex-prompt-missing-${crypto.randomUUID()}`)
    const workspacePath = join(root, 'workspace')
    const codexHome = join(root, '.codex')
    const sessionsDirectory = join(codexHome, 'sessions', '2026', '07', '22')
    const expectedSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const sessionPath = join(sessionsDirectory, `rollout-${expectedSessionId}.jsonl`)
    tempDirs.push(root)
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(sessionsDirectory, { recursive: true })
    process.env.CODEX_HOME = codexHome
    writeFileSync(
      sessionPath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspacePath, id: expectedSessionId } })}\n`
    )
    const capture = {
      pattern: '~/.codex/sessions/**/*.jsonl',
      source: 'codex_session_jsonl_dir' as const,
    }
    const baseSnapshot = snapshotSessionIdsForCapture(workspacePath, capture)
    if (!baseSnapshot) throw new Error('Expected a Codex session snapshot')
    const snapshot = { ...baseSnapshot, expectedSessionId }

    rmSync(sessionPath)
    expect(resolvePromptReadyResumeVerification(workspacePath, capture, snapshot)).toEqual({
      state: 'rejected',
    })

    writeFileSync(
      sessionPath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: join(root, 'other'), id: expectedSessionId } })}\n`
    )
    expect(resolvePromptReadyResumeVerification(workspacePath, capture, snapshot)).toEqual({
      state: 'rejected',
    })
  })

  test('verifies the only Claude session that advances after the run checkpoint', () => {
    const root = join(tmpdir(), `yive-claude-verification-${crypto.randomUUID()}`)
    const workspacePath = join(root, 'workspace')
    const projectsRoot = join(root, '.claude', 'projects')
    const projectDirectory = join(projectsRoot, encodeClaudeProjectPath(workspacePath))
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const sessionPath = join(projectDirectory, `${sessionId}.jsonl`)
    const marker = 'Hive session binding: workspace_id=workspace-1; agent_id=agent-1'
    tempDirs.push(root)
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(projectDirectory, { recursive: true })
    process.env.HIVE_CLAUDE_PROJECTS_DIR = projectsRoot
    writeFileSync(
      sessionPath,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: marker } })}\n`
    )
    const capture = {
      pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
      source: 'claude_project_jsonl_dir' as const,
    }
    const snapshot = snapshotSessionIdsForCapture(workspacePath, capture, {
      contentIncludes: marker,
    })
    if (!snapshot) throw new Error('Expected a Claude session snapshot')

    appendFileSync(sessionPath, `${JSON.stringify({ type: 'system', subtype: 'turn_duration' })}\n`)

    expect(inspectSessionVerification(workspacePath, capture, snapshot)).toEqual({
      sessionId,
      state: 'verified',
    })
  })

  test('reports ambiguity instead of choosing between two advanced Codex sessions', () => {
    const root = join(tmpdir(), `yive-codex-verification-${crypto.randomUUID()}`)
    const workspacePath = join(root, 'workspace')
    const codexHome = join(root, '.codex')
    const sessionsDirectory = join(codexHome, 'sessions', '2026', '07', '22')
    const marker = 'Hive session binding: workspace_id=workspace-1; agent_id=agent-1'
    const sessionIds = [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]
    tempDirs.push(root)
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(sessionsDirectory, { recursive: true })
    process.env.CODEX_HOME = codexHome
    const sessionPaths = sessionIds.map((sessionId) => {
      const sessionPath = join(sessionsDirectory, `rollout-${sessionId}.jsonl`)
      writeFileSync(
        sessionPath,
        `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspacePath, id: sessionId } })}\n${marker}\n`
      )
      return sessionPath
    })
    const capture = {
      pattern: '~/.codex/sessions/**/*.jsonl',
      source: 'codex_session_jsonl_dir' as const,
    }
    const snapshot = snapshotSessionIdsForCapture(workspacePath, capture, {
      contentIncludes: marker,
    })
    if (!snapshot) throw new Error('Expected a Codex session snapshot')

    for (const sessionPath of sessionPaths) {
      appendFileSync(
        sessionPath,
        `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
      )
    }

    expect(inspectSessionVerification(workspacePath, capture, snapshot)).toEqual({
      state: 'ambiguous',
    })
  })

  test('does not verify a session from malformed bytes alone', () => {
    const root = join(tmpdir(), `yive-codex-malformed-${crypto.randomUUID()}`)
    const workspacePath = join(root, 'workspace')
    const codexHome = join(root, '.codex')
    const sessionsDirectory = join(codexHome, 'sessions', '2026', '07', '22')
    const marker = 'Hive session binding: workspace_id=workspace-1; agent_id=agent-1'
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const sessionPath = join(sessionsDirectory, `rollout-${sessionId}.jsonl`)
    tempDirs.push(root)
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(sessionsDirectory, { recursive: true })
    process.env.CODEX_HOME = codexHome
    writeFileSync(
      sessionPath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspacePath, id: sessionId } })}\n${marker}\n`
    )
    const capture = {
      pattern: '~/.codex/sessions/**/*.jsonl',
      source: 'codex_session_jsonl_dir' as const,
    }
    const snapshot = snapshotSessionIdsForCapture(workspacePath, capture, {
      contentIncludes: marker,
    })
    if (!snapshot) throw new Error('Expected a Codex session snapshot')

    appendFileSync(sessionPath, 'not-json\n')

    expect(inspectSessionVerification(workspacePath, capture, snapshot)).toEqual({
      state: 'waiting',
    })
  })

  test('continues verification for a later interactive Codex session switch', async () => {
    const root = join(tmpdir(), `yive-codex-switch-${crypto.randomUUID()}`)
    const workspacePath = join(root, 'workspace')
    const codexHome = join(root, '.codex')
    const sessionsDirectory = join(codexHome, 'sessions', '2026', '07', '22')
    const marker = 'Hive session binding: workspace_id=workspace-1; agent_id=agent-1'
    const firstSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const secondSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    tempDirs.push(root)
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(sessionsDirectory, { recursive: true })
    process.env.CODEX_HOME = codexHome
    const firstSessionPath = join(sessionsDirectory, `rollout-${firstSessionId}.jsonl`)
    writeFileSync(
      firstSessionPath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspacePath, id: firstSessionId } })}\n${marker}\n`
    )
    const capture = {
      pattern: '~/.codex/sessions/**/*.jsonl',
      source: 'codex_session_jsonl_dir' as const,
    }
    const snapshot = snapshotSessionIdsForCapture(workspacePath, capture, {
      contentIncludes: marker,
    })
    if (!snapshot) throw new Error('Expected a Codex session snapshot')

    let active = true
    const verified: string[] = []
    const watching = watchSessionVerification({
      capture,
      cwd: workspacePath,
      isActive: () => active,
      onAmbiguous: () => {},
      onVerified: (sessionId) => verified.push(sessionId),
      pollIntervalMs: 5,
      snapshot,
    })
    appendFileSync(
      firstSessionPath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
    )
    await expect.poll(() => verified).toEqual([firstSessionId])

    const secondSessionPath = join(sessionsDirectory, `rollout-${secondSessionId}.jsonl`)
    writeFileSync(
      secondSessionPath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspacePath, id: secondSessionId } })}\n${marker}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
    )
    await expect.poll(() => verified, { timeout: 3000 }).toEqual([firstSessionId, secondSessionId])
    active = false
    await watching
  })
})
