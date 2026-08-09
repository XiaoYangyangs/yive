import { describe, expect, test } from 'vitest'
import WebSocket from 'ws'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const readUpgradeStatus = async (url: string, cookie: string) =>
  await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie } })
    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0)
      response.resume()
    })
    socket.once('open', () => {
      socket.close()
      reject(new Error('Retired Tasks websocket unexpectedly opened'))
    })
    socket.once('error', reject)
  })

describe('retired Workspace Tasks websocket surface', () => {
  test('upgrade returns 404', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const url = `${server.baseUrl.replace('http://', 'ws://')}/ws/tasks/workspace-1`

      await expect(readUpgradeStatus(url, cookie)).resolves.toBe(404)
    } finally {
      await server.close()
    }
  })
})
