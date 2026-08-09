import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  sendFeishuNotification,
  setFeishuNotifierFetchForTests,
  setFeishuNotifierNowForTests,
} from '../../src/server/feishu-notifier.js'

const tempDirs: string[] = []
const feishuEnvKeys = [
  'YIVE_FEISHU_APP_ID',
  'YIVE_FEISHU_APP_SECRET',
  'YIVE_FEISHU_WEBHOOK_URL',
  'YIVE_FEISHU_WEBHOOK_SECRET',
] as const
const inheritedFeishuEnv = new Map(feishuEnvKeys.map((key) => [key, process.env[key]]))

beforeEach(() => {
  for (const key of feishuEnvKeys) delete process.env[key]
})

afterEach(() => {
  for (const key of feishuEnvKeys) {
    const value = inheritedFeishuEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setFeishuNotifierFetchForTests(null)
  setFeishuNotifierNowForTests(null)
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('feishu notifier', () => {
  test('skips Feishu when no webhook URL is configured', async () => {
    await expect(
      sendFeishuNotification({ body: 'Need review.', title: 'Review needed' })
    ).resolves.toEqual({
      channel: 'feishu',
      ok: false,
      reason: 'not_configured',
    })
  })

  test('pushes text notifications through the Feishu bot webhook', async () => {
    process.env.YIVE_FEISHU_WEBHOOK_URL =
      'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook'
    const calls: Array<{ body: unknown; headers?: HeadersInit; method?: string; url: string }> = []
    setFeishuNotifierFetchForTests(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: { body: unknown; headers?: HeadersInit; method?: string; url: string } = {
        body: JSON.parse(String(init?.body ?? '{}')),
        url: String(input),
      }
      if (init?.headers) call.headers = init.headers
      if (init?.method) call.method = init.method
      calls.push(call)
      return Response.json({ code: 0, msg: 'success' })
    })

    await expect(
      sendFeishuNotification({ body: 'Open Files tab.', title: 'Build done' })
    ).resolves.toEqual({
      channel: 'feishu',
      ok: true,
    })

    expect(calls).toEqual([
      {
        body: {
          content: { text: 'Build done\nOpen Files tab.' },
          msg_type: 'text',
        },
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook',
      },
    ])
  })

  test('adds Feishu signature fields when a signing secret is configured', async () => {
    process.env.YIVE_FEISHU_WEBHOOK_URL =
      'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook'
    process.env.YIVE_FEISHU_WEBHOOK_SECRET = 'test-secret'
    setFeishuNotifierNowForTests(() => 1_700_000_000_000)
    const calls: Array<{ body: Record<string, unknown> }> = []
    setFeishuNotifierFetchForTests(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
      return Response.json({ code: 0, msg: 'success' })
    })

    await expect(
      sendFeishuNotification({ body: 'Need review.', title: 'Review needed' })
    ).resolves.toEqual({
      channel: 'feishu',
      ok: true,
    })

    expect(calls[0]?.body).toMatchObject({
      content: { text: 'Review needed\nNeed review.' },
      msg_type: 'text',
      timestamp: '1700000000',
    })
    expect(typeof calls[0]?.body.sign).toBe('string')
    expect(calls[0]?.body.sign).not.toContain('test-secret')
  })

  test('reports Feishu API failures without leaking webhook secrets', async () => {
    process.env.YIVE_FEISHU_WEBHOOK_URL =
      'https://open.feishu.cn/open-apis/bot/v2/hook/secret-webhook'
    process.env.YIVE_FEISHU_WEBHOOK_SECRET = 'secret-signing-key'
    setFeishuNotifierFetchForTests(async () =>
      Response.json({ code: 19021, msg: 'sign match fail or timestamp is not within one hour' })
    )

    const result = await sendFeishuNotification({ body: 'Blocked.', title: 'Need review' })

    expect(result).toEqual({
      channel: 'feishu',
      ok: false,
      reason: 'feishu_19021_sign match fail or timestamp is not within one hour',
    })
    expect(JSON.stringify(result)).not.toContain('secret-webhook')
    expect(JSON.stringify(result)).not.toContain('secret-signing-key')
  })

  test('reports non-2xx HTTP failures', async () => {
    process.env.YIVE_FEISHU_WEBHOOK_URL =
      'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook'
    setFeishuNotifierFetchForTests(async () => new Response('bad gateway', { status: 502 }))

    await expect(
      sendFeishuNotification({ body: 'Blocked.', title: 'Need review' })
    ).resolves.toEqual({
      channel: 'feishu',
      ok: false,
      reason: 'http_502',
    })
  })

  test('uploads and pushes image notifications when Feishu app credentials are configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yive-feishu-image-'))
    tempDirs.push(dir)
    const imagePath = join(dir, 'preview.png')
    writeFileSync(imagePath, 'pixels')
    process.env.YIVE_FEISHU_WEBHOOK_URL =
      'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook'
    process.env.YIVE_FEISHU_APP_ID = 'cli_app_id'
    process.env.YIVE_FEISHU_APP_SECRET = 'cli_app_secret'
    const calls: Array<{ body: unknown; headers?: HeadersInit; method?: string; url: string }> = []
    setFeishuNotifierFetchForTests(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const call: { body: unknown; headers?: HeadersInit; method?: string; url: string } = {
        body:
          typeof init?.body === 'string'
            ? JSON.parse(init.body)
            : init?.body instanceof FormData
              ? init.body
              : null,
        url,
      }
      if (init?.headers) call.headers = init.headers
      if (init?.method) call.method = init.method
      calls.push(call)
      if (url.endsWith('/bot/v2/hook/test-webhook')) {
        return Response.json({ code: 0, msg: 'success' })
      }
      if (url.endsWith('/auth/v3/tenant_access_token/internal')) {
        return Response.json({ code: 0, tenant_access_token: 'tenant-token' })
      }
      if (url.endsWith('/im/v1/images')) {
        return Response.json({ code: 0, data: { image_key: 'img_v2_preview' } })
      }
      throw new Error(`Unexpected Feishu URL: ${url}`)
    })

    await expect(
      sendFeishuNotification({
        body: 'Tap the preview.',
        image: { localPath: imagePath, mimeType: 'image/png', name: 'preview.png' },
        title: 'Preview ready',
      })
    ).resolves.toEqual({
      channel: 'feishu',
      image: { ok: true },
      ok: true,
    })

    expect(calls[0]).toMatchObject({
      body: {
        content: { text: 'Preview ready\nTap the preview.' },
        msg_type: 'text',
      },
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook',
    })
    expect(calls[1]).toMatchObject({
      body: { app_id: 'cli_app_id', app_secret: 'cli_app_secret' },
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    })
    expect(calls[2]?.body).toBeInstanceOf(FormData)
    expect(calls[2]).toMatchObject({
      headers: { authorization: 'Bearer tenant-token' },
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/im/v1/images',
    })
    expect(calls[3]).toMatchObject({
      body: {
        content: { image_key: 'img_v2_preview' },
        msg_type: 'image',
      },
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook',
    })
  })

  test('keeps text Feishu notifications successful when image app credentials are absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yive-feishu-image-no-app-'))
    tempDirs.push(dir)
    const imagePath = join(dir, 'preview.png')
    writeFileSync(imagePath, 'pixels')
    process.env.YIVE_FEISHU_WEBHOOK_URL =
      'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook'
    const calls: string[] = []
    setFeishuNotifierFetchForTests(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return Response.json({ code: 0, msg: 'success' })
    })

    await expect(
      sendFeishuNotification({
        body: 'Tap the preview.',
        image: { localPath: imagePath, mimeType: 'image/png', name: 'preview.png' },
        title: 'Preview ready',
      })
    ).resolves.toEqual({
      channel: 'feishu',
      image: { ok: false, reason: 'app_not_configured' },
      ok: true,
    })
    expect(calls).toEqual(['https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook'])
  })
})
