import { afterEach, describe, expect, test } from 'vitest'

import {
  resetXiaomiNotifierForTests,
  sendXiaomiNotification,
  setXiaomiNotifierFetchForTests,
} from '../../src/server/xiaomi-notifier.js'

afterEach(() => {
  delete process.env.YIVE_XIAOMI_API_ORIGIN
  delete process.env.YIVE_XIAOMI_APP_SECRET
  delete process.env.YIVE_XIAOMI_PACKAGE_NAME
  resetXiaomiNotifierForTests()
})

describe('xiaomi notifier', () => {
  test('skips Xiaomi push when no RegID is registered', async () => {
    await expect(
      sendXiaomiNotification({ body: 'Need review.', title: 'Review needed', tokens: [] })
    ).resolves.toEqual({
      channel: 'xiaomi',
      failed: 0,
      ok: false,
      reason: 'no_tokens',
      sent: 0,
    })
  })

  test('skips Xiaomi push when credentials are not configured', async () => {
    await expect(
      sendXiaomiNotification({
        body: 'Need review.',
        title: 'Review needed',
        tokens: ['xiaomi-regid-12345678901234567890'],
      })
    ).resolves.toEqual({
      channel: 'xiaomi',
      failed: 0,
      ok: false,
      reason: 'not_configured',
      sent: 0,
    })
  })

  test('pushes notifications through Xiaomi regid API when configured', async () => {
    process.env.YIVE_XIAOMI_API_ORIGIN = 'https://unit.test.xiaomi'
    process.env.YIVE_XIAOMI_APP_SECRET = 'xiaomi-secret'
    process.env.YIVE_XIAOMI_PACKAGE_NAME = 'xin.yive.dev'
    const calls: Array<{ body: string; headers?: HeadersInit; method?: string; url: string }> = []
    setXiaomiNotifierFetchForTests(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        body: String(init?.body ?? ''),
        ...(init?.headers !== undefined ? { headers: init.headers } : {}),
        ...(init?.method !== undefined ? { method: init.method } : {}),
        url: String(input),
      })
      return new Response(JSON.stringify({ code: 0, result: 'ok' }))
    })

    await expect(
      sendXiaomiNotification({
        body: 'Open Files tab.',
        data: { workspace_id: 'workspace-1' },
        title: 'Build done',
        tokens: ['xiaomi-regid-a', 'xiaomi-regid-a', 'xiaomi-regid-b'],
      })
    ).resolves.toEqual({
      channel: 'xiaomi',
      failed: 0,
      ok: true,
      sent: 2,
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({
      body: expect.stringContaining('registration_id=xiaomi-regid-a'),
      headers: {
        authorization: 'key=xiaomi-secret',
        'content-type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
      url: 'https://unit.test.xiaomi/v3/message/regid',
    })
    expect(calls[0]?.body).toContain('restricted_package_name=xin.yive.dev')
    expect(calls[0]?.body).toContain('pass_through=0')
    expect(calls[1]?.body).toContain('registration_id=xiaomi-regid-b')
  })
})
