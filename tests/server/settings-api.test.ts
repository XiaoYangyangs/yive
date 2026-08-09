import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

describe('settings api', () => {
  test('app state can round-trip without a Provider settings catalog', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const beforeResponse = await fetch(
      `${server.baseUrl}/api/settings/app-state/active_workspace_id`,
      { headers: { cookie } }
    )
    expect(beforeResponse.status).toBe(200)
    await expect(beforeResponse.json()).resolves.toEqual({
      key: 'active_workspace_id',
      value: null,
    })

    const updateResponse = await fetch(
      `${server.baseUrl}/api/settings/app-state/active_workspace_id`,
      {
        body: JSON.stringify({ value: 'ws-123' }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'PUT',
      }
    )
    expect(updateResponse.status).toBe(204)

    const afterResponse = await fetch(
      `${server.baseUrl}/api/settings/app-state/active_workspace_id`,
      { headers: { cookie } }
    )
    await expect(afterResponse.json()).resolves.toEqual({
      key: 'active_workspace_id',
      value: 'ws-123',
    })
  })

  test('the retired command preset settings surface is unavailable', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const suffix = method === 'PATCH' || method === 'DELETE' ? '/legacy' : ''
      const response = await fetch(`${server.baseUrl}/api/settings/command-presets${suffix}`, {
        body: method === 'POST' || method === 'PATCH' ? '{}' : undefined,
        headers: { 'content-type': 'application/json', cookie },
        method,
      })
      expect(response.status).toBe(404)
    }
  })
})
