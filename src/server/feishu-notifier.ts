import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'

export type FeishuNotifyResult =
  | { channel: 'feishu'; ok: false; reason: string }
  | {
      channel: 'feishu'
      image?: { ok: false; reason: string } | { ok: true }
      ok: true
    }
  | { channel: 'feishu'; ok: false; reason: 'not_configured' }

const FEISHU_WEBHOOK_URL_ENV = 'YIVE_FEISHU_WEBHOOK_URL'
const FEISHU_WEBHOOK_SECRET_ENV = 'YIVE_FEISHU_WEBHOOK_SECRET'
const FEISHU_APP_ID_ENV = 'YIVE_FEISHU_APP_ID'
const FEISHU_APP_SECRET_ENV = 'YIVE_FEISHU_APP_SECRET'
const FEISHU_TENANT_ACCESS_TOKEN_URL =
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'
const FEISHU_IMAGE_UPLOAD_URL = 'https://open.feishu.cn/open-apis/im/v1/images'
let fetchOverrideForTests: typeof fetch | null = null
let nowOverrideForTests: (() => number) | null = null

const readEnvValue = (name: string): string | null => {
  const value = process.env[name]?.trim()
  return value ? value : null
}

export const createFeishuWebhookSign = ({
  secret,
  timestamp,
}: {
  secret: string
  timestamp: number
}): string => createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')

const buildTextPayload = ({
  body,
  secret,
  title,
}: {
  body: string
  secret: string | null
  title: string
}): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    content: {
      text: body ? `${title}\n${body}` : title,
    },
    msg_type: 'text',
  }
  if (secret) {
    const timestamp = Math.floor((nowOverrideForTests?.() ?? Date.now()) / 1000)
    payload.timestamp = String(timestamp)
    payload.sign = createFeishuWebhookSign({ secret, timestamp })
  }
  return payload
}

const buildImagePayload = ({
  imageKey,
  secret,
}: {
  imageKey: string
  secret: string | null
}): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    content: {
      image_key: imageKey,
    },
    msg_type: 'image',
  }
  if (secret) {
    const timestamp = Math.floor((nowOverrideForTests?.() ?? Date.now()) / 1000)
    payload.timestamp = String(timestamp)
    payload.sign = createFeishuWebhookSign({ secret, timestamp })
  }
  return payload
}

const readFeishuErrorReason = async (response: Response): Promise<string> => {
  if (!response.ok) return `http_${response.status}`
  try {
    const result = (await response.json()) as { code?: number; msg?: string }
    if (result.code === 0) return ''
    return result.msg ? `feishu_${result.code ?? 'error'}_${result.msg}` : `feishu_${result.code}`
  } catch {
    return 'invalid_response'
  }
}

export const sendFeishuNotification = async ({
  body,
  image,
  title,
}: {
  body: string
  image?: {
    localPath: string
    mimeType: string
    name: string
  }
  title: string
}): Promise<FeishuNotifyResult> => {
  const webhookUrl = readEnvValue(FEISHU_WEBHOOK_URL_ENV)
  if (!webhookUrl) return { channel: 'feishu', ok: false, reason: 'not_configured' }

  try {
    const fetchImpl = fetchOverrideForTests ?? fetch
    const secret = readEnvValue(FEISHU_WEBHOOK_SECRET_ENV)
    const response = await fetchImpl(webhookUrl, {
      body: JSON.stringify(
        buildTextPayload({
          body,
          secret,
          title,
        })
      ),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
    })
    const reason = await readFeishuErrorReason(response)
    if (reason) return { channel: 'feishu', ok: false, reason }

    if (!image) return { channel: 'feishu', ok: true }

    const imageResult = await sendFeishuImage({
      fetchImpl,
      image,
      secret,
      webhookUrl,
    })
    return imageResult.ok
      ? { channel: 'feishu', image: { ok: true }, ok: true }
      : { channel: 'feishu', image: imageResult, ok: true }
  } catch (error) {
    return {
      channel: 'feishu',
      ok: false,
      reason:
        error instanceof Error && error.name === 'TimeoutError'
          ? 'request_timeout'
          : 'request_failed',
    }
  }
}

const readTenantAccessToken = async (fetchImpl: typeof fetch): Promise<string | null> => {
  const appId = readEnvValue(FEISHU_APP_ID_ENV)
  const appSecret = readEnvValue(FEISHU_APP_SECRET_ENV)
  if (!appId || !appSecret) return null

  const response = await fetchImpl(FEISHU_TENANT_ACCESS_TOKEN_URL, {
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`token_http_${response.status}`)
  const result = (await response.json()) as {
    code?: number
    msg?: string
    tenant_access_token?: string
  }
  if (result.code !== 0 || !result.tenant_access_token) {
    throw new Error(`token_feishu_${result.code ?? 'error'}`)
  }
  return result.tenant_access_token
}

const uploadFeishuImage = async ({
  fetchImpl,
  image,
  tenantAccessToken,
}: {
  fetchImpl: typeof fetch
  image: { localPath: string; mimeType: string; name: string }
  tenantAccessToken: string
}): Promise<string> => {
  const form = new FormData()
  form.append('image_type', 'message')
  form.append(
    'image',
    new Blob([readFileSync(image.localPath)], { type: image.mimeType }),
    image.name
  )
  const response = await fetchImpl(FEISHU_IMAGE_UPLOAD_URL, {
    body: form,
    headers: { authorization: `Bearer ${tenantAccessToken}` },
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`image_http_${response.status}`)
  const result = (await response.json()) as {
    code?: number
    data?: { image_key?: string }
    msg?: string
  }
  if (result.code !== 0 || !result.data?.image_key) {
    throw new Error(`image_feishu_${result.code ?? 'error'}`)
  }
  return result.data.image_key
}

const sendFeishuImageWebhook = async ({
  fetchImpl,
  imageKey,
  secret,
  webhookUrl,
}: {
  fetchImpl: typeof fetch
  imageKey: string
  secret: string | null
  webhookUrl: string
}) => {
  const response = await fetchImpl(webhookUrl, {
    body: JSON.stringify(buildImagePayload({ imageKey, secret })),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    signal: AbortSignal.timeout(5_000),
  })
  const reason = await readFeishuErrorReason(response)
  if (reason) throw new Error(reason)
}

const sendFeishuImage = async ({
  fetchImpl,
  image,
  secret,
  webhookUrl,
}: {
  fetchImpl: typeof fetch
  image: { localPath: string; mimeType: string; name: string }
  secret: string | null
  webhookUrl: string
}): Promise<{ ok: false; reason: string } | { ok: true }> => {
  try {
    const tenantAccessToken = await readTenantAccessToken(fetchImpl)
    if (!tenantAccessToken) return { ok: false, reason: 'app_not_configured' }
    const imageKey = await uploadFeishuImage({ fetchImpl, image, tenantAccessToken })
    await sendFeishuImageWebhook({ fetchImpl, imageKey, secret, webhookUrl })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.startsWith('token_') || message.startsWith('image_')) {
      return { ok: false, reason: message }
    }
    if (message.startsWith('feishu_') || message.startsWith('http_')) {
      return { ok: false, reason: `image_webhook_${message}` }
    }
    return { ok: false, reason: 'image_request_failed' }
  }
}

export const getFeishuNotificationHelp = (): string[] => [
  `Set ${FEISHU_WEBHOOK_URL_ENV}=<Feishu bot webhook URL> to also push yive mobile notify messages to Feishu.`,
  `Optional: set ${FEISHU_WEBHOOK_SECRET_ENV}=<Feishu bot signing secret> when the bot enables signature verification.`,
  `Optional: set ${FEISHU_APP_ID_ENV} and ${FEISHU_APP_SECRET_ENV} to let image notifications upload and push the attached picture.`,
]

export const setFeishuNotifierFetchForTests = (fetchImpl: typeof fetch | null): void => {
  fetchOverrideForTests = fetchImpl
}

export const setFeishuNotifierNowForTests = (nowImpl: (() => number) | null): void => {
  nowOverrideForTests = nowImpl
}
