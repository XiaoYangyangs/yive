import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import WebSocket from 'ws'
import { encodeClaudeProjectPath } from '../../src/server/session-capture-claude.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const temporaryDirectories: string[] = []
const originalCodexHome = process.env.CODEX_HOME
const originalClaudeProjectsDir = process.env.HIVE_CLAUDE_PROJECTS_DIR

const removeTempDir = async (directory: string) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(directory, { force: true, recursive: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM' || attempt === 19) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  if (originalClaudeProjectsDir === undefined) delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  else process.env.HIVE_CLAUDE_PROJECTS_DIR = originalClaudeProjectsDir
  for (const directory of temporaryDirectories.splice(0)) {
    await removeTempDir(directory)
  }
})

const waitForConversation = async (url: string, cookie: string) => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const response = await fetch(url, { headers: { cookie } })
    if (response.status === 200) {
      const body = (await response.json()) as { conversation: unknown }
      if (body.conversation) return body
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Conversation was not observed')
}

const waitForConversationMatching = async <T>(
  url: string,
  cookie: string,
  matches: (conversation: T) => boolean
) => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const response = await fetch(url, { headers: { cookie } })
    if (response.status === 200) {
      const body = (await response.json()) as { conversation: T | null }
      if (body.conversation && matches(body.conversation)) return body.conversation
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Conversation did not reach the expected state')
}

const waitForSocketMessage = async <T>(
  socket: WebSocket,
  matches: (value: T) => boolean
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for mobile event')), 5000)
    const onMessage = (data: WebSocket.RawData) => {
      const value = JSON.parse(data.toString()) as T
      if (!matches(value)) return
      clearTimeout(timeout)
      socket.off('message', onMessage)
      resolve(value)
    }
    socket.on('message', onMessage)
  })

const expectNoSocketMessage = async <T>(
  socket: WebSocket,
  predicate: (value: T) => boolean,
  durationMs = 1_200
) =>
  new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage)
      resolve()
    }, durationMs)
    const onMessage = (data: WebSocket.RawData) => {
      const value = JSON.parse(data.toString()) as T
      if (!predicate(value)) return
      clearTimeout(timeout)
      socket.off('message', onMessage)
      reject(new Error('Received a mobile event outside the selected workspace scope'))
    }
    socket.on('message', onMessage)
  })

describe('mobile conversation api', () => {
  test('starts at the Codex observation boundary and returns only later verified turns', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'yive-mobile-conversation-'))
    temporaryDirectories.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    const codexHome = join(dataDir, 'codex-home')
    const sessionDirectory = join(codexHome, 'sessions', '2026', '07', '11')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(sessionDirectory, { recursive: true })
    process.env.CODEX_HOME = codexHome
    const passiveScript = join(workspacePath, 'passive.cjs')
    writeFileSync(passiveScript, 'process.stdin.resume(); setInterval(() => {}, 1000);\n')

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Conversation')
      const worker = server.store.addWorker(workspace.id, { name: 'Codex' })
      server.store.configureAgentLaunch(workspace.id, worker.id, {
        args: [passiveScript],
        command: process.execPath,
        provider: 'codex',
        sessionIdCapture: {
          pattern: '~/.codex/sessions/**/*.jsonl',
          source: 'codex_session_jsonl_dir',
        },
      })
      const startPromise = server.store.startAgent(workspace.id, worker.id, {
        hivePort: new URL(server.baseUrl).port,
        suppressStartupInstructions: true,
      })
      const sessionId = '11111111-1111-4111-8111-111111111111'
      const sessionFile = join(sessionDirectory, `rollout-2026-07-11T00-00-00-${sessionId}.jsonl`)
      const startupText = [
        'Yive startup',
        `Hive session binding: workspace_id=${workspace.id}; agent_id=${worker.id}`,
        'Mobile file direction: .hive/mobile-attachments.json is only the phone-uploaded attachment registry',
        'To send a generated workspace file to the phone, run yive mobile send-file',
      ].join('\n')
      writeFileSync(
        sessionFile,
        `${[
          { type: 'session_meta', payload: { cwd: workspacePath, id: sessionId } },
          {
            id: 'startup',
            type: 'response_item',
            payload: {
              content: [{ type: 'input_text', text: startupText }],
              role: 'user',
              type: 'message',
            },
          },
          {
            id: 'old',
            type: 'response_item',
            payload: {
              content: [{ type: 'input_text', text: 'old' }],
              role: 'user',
              type: 'message',
            },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n')}\n`
      )
      const run = await startPromise
      server.store.refreshAgentSessionBinding(workspace.id, worker.id)
      const url = `${server.baseUrl}/api/mobile/agents/${encodeURIComponent(worker.id)}/conversation?workspace_id=${encodeURIComponent(workspace.id)}`
      const first = (await waitForConversation(url, cookie)) as {
        conversation: { cli_session_id: string; cursor: number; id: string; turns: unknown[] }
      }
      expect(first.conversation).toMatchObject({ cli_session_id: sessionId, turns: [] })

      const eventSocket = new WebSocket(
        `${server.baseUrl.replace(/^http/u, 'ws')}/ws/mobile/events`,
        { headers: { cookie, 'x-yive-mobile-workspace-ids': workspace.id } }
      )
      await new Promise<void>((resolve, reject) => {
        eventSocket.once('open', resolve)
        eventSocket.once('error', reject)
      })
      const invalidationPromise = waitForSocketMessage<Record<string, unknown>>(
        eventSocket,
        (value) => value.type === 'conversation-invalidated'
      )
      const restrictedSocket = new WebSocket(
        `${server.baseUrl.replace(/^http/u, 'ws')}/ws/mobile/events`,
        { headers: { cookie, 'x-yive-mobile-workspace-ids': 'another-workspace' } }
      )
      await new Promise<void>((resolve, reject) => {
        restrictedSocket.once('open', resolve)
        restrictedSocket.once('error', reject)
      })
      const restrictedPromise = expectNoSocketMessage<Record<string, unknown>>(
        restrictedSocket,
        (value) => value.type === 'conversation-invalidated'
      )

      const appendedRecords = [
        {
          id: 'new-user',
          type: 'response_item',
          payload: {
            content: [{ type: 'input_text', text: 'hello' }],
            role: 'user',
            type: 'message',
          },
        },
        {
          id: 'legacy-call-record',
          timestamp: '2026-07-12T00:00:00.000Z',
          type: 'response_item',
          payload: {
            arguments: '{"command":"wait"}',
            call_id: 'legacy-call-1',
            name: 'wait',
            type: 'function_call',
          },
        },
        {
          timestamp: '2026-07-12T00:00:01.250Z',
          type: 'response_item',
          payload: {
            call_id: 'legacy-call-1',
            output: 'legacy output',
            type: 'function_call_output',
          },
        },
        {
          id: 'modern-call-record',
          timestamp: '2026-07-12T00:00:02.000Z',
          type: 'response_item',
          payload: {
            call_id: 'modern-call-1',
            id: 'modern-call-record',
            input: '{"patch":"C:/private/secret.txt"}',
            name: 'apply_patch',
            status: 'completed',
            type: 'custom_tool_call',
          },
        },
        {
          id: 'new-agent',
          type: 'response_item',
          payload: {
            content: [{ type: 'output_text', text: 'hi' }],
            role: 'assistant',
            type: 'message',
          },
        },
      ]
      appendFileSync(
        sessionFile,
        `${appendedRecords.map((record) => JSON.stringify(record)).join('\n')}\n`
      )
      const invalidation = await invalidationPromise
      await restrictedPromise
      expect(invalidation).toEqual({
        activity_state: 'busy',
        agent_id: worker.id,
        conversation_id: first.conversation.id,
        cursor: expect.any(Number),
        type: 'conversation-invalidated',
        workspace_id: workspace.id,
      })
      expect(JSON.stringify(invalidation)).not.toContain('hello')
      restrictedSocket.close()
      const persisted = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
      try {
        const deadline = Date.now() + 5000
        let turnCount = 0
        while (Date.now() < deadline) {
          turnCount = (
            persisted.prepare('SELECT COUNT(*) AS count FROM conversation_turns').get() as {
              count: number
            }
          ).count
          if (turnCount === 2) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        expect(turnCount).toBe(2)
      } finally {
        persisted.close()
      }
      const runningResponse = await fetch(`${url}&cursor=${first.conversation.cursor}`, {
        headers: { cookie },
      })
      expect(runningResponse.status).toBe(200)
      const runningResponseText = await runningResponse.text()
      expect(runningResponseText).not.toContain('private')
      const runningBody = JSON.parse(runningResponseText) as {
        conversation: {
          tool_activity: Array<{
            completed_at: number | null
            duration_ms: number | null
            label: string
            provider_event_id: string
            sequence: number
            source_checkpoint: number
            status: string
          }>
        }
      }
      const runningModernTool = runningBody.conversation.tool_activity.find(
        (tool) => tool.provider_event_id === 'modern-call-1'
      )
      expect(runningModernTool).toMatchObject({
        completed_at: null,
        duration_ms: null,
        label: 'apply_patch',
        status: 'running',
      })
      if (!runningModernTool) throw new Error('Running modern tool activity missing')

      const completionInvalidationPromise = waitForSocketMessage<Record<string, unknown>>(
        eventSocket,
        (value) => value.type === 'conversation-invalidated'
      )
      appendFileSync(
        sessionFile,
        `${JSON.stringify({
          timestamp: '2026-07-12T00:00:03.500Z',
          type: 'response_item',
          payload: {
            call_id: 'modern-call-1',
            output: 'modern secret stdout',
            type: 'custom_tool_call_output',
          },
        })}\n`
      )
      const completionInvalidation = await completionInvalidationPromise
      eventSocket.close()
      const response = await fetch(`${url}&cursor=${first.conversation.cursor}`, {
        headers: { cookie },
      })
      expect(response.status).toBe(200)
      const responseText = await response.text()
      expect(responseText).not.toContain('private')
      expect(responseText).not.toContain('secret')
      const completedBody = JSON.parse(responseText) as {
        conversation: {
          cursor: number
          tool_activity: Array<{
            duration_ms: number | null
            label: string
            provider_event_id: string
            sequence: number
            source_checkpoint: number
            status: string
          }>
          turns: unknown[]
        }
      }
      expect(completedBody).toMatchObject({
        conversation: {
          cursor: completionInvalidation.cursor,
          tool_activity: [
            {
              duration_ms: 1_250,
              label: 'wait',
              provider_event_id: 'legacy-call-1',
              status: 'completed',
            },
            {
              duration_ms: 1_500,
              label: 'apply_patch',
              provider_event_id: 'modern-call-1',
              status: 'completed',
            },
          ],
          turns: [
            { provider_event_id: 'new-user', role: 'user', text: 'hello' },
            { provider_event_id: 'new-agent', role: 'assistant', text: 'hi' },
          ],
        },
      })
      const completedModernTools = completedBody.conversation.tool_activity.filter(
        (tool) => tool.provider_event_id === 'modern-call-1'
      )
      expect(completedModernTools).toHaveLength(1)
      expect(completedModernTools[0]?.sequence).toBe(runningModernTool.sequence)
      expect(completedModernTools[0]?.source_checkpoint).toBeGreaterThan(
        runningModernTool.source_checkpoint
      )
      renameSync(sessionFile, `${sessionFile}.missing`)
      const staleResponse = await fetch(url, { headers: { cookie } })
      expect(staleResponse.status).toBe(200)
      await expect(staleResponse.json()).resolves.toMatchObject({
        conversation: {
          stale: true,
          turns: [{ provider_event_id: 'new-user' }, { provider_event_id: 'new-agent' }],
        },
      })
      renameSync(`${sessionFile}.missing`, sessionFile)
      server.store.stopAgentRun(run.runId)
      await expect
        .poll(() => server.store.getLiveRun(run.runId).status, { timeout: 5_000 })
        .toBe('exited')

      const switchedStartPromise = server.store.startAgent(workspace.id, worker.id, {
        hivePort: new URL(server.baseUrl).port,
        suppressStartupInstructions: true,
      })
      const switchedRun = await switchedStartPromise
      appendFileSync(
        sessionFile,
        `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
      )
      server.store.refreshAgentSessionBinding(workspace.id, worker.id)
      await expect
        .poll(() => server.store.getLiveRun(switchedRun.runId).sessionId, { timeout: 5_000 })
        .toBe(sessionId)
      await expect(
        waitForConversationMatching<{ cli_session_id: string }>(
          url,
          cookie,
          (conversation) => conversation.cli_session_id === sessionId
        )
      ).resolves.toMatchObject({ cli_session_id: sessionId })
      server.store.stopAgentRun(switchedRun.runId)
      await expect
        .poll(() => server.store.getLiveRun(switchedRun.runId).status, { timeout: 5_000 })
        .toBe('exited')
    } finally {
      await server.close()
    }
  })

  test('projects an active Claude session through the same current conversation endpoint', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'yive-mobile-claude-conversation-'))
    temporaryDirectories.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    const projectsRoot = join(dataDir, 'claude-projects')
    const projectDirectory = join(projectsRoot, encodeClaudeProjectPath(workspacePath))
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(projectDirectory, { recursive: true })
    process.env.HIVE_CLAUDE_PROJECTS_DIR = projectsRoot
    const passiveScript = join(workspacePath, 'passive-claude.cjs')
    writeFileSync(passiveScript, 'process.stdin.resume(); setInterval(() => {}, 1000);\n')

    let server = await startTestServer({ dataDir })
    let serverIsOpen = true
    try {
      let cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Claude Conversation')
      const worker = server.store.addWorker(workspace.id, { name: 'Claude' })
      server.store.configureAgentLaunch(workspace.id, worker.id, {
        args: [passiveScript],
        command: process.execPath,
        provider: 'claude',
        sessionIdCapture: {
          pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
          source: 'claude_project_jsonl_dir',
        },
      })
      const startPromise = server.store.startAgent(workspace.id, worker.id, {
        hivePort: new URL(server.baseUrl).port,
        suppressStartupInstructions: true,
      })
      const sessionId = '22222222-2222-4222-8222-222222222222'
      const sessionFile = join(projectDirectory, `${sessionId}.jsonl`)
      const startupText = [
        'Yive startup',
        `Hive session binding: workspace_id=${workspace.id}; agent_id=${worker.id}`,
        'Mobile file direction: .hive/mobile-attachments.json is only the phone-uploaded attachment registry',
        'To send a generated workspace file to the phone, run yive mobile send-file',
      ].join('\n')
      writeFileSync(
        sessionFile,
        `${JSON.stringify({ type: 'user', uuid: 'startup', message: { role: 'user', content: startupText } })}\n${JSON.stringify({ type: 'assistant', uuid: 'old-agent', message: { id: 'old-message', role: 'assistant', content: [{ type: 'text', text: 'old answer' }] } })}\n`
      )
      const run = await startPromise
      server.store.refreshAgentSessionBinding(workspace.id, worker.id)
      const url = `${server.baseUrl}/api/mobile/agents/${encodeURIComponent(worker.id)}/conversation?workspace_id=${encodeURIComponent(workspace.id)}`
      const first = (await waitForConversation(url, cookie)) as {
        conversation: { cli_session_id: string; provider: string; turns: unknown[] }
      }
      expect(first.conversation).toMatchObject({
        cli_session_id: sessionId,
        provider: 'claude',
        turns: [],
      })

      appendFileSync(
        sessionFile,
        `${JSON.stringify({ type: 'user', uuid: 'claude-user', message: { role: 'user', content: 'hello Claude' } })}\n${JSON.stringify(
          {
            type: 'assistant',
            uuid: 'claude-agent',
            message: {
              id: 'claude-message',
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'secret' },
                { type: 'text', text: 'hello from Claude' },
                { type: 'tool_use', name: 'Read', input: { file_path: 'C:/private' } },
              ],
            },
          }
        )}\n`
      )
      const persisted = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
      try {
        const deadline = Date.now() + 5000
        let turnCount = 0
        while (Date.now() < deadline) {
          turnCount = (
            persisted.prepare('SELECT COUNT(*) AS count FROM conversation_turns').get() as {
              count: number
            }
          ).count
          if (turnCount === 2) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        expect(turnCount).toBe(2)
      } finally {
        persisted.close()
      }
      const response = await fetch(url, { headers: { cookie } })
      expect(response.status).toBe(200)
      const bodyText = await response.text()
      expect(bodyText).not.toContain('C:/private')
      expect(JSON.parse(bodyText)).toMatchObject({
        conversation: {
          provider: 'claude',
          turns: [
            { provider_event_id: 'claude-user', role: 'user', text: 'hello Claude' },
            {
              provider_event_id: 'claude-message',
              role: 'assistant',
              text: 'hello from Claude',
            },
          ],
        },
      })
      renameSync(sessionFile, `${sessionFile}.missing`)
      await expect(
        waitForConversationMatching<{
          stale: boolean
          turns: Array<{ provider_event_id: string }>
        }>(url, cookie, (conversation) => conversation.stale)
      ).resolves.toMatchObject({
        stale: true,
        turns: [{ provider_event_id: 'claude-user' }, { provider_event_id: 'claude-message' }],
      })
      renameSync(`${sessionFile}.missing`, sessionFile)
      await expect(
        waitForConversationMatching<{ stale: boolean }>(
          url,
          cookie,
          (conversation) => !conversation.stale
        )
      ).resolves.toMatchObject({ stale: false })

      server.store.stopAgentRun(run.runId)
      await server.close()
      serverIsOpen = false
      server = await startTestServer({ dataDir })
      serverIsOpen = true
      cookie = await getUiCookie(server.baseUrl)
      const restartedUrl = `${server.baseUrl}/api/mobile/agents/${encodeURIComponent(worker.id)}/conversation?workspace_id=${encodeURIComponent(workspace.id)}`
      await expect(
        waitForConversationMatching<{
          cli_session_id: string
          turns: Array<{ provider_event_id: string }>
        }>(restartedUrl, cookie, (conversation) => conversation.turns.length === 2)
      ).resolves.toMatchObject({
        cli_session_id: sessionId,
        turns: [{ provider_event_id: 'claude-user' }, { provider_event_id: 'claude-message' }],
      })

      const stoppedResponse = await fetch(restartedUrl, { headers: { cookie } })
      expect(stoppedResponse.status).toBe(200)
      await expect(stoppedResponse.json()).resolves.toMatchObject({
        conversation: { cli_session_id: sessionId },
      })
      server.store.configureAgentLaunch(workspace.id, worker.id, {
        args: [passiveScript],
        command: process.execPath,
        provider: 'claude',
        resumeArgsTemplate: '--resume {session_id}',
        sessionIdCapture: {
          pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
          source: 'claude_project_jsonl_dir',
        },
      })
      const restartedRun = await server.store.startAgent(workspace.id, worker.id, {
        hivePort: new URL(server.baseUrl).port,
        suppressStartupInstructions: true,
      })
      appendFileSync(
        sessionFile,
        `${JSON.stringify({ type: 'system', subtype: 'turn_duration' })}\n`
      )
      await expect(
        waitForConversationMatching<{ cli_session_id: string; turns: unknown[] }>(
          restartedUrl,
          cookie,
          (conversation) => conversation.cli_session_id === sessionId
        )
      ).resolves.toMatchObject({ cli_session_id: sessionId })
      appendFileSync(
        sessionFile,
        `${JSON.stringify({ type: 'user', uuid: 'resumed-user', message: { role: 'user', content: 'resumed session question' } })}\n`
      )
      await expect(
        waitForConversationMatching<{
          cli_session_id: string
          turns: Array<{ provider_event_id: string }>
        }>(
          restartedUrl,
          cookie,
          (conversation) =>
            conversation.cli_session_id === sessionId && conversation.turns.length === 3
        )
      ).resolves.toMatchObject({
        cli_session_id: sessionId,
        turns: [
          { provider_event_id: 'claude-user' },
          { provider_event_id: 'claude-message' },
          { provider_event_id: 'resumed-user' },
        ],
      })
      expect(existsSync(sessionFile)).toBe(true)
      server.store.stopAgentRun(restartedRun.runId)
    } finally {
      if (serverIsOpen) await server.close()
    }
  })
})
