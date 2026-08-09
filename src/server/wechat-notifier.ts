export type WechatNotifyResult =
  | { channel: 'serverchan'; ok: false; reason: string }
  | { channel: 'serverchan'; ok: true }
  | { channel: 'serverchan'; ok: false; reason: 'not_configured' }

const SERVERCHAN_SENDKEY_ENV = 'YIVE_WECHAT_SERVERCHAN_SENDKEY'
let fetchOverrideForTests: typeof fetch | null = null

const readServerChanSendKey = (): string | null => {
  const value = process.env[SERVERCHAN_SENDKEY_ENV]?.trim()
  return value ? value : null
}

const createServerChanUrl = (sendKey: string): string =>
  `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`

export const sendWechatNotification = async ({
  body,
  title,
}: {
  body: string
  title: string
}): Promise<WechatNotifyResult> => {
  const sendKey = readServerChanSendKey()
  if (!sendKey) return { channel: 'serverchan', ok: false, reason: 'not_configured' }

  try {
    const fetchImpl = fetchOverrideForTests ?? fetch
    const form = new URLSearchParams()
    form.set('title', title)
    form.set('desp', body)
    const response = await fetchImpl(createServerChanUrl(sendKey), {
      body: form,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) {
      return { channel: 'serverchan', ok: false, reason: `http_${response.status}` }
    }
    return { channel: 'serverchan', ok: true }
  } catch (error) {
    return {
      channel: 'serverchan',
      ok: false,
      reason: error instanceof Error ? error.message : 'request_failed',
    }
  }
}

export const getWechatNotificationHelp = (): string[] => [
  `Set ${SERVERCHAN_SENDKEY_ENV}=<ServerChan SendKey> to also push yive mobile notify messages to WeChat.`,
  'Example: $env:YIVE_WECHAT_SERVERCHAN_SENDKEY="SCT..." ; pnpm dev:runtime',
]

export const setWechatNotifierFetchForTests = (fetchImpl: typeof fetch | null): void => {
  fetchOverrideForTests = fetchImpl
}
