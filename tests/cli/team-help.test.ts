import { afterEach, describe, expect, test, vi } from 'vitest'

import { runTeamCommand } from '../../src/cli/team.js'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
})

describe('team cli help', () => {
  test('loads role-aware root Help from the authenticated Runtime', async () => {
    process.env = {
      HIVE_AGENT_ID: 'worker-1',
      HIVE_AGENT_TOKEN: 'worker-token',
      HIVE_PORT: '12345',
      HIVE_PROJECT_ID: 'workspace-1',
    }
    const fetchSpy = vi.fn(async () =>
      Response.json({
        help: [
          'Team commands for Worker',
          '',
          '  list     Show current Agent state.',
          '  context  Read current responsibility.',
          '  status   Replace latest Status.',
          '  report   Submit terminal result.',
        ].join('\n'),
      })
    )
    vi.stubGlobal('fetch', fetchSpy)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['--help'])

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/api/workspaces/workspace-1/team/help',
      {
        headers: {
          'x-hive-agent-id': 'worker-1',
          'x-hive-agent-token': 'worker-token',
        },
        method: 'GET',
      }
    )
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Team commands for Worker'))
  })

  test('loads command-specific Help without executing the command', async () => {
    process.env = {
      HIVE_AGENT_ID: 'workspace-1:orchestrator',
      HIVE_AGENT_TOKEN: 'orchestrator-token',
      HIVE_PORT: '12345',
      HIVE_PROJECT_ID: 'workspace-1',
    }
    const fetchSpy = vi.fn(async () =>
      Response.json({ help: 'team send\n\nSyntax:\n  team send <worker-name> "<task>"' })
    )
    vi.stubGlobal('fetch', fetchSpy)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['send', '--help'])

    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/api/workspaces/workspace-1/team/help/send',
      expect.objectContaining({ method: 'GET' })
    )
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('team send'))
  })

  test('does not publish a cross-role tutorial without Agent authentication', async () => {
    process.env = {}
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(runTeamCommand(['--help'])).resolves.toBeUndefined()

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(output).toBe(
      'Team Help is role-aware and available inside an authenticated Yive Agent session.'
    )
    expect(output).not.toMatch(/team (add|send|report|status)/u)
  })

  test('team add posts an orchestrator-authorized worker creation request', async () => {
    process.env = {
      HIVE_AGENT_ID: 'workspace-1:orchestrator',
      HIVE_AGENT_TOKEN: 'token-1',
      HIVE_PORT: '12345',
      HIVE_PROJECT_ID: 'workspace-1',
    }
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            agent_start: { error: null, ok: true, run_id: 'run-1' },
            provider: 'codex',
            id: 'worker-1',
            kind: 'worker',
            name: 'VideoMaker',
            status: 'idle',
          }),
          { headers: { 'content-type': 'application/json' }, status: 201 }
        )
    )
    vi.stubGlobal('fetch', fetchSpy)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['add', 'VideoMaker', '--provider', 'codex', '--start'])

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/api/team/add',
      expect.objectContaining({
        body: JSON.stringify({
          autostart: true,
          provider: 'codex',
          hive_port: '12345',
          project_id: 'workspace-1',
          from_agent_id: 'workspace-1:orchestrator',
          token: 'token-1',
          name: 'VideoMaker',
        }),
        method: 'POST',
      })
    )
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      id: 'worker-1',
      name: 'VideoMaker',
    })
  })

  test('team report accepts a durable receipt without synchronous delivery fields', async () => {
    process.env = {
      HIVE_AGENT_ID: 'worker-1',
      HIVE_AGENT_TOKEN: 'token-1',
      HIVE_PORT: '12345',
      HIVE_PROJECT_ID: 'workspace-1',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              dispatch_id: 'dispatch-1',
              ok: true,
              outcome: 'completed',
              reported_at: 100,
              request_id: 'report-1',
            }),
            { headers: { 'content-type': 'application/json' }, status: 202 }
          )
      )
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runTeamCommand(['report', 'Done'])

    expect(errorSpy).not.toHaveBeenCalled()
    const fetchMock = vi.mocked(fetch)
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >
    expect(request).toMatchObject({ outcome: 'completed', result: 'Done' })
    expect(request.request_id).toEqual(expect.any(String))
  })
})
