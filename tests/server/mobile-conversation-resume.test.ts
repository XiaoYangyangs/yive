import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const temporaryDirectories: string[] = []
const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 })
  }
})

const waitForConversation = async <T>(
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

describe('mobile conversation resume binding', () => {
  test('observes desktop and agent turns from the explicitly resumed Codex session', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'yive-mobile-conversation-resume-'))
    temporaryDirectories.push(dataDir)
    const workspacePath = process.cwd()
    const codexHome = join(dataDir, 'codex-home')
    const sessionDirectory = join(codexHome, 'sessions', '2026', '07', '19')
    mkdirSync(sessionDirectory, { recursive: true })
    process.env.CODEX_HOME = codexHome

    const passiveScript = join(dataDir, 'passive.cjs')
    writeFileSync(passiveScript, 'process.stdin.resume(); setInterval(() => {}, 1000);\n')

    const initialServer = await startTestServer({ dataDir })
    const workspace = initialServer.store.createWorkspace(workspacePath, 'Resume Conversation')
    const worker = initialServer.store.addWorker(workspace.id, { name: 'Codex' })
    initialServer.store.configureAgentLaunch(workspace.id, worker.id, {
      args: [passiveScript],
      command: process.execPath,
      provider: 'codex',
      resumeArgsTemplate: '--title={session_id}',
      sessionIdCapture: {
        pattern: '~/.codex/sessions/**/*.jsonl',
        source: 'codex_session_jsonl_dir',
      },
    })
    await initialServer.close()

    const staleSessionId = '11111111-1111-4111-8111-111111111111'
    const resumedSessionId = '22222222-2222-4222-8222-222222222222'
    const staleSessionFile = join(
      sessionDirectory,
      `rollout-2026-07-10T00-00-00-${staleSessionId}.jsonl`
    )
    const resumedSessionFile = join(
      sessionDirectory,
      `rollout-2026-07-19T00-00-00-${resumedSessionId}.jsonl`
    )
    const bindingMarker = `Hive session binding: workspace_id=${workspace.id}; agent_id=${worker.id}`
    writeFileSync(
      staleSessionFile,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspacePath, id: staleSessionId } })}\n${JSON.stringify({ id: 'stale-marker', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: bindingMarker }] } })}\n`
    )
    writeFileSync(
      resumedSessionFile,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspacePath, id: resumedSessionId } })}\n`
    )

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.transaction(() => {
      db.prepare(
        `INSERT INTO agent_sessions (agent_id, workspace_id, provider, last_session_id, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(worker.id, workspace.id, 'codex', resumedSessionId, Date.now())
      db.prepare('UPDATE workers SET last_session_id = ? WHERE id = ? AND workspace_id = ?').run(
        resumedSessionId,
        worker.id,
        workspace.id
      )
    })()
    db.close()

    const server = await startTestServer({ dataDir })
    let run: Awaited<ReturnType<typeof server.store.startAgent>> | undefined
    try {
      const cookie = await getUiCookie(server.baseUrl)
      run = await server.store.startAgent(workspace.id, worker.id, {
        hivePort: new URL(server.baseUrl).port,
        suppressStartupInstructions: true,
      })
      appendFileSync(
        resumedSessionFile,
        `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
      )
      const url = `${server.baseUrl}/api/mobile/agents/${encodeURIComponent(worker.id)}/conversation?workspace_id=${encodeURIComponent(workspace.id)}`
      await expect(
        waitForConversation<{ cli_session_id: string; turns: unknown[] }>(
          url,
          cookie,
          (conversation) => conversation.cli_session_id === resumedSessionId
        )
      ).resolves.toMatchObject({ cli_session_id: resumedSessionId, turns: [] })

      appendFileSync(
        resumedSessionFile,
        `${JSON.stringify({ id: 'desktop-user', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'desktop question' }] } })}\n${JSON.stringify({ id: 'agent-reply', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'agent answer' }] } })}\n`
      )

      await expect(
        waitForConversation<{
          cli_session_id: string
          turns: Array<{ provider_event_id: string; role: string; text: string }>
        }>(url, cookie, (conversation) => conversation.turns.length === 2)
      ).resolves.toMatchObject({
        cli_session_id: resumedSessionId,
        turns: [
          { provider_event_id: 'desktop-user', role: 'user', text: 'desktop question' },
          { provider_event_id: 'agent-reply', role: 'assistant', text: 'agent answer' },
        ],
      })
    } finally {
      if (run) {
        server.store.stopAgentRun(run.runId)
        await expect
          .poll(() => server.store.getLiveRun(run.runId).status, { timeout: 5_000 })
          .toBe('exited')
      }
      await server.close()
    }
  })
})
