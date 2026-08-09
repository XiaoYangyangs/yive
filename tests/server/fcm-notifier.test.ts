import { generateKeyPairSync } from 'node:crypto'

import { afterEach, describe, expect, test } from 'vitest'

import {
  resetFcmNotifierForTests,
  sendFcmNotification,
  setFcmNotifierFetchForTests,
} from '../../src/server/fcm-notifier.js'

const configureFcm = () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  process.env.YIVE_FCM_PROJECT_ID = 'yive-test'
  process.env.YIVE_FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: 'firebase-adminsdk@test.iam.gserviceaccount.com',
    private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    project_id: 'yive-test',
  })
}

afterEach(() => {
  delete process.env.YIVE_FCM_PROJECT_ID
  delete process.env.YIVE_FCM_SERVICE_ACCOUNT_FILE
  delete process.env.YIVE_FCM_SERVICE_ACCOUNT_JSON
  resetFcmNotifierForTests()
})

describe('fcm notifier', () => {
  test('skips native push when no phone token is registered', async () => {
    await expect(
      sendFcmNotification({ body: 'Need review.', title: 'Review needed', tokens: [] })
    ).resolves.toEqual({
      channel: 'fcm',
      failed: 0,
      ok: false,
      reason: 'no_tokens',
      sent: 0,
    })
  })

  test('skips native push when Firebase credentials are not configured', async () => {
    await expect(
      sendFcmNotification({
        body: 'Need review.',
        title: 'Review needed',
        tokens: ['fcm-token-12345678901234567890'],
      })
    ).resolves.toEqual({
      channel: 'fcm',
      failed: 0,
      ok: false,
      reason: 'not_configured',
      sent: 0,
    })
  })

  test('pushes one FCM message per registered token when configured', async () => {
    configureFcm()
    const calls: Array<{ body: unknown; headers?: HeadersInit; method?: string; url: string }> = []
    setFcmNotifierFetchForTests(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawBody = String(init?.body ?? '')
      calls.push({
        body: rawBody.startsWith('{') ? JSON.parse(rawBody) : rawBody,
        ...(init?.headers !== undefined ? { headers: init.headers } : {}),
        ...(init?.method !== undefined ? { method: init.method } : {}),
        url: String(input),
      })
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }))
      }
      return new Response(JSON.stringify({ name: 'projects/yive-test/messages/1' }))
    })

    await expect(
      sendFcmNotification({
        body: 'Open Files tab.',
        data: { workspace_id: 'workspace-1' },
        title: 'Build done',
        tokens: ['fcm-token-a', 'fcm-token-a', 'fcm-token-b'],
      })
    ).resolves.toEqual({
      channel: 'fcm',
      failed: 0,
      ok: true,
      sent: 2,
    })

    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual(
      expect.objectContaining({
        method: 'POST',
        url: 'https://oauth2.googleapis.com/token',
      })
    )
    expect(calls.slice(1)).toEqual([
      expect.objectContaining({
        body: {
          message: {
            android: { priority: 'HIGH' },
            data: {
              body: 'Open Files tab.',
              title: 'Build done',
              workspace_id: 'workspace-1',
            },
            token: 'fcm-token-a',
          },
        },
        method: 'POST',
        url: 'https://fcm.googleapis.com/v1/projects/yive-test/messages:send',
      }),
      expect.objectContaining({
        body: expect.objectContaining({
          message: expect.objectContaining({ token: 'fcm-token-b' }),
        }),
      }),
    ])
  })
})
