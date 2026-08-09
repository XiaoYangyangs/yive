export type MobileAppInstallReadiness =
  | { kind: 'installed' }
  | { kind: 'blocked_http'; message: string }
  | { kind: 'installable'; message: string }
  | { kind: 'manual_ios'; message: string }
  | { kind: 'unavailable' }

export type MobileAndroidTwaReadiness =
  | { kind: 'blocked_http'; message: string; tone: 'error' }
  | { kind: 'blocked_static'; message: string; tone: 'error' }
  | { kind: 'ready_for_assetlinks'; message: string; tone: 'ok' }
  | { kind: 'unknown'; message: string; tone: 'warn' }

export type BeforeInstallPromptLike = {
  prompt: () => Promise<void>
}

const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/u

export const normalizeRelayServerUrlForInstall = (
  value: null | string | undefined
): string | undefined => {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (URL_SCHEME_PATTERN.test(trimmed)) return trimmed

  const authority = trimmed.split(/[/?#]/u, 1)[0]?.split('@').pop() ?? trimmed
  const host = authority.replace(/:\d+$/u, '').replace(/^\[/u, '').replace(/\]$/u, '')
  const shouldUseHttp =
    host === 'localhost' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(?:1[6-9]|2\d|3[0-1])\./u.test(host) ||
    IPV4_PATTERN.test(host)
  return `${shouldUseHttp ? 'http' : 'https'}://${trimmed}`
}

export const isLocalRelayHostForInstall = (host: string): boolean =>
  host === 'localhost' ||
  host.startsWith('127.') ||
  host.startsWith('10.') ||
  host.startsWith('192.168.') ||
  /^172\.(?:1[6-9]|2\d|3[0-1])\./u.test(host)

export const isInsecureRemoteRelayUrlForInstall = (
  serverUrl: null | string | undefined
): boolean => {
  const normalized = normalizeRelayServerUrlForInstall(serverUrl)
  if (!normalized) return false
  try {
    const url = new URL(normalized)
    return url.protocol === 'http:' && !isLocalRelayHostForInstall(url.hostname)
  } catch {
    return false
  }
}

export const isIosLikeBrowserForInstall = ({
  maxTouchPoints = 0,
  platform = '',
  userAgent = '',
}: {
  maxTouchPoints?: number
  platform?: string
  userAgent?: string
}): boolean => {
  const normalizedPlatform = platform.toLowerCase()
  const normalizedUserAgent = userAgent.toLowerCase()
  return (
    /iphone|ipad|ipod/u.test(normalizedUserAgent) ||
    /iphone|ipad|ipod/u.test(normalizedPlatform) ||
    (normalizedPlatform === 'macintel' && maxTouchPoints > 1)
  )
}

export const getMobileAppInstallReadiness = ({
  installEvent,
  isStandalone,
  relayServerUrl,
  showManualIosHint,
}: {
  installEvent: BeforeInstallPromptLike | null
  isStandalone: boolean
  relayServerUrl?: string | undefined
  showManualIosHint: boolean
}): MobileAppInstallReadiness => {
  if (isStandalone) return { kind: 'installed' }
  if (isInsecureRemoteRelayUrlForInstall(relayServerUrl)) {
    return {
      kind: 'blocked_http',
      message: '当前 Relay 地址不是 HTTPS，浏览器通常不会允许安装为 App；远程控制仍可临时使用。',
    }
  }
  if (installEvent) {
    return { kind: 'installable', message: '可以把 Yive 添加到手机主屏幕。' }
  }
  if (showManualIosHint) {
    return { kind: 'manual_ios', message: '在 Safari 中点分享按钮，然后选择“添加到主屏幕”。' }
  }
  return { kind: 'unavailable' }
}

export const getMobileAndroidTwaReadiness = ({
  mobileAppAvailable,
  relayServerUrl,
}: {
  mobileAppAvailable?: boolean | undefined
  relayServerUrl?: string | undefined
}): MobileAndroidTwaReadiness => {
  const normalized = normalizeRelayServerUrlForInstall(relayServerUrl)
  if (!normalized) {
    return {
      kind: 'unknown',
      message: '还没有 Relay 域名，暂时无法确认 Android App 发布条件。',
      tone: 'warn',
    }
  }

  try {
    const url = new URL(normalized)
    if (url.protocol !== 'https:') {
      return {
        kind: 'blocked_http',
        message: 'Android App 需要 HTTPS 域名；当前 Relay 只能作为临时网页远程控制。',
        tone: 'error',
      }
    }
  } catch {
    return {
      kind: 'unknown',
      message: 'Relay 地址无法解析，暂时无法确认 Android App 发布条件。',
      tone: 'warn',
    }
  }

  if (mobileAppAvailable === false) {
    return {
      kind: 'blocked_static',
      message: 'Relay 还没有发布构建后的手机页面，Android App 打包前需要先部署 web/dist。',
      tone: 'error',
    }
  }

  if (mobileAppAvailable === true) {
    return {
      kind: 'ready_for_assetlinks',
      message:
        'Android App 基础条件已具备；下一步用 release 证书 SHA-256 生成并校验 assetlinks.json。',
      tone: 'ok',
    }
  }

  return {
    kind: 'unknown',
    message: '还没有 Relay 静态页面状态，暂时无法确认 Android App 发布条件。',
    tone: 'warn',
  }
}
