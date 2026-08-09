import { once } from 'node:events'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import WebSocket from 'ws'

import {
  attachRelayDesktopHandlers,
  openRelayDesktopSocket,
} from '../../src/relay/desktop-client.js'
import { createRelayServer } from '../../src/relay/server.js'
import { encodeClaudeProjectPath } from '../../src/server/session-capture-claude.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const temporaryDirectories: string[] = []
const originalCodexHome = process.env.CODEX_HOME
const originalClaudeProjects = process.env.HIVE_CLAUDE_PROJECTS_DIR

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  if (originalClaudeProjects === undefined) delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  else process.env.HIVE_CLAUDE_PROJECTS_DIR = originalClaudeProjects
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

const waitFor = async <T>(read: () => T, matches: (value: T) => boolean, label: string) => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = read()
    if (matches(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const readMessage = async (socket: WebSocket) => {
  const [raw] = (await once(socket, 'message')) as [WebSocket.RawData]
  return JSON.parse(raw.toString()) as Record<string, unknown>
}

const appendUserTurn = (
  provider: 'claude' | 'codex',
  sessionFile: string,
  id: string,
  text: string
) => {
  const event =
    provider === 'codex'
      ? {
          id,
          payload: {
            content: [{ text, type: 'input_text' }],
            role: 'user',
            type: 'message',
          },
          type: 'response_item',
        }
      : {
          message: { content: text, role: 'user' },
          type: 'user',
          uuid: id,
        }
  appendFileSync(sessionFile, `${JSON.stringify(event)}\n`)
}

const createProviderRuntime = async (provider: 'claude' | 'codex') => {
  const dataDir = mkdtempSync(join(tmpdir(), `yive-relay-chat-force-${provider}-`))
  temporaryDirectories.push(dataDir)
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  const sessionId =
    provider === 'codex'
      ? '91919191-9191-4191-8191-919191919191'
      : '92929292-9292-4292-8292-929292929292'
  let sessionFile: string
  if (provider === 'codex') {
    const codexHome = join(dataDir, 'codex-home')
    const sessionDirectory = join(codexHome, 'sessions', '2026', '07', '12')
    mkdirSync(sessionDirectory, { recursive: true })
    process.env.CODEX_HOME = codexHome
    sessionFile = join(sessionDirectory, `rollout-2026-07-12T00-00-00-${sessionId}.jsonl`)
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspacePath, id: sessionId } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
    )
  } else {
    const projectsRoot = join(dataDir, 'claude-projects')
    const projectDirectory = join(projectsRoot, encodeClaudeProjectPath(workspacePath))
    mkdirSync(projectDirectory, { recursive: true })
    process.env.HIVE_CLAUDE_PROJECTS_DIR = projectsRoot
    sessionFile = join(projectDirectory, `${sessionId}.jsonl`)
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1 })}\n`
    )
  }
  const scriptPath = join(workspacePath, 'capture-input.cjs')
  writeFileSync(
    scriptPath,
    `process.stdout.write('❯ ')
process.stdin.on('data', (chunk) => process.stdout.write(chunk))
setInterval(() => {}, 1000)
`
  )
  const runtime = await startTestServer({ dataDir })
  const cookie = await getUiCookie(runtime.baseUrl)
  const workspace = runtime.store.createWorkspace(workspacePath, `${provider} Relay Force`)
  const worker = runtime.store.addWorker(workspace.id, { name: provider })
  const startupText = [
    'Yive startup',
    `Hive session binding: workspace_id=${workspace.id}; agent_id=${worker.id}`,
    'Mobile file direction: .hive/mobile-attachments.json is only the phone-uploaded attachment registry',
    'To send a generated workspace file to the phone, run yive mobile send-file',
  ].join('\n')
  if (provider === 'claude') {
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'user', uuid: 'startup', message: { role: 'user', content: startupText } })}\n${JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1 })}\n`
    )
  } else {
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: startupText }] } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
    )
  }
  runtime.store.configureAgentLaunch(workspace.id, worker.id, {
    args: [scriptPath],
    command: process.execPath,
    provider: provider,
    sessionIdCapture:
      provider === 'codex'
        ? { pattern: '~/.codex/sessions/**/*.jsonl', source: 'codex_session_jsonl_dir' }
        : {
            pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
            source: 'claude_project_jsonl_dir',
          },
  })
  const run = await runtime.store.startAgent(workspace.id, worker.id, {
    hivePort: new URL(runtime.baseUrl).port,
    suppressStartupInstructions: true,
  })
  appendFileSync(
    sessionFile,
    provider === 'codex'
      ? `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
      : `${JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1 })}\n`
  )
  await waitFor(
    () => runtime.store.getActiveRunByAgentId(workspace.id, worker.id)?.sessionId,
    (value) => value === sessionId,
    `${provider} verified active session`
  )
  runtime.store.refreshAgentSessionBinding(workspace.id, worker.id)
  const readConversation = () => runtime.store.getCurrentAgentConversation(workspace.id, worker.id)
  const conversation = await waitFor(
    readConversation,
    (value) => value?.activity_state === 'idle',
    `${provider} idle conversation`
  )
  if (!conversation) throw new Error('Conversation missing')
  appendUserTurn(provider, sessionFile, `${provider}-busy-user`, 'working')
  await waitFor(
    readConversation,
    (value) => value?.activity_state === 'busy',
    `${provider} busy conversation`
  )
  return { conversation, cookie, readConversation, run, runtime, worker, workspace }
}

const createRelayPath = async (runtimeUrl: string, workspaceId: string) => {
  const relayApp = createRelayServer({ pairingToken: 'test-token' })
  await new Promise<void>((resolve) => relayApp.server.listen(0, '127.0.0.1', () => resolve()))
  const address = relayApp.server.address()
  if (!address || typeof address === 'string') throw new Error('Relay did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const pairingResponse = await fetch(`${baseUrl}/pairings`, {
    headers: { authorization: 'Bearer test-token' },
    method: 'POST',
  })
  const pairing = (await pairingResponse.json()) as { token: string }
  const claimResponse = await fetch(`${baseUrl}/pairings/claim`, {
    body: JSON.stringify({
      desktop_id: 'desktop-1',
      device_id: 'mobile-1',
      token: pairing.token,
      workspace_ids: [workspaceId],
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  const claimed = (await claimResponse.json()) as { token: string }
  const desktop = openRelayDesktopSocket({
    deviceId: 'desktop-1',
    serverUrl: baseUrl,
    token: 'test-token',
  })
  attachRelayDesktopHandlers(desktop, { deviceId: 'desktop-1', localRuntimeUrl: runtimeUrl })
  await once(desktop, 'open')
  const mobile = new WebSocket(
    `ws://127.0.0.1:${address.port}/ws/mobile?device_id=mobile-1&desktop_id=desktop-1&pairing_token=${claimed.token}`
  )
  await once(mobile, 'open')
  return {
    desktop,
    mobile,
    close: async () => {
      desktop.close()
      mobile.close()
      relayApp.hub.close()
      await new Promise<void>((resolve) => relayApp.server.close(() => resolve()))
    },
  }
}

const sendAction = async (
  socket: WebSocket,
  requestId: string,
  payload: Record<string, unknown>
) => {
  socket.send(
    JSON.stringify({
      channel: 'runtime',
      from: 'mobile-1',
      payload,
      request_id: requestId,
      to: 'desktop-1',
      type: 'mobile_action',
    })
  )
  return readMessage(socket)
}

describe('Relay forced Chat delivery', () => {
  test.each([
    'codex',
    'claude',
  ] as const)('delivers one selected queued %s message through Relay without Ctrl+C', async (provider) => {
    const fixture = await createProviderRuntime(provider)
    const relay = await createRelayPath(fixture.runtime.baseUrl, fixture.workspace.id)
    try {
      const binding = await sendAction(relay.mobile, `${provider}-bind-session`, {
        action_id: `${provider}-bind-session`,
        kind: 'bind_current_session',
        target: { agent_id: fixture.worker.id },
        workspace_id: fixture.workspace.id,
      })
      expect(binding).toMatchObject({
        payload: {
          kind: 'bind_current_session',
          result: {
            agent_id: fixture.worker.id,
            failure_reason: null,
            run_id: fixture.run.runId,
            session_id: expect.any(String),
            state: 'saved',
            unchanged: true,
          },
        },
      })

      const upload = await fetch(`${fixture.runtime.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({
          content_base64: Buffer.from('89504e470d0a1a0a706e67', 'hex').toString('base64'),
          name: 'relay-chat.png',
        }),
        headers: { 'content-type': 'application/json', cookie: fixture.cookie },
        method: 'POST',
      })
      expect(upload.status).toBe(201)
      const uploaded = (await upload.json()) as { id: string; local_path?: string }
      expect(uploaded).not.toHaveProperty('local_path')
      const uploadedLocalPath = join(tmpdir(), 'hive-mobile-files', `${uploaded.id}.png`)
      const firstId = '93939393-9393-4393-8393-939393939393'
      const secondId = '94949494-9494-4494-8494-949494949494'
      const thirdId = '95959595-9595-4595-8595-959595959595'
      for (const [index, id] of [firstId, secondId, thirdId].entries()) {
        const response = await sendAction(relay.mobile, `${provider}-submit-${index}`, {
          action_id: id,
          kind: 'chat_submit',
          payload: {
            ...(index === 1 ? { attachments: [{ file_id: uploaded.id }] } : {}),
            body:
              index === 0 ? 'first queued' : index === 1 ? 'forced through relay' : 'third queued',
          },
          target: { conversation_id: fixture.conversation.id },
          workspace_id: fixture.workspace.id,
        })
        expect(response).toMatchObject({ payload: { result: { state: 'queued' } } })
      }
      const capacity = await sendAction(relay.mobile, `${provider}-capacity`, {
        action_id: '96969696-9696-4696-8696-969696969696',
        kind: 'chat_submit',
        payload: { body: 'fourth queued' },
        target: { conversation_id: fixture.conversation.id },
        workspace_id: fixture.workspace.id,
      })
      expect(capacity).toMatchObject({
        payload: { code: 'chat_queue_capacity' },
        type: 'relay_error',
      })

      const forced = await sendAction(relay.mobile, `${provider}-force`, {
        action_id: `${provider}-force-action`,
        kind: 'chat_force',
        payload: { skipped_count: 1 },
        target: { submission_id: secondId },
        workspace_id: fixture.workspace.id,
      })

      expect(forced).toMatchObject({
        payload: { kind: 'chat_force', result: { id: secondId, state: 'delivered' } },
      })
      const output = await waitFor(
        () => fixture.runtime.store.getLiveRun(fixture.run.runId).output,
        (value) => value.includes('forced through relay'),
        `${provider} Relay PTY delivery`
      )
      expect(output).not.toContain('first queued')
      expect(output).not.toContain('\u0003')
      expect(output).toContain(`[Yive mobile attachments]`)
      expect(output).toContain(`.hive/chat-attachments/${secondId}/${uploaded.id}.png`)
      expect(output).not.toContain('.hive/mobile-attachments.json')
      expect(output).not.toContain('local_path')
      expect(output).not.toContain('file_id')
      expect(output).not.toContain(uploadedLocalPath)
    } finally {
      await relay.close()
      fixture.runtime.store.stopAgentRun(fixture.run.runId)
      await fixture.runtime.close()
    }
  }, 30_000)
})
