import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import {
  getMobileAttachmentsFilePath,
  readMobileAttachments,
} from '../../src/server/mobile-attachments.js'
import { encodeClaudeProjectPath } from '../../src/server/session-capture-claude.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const temporaryDirectories: string[] = []
const originalCodexHome = process.env.CODEX_HOME
const originalClaudeProjects = process.env.HIVE_CLAUDE_PROJECTS_DIR
const pngFixture = () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('png')])

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  if (originalClaudeProjects === undefined) delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  else process.env.HIVE_CLAUDE_PROJECTS_DIR = originalClaudeProjects
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 })
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

const postAction = async (baseUrl: string, cookie: string, action: Record<string, unknown>) =>
  fetch(`${baseUrl}/api/mobile/actions`, {
    body: JSON.stringify(action),
    headers: { 'content-type': 'application/json', cookie },
    method: 'POST',
  })

const createProviderFixture = async (
  provider: 'claude' | 'codex',
  options: { promptReady?: boolean } = {}
) => {
  const dataDir = mkdtempSync(join(tmpdir(), `yive-chat-queue-${provider}-`))
  temporaryDirectories.push(dataDir)
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  const sessionId =
    provider === 'codex'
      ? '11111111-1111-4111-8111-111111111111'
      : '22222222-2222-4222-8222-222222222222'
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
      `${JSON.stringify({ type: 'assistant', uuid: 'old', message: { id: 'old', role: 'assistant', content: [{ type: 'text', text: 'old' }] } })}\n${JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1 })}\n`
    )
  }
  const scriptPath = join(workspacePath, 'capture-input.cjs')
  writeFileSync(
    scriptPath,
    `process.stdout.write(${JSON.stringify(options.promptReady ? '❯ ' : 'waiting')})
process.stdin.on('data', (chunk) => {
  process.stdout.write(chunk)
  if (chunk.includes(Buffer.from('\\u001b[201~'))) process.stdout.write('[Pasted Content 20 chars]\\n')
  if (chunk.includes(Buffer.from('\\r'))) process.stdout.write('\\n❯ ')
})
setInterval(() => {}, 1000)
`
  )
  const server = await startTestServer({ dataDir })
  const cookie = await getUiCookie(server.baseUrl)
  const workspace = server.store.createWorkspace(workspacePath, `${provider} Queue`)
  const worker = server.store.addWorker(workspace.id, { name: provider })
  if (provider === 'claude') {
    const startupText = [
      'Yive startup',
      `Hive session binding: workspace_id=${workspace.id}; agent_id=${worker.id}`,
      'Mobile file direction: .hive/mobile-attachments.json is only the phone-uploaded attachment registry',
      'To send a generated workspace file to the phone, run yive mobile send-file',
    ].join('\n')
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'user', uuid: 'startup', message: { role: 'user', content: startupText } })}\n${JSON.stringify({ type: 'assistant', uuid: 'old', message: { id: 'old', role: 'assistant', content: [{ type: 'text', text: 'old' }] } })}\n${JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1 })}\n`
    )
  }
  server.store.configureAgentLaunch(workspace.id, worker.id, {
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
  const run = await server.store.startAgent(workspace.id, worker.id, {
    hivePort: new URL(server.baseUrl).port,
    suppressStartupInstructions: true,
  })
  appendCompletion(provider, sessionFile)
  server.store.refreshAgentSessionBinding(workspace.id, worker.id)
  const readConversation = () => server.store.getCurrentAgentConversation(workspace.id, worker.id)
  await waitFor(readConversation, (conversation) => conversation !== null, 'conversation')
  return { cookie, readConversation, run, server, sessionFile, worker, workspace, workspacePath }
}

const appendTurn = (
  provider: 'claude' | 'codex',
  sessionFile: string,
  role: 'assistant' | 'user',
  id: string,
  text: string
) => {
  const event =
    provider === 'codex'
      ? {
          id,
          payload: {
            content: [{ text, type: role === 'user' ? 'input_text' : 'output_text' }],
            role,
            type: 'message',
          },
          type: 'response_item',
        }
      : {
          message: {
            content: role === 'user' ? text : [{ text, type: 'text' }],
            id,
            role,
          },
          type: role,
          uuid: id,
        }
  appendFileSync(sessionFile, `${JSON.stringify(event)}\n`)
}

const appendCompletion = (provider: 'claude' | 'codex', sessionFile: string) => {
  const event =
    provider === 'codex'
      ? { type: 'event_msg', payload: { type: 'task_complete' } }
      : { type: 'system', subtype: 'turn_duration', durationMs: 1 }
  appendFileSync(sessionFile, `${JSON.stringify(event)}\n`)
}

const chatSubmitAction = (
  workspaceId: string,
  conversationId: string,
  id: string,
  body: string,
  attachments: Array<{ file_id: string }> = []
) => ({
  action_id: id,
  kind: 'chat_submit',
  payload: { attachments, body },
  target: { conversation_id: conversationId },
  workspace_id: workspaceId,
})

describe('queued Chat submission', () => {
  test.each([
    'codex',
    'claude',
  ] as const)('accepts and delivers one atomic %s image Chat submission idempotently', async (provider) => {
    const fixture = await createProviderFixture(provider, { promptReady: true })
    try {
      const conversation = fixture.readConversation()
      if (!conversation) throw new Error('Conversation missing')
      const upload = await fetch(`${fixture.server.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({
          content_base64: pngFixture().toString('base64'),
          name: 'chat-photo.png',
        }),
        headers: { 'content-type': 'application/json', cookie: fixture.cookie },
        method: 'POST',
      })
      expect(upload.status).toBe(201)
      const uploaded = (await upload.json()) as { id: string; local_path?: string }
      expect(uploaded).not.toHaveProperty('local_path')
      const uploadedLocalPath = join(tmpdir(), 'hive-mobile-files', `${uploaded.id}.png`)
      const submissionId =
        provider === 'codex'
          ? '90909090-9090-4090-8090-909090909090'
          : '91919191-9191-4191-8191-919191919191'
      const action = chatSubmitAction(
        fixture.workspace.id,
        conversation.id,
        submissionId,
        '请分析这张图',
        [{ file_id: uploaded.id }]
      )

      const first = await postAction(fixture.server.baseUrl, fixture.cookie, action)
      expect(first.status).toBe(202)
      const firstPayload = JSON.stringify(await first.json())
      const artifact = `.hive/chat-attachments/${submissionId}/${uploaded.id}.png`
      expect(firstPayload).toContain(uploaded.id)
      expect(firstPayload).toContain(artifact)
      expect(firstPayload).not.toContain(uploadedLocalPath)
      expect(firstPayload).not.toContain('content_base64')
      expect(firstPayload).not.toContain('mobile-attachments.json')
      expect(firstPayload).not.toContain('local_path')

      await new Promise((resolve) => setTimeout(resolve, 500))
      const beforeRetry = fixture.server.store.getLiveRun(fixture.run.runId).output
      const beforeRetryOccurrences = beforeRetry.match(/请分析这张图/gu)?.length ?? 0
      const retry = await postAction(fixture.server.baseUrl, fixture.cookie, action)
      expect(retry.status).toBe(202)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const output = fixture.server.store.getLiveRun(fixture.run.runId).output
      expect(output.match(/请分析这张图/gu)?.length ?? 0).toBe(beforeRetryOccurrences)
      expect(output).toContain('[Yive mobile attachments]')
      expect(output).toContain(artifact)
      expect(output).not.toContain('.hive/mobile-attachments.json')
      expect(output).not.toContain('local_path')
      expect(output).not.toContain('file_id')
      expect(output).not.toContain(uploadedLocalPath)
    } finally {
      fixture.server.store.stopAgentRun(fixture.run.runId)
      await fixture.server.close()
    }
  }, 30_000)

  test('reconciles a durable image submission when Runtime exits before registry commit', async () => {
    const fixture = await createProviderFixture('codex', { promptReady: true })
    let closed = false
    try {
      const conversation = fixture.readConversation()
      if (!conversation) throw new Error('Conversation missing')
      const upload = await fetch(`${fixture.server.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({
          content_base64: pngFixture().toString('base64'),
          name: 'recovery.png',
        }),
        headers: { 'content-type': 'application/json', cookie: fixture.cookie },
        method: 'POST',
      })
      const uploaded = (await upload.json()) as { id: string }
      const submissionId = '93939393-9393-4393-8393-939393939393'
      const accepted = await postAction(
        fixture.server.baseUrl,
        fixture.cookie,
        chatSubmitAction(fixture.workspace.id, conversation.id, submissionId, 'recover image', [
          { file_id: uploaded.id },
        ])
      )
      expect(accepted.status).toBe(202)
      expect(readMobileAttachments(fixture.workspacePath)).toContainEqual(
        expect.objectContaining({ file_id: uploaded.id })
      )

      fixture.server.store.stopAgentRun(fixture.run.runId)
      await fixture.server.close()
      closed = true
      writeFileSync(getMobileAttachmentsFilePath(fixture.workspacePath), '{"attachments":', 'utf8')
      const orphanStaging = join(
        fixture.workspacePath,
        '.hive',
        'chat-attachment-staging',
        '94959595-9495-4495-8495-949595959495'
      )
      mkdirSync(orphanStaging, { recursive: true })
      writeFileSync(join(orphanStaging, 'orphan.png'), pngFixture())

      const reopened = await startTestServer({ dataDir: fixture.server.dataDir })
      try {
        expect(readMobileAttachments(fixture.workspacePath)).toContainEqual(
          expect.objectContaining({
            artifact: `.hive/chat-attachments/${submissionId}/${uploaded.id}.png`,
            file_id: uploaded.id,
          })
        )
        expect(existsSync(orphanStaging)).toBe(false)
      } finally {
        await reopened.close()
      }
    } finally {
      if (!closed) {
        fixture.server.store.stopAgentRun(fixture.run.runId)
        await fixture.server.close()
      }
    }
  }, 30_000)

  test('rejects the whole Chat submission when any image attachment cannot bind', async () => {
    const fixture = await createProviderFixture('codex', { promptReady: true })
    try {
      const conversation = fixture.readConversation()
      if (!conversation) throw new Error('Conversation missing')
      const upload = await fetch(`${fixture.server.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({
          content_base64: pngFixture().toString('base64'),
          name: 'valid.png',
        }),
        headers: { 'content-type': 'application/json', cookie: fixture.cookie },
        method: 'POST',
      })
      const uploaded = (await upload.json()) as { id: string }
      const submissionId = '92929292-9292-4292-8292-929292929292'

      const response = await postAction(
        fixture.server.baseUrl,
        fixture.cookie,
        chatSubmitAction(fixture.workspace.id, conversation.id, submissionId, 'do not send', [
          { file_id: uploaded.id },
          { file_id: 'missing-file' },
        ])
      )

      expect(response.status).toBe(400)
      expect(fixture.server.store.getLiveRun(fixture.run.runId).output).not.toContain('do not send')
      expect(fixture.readConversation()?.submissions).not.toContainEqual(
        expect.objectContaining({ id: submissionId })
      )

      const linkedSubmissionId = '94949494-9494-4494-8494-949494949494'
      const outsideAttachmentTarget = join(dirname(fixture.workspacePath), 'outside-chat-target')
      const linkedSubmissionDirectory = join(
        fixture.workspacePath,
        '.hive',
        'chat-attachments',
        linkedSubmissionId
      )
      mkdirSync(outsideAttachmentTarget)
      mkdirSync(dirname(linkedSubmissionDirectory), { recursive: true })
      symlinkSync(outsideAttachmentTarget, linkedSubmissionDirectory, 'junction')
      try {
        const linkedResponse = await postAction(
          fixture.server.baseUrl,
          fixture.cookie,
          chatSubmitAction(
            fixture.workspace.id,
            conversation.id,
            linkedSubmissionId,
            'do not escape',
            [{ file_id: uploaded.id }]
          )
        )
        expect(linkedResponse.status).toBe(400)
        expect(await linkedResponse.text()).not.toContain(fixture.workspacePath)
        expect(readdirSync(outsideAttachmentTarget)).toEqual([])
        expect(fixture.readConversation()?.submissions).not.toContainEqual(
          expect.objectContaining({ id: linkedSubmissionId })
        )
      } finally {
        unlinkSync(linkedSubmissionDirectory)
      }
    } finally {
      fixture.server.store.stopAgentRun(fixture.run.runId)
      await fixture.server.close()
    }
  }, 30_000)

  test('delivers a queued image after its temporary upload is deleted', async () => {
    const fixture = await createProviderFixture('codex', { promptReady: true })
    try {
      const conversation = fixture.readConversation()
      if (!conversation) throw new Error('Conversation missing')
      appendTurn('codex', fixture.sessionFile, 'user', 'busy-image-user', 'working')
      await waitFor(
        fixture.readConversation,
        (page) => page?.activity_state === 'busy',
        'busy image conversation'
      )
      const upload = await fetch(`${fixture.server.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({
          content_base64: pngFixture().toString('base64'),
          name: 'DB_PASSWORD=secret.png',
        }),
        headers: { 'content-type': 'application/json', cookie: fixture.cookie },
        method: 'POST',
      })
      const uploaded = (await upload.json()) as { id: string }
      const submissionId = '93939393-9393-4393-8393-939393939393'
      const queued = await postAction(
        fixture.server.baseUrl,
        fixture.cookie,
        chatSubmitAction(fixture.workspace.id, conversation.id, submissionId, 'delayed image', [
          { file_id: uploaded.id },
        ])
      )
      expect(queued.status).toBe(202)
      const queuedPayload = await queued.json()
      expect(queuedPayload).toMatchObject({ result: { state: 'queued' } })
      expect(JSON.stringify(queuedPayload)).not.toContain('secret.png')

      const deleted = await fetch(`${fixture.server.baseUrl}/api/mobile/files/${uploaded.id}`, {
        headers: { cookie: fixture.cookie },
        method: 'DELETE',
      })
      expect(deleted.ok).toBe(true)
      const durableDownload = await fetch(
        `${fixture.server.baseUrl}/api/mobile/files/${uploaded.id}?workspace_id=${fixture.workspace.id}&submission_id=${submissionId}`,
        { headers: { cookie: fixture.cookie } }
      )
      expect(durableDownload.status).toBe(200)
      expect(durableDownload.headers.get('content-type')).toBe('image/png')
      expect(Buffer.from(await durableDownload.arrayBuffer())).toEqual(pngFixture())
      appendTurn('codex', fixture.sessionFile, 'assistant', 'busy-image-answer', 'done')
      appendCompletion('codex', fixture.sessionFile)

      const output = await waitFor(
        () => fixture.server.store.getLiveRun(fixture.run.runId).output,
        (value) => value.includes('delayed image'),
        'durable queued image delivery'
      )
      const artifact = `.hive/chat-attachments/${submissionId}/${uploaded.id}.png`
      expect(output).toContain('[Yive mobile attachments]')
      expect(output).toContain(artifact)
      expect(output).not.toContain('.hive/mobile-attachments.json')
      expect(output).not.toContain('local_path')
      expect(output).not.toContain('file_id')
      await waitFor(
        fixture.readConversation,
        (page) =>
          page?.submissions.some(
            (submission) => submission.id === submissionId && submission.state === 'delivered'
          ) === true,
        'durable image delivery persistence'
      )
    } finally {
      fixture.server.store.stopAgentRun(fixture.run.runId)
      await fixture.server.close()
    }
  }, 30_000)

  test('copies a paused image into the migrated submission before delivery', async () => {
    const fixture = await createProviderFixture('codex', { promptReady: true })
    try {
      const sourceConversation = fixture.readConversation()
      if (!sourceConversation) throw new Error('Conversation missing')
      appendTurn('codex', fixture.sessionFile, 'user', 'busy-before-migration', 'working')
      await waitFor(
        fixture.readConversation,
        (page) => page?.activity_state === 'busy',
        'busy conversation before migration'
      )
      const upload = await fetch(`${fixture.server.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({
          content_base64: pngFixture().toString('base64'),
          name: 'migrate.png',
        }),
        headers: { 'content-type': 'application/json', cookie: fixture.cookie },
        method: 'POST',
      })
      const uploaded = (await upload.json()) as { id: string; local_path?: string }
      expect(uploaded).not.toHaveProperty('local_path')
      const uploadedLocalPath = join(tmpdir(), 'hive-mobile-files', `${uploaded.id}.png`)
      const sourceSubmissionId = '94949494-9494-4494-8494-949494949494'
      const queued = await postAction(
        fixture.server.baseUrl,
        fixture.cookie,
        chatSubmitAction(
          fixture.workspace.id,
          sourceConversation.id,
          sourceSubmissionId,
          'move image',
          [{ file_id: uploaded.id }]
        )
      )
      expect(queued.status).toBe(202)
      const sourcePinnedPath = join(
        fixture.workspacePath,
        '.hive',
        'chat-attachments',
        sourceSubmissionId,
        `${uploaded.id}.png`
      )
      expect(existsSync(sourcePinnedPath)).toBe(true)

      const deleted = await fetch(`${fixture.server.baseUrl}/api/mobile/files/${uploaded.id}`, {
        headers: { cookie: fixture.cookie },
        method: 'DELETE',
      })
      expect(deleted.ok).toBe(true)
      const nextSessionId = '95959595-9595-4595-8595-959595959595'
      const nextSessionFile = join(
        dirname(fixture.sessionFile),
        `rollout-2026-07-12T23-58-59-${nextSessionId}.jsonl`
      )
      writeFileSync(
        nextSessionFile,
        `${JSON.stringify({ type: 'session_meta', payload: { cwd: fixture.workspacePath, id: nextSessionId } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
      )
      fixture.server.store.refreshAgentSessionBinding(fixture.workspace.id, fixture.worker.id)
      const targetConversation = await waitFor(
        fixture.readConversation,
        (page) => (page?.id !== sourceConversation.id ? page : null),
        'new conversation before migration'
      )
      if (!targetConversation) throw new Error('Target conversation missing')
      await waitFor(
        () =>
          fixture.server.store.getAgentConversation(
            fixture.workspace.id,
            fixture.worker.id,
            sourceConversation.id
          ),
        (page) =>
          page?.submissions.some(
            (submission) => submission.id === sourceSubmissionId && submission.state === 'paused'
          ) === true,
        'paused source submission'
      )

      const targetSubmissionId = '96969696-9696-4696-8696-969696969696'
      const migrated = await postAction(fixture.server.baseUrl, fixture.cookie, {
        action_id: targetSubmissionId,
        kind: 'chat_migrate',
        payload: {},
        target: {
          conversation_id: targetConversation.id,
          submission_id: sourceSubmissionId,
        },
        workspace_id: fixture.workspace.id,
      })
      expect(migrated.status).toBe(202)
      const migratedPayload = JSON.stringify(await migrated.json())
      expect(migratedPayload).toContain(`[Image ${targetSubmissionId.slice(0, 8)} #1]`)
      expect(migratedPayload).not.toContain(uploadedLocalPath)
      const targetPinnedPath = join(
        fixture.workspacePath,
        '.hive',
        'chat-attachments',
        targetSubmissionId,
        `${uploaded.id}.png`
      )
      const targetArtifact = `.hive/chat-attachments/${targetSubmissionId}/${uploaded.id}.png`
      expect(existsSync(targetPinnedPath)).toBe(true)
      const output = await waitFor(
        () => fixture.server.store.getLiveRun(fixture.run.runId).output,
        (value) => value.includes(targetArtifact),
        'migrated image delivery'
      )
      expect(output).toContain('[Yive mobile attachments]')
      expect(output).not.toContain('.hive/mobile-attachments.json')
      expect(output).not.toContain('local_path')
      expect(output).not.toContain('file_id')
      expect(output).not.toContain(uploadedLocalPath)
      await waitFor(
        fixture.readConversation,
        (page) =>
          page?.submissions.some(
            (submission) => submission.id === targetSubmissionId && submission.state === 'delivered'
          ) === true,
        'migrated image delivery persistence'
      )
      const cancelledSource = await postAction(fixture.server.baseUrl, fixture.cookie, {
        action_id: 'cancel-migrated-source',
        kind: 'chat_cancel',
        payload: {},
        target: { submission_id: sourceSubmissionId },
        workspace_id: fixture.workspace.id,
      })
      expect(cancelledSource.status).toBe(202)
      expect(
        existsSync(join(fixture.workspacePath, '.hive', 'chat-attachments', sourceSubmissionId))
      ).toBe(false)
      expect(existsSync(targetPinnedPath)).toBe(true)
    } finally {
      fixture.server.store.stopAgentRun(fixture.run.runId)
      await fixture.server.close()
    }
  }, 30_000)

  test('queues a second idle submission until the first Provider turn completes', async () => {
    const fixture = await createProviderFixture('codex', { promptReady: true })
    try {
      const conversation = fixture.readConversation()
      if (!conversation) throw new Error('Conversation missing')
      const firstId = '12121212-1212-4121-8121-121212121212'
      const secondId = '34343434-3434-4343-8343-343434343434'

      const first = await postAction(
        fixture.server.baseUrl,
        fixture.cookie,
        chatSubmitAction(fixture.workspace.id, conversation.id, firstId, 'first idle')
      )
      expect(first.status).toBe(202)
      await expect(first.json()).resolves.toMatchObject({ result: { state: 'delivered' } })

      const second = await postAction(
        fixture.server.baseUrl,
        fixture.cookie,
        chatSubmitAction(fixture.workspace.id, conversation.id, secondId, 'second idle')
      )
      expect(second.status).toBe(202)
      await expect(second.json()).resolves.toMatchObject({ result: { state: 'queued' } })
      expect(fixture.server.store.getLiveRun(fixture.run.runId).output).not.toContain('second idle')

      appendTurn('codex', fixture.sessionFile, 'user', 'first-provider-user', 'first idle')
      await waitFor(
        fixture.readConversation,
        (page) => page?.activity_state === 'busy',
        'first Provider turn'
      )
      await waitFor(
        fixture.readConversation,
        (page) =>
          page?.submissions.some(
            (submission) => submission.id === firstId && submission.state === 'confirmed'
          ) === true,
        'first Provider turn confirmation'
      )
      appendTurn('codex', fixture.sessionFile, 'assistant', 'first-provider-answer', 'done')
      appendCompletion('codex', fixture.sessionFile)
      await waitFor(
        fixture.readConversation,
        (page) => page?.activity_state === 'idle',
        'first Provider completion'
      )
      await waitFor(
        () => fixture.server.store.getLiveRun(fixture.run.runId).output,
        (output) => output.includes('second idle'),
        'second idle delivery'
      )
      await waitFor(
        fixture.readConversation,
        (page) =>
          page?.submissions.some(
            (submission) => submission.id === secondId && submission.state === 'delivered'
          ) === true,
        'second idle delivery persistence'
      )
    } finally {
      fixture.server.store.stopAgentRun(fixture.run.runId)
      await fixture.server.close()
    }
  }, 30_000)

  test('queues at most three busy messages and releases one per Provider completion', async () => {
    const fixture = await createProviderFixture('codex', { promptReady: true })
    try {
      const conversation = fixture.readConversation()
      if (!conversation) throw new Error('Conversation missing')
      appendTurn('codex', fixture.sessionFile, 'user', 'busy-user', 'working')
      await waitFor(
        fixture.readConversation,
        (page) => page?.activity_state === 'busy',
        'busy conversation'
      )
      const ids = [
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
        '55555555-5555-4555-8555-555555555555',
      ]
      for (const [index, id] of ids.entries()) {
        const response = await postAction(
          fixture.server.baseUrl,
          fixture.cookie,
          chatSubmitAction(fixture.workspace.id, conversation.id, id, `queued ${index + 1}`)
        )
        expect(response.status).toBe(202)
        await expect(response.json()).resolves.toMatchObject({ result: { state: 'queued' } })
      }
      const upload = await fetch(`${fixture.server.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({
          content_base64: pngFixture().toString('base64'),
          name: 'capacity.png',
        }),
        headers: { 'content-type': 'application/json', cookie: fixture.cookie },
        method: 'POST',
      })
      const uploaded = (await upload.json()) as { id: string }
      const fourthId = '66666666-6666-4666-8666-666666666666'
      const fourth = await postAction(
        fixture.server.baseUrl,
        fixture.cookie,
        chatSubmitAction(fixture.workspace.id, conversation.id, fourthId, 'queued 4', [
          { file_id: uploaded.id },
        ])
      )
      expect(fourth.status).toBe(409)
      expect(existsSync(join(fixture.workspacePath, '.hive', 'chat-attachments', fourthId))).toBe(
        false
      )
      await new Promise((resolve) => setTimeout(resolve, 1000))
      expect(fixture.server.store.getLiveRun(fixture.run.runId).output).not.toContain('queued 1')

      appendTurn('codex', fixture.sessionFile, 'assistant', 'busy-answer', 'still using tools')
      await new Promise((resolve) => setTimeout(resolve, 1000))
      expect(fixture.server.store.getLiveRun(fixture.run.runId).output).not.toContain('queued 1')
      appendCompletion('codex', fixture.sessionFile)
      await waitFor(
        () => fixture.server.store.getLiveRun(fixture.run.runId).output,
        (output) => output.includes('queued 1'),
        'first queued delivery'
      )
      await waitFor(
        fixture.readConversation,
        (page) =>
          page?.submissions.some(
            (submission) => submission.id === ids[0] && submission.state === 'delivered'
          ) === true,
        'first queued delivery persistence'
      )
      expect(fixture.server.store.getLiveRun(fixture.run.runId).output).not.toContain('queued 2')

      appendTurn('codex', fixture.sessionFile, 'user', 'queued-user-1', 'queued 1')
      await waitFor(
        fixture.readConversation,
        (page) => page?.activity_state === 'busy',
        'first queued Provider turn'
      )
      await waitFor(
        fixture.readConversation,
        (page) =>
          page?.submissions.some(
            (submission) => submission.id === ids[0] && submission.state === 'confirmed'
          ) === true,
        'first queued Provider turn confirmation'
      )
      appendTurn('codex', fixture.sessionFile, 'assistant', 'queued-answer-1', 'done again')
      appendCompletion('codex', fixture.sessionFile)
      await waitFor(
        fixture.readConversation,
        (page) => page?.activity_state === 'idle',
        'first queued Provider completion'
      )
      await waitFor(
        () => fixture.server.store.getLiveRun(fixture.run.runId).output,
        (output) => output.includes('queued 2'),
        'second queued delivery'
      )
      await waitFor(
        fixture.readConversation,
        (page) =>
          page?.submissions.some(
            (submission) => submission.id === ids[1] && submission.state === 'delivered'
          ) === true,
        'second queued delivery persistence'
      )
      expect(fixture.server.store.getLiveRun(fixture.run.runId).output).not.toContain('queued 3')
    } finally {
      fixture.server.store.stopAgentRun(fixture.run.runId)
      await fixture.server.close()
    }
  }, 30_000)

  test.each([
    'codex',
    'claude',
  ] as const)('forces one selected queued %s message without interrupting the PTY', async (provider) => {
    const fixture = await createProviderFixture(provider, { promptReady: true })
    try {
      const conversation = fixture.readConversation()
      if (!conversation) throw new Error('Conversation missing')
      if (provider === 'codex') {
        appendTurn(provider, fixture.sessionFile, 'user', 'busy-user', 'working')
        await waitFor(
          fixture.readConversation,
          (page) => page?.activity_state === 'busy',
          'busy conversation'
        )
      } else {
        renameSync(fixture.sessionFile, `${fixture.sessionFile}.missing`)
        await waitFor(
          fixture.readConversation,
          (page) => page?.activity_state === 'unknown',
          'unknown conversation'
        )
      }
      const firstId = '77777777-7777-4777-8777-777777777777'
      const secondId = '88888888-8888-4888-8888-888888888888'
      for (const [id, body] of [
        [firstId, 'first queued'],
        [secondId, 'forced selected'],
      ] as const) {
        const response = await postAction(
          fixture.server.baseUrl,
          fixture.cookie,
          chatSubmitAction(fixture.workspace.id, conversation.id, id, body)
        )
        expect(response.status).toBe(202)
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
      expect(fixture.server.store.getLiveRun(fixture.run.runId).output).not.toContain(
        'forced selected'
      )
      if (provider === 'codex') {
        appendTurn(provider, fixture.sessionFile, 'assistant', 'became-idle', 'done')
        appendCompletion(provider, fixture.sessionFile)
      }
      const forced = await postAction(fixture.server.baseUrl, fixture.cookie, {
        action_id: `${provider}-force-action`,
        kind: 'chat_force',
        payload: { skipped_count: 1 },
        target: { submission_id: secondId },
        workspace_id: fixture.workspace.id,
      })
      expect(forced.status).toBe(202)
      await expect(forced.json()).resolves.toMatchObject({ result: { state: 'delivered' } })
      const output = await waitFor(
        () => fixture.server.store.getLiveRun(fixture.run.runId).output,
        (value) => value.includes('forced selected'),
        'forced delivery'
      )
      expect(output).not.toContain('first queued')
      expect(output).not.toContain('\u0003')
    } finally {
      fixture.server.store.stopAgentRun(fixture.run.runId)
      await fixture.server.close()
    }
  }, 30_000)

  test('revalidates the CLI session before the first forced PTY write', async () => {
    const fixture = await createProviderFixture('codex', { promptReady: true })
    try {
      const conversation = fixture.readConversation()
      if (!conversation) throw new Error('Conversation missing')
      appendTurn('codex', fixture.sessionFile, 'user', 'busy-before-switch', 'working')
      await waitFor(
        fixture.readConversation,
        (page) => page?.activity_state === 'busy',
        'busy conversation before session switch'
      )
      await waitFor(
        () => fixture.server.store.getLiveRun(fixture.run.runId).output,
        (output) => output.includes('❯'),
        'ready prompt before session switch'
      )
      const blockerId = '97979797-9797-4797-8797-979797979797'
      const protectedId = '90909090-9090-4090-8090-909090909090'
      for (const [id, body] of [
        [blockerId, 'chain blocker'],
        [protectedId, 'must stay queued'],
      ] as const) {
        const queued = await postAction(
          fixture.server.baseUrl,
          fixture.cookie,
          chatSubmitAction(fixture.workspace.id, conversation.id, id, body)
        )
        expect(queued.status).toBe(202)
      }

      const blockerResponse = postAction(fixture.server.baseUrl, fixture.cookie, {
        action_id: 'force-chain-blocker',
        kind: 'chat_force',
        payload: { skipped_count: 0 },
        target: { submission_id: blockerId },
        workspace_id: fixture.workspace.id,
      })
      await waitFor(
        () => fixture.server.store.getLiveRun(fixture.run.runId).output,
        (output) => output.includes('chain blocker'),
        'first forced paste before session switch'
      )
      const protectedResponse = postAction(fixture.server.baseUrl, fixture.cookie, {
        action_id: 'force-after-session-switch',
        kind: 'chat_force',
        payload: { skipped_count: 0 },
        target: { submission_id: protectedId },
        workspace_id: fixture.workspace.id,
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      const nextSessionId = '98989898-9898-4898-8898-989898989898'
      const nextSessionFile = join(
        dirname(fixture.sessionFile),
        `rollout-2026-07-12T23-59-59-${nextSessionId}.jsonl`
      )
      writeFileSync(
        nextSessionFile,
        `${JSON.stringify({ type: 'session_meta', payload: { cwd: fixture.workspacePath, id: nextSessionId } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
      )
      fixture.server.store.refreshAgentSessionBinding(fixture.workspace.id, fixture.worker.id)

      const blockerResult = await blockerResponse
      const protectedResult = await protectedResponse
      const blockerBody = await blockerResult.text()
      const protectedBody = await protectedResult.text()
      expect(blockerResult.status, blockerBody).toBe(202)
      expect(protectedResult.status, protectedBody).toBe(409)
      const output = fixture.server.store.getLiveRun(fixture.run.runId).output
      expect(output).toContain('chain blocker')
      expect(output).not.toContain('must stay queued')
    } finally {
      fixture.server.store.stopAgentRun(fixture.run.runId)
      await fixture.server.close()
    }
  }, 30_000)
})
