import { afterEach, describe, expect, test } from 'vitest'

import {
  sendWechatNotification,
  setWechatNotifierFetchForTests,
} from '../../src/server/wechat-notifier.js'

afterEach(() => {
  delete process.env.YIVE_WECHAT_SERVERCHAN_SENDKEY
  setWechatNotifierFetchForTests(null)
})

describe('wechat notifier', () => {
  test('skips ServerChan when no SendKey is configured', async () => {
    await expect(
      sendWechatNotification({ body: 'Need review.', title: 'Review needed' })
    ).resolves.toEqual({
      channel: 'serverchan',
      ok: false,
      reason: 'not_configured',
    })
  })

  test('pushes notifications through ServerChan when a SendKey is configured', async () => {
    process.env.YIVE_WECHAT_SERVERCHAN_SENDKEY = 'SCT_TEST_KEY'
    const calls: Array<{ body: string; headers?: HeadersInit; method?: string; url: string }> = []
    setWechatNotifierFetchForTests(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        body: String(init?.body ?? ''),
        headers: init?.headers,
        method: init?.method,
        url: String(input),
      })
      return new Response(JSON.stringify({ code: 0, message: 'success' }))
    })

    await expect(
      sendWechatNotification({ body: 'Open Files tab.', title: 'Build done' })
    ).resolves.toEqual({
      channel: 'serverchan',
      ok: true,
    })

    expect(calls).toEqual([
      {
        body: 'title=Build+done&desp=Open+Files+tab.',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
        url: 'https://sctapi.ftqq.com/SCT_TEST_KEY.send',
      },
    ])
  })
})
