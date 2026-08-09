import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { MOBILE_ARTIFACT_CONTRACT_VERSION } from '../../src/shared/types.js'
import { writeManagedProviderScriptLaunchConfig } from '../helpers/managed-provider-script-fixture.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

const pngFixture = () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('png')])

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 4000,
  intervalMs = 25
) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  throw lastError
}

const createWorkspaceFixture = (prefix: string) => {
  const dataDir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dataDir)
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  return { dataDir, workspacePath }
}

const getTranscript = (
  baseUrl: string,
  cookie: string | undefined,
  workspaceId: string,
  runId: string
) =>
  fetch(
    `${baseUrl}/api/mobile/transcript?workspace_id=${encodeURIComponent(
      workspaceId
    )}&run_id=${encodeURIComponent(runId)}`,
    {
      headers: cookie ? { cookie } : {},
    }
  )

const postMobileAction = (baseUrl: string, cookie: string, body: Record<string, unknown>) =>
  fetch(`${baseUrl}/api/mobile/actions`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', cookie },
    method: 'POST',
  })

const createMobileConfirmationNonce = async (
  baseUrl: string,
  cookie: string,
  body: Record<string, unknown>
) => {
  const response = await fetch(`${baseUrl}/api/mobile/confirmations`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', cookie },
    method: 'POST',
  })
  expect(response.status).toBe(201)
  const confirmation = (await response.json()) as { nonce: string }
  return confirmation.nonce
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('mobile transcript api', () => {
  test('rejects anonymous callers', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-transcript-auth-')
    const server = await startTestServer({ dataDir })
    try {
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')

      const response = await getTranscript(server.baseUrl, undefined, workspace.id, 'run-1')

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        error: 'Mobile endpoint requires valid mobile token',
      })
    } finally {
      await server.close()
    }
  })

  test('validates workspace and run ownership', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-transcript-targets-')
    const otherWorkspacePath = join(dataDir, 'other')
    mkdirSync(otherWorkspacePath, { recursive: true })
    const script = join(workspacePath, 'passive.cjs')
    writeFileSync(script, 'process.stdin.resume(); setInterval(() => {}, 1000);\n')

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
      const otherWorkspace = server.store.createWorkspace(otherWorkspacePath, 'Beta')
      const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
      server.store.configureAgentLaunch(
        workspace.id,
        worker.id,
        writeManagedProviderScriptLaunchConfig({ root: workspacePath, targetScript: script })
      )

      const missingWorkspace = await getTranscript(
        server.baseUrl,
        cookie,
        'missing-workspace',
        'run-1'
      )
      expect(missingWorkspace.status).toBe(400)
      await expect(missingWorkspace.json()).resolves.toEqual({
        error: 'Workspace not found: missing-workspace',
      })

      const startResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'start-owned-run',
        kind: 'start_run',
        target: { agent_id: worker.id },
        workspace_id: workspace.id,
      })
      expect(startResponse.status).toBe(202)
      const started = (await startResponse.json()) as { result: { run_id: string } }

      const crossWorkspace = await getTranscript(
        server.baseUrl,
        cookie,
        otherWorkspace.id,
        started.result.run_id
      )
      expect(crossWorkspace.status).toBe(400)
      await expect(crossWorkspace.json()).resolves.toEqual({
        error: `Run not found in workspace: ${started.result.run_id}`,
      })
    } finally {
      await server.close()
    }
  }, 60000)

  test('includes useful recent PTY output from a running agent', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-transcript-pty-')
    const script = join(workspacePath, 'streaming-output.cjs')
    writeFileSync(
      script,
      [
        'let index = 0;',
        'const timer = setInterval(() => {',
        '  index += 1;',
        "  console.log(index === 2 ? '\\u001b[32mLIVE-LINE-' + index + '\\u001b[0m' : 'LIVE-LINE-' + index);",
        '  if (index === 6) clearInterval(timer);',
        '}, 30);',
        'process.stdin.resume();',
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n')
    )

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
      const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
      server.store.configureAgentLaunch(
        workspace.id,
        worker.id,
        writeManagedProviderScriptLaunchConfig({ root: workspacePath, targetScript: script })
      )

      const startResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'start-streaming-output',
        kind: 'start_run',
        target: { agent_id: worker.id },
        workspace_id: workspace.id,
      })
      expect(startResponse.status).toBe(202)
      const started = (await startResponse.json()) as { result: { run_id: string } }
      await waitFor(() => {
        const output = server.store.getLiveRun(started.result.run_id).output
        expect(output).toContain('LIVE-LINE-6')
      })

      const response = await getTranscript(
        server.baseUrl,
        cookie,
        workspace.id,
        started.result.run_id
      )

      expect(response.status).toBe(200)
      const transcriptText = await response.text()
      expect(transcriptText).not.toContain('\u001b')
      expect(transcriptText).not.toContain('HIVE_AGENT_TOKEN')
      expect(transcriptText).not.toContain('local_path')
      expect(transcriptText).not.toContain('content_base64')

      const transcript = JSON.parse(transcriptText) as {
        events: Array<Record<string, unknown>>
      }
      const outputEvent = transcript.events.find((event) => event.type === 'terminal_output')
      expect(outputEvent).toEqual(
        expect.objectContaining({
          raw_summary: expect.stringContaining('LIVE-LINE-6'),
          text: expect.stringContaining('LIVE-LINE-6'),
          type: 'terminal_output',
        })
      )
      expect(outputEvent).toEqual(
        expect.objectContaining({
          raw_summary: expect.stringContaining('LIVE-LINE-2'),
          text: expect.stringContaining('LIVE-LINE-2'),
        })
      )
    } finally {
      await server.close()
    }
  }, 60000)

  test('returns sanitized status, output, action echoes, and attachments', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-transcript-safe-')
    const script = join(workspacePath, 'stdin-listener.cjs')
    writeFileSync(
      script,
      [
        "console.log('READY \\u001b[31mred\\u001b[0m');",
        "console.log('SECRET ' + process.env.HIVE_AGENT_TOKEN);",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => process.stdout.write('IN:' + chunk));",
        'process.stdin.resume();',
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n')
    )

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
      const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
      server.store.configureAgentLaunch(
        workspace.id,
        worker.id,
        writeManagedProviderScriptLaunchConfig({ root: workspacePath, targetScript: script })
      )

      const startResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'start-transcript',
        kind: 'start_run',
        target: { agent_id: worker.id },
        workspace_id: workspace.id,
      })
      expect(startResponse.status).toBe(202)
      const started = (await startResponse.json()) as { result: { run_id: string } }
      await waitFor(() => {
        expect(server.store.getLiveRun(started.result.run_id).output).toContain('READY')
      })

      const encodedContent = pngFixture().toString('base64')
      const uploadResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({
          content_base64: encodedContent,
          name: 'photo.png',
        }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(uploadResponse.status).toBe(201)
      const uploaded = (await uploadResponse.json()) as {
        id: string
        local_path: string
      }

      const input = '[Image #1]\n'
      const inputResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'input-transcript-image',
        artifact_contract_version: MOBILE_ARTIFACT_CONTRACT_VERSION,
        kind: 'terminal_input',
        payload: {
          attachments: [{ file_id: uploaded.id, placeholder: '[Image #1]' }],
          input,
        },
        target: { run_id: started.result.run_id },
        workspace_id: workspace.id,
      })
      expect(inputResponse.status).toBe(202)
      const inputAction = (await inputResponse.json()) as { result: { bytes: number } }
      expect(inputAction.result.bytes).toBeGreaterThan(Buffer.byteLength(input))
      await waitFor(() => {
        expect(server.store.getLiveRun(started.result.run_id).output).toContain('[Image #1]')
      })

      const confirmationNonce = await createMobileConfirmationNonce(server.baseUrl, cookie, {
        kind: 'stop_run',
        target: { run_id: started.result.run_id },
        workspace_id: workspace.id,
      })
      const stopResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'stop-transcript-confirmed',
        kind: 'stop_run',
        payload: { confirmation_nonce: confirmationNonce },
        target: { run_id: started.result.run_id },
        workspace_id: workspace.id,
      })
      expect(stopResponse.status).toBe(202)
      const stopText = await stopResponse.text()
      expect(stopText).not.toContain(confirmationNonce)

      const token = server.store.peekAgentToken(worker.id)
      const response = await getTranscript(
        server.baseUrl,
        cookie,
        workspace.id,
        started.result.run_id
      )

      expect(response.status).toBe(200)
      const transcriptText = await response.text()
      expect(transcriptText).not.toContain(uploaded.local_path)
      expect(transcriptText).not.toContain(encodedContent)
      expect(transcriptText).not.toContain('content_base64')
      expect(transcriptText).not.toContain('local_path')
      expect(transcriptText).not.toContain('registry_path')
      expect(transcriptText).not.toContain(confirmationNonce)
      if (token) expect(transcriptText).not.toContain(token)

      const transcript = JSON.parse(transcriptText) as {
        attachments: Array<{
          file_id: string
          mime_type: string
          name: string
          placeholder: string
          size: number
        }>
        events: Array<Record<string, unknown>>
        run: { agent_id: string; agent_name: string; status: string }
        run_id: string
        workspace_id: string
      }

      expect(transcript.workspace_id).toBe(workspace.id)
      expect(transcript.run_id).toBe(started.result.run_id)
      expect(transcript.run).toEqual(
        expect.objectContaining({
          agent_id: worker.id,
          agent_name: 'Alice',
          status: 'exited',
        })
      )
      expect(transcript.attachments).toEqual([
        expect.objectContaining({
          file_id: uploaded.id,
          mime_type: 'image/png',
          name: 'photo.png',
          placeholder: '[Image #1]',
          size: pngFixture().byteLength,
        }),
      ])
      expect(transcript.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            run_id: started.result.run_id,
            status: 'exited',
            type: 'status',
          }),
          expect.objectContaining({
            raw_summary: expect.stringContaining('[redacted]'),
            text: expect.stringContaining('READY red'),
            type: 'terminal_output',
          }),
          expect.objectContaining({
            attachments: [
              {
                file_id: uploaded.id,
                placeholder: '[Image #1]',
              },
            ],
            bytes: inputAction.result.bytes,
            kind: 'terminal_input',
            run_id: started.result.run_id,
            type: 'mobile_action_echo',
          }),
          expect.objectContaining({
            bytes: null,
            confirmed: true,
            kind: 'stop_run',
            run_id: started.result.run_id,
            type: 'mobile_action_echo',
          }),
          expect.objectContaining({
            attachment: expect.objectContaining({
              file_id: uploaded.id,
            }),
            type: 'attachment',
          }),
        ])
      )
    } finally {
      await server.close()
    }
  }, 60000)
})
