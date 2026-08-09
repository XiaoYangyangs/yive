import { createServer, type Server } from 'node:http'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { runTeamCommand } from '../../src/cli/team.js'

const originalEnv = { ...process.env }
const servers: Server[] = []

afterEach(async () => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
    )
  )
})

describe('flat agent identity Team CLI contract', () => {
  test('does not publish Worker creation syntax without Agent authentication', async () => {
    process.env = {}
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['--help'])

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(output).toBe(
      'Team Help is role-aware and available inside an authenticated Yive Agent session.'
    )
    expect(output).not.toContain('team add')
    expect(output).not.toMatch(/--role|--description|coder|reviewer|tester|custom/iu)
  })

  test('posts a role-free Worker creation payload over the real HTTP boundary', async () => {
    let requestBody: Record<string, unknown> | null = null
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            agent_start: { error: null, ok: false, run_id: null },
            id: 'worker-1',
            kind: 'worker',
            name: 'VideoMaker',
            status: 'idle',
          })
        )
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected HTTP server port')

    process.env = {
      HIVE_AGENT_ID: 'workspace-1:orchestrator',
      HIVE_AGENT_TOKEN: 'token-1',
      HIVE_PORT: String(address.port),
      HIVE_PROJECT_ID: 'workspace-1',
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['add', 'VideoMaker'])

    expect(requestBody).toEqual({
      autostart: false,
      from_agent_id: 'workspace-1:orchestrator',
      hive_port: String(address.port),
      name: 'VideoMaker',
      project_id: 'workspace-1',
      token: 'token-1',
    })
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      id: 'worker-1',
      kind: 'worker',
      name: 'VideoMaker',
    })
  })
})
