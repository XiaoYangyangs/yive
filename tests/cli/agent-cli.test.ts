import { afterEach, describe, expect, test, vi } from 'vitest'

import { runAgentCommand } from '../../src/cli/agent.js'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
})

const setAgentEnv = () => {
  process.env = {
    HIVE_AGENT_ID: 'worker-secret-id',
    HIVE_AGENT_TOKEN: 'agent-secret-token',
    HIVE_PORT: '4512',
    HIVE_PROJECT_ID: 'workspace-secret-id',
  }
}

describe('yive agent CLI', () => {
  test('loads role-aware Help from the Runtime and does not publish human administration tools', async () => {
    setAgentEnv()
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        help: 'Yive Agent tools for Worker\n\n  send-file  Send a Workspace Artifact.',
      })
    )
    vi.stubGlobal('fetch', fetchSpy)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runAgentCommand(['--help'])

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:4512/api/workspaces/workspace-secret-id/agent/help',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-hive-agent-id': 'worker-secret-id',
          'x-hive-agent-token': 'agent-secret-token',
        }),
      })
    )
    const output = String(logSpy.mock.calls[0]?.[0])
    expect(output).toContain('send-file')
    expect(output).not.toMatch(/\b(lan|relay|pair|runtime)\b/u)
  })

  test('sends a file using only an Artifact argument and keeps identities out of CLI output', async () => {
    setAgentEnv()
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(
        { artifact: 'dist/report.pdf', name: 'report.pdf', ok: true, size: 42 },
        { status: 201 }
      )
    )
    vi.stubGlobal('fetch', fetchSpy)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runAgentCommand(['send-file', 'dist/report.pdf'])

    const request = fetchSpy.mock.calls[0]
    expect(request?.[0]).toBe('http://127.0.0.1:4512/api/agent/send-file')
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      path: 'dist/report.pdf',
      workspace_id: 'workspace-secret-id',
    })
    const output = logSpy.mock.calls.flat().join('\n')
    expect(output).toContain('dist/report.pdf')
    expect(output).not.toContain('workspace-secret-id')
    expect(output).not.toContain('worker-secret-id')
    expect(output).not.toContain('agent-secret-token')
  })

  test('does not expose cross-role tools without authenticated Agent context', async () => {
    process.env = {}
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runAgentCommand(['--help'])

    const output = logSpy.mock.calls.flat().join('\n')
    expect(output).toContain('role-aware')
    expect(output).not.toMatch(/notify|send-file|lan|relay/u)
  })

  test('rejects ambiguous positional arguments and duplicate options', async () => {
    setAgentEnv()

    await expect(runAgentCommand(['send-file', 'one.md', 'two.md'])).rejects.toThrow(
      'Usage: yive agent send-file'
    )
    await expect(
      runAgentCommand(['notify', 'Done', '--body', 'one', '--body', 'two'])
    ).rejects.toThrow('Duplicate option: --body')
  })
})
