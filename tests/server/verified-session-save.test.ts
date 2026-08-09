import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getMobileCookie, getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []

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
  for (const server of servers.splice(0)) await server.close()
  delete process.env.CODEX_HOME
  for (const directory of tempDirs.splice(0)) {
    await removeTempDir(directory)
  }
})

const waitFor = async (assertion: () => void, timeoutMs = 4000) => {
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

describe('verified CLI session save', () => {
  test('shares one waiting request across desktop and mobile, then saves the verified session', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'yive-verified-session-save-'))
    const workspacePath = join(dataDir, 'workspace')
    const codexHome = join(dataDir, '.codex')
    const sessionsDirectory = join(codexHome, 'sessions', '2026', '07', '22')
    tempDirs.push(dataDir)
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(sessionsDirectory, { recursive: true })
    process.env.CODEX_HOME = codexHome
    const passiveScript = join(workspacePath, 'passive.cjs')
    writeFileSync(passiveScript, 'process.stdin.resume(); setInterval(() => {}, 1000);\n')

    const initialServer = await startTestServer({ dataDir })
    const seedStore = initialServer.store
    const workspace = seedStore.createWorkspace(workspacePath, 'Workspace')
    const agent = seedStore.addWorker(workspace.id, { name: 'Alice' })
    seedStore.configureAgentLaunch(workspace.id, agent.id, {
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

    const resumedSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const marker = `Hive session binding: workspace_id=${workspace.id}; agent_id=${agent.id}`
    const writeSession = (sessionId: string) => {
      const path = join(sessionsDirectory, `rollout-${sessionId}.jsonl`)
      writeFileSync(
        path,
        `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspacePath, id: sessionId } })}\n${marker}\n`
      )
      return path
    }
    const resumedSessionPath = writeSession(resumedSessionId)

    const database = new Database(join(dataDir, 'runtime.sqlite'))
    const savedAt = Date.now()
    database
      .prepare(
        `INSERT INTO agent_sessions
           (workspace_id, agent_id, provider, last_session_id, saved_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(workspace.id, agent.id, 'codex', resumedSessionId, savedAt, savedAt)
    database
      .prepare('UPDATE workers SET last_session_id = ? WHERE workspace_id = ? AND id = ?')
      .run(resumedSessionId, workspace.id, agent.id)
    database.close()

    const server = await startTestServer({ dataDir })
    servers.push(server)
    const store = server.store
    const run = await store.startAgent(workspace.id, agent.id, {
      hivePort: '4010',
      suppressStartupInstructions: true,
    })
    const baseUrl = server.baseUrl
    const uiCookie = await getUiCookie(baseUrl)
    const mobileCookie = await getMobileCookie(baseUrl)

    const desktopResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${agent.id}/session/refresh`,
      { headers: { cookie: uiCookie }, method: 'POST' }
    )
    expect(desktopResponse.status).toBe(200)
    const desktopWaiting = (await desktopResponse.json()) as Record<string, unknown>
    expect(desktopWaiting).toMatchObject({
      failure_reason: null,
      previous_session_id: resumedSessionId,
      run_id: run.runId,
      session_id: null,
      state: 'waiting',
    })

    const mobileResponse = await fetch(`${baseUrl}/api/mobile/actions`, {
      body: JSON.stringify({
        action_id: 'bind-session-1',
        kind: 'bind_current_session',
        target: { agent_id: agent.id },
        workspace_id: workspace.id,
      }),
      headers: { 'content-type': 'application/json', cookie: mobileCookie },
      method: 'POST',
    })
    expect(mobileResponse.status).toBe(202)
    const mobileWaiting = (await mobileResponse.json()) as {
      result: Record<string, unknown>
    }
    expect(mobileWaiting.result).toMatchObject({
      agent_id: agent.id,
      request_id: desktopWaiting.request_id,
      session_id: null,
      state: 'waiting',
    })

    appendFileSync(
      resumedSessionPath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
    )
    await waitFor(() => {
      expect(store.getActiveRunByAgentId(workspace.id, agent.id)?.sessionId).toBe(resumedSessionId)
    })

    const savedResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${agent.id}/session/refresh`,
      { headers: { cookie: uiCookie }, method: 'POST' }
    )
    const saved = (await savedResponse.json()) as Record<string, unknown>
    expect(saved).toMatchObject({
      previous_session_id: resumedSessionId,
      request_id: desktopWaiting.request_id,
      session_id: resumedSessionId,
      state: 'saved',
    })

    const persistedDatabase = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    const persisted = persistedDatabase
      .prepare(
        'SELECT last_session_id, saved_at FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?'
      )
      .get(workspace.id, agent.id) as { last_session_id: string; saved_at: number | null }
    expect(persisted.last_session_id).toBe(resumedSessionId)
    expect(persisted.saved_at).not.toBeNull()
    persistedDatabase.close()

    store.stopAgentRun(run.runId)
    const desktopUnresolvedResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${agent.id}/session/refresh`,
      { headers: { cookie: uiCookie }, method: 'POST' }
    )
    await expect(desktopUnresolvedResponse.json()).resolves.toMatchObject({
      failure_reason: null,
      request_id: null,
      run_id: null,
      session_id: null,
      state: 'unresolved',
    })

    const mobileUnresolvedResponse = await fetch(`${baseUrl}/api/mobile/actions`, {
      body: JSON.stringify({
        action_id: 'bind-session-unresolved',
        kind: 'bind_current_session',
        target: { agent_id: agent.id },
        workspace_id: workspace.id,
      }),
      headers: { 'content-type': 'application/json', cookie: mobileCookie },
      method: 'POST',
    })
    await expect(mobileUnresolvedResponse.json()).resolves.toMatchObject({
      result: {
        agent_id: agent.id,
        failure_reason: null,
        request_id: null,
        run_id: null,
        session_id: null,
        state: 'unresolved',
      },
    })
  })
})
