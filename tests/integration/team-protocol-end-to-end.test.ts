import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { writeProviderAdapterFixture } from '../helpers/provider-adapter-fixture.js'

const tempDirs: string[] = []
const originalCodexHome = process.env.CODEX_HOME

const waitFor = async (
  assertion: () => Promise<void> | void,
  timeoutMs = 2000,
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

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('team protocol end to end', () => {
  test('real hive runtime records send/report messages and updates worker status', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-e2e-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(join(workspacePath, 'src'), { recursive: true })
    mkdirSync(join(workspacePath, 'tests'), { recursive: true })
    writeFileSync(join(workspacePath, 'src', 'auth.ts'), 'export const auth = true\n')
    writeFileSync(join(workspacePath, 'tests', 'auth.test.ts'), 'export const tested = true\n')
    tempDirs.push(dataDir)

    process.env.CODEX_HOME = join(dataDir, 'codex-home')
    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])
    const orchestratorFixture = writeProviderAdapterFixture({
      fixtureId: 'team-e2e-orchestrator',
      provider: 'codex',
      root: dataDir,
      sessionId: '11111111-1111-4111-8111-111111111111',
      workspacePath,
    })
    const workerFixture = writeProviderAdapterFixture({
      fixtureId: 'team-e2e-worker',
      provider: 'codex',
      root: dataDir,
      sessionId: '22222222-2222-4222-8222-222222222222',
      workspacePath,
    })

    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const sessionResponse = await fetch(`${baseUrl}/api/ui/session`)
      const cookie = sessionResponse.headers.get('set-cookie')
      if (!cookie) {
        throw new Error('Expected UI session cookie')
      }
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Alpha',
          path: workspacePath,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'Alice' }),
      })
      expect(workerResponse.status).toBe(201)
      const worker = (await workerResponse.json()) as { id: string }

      hive.store.configureAgentLaunch(workspace.id, orchestratorId, {
        ...buildManagedProviderLaunchConfig('codex'),
        args: [],
        command: orchestratorFixture.command,
        interactiveCommand: orchestratorFixture.command,
      })
      hive.store.configureAgentLaunch(workspace.id, worker.id, {
        ...buildManagedProviderLaunchConfig('codex'),
        args: [],
        command: workerFixture.command,
        interactiveCommand: workerFixture.command,
      })
      await hive.store.startAgent(workspace.id, orchestratorId, {
        hivePort: String(hive.port),
      })
      await hive.store.startAgent(workspace.id, worker.id, {
        hivePort: String(hive.port),
      })
      await waitFor(() => {
        expect(hive.store.getAgentState(workspace.id, orchestratorId)).toMatchObject({
          conversationActivity: 'idle',
          processState: 'running',
        })
        expect(hive.store.getAgentState(workspace.id, worker.id)).toMatchObject({
          conversationActivity: 'idle',
          processState: 'running',
        })
      }, 10_000)

      const sendResponse = await fetch(`${baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token: hive.store.peekAgentToken(orchestratorId),
          to: 'Alice',
          text: '实现登录接口',
        }),
      })
      expect(sendResponse.status).toBe(202)
      const sendBody = (await sendResponse.json()) as { dispatch_id: string; ok: true }
      expect(sendBody.dispatch_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )

      await waitFor(() => {
        const stdin = workerFixture
          .readEvents()
          .filter((event) => event.kind === 'stdin')
          .flatMap((event) => event.text ?? '')
          .join('')
        expect(stdin).toContain(`dispatch_id: ${sendBody.dispatch_id}`)
        expect(stdin).toContain('实现登录接口')
        expect(stdin).not.toContain(`team report "<result>" --dispatch ${sendBody.dispatch_id}`)
      })

      const activeDispatchesResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches`,
        { headers: { cookie } }
      )
      expect(activeDispatchesResponse.status).toBe(200)
      const activeDispatches = (await activeDispatchesResponse.json()) as Array<{
        id: string
        workspace_id: string
        from_agent_id: string
        to_agent_id: string
        state: string
        text: string
        report_text: string | null
        artifacts: string[]
      }>
      expect(activeDispatches).toEqual([
        expect.objectContaining({
          id: sendBody.dispatch_id,
          workspace_id: workspace.id,
          from_agent_id: orchestratorId,
          to_agent_id: worker.id,
          state: 'submitted',
          text: '实现登录接口',
          report_text: null,
          artifacts: [],
        }),
      ])
      const anonymousDispatchesResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches`
      )
      expect(anonymousDispatchesResponse.status).toBe(403)

      const sendSecondTask = () =>
        fetch(`${baseUrl}/api/team/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            project_id: workspace.id,
            from_agent_id: orchestratorId,
            token: hive.store.peekAgentToken(orchestratorId),
            to: 'Alice',
            text: '补充测试',
          }),
        })
      const secondSendResponse = await sendSecondTask()
      expect(secondSendResponse.status).toBe(409)
      expect(await secondSendResponse.json()).toEqual({
        code: 'active_dispatch_exists',
        error: `Worker Alice already has active Dispatch ${sendBody.dispatch_id}`,
      })

      const reportResponse = await fetch(`${baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: worker.id,
          token: hive.store.peekAgentToken(worker.id),
          request_id: 'team-e2e-report',
          result: '补充测试已完成',
          artifacts: ['tests/auth.test.ts'],
        }),
      })
      expect(reportResponse.status).toBe(202)
      const reportBody = (await reportResponse.json()) as { dispatch_id: string; ok: true }
      expect(reportBody.dispatch_id).toBe(sendBody.dispatch_id)

      const acceptedSecondSendResponse = await sendSecondTask()
      expect(acceptedSecondSendResponse.status).toBe(202)
      const secondSendBody = (await acceptedSecondSendResponse.json()) as {
        dispatch_id: string
        ok: true
      }

      const cancelResponse = await fetch(`${baseUrl}/api/team/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token: hive.store.peekAgentToken(orchestratorId),
          dispatch_id: secondSendBody.dispatch_id,
          request_id: 'team-e2e-cancel',
          reason: '方向变更，登录接口任务取消',
        }),
      })
      expect(cancelResponse.status).toBe(202)
      const cancelBody = (await cancelResponse.json()) as { dispatch_id: string; ok: true }
      expect(cancelBody.dispatch_id).toBe(secondSendBody.dispatch_id)

      const reportedDispatchesResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches`,
        { headers: { cookie } }
      )
      expect(reportedDispatchesResponse.status).toBe(200)
      const reportedDispatches = (await reportedDispatchesResponse.json()) as Array<{
        id: string
        state: string
        report_text: string | null
        artifacts: string[]
      }>
      expect(reportedDispatches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: secondSendBody.dispatch_id,
            state: 'cancelled',
            report_text: '方向变更，登录接口任务取消',
            artifacts: [],
          }),
          expect.objectContaining({
            id: sendBody.dispatch_id,
            state: 'reported',
            report_text: '补充测试已完成',
            artifacts: ['tests/auth.test.ts'],
          }),
        ])
      )

      const pagedDispatchesResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches?limit=1&offset=1`,
        { headers: { cookie } }
      )
      expect(pagedDispatchesResponse.status).toBe(200)
      const pagedDispatches = (await pagedDispatchesResponse.json()) as Array<{ id: string }>
      expect(pagedDispatches).toEqual([expect.objectContaining({ id: secondSendBody.dispatch_id })])

      const submittedDispatchesResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches?state=submitted`,
        { headers: { cookie } }
      )
      expect(submittedDispatchesResponse.status).toBe(200)
      const submittedDispatches = (await submittedDispatchesResponse.json()) as Array<{
        id: string
        state: string
      }>
      expect(submittedDispatches).toEqual([])

      const cancelledDispatchesResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches?state=cancelled`,
        { headers: { cookie } }
      )
      expect(cancelledDispatchesResponse.status).toBe(200)
      const cancelledDispatches = (await cancelledDispatchesResponse.json()) as Array<{
        id: string
        state: string
      }>
      expect(cancelledDispatches).toEqual([
        expect.objectContaining({ id: secondSendBody.dispatch_id, state: 'cancelled' }),
      ])

      const invalidStateResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches?state=working`,
        { headers: { cookie } }
      )
      expect(invalidStateResponse.status).toBe(400)

      const deprecatedStatusResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches?status=submitted`,
        { headers: { cookie } }
      )
      expect(deprecatedStatusResponse.status).toBe(400)

      const malformedLimitResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches?limit=1abc`,
        { headers: { cookie } }
      )
      expect(malformedLimitResponse.status).toBe(400)

      const hugeOffsetResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches?offset=999999999999999999999`,
        { headers: { cookie } }
      )
      expect(hugeOffsetResponse.status).toBe(400)

      const cancelledReportResponse = await fetch(`${baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: worker.id,
          token: hive.store.peekAgentToken(worker.id),
          request_id: 'cancelled-dispatch-report',
          result: '已完成登录接口',
          artifacts: ['src/auth.ts'],
        }),
      })
      expect(cancelledReportResponse.status).toBe(409)

      await waitFor(async () => {
        const teamResponse = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
          headers: { cookie },
        })
        expect(teamResponse.status).toBe(200)
        const team = (await teamResponse.json()) as Array<{
          active_dispatch_id: string | null
          id: string
          process_state: string
          queued_dispatch_count: number
        }>

        expect(team).toContainEqual(
          expect.objectContaining({
            id: worker.id,
            active_dispatch_id: null,
            process_state: 'running',
            queued_dispatch_count: 0,
          })
        )
      })

      const runtimeStore = createRuntimeStore({ dataDir })
      try {
        const persistedDispatches = runtimeStore.listDispatches(workspace.id)
        expect(persistedDispatches).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: secondSendBody.dispatch_id,
              reportText: '方向变更，登录接口任务取消',
              status: 'cancelled',
            }),
            expect.objectContaining({
              id: sendBody.dispatch_id,
              reportText: '补充测试已完成',
              status: 'reported',
            }),
          ])
        )
        const messages = runtimeStore.listMessagesForRecovery(workspace.id, 0)
        expect(messages).toHaveLength(3)
        expect(messages).toContainEqual(
          expect.objectContaining({ type: 'send', to: worker.id, text: '实现登录接口' })
        )
        expect(messages).toContainEqual(
          expect.objectContaining({ type: 'send', to: worker.id, text: '补充测试' })
        )
        expect(messages).toContainEqual(
          expect.objectContaining({ type: 'report', from: worker.id, text: '补充测试已完成' })
        )
        const report = messages.find((message) => message.type === 'report')
        expect(report).not.toHaveProperty('status')
        expect(report).toMatchObject({ outcome: 'completed' })
      } finally {
        await runtimeStore.close()
      }
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }
  }, 20_000)
})
