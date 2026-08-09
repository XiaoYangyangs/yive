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

describe('team send queue CLI contract', () => {
  test('posts an explicit queue request without adding the flag to the task body', async () => {
    let requestBody: Record<string, unknown> | null = null
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        requestBody = parsed
        response.writeHead(202, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            dispatch_id: 'dispatch-queue-1',
            ok: true,
            request_id: parsed.request_id,
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

    await runTeamCommand([
      'send',
      'Alice',
      'Implement login validation',
      '--artifact',
      'src/auth.ts',
      '--queue',
      '--artifact',
      'tests/auth.test.ts',
    ])

    expect(requestBody).toEqual({
      artifacts: ['src/auth.ts', 'tests/auth.test.ts'],
      from_agent_id: 'workspace-1:orchestrator',
      hive_port: String(address.port),
      project_id: 'workspace-1',
      queue: true,
      request_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      ),
      text: 'Implement login validation',
      to: 'Alice',
      token: 'token-1',
    })
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      dispatch_id: 'dispatch-queue-1',
      ok: true,
      request_id: expect.any(String),
    })
  })
})
