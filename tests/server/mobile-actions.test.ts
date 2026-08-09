import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { setMobileNativeClipboardPasteForTests } from '../../src/server/mobile-native-clipboard.js'
import { MOBILE_ARTIFACT_CONTRACT_VERSION } from '../../src/shared/types.js'
import { writeManagedProviderScriptLaunchConfig } from '../helpers/managed-provider-script-fixture.js'
import { writeProviderAdapterFixture } from '../helpers/provider-adapter-fixture.js'
import { startTestServer } from '../helpers/test-server.js'
import { getMobileCookie, getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const originalCodexHome = process.env.CODEX_HOME
const uploadedImagePath = (id: string) => join(tmpdir(), 'hive-mobile-files', `${id}.png`)

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

const pngFixture = () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('png')])
const passiveScriptBody =
  "console.log('READY'); process.stdin.resume(); setTimeout(() => process.exit(0), 2500);\n"
const stdinListenerScriptLines = [
  "console.log('READY');",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  process.stdout.write('IN:' + chunk);",
  '  setTimeout(() => process.exit(0), 10);',
  '});',
  'process.stdin.resume();',
  'setTimeout(() => process.exit(0), 2500);',
  '',
]

const postMobileAction = (
  baseUrl: string,
  cookie: string | undefined,
  body: Record<string, unknown>
) => {
  const payload =
    typeof body.payload === 'object' && body.payload !== null
      ? (body.payload as Record<string, unknown>)
      : null
  const needsArtifactContract =
    body.kind === 'native_image_paste' ||
    (body.kind === 'terminal_input' &&
      Array.isArray(payload?.attachments) &&
      payload.attachments.length > 0)
  return fetch(`${baseUrl}/api/mobile/actions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({
      ...body,
      ...(needsArtifactContract
        ? { artifact_contract_version: MOBILE_ARTIFACT_CONTRACT_VERSION }
        : {}),
    }),
  })
}

const postMobileConfirmation = (
  baseUrl: string,
  cookie: string | undefined,
  body: Record<string, unknown>
) =>
  fetch(`${baseUrl}/api/mobile/confirmations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })

const createMobileConfirmationNonce = async (
  baseUrl: string,
  cookie: string,
  body: Record<string, unknown>
) => {
  const response = await postMobileConfirmation(baseUrl, cookie, body)
  expect(response.status).toBe(201)
  const confirmation = (await response.json()) as { nonce: string }
  return confirmation.nonce
}

const getMobileDispatches = (baseUrl: string, cookie: string | undefined, workspaceId: string) =>
  fetch(`${baseUrl}/api/mobile/dispatches?workspace_id=${encodeURIComponent(workspaceId)}`, {
    headers: {
      ...(cookie ? { cookie } : {}),
    },
  })

const getMobileTranscript = (
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
      headers: {
        ...(cookie ? { cookie } : {}),
      },
    }
  )

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  setMobileNativeClipboardPasteForTests(null)
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

test('mobile team_replace confirms and idempotently replaces one queued Dispatch', async () => {
  const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-team-replace-')
  const server = await startTestServer({ dataDir })
  try {
    const cookie = await getMobileCookie(server.baseUrl)
    const workspace = server.store.createWorkspace(workspacePath, 'Mobile replacement')
    const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
    const queued = await server.store.dispatchTask(workspace.id, worker.id, 'Incorrect queued task')
    const target = { dispatch_id: queued.id }
    const nonce = await createMobileConfirmationNonce(server.baseUrl, cookie, {
      kind: 'team_replace',
      target,
      workspace_id: workspace.id,
    })
    const body = {
      action_id: 'mobile-replace-fixed',
      kind: 'team_replace',
      payload: { confirmation_nonce: nonce, text: 'Corrected queued task' },
      target,
      workspace_id: workspace.id,
    }

    const response = await postMobileAction(server.baseUrl, cookie, body)
    expect(response.status, await response.clone().text()).toBe(202)
    const receipt = (await response.json()) as {
      result: { dispatch_id: string; replaced_dispatch_id: string }
    }
    expect(receipt.result).toMatchObject({
      dispatch_id: expect.any(String),
      replaced_dispatch_id: queued.id,
    })
    const retry = await postMobileAction(server.baseUrl, cookie, body)
    expect(retry.status).toBe(202)
    await expect(retry.json()).resolves.toMatchObject({ duplicate: true, result: receipt.result })
    expect(server.store.listDispatches(workspace.id)).toEqual([
      expect.objectContaining({
        id: queued.id,
        replacedBy: receipt.result.dispatch_id,
        status: 'replaced',
      }),
      expect.objectContaining({
        id: receipt.result.dispatch_id,
        replacesDispatchId: queued.id,
        status: 'queued',
      }),
    ])
  } finally {
    await server.close()
  }
})

describe('mobile actions api', () => {
  test('rejects anonymous actions before executing runtime operations', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-auth-')
    const server = await startTestServer({ dataDir })
    try {
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
      const worker = server.store.addWorker(workspace.id, { name: 'Alice' })

      const response = await postMobileAction(server.baseUrl, undefined, {
        action_id: 'start-1',
        workspace_id: workspace.id,
        kind: 'start_run',
        target: { agent_id: worker.id },
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        error: 'Mobile endpoint requires valid mobile token',
      })
      expect(server.store.listTerminalRuns(workspace.id)).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('rejects anonymous confirmations before issuing dangerous action nonces', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-confirm-auth-')
    const server = await startTestServer({ dataDir })
    try {
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
      const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
      const response = await postMobileConfirmation(server.baseUrl, undefined, {
        kind: 'restart_run',
        target: { agent_id: worker.id },
        workspace_id: workspace.id,
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        error: 'Mobile endpoint requires valid mobile token',
      })

      const forgedDangerousAction = await postMobileAction(server.baseUrl, undefined, {
        action_id: 'anonymous-restart-without-nonce',
        kind: 'restart_run',
        payload: { confirmation_nonce: 'forged-nonce' },
        target: { agent_id: worker.id },
        workspace_id: workspace.id,
      })
      expect(forgedDangerousAction.status).toBe(403)
      await expect(forgedDangerousAction.json()).resolves.toEqual({
        error: 'Mobile endpoint requires valid mobile token',
      })
      expect(server.store.listTerminalRuns(workspace.id)).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('accepts mobile-token cookies without the UI cookie for mobile actions', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-mobile-token-')
    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getMobileCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')

      const response = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'terminal-input-with-mobile-token',
        kind: 'terminal_input',
        payload: { input: 'hello' },
        target: { run_id: 'missing-run' },
        workspace_id: workspace.id,
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        error: 'Run not found in workspace: missing-run',
      })
    } finally {
      await server.close()
    }
  })

  test('returns clear validation errors for unsupported kinds and malformed targets', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-validation-')
    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')

      const invalidKind = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'bad-kind',
        workspace_id: workspace.id,
        kind: 'delete_workspace',
        target: {},
      })
      expect(invalidKind.status).toBe(400)
      await expect(invalidKind.json()).resolves.toEqual({
        error: 'Unsupported mobile action kind: delete_workspace',
      })

      const malformedTarget = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'bad-target',
        workspace_id: workspace.id,
        kind: 'terminal_input',
        target: {},
        payload: { input: 'hello' },
      })
      expect(malformedTarget.status).toBe(400)
      await expect(malformedTarget.json()).resolves.toEqual({
        error: 'target.run_id is required',
      })

      const emptyInput = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'empty-input',
        workspace_id: workspace.id,
        kind: 'terminal_input',
        target: { run_id: 'run-1' },
        payload: { input: '' },
      })
      expect(emptyInput.status).toBe(400)
      await expect(emptyInput.json()).resolves.toEqual({
        error: 'payload.input is required',
      })

      const missingStartAgent = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'missing-start-agent',
        workspace_id: workspace.id,
        kind: 'start_run',
        target: {},
      })
      expect(missingStartAgent.status).toBe(400)
      await expect(missingStartAgent.json()).resolves.toEqual({
        error: 'target.agent_id is required',
      })

      const missingRestartAgent = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'missing-restart-agent',
        workspace_id: workspace.id,
        kind: 'restart_run',
        target: { run_id: 'run-1' },
      })
      expect(missingRestartAgent.status).toBe(400)
      await expect(missingRestartAgent.json()).resolves.toEqual({
        error: 'target.agent_id is required',
      })
    } finally {
      await server.close()
    }
  })

  test('rejects missing workspaces and agents without leaking CLI agent tokens', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-targets-')
    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
      const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
      const token = server.store.peekAgentToken(worker.id)

      const missingWorkspace = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'missing-workspace',
        workspace_id: 'missing-workspace',
        kind: 'start_run',
        target: { agent_id: worker.id },
      })
      expect(missingWorkspace.status).toBe(400)
      const missingWorkspaceText = await missingWorkspace.text()
      expect(missingWorkspaceText).toContain('Workspace not found: missing-workspace')
      expect(missingWorkspaceText).not.toContain('HIVE_AGENT_TOKEN')
      expect(missingWorkspaceText).not.toContain('x-hive-agent-token')
      expect(missingWorkspaceText).not.toContain('agent_token')
      if (token) expect(missingWorkspaceText).not.toContain(token)

      const missingAgent = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'missing-agent',
        workspace_id: workspace.id,
        kind: 'start_run',
        target: { agent_id: 'missing-agent' },
      })
      expect(missingAgent.status).toBe(400)
      const missingAgentText = await missingAgent.text()
      expect(missingAgentText).toContain('Agent not found in workspace: missing-agent')
      expect(missingAgentText).not.toContain('HIVE_AGENT_TOKEN')
      expect(missingAgentText).not.toContain('x-hive-agent-token')
      expect(missingAgentText).not.toContain('agent_token')
      if (token) expect(missingAgentText).not.toContain(token)
    } finally {
      await server.close()
    }
  })

  test('starts a run and writes terminal input to the real run stdin', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-stdin-')
    const script = join(workspacePath, 'stdin-listener.cjs')
    writeFileSync(script, stdinListenerScriptLines.join('\n'))

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
      const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
      const otherWorker = server.store.addWorker(workspace.id, { name: 'Bob' })
      server.store.configureAgentLaunch(
        workspace.id,
        worker.id,
        writeManagedProviderScriptLaunchConfig({ root: workspacePath, targetScript: script })
      )
      server.store.configureAgentLaunch(
        workspace.id,
        otherWorker.id,
        writeManagedProviderScriptLaunchConfig({ root: workspacePath, targetScript: script })
      )

      const startResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'start-stdin',
        workspace_id: workspace.id,
        kind: 'start_run',
        target: { agent_id: worker.id },
      })
      expect(startResponse.status).toBe(202)
      const startText = await startResponse.text()
      expect(startText).not.toContain('HIVE_AGENT_TOKEN')
      expect(startText).not.toContain('x-hive-agent-token')
      expect(startText).not.toContain('agent_token')
      expect(startText).not.toContain(server.store.peekAgentToken(worker.id) ?? 'missing-token')
      const started = JSON.parse(startText) as {
        action_id: string
        kind: string
        ok: boolean
        result: { agent_id: string; run_id: string; status: string }
        workspace_id: string
      }
      expect(started).toEqual({
        action_id: 'start-stdin',
        kind: 'start_run',
        ok: true,
        result: {
          agent_id: worker.id,
          run_id: expect.any(String),
          status: expect.stringMatching(/^(running|starting)$/),
        },
        workspace_id: workspace.id,
      })
      await waitFor(() => {
        expect(server.store.getLiveRun(started.result.run_id).output).toContain('READY')
      })

      const inputResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'input-stdin',
        workspace_id: workspace.id,
        kind: 'terminal_input',
        target: { run_id: started.result.run_id },
        payload: { input: 'hello from mobile\n' },
      })
      expect(inputResponse.status).toBe(202)
      const inputText = await inputResponse.text()
      expect(inputText).not.toContain('HIVE_AGENT_TOKEN')
      expect(inputText).not.toContain('x-hive-agent-token')
      expect(inputText).not.toContain('agent_token')
      expect(inputText).not.toContain(server.store.peekAgentToken(worker.id) ?? 'missing-token')
      expect(JSON.parse(inputText)).toEqual({
        action_id: 'input-stdin',
        kind: 'terminal_input',
        ok: true,
        result: {
          bytes: Buffer.byteLength('hello from mobile\n'),
          run_id: started.result.run_id,
        },
        workspace_id: workspace.id,
      })

      await waitFor(() => {
        expect(server.store.getLiveRun(started.result.run_id).output).toContain('hello from mobile')
      })
    } finally {
      await server.close()
    }
  }, 60000)

  test('deduplicates repeated mobile action ids without replaying terminal input', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-dedupe-')
    const script = join(workspacePath, 'stdin-listener.cjs')
    writeFileSync(script, stdinListenerScriptLines.join('\n'))

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
      const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
      const otherWorker = server.store.addWorker(workspace.id, { name: 'Bob' })
      server.store.configureAgentLaunch(
        workspace.id,
        worker.id,
        writeManagedProviderScriptLaunchConfig({ root: workspacePath, targetScript: script })
      )
      server.store.configureAgentLaunch(
        workspace.id,
        otherWorker.id,
        writeManagedProviderScriptLaunchConfig({ root: workspacePath, targetScript: script })
      )

      const startResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'start-dedupe',
        workspace_id: workspace.id,
        kind: 'start_run',
        target: { agent_id: worker.id },
      })
      expect(startResponse.status).toBe(202)
      const started = (await startResponse.json()) as { result: { run_id: string } }
      await waitFor(() => {
        expect(server.store.getLiveRun(started.result.run_id).output).toContain('READY')
      })

      const inputBody = {
        action_id: 'input-dedupe',
        workspace_id: workspace.id,
        kind: 'terminal_input',
        target: { run_id: started.result.run_id },
        payload: { input: 'dedupe once\n' },
      }
      const firstResponse = await postMobileAction(server.baseUrl, cookie, inputBody)
      expect(firstResponse.status).toBe(202)
      const first = await firstResponse.json()
      expect(first).toEqual({
        action_id: 'input-dedupe',
        kind: 'terminal_input',
        ok: true,
        result: {
          bytes: Buffer.byteLength('dedupe once\n'),
          run_id: started.result.run_id,
        },
        workspace_id: workspace.id,
      })

      const duplicateResponse = await postMobileAction(server.baseUrl, cookie, inputBody)
      expect(duplicateResponse.status).toBe(202)
      await expect(duplicateResponse.json()).resolves.toEqual({
        ...first,
        duplicate: true,
      })

      await waitFor(() => {
        const output = server.store.getLiveRun(started.result.run_id).output
        expect(output).toContain('dedupe once')
      })
      const output = server.store.getLiveRun(started.result.run_id).output
      expect(output.match(/dedupe once/gu)).toHaveLength(1)

      const conflictingResponse = await postMobileAction(server.baseUrl, cookie, {
        ...inputBody,
        payload: { input: 'different replay\n' },
      })
      expect(conflictingResponse.status).toBe(400)
      await expect(conflictingResponse.json()).resolves.toEqual({
        error: 'Duplicate mobile action_id with different payload: input-dedupe',
      })
    } finally {
      await server.close()
    }
  }, 60000)
  test('handles team tasks through mobile-token actions without CLI agent tokens', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-team-')
    for (const artifact of ['mobile-note.md', 'notes.md', 'result.md']) {
      writeFileSync(join(workspacePath, artifact), `Artifact fixture: ${artifact}\n`)
    }
    const providerFixture = writeProviderAdapterFixture({
      fixtureId: 'mobile-team-actions',
      provider: 'codex',
      root: dataDir,
      workspacePath,
    })
    process.env.CODEX_HOME = join(dataDir, 'codex-home')
    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getMobileCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
      const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
      server.store.configureAgentLaunch(workspace.id, worker.id, {
        ...buildManagedProviderLaunchConfig('codex'),
        args: [],
        command: providerFixture.command,
        interactiveCommand: providerFixture.command,
      })
      await server.store.startAgent(workspace.id, worker.id, {
        hivePort: new URL(server.baseUrl).port,
      })
      await waitFor(() => {
        expect(server.store.getAgentState(workspace.id, worker.id)).toMatchObject({
          conversationActivity: 'idle',
          processState: 'running',
        })
      })
      const orchestratorToken = server.store.peekAgentToken(`${workspace.id}:orchestrator`)
      const workerToken = server.store.peekAgentToken(worker.id)
      let capturedDispatchInput:
        | {
            fromAgentId?: string
            hivePort?: string
          }
        | undefined
      const dispatchTaskByWorkerName = server.store.dispatchTaskByWorkerName
      server.store.dispatchTaskByWorkerName = async (workspaceId, workerName, text, input) => {
        capturedDispatchInput = input
        expect(workspaceId).toBe(workspace.id)
        expect(workerName).toBe('Alice')
        return dispatchTaskByWorkerName(workspaceId, workerName, text, input)
      }

      const sendResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'team-send-1',
        kind: 'team_send',
        payload: { text: 'Check the mobile remote control path.' },
        target: { to: 'Alice' },
        workspace_id: workspace.id,
      })

      expect(sendResponse.status).toBe(202)
      const sendBody = (await sendResponse.json()) as {
        result: { dispatch_id: string; to: string }
      }
      expect(sendBody.result.to).toBe('Alice')
      expect(sendBody.result.dispatch_id).toEqual(expect.any(String))
      const sendText = JSON.stringify(sendBody)
      expect(sendText).not.toContain('HIVE_AGENT_TOKEN')
      expect(sendText).not.toContain('x-hive-agent-token')
      expect(sendText).not.toContain('agent_token')
      if (orchestratorToken) expect(sendText).not.toContain(orchestratorToken)
      if (workerToken) expect(sendText).not.toContain(workerToken)

      const dispatchesResponse = await getMobileDispatches(server.baseUrl, cookie, workspace.id)
      expect(dispatchesResponse.status).toBe(200)
      const dispatchesText = await dispatchesResponse.text()
      expect(dispatchesText).toContain(sendBody.result.dispatch_id)
      expect(dispatchesText).toContain('Check the mobile remote control path.')
      expect(dispatchesText).not.toContain('HIVE_AGENT_TOKEN')
      expect(dispatchesText).not.toContain('x-hive-agent-token')
      expect(dispatchesText).not.toContain('agent_token')
      if (orchestratorToken) expect(dispatchesText).not.toContain(orchestratorToken)
      if (workerToken) expect(dispatchesText).not.toContain(workerToken)

      const [dispatch] = server.store.listDispatches(workspace.id)
      expect(dispatch).toEqual(
        expect.objectContaining({
          status: 'submitted',
          text: 'Check the mobile remote control path.',
          toAgentId: worker.id,
        })
      )
      expect(capturedDispatchInput).toEqual(
        expect.objectContaining({
          fromAgentId: `${workspace.id}:orchestrator`,
          hivePort: expect.any(String),
        })
      )

      providerFixture.appendUser('Check the mobile remote control path.')
      providerFixture.appendAssistant('Initial mobile Dispatch turn completed')
      providerFixture.appendCompletion()
      await waitFor(() => {
        expect(server.store.getCurrentAgentConversation(workspace.id, worker.id)).toMatchObject({
          activity_state: 'idle',
          turns: expect.arrayContaining([
            expect.objectContaining({ text: 'Initial mobile Dispatch turn completed' }),
          ]),
        })
      })

      const noteAction = {
        action_id: 'team-note-1',
        kind: 'team_note',
        payload: {
          artifacts: ['mobile-note.md'],
          text: 'Also verify the safe supplemental context path.',
        },
        target: { dispatch_id: sendBody.result.dispatch_id },
        workspace_id: workspace.id,
      }
      const forcedNoteResponse = await postMobileAction(server.baseUrl, cookie, {
        ...noteAction,
        action_id: 'team-note-force',
        payload: { ...noteAction.payload, force: true },
      })
      expect(forcedNoteResponse.status).toBe(400)
      await expect(forcedNoteResponse.json()).resolves.toMatchObject({
        error: 'force delivery is not supported for Dispatch Notes',
      })
      const noteResponse = await postMobileAction(server.baseUrl, cookie, noteAction)
      expect(noteResponse.status).toBe(202)
      const noteBody = (await noteResponse.json()) as {
        result: {
          created: boolean
          delivery_state: string
          dispatch_id: string
          note_id: string
        }
      }
      expect(noteBody.result).toMatchObject({
        created: true,
        dispatch_id: sendBody.result.dispatch_id,
        note_id: 'team-note-1',
      })
      expect(JSON.stringify(noteBody)).not.toContain('agent_token')
      await waitFor(() => {
        expect(server.store.listDispatchNotes(workspace.id, sendBody.result.dispatch_id)).toEqual([
          expect.objectContaining({
            actorId: 'mobile-user',
            actorType: 'user',
            artifacts: ['mobile-note.md'],
            deliveryState: 'delivered',
            id: 'team-note-1',
            text: 'Also verify the safe supplemental context path.',
          }),
        ])
        expect(
          providerFixture
            .readEvents()
            .some(
              (event) =>
                event.kind === 'stdin' &&
                event.text?.includes('"id":"team-note-1"') &&
                event.text.includes('"actor":{"id":"mobile-user","type":"user"}')
            )
        ).toBe(true)
      })

      const duplicateNoteResponse = await postMobileAction(server.baseUrl, cookie, noteAction)
      expect(duplicateNoteResponse.status).toBe(202)
      await expect(duplicateNoteResponse.json()).resolves.toMatchObject({
        duplicate: true,
        result: { created: true, note_id: 'team-note-1' },
      })
      expect(
        server.store.listDispatchNotes(workspace.id, sendBody.result.dispatch_id)
      ).toHaveLength(1)

      const statusResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'team-status-1',
        kind: 'team_status',
        payload: {
          artifacts: ['notes.md'],
          notify: true,
          text: 'Alice is checking the mobile path.',
        },
        target: { agent_id: worker.id },
        workspace_id: workspace.id,
      })
      expect(statusResponse.status).toBe(202)
      const statusText = await statusResponse.text()
      expect(statusText).toContain(worker.id)
      expect(statusText).toContain('"notify":true')
      expect(statusText).toContain('"request_id":"team-status-1"')
      expect(statusText).not.toContain('HIVE_AGENT_TOKEN')
      expect(statusText).not.toContain('x-hive-agent-token')
      expect(statusText).not.toContain('agent_token')
      if (orchestratorToken) expect(statusText).not.toContain(orchestratorToken)
      if (workerToken) expect(statusText).not.toContain(workerToken)
      expect(server.store.getLatestStatus(workspace.id, worker.id)).toMatchObject({
        artifacts: ['notes.md'],
        from: worker.id,
        requestId: 'team-status-1',
        notify: true,
        text: 'Alice is checking the mobile path.',
        type: 'status',
      })

      const legacyReportResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'team-report-legacy',
        kind: 'team_report',
        payload: { status: 'done', text: 'Legacy report attempt.' },
        target: { agent_id: worker.id, dispatch_id: sendBody.result.dispatch_id },
        workspace_id: workspace.id,
      })
      expect(legacyReportResponse.status).toBe(400)
      await expect(legacyReportResponse.json()).resolves.toEqual({
        error:
          'Mobile Report binds automatically and uses outcome; legacy dispatch_id/status is not accepted',
      })

      const reportResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'team-report-1',
        kind: 'team_report',
        payload: {
          artifacts: ['result.md'],
          text: 'Finished from mobile.',
        },
        target: { agent_id: worker.id },
        workspace_id: workspace.id,
      })
      expect(reportResponse.status).toBe(202)
      const reportText = await reportResponse.text()
      expect(reportText).toContain(sendBody.result.dispatch_id)
      expect(reportText).not.toContain('HIVE_AGENT_TOKEN')
      expect(reportText).not.toContain('x-hive-agent-token')
      expect(reportText).not.toContain('agent_token')
      if (orchestratorToken) expect(reportText).not.toContain(orchestratorToken)
      if (workerToken) expect(reportText).not.toContain(workerToken)
      expect(server.store.listDispatches(workspace.id)).toEqual([
        expect.objectContaining({
          artifacts: ['result.md'],
          id: sendBody.result.dispatch_id,
          reportOutcome: 'completed',
          reportText: 'Finished from mobile.',
          status: 'reported',
        }),
      ])

      const secondSendResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'team-send-2',
        kind: 'team_send',
        payload: { text: 'Prepare cancellation path.' },
        target: { to: 'Alice' },
        workspace_id: workspace.id,
      })
      expect(secondSendResponse.status).toBe(202)
      const secondSendBody = (await secondSendResponse.json()) as {
        result: { dispatch_id: string; to: string }
      }

      const rejectedCancel = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'team-cancel-no-confirmation',
        kind: 'team_cancel',
        payload: { reason: 'Cancelled from mobile' },
        target: { dispatch_id: secondSendBody.result.dispatch_id },
        workspace_id: workspace.id,
      })
      expect(rejectedCancel.status).toBe(400)
      await expect(rejectedCancel.json()).resolves.toEqual({
        error: 'payload.confirmation_nonce is required',
      })

      const nonce = await createMobileConfirmationNonce(server.baseUrl, cookie, {
        kind: 'team_cancel',
        target: { dispatch_id: secondSendBody.result.dispatch_id },
        workspace_id: workspace.id,
      })

      const cancelResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'team-cancel-1',
        kind: 'team_cancel',
        payload: { confirmation_nonce: nonce, reason: 'Cancelled from mobile' },
        target: { dispatch_id: secondSendBody.result.dispatch_id },
        workspace_id: workspace.id,
      })

      expect(cancelResponse.status).toBe(202)
      const cancelText = await cancelResponse.text()
      expect(cancelText).toContain(secondSendBody.result.dispatch_id)
      expect(cancelText).not.toContain('HIVE_AGENT_TOKEN')
      expect(cancelText).not.toContain('x-hive-agent-token')
      expect(cancelText).not.toContain('agent_token')
      if (orchestratorToken) expect(cancelText).not.toContain(orchestratorToken)
      if (workerToken) expect(cancelText).not.toContain(workerToken)
      expect(server.store.listDispatches(workspace.id)).toEqual([
        expect.objectContaining({
          id: sendBody.result.dispatch_id,
          status: 'reported',
        }),
        expect.objectContaining({
          id: secondSendBody.result.dispatch_id,
          status: 'cancelled',
        }),
      ])
    } finally {
      await server.close()
    }
  })

  test('does not cache failed mobile actions before a later valid retry', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-failed-cache-')
    const script = join(workspacePath, 'passive.cjs')
    writeFileSync(script, passiveScriptBody)

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
      const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
      const otherWorker = server.store.addWorker(workspace.id, { name: 'Bob' })
      server.store.configureAgentLaunch(
        workspace.id,
        worker.id,
        writeManagedProviderScriptLaunchConfig({ root: workspacePath, targetScript: script })
      )
      server.store.configureAgentLaunch(
        workspace.id,
        otherWorker.id,
        writeManagedProviderScriptLaunchConfig({ root: workspacePath, targetScript: script })
      )

      const failedResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'retry-after-failure',
        workspace_id: workspace.id,
        kind: 'terminal_input',
        target: { run_id: 'missing-run' },
        payload: { input: 'should not cache\n' },
      })
      expect(failedResponse.status).toBe(400)
      await expect(failedResponse.json()).resolves.toEqual({
        error: 'Run not found in workspace: missing-run',
      })

      const retryResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'retry-after-failure',
        workspace_id: workspace.id,
        kind: 'start_run',
        target: { agent_id: worker.id },
      })
      expect(retryResponse.status).toBe(202)
      const retried = (await retryResponse.json()) as {
        duplicate?: boolean
        result: { agent_id: string; run_id: string; status: string }
      }
      expect(retried).toEqual({
        action_id: 'retry-after-failure',
        kind: 'start_run',
        ok: true,
        result: {
          agent_id: worker.id,
          run_id: expect.any(String),
          status: expect.stringMatching(/^(running|starting)$/),
        },
        workspace_id: workspace.id,
      })
      expect(retried.duplicate).toBeUndefined()
      await waitFor(() => {
        expect(server.store.getLiveRun(retried.result.run_id).output).toContain('READY')
      })
    } finally {
      await server.close()
    }
  }, 60000)

  test('keeps mobile action dedupe scoped to each workspace', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-dedupe-scope-')
    const otherWorkspacePath = join(dataDir, 'other')
    mkdirSync(otherWorkspacePath, { recursive: true })
    const script = join(workspacePath, 'passive.cjs')
    const otherScript = join(otherWorkspacePath, 'passive.cjs')
    writeFileSync(script, passiveScriptBody)
    writeFileSync(otherScript, passiveScriptBody)

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
      const otherWorkspace = server.store.createWorkspace(otherWorkspacePath, 'Beta')
      const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
      const otherWorker = server.store.addWorker(otherWorkspace.id, { name: 'Bob' })
      server.store.configureAgentLaunch(
        workspace.id,
        worker.id,
        writeManagedProviderScriptLaunchConfig({ root: workspacePath, targetScript: script })
      )
      server.store.configureAgentLaunch(
        otherWorkspace.id,
        otherWorker.id,
        writeManagedProviderScriptLaunchConfig({
          root: otherWorkspacePath,
          targetScript: otherScript,
        })
      )

      const firstResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'same-action-id',
        workspace_id: workspace.id,
        kind: 'start_run',
        target: { agent_id: worker.id },
      })
      expect(firstResponse.status).toBe(202)
      const first = (await firstResponse.json()) as {
        duplicate?: boolean
        result: { run_id: string }
        workspace_id: string
      }
      expect(first.workspace_id).toBe(workspace.id)
      expect(first.duplicate).toBeUndefined()

      const secondResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'same-action-id',
        workspace_id: otherWorkspace.id,
        kind: 'start_run',
        target: { agent_id: otherWorker.id },
      })
      expect(secondResponse.status).toBe(202)
      const second = (await secondResponse.json()) as {
        duplicate?: boolean
        result: { run_id: string }
        workspace_id: string
      }
      expect(second.workspace_id).toBe(otherWorkspace.id)
      expect(second.duplicate).toBeUndefined()
      expect(second.result.run_id).not.toBe(first.result.run_id)

      await waitFor(() => {
        expect(server.store.getLiveRun(first.result.run_id).output).toContain('READY')
        expect(server.store.getLiveRun(second.result.run_id).output).toContain('READY')
      })
    } finally {
      await server.close()
    }
  }, 60000)

  test('stops and restarts runs through UI-cookie mobile actions', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-lifecycle-')
    const script = join(workspacePath, 'passive.cjs')
    writeFileSync(script, passiveScriptBody)

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
      const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
      const otherWorker = server.store.addWorker(workspace.id, { name: 'Bob' })
      server.store.configureAgentLaunch(
        workspace.id,
        worker.id,
        writeManagedProviderScriptLaunchConfig({ root: workspacePath, targetScript: script })
      )
      server.store.configureAgentLaunch(
        workspace.id,
        otherWorker.id,
        writeManagedProviderScriptLaunchConfig({ root: workspacePath, targetScript: script })
      )

      const startResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'start-lifecycle',
        workspace_id: workspace.id,
        kind: 'start_run',
        target: { agent_id: worker.id },
      })
      expect(startResponse.status).toBe(202)
      const started = (await startResponse.json()) as { result: { run_id: string } }
      await waitFor(() => {
        expect(server.store.getLiveRun(started.result.run_id).output).toContain('READY')
      })

      const stopBody = {
        action_id: 'stop-lifecycle',
        workspace_id: workspace.id,
        kind: 'stop_run',
        payload: {
          confirmation_nonce: await createMobileConfirmationNonce(server.baseUrl, cookie, {
            workspace_id: workspace.id,
            kind: 'stop_run',
            target: { run_id: started.result.run_id },
          }),
        },
        target: { run_id: started.result.run_id },
      }
      const stopResponse = await postMobileAction(server.baseUrl, cookie, stopBody)
      const stopResponseBody = await stopResponse.text()
      expect(stopResponse.status, stopResponseBody).toBe(202)
      const stopped = JSON.parse(stopResponseBody)
      expect(stopped).toEqual({
        action_id: 'stop-lifecycle',
        kind: 'stop_run',
        ok: true,
        result: {
          mode: 'safe',
          reason: null,
          run_id: started.result.run_id,
          session_id: null,
          state: 'stopped',
        },
        workspace_id: workspace.id,
      })
      const duplicateStopResponse = await postMobileAction(server.baseUrl, cookie, stopBody)
      expect(duplicateStopResponse.status).toBe(202)
      await expect(duplicateStopResponse.json()).resolves.toEqual({
        ...stopped,
        duplicate: true,
      })

      await waitFor(() => {
        expect(server.store.listTerminalRuns(workspace.id)).not.toContainEqual(
          expect.objectContaining({ run_id: started.result.run_id })
        )
      })

      const restartStart = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'start-before-restart',
        workspace_id: workspace.id,
        kind: 'start_run',
        target: { agent_id: worker.id },
      })
      expect(restartStart.status).toBe(202)
      const beforeRestart = (await restartStart.json()) as { result: { run_id: string } }
      await waitFor(() => {
        expect(server.store.getLiveRun(beforeRestart.result.run_id).output).toContain('READY')
      })

      const restartResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'restart-lifecycle',
        workspace_id: workspace.id,
        kind: 'restart_run',
        payload: {
          confirmation_nonce: await createMobileConfirmationNonce(server.baseUrl, cookie, {
            workspace_id: workspace.id,
            kind: 'restart_run',
            target: { agent_id: worker.id, run_id: beforeRestart.result.run_id },
          }),
        },
        target: { agent_id: worker.id, run_id: beforeRestart.result.run_id },
      })
      expect(restartResponse.status).toBe(202)
      const restarted = (await restartResponse.json()) as {
        result: { agent_id: string; run_id: string; status: string; stopped_run_id: string }
      }
      expect(restarted).toEqual({
        action_id: 'restart-lifecycle',
        kind: 'restart_run',
        ok: true,
        result: {
          agent_id: worker.id,
          run_id: expect.any(String),
          status: expect.stringMatching(/^(running|starting)$/),
          stopped_run_id: beforeRestart.result.run_id,
        },
        workspace_id: workspace.id,
      })
      expect(restarted.result.run_id).not.toBe(beforeRestart.result.run_id)
    } finally {
      await server.close()
    }
  }, 60000)

  test('requires one-time confirmation nonces for dangerous mobile actions', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-confirm-')
    const script = join(workspacePath, 'passive.cjs')
    writeFileSync(script, passiveScriptBody)

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
      const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
      const otherWorker = server.store.addWorker(workspace.id, { name: 'Bob' })
      server.store.configureAgentLaunch(
        workspace.id,
        worker.id,
        writeManagedProviderScriptLaunchConfig({ root: workspacePath, targetScript: script })
      )
      server.store.configureAgentLaunch(
        workspace.id,
        otherWorker.id,
        writeManagedProviderScriptLaunchConfig({ root: workspacePath, targetScript: script })
      )

      const startResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'start-confirm',
        workspace_id: workspace.id,
        kind: 'start_run',
        target: { agent_id: worker.id },
      })
      expect(startResponse.status).toBe(202)
      const started = (await startResponse.json()) as { result: { run_id: string } }
      await waitFor(() => {
        expect(server.store.getLiveRun(started.result.run_id).output).toContain('READY')
      })

      const missingNonce = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'stop-missing-confirmation',
        workspace_id: workspace.id,
        kind: 'stop_run',
        target: { run_id: started.result.run_id },
      })
      expect(missingNonce.status).toBe(400)
      await expect(missingNonce.json()).resolves.toEqual({
        error: 'payload.confirmation_nonce is required',
      })

      const nonce = await createMobileConfirmationNonce(server.baseUrl, cookie, {
        workspace_id: workspace.id,
        kind: 'stop_run',
        target: { run_id: started.result.run_id },
      })
      const otherStart = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'start-confirm-other',
        workspace_id: workspace.id,
        kind: 'start_run',
        target: { agent_id: otherWorker.id },
      })
      expect(otherStart.status).toBe(202)
      const otherStarted = (await otherStart.json()) as { result: { run_id: string } }
      const mismatched = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'stop-mismatch-confirmation',
        workspace_id: workspace.id,
        kind: 'stop_run',
        payload: { confirmation_nonce: nonce },
        target: { run_id: otherStarted.result.run_id },
      })
      expect(mismatched.status).toBe(400)
      await expect(mismatched.json()).resolves.toEqual({
        error: 'Mobile confirmation nonce does not match this action',
      })

      const replay = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'stop-replay-confirmation',
        workspace_id: workspace.id,
        kind: 'stop_run',
        payload: { confirmation_nonce: nonce },
        target: { run_id: started.result.run_id },
      })
      expect(replay.status).toBe(400)
      await expect(replay.json()).resolves.toEqual({
        error: 'Invalid or expired mobile confirmation nonce',
      })

      const validNonce = await createMobileConfirmationNonce(server.baseUrl, cookie, {
        workspace_id: workspace.id,
        kind: 'stop_run',
        target: { run_id: started.result.run_id },
      })
      const valid = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'stop-valid-confirmation',
        workspace_id: workspace.id,
        kind: 'stop_run',
        payload: { confirmation_nonce: validNonce },
        target: { run_id: started.result.run_id },
      })
      expect(valid.status).toBe(202)

      const duplicateNonceUse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'stop-second-confirmation',
        workspace_id: workspace.id,
        kind: 'stop_run',
        payload: { confirmation_nonce: validNonce },
        target: { run_id: started.result.run_id },
      })
      expect(duplicateNonceUse.status).toBe(400)
      await expect(duplicateNonceUse.json()).resolves.toEqual({
        error: 'Invalid or expired mobile confirmation nonce',
      })
    } finally {
      await server.close()
    }
  }, 60000)

  test('rejects run ids that belong to another workspace', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-cross-')
    const otherWorkspacePath = join(dataDir, 'other')
    mkdirSync(otherWorkspacePath, { recursive: true })
    const script = join(workspacePath, 'passive.cjs')
    writeFileSync(script, 'process.stdin.resume(); setTimeout(() => process.exit(0), 2500);\n')

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

      const startResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'start-cross',
        workspace_id: workspace.id,
        kind: 'start_run',
        target: { agent_id: worker.id },
      })
      expect(startResponse.status).toBe(202)
      const started = (await startResponse.json()) as { result: { run_id: string } }

      const response = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'input-cross',
        workspace_id: otherWorkspace.id,
        kind: 'terminal_input',
        target: { run_id: started.result.run_id },
        payload: { input: 'nope' },
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        error: `Run not found in workspace: ${started.result.run_id}`,
      })
    } finally {
      await server.close()
    }
  }, 60000)

  test('binds mobile image placeholders to safe Artifacts without writing local paths to PTY', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-image-')
    const script = join(workspacePath, 'stdin-listener.cjs')
    writeFileSync(script, stdinListenerScriptLines.join('\n'))

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

      const uploadResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({
          content_base64: pngFixture().toString('base64'),
          name: 'photo.png',
        }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(uploadResponse.status).toBe(201)
      const uploaded = (await uploadResponse.json()) as {
        id: string
        local_path: string
        mime_type: string
        name: string
        size: number
      }

      const startResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'start-image',
        workspace_id: workspace.id,
        kind: 'start_run',
        target: { agent_id: worker.id },
      })
      expect(startResponse.status).toBe(202)
      const started = (await startResponse.json()) as { result: { run_id: string } }
      await waitFor(() => {
        expect(server.store.getLiveRun(started.result.run_id).output).toContain('READY')
      })

      const input = `\u001b[200~Please inspect why agent_token and local_path mention ${uploaded.id} [Image #1]\u001b[201~`
      const traversalResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: '../../escaped-terminal-attachment',
        workspace_id: workspace.id,
        kind: 'terminal_input',
        target: { run_id: started.result.run_id },
        payload: {
          attachments: [{ file_id: uploaded.id, placeholder: '[Image #1]' }],
          input,
        },
      })
      expect(traversalResponse.status).toBe(400)
      expect(existsSync(join(workspacePath, 'escaped-terminal-attachment'))).toBe(false)

      const durableAttachment = join(
        workspacePath,
        '.hive',
        'chat-attachments',
        'durable-submission',
        'keep.png'
      )
      mkdirSync(join(durableAttachment, '..'), { recursive: true })
      writeFileSync(durableAttachment, pngFixture())
      for (const unsafeActionId of ['.', '/']) {
        const aliasResponse = await postMobileAction(server.baseUrl, cookie, {
          action_id: unsafeActionId,
          workspace_id: workspace.id,
          kind: 'terminal_input',
          target: { run_id: started.result.run_id },
          payload: {
            attachments: [
              { file_id: uploaded.id, placeholder: '[Image #1]' },
              { file_id: 'missing-file', placeholder: '[Image #2]' },
            ],
            input: '\u001b[200~[Image #1][Image #2]\u001b[201~',
          },
        })
        expect(aliasResponse.status).toBe(400)
        expect(existsSync(durableAttachment)).toBe(true)
      }

      const outsideAttachmentTarget = join(dataDir, 'outside-attachment-target')
      const linkedBinding = join(
        workspacePath,
        '.hive',
        'chat-attachments',
        'linked-terminal-action'
      )
      mkdirSync(outsideAttachmentTarget)
      symlinkSync(outsideAttachmentTarget, linkedBinding, 'junction')
      try {
        const linkedResponse = await postMobileAction(server.baseUrl, cookie, {
          action_id: 'linked-terminal-action',
          workspace_id: workspace.id,
          kind: 'terminal_input',
          target: { run_id: started.result.run_id },
          payload: {
            attachments: [{ file_id: uploaded.id, placeholder: '[Image #1]' }],
            input,
          },
        })
        expect(linkedResponse.status).toBe(400)
        expect(await linkedResponse.text()).not.toContain(workspacePath)
        expect(readdirSync(outsideAttachmentTarget)).toEqual([])
      } finally {
        unlinkSync(linkedBinding)
      }

      const unversionedResponse = await fetch(`${server.baseUrl}/api/mobile/actions`, {
        body: JSON.stringify({
          action_id: 'unversioned-image',
          kind: 'terminal_input',
          payload: {
            attachments: [{ file_id: uploaded.id, placeholder: '[Image #1]' }],
            input,
          },
          target: { run_id: started.result.run_id },
          workspace_id: workspace.id,
        }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(unversionedResponse.status).toBe(426)
      await expect(unversionedResponse.json()).resolves.toEqual({
        code: 'mobile_artifact_contract_upgrade_required',
        error: `Mobile attachment actions require Artifact contract version ${MOBILE_ARTIFACT_CONTRACT_VERSION}`,
      })
      expect(
        existsSync(join(workspacePath, '.hive', 'chat-attachments', 'unversioned-image'))
      ).toBe(false)

      const inputResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'input-image',
        workspace_id: workspace.id,
        kind: 'terminal_input',
        target: { run_id: started.result.run_id },
        payload: {
          attachments: [{ file_id: uploaded.id, placeholder: '[Image #1]' }],
          input,
        },
      })

      expect(inputResponse.status).toBe(202)
      const artifact = `.hive/chat-attachments/input-image/${uploaded.id}.png`
      const pinnedPath = join(workspacePath, ...artifact.split('/'))
      await expect(inputResponse.json()).resolves.toEqual({
        action_id: 'input-image',
        artifact_contract_version: MOBILE_ARTIFACT_CONTRACT_VERSION,
        kind: 'terminal_input',
        ok: true,
        result: {
          attachments: [
            {
              artifact,
              file_id: uploaded.id,
              placeholder: '[Image #1]',
            },
          ],
          bytes: expect.any(Number),
          run_id: started.result.run_id,
        },
        workspace_id: workspace.id,
      })

      const registryPath = join(workspacePath, '.hive', 'mobile-attachments.json')
      const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
        attachments: Array<{
          artifact?: string
          file_id: string
          local_path: string
          mime_type: string
          name: string
          placeholder: string
          size: number
        }>
      }
      expect(registry.attachments).toEqual([
        expect.objectContaining({
          artifact,
          file_id: uploaded.id,
          local_path: pinnedPath,
          mime_type: 'image/png',
          name: 'photo.png',
          placeholder: '[Image #1]',
          size: pngFixture().byteLength,
        }),
      ])

      await waitFor(() => {
        const output = server.store.getLiveRun(started.result.run_id).output
        expect(output).toContain('[Yive mobile attachment]')
        expect(output).toContain(
          `Please inspect why agent_token and local_path mention ${uploaded.id} [Image #1]`
        )
        expect(output).toContain(artifact)
        expect(output).not.toContain('.hive/mobile-attachments.json')
        expect(output).not.toContain(uploadedImagePath(uploaded.id))
      })
    } finally {
      await server.close()
    }
  }, 60000)

  test('uses native image paste on Windows desktop runtime by default', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-native-image-')
    const script = join(workspacePath, 'stdin-listener.cjs')
    writeFileSync(script, stdinListenerScriptLines.join('\n'))
    const nativePastePaths: string[] = []
    setMobileNativeClipboardPasteForTests(async (imagePath) => {
      nativePastePaths.push(imagePath)
    })

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

      const uploadResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({
          content_base64: pngFixture().toString('base64'),
          name: 'native.png',
        }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(uploadResponse.status).toBe(201)
      const uploaded = (await uploadResponse.json()) as {
        id: string
        local_path: string
      }

      const startResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'start-native-image',
        workspace_id: workspace.id,
        kind: 'start_run',
        target: { agent_id: worker.id },
      })
      expect(startResponse.status).toBe(202)
      const started = (await startResponse.json()) as { result: { run_id: string } }
      await waitFor(() => {
        expect(server.store.getLiveRun(started.result.run_id).output).toContain('READY')
      })

      const pasteResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'paste-native-image',
        workspace_id: workspace.id,
        kind: 'native_image_paste',
        target: { run_id: started.result.run_id },
        payload: { file_id: uploaded.id, placeholder: '[Image #1]' },
      })

      expect(pasteResponse.status).toBe(202)
      const artifact = `.hive/chat-attachments/paste-native-image/${uploaded.id}.png`
      const pinnedPath = join(workspacePath, ...artifact.split('/'))
      await expect(pasteResponse.json()).resolves.toEqual({
        action_id: 'paste-native-image',
        artifact_contract_version: MOBILE_ARTIFACT_CONTRACT_VERSION,
        kind: 'native_image_paste',
        ok: true,
        result: {
          attachment: {
            artifact,
            file_id: uploaded.id,
            placeholder: '[Image #1]',
          },
          input: 'ctrl_v',
          run_id: started.result.run_id,
        },
        workspace_id: workspace.id,
      })
      expect(nativePastePaths).toEqual([pinnedPath])

      const registryPath = join(workspacePath, '.hive', 'mobile-attachments.json')
      const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
        attachments: Array<{
          artifact?: string
          file_id: string
          local_path: string
          placeholder: string
        }>
      }
      expect(registry.attachments).toEqual([
        expect.objectContaining({
          artifact,
          file_id: uploaded.id,
          local_path: pinnedPath,
          placeholder: '[Image #1]',
        }),
      ])

      await waitFor(() => {
        const output = server.store.getLiveRun(started.result.run_id).output
        expect(output).toContain('^V')
        expect(output).not.toContain(uploadedImagePath(uploaded.id))
      })
    } finally {
      await server.close()
    }
  }, 60000)

  test('falls back to a server attachment prompt when native image paste is unavailable', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-server-image-')
    const script = join(workspacePath, 'stdin-listener.cjs')
    writeFileSync(script, stdinListenerScriptLines.join('\n'))
    setMobileNativeClipboardPasteForTests(async () => {
      throw new Error('clipboard unavailable')
    })

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

      const uploadResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({
          content_base64: pngFixture().toString('base64'),
          name: 'server.png',
        }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(uploadResponse.status).toBe(201)
      const uploaded = (await uploadResponse.json()) as {
        id: string
        local_path: string
      }

      const startResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'start-server-image',
        workspace_id: workspace.id,
        kind: 'start_run',
        target: { agent_id: worker.id },
      })
      expect(startResponse.status).toBe(202)
      const started = (await startResponse.json()) as { result: { run_id: string } }
      await waitFor(() => {
        expect(server.store.getLiveRun(started.result.run_id).output).toContain('READY')
      })

      const pasteResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'paste-server-image',
        workspace_id: workspace.id,
        kind: 'native_image_paste',
        target: { run_id: started.result.run_id },
        payload: { file_id: uploaded.id, placeholder: '[Image #1]' },
      })

      expect(pasteResponse.status).toBe(202)
      const artifact = `.hive/chat-attachments/paste-server-image/${uploaded.id}.png`
      await expect(pasteResponse.json()).resolves.toEqual({
        action_id: 'paste-server-image',
        artifact_contract_version: MOBILE_ARTIFACT_CONTRACT_VERSION,
        kind: 'native_image_paste',
        ok: true,
        result: {
          attachment: {
            artifact,
            file_id: uploaded.id,
            placeholder: '[Image #1]',
          },
          bytes: expect.any(Number),
          fallback_reason: 'native_clipboard_unavailable',
          input: 'server_attachment_prompt',
          run_id: started.result.run_id,
        },
        workspace_id: workspace.id,
      })

      await waitFor(() => {
        const output = server.store.getLiveRun(started.result.run_id).output
        expect(output).toContain('[Yive mobile attachment]')
        expect(output).toContain(artifact)
        expect(output).toContain('"mime_type":"image/png"')
        expect(output).not.toContain('.hive/mobile-attachments.json')
        expect(output).not.toContain('local_path')
        expect(output).not.toContain('file_id')
        expect(output).not.toContain('[Image #1]')
        expect(output).not.toContain('^V')
        expect(output).not.toContain(uploadedImagePath(uploaded.id))
      })
    } finally {
      await server.close()
    }
  }, 60000)

  test('uses a server attachment prompt when native image paste is disabled', async () => {
    const originalFlag = process.env.HIVE_MOBILE_NATIVE_IMAGE_PASTE
    process.env.HIVE_MOBILE_NATIVE_IMAGE_PASTE = '0'
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-cloud-image-')
    const script = join(workspacePath, 'stdin-listener.cjs')
    writeFileSync(script, stdinListenerScriptLines.join('\n'))
    const nativePastePaths: string[] = []
    setMobileNativeClipboardPasteForTests(async (imagePath) => {
      nativePastePaths.push(imagePath)
    })

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

      const uploadResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({
          content_base64: pngFixture().toString('base64'),
          name: 'cloud.png',
        }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(uploadResponse.status).toBe(201)
      const uploaded = (await uploadResponse.json()) as { id: string; local_path: string }

      const startResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'start-cloud-image',
        workspace_id: workspace.id,
        kind: 'start_run',
        target: { agent_id: worker.id },
      })
      expect(startResponse.status).toBe(202)
      const started = (await startResponse.json()) as { result: { run_id: string } }
      await waitFor(() => {
        expect(server.store.getLiveRun(started.result.run_id).output).toContain('READY')
      })

      const pasteResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'paste-cloud-image',
        workspace_id: workspace.id,
        kind: 'native_image_paste',
        target: { run_id: started.result.run_id },
        payload: { file_id: uploaded.id, placeholder: '[Image #1]' },
      })

      expect(pasteResponse.status).toBe(202)
      const artifact = `.hive/chat-attachments/paste-cloud-image/${uploaded.id}.png`
      const body = (await pasteResponse.json()) as {
        result: { attachment: { artifact: string }; input: string }
      }
      expect(body.result.input).toBe('server_attachment_prompt')
      expect(body.result.attachment.artifact).toBe(artifact)
      expect(JSON.stringify(body)).not.toContain('registry_path')
      expect(JSON.stringify(body)).not.toContain('local_path')
      expect(nativePastePaths).toEqual([])
      await waitFor(() => {
        const output = server.store.getLiveRun(started.result.run_id).output
        expect(output).toContain('[Yive mobile attachment]')
        expect(output).toContain(artifact)
        expect(output).not.toContain('.hive/mobile-attachments.json')
        expect(output).not.toContain('local_path')
        expect(output).not.toContain('file_id')
        expect(output).not.toContain('^V')
        expect(output).not.toContain(uploadedImagePath(uploaded.id))
      })
    } finally {
      if (originalFlag === undefined) delete process.env.HIVE_MOBILE_NATIVE_IMAGE_PASTE
      else process.env.HIVE_MOBILE_NATIVE_IMAGE_PASTE = originalFlag
      await server.close()
    }
  }, 60000)

  test('records a mobile workspace file review without leaking local file paths', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture('hive-mobile-actions-file-review-')
    const script = join(workspacePath, 'stdin-listener.cjs')
    writeFileSync(script, stdinListenerScriptLines.join('\n'))
    mkdirSync(join(workspacePath, 'dist'), { recursive: true })
    writeFileSync(join(workspacePath, 'dist', 'review.md'), '# Review\n')

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
        action_id: 'start-review-run',
        kind: 'start_run',
        target: { agent_id: worker.id },
        workspace_id: workspace.id,
      })
      expect(startResponse.status).toBe(202)
      const started = (await startResponse.json()) as { result: { run_id: string } }
      await waitFor(() => {
        expect(server.store.getLiveRun(started.result.run_id).output).toContain('READY')
      })

      const fileResponse = await fetch(`${server.baseUrl}/api/mobile/files/from-workspace`, {
        body: JSON.stringify({
          path: 'dist/review.md',
          workspace_id: workspace.id,
        }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(fileResponse.status).toBe(201)
      const fileItem = (await fileResponse.json()) as {
        id: string
        local_path: string
        name: string
        workspace_path: string
      }

      const reviewResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'review-file-1',
        kind: 'file_review',
        payload: { comment: 'Please adjust the ending.', decision: 'needs_changes' },
        target: { file_id: fileItem.id, run_id: started.result.run_id },
        workspace_id: workspace.id,
      })

      expect(reviewResponse.status).toBe(202)
      const reviewText = await reviewResponse.text()
      expect(reviewText).not.toContain(fileItem.local_path)
      expect(reviewText).not.toContain('content_base64')
      expect(reviewText).not.toContain('local_path')
      expect(JSON.parse(reviewText)).toEqual({
        action_id: 'review-file-1',
        kind: 'file_review',
        ok: true,
        result: {
          bytes: expect.any(Number),
          comment: 'Please adjust the ending.',
          decision: 'needs_changes',
          file_id: fileItem.id,
          name: 'review.md',
          run_id: started.result.run_id,
          source: 'workspace',
          workspace_path: 'dist/review.md',
        },
        workspace_id: workspace.id,
      })

      const transcriptResponse = await getMobileTranscript(
        server.baseUrl,
        cookie,
        workspace.id,
        started.result.run_id
      )
      expect(transcriptResponse.status).toBe(200)
      const transcriptText = await transcriptResponse.text()
      expect(transcriptText).not.toContain(fileItem.local_path)
      expect(transcriptText).not.toContain('local_path')
      expect(transcriptText).not.toContain('content_base64')
      const transcript = JSON.parse(transcriptText) as { events: Array<Record<string, unknown>> }
      expect(transcript.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_review: {
              comment: 'Please adjust the ending.',
              decision: 'needs_changes',
              file_id: fileItem.id,
              name: 'review.md',
              workspace_path: 'dist/review.md',
            },
            kind: 'file_review',
            run_id: started.result.run_id,
            type: 'mobile_action_echo',
          }),
        ])
      )
    } finally {
      await server.close()
    }
  }, 60000)

  test('rejects invalid mobile file review requests', async () => {
    const { dataDir, workspacePath } = createWorkspaceFixture(
      'hive-mobile-actions-file-review-bad-'
    )
    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = server.store.createWorkspace(workspacePath, 'Alpha')

      const otherWorkspacePath = join(dataDir, 'other-workspace')
      mkdirSync(otherWorkspacePath)
      writeFileSync(join(otherWorkspacePath, 'owned.md'), '# Other\n')
      const otherWorkspace = server.store.createWorkspace(otherWorkspacePath, 'Other')
      const otherFileResponse = await fetch(`${server.baseUrl}/api/mobile/files/from-workspace`, {
        body: JSON.stringify({ path: 'owned.md', workspace_id: otherWorkspace.id }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      const otherFile = (await otherFileResponse.json()) as { id: string }
      const crossWorkspaceResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'review-cross-workspace-file',
        kind: 'file_review',
        payload: { decision: 'approved' },
        target: { file_id: otherFile.id },
        workspace_id: workspace.id,
      })
      expect(crossWorkspaceResponse.status).toBe(400)

      const missingFileResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'review-missing-file',
        kind: 'file_review',
        payload: { decision: 'approved' },
        target: { file_id: 'missing-file' },
        workspace_id: workspace.id,
      })
      expect(missingFileResponse.status).toBe(400)

      const uploadResponse = await fetch(`${server.baseUrl}/api/mobile/files`, {
        body: JSON.stringify({
          content_base64: Buffer.from('# Review\n').toString('base64'),
          name: 'review.md',
        }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(uploadResponse.status).toBe(201)
      const uploaded = (await uploadResponse.json()) as { id: string }

      const invalidDecisionResponse = await postMobileAction(server.baseUrl, cookie, {
        action_id: 'review-invalid-decision',
        kind: 'file_review',
        payload: { decision: 'maybe' },
        target: { file_id: uploaded.id },
        workspace_id: workspace.id,
      })
      expect(invalidDecisionResponse.status).toBe(400)
      await expect(invalidDecisionResponse.json()).resolves.toEqual({
        error: 'Unsupported file review decision: maybe',
      })
    } finally {
      await server.close()
    }
  })
})
