import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { writeProviderAdapterFixture } from '../helpers/provider-adapter-fixture.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const temporaryDirectories: string[] = []
const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

const waitForOutput = async (read: () => string, needle: string) => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const output = read()
    if (output.includes(needle)) return output
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`PTY output did not contain ${needle}: ${read()}`)
}

const waitForSubmissionState = async (url: string, cookie: string, state: string) => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const response = await fetch(url, { headers: { cookie } })
    const body = (await response.json()) as {
      conversation: { submissions: Array<{ id: string; state: string }> }
    }
    const submission = body.conversation.submissions.find((item) => item.state === state)
    if (submission) return submission
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Submission did not reach ${state}`)
}

describe('idle chat submission', () => {
  test('rechecks verified activity before an automatic queued delivery writes to the PTY', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'yive-chat-activity-race-'))
    temporaryDirectories.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    process.env.CODEX_HOME = join(dataDir, 'codex-home')
    const fixture = writeProviderAdapterFixture({
      fixtureId: 'automatic-delivery-race',
      provider: 'codex',
      root: dataDir,
      workspacePath,
    })
    const server = await startTestServer({ dataDir: join(dataDir, 'runtime') })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Activity Race')
      const worker = server.store.addWorker(workspace.id, { name: 'Codex' })
      server.store.configureAgentLaunch(workspace.id, worker.id, {
        ...buildManagedProviderLaunchConfig('codex'),
        args: [],
        command: fixture.command,
        interactiveCommand: fixture.command,
      })
      await server.store.startAgent(workspace.id, worker.id, {
        hivePort: new URL(server.baseUrl).port,
        suppressStartupInstructions: true,
      })

      const conversationUrl = `${server.baseUrl}/api/mobile/agents/${encodeURIComponent(worker.id)}/conversation?workspace_id=${encodeURIComponent(workspace.id)}`
      const readConversation = async () => {
        const response = await fetch(conversationUrl, { headers: { cookie } })
        expect(response.status).toBe(200)
        return (await response.json()) as {
          conversation: {
            activity_state: string
            id: string
            submissions: Array<{ id: string; state: string }>
          } | null
        }
      }
      await expect
        .poll(async () => (await readConversation()).conversation?.activity_state)
        .toBe('idle')

      fixture.appendUser('first busy turn')
      await expect
        .poll(async () => (await readConversation()).conversation?.activity_state)
        .toBe('busy')
      const conversation = (await readConversation()).conversation
      expect(conversation).not.toBeNull()
      const actionId = '77777777-7777-4777-8777-777777777777'
      const queued = await fetch(`${server.baseUrl}/api/mobile/actions`, {
        body: JSON.stringify({
          action_id: actionId,
          kind: 'chat_submit',
          payload: { body: 'stay queued across stale idle callback' },
          target: { conversation_id: conversation?.id },
          workspace_id: workspace.id,
        }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(queued.status).toBe(202)
      await expect(queued.json()).resolves.toMatchObject({ result: { state: 'queued' } })

      fixture.appendAssistant('first turn complete')
      fixture.appendCompletion()
      expect(
        server.store.getCurrentAgentConversation(workspace.id, worker.id)?.activity_state
      ).toBe('idle')
      fixture.appendUser('second busy turn before automatic delivery')

      await expect
        .poll(async () => (await readConversation()).conversation?.activity_state)
        .toBe('busy')
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(
        fixture
          .readEvents()
          .filter((event) => event.kind === 'stdin')
          .map((event) => event.text)
          .join('')
      ).not.toContain('stay queued across stale idle callback')
      expect(
        (await readConversation()).conversation?.submissions.find((item) => item.id === actionId)
      ).toMatchObject({ state: 'queued' })
    } finally {
      await server.close()
    }
  }, 20_000)

  test('persists and delivers one whole message idempotently without terminal ownership', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'yive-chat-submit-'))
    temporaryDirectories.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    const codexHome = join(dataDir, 'codex-home')
    const sessionDirectory = join(codexHome, 'sessions', '2026', '07', '11')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(sessionDirectory, { recursive: true })
    process.env.CODEX_HOME = codexHome
    const scriptPath = join(workspacePath, 'capture-input.cjs')
    writeFileSync(
      scriptPath,
      `process.stdout.write('❯ ')
process.stdin.on('data', (chunk) => {
  process.stdout.write('CHUNK:' + chunk.toString('hex') + '\\n')
  if (chunk.includes(Buffer.from('\\u001b[201~'))) process.stdout.write('[Pasted text #1]\\n')
})
setInterval(() => {}, 1000)
`
    )

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Chat Submit')
      const worker = server.store.addWorker(workspace.id, { name: 'Codex' })
      server.store.configureAgentLaunch(workspace.id, worker.id, {
        args: [scriptPath],
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
      const sessionId = '44444444-4444-4444-8444-444444444444'
      const sessionFile = join(sessionDirectory, `rollout-2026-07-11T00-00-00-${sessionId}.jsonl`)
      writeFileSync(
        sessionFile,
        `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspacePath, id: sessionId } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
      )
      const run = await startPromise
      server.store.refreshAgentSessionBinding(workspace.id, worker.id)
      const conversation = server.store.getCurrentAgentConversation(workspace.id, worker.id)
      expect(conversation).not.toBeNull()

      const action = {
        action_id: '55555555-5555-4555-8555-555555555555',
        kind: 'chat_submit',
        payload: { body: 'first line\nsecond line' },
        target: { conversation_id: conversation?.id },
        workspace_id: workspace.id,
      }
      const response = await fetch(`${server.baseUrl}/api/mobile/actions`, {
        body: JSON.stringify(action),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      const responseText = await response.text()
      expect(response.status, responseText).toBe(202)
      expect(JSON.parse(responseText)).toMatchObject({
        action_id: action.action_id,
        kind: 'chat_submit',
        result: { id: action.action_id, state: 'delivered' },
      })

      const output = await waitForOutput(
        () => server.store.getLiveRun(run.runId).output,
        'first linesecond line'
      )
      expect(output).not.toContain('\u0003')

      const duplicate = await fetch(`${server.baseUrl}/api/mobile/actions`, {
        body: JSON.stringify({ ...action, payload: {} }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(duplicate.status).toBe(202)
      await expect(duplicate.json()).resolves.toMatchObject({ duplicate: true })
      const conflictingDuplicate = await fetch(`${server.baseUrl}/api/mobile/actions`, {
        body: JSON.stringify({ ...action, payload: { body: 'different message' } }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(conflictingDuplicate.status).toBe(400)
      expect(
        server.store.getLiveRun(run.runId).output.match(/first linesecond line/gu)
      ).toHaveLength(1)

      const conversationUrl = `${server.baseUrl}/api/mobile/agents/${encodeURIComponent(worker.id)}/conversation?workspace_id=${encodeURIComponent(workspace.id)}`
      await expect(
        waitForSubmissionState(conversationUrl, cookie, 'delivered')
      ).resolves.toMatchObject({ id: action.action_id })
      appendFileSync(
        sessionFile,
        `${JSON.stringify({ id: 'provider-user-1', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first line\nsecond line' }] } })}\n`
      )
      await expect(
        waitForSubmissionState(conversationUrl, cookie, 'confirmed')
      ).resolves.toMatchObject({ id: action.action_id })
      const confirmedDuplicate = await fetch(`${server.baseUrl}/api/mobile/actions`, {
        body: JSON.stringify({ ...action, payload: {} }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(confirmedDuplicate.status).toBe(202)
      await expect(confirmedDuplicate.json()).resolves.toMatchObject({
        duplicate: true,
        result: { id: action.action_id },
      })

      const otherWorkspace = server.store.createWorkspace(join(dataDir, 'other'), 'Other')
      const crossWorkspace = await fetch(`${server.baseUrl}/api/mobile/actions`, {
        body: JSON.stringify({
          ...action,
          action_id: '66666666-6666-4666-8666-666666666666',
          workspace_id: otherWorkspace.id,
        }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(crossWorkspace.status).toBe(400)
      const busyAction = {
        ...action,
        action_id: '88888888-8888-4888-8888-888888888888',
        payload: { body: 'must wait until idle' },
      }
      const busyDelivery = await fetch(`${server.baseUrl}/api/mobile/actions`, {
        body: JSON.stringify(busyAction),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(busyDelivery.status).toBe(202)
      await expect(busyDelivery.json()).resolves.toMatchObject({ result: { state: 'queued' } })
      expect(server.store.getLiveRun(run.runId).output).not.toContain('must wait until idle')
      server.store.stopAgentRun(run.runId)
    } finally {
      await server.close()
    }
  }, 15_000)
})
