import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { writeProviderAdapterFixture } from '../helpers/provider-adapter-fixture.js'
import { startTestServer } from '../helpers/test-server.js'

const originalCodexHome = process.env.CODEX_HOME
const tempDirs: string[] = []
let server: Awaited<ReturnType<typeof startTestServer>> | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  for (const directory of tempDirs.splice(0)) rmSync(directory, { force: true, recursive: true })
})

const waitFor = async (assertion: () => void | Promise<void>, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastError
}

const startIdleWorker = async () => {
  const root = mkdtempSync(join(tmpdir(), 'yive-dispatch-interruption-'))
  tempDirs.push(root)
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  mkdirSync(join(workspacePath, 'src'), { recursive: true })
  writeFileSync(join(workspacePath, 'src', 'corrected.ts'), 'export const corrected = true\n')
  process.env.CODEX_HOME = join(root, 'codex-home')
  const providerFixture = writeProviderAdapterFixture({
    fixtureId: 'dispatch-interruption',
    provider: 'codex',
    root,
    workspacePath,
  })
  const dataDir = join(root, 'data')
  server = await startTestServer({ dataDir })
  const workspace = server.store.createWorkspace(workspacePath, 'Dispatch interruption')
  const orchestratorId = `${workspace.id}:orchestrator`
  const worker = server.store.addWorker(workspace.id, { name: 'Alice' })
  server.store.configureAgentLaunch(workspace.id, worker.id, {
    ...buildManagedProviderLaunchConfig('codex'),
    args: [],
    command: providerFixture.command,
    interactiveCommand: providerFixture.command,
  })
  await server.store.startAgent(workspace.id, worker.id, {
    hivePort: server.baseUrl.split(':').at(-1) ?? '',
  })
  server.store.configureAgentLaunch(workspace.id, orchestratorId, {
    args: ['-e', 'process.stdin.resume()'],
    command: process.execPath,
    provider: 'codex',
  })
  await server.store.startAgent(workspace.id, orchestratorId, {
    hivePort: server.baseUrl.split(':').at(-1) ?? '',
    suppressStartupInstructions: true,
  })
  await waitFor(() => {
    expect(server?.store.getCurrentAgentConversation(workspace.id, worker.id)?.activity_state).toBe(
      'idle'
    )
  })
  const token = server.store.peekAgentToken(orchestratorId)
  if (!token) throw new Error('Expected Orchestrator token')
  return { dataDir, orchestratorId, providerFixture, token, worker, workspace }
}

describe('Dispatch interruption contract', () => {
  test('rejects an unauthorized direct Runtime cancellation before persisting side effects', async () => {
    const { orchestratorId, providerFixture, worker, workspace } = await startIdleWorker()
    if (!server) throw new Error('Expected test server')
    const active = await server.store.dispatchTask(workspace.id, worker.id, 'Protected task', {
      fromAgentId: orchestratorId,
      requestId: 'active-before-unauthorized-cancel',
    })
    providerFixture.appendUser(`dispatch_id: ${active.id}\nProtected task`)
    providerFixture.appendAssistant('Working on protected task.')
    await waitFor(() => {
      expect(
        server?.store.getCurrentAgentConversation(workspace.id, worker.id)?.activity_state
      ).toBe('busy')
    })
    const hiddenSessionPath = `${providerFixture.sessionPath}.temporarily-unavailable`
    renameSync(providerFixture.sessionPath, hiddenSessionPath)
    const baseline = providerFixture.readEvents().length

    await expect(
      server.store.cancelTask(workspace.id, active.id, {
        fromAgentId: worker.id,
        reason: 'Worker must not cancel its own Dispatch',
        requestId: 'unauthorized-direct-cancel',
      })
    ).rejects.toMatchObject({ statusCode: 403 })

    expect(providerFixture.readEvents().slice(baseline)).toEqual([])
    expect(server.store.getDispatch(workspace.id, active.id)).toMatchObject({
      operationKind: null,
      operationState: null,
      status: 'submitted',
    })

    await expect(
      server.store.replaceTask(workspace.id, active.id, {
        fromAgentId: worker.id,
        interrupt: true,
        requestId: 'unauthorized-direct-replace',
        text: 'Worker must not replace its own Dispatch',
      })
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(server.store.listDispatches(workspace.id)).toEqual([
      expect.objectContaining({ id: active.id, operationKind: null, status: 'submitted' }),
    ])
  })

  test('cancels a verified-idle active Dispatch without PTY input and pauses its queue', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } = await startIdleWorker()
    if (!server) throw new Error('Expected test server')
    const active = await server.store.dispatchTask(workspace.id, worker.id, 'Active task', {
      fromAgentId: orchestratorId,
      requestId: 'active-before-idle-cancel',
    })
    const queued = await server.store.dispatchTask(workspace.id, worker.id, 'Later queued task', {
      fromAgentId: orchestratorId,
      queue: true,
      requestId: 'queued-behind-idle-cancel',
    })
    const baseline = providerFixture.readEvents().length

    const response = await fetch(`${server.baseUrl}/api/team/cancel`, {
      body: JSON.stringify({
        dispatch_id: active.id,
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        reason: 'Direction changed',
        request_id: 'cancel-idle-request',
        token,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status, await response.clone().text()).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      dispatch_id: active.id,
      ok: true,
      request_id: 'cancel-idle-request',
      state: 'cancelled',
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(
      providerFixture
        .readEvents()
        .slice(baseline)
        .filter((event) => event.kind === 'stdin')
    ).toEqual([])
    expect(server.store.getDispatch(workspace.id, active.id)).toMatchObject({
      reportText: 'Direction changed',
      status: 'cancelled',
    })
    expect(server.store.getDispatch(workspace.id, queued.id)).toMatchObject({ status: 'queued' })
    expect(server.store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: null,
      conversationActivity: 'idle',
      queuePauseReason: 'Direction changed',
      queuedDispatchCount: 1,
    })
  })

  test('interrupts a busy active Dispatch with Esc and waits for the same Session to become idle', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } = await startIdleWorker()
    if (!server) throw new Error('Expected test server')
    const active = await server.store.dispatchTask(workspace.id, worker.id, 'Active busy task', {
      fromAgentId: orchestratorId,
      requestId: 'active-before-busy-cancel',
    })
    await server.store.dispatchTask(workspace.id, worker.id, 'Queued after busy task', {
      fromAgentId: orchestratorId,
      queue: true,
      requestId: 'queued-behind-busy-cancel',
    })
    providerFixture.appendUser(`dispatch_id: ${active.id}\nActive busy task`)
    providerFixture.appendAssistant('Work is still in progress.')
    await waitFor(() => {
      expect(
        server?.store.getCurrentAgentConversation(workspace.id, worker.id)?.activity_state
      ).toBe('busy')
    })
    const originalRun = server.store.getActiveRunByAgentId(workspace.id, worker.id)
    expect(originalRun?.sessionId).toBe(providerFixture.sessionId)
    const baseline = providerFixture.readEvents().length

    const cancellationBody = {
      dispatch_id: active.id,
      from_agent_id: orchestratorId,
      project_id: workspace.id,
      reason: 'Stop incorrect busy work',
      request_id: 'cancel-busy-request',
      token,
    }
    const cancellation = fetch(`${server.baseUrl}/api/team/cancel`, {
      body: JSON.stringify(cancellationBody),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    await waitFor(() => {
      const inputs = providerFixture
        .readEvents()
        .slice(baseline)
        .filter((event) => event.kind === 'stdin')
        .map((event) => event.text)
      expect(inputs).toEqual(['\u001b'])
      expect(inputs).not.toContain('\u0003')
    })
    expect(server.store.getDispatch(workspace.id, active.id)).toMatchObject({
      operationAttempts: 1,
      operationState: 'waiting_for_idle',
      status: 'submitted',
    })

    providerFixture.appendCompletion('interrupted')
    const response = await cancellation
    expect(response.status, await response.clone().text()).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      dispatch_id: active.id,
      ok: true,
      request_id: 'cancel-busy-request',
      state: 'cancelled',
    })
    expect(server.store.getActiveRunByAgentId(workspace.id, worker.id)).toMatchObject({
      runId: originalRun?.runId,
      sessionId: providerFixture.sessionId,
    })
    expect(server.store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: null,
      conversationActivity: 'idle',
      queuePauseReason: 'Stop incorrect busy work',
      queuedDispatchCount: 1,
    })
    const retryBaseline = providerFixture.readEvents().length
    const retry = await fetch(`${server.baseUrl}/api/team/cancel`, {
      body: JSON.stringify(cancellationBody),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(retry.status).toBe(202)
    await expect(retry.json()).resolves.toMatchObject({
      dispatch_id: active.id,
      request_id: 'cancel-busy-request',
      state: 'cancelled',
    })
    expect(providerFixture.readEvents().slice(retryBaseline)).toEqual([])
  }, 15_000)

  test('retries Esc once then leaves a visible blocked cancellation while Provider stays busy', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } = await startIdleWorker()
    if (!server) throw new Error('Expected test server')
    const active = await server.store.dispatchTask(workspace.id, worker.id, 'Never-idle task', {
      fromAgentId: orchestratorId,
      requestId: 'active-before-timeout-cancel',
    })
    await server.store.dispatchTask(workspace.id, worker.id, 'Must remain queued', {
      fromAgentId: orchestratorId,
      queue: true,
      requestId: 'queued-behind-timeout-cancel',
    })
    providerFixture.appendUser(`dispatch_id: ${active.id}\nNever-idle task`)
    providerFixture.appendAssistant('Still busy forever.')
    await waitFor(() => {
      expect(
        server?.store.getCurrentAgentConversation(workspace.id, worker.id)?.activity_state
      ).toBe('busy')
    })
    const run = server.store.getActiveRunByAgentId(workspace.id, worker.id)
    const baseline = providerFixture.readEvents().length

    const response = await fetch(`${server.baseUrl}/api/team/cancel`, {
      body: JSON.stringify({
        dispatch_id: active.id,
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        reason: 'This cannot be claimed stopped',
        request_id: 'cancel-timeout-request',
        token,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: 'dispatch_interruption_blocked',
    })
    const inputs = providerFixture
      .readEvents()
      .slice(baseline)
      .filter((event) => event.kind === 'stdin')
      .map((event) => event.text)
    expect(inputs).toEqual(['\u001b', '\u001b'])
    expect(inputs).not.toContain('\u0003')
    expect(server.store.getDispatch(workspace.id, active.id)).toMatchObject({
      operationAttempts: 2,
      operationError: 'Provider remained busy after two interruption attempts',
      operationState: 'blocked',
      status: 'submitted',
    })
    expect(server.store.getActiveRunByAgentId(workspace.id, worker.id)).toMatchObject({
      runId: run?.runId,
      sessionId: providerFixture.sessionId,
    })
    expect(server.store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: active.id,
      conversationActivity: 'busy',
      queuePauseReason: null,
      queuedDispatchCount: 1,
    })
  }, 15_000)

  test('blocks cancellation without PTY input when Provider activity becomes unknown', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } = await startIdleWorker()
    if (!server) throw new Error('Expected test server')
    const active = await server.store.dispatchTask(workspace.id, worker.id, 'Unverifiable task', {
      fromAgentId: orchestratorId,
      requestId: 'active-before-unknown-cancel',
    })
    rmSync(providerFixture.sessionPath)
    const baseline = providerFixture.readEvents().length

    const response = await fetch(`${server.baseUrl}/api/team/cancel`, {
      body: JSON.stringify({
        dispatch_id: active.id,
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        reason: 'Cannot verify this turn',
        request_id: 'cancel-unknown-request',
        token,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: 'dispatch_interruption_blocked',
    })
    expect(providerFixture.readEvents().slice(baseline)).toEqual([])
    expect(server.store.getDispatch(workspace.id, active.id)).toMatchObject({
      operationAttempts: 0,
      operationError: 'Provider activity or Session is not verifiable',
      operationState: 'blocked',
      status: 'submitted',
    })
  })

  test('rolls back cancellation when queue-pause persistence fails and recovers by request id', async () => {
    const { dataDir, orchestratorId, providerFixture, token, worker, workspace } =
      await startIdleWorker()
    if (!server) throw new Error('Expected test server')
    const active = await server.store.dispatchTask(workspace.id, worker.id, 'Atomic cancel task', {
      fromAgentId: orchestratorId,
      requestId: 'active-before-atomic-cancel',
    })
    const baseline = providerFixture.readEvents().length
    const database = new Database(join(dataDir, 'runtime.sqlite'))
    database.exec(`
      CREATE TRIGGER fail_worker_queue_pause
      BEFORE INSERT ON worker_queue_state
      BEGIN
        SELECT RAISE(ABORT, 'injected queue pause failure');
      END;
    `)
    const body = {
      dispatch_id: active.id,
      from_agent_id: orchestratorId,
      project_id: workspace.id,
      reason: 'Atomic cancellation',
      request_id: 'cancel-after-persistence-failure',
      token,
    }

    let failed: Response
    try {
      failed = await fetch(`${server.baseUrl}/api/team/cancel`, {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    } finally {
      database.exec('DROP TRIGGER fail_worker_queue_pause')
      database.close()
    }
    expect(failed.status).toBe(500)
    expect(server.store.getDispatch(workspace.id, active.id)).toMatchObject({
      operationKind: null,
      status: 'submitted',
    })
    expect(server.store.getAgentState(workspace.id, worker.id).queuePauseReason).toBeNull()
    expect(providerFixture.readEvents().slice(baseline)).toEqual([])

    const retry = await fetch(`${server.baseUrl}/api/team/cancel`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(retry.status, await retry.clone().text()).toBe(202)
    expect(server.store.getDispatch(workspace.id, active.id)).toMatchObject({
      operationRequestId: 'cancel-after-persistence-failure',
      status: 'cancelled',
    })
    expect(server.store.getAgentState(workspace.id, worker.id).queuePauseReason).toBe(
      'Atomic cancellation'
    )
  })

  test('recovers a persisted blocked cancellation after Runtime restart without another Esc', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } = await startIdleWorker()
    if (!server) throw new Error('Expected test server')
    const dataDir = server.dataDir
    const active = await server.store.dispatchTask(workspace.id, worker.id, 'Recoverable task', {
      fromAgentId: orchestratorId,
      requestId: 'active-before-restart-cancel',
    })
    const hiddenSessionPath = `${providerFixture.sessionPath}.temporarily-unavailable`
    renameSync(providerFixture.sessionPath, hiddenSessionPath)
    const cancellationBody = {
      dispatch_id: active.id,
      from_agent_id: orchestratorId,
      project_id: workspace.id,
      reason: 'Persist cancellation across restart',
      request_id: 'cancel-across-runtime-restart',
      token,
    }
    const blocked = await fetch(`${server.baseUrl}/api/team/cancel`, {
      body: JSON.stringify(cancellationBody),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(blocked.status).toBe(409)
    expect(server.store.getDispatch(workspace.id, active.id)).toMatchObject({
      operationRequestId: cancellationBody.request_id,
      operationState: 'blocked',
      status: 'submitted',
    })

    renameSync(hiddenSessionPath, providerFixture.sessionPath)
    await server.close()
    server = await startTestServer({ dataDir })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      ...buildManagedProviderLaunchConfig('codex'),
      args: [],
      command: providerFixture.command,
      interactiveCommand: providerFixture.command,
    })
    const restarted = await server.store.startAgent(workspace.id, worker.id, {
      hivePort: new URL(server.baseUrl).port,
    })
    expect(restarted.resumedSessionId).toBe(providerFixture.sessionId)
    await waitFor(() => {
      expect(
        server?.store.getCurrentAgentConversation(workspace.id, worker.id)?.activity_state
      ).toBe('idle')
    })
    const retryBaseline = providerFixture.readEvents().length
    const result = await server.store.cancelTask(workspace.id, active.id, {
      fromAgentId: orchestratorId,
      reason: cancellationBody.reason,
      requestId: cancellationBody.request_id,
    })

    expect(result.dispatch).toMatchObject({
      operationRequestId: cancellationBody.request_id,
      operationState: 'completed',
      status: 'cancelled',
    })
    expect(
      providerFixture
        .readEvents()
        .slice(retryBaseline)
        .filter((event) => event.kind === 'stdin' && event.text === '\u001b')
    ).toEqual([])
    expect(server.store.getActiveRunByAgentId(workspace.id, worker.id)).toMatchObject({
      sessionId: providerFixture.sessionId,
    })
  }, 20_000)

  test('replaces a verified-idle active Dispatch directly and preserves the remaining queue', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } = await startIdleWorker()
    if (!server) throw new Error('Expected test server')
    const active = await server.store.dispatchTask(
      workspace.id,
      worker.id,
      'Incorrect active task',
      {
        fromAgentId: orchestratorId,
        requestId: 'active-before-idle-replace',
      }
    )
    const queued = await server.store.dispatchTask(
      workspace.id,
      worker.id,
      'Preserved queued task',
      {
        fromAgentId: orchestratorId,
        queue: true,
        requestId: 'queued-behind-idle-replace',
      }
    )
    const baseline = providerFixture.readEvents().length

    const replacementBody = {
      artifacts: ['src/corrected.ts'],
      dispatch_id: active.id,
      from_agent_id: orchestratorId,
      project_id: workspace.id,
      request_id: 'replace-idle-request',
      text: 'Corrected active task',
      token,
    }
    const response = await fetch(`${server.baseUrl}/api/team/replace`, {
      body: JSON.stringify(replacementBody),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status, await response.clone().text()).toBe(202)
    const receipt = (await response.json()) as {
      dispatch_id: string
      replaced_dispatch_id: string
    }
    expect(receipt).toMatchObject({
      dispatch_id: expect.any(String),
      replaced_dispatch_id: active.id,
    })
    const inputs = providerFixture
      .readEvents()
      .slice(baseline)
      .filter((event) => event.kind === 'stdin')
      .map((event) => event.text ?? '')
    expect(inputs).not.toContain('\u001b')
    expect(inputs).not.toContain('\u0003')
    expect(inputs.join('')).toContain(`dispatch_id: ${receipt.dispatch_id}`)
    expect(inputs.join('')).toContain('Corrected active task')
    expect(server.store.getDispatch(workspace.id, active.id)).toMatchObject({
      operationState: 'completed',
      replacedBy: receipt.dispatch_id,
      status: 'replaced',
    })
    expect(server.store.getDispatch(workspace.id, receipt.dispatch_id)).toMatchObject({
      artifacts: ['src/corrected.ts'],
      replacesDispatchId: active.id,
      status: 'submitted',
      text: 'Corrected active task',
    })
    expect(server.store.getDispatch(workspace.id, queued.id)).toMatchObject({ status: 'queued' })
    expect(server.store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: receipt.dispatch_id,
      queuePauseReason: null,
      queuedDispatchCount: 1,
    })
    const retryBaseline = providerFixture.readEvents().length
    const retry = await fetch(`${server.baseUrl}/api/team/replace`, {
      body: JSON.stringify(replacementBody),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(retry.status).toBe(202)
    await expect(retry.json()).resolves.toMatchObject(receipt)
    expect(providerFixture.readEvents().slice(retryBaseline)).toEqual([])

    const conflictingRetry = await fetch(`${server.baseUrl}/api/team/replace`, {
      body: JSON.stringify({ ...replacementBody, text: 'Conflicting replacement content' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(conflictingRetry.status).toBe(409)
    await expect(conflictingRetry.json()).resolves.toMatchObject({
      code: 'dispatch_operation_request_conflict',
    })
  }, 15_000)

  test('requires explicit interruption before replacing busy active work and delivers in order', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } = await startIdleWorker()
    if (!server) throw new Error('Expected test server')
    const active = await server.store.dispatchTask(workspace.id, worker.id, 'Busy incorrect task', {
      fromAgentId: orchestratorId,
      requestId: 'active-before-busy-replace',
    })
    const queued = await server.store.dispatchTask(
      workspace.id,
      worker.id,
      'Preserved after replace',
      {
        fromAgentId: orchestratorId,
        queue: true,
        requestId: 'queued-behind-busy-replace',
      }
    )
    providerFixture.appendUser(`dispatch_id: ${active.id}\nBusy incorrect task`)
    providerFixture.appendAssistant('Busy with the wrong direction.')
    await waitFor(() => {
      expect(
        server?.store.getCurrentAgentConversation(workspace.id, worker.id)?.activity_state
      ).toBe('busy')
    })
    const baseline = providerFixture.readEvents().length
    const replace = (requestId: string, interrupt: boolean) =>
      fetch(`${server?.baseUrl}/api/team/replace`, {
        body: JSON.stringify({
          dispatch_id: active.id,
          from_agent_id: orchestratorId,
          interrupt,
          project_id: workspace.id,
          request_id: requestId,
          text: 'Corrected after interruption',
          token,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

    const refused = await replace('replace-busy-without-interrupt', false)
    expect(refused.status).toBe(409)
    await expect(refused.json()).resolves.toMatchObject({
      code: 'replacement_requires_interrupt',
    })
    expect(providerFixture.readEvents().slice(baseline)).toEqual([])
    expect(
      server.store
        .listDispatches(workspace.id)
        .filter((dispatch) => dispatch.replacesDispatchId === active.id)
    ).toEqual([])

    const replacement = replace('replace-busy-with-interrupt', true)
    await waitFor(() => {
      const inputs = providerFixture
        .readEvents()
        .slice(baseline)
        .filter((event) => event.kind === 'stdin')
        .map((event) => event.text)
      expect(inputs).toEqual(['\u001b'])
    })
    expect(server.store.getDispatch(workspace.id, active.id)).toMatchObject({
      operationAttempts: 1,
      operationState: 'waiting_for_idle',
      status: 'submitted',
    })
    const pending = server.store
      .listDispatches(workspace.id)
      .find((dispatch) => dispatch.replacesDispatchId === active.id)
    expect(pending).toMatchObject({
      status: 'replacement_pending',
      text: 'Corrected after interruption',
    })

    providerFixture.appendCompletion('interrupted')
    const response = await replacement
    expect(response.status, await response.clone().text()).toBe(202)
    const receipt = (await response.json()) as { dispatch_id: string }
    const inputs = providerFixture
      .readEvents()
      .slice(baseline)
      .filter((event) => event.kind === 'stdin')
      .map((event) => event.text ?? '')
    const escIndex = inputs.indexOf('\u001b')
    const replacementIndex = inputs.findIndex((input) =>
      input.includes(`dispatch_id: ${receipt.dispatch_id}`)
    )
    expect(escIndex).toBeGreaterThanOrEqual(0)
    expect(replacementIndex).toBeGreaterThan(escIndex)
    expect(inputs).not.toContain('\u0003')
    expect(server.store.getDispatch(workspace.id, active.id)).toMatchObject({
      replacedBy: receipt.dispatch_id,
      status: 'replaced',
    })
    expect(server.store.getDispatch(workspace.id, receipt.dispatch_id)).toMatchObject({
      status: 'submitted',
    })
    expect(server.store.getDispatch(workspace.id, queued.id)).toMatchObject({ status: 'queued' })
    expect(server.store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: receipt.dispatch_id,
      queuePauseReason: null,
      queuedDispatchCount: 1,
    })
  }, 15_000)

  test('keeps a timed-out busy replacement pending without delivering its task', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } = await startIdleWorker()
    if (!server) throw new Error('Expected test server')
    const active = await server.store.dispatchTask(workspace.id, worker.id, 'Busy original task', {
      fromAgentId: orchestratorId,
      requestId: 'active-before-timeout-replace',
    })
    const queued = await server.store.dispatchTask(
      workspace.id,
      worker.id,
      'Preserved future task',
      {
        fromAgentId: orchestratorId,
        queue: true,
        requestId: 'queued-behind-timeout-replace',
      }
    )
    providerFixture.appendUser(`dispatch_id: ${active.id}\nBusy original task`)
    providerFixture.appendAssistant('Still busy with the original task.')
    await waitFor(() => {
      expect(
        server?.store.getCurrentAgentConversation(workspace.id, worker.id)?.activity_state
      ).toBe('busy')
    })
    const baseline = providerFixture.readEvents().length

    const replacementBody = {
      dispatch_id: active.id,
      from_agent_id: orchestratorId,
      interrupt: true,
      project_id: workspace.id,
      request_id: 'replace-timeout-request',
      text: 'Replacement must not be delivered while busy',
      token,
    }
    const response = await fetch(`${server.baseUrl}/api/team/replace`, {
      body: JSON.stringify(replacementBody),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'dispatch_replacement_blocked' })
    const inputs = providerFixture
      .readEvents()
      .slice(baseline)
      .filter((event) => event.kind === 'stdin')
      .map((event) => event.text ?? '')
    expect(inputs).toEqual(['\u001b', '\u001b'])
    expect(inputs.join('')).not.toContain('Replacement must not be delivered while busy')
    expect(server.store.getDispatch(workspace.id, active.id)).toMatchObject({
      operationAttempts: 2,
      operationState: 'blocked',
      status: 'submitted',
    })
    expect(
      server.store
        .listDispatches(workspace.id)
        .find((dispatch) => dispatch.replacesDispatchId === active.id)
    ).toMatchObject({ status: 'replacement_pending' })
    expect(server.store.getDispatch(workspace.id, queued.id)).toMatchObject({ status: 'queued' })

    providerFixture.appendCompletion('interrupted')
    await waitFor(() => {
      expect(
        server?.store.getCurrentAgentConversation(workspace.id, worker.id)?.activity_state
      ).toBe('idle')
    })
    const retryBaseline = providerFixture.readEvents().length
    const retry = await fetch(`${server.baseUrl}/api/team/replace`, {
      body: JSON.stringify(replacementBody),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(retry.status, await retry.clone().text()).toBe(202)
    const receipt = (await retry.json()) as { dispatch_id: string }
    const retryInputs = providerFixture
      .readEvents()
      .slice(retryBaseline)
      .filter((event) => event.kind === 'stdin')
      .map((event) => event.text ?? '')
    expect(retryInputs.join('')).toContain(`dispatch_id: ${receipt.dispatch_id}`)
    expect(
      retryInputs.join('').match(/Replacement must not be delivered while busy/gu)
    ).toHaveLength(1)
    expect(server.store.getDispatch(workspace.id, active.id)).toMatchObject({
      operationState: 'completed',
      replacedBy: receipt.dispatch_id,
      status: 'replaced',
    })
    expect(server.store.getDispatch(workspace.id, receipt.dispatch_id)).toMatchObject({
      status: 'submitted',
    })
  }, 15_000)

  test('rejects Report and Note writes after replacement owns the active Dispatch', async () => {
    const { orchestratorId, providerFixture, token, worker, workspace } = await startIdleWorker()
    if (!server) throw new Error('Expected test server')
    const active = await server.store.dispatchTask(workspace.id, worker.id, 'Original busy task', {
      fromAgentId: orchestratorId,
      requestId: 'active-before-write-race',
    })
    providerFixture.appendUser(`dispatch_id: ${active.id}\nOriginal busy task`)
    providerFixture.appendAssistant('Still working on the original task.')
    await waitFor(() => {
      expect(
        server?.store.getCurrentAgentConversation(workspace.id, worker.id)?.activity_state
      ).toBe('busy')
    })

    const replacement = fetch(`${server.baseUrl}/api/team/replace`, {
      body: JSON.stringify({
        dispatch_id: active.id,
        from_agent_id: orchestratorId,
        interrupt: true,
        project_id: workspace.id,
        request_id: 'replace-before-write-race',
        text: 'Corrected task after interruption',
        token,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    await waitFor(() => {
      expect(server?.store.getDispatch(workspace.id, active.id)).toMatchObject({
        operationKind: 'replace',
        operationState: 'waiting_for_idle',
        status: 'submitted',
      })
    })

    expect(() =>
      server?.store.reportTask(workspace.id, worker.id, {
        outcome: 'completed',
        requestId: 'report-racing-replacement',
        text: 'The obsolete task completed',
      })
    ).toThrow('already has a different lifecycle operation in progress')
    await expect(
      server.store.appendDispatchNote(workspace.id, {
        actorId: orchestratorId,
        actorType: 'agent',
        artifacts: [],
        dispatchId: active.id,
        id: 'note-racing-replacement',
        text: 'This Note must not attach after replacement begins',
      })
    ).rejects.toMatchObject({ code: 'dispatch_operation_in_progress', statusCode: 409 })

    providerFixture.appendCompletion('interrupted')
    const response = await replacement
    expect(response.status, await response.clone().text()).toBe(202)
    const receipt = (await response.json()) as { dispatch_id: string }
    expect(server.store.getDispatch(workspace.id, active.id)).toMatchObject({
      replacedBy: receipt.dispatch_id,
      status: 'replaced',
    })
    expect(server.store.getDispatch(workspace.id, receipt.dispatch_id)).toMatchObject({
      status: 'submitted',
    })
  }, 15_000)
})
