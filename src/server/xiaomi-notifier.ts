export type XiaomiNotifyResult =
  | {
      channel: 'xiaomi'
      failed: 0
      ok: false
      reason: 'no_tokens' | 'not_configured'
      sent: 0
    }
  | {
      channel: 'xiaomi'
      errors?: Array<{ reason: string; token: string }>
      failed: number
      ok: boolean
      sent: number
    }

let fetchOverrideForTests: typeof fetch | null = null

const readXiaomiConfig = () => {
  const appSecret = process.env.YIVE_XIAOMI_APP_SECRET?.trim()
  const packageName = process.env.YIVE_XIAOMI_PACKAGE_NAME?.trim()
  if (!appSecret || !packageName) return null
  return {
    appSecret,
    apiOrigin: process.env.YIVE_XIAOMI_API_ORIGIN?.trim() || 'https://api.xmpush.xiaomi.com',
    packageName,
  }
}

export const sendXiaomiNotification = async ({
  body,
  data = {},
  title,
  tokens,
}: {
  body: string
  data?: Record<string, string>
  title: string
  tokens: string[]
}): Promise<XiaomiNotifyResult> => {
  const uniqueTokens = [...new Set(tokens.map((token) => token.trim()).filter(Boolean))]
  if (uniqueTokens.length === 0) {
    return { channel: 'xiaomi', failed: 0, ok: false, reason: 'no_tokens', sent: 0 }
  }
  const config = readXiaomiConfig()
  if (!config) {
    return { channel: 'xiaomi', failed: 0, ok: false, reason: 'not_configured', sent: 0 }
  }

  const fetchImpl = fetchOverrideForTests ?? fetch
  const errors: Array<{ reason: string; token: string }> = []
  let sent = 0
  for (const token of uniqueTokens) {
    const form = new URLSearchParams()
    form.set('registration_id', token)
    form.set('title', title)
    form.set('description', body)
    form.set('payload', JSON.stringify({ ...data, body, title }))
    form.set('restricted_package_name', config.packageName)
    form.set('pass_through', '0')
    form.set('notify_type', '-1')
    form.set('extra.notify_effect', '1')
    try {
      const response = await fetchImpl(`${config.apiOrigin}/v3/message/regid`, {
        body: form,
        headers: {
          authorization: `key=${config.appSecret}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
        signal: AbortSignal.timeout(8_000),
      })
      if (response.ok) {
        sent += 1
      } else {
        errors.push({ reason: `http_${response.status}`, token: '<redacted>' })
      }
    } catch (error) {
      errors.push({
        reason: error instanceof Error ? error.message : 'request_failed',
        token: '<redacted>',
      })
    }
  }

  return {
    channel: 'xiaomi',
    ...(errors.length > 0 ? { errors } : {}),
    failed: errors.length,
    ok: sent > 0 && errors.length === 0,
    sent,
  }
}

export const resetXiaomiNotifierForTests = (): void => {
  fetchOverrideForTests = null
}

export const setXiaomiNotifierFetchForTests = (fetchImpl: typeof fetch | null): void => {
  fetchOverrideForTests = fetchImpl
}
