import { afterEach, describe, expect, test, vi } from 'vitest'

import { runTeamCommand } from '../../src/cli/team.js'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
})

describe('team context cli', () => {
  test('requests focused Runtime Context without exposing credentials in output', async () => {
    process.env = {
      HIVE_AGENT_ID: 'workspace-1:orchestrator',
      HIVE_AGENT_TOKEN: 'agent-secret',
      HIVE_PORT: '12345',
      HIVE_PROJECT_ID: 'workspace-1',
    }
    const fetchSpy = vi.fn(async () =>
      Response.json({
        scope: 'worker',
        worker: { name: 'Alice', queued_dispatch_count: 0 },
      })
    )
    vi.stubGlobal('fetch', fetchSpy)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['context', '--worker', 'Alice'])

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/api/team/context',
      expect.objectContaining({
        body: JSON.stringify({
          project_id: 'workspace-1',
          from_agent_id: 'workspace-1:orchestrator',
          token: 'agent-secret',
          worker: 'Alice',
        }),
        method: 'POST',
      })
    )
    const output = String(logSpy.mock.calls[0]?.[0])
    expect(JSON.parse(output)).toEqual({
      scope: 'worker',
      worker: { name: 'Alice', queued_dispatch_count: 0 },
    })
    expect(output).not.toContain('agent-secret')
    expect(output).not.toContain('workspace-1:orchestrator')
  })

  test('rejects ambiguous Worker and Dispatch focus before contacting Runtime', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(
      runTeamCommand(['context', '--worker', 'Alice', '--dispatch', 'dispatch-1'])
    ).rejects.toThrow('Choose either --worker or --dispatch')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
