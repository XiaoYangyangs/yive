import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { MAX_ARTIFACT_BYTES } from '../../src/server/artifact-reference.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { writeProviderAdapterFixture } from '../helpers/provider-adapter-fixture.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const cleanups: Array<() => Promise<void>> = []
const tempDirs: string[] = []
const originalCodexHome = process.env.CODEX_HOME

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const waitFor = async (assertion: () => void, timeoutMs = 10_000) => {
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

const normalizePastedInput = (text: string) => {
  const pasteStart = '\u001b[200~'
  const pasteEnd = '\u001b[201~'
  const withoutStart = text.startsWith(pasteStart) ? text.slice(pasteStart.length) : text
  return withoutStart.endsWith(pasteEnd) ? withoutStart.slice(0, -pasteEnd.length) : withoutStart
}

const setupActiveDispatch = async () => {
  const root = mkdtempSync(join(tmpdir(), 'yive-team-report-'))
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  for (const artifact of [
    'logs/blocker.txt',
    'logs/failure.txt',
    'reports/first.md',
    'reports/second.md',
    'src/report.ts',
    'src/status.ts',
    'tests/status.test.ts',
  ]) {
    const artifactPath = join(workspacePath, artifact)
    mkdirSync(dirname(artifactPath), { recursive: true })
    writeFileSync(artifactPath, `Artifact fixture: ${artifact}\n`)
  }
  tempDirs.push(root)
  process.env.CODEX_HOME = join(root, 'codex-home')

  const server = await startTestServer({ dataDir: join(root, 'runtime') })
  cleanups.push(server.close)
  const uiCookie = await getUiCookie(server.baseUrl)
  const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
    body: JSON.stringify({
      autostart_orchestrator: false,
      name: 'Report Contract',
      path: workspacePath,
      provider: 'codex',
    }),
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    method: 'POST',
  })
  const workspace = (await workspaceResponse.json()) as { id: string }
  const orchestratorId = `${workspace.id}:orchestrator`
  const workerResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
    body: JSON.stringify({ name: 'Alice' }),
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    method: 'POST',
  })
  const worker = (await workerResponse.json()) as { id: string }

  const fixtures = []
  for (const [index, agentId] of [orchestratorId, worker.id].entries()) {
    const fixture = writeProviderAdapterFixture({
      fixtureId: `team-report-${index}`,
      provider: 'codex',
      root,
      sessionId:
        index === 0
          ? '11111111-1111-4111-8111-111111111111'
          : '22222222-2222-4222-8222-222222222222',
      workspacePath,
    })
    fixtures.push(fixture)
    server.store.configureAgentLaunch(workspace.id, agentId, {
      ...buildManagedProviderLaunchConfig('codex'),
      args: [],
      command: fixture.command,
      interactiveCommand: fixture.command,
    })
    await server.store.startAgent(workspace.id, agentId, {
      hivePort: server.baseUrl.split(':').at(-1) ?? '',
    })
    await waitFor(() => {
      expect(server.store.getAgentState(workspace.id, agentId)).toMatchObject({
        conversationActivity: 'idle',
        processState: 'running',
      })
    })
  }

  const orchestratorToken = server.store.peekAgentToken(orchestratorId)
  const workerToken = server.store.peekAgentToken(worker.id)
  if (!orchestratorToken || !workerToken) throw new Error('Expected Agent tokens')
  const sendResponse = await fetch(`${server.baseUrl}/api/team/send`, {
    body: JSON.stringify({
      from_agent_id: orchestratorId,
      project_id: workspace.id,
      request_id: 'dispatch-request-1',
      text: 'Implement the report contract',
      to: 'Alice',
      token: orchestratorToken,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  expect(sendResponse.status, await sendResponse.clone().text()).toBe(202)
  const dispatch = (await sendResponse.json()) as { dispatch_id: string }

  const orchestratorFixture = fixtures[0]
  const workerFixture = fixtures[1]
  if (!orchestratorFixture || !workerFixture) throw new Error('Expected Provider fixtures')
  const workerRun = server.store.getActiveRunByAgentId(workspace.id, worker.id)
  if (!workerRun) throw new Error('Expected active Worker run')
  return {
    dispatchId: dispatch.dispatch_id,
    orchestratorId,
    orchestratorFixture,
    orchestratorToken,
    server,
    uiCookie,
    worker,
    workerFixture,
    workerRunId: workerRun.runId,
    workerToken,
    workspace,
    workspacePath,
  }
}

describe('team Report outcome API', () => {
  test('applies the shared Artifact rejection matrix before every Team consumer persists', async () => {
    const { dispatchId, orchestratorId, server, worker, workspace, workspacePath } =
      await setupActiveDispatch()
    const outsideDirectory = join(dirname(workspacePath), 'artifact-matrix-outside')
    mkdirSync(outsideDirectory)
    writeFileSync(join(outsideDirectory, 'secret.md'), '# secret\n')
    symlinkSync(outsideDirectory, join(workspacePath, 'linked'), 'junction')
    writeFileSync(join(workspacePath, 'run.exe'), 'not executable')
    writeFileSync(join(workspacePath, 'fake.png'), 'not a png')
    const oversized = join(workspacePath, 'oversized.log')
    writeFileSync(oversized, '')
    truncateSync(oversized, MAX_ARTIFACT_BYTES + 1)

    const unsafeReferences = [
      join(workspacePath, 'src', 'report.ts'),
      '../artifact-matrix-outside/secret.md',
      'safe/../src/report.ts',
      'linked/secret.md',
      'missing.md',
      'run.exe',
      'fake.png',
      'oversized.log',
    ]
    for (const [index, reference] of unsafeReferences.entries()) {
      await expect(
        server.store.dispatchTask(workspace.id, worker.id, `unsafe Dispatch ${index}`, {
          artifacts: [reference],
          fromAgentId: orchestratorId,
          queue: true,
          requestId: `artifact-matrix-dispatch-${index}`,
        })
      ).rejects.toThrow()
      await expect(
        server.store.appendDispatchNote(workspace.id, {
          actorId: orchestratorId,
          actorType: 'agent',
          artifacts: [reference],
          dispatchId,
          id: `artifact-matrix-note-${index}`,
          text: `unsafe Note ${index}`,
        })
      ).rejects.toThrow()
      expect(() =>
        server.store.statusTask(workspace.id, worker.id, {
          artifacts: [reference],
          requestId: `artifact-matrix-status-${index}`,
          text: `unsafe Status ${index}`,
        })
      ).toThrow()
      expect(() =>
        server.store.reportTask(workspace.id, worker.id, {
          artifacts: [reference],
          requestId: `artifact-matrix-report-${index}`,
          text: `unsafe Report ${index}`,
        })
      ).toThrow()
    }

    expect(server.store.listDispatches(workspace.id)).toHaveLength(1)
    expect(server.store.listDispatchNotes(workspace.id, dispatchId)).toEqual([])
    expect(server.store.getDispatch(workspace.id, dispatchId)).toMatchObject({
      status: 'submitted',
    })
  }, 30_000)

  test('does not replay a Report request into a newer active Dispatch', async () => {
    const { orchestratorId, orchestratorToken, server, worker, workerToken, workspace } =
      await setupActiveDispatch()
    const reportRequest = 'report-request-reused'
    const firstReport = await fetch(`${server.baseUrl}/api/team/report`, {
      body: JSON.stringify({
        from_agent_id: worker.id,
        project_id: workspace.id,
        request_id: reportRequest,
        result: 'First Dispatch completed',
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(firstReport.status).toBe(202)

    const secondDispatch = await fetch(`${server.baseUrl}/api/team/send`, {
      body: JSON.stringify({
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        request_id: 'report-request-reused-dispatch',
        text: 'A newer Dispatch must own its own Report',
        to: 'Alice',
        token: orchestratorToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(secondDispatch.status).toBe(202)

    const replay = await fetch(`${server.baseUrl}/api/team/report`, {
      body: JSON.stringify({
        from_agent_id: worker.id,
        project_id: workspace.id,
        request_id: reportRequest,
        result: 'First Dispatch completed',
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(replay.status).toBe(409)
    await expect(replay.json()).resolves.toMatchObject({ code: 'report_request_conflict' })
  }, 30_000)

  test('automatically binds one immutable completed Report and replays its receipt', async () => {
    const {
      dispatchId,
      server,
      uiCookie,
      worker,
      workerRunId,
      workerToken,
      workspace,
      workspacePath,
    } = await setupActiveDispatch()
    const postReport = (body: Record<string, unknown>) =>
      fetch(`${server.baseUrl}/api/team/report`, {
        body: JSON.stringify({
          artifacts: ['src/report.ts'],
          from_agent_id: worker.id,
          project_id: workspace.id,
          request_id: 'report-request-1',
          result: 'Report contract implemented',
          token: workerToken,
          ...body,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

    const missingArtifact = await postReport({ artifacts: ['missing-report.md'] })
    expect(missingArtifact.status).toBe(400)
    expect(server.store.getDispatch(workspace.id, dispatchId)).toMatchObject({
      status: 'submitted',
    })

    const explicitDispatch = await postReport({ dispatch_id: dispatchId })
    expect(explicitDispatch.status).toBe(400)
    await expect(explicitDispatch.json()).resolves.toMatchObject({
      code: 'invalid_report',
    })
    expect(server.store.getDispatch(workspace.id, dispatchId)).toMatchObject({
      status: 'submitted',
    })

    const response = await postReport({})
    expect(response.status, await response.clone().text()).toBe(202)
    const receipt = await response.json()
    expect(receipt).toMatchObject({
      dispatch_id: dispatchId,
      ok: true,
      outcome: 'completed',
      request_id: 'report-request-1',
      reported_at: expect.any(Number),
    })

    rmSync(join(workspacePath, 'src', 'report.ts'))
    const retry = await postReport({})
    expect(retry.status, await retry.clone().text()).toBe(202)
    await expect(retry.json()).resolves.toEqual(receipt)

    const conflict = await postReport({ result: 'Conflicting replacement result' })
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({
      code: 'report_request_conflict',
    })
    expect(server.store.getDispatch(workspace.id, dispatchId)).toMatchObject({
      artifacts: ['src/report.ts'],
      reportOutcome: 'completed',
      reportRequestId: 'report-request-1',
      reportText: 'Report contract implemented',
      status: 'reported',
    })

    const transcriptResponse = await fetch(
      `${server.baseUrl}/api/mobile/transcript?workspace_id=${encodeURIComponent(
        workspace.id
      )}&run_id=${encodeURIComponent(workerRunId)}`,
      { headers: { cookie: uiCookie } }
    )
    expect(transcriptResponse.status, await transcriptResponse.clone().text()).toBe(200)
    const transcript = (await transcriptResponse.json()) as {
      events: Array<Record<string, unknown>>
    }
    const reportEvent = transcript.events.find((event) => event.type === 'report')
    expect(reportEvent).toMatchObject({
      artifacts: ['src/report.ts'],
      from_agent_id: worker.id,
      outcome: 'completed',
      text: 'Report contract implemented',
      type: 'report',
    })
    expect(reportEvent).not.toHaveProperty('status')
  }, 30_000)

  test('persists an explicit failed outcome in the immutable Report receipt', async () => {
    const { dispatchId, server, worker, workerToken, workspace } = await setupActiveDispatch()
    const response = await fetch(`${server.baseUrl}/api/team/report`, {
      body: JSON.stringify({
        artifacts: ['logs/failure.txt'],
        from_agent_id: worker.id,
        outcome: 'failed',
        project_id: workspace.id,
        request_id: 'failed-report-request',
        result: 'Validation cannot complete',
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status, await response.clone().text()).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      dispatch_id: dispatchId,
      outcome: 'failed',
      request_id: 'failed-report-request',
      reported_at: expect.any(Number),
    })
    expect(server.store.getDispatch(workspace.id, dispatchId)).toMatchObject({
      reportOutcome: 'failed',
      reportRequestId: 'failed-report-request',
      status: 'reported',
    })
  }, 30_000)

  test('commits the terminal Dispatch transition before its Report message becomes visible', async () => {
    const { dispatchId, server, worker, workerToken, workspace } = await setupActiveDispatch()
    const db = new Database(join(server.dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TRIGGER report_message_requires_terminal_dispatch
      BEFORE INSERT ON messages
      WHEN NEW.type = 'report'
       AND NOT EXISTS (
         SELECT 1 FROM dispatches
         WHERE workspace_id = NEW.workspace_id
           AND to_agent_id = NEW.worker_id
           AND status = 'reported'
       )
      BEGIN
        SELECT RAISE(ABORT, 'Report message observed before terminal Dispatch');
      END;
    `)
    db.close()

    const response = await fetch(`${server.baseUrl}/api/team/report`, {
      body: JSON.stringify({
        from_agent_id: worker.id,
        project_id: workspace.id,
        request_id: 'atomic-report-request',
        result: 'Committed atomically',
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status, await response.clone().text()).toBe(202)
    expect(server.store.getDispatch(workspace.id, dispatchId)).toMatchObject({ status: 'reported' })
  }, 30_000)

  test('rolls back the terminal Dispatch transition when Report persistence fails', async () => {
    const { dispatchId, server, worker, workerToken, workspace } = await setupActiveDispatch()
    const db = new Database(join(server.dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TRIGGER reject_report_message
      BEFORE INSERT ON messages
      WHEN NEW.type = 'report'
      BEGIN
        SELECT RAISE(ABORT, 'Injected Report persistence failure');
      END;
    `)
    db.close()

    const response = await fetch(`${server.baseUrl}/api/team/report`, {
      body: JSON.stringify({
        from_agent_id: worker.id,
        project_id: workspace.id,
        request_id: 'rollback-report-request',
        result: 'Must roll back',
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status).toBe(500)
    expect(server.store.getDispatch(workspace.id, dispatchId)).toMatchObject({
      reportOutcome: null,
      reportRequestId: null,
      status: 'submitted',
    })
    expect(
      server.store
        .listMessagesForRecovery(workspace.id, 0)
        .filter((message) => message.type === 'report')
    ).toEqual([])
  }, 30_000)

  test('pauses a failed Worker queue until explicit resume and verified idle', async () => {
    const {
      dispatchId,
      orchestratorId,
      orchestratorToken,
      server,
      worker,
      workerFixture,
      workerToken,
      workspace,
    } = await setupActiveDispatch()
    const queuedResponse = await fetch(`${server.baseUrl}/api/team/send`, {
      body: JSON.stringify({
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        queue: true,
        request_id: 'queued-after-failure',
        text: 'Run only after explicit recovery',
        to: 'Alice',
        token: orchestratorToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const queued = (await queuedResponse.json()) as { dispatch_id: string }
    workerFixture.appendUser('Worker is still in the failing turn')
    await waitFor(() => {
      expect(server.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('busy')
    })

    const reportResponse = await fetch(`${server.baseUrl}/api/team/report`, {
      body: JSON.stringify({
        from_agent_id: worker.id,
        outcome: 'failed',
        project_id: workspace.id,
        request_id: 'failed-queue-report',
        result: 'Dependency failed permanently',
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(reportResponse.status, await reportResponse.clone().text()).toBe(202)
    expect(server.store.getDispatch(workspace.id, dispatchId)).toMatchObject({
      reportOutcome: 'failed',
      status: 'reported',
    })
    expect(server.store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: null,
      queuePauseReason: 'Dependency failed permanently',
      queuedDispatchCount: 1,
    })
    expect(server.store.getDispatch(workspace.id, queued.dispatch_id)).toMatchObject({
      status: 'queued',
    })

    const resumeResponse = await fetch(`${server.baseUrl}/api/team/queue/resume`, {
      body: JSON.stringify({
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        token: orchestratorToken,
        worker: 'Alice',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(resumeResponse.status, await resumeResponse.clone().text()).toBe(200)
    await expect(resumeResponse.json()).resolves.toMatchObject({
      ok: true,
      queue_pause_reason: null,
      worker_id: worker.id,
    })
    expect(server.store.getDispatch(workspace.id, queued.dispatch_id)).toMatchObject({
      status: 'queued',
    })

    workerFixture.appendAssistant('Failed turn closed after recovery decision')
    workerFixture.appendCompletion()
    await waitFor(() => {
      expect(server.store.getDispatch(workspace.id, queued.dispatch_id)).toMatchObject({
        status: 'submitted',
      })
    })
  }, 30_000)

  test('rejects immediate assignment while a failed Worker queue remains paused', async () => {
    const { orchestratorId, orchestratorToken, server, worker, workerToken, workspace } =
      await setupActiveDispatch()
    const failedReport = await fetch(`${server.baseUrl}/api/team/report`, {
      body: JSON.stringify({
        from_agent_id: worker.id,
        outcome: 'failed',
        project_id: workspace.id,
        request_id: 'pause-immediate-report',
        result: 'The dependency is unavailable',
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(failedReport.status, await failedReport.clone().text()).toBe(202)

    const sendImmediate = (requestId: string) =>
      fetch(`${server.baseUrl}/api/team/send`, {
        body: JSON.stringify({
          from_agent_id: orchestratorId,
          project_id: workspace.id,
          request_id: requestId,
          text: 'Must wait for explicit queue recovery',
          to: 'Alice',
          token: orchestratorToken,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    const blocked = await sendImmediate('paused-immediate-send')
    expect(blocked.status).toBe(409)
    await expect(blocked.json()).resolves.toMatchObject({ code: 'worker_queue_paused' })
    expect(server.store.getAgentState(workspace.id, worker.id).activeDispatchId).toBeNull()

    const resumed = await fetch(`${server.baseUrl}/api/team/queue/resume`, {
      body: JSON.stringify({
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        token: orchestratorToken,
        worker: 'Alice',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(resumed.status).toBe(200)
    const accepted = await sendImmediate('resumed-immediate-send')
    expect(accepted.status, await accepted.clone().text()).toBe(202)
  }, 30_000)

  test('advances a completed Worker queue only after verified Provider idle', async () => {
    const {
      orchestratorId,
      orchestratorToken,
      server,
      worker,
      workerFixture,
      workerToken,
      workspace,
    } = await setupActiveDispatch()
    const queuedResponse = await fetch(`${server.baseUrl}/api/team/send`, {
      body: JSON.stringify({
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        queue: true,
        request_id: 'queued-after-completion',
        text: 'Run after the completed turn becomes idle',
        to: 'Alice',
        token: orchestratorToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const queued = (await queuedResponse.json()) as { dispatch_id: string }
    workerFixture.appendUser('Worker is completing the active Dispatch')
    await waitFor(() => {
      expect(server.store.getAgentState(workspace.id, worker.id).conversationActivity).toBe('busy')
    })

    const reportResponse = await fetch(`${server.baseUrl}/api/team/report`, {
      body: JSON.stringify({
        from_agent_id: worker.id,
        project_id: workspace.id,
        request_id: 'completed-queue-report',
        result: 'Active Dispatch completed',
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(reportResponse.status).toBe(202)
    expect(server.store.getDispatch(workspace.id, queued.dispatch_id)).toMatchObject({
      status: 'queued',
    })
    expect(server.store.getAgentState(workspace.id, worker.id)).toMatchObject({
      activeDispatchId: null,
      queuePauseReason: null,
      queuedDispatchCount: 1,
    })

    workerFixture.appendAssistant('Completed turn closed')
    workerFixture.appendCompletion()
    await waitFor(() => {
      expect(server.store.getDispatch(workspace.id, queued.dispatch_id)).toMatchObject({
        status: 'submitted',
      })
    })
  }, 30_000)

  test('batches compact Report events waiting in the same Orchestrator idle interval', async () => {
    const {
      orchestratorFixture,
      orchestratorId,
      orchestratorToken,
      server,
      worker,
      workerToken,
      workspace,
    } = await setupActiveDispatch()
    const queuedResponse = await fetch(`${server.baseUrl}/api/team/send`, {
      body: JSON.stringify({
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        queue: true,
        request_id: 'batch-report-dispatch',
        text: 'Second full task text must stay out of the compact event',
        to: 'Alice',
        token: orchestratorToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const queued = (await queuedResponse.json()) as { dispatch_id: string }
    orchestratorFixture.appendUser('Keep report events waiting')
    await waitFor(() => {
      expect(server.store.getAgentState(workspace.id, orchestratorId).conversationActivity).toBe(
        'busy'
      )
    })
    const initialStdinCount = orchestratorFixture
      .readEvents()
      .filter((event) => event.kind === 'stdin').length
    const postReport = (requestId: string, result: string, artifacts: string[] = []) =>
      fetch(`${server.baseUrl}/api/team/report`, {
        body: JSON.stringify({
          artifacts,
          from_agent_id: worker.id,
          project_id: workspace.id,
          request_id: requestId,
          result,
          token: workerToken,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

    const firstReport = await postReport('batch-report-1', 'First concise result')
    expect(firstReport.status).toBe(202)
    await waitFor(() => {
      expect(server.store.getDispatch(workspace.id, queued.dispatch_id)).toMatchObject({
        status: 'submitted',
      })
    })
    const secondReport = await postReport('batch-report-2', 'Second concise result', [
      'reports/second.md',
    ])
    expect(secondReport.status).toBe(202)
    expect(orchestratorFixture.readEvents().filter((event) => event.kind === 'stdin')).toHaveLength(
      initialStdinCount
    )

    orchestratorFixture.appendAssistant('Orchestrator is ready for reports')
    orchestratorFixture.appendCompletion()
    await waitFor(() => {
      const text = orchestratorFixture
        .readEvents()
        .filter((event) => event.kind === 'stdin')
        .map((event) => event.text ?? '')
        .join('')
      expect(text).toContain('First concise result')
      expect(text).toContain('Second concise result')
    })
    const deliveredText = orchestratorFixture
      .readEvents()
      .filter((event) => event.kind === 'stdin')
      .slice(initialStdinCount)
      .map((event) => event.text ?? '')
      .join('')
    expect(deliveredText.match(/Team coordination updates/gu)).toHaveLength(1)
    expect(deliveredText).toContain('Outcome: completed')
    expect(deliveredText).toContain('reports/second.md')
    expect(deliveredText).not.toContain('Implement the report contract')
    expect(deliveredText).not.toContain('Second full task text')
    const reportPrompt = orchestratorFixture
      .readEvents()
      .filter((event) => event.kind === 'stdin')
      .slice(initialStdinCount)
      .find((event) => event.text?.includes('[Hive Team coordination events JSON]'))
    if (!reportPrompt?.text) throw new Error('Expected Provider-visible Report prompt')
    orchestratorFixture.appendUser(normalizePastedInput(reportPrompt.text))
    orchestratorFixture.appendCompletion()

    await waitFor(() => {
      const db = new Database(join(server.dataDir, 'runtime.sqlite'), { readonly: true })
      const receipt = db
        .prepare(
          `SELECT COUNT(*) AS event_count, COUNT(DISTINCT delivered_at) AS delivery_count
           FROM coordination_events
           WHERE kind = 'report' AND delivery_state = 'delivered'`
        )
        .get() as { delivery_count: number; event_count: number }
      db.close()
      expect(receipt).toEqual({ delivery_count: 1, event_count: 2 })
    })
  }, 30_000)
})

describe('team Status snapshot API', () => {
  test('does not replay a Status request into a newer active Dispatch', async () => {
    const {
      dispatchId,
      orchestratorId,
      orchestratorToken,
      server,
      worker,
      workerToken,
      workspace,
    } = await setupActiveDispatch()
    const statusRequest = 'status-request-reused'
    const firstStatus = await fetch(`${server.baseUrl}/api/team/status`, {
      body: JSON.stringify({
        from_agent_id: worker.id,
        project_id: workspace.id,
        request_id: statusRequest,
        result: 'First Dispatch progress',
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(firstStatus.status).toBe(202)
    expect((await firstStatus.json()).dispatch_id).toBe(dispatchId)

    const firstReport = await fetch(`${server.baseUrl}/api/team/report`, {
      body: JSON.stringify({
        from_agent_id: worker.id,
        project_id: workspace.id,
        request_id: 'status-reused-report',
        result: 'First Dispatch completed',
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(firstReport.status).toBe(202)

    const secondDispatch = await fetch(`${server.baseUrl}/api/team/send`, {
      body: JSON.stringify({
        from_agent_id: orchestratorId,
        project_id: workspace.id,
        request_id: 'status-reused-dispatch',
        text: 'A newer Dispatch must own its own Status',
        to: 'Alice',
        token: orchestratorToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(secondDispatch.status).toBe(202)

    const replay = await fetch(`${server.baseUrl}/api/team/status`, {
      body: JSON.stringify({
        from_agent_id: worker.id,
        project_id: workspace.id,
        request_id: statusRequest,
        result: 'First Dispatch progress',
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(replay.status).toBe(409)
    await expect(replay.json()).resolves.toMatchObject({ code: 'status_request_conflict' })
  }, 30_000)

  test('replaces the active Dispatch snapshot without injecting the Orchestrator', async () => {
    const {
      dispatchId,
      orchestratorFixture,
      server,
      uiCookie,
      worker,
      workerFixture,
      workerToken,
      workspace,
      workspacePath,
    } = await setupActiveDispatch()
    const stdinCount = () =>
      orchestratorFixture.readEvents().filter((event) => event.kind === 'stdin').length
    const initialStdinCount = stdinCount()
    const postStatus = (body: Record<string, unknown>) =>
      fetch(`${server.baseUrl}/api/team/status`, {
        body: JSON.stringify({
          artifacts: ['src/status.ts'],
          from_agent_id: worker.id,
          notify: false,
          project_id: workspace.id,
          request_id: 'status-request-1',
          result: 'First progress snapshot',
          token: workerToken,
          ...body,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

    const firstResponse = await postStatus({})
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(202)
    const firstReceipt = await firstResponse.json()
    expect(firstReceipt).toMatchObject({
      dispatch_id: dispatchId,
      notify: false,
      ok: true,
      request_id: 'status-request-1',
      updated_at: expect.any(Number),
    })
    expect(stdinCount()).toBe(initialStdinCount)

    rmSync(join(workspacePath, 'src', 'status.ts'))
    const retry = await postStatus({})
    expect(retry.status).toBe(202)
    await expect(retry.json()).resolves.toEqual(firstReceipt)
    expect(stdinCount()).toBe(initialStdinCount)

    const conflict = await postStatus({ result: 'Conflicting first snapshot' })
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({
      code: 'status_request_conflict',
    })

    const secondResponse = await postStatus({
      artifacts: ['tests/status.test.ts'],
      request_id: 'status-request-2',
      result: 'Latest progress snapshot',
    })
    expect(secondResponse.status).toBe(202)
    expect(stdinCount()).toBe(initialStdinCount)

    const contextResponse = await fetch(`${server.baseUrl}/api/team/context`, {
      body: JSON.stringify({
        from_agent_id: worker.id,
        project_id: workspace.id,
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(contextResponse.status).toBe(200)
    await expect(contextResponse.json()).resolves.toMatchObject({
      active_dispatch: {
        id: dispatchId,
        latest_status: {
          artifacts: ['tests/status.test.ts'],
          text: 'Latest progress snapshot',
          updated_at: expect.any(Number),
        },
      },
    })

    const mobileDispatches = await fetch(
      `${server.baseUrl}/api/mobile/dispatches?workspace_id=${encodeURIComponent(workspace.id)}`,
      { headers: { cookie: uiCookie } }
    )
    expect(mobileDispatches.status).toBe(200)
    await expect(mobileDispatches.json()).resolves.toContainEqual(
      expect.objectContaining({
        id: dispatchId,
        latest_status: {
          artifacts: ['tests/status.test.ts'],
          notify: false,
          request_id: 'status-request-2',
          text: 'Latest progress snapshot',
          updated_at: expect.any(Number),
        },
      })
    )

    const initialWorkerStdinCount = workerFixture
      .readEvents()
      .filter((event) => event.kind === 'stdin').length
    workerFixture.appendCompaction('PRIVATE STATUS COMPACTION SUMMARY')
    await waitFor(() => {
      server.store.getAgentState(workspace.id, worker.id)
      const recoveryInput = workerFixture
        .readEvents()
        .filter((event) => event.kind === 'stdin')
        .slice(initialWorkerStdinCount)
        .map((event) => event.text ?? '')
        .join('')
      expect(recoveryInput).toContain('Current bounded Runtime Context:')
      expect(recoveryInput).toContain('Latest progress snapshot')
      expect(recoveryInput).not.toContain('First progress snapshot')
      expect(recoveryInput).not.toContain('PRIVATE STATUS COMPACTION SUMMARY')
    })
    expect(
      server.store
        .listMessagesForRecovery(workspace.id, 0)
        .filter((message) => message.type === 'status')
    ).toEqual([])
  }, 30_000)

  test('persists --notify immediately but delivers only after verified Orchestrator idle', async () => {
    const { dispatchId, orchestratorFixture, server, worker, workerToken, workspace } =
      await setupActiveDispatch()
    orchestratorFixture.appendUser('Keep the Orchestrator busy')
    await waitFor(() => {
      expect(
        server.store.getAgentState(workspace.id, `${workspace.id}:orchestrator`)
      ).toMatchObject({
        conversationActivity: 'busy',
      })
    })
    const stdinEvents = () =>
      orchestratorFixture.readEvents().filter((event) => event.kind === 'stdin')
    const initialStdinCount = stdinEvents().length

    const response = await fetch(`${server.baseUrl}/api/team/status`, {
      body: JSON.stringify({
        artifacts: ['logs/blocker.txt'],
        from_agent_id: worker.id,
        notify: true,
        project_id: workspace.id,
        request_id: 'notified-status-request',
        result: 'Waiting for a recoverable dependency',
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(response.status, await response.clone().text()).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      dispatch_id: dispatchId,
      notify: true,
      request_id: 'notified-status-request',
    })
    expect(stdinEvents()).toHaveLength(initialStdinCount)

    const contextResponse = await fetch(`${server.baseUrl}/api/team/context`, {
      body: JSON.stringify({
        from_agent_id: worker.id,
        project_id: workspace.id,
        token: workerToken,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    await expect(contextResponse.json()).resolves.toMatchObject({
      active_dispatch: {
        latest_status: { text: 'Waiting for a recoverable dependency' },
      },
    })

    orchestratorFixture.appendAssistant('Orchestrator turn finished')
    orchestratorFixture.appendCompletion()
    await waitFor(() => {
      expect(
        stdinEvents().some((event) => event.text?.includes('Waiting for a recoverable dependency'))
      ).toBe(true)
    })
    const deliveredInput = stdinEvents().slice(initialStdinCount)
    expect(deliveredInput.some((event) => event.text === '\u001b')).toBe(false)
    expect(deliveredInput.some((event) => event.text?.includes('\u0003'))).toBe(false)
    expect(deliveredInput.map((event) => event.text ?? '').join('')).toContain('logs/blocker.txt')
    const statusPrompt = deliveredInput.find((event) =>
      event.text?.includes('[Hive Team coordination events JSON]')
    )
    if (!statusPrompt?.text) throw new Error('Expected Provider-visible Status prompt')
    orchestratorFixture.appendUser(normalizePastedInput(statusPrompt.text))
    orchestratorFixture.appendCompletion()

    await waitFor(() => {
      const stateDb = new Database(join(server.dataDir, 'runtime.sqlite'), { readonly: true })
      const state = stateDb.prepare('SELECT delivery_state FROM coordination_events').get() as {
        delivery_state: string
      }
      stateDb.close()
      expect(state.delivery_state).toBe('delivered')
    })
    const db = new Database(join(server.dataDir, 'runtime.sqlite'), { readonly: true })
    const events = db
      .prepare(
        `SELECT kind, dispatch_id, worker_id, delivery_state
         FROM coordination_events`
      )
      .all()
    db.close()
    expect(events).toEqual([
      {
        delivery_state: 'delivered',
        dispatch_id: dispatchId,
        kind: 'status',
        worker_id: worker.id,
      },
    ])
  }, 30_000)
})
