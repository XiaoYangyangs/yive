import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { runTeamCommand } from '../../src/cli/team.js'
import { buildManagedProviderLaunchConfig } from '../../src/server/managed-provider.js'
import { writeCrossPlatformNodeCli } from '../helpers/node-cli-fixtures.js'
import { writeProviderAdapterFixture } from '../helpers/provider-adapter-fixture.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const originalCodexHome = process.env.CODEX_HOME

const waitFor = async (assertion: () => void, timeoutMs = 2000, intervalMs = 25) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw lastError
}

interface HiveContext {
  baseUrl: string
  hive: Awaited<ReturnType<typeof runHiveCommand>>
  orchestratorId: string
  worker: { id: string; name: string }
  workerProviderFixture: ReturnType<typeof writeProviderAdapterFixture>
  workspaceId: string
}

const setupHive = async (): Promise<HiveContext> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-authz-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  for (const artifact of [
    'notes/evidence.txt',
    'reports/final.md',
    'reports/focused.txt',
    'status/latest.txt',
  ]) {
    const artifactPath = join(workspacePath, artifact)
    mkdirSync(dirname(artifactPath), { recursive: true })
    writeFileSync(artifactPath, `Artifact fixture: ${artifact}\n`)
  }
  tempDirs.push(dataDir)
  process.env.CODEX_HOME = join(dataDir, 'codex-home')

  process.env.HIVE_DATA_DIR = dataDir
  const hive = await runHiveCommand(['--port', '0'])
  const baseUrl = `http://127.0.0.1:${hive.port}`
  const uiCookie = await getUiCookie(baseUrl)

  const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
  })
  const workspace = (await workspaceResponse.json()) as { id: string }
  const orchestratorId = `${workspace.id}:orchestrator`

  const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ name: 'Alice' }),
  })
  const worker = (await workerResponse.json()) as { id: string; name: string }

  let workerProviderFixture: ReturnType<typeof writeProviderAdapterFixture> | undefined
  for (const [index, agentId] of [orchestratorId, worker.id].entries()) {
    const fixture = writeProviderAdapterFixture({
      fixtureId: `authz-agent-${index}`,
      provider: 'codex',
      root: dataDir,
      sessionId:
        index === 0
          ? '11111111-1111-4111-8111-111111111111'
          : '22222222-2222-4222-8222-222222222222',
      workspacePath,
    })
    if (agentId === worker.id) workerProviderFixture = fixture
    hive.store.configureAgentLaunch(workspace.id, agentId, {
      ...buildManagedProviderLaunchConfig('codex'),
      args: [],
      command: fixture.command,
      interactiveCommand: fixture.command,
    })
    await hive.store.startAgent(workspace.id, agentId, {
      hivePort: String(hive.port),
    })
    await waitFor(() => {
      expect(hive.store.getAgentState(workspace.id, agentId)).toMatchObject({
        conversationActivity: 'idle',
        processState: 'running',
      })
    }, 10_000)
  }
  if (!workerProviderFixture) throw new Error('Expected Worker Provider fixture')

  return {
    baseUrl,
    hive,
    orchestratorId,
    worker,
    workerProviderFixture,
    workspaceId: workspace.id,
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  delete process.env.HIVE_DATA_DIR
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('team API authz (R1.4)', () => {
  test('rejects spoofed orchestrator id without a valid token (401)', async () => {
    const ctx = await setupHive()
    try {
      const response = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: 'totally-wrong-token',
          to: 'Alice',
          text: 'hack',
        }),
      })
      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toMatchObject({
        code: 'unauthorized',
      })
      const messages = ctx.hive.store.listMessagesForRecovery(ctx.workspaceId, 0)
      expect(messages.filter((item) => item.type === 'send')).toEqual([])
    } finally {
      await ctx.hive.close()
    }
  })

  test('rejects worker that invokes /api/team/send (403)', async () => {
    const ctx = await setupHive()
    try {
      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!workerToken) {
        throw new Error('Expected worker token after start')
      }
      const response = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.worker.id,
          token: workerToken,
          to: 'Alice',
          text: 'self-dispatch attempt',
        }),
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({
        code: 'team_command_forbidden',
        error: expect.stringContaining('Worker'),
      })
      const messages = ctx.hive.store.listMessagesForRecovery(ctx.workspaceId, 0)
      expect(messages.filter((item) => item.type === 'send')).toEqual([])
    } finally {
      await ctx.hive.close()
    }
  })

  test('rejects anonymous caller that invokes CLI team list endpoint (401)', async () => {
    const ctx = await setupHive()
    try {
      const response = await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/team`)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({
        code: 'unauthorized',
        error: 'Missing agent identity',
      })
    } finally {
      await ctx.hive.close()
    }
  })

  test('rejects caller without UI cookie for UI team endpoint (403)', async () => {
    const ctx = await setupHive()
    try {
      const response = await fetch(`${ctx.baseUrl}/api/ui/workspaces/${ctx.workspaceId}/team`)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'UI endpoint requires valid UI token' })
    } finally {
      await ctx.hive.close()
    }
  })

  test('returns role-aware Team Help through the authenticated Runtime', async () => {
    const ctx = await setupHive()
    try {
      const orchestratorToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!orchestratorToken || !workerToken) {
        throw new Error('Expected Agent tokens after start')
      }

      const requestHelp = async (agentId: string, token: string) => {
        const response = await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/team/help`, {
          headers: {
            'x-hive-agent-id': agentId,
            'x-hive-agent-token': token,
          },
        })
        expect(response.status).toBe(200)
        return (await response.json()) as { help: string }
      }

      const orchestrator = await requestHelp(ctx.orchestratorId, orchestratorToken)
      expect(orchestrator.help).toMatch(/^Team commands for Orchestrator$/mu)
      for (const command of [
        'list',
        'context',
        'add',
        'start',
        'restart',
        'stop',
        'send',
        'note',
        'cancel',
        'replace',
        'queue',
      ]) {
        expect(orchestrator.help).toMatch(new RegExp(`^  ${command}\\b`, 'mu'))
      }
      expect(orchestrator.help).not.toMatch(/^ {2}(report|status)\b/mu)

      const worker = await requestHelp(ctx.worker.id, workerToken)
      expect(worker.help).toMatch(/^Team commands for Worker$/mu)
      for (const command of ['list', 'context', 'status', 'report']) {
        expect(worker.help).toMatch(new RegExp(`^  ${command}\\b`, 'mu'))
      }
      expect(worker.help).not.toMatch(
        /^ {2}(add|start|restart|stop|send|note|cancel|replace|queue)\b/mu
      )

      for (const help of [orchestrator.help, worker.help]) {
        expect(help).not.toContain(orchestratorToken)
        expect(help).not.toContain(workerToken)
        expect(help).not.toContain(ctx.workspaceId)
        expect(help).not.toContain(ctx.orchestratorId)
        expect(help).not.toContain(ctx.worker.id)
      }
    } finally {
      await ctx.hive.close()
    }
  })

  test('returns complete command Help while keeping Runtime authorization authoritative', async () => {
    const ctx = await setupHive()
    try {
      const orchestratorToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!orchestratorToken || !workerToken) {
        throw new Error('Expected Agent tokens after start')
      }

      const commandUrl = `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/team/help/send`
      const response = await fetch(commandUrl, {
        headers: {
          'x-hive-agent-id': ctx.orchestratorId,
          'x-hive-agent-token': orchestratorToken,
        },
      })
      expect(response.status).toBe(200)
      const payload = (await response.json()) as { help: string }
      expect(payload.help).toBe(
        [
          'team send',
          '',
          'Syntax:',
          '  team send <worker-name> "<task>" [--artifact <path>] [--queue]',
          '',
          'Effects:',
          '  Without --queue, creates one active Dispatch and delivers it only to a running, verified-idle Worker.',
          '  With --queue, appends one persisted Dispatch without starting or writing to the Worker.',
          '',
          'Common errors:',
          '  401 unauthorized - the Agent identity or token is missing or invalid.',
          '  403 team_command_forbidden - the authenticated identity cannot use this command.',
          '  400 invalid_dispatch_request - queue or request_id is invalid.',
          '  409 active_dispatch_exists - the Worker already owns an active Dispatch.',
          '  409 agent_process_not_running - start the stopped or crashed Worker first.',
          '  409 agent_conversation_busy - wait for the current Provider turn to finish.',
          '  409 agent_conversation_unknown - inspect or recover the Provider session first.',
          '  409 dispatch_request_conflict - request_id was already used for different work.',
          '  409 worker_queue_paused - resume the Worker queue before assigning more work.',
          '',
          'Example:',
          '  team send Alice "Implement login validation"',
        ].join('\n')
      )

      const forbidden = await fetch(commandUrl, {
        headers: {
          'x-hive-agent-id': ctx.worker.id,
          'x-hive-agent-token': workerToken,
        },
      })
      expect(forbidden.status).toBe(403)
      await expect(forbidden.json()).resolves.toEqual({
        code: 'team_command_forbidden',
        error: 'Worker is not allowed to run team send',
      })
    } finally {
      await ctx.hive.close()
    }
  })

  test('publishes complete progressive Help for every role-visible Team command', async () => {
    const ctx = await setupHive()
    try {
      const orchestratorToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!orchestratorToken || !workerToken) {
        throw new Error('Expected Agent tokens after start')
      }

      const cases = [
        {
          agentId: ctx.orchestratorId,
          commands: {
            add: 'team add <worker-name> [--provider codex|claude] [--start]',
            cancel: 'team cancel --dispatch <dispatch-id> "<reason>" [--request-id <request-id>]',
            context: 'team context [--worker <worker-name> | --dispatch <dispatch-id>]',
            list: 'team list',
            note: 'team note --dispatch <dispatch-id> "<text>" [--artifact <path>]',
            queue: 'team queue resume <worker-name>',
            replace:
              'team replace --dispatch <dispatch-id> "<task>" [--artifact <path>] [--interrupt] [--request-id <request-id>]',
            restart: 'team restart <worker-name>',
            send: 'team send <worker-name> "<task>" [--artifact <path>] [--queue]',
            start: 'team start <worker-name>',
            stop: 'team stop <worker-name>',
          },
          token: orchestratorToken,
        },
        {
          agentId: ctx.worker.id,
          commands: {
            context: 'team context',
            list: 'team list',
            report: 'team report (<result> | --stdin) [--failed] [--artifact <path>]',
            status: 'team status (<current-status> | --stdin) [--notify] [--artifact <path>]',
          },
          token: workerToken,
        },
      ] as const

      for (const testCase of cases) {
        for (const [command, usage] of Object.entries(testCase.commands)) {
          const response = await fetch(
            `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/team/help/${command}`,
            {
              headers: {
                'x-hive-agent-id': testCase.agentId,
                'x-hive-agent-token': testCase.token,
              },
            }
          )
          expect(response.status, command).toBe(200)
          const payload = (await response.json()) as { help: string }
          expect(payload.help, command).toContain(`Syntax:\n  ${usage}`)
          expect(payload.help, command).toMatch(/\nEffects:\n {2}\S/u)
          expect(payload.help, command).toMatch(/\nCommon errors:\n {2}\S/u)
          expect(payload.help, command).toMatch(/\nExample:\n {2}team /u)
          expect(payload.help.length, command).toBeLessThan(2500)
          if (command === 'status') {
            expect(payload.help).toContain('no_active_dispatch')
            expect(payload.help).toContain('status_request_conflict')
          }
          if (command === 'report') {
            expect(payload.help).toContain('report_request_conflict')
          }
        }
      }
    } finally {
      await ctx.hive.close()
    }
  })

  test('returns a bounded default Orchestrator Team Context without queued task bodies', async () => {
    const ctx = await setupHive()
    try {
      const orchestratorToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!orchestratorToken || !workerToken) {
        throw new Error('Expected Agent tokens after start')
      }

      const sendResponse = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchestratorToken,
          to: 'Alice',
          text: 'Implement login validation\nPRIVATE ACTIVE DETAIL',
        }),
      })
      expect(sendResponse.status).toBe(202)
      const active = (await sendResponse.json()) as { dispatch_id: string }

      const queued = await ctx.hive.store.dispatchTask(
        ctx.workspaceId,
        ctx.worker.id,
        'PRIVATE QUEUED TASK BODY'
      )
      expect(queued.status).toBe('queued')

      const statusResponse = await fetch(`${ctx.baseUrl}/api/team/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.worker.id,
          token: workerToken,
          request_id: 'bounded-context-status',
          result: 'Focused tests are running',
          artifacts: ['reports/focused.txt'],
        }),
      })
      expect(statusResponse.status).toBe(202)

      const response = await fetch(`${ctx.baseUrl}/api/team/context`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchestratorToken,
        }),
      })
      const context = await response.json()
      expect(response.status, JSON.stringify(context)).toBe(200)
      expect(context).toEqual({
        member_total_count: 1,
        members: [
          {
            actionable_failures: [],
            active_dispatch: {
              id: active.dispatch_id,
              task_first_line: 'Implement login validation',
            },
            conversation_activity: expect.stringMatching(/^(busy|idle)$/u),
            kind: 'worker',
            last_observed_at: expect.any(Number),
            latest_status: {
              artifacts: ['reports/focused.txt'],
              text: 'Focused tests are running',
              updated_at: expect.any(Number),
            },
            name: 'Alice',
            process_state: 'running',
            provider: 'codex',
            queue_pause_reason: null,
            queued_dispatch_count: 1,
          },
        ],
        members_truncated: false,
        scope: 'team',
      })
      const serialized = JSON.stringify(context)
      expect(serialized).not.toContain('PRIVATE ACTIVE DETAIL')
      expect(serialized).not.toContain('PRIVATE QUEUED TASK BODY')
      expect(serialized).not.toContain(orchestratorToken)
      expect(serialized).not.toContain(workerToken)
      expect(serialized).not.toContain(ctx.workspaceId)
      expect(serialized).not.toContain(ctx.orchestratorId)
      expect(serialized).not.toContain(ctx.worker.id)
    } finally {
      await ctx.hive.close()
    }
  })

  test('scopes focused Team Context to current Worker responsibility and hides future work', async () => {
    const ctx = await setupHive()
    try {
      const orchestratorToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!orchestratorToken || !workerToken) {
        throw new Error('Expected Agent tokens after start')
      }

      const sendResponse = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchestratorToken,
          to: 'Alice',
          text: 'Implement scoped Context\nCURRENT RESPONSIBILITY DETAIL',
        }),
      })
      expect(sendResponse.status).toBe(202)
      const active = (await sendResponse.json()) as { dispatch_id: string }
      ctx.workerProviderFixture.appendUser('Implement scoped Context')
      ctx.workerProviderFixture.appendAssistant('Scoped Dispatch completed')
      ctx.workerProviderFixture.appendCompletion()
      await waitFor(() => {
        expect(
          ctx.hive.store.getCurrentAgentConversation(ctx.workspaceId, ctx.worker.id)
        ).toMatchObject({
          activity_state: 'idle',
          turns: expect.arrayContaining([
            expect.objectContaining({ text: 'Scoped Dispatch completed' }),
          ]),
        })
      }, 10_000)

      const noteId = '33333333-3333-4333-8333-333333333333'
      const noteResponse = await fetch(`${ctx.baseUrl}/api/team/note`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          artifacts: ['notes/evidence.txt'],
          dispatch_id: active.dispatch_id,
          from_agent_id: ctx.orchestratorId,
          note_id: noteId,
          project_id: ctx.workspaceId,
          text: 'DELIVERED NOTE BODY',
          token: orchestratorToken,
        }),
      })
      expect(noteResponse.status).toBe(201)
      await waitFor(() => {
        expect(ctx.hive.store.getDispatchNote(ctx.workspaceId, noteId)?.deliveryState).toBe(
          'delivered'
        )
      }, 10_000)

      const statusResponse = await fetch(`${ctx.baseUrl}/api/team/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.worker.id,
          token: workerToken,
          request_id: 'focused-context-status',
          result: 'LATEST WORKER STATUS',
          artifacts: ['status/latest.txt'],
        }),
      })
      expect(statusResponse.status).toBe(202)

      const queued = await ctx.hive.store.dispatchTask(
        ctx.workspaceId,
        ctx.worker.id,
        'PRIVATE ALICE QUEUED BODY'
      )
      const bob = ctx.hive.store.addWorker(ctx.workspaceId, { name: 'Bob' })
      await ctx.hive.store.dispatchTask(ctx.workspaceId, bob.id, 'PRIVATE BOB TASK BODY')

      const requestContext = async (
        agentId: string,
        token: string,
        focus: Record<string, string> = {}
      ) => {
        const response = await fetch(`${ctx.baseUrl}/api/team/context`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...focus,
            project_id: ctx.workspaceId,
            from_agent_id: agentId,
            token,
          }),
        })
        expect(response.status).toBe(200)
        return response.json()
      }

      const focused = await requestContext(ctx.orchestratorId, orchestratorToken, {
        worker: 'Alice',
      })
      expect(focused).toMatchObject({
        active_dispatch: {
          artifacts: [],
          id: active.dispatch_id,
          latest_status: {
            artifacts: ['status/latest.txt'],
            text: 'LATEST WORKER STATUS',
          },
          notes: [
            {
              artifacts: ['notes/evidence.txt'],
              delivery_state: 'delivered',
              id: noteId,
              text: 'DELIVERED NOTE BODY',
            },
          ],
          report: null,
          status: 'submitted',
          task: 'Implement scoped Context\nCURRENT RESPONSIBILITY DETAIL',
        },
        queue: [
          {
            id: queued.id,
            status: 'queued',
            task: 'PRIVATE ALICE QUEUED BODY',
          },
        ],
        scope: 'worker',
        worker: {
          name: 'Alice',
          queued_dispatch_count: 1,
        },
      })

      const own = await requestContext(ctx.worker.id, workerToken)
      expect(own).toMatchObject({
        active_dispatch: {
          id: active.dispatch_id,
          latest_status: { text: 'LATEST WORKER STATUS' },
          notes: [{ id: noteId, text: 'DELIVERED NOTE BODY' }],
          task: 'Implement scoped Context\nCURRENT RESPONSIBILITY DETAIL',
        },
        queued_dispatch_count: 1,
        scope: 'responsibility',
        worker: { name: 'Alice' },
      })

      const previousEnv = {
        HIVE_AGENT_ID: process.env.HIVE_AGENT_ID,
        HIVE_AGENT_TOKEN: process.env.HIVE_AGENT_TOKEN,
        HIVE_PORT: process.env.HIVE_PORT,
        HIVE_PROJECT_ID: process.env.HIVE_PROJECT_ID,
      }
      const output: string[] = []
      const logSpy = vi.spyOn(console, 'log').mockImplementation((value) => {
        output.push(String(value))
      })
      try {
        process.env.HIVE_AGENT_ID = ctx.orchestratorId
        process.env.HIVE_AGENT_TOKEN = orchestratorToken
        process.env.HIVE_PORT = String(ctx.hive.port)
        process.env.HIVE_PROJECT_ID = ctx.workspaceId

        await runTeamCommand(['context', '--dispatch', active.dispatch_id])

        expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({
          dispatch: { id: active.dispatch_id },
          scope: 'dispatch',
        })
      } finally {
        logSpy.mockRestore()
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
      expect(own).not.toHaveProperty('queue')
      const workerSerialized = JSON.stringify(own)
      expect(workerSerialized).not.toContain('PRIVATE ALICE QUEUED BODY')
      expect(workerSerialized).not.toContain('PRIVATE BOB TASK BODY')
      expect(workerSerialized).not.toContain(bob.id)
      expect(workerSerialized).not.toContain(ctx.workspaceId)
      expect(workerSerialized).not.toContain(ctx.worker.id)
      expect(workerSerialized).not.toContain(orchestratorToken)
      expect(workerSerialized).not.toContain(workerToken)
    } finally {
      await ctx.hive.close()
    }
  })

  test('returns a terminal Report to its Worker and through Orchestrator Dispatch focus', async () => {
    const ctx = await setupHive()
    try {
      const orchestratorToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!orchestratorToken || !workerToken) {
        throw new Error('Expected Agent tokens after start')
      }

      const sendResponse = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchestratorToken,
          to: 'Alice',
          text: 'Produce the verification report',
        }),
      })
      expect(sendResponse.status).toBe(202)
      const active = (await sendResponse.json()) as { dispatch_id: string }

      const reportResponse = await fetch(`${ctx.baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          artifacts: ['reports/final.md'],
          from_agent_id: ctx.worker.id,
          project_id: ctx.workspaceId,
          request_id: 'terminal-context-report',
          result: 'FINAL VERIFIED RESULT',
          token: workerToken,
        }),
      })
      expect(reportResponse.status).toBe(202)

      const workerFocusResponse = await fetch(`${ctx.baseUrl}/api/team/context`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          from_agent_id: ctx.orchestratorId,
          project_id: ctx.workspaceId,
          token: orchestratorToken,
          worker: 'Alice',
        }),
      })
      expect(workerFocusResponse.status).toBe(200)
      await expect(workerFocusResponse.json()).resolves.toMatchObject({
        active_dispatch: null,
        recent_report: {
          artifacts: ['reports/final.md'],
          id: active.dispatch_id,
          reported_at: expect.any(Number),
          status: 'reported',
          text: 'FINAL VERIFIED RESULT',
        },
        scope: 'worker',
      })

      const workerContextResponse = await fetch(`${ctx.baseUrl}/api/team/context`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          from_agent_id: ctx.worker.id,
          project_id: ctx.workspaceId,
          token: workerToken,
        }),
      })
      expect(workerContextResponse.status).toBe(200)
      await expect(workerContextResponse.json()).resolves.toMatchObject({
        active_dispatch: null,
        recent_report: {
          artifacts: ['reports/final.md'],
          id: active.dispatch_id,
          reported_at: expect.any(Number),
          status: 'reported',
          text: 'FINAL VERIFIED RESULT',
        },
        scope: 'responsibility',
      })

      const response = await fetch(`${ctx.baseUrl}/api/team/context`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dispatch_id: active.dispatch_id,
          from_agent_id: ctx.orchestratorId,
          project_id: ctx.workspaceId,
          token: orchestratorToken,
        }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        dispatch: {
          artifacts: ['reports/final.md'],
          id: active.dispatch_id,
          notes: [],
          report: {
            artifacts: ['reports/final.md'],
            reported_at: expect.any(Number),
            text: 'FINAL VERIFIED RESULT',
          },
          status: 'reported',
          task: 'Produce the verification report',
        },
        scope: 'dispatch',
        worker: { name: 'Alice' },
      })

      const forbidden = await fetch(`${ctx.baseUrl}/api/team/context`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dispatch_id: active.dispatch_id,
          from_agent_id: ctx.worker.id,
          project_id: ctx.workspaceId,
          token: workerToken,
        }),
      })
      expect(forbidden.status).toBe(403)
      expect(JSON.stringify(await forbidden.json())).not.toContain('FINAL VERIFIED RESULT')
    } finally {
      await ctx.hive.close()
    }
  })

  test('lets a Worker inspect canonical Team state without task bodies or credentials', async () => {
    const ctx = await setupHive()
    try {
      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!workerToken) {
        throw new Error('Expected worker token after start')
      }
      await ctx.hive.store.dispatchTask(ctx.workspaceId, ctx.worker.id, 'PRIVATE QUEUED TASK BODY')
      const response = await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/team`, {
        method: 'GET',
        headers: {
          'x-hive-agent-id': ctx.worker.id,
          'x-hive-agent-token': workerToken,
        },
      })
      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(payload).toEqual([
        expect.objectContaining({
          conversation_activity: expect.stringMatching(/^(busy|idle)$/u),
          id: ctx.worker.id,
          kind: 'worker',
          name: 'Alice',
          process_state: 'running',
          queued_dispatch_count: 1,
        }),
      ])
      const serialized = JSON.stringify(payload)
      expect(serialized).not.toContain('PRIVATE QUEUED TASK BODY')
      expect(serialized).not.toContain(workerToken)
    } finally {
      await ctx.hive.close()
    }
  })

  test('orchestrator can invoke CLI team list endpoint (200)', async () => {
    const ctx = await setupHive()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) {
        throw new Error('Expected orchestrator token after start')
      }
      const response = await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/team`, {
        method: 'GET',
        headers: {
          'x-hive-agent-id': ctx.orchestratorId,
          'x-hive-agent-token': orchToken,
        },
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual([
        expect.objectContaining({
          active_dispatch_id: null,
          conversation_activity: 'idle',
          provider: 'codex',
          conversation_provider: 'codex',
          id: ctx.worker.id,
          kind: 'worker',
          name: 'Alice',
          process_state: 'running',
          queue_pause_reason: null,
          queued_dispatch_count: 0,
        }),
      ])
    } finally {
      await ctx.hive.close()
    }
  })

  test('rejects orchestrator that invokes team report (403)', async () => {
    const ctx = await setupHive()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) {
        throw new Error('Expected orchestrator token after start')
      }

      const response = await fetch(`${ctx.baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          result: 'orchestrator should not self-report',
          artifacts: [],
        }),
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        code: 'team_command_forbidden',
        error: 'Orchestrator is not allowed to run team report',
      })
      const statusResponse = await fetch(`${ctx.baseUrl}/api/team/status`, {
        body: JSON.stringify({
          from_agent_id: ctx.orchestratorId,
          project_id: ctx.workspaceId,
          request_id: 'orchestrator-status-forbidden',
          result: 'orchestrator should not publish Worker Status',
          token: orchToken,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      expect(statusResponse.status).toBe(403)
      await expect(statusResponse.json()).resolves.toEqual({
        code: 'team_command_forbidden',
        error: 'Orchestrator is not allowed to run team status',
      })

      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!workerToken) throw new Error('Expected Worker token after start')
      const queueResponse = await fetch(`${ctx.baseUrl}/api/team/queue/resume`, {
        body: JSON.stringify({
          from_agent_id: ctx.worker.id,
          project_id: ctx.workspaceId,
          token: workerToken,
          worker: 'Alice',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      expect(queueResponse.status).toBe(403)
      await expect(queueResponse.json()).resolves.toEqual({
        code: 'team_command_forbidden',
        error: 'Worker is not allowed to run team queue',
      })
      expect(
        ctx.hive.store
          .listMessagesForRecovery(ctx.workspaceId, 0)
          .filter((item) => item.type === 'report')
      ).toEqual([])
      expect(ctx.hive.store.listDispatches(ctx.workspaceId)).toEqual([])
    } finally {
      await ctx.hive.close()
    }
  })

  test('rejects token from workspace A used against workspace B (401)', async () => {
    const ctxA = await setupHive()
    try {
      const tokenA = ctxA.hive.store.peekAgentToken(ctxA.orchestratorId)
      if (!tokenA) {
        throw new Error('Expected orchestrator token after start')
      }
      // Forged request: orchestrator id from workspace A, projectId of a different workspace
      // that exists alongside. Create a second workspace via the same runtime.
      const secondWorkspacePath = mkdtempSync(join(tmpdir(), 'hive-authz-beta-'))
      tempDirs.push(secondWorkspacePath)
      const secondResponse = await fetch(`${ctxA.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await getUiCookie(ctxA.baseUrl),
        },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Beta',
          path: secondWorkspacePath,
        }),
      })
      expect(secondResponse.status).toBe(201)
      const secondWorkspace = (await secondResponse.json()) as { id: string }

      const response = await fetch(`${ctxA.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: secondWorkspace.id,
          from_agent_id: ctxA.orchestratorId,
          token: tokenA,
          to: 'Alice',
          text: 'cross-workspace dispatch attempt',
        }),
      })
      expect(response.status).toBe(401)
    } finally {
      await ctxA.hive.close()
    }
  })

  test('worker reporting with its own token succeeds (202) and decrements pending count', async () => {
    const ctx = await setupHive()
    try {
      // Bump pending so we can verify decrement.
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) {
        throw new Error('Expected orchestrator token after start')
      }
      await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          to: 'Alice',
          text: 'task A',
        }),
      })
      expect(ctx.hive.store.getAgentState(ctx.workspaceId, ctx.worker.id)).toMatchObject({
        activeDispatchId: expect.any(String),
        queuedDispatchCount: 0,
      })

      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!workerToken) {
        throw new Error('Expected worker token after start')
      }
      const response = await fetch(`${ctx.baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.worker.id,
          token: workerToken,
          request_id: 'worker-report-success',
          result: 'done',
          artifacts: [],
        }),
      })
      expect(response.status).toBe(202)
      expect(ctx.hive.store.getAgentState(ctx.workspaceId, ctx.worker.id)).toMatchObject({
        activeDispatchId: null,
        queuedDispatchCount: 0,
      })
    } finally {
      await ctx.hive.close()
    }
  })

  test('worker report without an open dispatch is rejected and records no report', async () => {
    const ctx = await setupHive()
    try {
      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!workerToken) {
        throw new Error('Expected worker token after start')
      }

      const response = await fetch(`${ctx.baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.worker.id,
          token: workerToken,
          request_id: 'report-without-dispatch',
          result: 'connected and waiting for work',
          artifacts: [],
        }),
      })

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toEqual({
        code: 'no_active_dispatch',
        error: 'No open dispatch for worker: Alice',
      })
      expect(ctx.hive.store.getAgentState(ctx.workspaceId, ctx.worker.id)).toMatchObject({
        activeDispatchId: null,
        queuedDispatchCount: 0,
      })
      expect(
        ctx.hive.store
          .listMessagesForRecovery(ctx.workspaceId, 0)
          .filter((item) => item.type === 'report')
      ).toEqual([])
      expect(ctx.hive.store.listDispatches(ctx.workspaceId)).toEqual([])
    } finally {
      await ctx.hive.close()
    }
  })

  test('worker cancel is rejected and a real cancellation remains visible in Worker Context', async () => {
    const ctx = await setupHive()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) {
        throw new Error('Expected orchestrator token after start')
      }
      const sendResponse = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          to: 'Alice',
          text: 'task A',
        }),
      })
      const sendBody = (await sendResponse.json()) as { dispatch_id: string }

      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!workerToken) {
        throw new Error('Expected worker token after start')
      }
      const response = await fetch(`${ctx.baseUrl}/api/team/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.worker.id,
          token: workerToken,
          dispatch_id: sendBody.dispatch_id,
          request_id: 'worker-cancel-forbidden',
          reason: 'not allowed',
        }),
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        code: 'team_command_forbidden',
        error: 'Worker is not allowed to run team cancel',
      })
      const replaceResponse = await fetch(`${ctx.baseUrl}/api/team/replace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.worker.id,
          token: workerToken,
          dispatch_id: sendBody.dispatch_id,
          request_id: 'worker-replace-forbidden',
          text: 'Workers cannot replace their own responsibility',
        }),
      })
      expect(replaceResponse.status).toBe(403)
      await expect(replaceResponse.json()).resolves.toEqual({
        code: 'team_command_forbidden',
        error: 'Worker is not allowed to run team replace',
      })
      expect(ctx.hive.store.listDispatches(ctx.workspaceId)).toEqual([
        expect.objectContaining({ id: sendBody.dispatch_id, status: 'submitted' }),
      ])
      expect(ctx.hive.store.getAgentState(ctx.workspaceId, ctx.worker.id)).toMatchObject({
        activeDispatchId: sendBody.dispatch_id,
        queuedDispatchCount: 0,
      })

      const cancelResponse = await fetch(`${ctx.baseUrl}/api/team/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          dispatch_id: sendBody.dispatch_id,
          request_id: 'orchestrator-cancel-authorized',
          reason: 'direction changed',
        }),
      })
      expect(cancelResponse.status).toBe(202)

      const contextResponse = await fetch(`${ctx.baseUrl}/api/team/context`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.worker.id,
          token: workerToken,
        }),
      })
      expect(contextResponse.status).toBe(200)
      await expect(contextResponse.json()).resolves.toMatchObject({
        active_dispatch: null,
        recent_cancellation: {
          id: sendBody.dispatch_id,
          reason: 'direction changed',
          status: 'cancelled',
        },
        scope: 'responsibility',
      })
    } finally {
      await ctx.hive.close()
    }
  })

  test('worker status without an active Dispatch is rejected and records no snapshot', async () => {
    const ctx = await setupHive()
    try {
      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!workerToken) {
        throw new Error('Expected worker token after start')
      }

      const response = await fetch(`${ctx.baseUrl}/api/team/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.worker.id,
          token: workerToken,
          request_id: 'status-without-dispatch',
          result: 'connected and waiting for work',
          artifacts: [],
        }),
      })

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toEqual({
        code: 'no_active_dispatch',
        error: 'No open dispatch for worker: Alice',
      })
      expect(ctx.hive.store.getAgentState(ctx.workspaceId, ctx.worker.id)).toMatchObject({
        activeDispatchId: null,
        queuedDispatchCount: 0,
      })
      expect(
        ctx.hive.store
          .listMessagesForRecovery(ctx.workspaceId, 0)
          .filter((item) => item.type === 'status')
      ).toEqual([])
      expect(ctx.hive.store.listDispatches(ctx.workspaceId)).toEqual([])

      const orchestratorToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchestratorToken) throw new Error('Expected orchestrator token after start')
      const sendResponse = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchestratorToken,
          to: 'Alice',
          text: 'new responsibility',
        }),
      })
      expect(sendResponse.status).toBe(202)

      const contextResponse = await fetch(`${ctx.baseUrl}/api/team/context`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.worker.id,
          token: workerToken,
        }),
      })
      expect(contextResponse.status).toBe(200)
      await expect(contextResponse.json()).resolves.toMatchObject({
        active_dispatch: {
          latest_status: null,
          task: 'new responsibility',
        },
        scope: 'responsibility',
      })
    } finally {
      await ctx.hive.close()
    }
  })

  test('worker status rejects an empty result and records no status message', async () => {
    const ctx = await setupHive()
    try {
      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!workerToken) {
        throw new Error('Expected worker token after start')
      }

      const response = await fetch(`${ctx.baseUrl}/api/team/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.worker.id,
          token: workerToken,
          result: '   ',
          artifacts: [],
        }),
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        code: 'invalid_status',
        error: 'Missing result',
      })
      expect(
        ctx.hive.store
          .listMessagesForRecovery(ctx.workspaceId, 0)
          .filter((item) => item.type === 'status')
      ).toEqual([])
    } finally {
      await ctx.hive.close()
    }
  })

  test('worker report with an explicit missing dispatch is rejected and records no report', async () => {
    const ctx = await setupHive()
    try {
      const workerToken = ctx.hive.store.peekAgentToken(ctx.worker.id)
      if (!workerToken) {
        throw new Error('Expected worker token after start')
      }

      const response = await fetch(`${ctx.baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.worker.id,
          token: workerToken,
          dispatch_id: 'missing-dispatch',
          result: 'done without dispatch',
          artifacts: [],
        }),
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        code: 'invalid_report',
        error: 'team report binds automatically; dispatch_id is not accepted',
      })
      expect(
        ctx.hive.store
          .listMessagesForRecovery(ctx.workspaceId, 0)
          .filter((item) => item.type === 'report')
      ).toEqual([])
      expect(ctx.hive.store.listDispatches(ctx.workspaceId)).toEqual([])
    } finally {
      await ctx.hive.close()
    }
  })

  test('orchestrator with valid token succeeds (202) and records send', async () => {
    const ctx = await setupHive()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) {
        throw new Error('Expected orchestrator token after start')
      }
      const response = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          to: 'Alice',
          text: 'Implement login',
        }),
      })
      expect(response.status).toBe(202)
      const messages = ctx.hive.store.listMessagesForRecovery(ctx.workspaceId, 0)
      expect(messages.some((item) => item.type === 'send' && item.text === 'Implement login')).toBe(
        true
      )
    } finally {
      await ctx.hive.close()
    }
  })

  test('rejects a second active Dispatch before recording or delivering it', async () => {
    const ctx = await setupHive()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) {
        throw new Error('Expected orchestrator token after start')
      }
      const send = (text: string) =>
        fetch(`${ctx.baseUrl}/api/team/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            project_id: ctx.workspaceId,
            from_agent_id: ctx.orchestratorId,
            token: orchToken,
            to: 'Alice',
            text,
          }),
        })

      const firstResponse = await send('First active task')
      expect(firstResponse.status).toBe(202)
      const first = (await firstResponse.json()) as { dispatch_id: string }

      const disguisedSecondTask = `Additional context for existing dispatch ${first.dispatch_id}`
      const disguisedSecondResponse = await send(disguisedSecondTask)
      expect(disguisedSecondResponse.status).toBe(409)
      await expect(disguisedSecondResponse.json()).resolves.toEqual({
        code: 'active_dispatch_exists',
        error: `Worker Alice already has active Dispatch ${first.dispatch_id}`,
      })

      const secondResponse = await send('Second active task')
      expect(secondResponse.status).toBe(409)
      await expect(secondResponse.json()).resolves.toEqual({
        code: 'active_dispatch_exists',
        error: `Worker Alice already has active Dispatch ${first.dispatch_id}`,
      })

      expect(ctx.hive.store.listDispatches(ctx.workspaceId)).toEqual([
        expect.objectContaining({ id: first.dispatch_id, status: 'submitted' }),
      ])
      expect(
        ctx.hive.store
          .listMessagesForRecovery(ctx.workspaceId, 0)
          .filter((message) => message.type === 'send')
      ).toEqual([expect.objectContaining({ text: 'First active task' })])
    } finally {
      await ctx.hive.close()
    }
  })

  test('team send rejects a stopped Worker without auto-starting it', async () => {
    const ctx = await setupHive()
    const originalPath = process.env.PATH
    try {
      const uiCookie = await getUiCookie(ctx.baseUrl)
      const workspacePath = join(tempDirs[0] ?? '', 'workspace')
      const portFile = join(workspacePath, 'worker-port.txt')
      const stoppedWorkerResponse = await fetch(
        `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/workers`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ name: 'Bob' }),
        }
      )
      expect(stoppedWorkerResponse.status).toBe(201)
      const command = writeCrossPlatformNodeCli(
        workspacePath,
        'codex',
        `const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'debug' && args[1] === 'prompt-input') {
  const configIndex = args.indexOf('-c')
  const instruction = args[configIndex + 1]?.replace(/^developer_instructions=/, '') ?? ''
  process.stdout.write(JSON.stringify([{ role: 'developer', content: [{ text: instruction }] }]))
  process.exit(0)
}
if (args.includes('--help')) {
  process.stdout.write('resume <session-id>\\n')
  process.exit(0)
}
fs.writeFileSync(${JSON.stringify(portFile)}, process.env.HIVE_PORT || '')
process.stdout.write('\\n\\u276f ')
process.stdin.resume()
setInterval(() => {}, 1000)
`
      )
      process.env.PATH = [dirname(command), originalPath].filter(Boolean).join(delimiter)

      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) {
        throw new Error('Expected orchestrator token after start')
      }

      const response = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hive_port: '65535',
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          to: 'Bob',
          text: 'start with correct port',
        }),
      })

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toEqual({
        code: 'agent_process_not_running',
        error: 'Worker Bob process is stopped; start it before assigning work',
      })
      expect(existsSync(portFile)).toBe(false)
    } finally {
      process.env.PATH = originalPath
      await ctx.hive.close()
    }
  })
})
