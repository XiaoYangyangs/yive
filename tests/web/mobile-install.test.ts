import { describe, expect, test } from 'vitest'

import {
  type BeforeInstallPromptLike,
  getMobileAndroidTwaReadiness,
  getMobileAppInstallReadiness,
  isInsecureRemoteRelayUrlForInstall,
  isIosLikeBrowserForInstall,
  normalizeRelayServerUrlForInstall,
} from '../../web/src/mobile/mobile-install.js'

const installEvent: BeforeInstallPromptLike = {
  prompt: async () => {},
}

describe('mobile app install helpers', () => {
  test('normalizes relay server URLs for install checks', () => {
    expect(normalizeRelayServerUrlForInstall(undefined)).toBeUndefined()
    expect(normalizeRelayServerUrlForInstall('relay.example')).toBe('https://relay.example')
    expect(normalizeRelayServerUrlForInstall('relay.example.com')).toBe('https://relay.example.com')
    expect(normalizeRelayServerUrlForInstall('203.0.113.10:3001')).toBe('http://203.0.113.10:3001')
    expect(normalizeRelayServerUrlForInstall('192.168.1.2:3001')).toBe('http://192.168.1.2:3001')
    expect(normalizeRelayServerUrlForInstall('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001')
  })

  test('blocks only insecure remote relay URLs for app install', () => {
    expect(isInsecureRemoteRelayUrlForInstall('http://203.0.113.10')).toBe(true)
    expect(isInsecureRemoteRelayUrlForInstall('203.0.113.10')).toBe(true)
    expect(isInsecureRemoteRelayUrlForInstall('http://192.168.1.2')).toBe(false)
    expect(isInsecureRemoteRelayUrlForInstall('http://127.0.0.1:3001')).toBe(false)
    expect(isInsecureRemoteRelayUrlForInstall('https://relay.example.com')).toBe(false)
  })

  test('detects iOS and iPadOS style browsers', () => {
    expect(
      isIosLikeBrowserForInstall({
        platform: 'iPhone',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      })
    ).toBe(true)
    expect(
      isIosLikeBrowserForInstall({
        maxTouchPoints: 5,
        platform: 'MacIntel',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15',
      })
    ).toBe(true)
    expect(
      isIosLikeBrowserForInstall({
        maxTouchPoints: 0,
        platform: 'Win32',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      })
    ).toBe(false)
  })

  test('reports installed and installable states before fallback hints', () => {
    expect(
      getMobileAppInstallReadiness({
        installEvent,
        isStandalone: true,
        relayServerUrl: 'http://203.0.113.10',
        showManualIosHint: true,
      })
    ).toEqual({ kind: 'installed' })

    expect(
      getMobileAppInstallReadiness({
        installEvent,
        isStandalone: false,
        relayServerUrl: 'https://relay.example.com',
        showManualIosHint: true,
      })
    ).toEqual({ kind: 'installable', message: '可以把 Yive 添加到手机主屏幕。' })
  })

  test('reports blocked HTTP and manual iOS install guidance', () => {
    expect(
      getMobileAppInstallReadiness({
        installEvent: null,
        isStandalone: false,
        relayServerUrl: 'http://203.0.113.10',
        showManualIosHint: true,
      })
    ).toEqual({
      kind: 'blocked_http',
      message: '当前 Relay 地址不是 HTTPS，浏览器通常不会允许安装为 App；远程控制仍可临时使用。',
    })

    expect(
      getMobileAppInstallReadiness({
        installEvent: null,
        isStandalone: false,
        relayServerUrl: 'https://relay.example.com',
        showManualIosHint: true,
      })
    ).toEqual({ kind: 'manual_ios', message: '在 Safari 中点分享按钮，然后选择“添加到主屏幕”。' })

    expect(
      getMobileAppInstallReadiness({
        installEvent: null,
        isStandalone: false,
        relayServerUrl: 'https://relay.example.com',
        showManualIosHint: false,
      })
    ).toEqual({ kind: 'unavailable' })
  })

  test('reports Android TWA release readiness blockers and next gate', () => {
    expect(
      getMobileAndroidTwaReadiness({
        mobileAppAvailable: true,
        relayServerUrl: 'http://203.0.113.10',
      })
    ).toEqual({
      kind: 'blocked_http',
      message: 'Android App 需要 HTTPS 域名；当前 Relay 只能作为临时网页远程控制。',
      tone: 'error',
    })

    expect(
      getMobileAndroidTwaReadiness({
        mobileAppAvailable: false,
        relayServerUrl: 'https://relay.example.com',
      })
    ).toEqual({
      kind: 'blocked_static',
      message: 'Relay 还没有发布构建后的手机页面，Android App 打包前需要先部署 web/dist。',
      tone: 'error',
    })

    expect(
      getMobileAndroidTwaReadiness({
        mobileAppAvailable: true,
        relayServerUrl: 'https://relay.example.com',
      })
    ).toEqual({
      kind: 'ready_for_assetlinks',
      message:
        'Android App 基础条件已具备；下一步用 release 证书 SHA-256 生成并校验 assetlinks.json。',
      tone: 'ok',
    })

    expect(getMobileAndroidTwaReadiness({})).toEqual({
      kind: 'unknown',
      message: '还没有 Relay 域名，暂时无法确认 Android App 发布条件。',
      tone: 'warn',
    })
  })
})
