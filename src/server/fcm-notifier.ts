import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

type FcmServiceAccount = {
  client_email: string
  private_key: string
  project_id?: string
}

export type FcmNotifyResult =
  | {
      channel: 'fcm'
      failed: 0
      ok: false
      reason: 'no_tokens' | 'not_configured'
      sent: 0
    }
  | {
      channel: 'fcm'
      errors?: Array<{ reason: string; token: string }>
      failed: number
      ok: boolean
      sent: number
    }

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

let fetchOverrideForTests: typeof fetch | null = null
let cachedAccessToken: { expiresAt: number; token: string } | null = null

const base64Url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_')

const readServiceAccount = (): FcmServiceAccount | null => {
  try {
    const inline = process.env.YIVE_FCM_SERVICE_ACCOUNT_JSON?.trim()
    const file = process.env.YIVE_FCM_SERVICE_ACCOUNT_FILE?.trim()
    const raw = inline || (file ? readFileSync(file, 'utf8') : '')
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<FcmServiceAccount>
    if (typeof parsed.client_email !== 'string' || !parsed.client_email.trim()) return null
    if (typeof parsed.private_key !== 'string' || !parsed.private_key.trim()) return null
    return {
      client_email: parsed.client_email,
      private_key: parsed.private_key,
      ...(typeof parsed.project_id === 'string' && parsed.project_id.trim()
        ? { project_id: parsed.project_id }
        : {}),
    }
  } catch {
    return null
  }
}

const readFcmConfig = () => {
  const serviceAccount = readServiceAccount()
  if (!serviceAccount) return null
  const projectId = process.env.YIVE_FCM_PROJECT_ID?.trim() || serviceAccount.project_id?.trim()
  if (!projectId) return null
  return { projectId, serviceAccount }
}

const createJwtAssertion = (serviceAccount: FcmServiceAccount, nowSeconds: number) => {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64Url(
    JSON.stringify({
      aud: GOOGLE_TOKEN_URL,
      exp: nowSeconds + 3600,
      iat: nowSeconds,
      iss: serviceAccount.client_email,
      scope: FCM_SCOPE,
    })
  )
  const unsigned = `${header}.${payload}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(serviceAccount.private_key)
  return `${unsigned}.${base64Url(signature)}`
}

const getAccessToken = async (serviceAccount: FcmServiceAccount): Promise<string> => {
  const nowMs = Date.now()
  if (cachedAccessToken && cachedAccessToken.expiresAt - 60_000 > nowMs) {
    return cachedAccessToken.token
  }
  const fetchImpl = fetchOverrideForTests ?? fetch
  const assertion = createJwtAssertion(serviceAccount, Math.floor(nowMs / 1000))
  const form = new URLSearchParams()
  form.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer')
  form.set('assertion', assertion)
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    body: form,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`oauth_http_${response.status}`)
  const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown }
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new Error('oauth_missing_access_token')
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
  cachedAccessToken = {
    expiresAt: nowMs + Math.max(60, expiresIn) * 1000,
    token: body.access_token,
  }
  return body.access_token
}

export const sendFcmNotification = async ({
  body,
  data = {},
  title,
  tokens,
}: {
  body: string
  data?: Record<string, string>
  title: string
  tokens: string[]
}): Promise<FcmNotifyResult> => {
  const uniqueTokens = [...new Set(tokens.map((token) => token.trim()).filter(Boolean))]
  if (uniqueTokens.length === 0) {
    return { channel: 'fcm', failed: 0, ok: false, reason: 'no_tokens', sent: 0 }
  }
  const config = readFcmConfig()
  if (!config) {
    return { channel: 'fcm', failed: 0, ok: false, reason: 'not_configured', sent: 0 }
  }

  try {
    const accessToken = await getAccessToken(config.serviceAccount)
    const fetchImpl = fetchOverrideForTests ?? fetch
    const errors: Array<{ reason: string; token: string }> = []
    let sent = 0
    for (const token of uniqueTokens) {
      try {
        const response = await fetchImpl(
          `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(
            config.projectId
          )}/messages:send`,
          {
            body: JSON.stringify({
              message: {
                android: { priority: 'HIGH' },
                data: { ...data, body, title },
                token,
              },
            }),
            headers: {
              authorization: `Bearer ${accessToken}`,
              'content-type': 'application/json',
            },
            method: 'POST',
            signal: AbortSignal.timeout(8_000),
          }
        )
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
      channel: 'fcm',
      ...(errors.length > 0 ? { errors } : {}),
      failed: errors.length,
      ok: sent > 0 && errors.length === 0,
      sent,
    }
  } catch (error) {
    return {
      channel: 'fcm',
      errors: [
        {
          reason: error instanceof Error ? error.message : 'request_failed',
          token: '<redacted>',
        },
      ],
      failed: uniqueTokens.length,
      ok: false,
      sent: 0,
    }
  }
}

export const resetFcmNotifierForTests = (): void => {
  cachedAccessToken = null
  fetchOverrideForTests = null
}

export const setFcmNotifierFetchForTests = (fetchImpl: typeof fetch | null): void => {
  cachedAccessToken = null
  fetchOverrideForTests = fetchImpl
}
