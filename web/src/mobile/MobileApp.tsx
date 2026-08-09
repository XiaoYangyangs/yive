import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  AgentStopMode,
  AgentSummary,
  MobileAgentNotification,
  TeamListItem,
  WorkspaceSummary,
} from '../../../src/shared/types.js'
import {
  getActiveWorkspaceId,
  initializeUiSession,
  type MobileDispatchItem,
  type MobileFileDownloadProgress,
  type MobileFileExchangeItem,
  type MobileFileReviewDecision,
  saveActiveWorkspaceId,
  type TerminalRunSummary,
} from '../api.js'
import { createBrowserId } from '../browser-id.js'
import {
  type ServiceWorkerUpdateApply,
  subscribeServiceWorkerUpdate,
} from '../pwa/register-service-worker.js'
import {
  claimRelayPairingToken,
  createRelayPairingToken,
  getRelayHealth,
  isRelayHttpProtocolSupported,
  listRelayDevices,
  listRelayPairedDevices,
  loginRelayAccount,
  type RelayDesktopDevice,
  type RelayDeviceSnapshot,
  type RelayDeviceTokenSummary,
  type RelayHealthSnapshot,
  RelayMobileClient,
  type RelayMobileDevice,
  RelayRuntimeError,
  revokeRelayPairedDevice,
  SUPPORTED_RELAY_HTTP_PROTOCOL_VERSION,
} from '../relay-api.js'
import { preloadTerminalAssets } from '../terminal/preloadTerminalAssets.js'
import {
  type AgentStatusPresentationKind,
  areAllAgentsVerifiedIdle,
  formatLastObservedAt,
  presentAgentStatus,
} from '../worker/worker-status.js'
import { MobileAgentAvatar } from './MobileAgentAvatar.js'
import { MobileAgentDetail } from './MobileAgentDetail.js'
import { readMobileAgentDeepLink } from './mobile-agent-detail-preference.js'
import {
  type MobileAgentCard as AgentCardModel,
  deriveOrchestratorCard,
  deriveWorkerCard,
  MOBILE_AGENT_STATUS_PRIORITY,
  type MobileAgentSummary,
  summarizeMobileAgents as summarizeAgents,
} from './mobile-agent-state.js'
import { applyMobileChatDeepLink } from './mobile-chat-completion.js'
import {
  createMobileEventsClient,
  getMobileSnapshotDashboard,
  type MobileSnapshot,
} from './mobile-events-client.js'
import {
  getMobileFileExchangeActionPresentation,
  removeMobileFileItem,
  shouldSkipMobileFileExchangeAction,
  upsertMobileFileItem,
  validateMobileExchangeFile,
  validateWorkspaceFileExchangePath,
} from './mobile-file-transfer.js'
import {
  getMobileAndroidTwaReadiness,
  getMobileAppInstallReadiness,
  isIosLikeBrowserForInstall,
  normalizeRelayServerUrlForInstall,
} from './mobile-install.js'
import {
  clearStoredRelayDesktopSelection as clearStoredRelayDesktopSelectionFromStorage,
  clearRelayPairing as clearStoredRelayPairing,
  readStoredRelayPairing as readStoredRelayPairingFromStorage,
  type StoredRelayPairing,
  saveRelayPairing as saveRelayPairingToStorage,
} from './mobile-relay-pairing-storage.js'
import {
  createLocalMobileRuntimeClient,
  createRelayMobileRuntimeClient,
  type MobileRuntimeClient,
} from './mobile-runtime-client.js'
import { useMobileChatCompletionNotifications } from './useMobileChatCompletionNotifications.js'
import './MobileApp.css'

type WorkspaceLoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; workspaces: WorkspaceSummary[] }
  | { kind: 'error'; message: string }

type WorkspaceDashboardState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'ready'
      orchestrator?: AgentSummary
      runs: TerminalRunSummary[]
      staleAt?: number
      staleMessage?: string
      workers: TeamListItem[]
    }
  | { kind: 'error'; message: string }

type MobileFileDownloadProgressState = MobileFileDownloadProgress & {
  fileId: string
  name: string
}

type YiveAndroidBridge = {
  saveFile?: (name: string, mimeType: string, contentBase64: string) => string | undefined
}

const getYiveAndroidBridge = (): YiveAndroidBridge | null => {
  if (typeof window === 'undefined') return null
  const candidate = (window as typeof window & { YiveAndroid?: YiveAndroidBridge }).YiveAndroid
  return candidate && typeof candidate.saveFile === 'function' ? candidate : null
}

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file content'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const marker = 'base64,'
      const markerIndex = result.indexOf(marker)
      resolve(markerIndex >= 0 ? result.slice(markerIndex + marker.length) : result)
    }
    reader.readAsDataURL(blob)
  })

const createPreviewImageUrl = async (blob: Blob): Promise<{ revoke: () => void; url: string }> => {
  if (typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(blob)
    return {
      revoke: () => {
        if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
      },
      url,
    }
  }
  return {
    revoke: () => {},
    url: `data:${blob.type || 'application/octet-stream'};base64,${await blobToBase64(blob)}`,
  }
}

type MobileDispatchesState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { dispatches: MobileDispatchItem[]; kind: 'ready' }
  | { kind: 'error'; message: string }

type MobileLastConnectionSnapshot = {
  agentCount?: number
  desktopId?: string
  deviceId?: string
  awaitingReport?: number
  busy?: number
  crashed?: number
  idle?: number
  mode: 'local' | 'relay'
  pending?: number
  runtimeLabel: string
  serverUrl?: string
  stopped?: number
  updatedAt: number
  unknown?: number
  workspaceId?: string
  workspaceName?: string
  workspacePath?: string
}

type ApprovalItem = {
  id: string
  agentName: string
  description: string
  kind: 'danger' | 'dispatch' | 'input'
  title: string
}

type MobileTab = 'agents' | 'background' | 'dispatches' | 'files' | 'notifications'
type MobileAgentAction = 'restart' | 'start' | 'stop'

type MobileDispatchActionState = {
  busy: boolean
  dispatchId: string | null
  message: string | null
  mode: 'cancel' | 'note' | 'replace' | 'report' | 'status' | null
}

type MobileRuntimeSession =
  | {
      client: MobileRuntimeClient
      connect: () => Promise<void>
      connectionMessage: string
      close?: undefined
      mode: 'invalid-relay' | 'local'
      relayDiagnostics?: undefined
      runtimeLabel: string
      terminalConnectionParams?: undefined
    }
  | {
      client: MobileRuntimeClient
      close: () => void
      connect: () => Promise<void>
      connectionMessage: string
      mode: 'relay'
      relayDiagnostics: {
        desktopId: string
        deviceId?: string
        serverUrl?: string
        token: string
      }
      runtimeLabel: string
      terminalConnectionParams: Record<string, string>
    }

type RelayRuntimeDiagnosticsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      devices: RelayDeviceSnapshot | null
      devicesMessage?: string
      health: RelayHealthSnapshot | null
      healthMessage?: string
      healthRoundTripMs: number | null
      kind: 'ready'
    }

type RelayRuntimeDeviceState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { desktop: RelayDesktopDevice | null; kind: 'ready'; loadedAt: number }
  | { kind: 'error'; loadedAt: number; message: string }

type RelayForegroundRefreshState =
  | { kind: 'idle' }
  | { kind: 'checking'; startedAt: number }
  | { checkedAt: number; kind: 'ready'; message: string; tone: MobileConnectionTone }

type RelayEventsStatus =
  | { kind: 'idle' }
  | { kind: 'connected'; updatedAt: number }
  | { kind: 'error'; message: string; updatedAt: number }
  | {
      attempt?: number
      kind: 'reconnecting'
      message: string
      nextDelayMs?: number
      updatedAt: number
    }

type MobileConnectionTone = 'error' | 'ok' | 'warn'

type MobileRelayPathItem = {
  detail: string
  label: string
  tone: MobileConnectionTone
}

type MobileRelayDiagnosticCommand = {
  command: string
  label: string
  purpose?: string
}

type MobileRelayDiagnosticCheck = {
  id: string
  label: string
  tone: 'error' | 'ok' | 'warn'
}

type MobileRelayDiagnosticReport = {
  checks: MobileRelayDiagnosticCheck[]
  desktop_id: string
  device_id?: string
  generated_at: string
  next_action?: string
  next_action_id?: string
  ok: boolean
  recommended_smoke: Array<
    'checklist' | 'doctor' | 'events' | 'file_exchange' | 'image_paste' | 'terminal'
  >
  relay: {
    devices_checked: boolean
    health_checked: boolean
  }
  status: RelayRuntimeDiagnosticsState['kind']
}

type MobileRelayRecommendedSmoke = MobileRelayDiagnosticReport['recommended_smoke'][number]

type MobileRelayDesktopConnectGuideContext = {
  desktopId?: string | undefined
  runtimeUrl?: string | undefined
  serverUrl?: string | undefined
}

type RelayDeviceAdminState =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { devices: RelayDeviceTokenSummary[]; kind: 'ready'; message?: string }
  | { kind: 'error'; message: string }

type RelayPairingLinkState =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | {
      copyMessage?: string
      expiresAt?: number
      href: string
      kind: 'ready'
      shareMessage?: string
      ttlMs?: number
    }
  | { kind: 'error'; message: string }

type MobileNotificationState = 'denied' | 'enabled' | 'prompt' | 'unsupported'

type NavigatorWithAppBadge = Navigator & {
  clearAppBadge?: () => Promise<void>
  setAppBadge?: (contents?: number) => Promise<void>
}

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice?: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

type MobileRelayEntry =
  | { kind: 'runtime' }
  | {
      desktopId?: string
      deviceId?: string
      kind: 'pairing'
      serverUrl?: string
      token?: string
      workspaceIds?: string[]
    }
  | {
      deviceId?: string
      kind: 'picker'
      serverUrl?: string
      storageUnavailable?: boolean
      token: string
    }

const REFRESH_INTERVAL_MS = 1000
const AGENT_DETAIL_DASHBOARD_REFRESH_INTERVAL_MS = 5000
const MOBILE_TABS: Array<{ id: MobileTab; label: string }> = [
  { id: 'agents', label: 'Agent' },
  { id: 'dispatches', label: '派单' },
  { id: 'notifications', label: '通知' },
  { id: 'files', label: '文件' },
  { id: 'background', label: '后台' },
]
const MOBILE_TAB_IDS = new Set<MobileTab>(MOBILE_TABS.map((tab) => tab.id))
const MOBILE_LAST_CONNECTION_STORAGE_KEY = 'yive.mobile.lastConnection'
const MOBILE_NOTIFICATION_STORAGE_KEY = 'yive.mobile.notifications.enabled'
const MOBILE_ACTIVE_TAB_STORAGE_KEY = 'yive.mobile.activeTab'
const MOBILE_RELAY_WORKSPACE_STORAGE_KEY = 'yive.mobile.relay.activeWorkspace'
const RELAY_RUNTIME_STALE_MS = 30_000
const RELAY_EVENTS_STALE_MS = 30_000
const RELAY_EVENTS_RECONNECT_NOTICE_DELAY_MS = 4_000
const isMobileTab = (value: string | null): value is MobileTab =>
  value !== null && MOBILE_TAB_IDS.has(value as MobileTab)

const readInitialMobileTab = (): MobileTab => {
  if (typeof window === 'undefined') return 'agents'
  const tab = new URLSearchParams(window.location.search).get('tab')
  if (isMobileTab(tab)) return tab
  try {
    const storedTab = window.localStorage.getItem(MOBILE_ACTIVE_TAB_STORAGE_KEY)
    if (isMobileTab(storedTab)) return storedTab
  } catch {
    // Storage may be unavailable in private browsing or locked-down WebViews.
  }
  return 'agents'
}

const writeMobileTabToUrl = (tab: MobileTab): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(MOBILE_ACTIVE_TAB_STORAGE_KEY, tab)
  } catch {
    // Storage may be unavailable in private browsing or locked-down WebViews.
  }
  const url = new URL(window.location.href)
  if (tab === 'agents') url.searchParams.delete('tab')
  else url.searchParams.set('tab', tab)
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

const isStandaloneDisplayMode = (): boolean => {
  if (typeof window === 'undefined') return false
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean }
  return (
    navigatorWithStandalone.standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true
  )
}

const getMobileNotificationState = (): MobileNotificationState => {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  const permission = Notification.permission
  if (permission === 'denied') return 'denied'
  let enabled = false
  try {
    enabled = window.localStorage.getItem(MOBILE_NOTIFICATION_STORAGE_KEY) === '1'
  } catch {
    enabled = false
  }
  if (permission === 'granted' && enabled) return 'enabled'
  return 'prompt'
}

const setMobileNotificationPreference = (enabled: boolean): void => {
  if (typeof window === 'undefined') return
  try {
    if (enabled) window.localStorage.setItem(MOBILE_NOTIFICATION_STORAGE_KEY, '1')
    else window.localStorage.removeItem(MOBILE_NOTIFICATION_STORAGE_KEY)
  } catch {
    // Ignore storage failures; the permission state still reflects the browser.
  }
}

const sendMobileNotification = ({
  body,
  onClick,
  tag,
  title,
}: {
  body: string
  onClick?: (() => void) | undefined
  tag: string
  title: string
}) => {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (Notification.permission !== 'granted') return
  try {
    const notification = new Notification(title, { body, tag })
    notification.onclick = () => {
      try {
        window.focus()
        onClick?.()
      } catch {
        // Notification click handling is best-effort across browsers.
      }
    }
  } catch {
    // Notifications are best-effort and must not interrupt mobile control.
  }
}

const updateMobileAppBadge = (pendingCount: number): void => {
  if (typeof navigator === 'undefined') return
  const badgeNavigator = navigator as NavigatorWithAppBadge
  try {
    if (pendingCount > 0 && typeof badgeNavigator.setAppBadge === 'function') {
      void badgeNavigator.setAppBadge(pendingCount).catch(() => {})
      return
    }
    if (pendingCount === 0 && typeof badgeNavigator.clearAppBadge === 'function') {
      void badgeNavigator.clearAppBadge().catch(() => {})
    }
  } catch {
    // Badging is optional PWA polish; failures must not affect the controller.
  }
}

const readMobileLastConnectionSnapshot = (): MobileLastConnectionSnapshot | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(MOBILE_LAST_CONNECTION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<MobileLastConnectionSnapshot>
    if (parsed.mode !== 'local' && parsed.mode !== 'relay') return null
    if (typeof parsed.runtimeLabel !== 'string' || parsed.runtimeLabel.trim().length === 0) {
      return null
    }
    if (typeof parsed.updatedAt !== 'number' || !Number.isFinite(parsed.updatedAt)) return null
    return {
      ...(typeof parsed.agentCount === 'number' ? { agentCount: parsed.agentCount } : {}),
      ...(typeof parsed.desktopId === 'string' ? { desktopId: parsed.desktopId } : {}),
      ...(typeof parsed.deviceId === 'string' ? { deviceId: parsed.deviceId } : {}),
      ...(typeof parsed.awaitingReport === 'number'
        ? { awaitingReport: parsed.awaitingReport }
        : {}),
      ...(typeof parsed.busy === 'number' ? { busy: parsed.busy } : {}),
      ...(typeof parsed.crashed === 'number' ? { crashed: parsed.crashed } : {}),
      ...(typeof parsed.idle === 'number' ? { idle: parsed.idle } : {}),
      mode: parsed.mode,
      ...(typeof parsed.pending === 'number' ? { pending: parsed.pending } : {}),
      runtimeLabel: parsed.runtimeLabel,
      ...(typeof parsed.serverUrl === 'string' ? { serverUrl: parsed.serverUrl } : {}),
      ...(typeof parsed.stopped === 'number' ? { stopped: parsed.stopped } : {}),
      updatedAt: parsed.updatedAt,
      ...(typeof parsed.unknown === 'number' ? { unknown: parsed.unknown } : {}),
      ...(typeof parsed.workspaceId === 'string' ? { workspaceId: parsed.workspaceId } : {}),
      ...(typeof parsed.workspaceName === 'string' ? { workspaceName: parsed.workspaceName } : {}),
      ...(typeof parsed.workspacePath === 'string' ? { workspacePath: parsed.workspacePath } : {}),
    }
  } catch {
    return null
  }
}

const writeMobileLastConnectionSnapshot = (snapshot: MobileLastConnectionSnapshot): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(MOBILE_LAST_CONNECTION_STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Snapshot continuity is optional; storage failures must not affect control.
  }
}

const normalizeRelayServerUrl = normalizeRelayServerUrlForInstall

const readIsIosLikeBrowser = (): boolean => {
  if (typeof navigator === 'undefined') return false
  return isIosLikeBrowserForInstall({
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    platform: navigator.platform,
    userAgent: navigator.userAgent,
  })
}

const getSearchParam = (params: URLSearchParams, ...names: string[]): string | null => {
  for (const name of names) {
    const value = params.get(name)?.trim()
    if (value) return value
  }
  return null
}

const getRelayTokenParam = (params: URLSearchParams): string | null =>
  getSearchParam(params, 'token', 'pairing_token', 'pairingToken')

const scrubRelayTokenFromLocation = (): void => {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  let changed = false
  for (const name of ['token', 'pairing_token', 'pairingToken']) {
    if (!url.searchParams.has(name)) continue
    url.searchParams.delete(name)
    changed = true
  }
  if (!changed) return
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

const getBrowserRelayPairingStorage = () =>
  typeof window === 'undefined' ? null : window.localStorage

const readStoredRelayPairing = (): StoredRelayPairing | null =>
  readStoredRelayPairingFromStorage(getBrowserRelayPairingStorage())

const saveRelayPairing = (pairing: StoredRelayPairing): boolean =>
  saveRelayPairingToStorage(getBrowserRelayPairingStorage(), pairing)

const readStoredRelayWorkspaceId = (desktopId: string): string | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(MOBILE_RELAY_WORKSPACE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { desktopId?: unknown; workspaceId?: unknown }
    if (parsed.desktopId !== desktopId || typeof parsed.workspaceId !== 'string') return null
    const workspaceId = parsed.workspaceId.trim()
    return workspaceId ? workspaceId : null
  } catch {
    return null
  }
}

const saveStoredRelayWorkspaceId = (desktopId: string, workspaceId: string): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      MOBILE_RELAY_WORKSPACE_STORAGE_KEY,
      JSON.stringify({ desktopId, workspaceId })
    )
  } catch {
    // Storage may be unavailable in private browsing or locked-down WebViews.
  }
}

const clearRelayPairing = (): void => clearStoredRelayPairing(getBrowserRelayPairingStorage())

const clearStoredRelayDesktopSelection = (): StoredRelayPairing | null => {
  return clearStoredRelayDesktopSelectionFromStorage(getBrowserRelayPairingStorage())
}

const rememberRelayDesktopSelection = (
  entry: Extract<MobileRelayEntry, { kind: 'picker' }>,
  desktopId: string
): void => {
  saveRelayPairing({
    desktopId,
    ...(entry.deviceId ? { deviceId: entry.deviceId } : {}),
    ...(entry.serverUrl ? { serverUrl: entry.serverUrl } : {}),
    token: entry.token,
  })
}

const getRelayWorkspaceIdsParam = (params: URLSearchParams): string[] | undefined => {
  const values = [
    ...params.getAll('workspace_id'),
    ...params
      .getAll('workspace_ids')
      .flatMap((value) => value.split(',').map((item) => item.trim())),
  ].filter(Boolean)
  return values.length > 0 ? Array.from(new Set(values)) : undefined
}

const getCurrentRelayAppBaseUrl = (): string | undefined => {
  if (typeof window === 'undefined') return undefined
  const currentUrl = new URL(window.location.href)
  const mobileIndex = currentUrl.pathname.lastIndexOf('/mobile')
  const basePath =
    mobileIndex >= 0 ? currentUrl.pathname.slice(0, mobileIndex).replace(/\/+$/u, '') : ''
  return `${currentUrl.origin}${basePath}`
}

const getCurrentRelayMobilePath = (): string => {
  if (typeof window === 'undefined') return '/mobile'
  const currentUrl = new URL(window.location.href)
  const mobileIndex = currentUrl.pathname.lastIndexOf('/mobile')
  const basePath =
    mobileIndex >= 0 ? currentUrl.pathname.slice(0, mobileIndex).replace(/\/+$/u, '') : ''
  return `${basePath}/mobile`
}

const getCurrentRelayWebSocketBasePath = (): string | undefined => {
  if (typeof window === 'undefined') return undefined
  const currentUrl = new URL(window.location.href)
  const mobileIndex = currentUrl.pathname.lastIndexOf('/mobile')
  const basePath =
    mobileIndex >= 0 ? currentUrl.pathname.slice(0, mobileIndex).replace(/\/+$/u, '') : ''
  return basePath || undefined
}

const shouldPreferCurrentRelayBase = (): boolean => {
  if (typeof window === 'undefined') return false
  return getCurrentRelayMobilePath() !== '/mobile'
}

const normalizeRelayBaseForComparison = (value: string | undefined): string | undefined => {
  const normalized = normalizeRelayServerUrl(value)
  return normalized?.replace(/\/+$/u, '')
}

const getStoredRelayPairingForCurrentApp = (): StoredRelayPairing | null => {
  const storedPairing = readStoredRelayPairing()
  if (!storedPairing || !shouldPreferCurrentRelayBase()) return storedPairing
  const currentRelayBaseUrl = normalizeRelayBaseForComparison(getCurrentRelayAppBaseUrl())
  const storedRelayBaseUrl = normalizeRelayBaseForComparison(storedPairing.serverUrl)
  return currentRelayBaseUrl && storedRelayBaseUrl === currentRelayBaseUrl ? storedPairing : null
}

const getRelayEntry = (): MobileRelayEntry => {
  if (typeof window === 'undefined') return { kind: 'runtime' }
  const params = new URLSearchParams(window.location.search)
  const relayRequested =
    params.get('relay') === '1' ||
    params.get('mode') === 'relay' ||
    params.has('desktop_id') ||
    params.has('desktopId')
  if (!relayRequested) return { kind: 'runtime' }
  const desktopId = getSearchParam(params, 'desktop_id', 'desktopId')
  const tokenFromUrl = getRelayTokenParam(params)
  const workspaceIds = getRelayWorkspaceIdsParam(params)
  const shouldClaimDirectToken = params.get('claim') === '1'
  if (desktopId && (!tokenFromUrl || !shouldClaimDirectToken)) return { kind: 'runtime' }

  const storedPairing = getStoredRelayPairingForCurrentApp()
  if (!tokenFromUrl && storedPairing?.desktopId) return { kind: 'runtime' }
  const token = tokenFromUrl ?? storedPairing?.token
  const deviceId =
    getSearchParam(params, 'device_id', 'deviceId') ?? storedPairing?.deviceId ?? undefined
  const explicitServerUrl = getSearchParam(params, 'server', 'relay_server', 'relayServer')
  const currentRelayBaseUrl = getCurrentRelayAppBaseUrl()
  const serverUrl = normalizeRelayServerUrl(
    explicitServerUrl ??
      (shouldPreferCurrentRelayBase() ? currentRelayBaseUrl : storedPairing?.serverUrl) ??
      currentRelayBaseUrl
  )
  if (!token) {
    return {
      ...(desktopId ? { desktopId } : {}),
      ...(deviceId ? { deviceId } : {}),
      kind: 'pairing',
      ...(serverUrl ? { serverUrl } : {}),
      ...(workspaceIds ? { workspaceIds } : {}),
    }
  }
  if (desktopId && tokenFromUrl && shouldClaimDirectToken) {
    return {
      desktopId,
      ...(deviceId ? { deviceId } : {}),
      kind: 'pairing',
      ...(serverUrl ? { serverUrl } : {}),
      token: tokenFromUrl,
      ...(workspaceIds ? { workspaceIds } : {}),
    }
  }
  const saved = saveRelayPairing({
    ...(deviceId ? { deviceId } : {}),
    ...(serverUrl ? { serverUrl } : {}),
    token,
  })
  if (tokenFromUrl) scrubRelayTokenFromLocation()
  return {
    ...(deviceId ? { deviceId } : {}),
    kind: 'picker',
    ...(serverUrl ? { serverUrl } : {}),
    ...(tokenFromUrl && !saved ? { storageUnavailable: true } : {}),
    token,
  }
}

const createMobileRuntimeSession = (): MobileRuntimeSession => {
  if (typeof window === 'undefined') {
    return {
      client: createLocalMobileRuntimeClient(),
      connect: async () => {
        await initializeUiSession()
      },
      connectionMessage: '已连接到电脑端 Yive runtime。',
      mode: 'local',
      runtimeLabel: 'Runtime 在线',
    }
  }

  const params = new URLSearchParams(window.location.search)
  const relayRequested =
    params.get('relay') === '1' ||
    params.get('mode') === 'relay' ||
    params.has('desktop_id') ||
    params.has('desktopId')
  if (!relayRequested) {
    return {
      client: createLocalMobileRuntimeClient(),
      connect: async () => {
        await initializeUiSession()
      },
      connectionMessage: '已连接到电脑端 Yive runtime。',
      mode: 'local',
      runtimeLabel: 'Runtime 在线',
    }
  }

  const storedPairing = getStoredRelayPairingForCurrentApp()
  const tokenFromUrl = getRelayTokenParam(params)
  const desktopId =
    getSearchParam(params, 'desktop_id', 'desktopId') ??
    (!tokenFromUrl ? storedPairing?.desktopId : undefined)
  const token = tokenFromUrl ?? storedPairing?.token
  if (!desktopId || !token) {
    return {
      client: createLocalMobileRuntimeClient(),
      connect: async () => {
        throw new Error('远程模式需要 desktop_id 和已保存的配对 token')
      },
      connectionMessage: '远程模式配置不完整。',
      mode: 'invalid-relay',
      runtimeLabel: 'Relay 未配置',
    }
  }

  const deviceId =
    getSearchParam(params, 'device_id', 'deviceId') ?? storedPairing?.deviceId ?? undefined
  const explicitServerUrl = getSearchParam(params, 'server', 'relay_server', 'relayServer')
  const currentRelayBaseUrl = getCurrentRelayAppBaseUrl()
  const serverUrl = normalizeRelayServerUrl(
    explicitServerUrl ??
      (shouldPreferCurrentRelayBase() ? currentRelayBaseUrl : storedPairing?.serverUrl) ??
      currentRelayBaseUrl
  )
  if (tokenFromUrl || desktopId !== storedPairing?.desktopId) {
    saveRelayPairing({
      desktopId,
      ...(deviceId ? { deviceId } : {}),
      ...(serverUrl ? { serverUrl } : {}),
      token,
    })
    scrubRelayTokenFromLocation()
  }
  const relayClient = new RelayMobileClient({
    desktopId,
    ...(deviceId ? { deviceId } : {}),
    ...(serverUrl ? { serverUrl } : {}),
    token,
  })
  return {
    client: createRelayMobileRuntimeClient(relayClient),
    close: () => relayClient.close(),
    connect: () => relayClient.connect(),
    connectionMessage: `已通过云端 Relay 连接电脑 ${desktopId}。`,
    mode: 'relay',
    relayDiagnostics: {
      desktopId,
      ...(deviceId ? { deviceId } : {}),
      ...(serverUrl ? { serverUrl } : {}),
      token,
    },
    runtimeLabel: 'Relay 在线',
    terminalConnectionParams: {
      desktop_id: desktopId,
      ...(deviceId ? { device_id: deviceId } : {}),
      ...(serverUrl ? { server: serverUrl } : {}),
      token,
      ...(getCurrentRelayWebSocketBasePath()
        ? { websocket_base_path: getCurrentRelayWebSocketBasePath() }
        : {}),
    },
  }
}

const isRelayNetworkErrorMessage = (message: string): boolean =>
  /failed to fetch|fetch failed|networkerror|relay http request timed out|relay mobile socket connection timed out|relay mobile socket failed to connect|relay mobile socket closed before connecting|relay request timed out|relay socket closed before response/iu.test(
    message
  )

const getLoadErrorMessage = (error: unknown, fallback: string) => {
  if (!(error instanceof Error)) return fallback
  if (error instanceof RelayRuntimeError) {
    const relayMessage = error.message.replace(/\s+/gu, ' ').trim().slice(0, 160)
    if (error.code === 'desktop_offline') {
      return '目标电脑已从 Relay 断开，请在电脑端重新执行 yive connect。'
    }
    if (error.code === 'desktop_runtime_unavailable') {
      return '目标电脑已连接 Relay，但本地 yive runtime 不可用，请在电脑端启动 yive。'
    }
    if (error.code === 'local_runtime_error') {
      return `目标电脑在线，但本地 yive runtime 请求失败：${relayMessage || '未知错误'}。请确认电脑端 yive 正在运行后重试。`
    }
    if (error.code === 'unauthorized' || error.code === 'invalid_token') {
      return '当前手机配对已失效或被撤销，请重新配对。'
    }
    return `Relay 返回错误：${relayMessage || '未知错误'}`
  }
  if (/^Relay /u.test(error.message)) {
    return '远程连接中断或超时，请确认 Relay 在线、本地电脑已执行 yive connect，然后重试。'
  }
  return error.message.startsWith('Failed to ') ? fallback : error.message
}

const getRelayPairingErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return '配对失败'
  if (/\b401\b/u.test(error.message)) return '配对码无效或已过期，请在电脑端重新生成配对码。'
  if (/\b404\b/u.test(error.message)) {
    return 'Relay 地址可访问，但没有找到配对接口。请确认服务器运行的是 yive relay。'
  }
  if (isRelayNetworkErrorMessage(error.message)) {
    return '无法连接 Relay 服务器，请检查 Relay 地址、网络和服务器是否在线。'
  }
  if (/\b5\d\d\b/u.test(error.message)) {
    return 'Relay 服务器返回错误，请稍后重试或检查服务器日志。'
  }
  return getLoadErrorMessage(error, '配对失败')
}

const getRelayAccountLoginErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return '登录失败'
  if (/\b401\b/u.test(error.message)) return '账号或密码不正确。'
  if (/\b404\b/u.test(error.message)) return '服务器还没有启用账号登录，请先配置 Relay 账号。'
  if (/\b409\b/u.test(error.message)) return '当前有多台电脑在线，请填写目标电脑后再登录。'
  if (isRelayNetworkErrorMessage(error.message)) {
    return '无法连接 Relay 服务器，请检查 Relay 地址、网络和服务器是否在线。'
  }
  if (/\b5\d\d\b/u.test(error.message)) {
    return 'Relay 服务器返回错误，请稍后重试或检查服务器日志。'
  }
  return getLoadErrorMessage(error, '登录失败')
}

const getRelayDevicePickerErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return '加载在线电脑失败'
  if (/\b401\b/u.test(error.message)) return '配对已失效或被撤销，请重新配对。'
  if (/\b403\b/u.test(error.message)) {
    return '当前手机配对没有绑定电脑，请用电脑端生成的新配对链接重新配对。'
  }
  if (/\b404\b/u.test(error.message)) {
    return 'Relay 地址可访问，但没有找到设备列表接口。请确认服务器运行的是 yive relay。'
  }
  if (isRelayNetworkErrorMessage(error.message)) {
    return '无法连接 Relay 服务器，请检查 Relay 地址、网络和服务器是否在线。'
  }
  if (/\b5\d\d\b/u.test(error.message)) {
    return 'Relay 服务器返回错误，请稍后重试或检查服务器日志。'
  }
  return getLoadErrorMessage(error, '加载在线电脑失败')
}

const getRelayDevicePickerErrorAction = (error: unknown): 'pairing' | 'retry' => {
  if (error instanceof Error && /\b(?:401|403)\b/u.test(error.message)) return 'pairing'
  return 'retry'
}

const getRelayHealthErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return '检查 Relay 失败'
  if (/service=hive-relay|Invalid relay health response/u.test(error.message)) {
    return '这个地址可访问，但它不是 Yive Relay 服务。请检查 Relay 地址。'
  }
  if (/\b404\b/u.test(error.message)) {
    return 'Relay 地址可访问，但没有找到健康检查接口。请确认服务器运行的是 yive relay。'
  }
  if (isRelayNetworkErrorMessage(error.message)) {
    return '无法连接 Relay 服务器，请检查 Relay 地址、网络和服务器是否在线。'
  }
  if (/\b5\d\d\b/u.test(error.message)) {
    return 'Relay 服务器返回错误，请稍后重试或检查服务器日志。'
  }
  return getLoadErrorMessage(error, '检查 Relay 失败')
}

const getRelayDeviceAdminErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return '加载已配对手机失败'
  if (/\b401\b/u.test(error.message)) return '当前 token 不能管理设备，请使用 Relay 管理员 token。'
  if (/\b404\b/u.test(error.message)) {
    return 'Relay 地址可访问，但没有找到设备管理接口。请确认服务器运行的是新版 yive relay。'
  }
  if (isRelayNetworkErrorMessage(error.message)) {
    return '无法连接 Relay 服务器，请检查 Relay 地址、网络和服务器是否在线。'
  }
  if (/\b5\d\d\b/u.test(error.message)) {
    return 'Relay 服务器返回错误，请稍后重试或检查服务器日志。'
  }
  return getLoadErrorMessage(error, '加载已配对手机失败')
}

const formatRelayUptime = (uptimeMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(uptimeMs / 1000))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
  if (minutes > 0) return `${minutes} 分钟 ${seconds} 秒`
  return `${seconds} 秒`
}

const formatRelayStartedAt = (startedAt: number): string =>
  new Intl.DateTimeFormat('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
  }).format(new Date(startedAt))

const formatRelayHealth = (health: RelayHealthSnapshot): string =>
  `Relay 在线：${health.service}${health.version ? ` ${health.version}` : ''}${
    typeof health.protocol_version === 'number' ? `，协议 v${health.protocol_version}` : ''
  }，${health.desktop_count} 台电脑，${health.mobile_count} 台手机连接${
    typeof health.uptime_ms === 'number' ? `，已运行 ${formatRelayUptime(health.uptime_ms)}` : ''
  }${
    typeof health.started_at === 'number'
      ? `，启动于 ${formatRelayStartedAt(health.started_at)}`
      : ''
  }。`

const getHealthProbeTime = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()

const getBrowserOnlineStatus = (): boolean => {
  if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') return true
  return navigator.onLine
}

const formatRelayRoundTrip = (roundTripMs: number): string =>
  `${Math.max(1, Math.round(roundTripMs))}ms`

const buildRelayHeartbeatDiagnostic = (
  health: RelayHealthSnapshot
): { label: string; tone: 'ok' | 'warn' } | null => {
  if (
    typeof health.heartbeat_interval_ms !== 'number' ||
    typeof health.heartbeat_timeout_ms !== 'number'
  ) {
    return null
  }
  const interval = formatRelayUptime(health.heartbeat_interval_ms)
  const timeout = formatRelayUptime(health.heartbeat_timeout_ms)
  if (health.heartbeat_timeout_ms <= health.heartbeat_interval_ms) {
    return {
      label: `Relay 心跳配置异常：每 ${interval} 检查一次，但 ${timeout} 无响应就会断开设备。`,
      tone: 'warn',
    }
  }
  return {
    label: `Relay 心跳：每 ${interval} 检查一次，${timeout} 无响应会断开设备。`,
    tone: 'ok',
  }
}

const buildRelayRoundTripDiagnostic = (
  roundTripMs: number | null
): { label: string; tone: 'ok' | 'warn' } | null => {
  if (typeof roundTripMs !== 'number') return null
  const formatted = formatRelayRoundTrip(roundTripMs)
  if (roundTripMs >= 3000) {
    return {
      label: `Relay 网络很慢：最近检查耗时 ${formatted}，远程终端可能会明显卡顿。`,
      tone: 'warn',
    }
  }
  if (roundTripMs >= 1000) {
    return {
      label: `Relay 网络偏慢：最近检查耗时 ${formatted}。`,
      tone: 'warn',
    }
  }
  return {
    label: `Relay 网络正常：最近检查耗时 ${formatted}。`,
    tone: 'ok',
  }
}

const formatRelayProtocolWarning = (health: RelayHealthSnapshot): string | null => {
  if (isRelayHttpProtocolSupported(health)) return null
  return `Relay 协议 v${health.protocol_version} 高于当前客户端支持的 v${SUPPORTED_RELAY_HTTP_PROTOCOL_VERSION}，请更新手机端或使用匹配版本。`
}

const REQUIRED_REMOTE_FEATURES = [
  {
    id: 'mobile_confirmations',
    label: '危险操作确认',
  },
  {
    id: 'mobile_events',
    label: '实时状态事件',
  },
  {
    id: 'mobile_file_exchange',
    label: '手机文件交换',
  },
  {
    id: 'terminal_proxy',
    label: '远程原始终端',
  },
] as const

const getMissingRemoteFeatures = (features: string[] | undefined): string[] => {
  if (!Array.isArray(features)) return REQUIRED_REMOTE_FEATURES.map((feature) => feature.label)
  const available = new Set(features)
  return REQUIRED_REMOTE_FEATURES.filter((feature) => !available.has(feature.id)).map(
    (feature) => feature.label
  )
}

const formatMissingRemoteFeatures = (
  features: string[] | undefined,
  target: 'desktop' | 'relay'
): string | null => {
  const missing = getMissingRemoteFeatures(features)
  if (missing.length === 0) return null
  const subject = target === 'desktop' ? '电脑端 yive connect' : 'Relay'
  const action = target === 'desktop' ? '请更新电脑端 yive 并重新连接。' : '请更新服务器端 yive。'
  return `${subject} 版本较旧或能力未知，缺少：${missing.join('、')}。${action}`
}

const formatRelayFeatureWarning = (health: RelayHealthSnapshot): string | null =>
  formatMissingRemoteFeatures(health.features, 'relay')

const formatRefreshTime = (value: number | null): string => {
  if (!value) return '尚未刷新'
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

const formatRelayEventsStatus = (status: RelayEventsStatus, now = Date.now()): string | null => {
  if (status.kind === 'idle') return null
  if (status.kind === 'connected') {
    if (now - status.updatedAt > RELAY_EVENTS_STALE_MS) {
      return `事件流可能过期：最近更新 ${formatRefreshTime(status.updatedAt)}`
    }
    return `事件流已恢复 ${formatRefreshTime(status.updatedAt)}`
  }
  if (status.kind === 'reconnecting') {
    const retryMeta =
      typeof status.attempt === 'number' && typeof status.nextDelayMs === 'number'
        ? `第 ${status.attempt} 次，${formatRelayUptime(status.nextDelayMs)}后重试`
        : '等待重试'
    return `事件流重连中：${status.message}（${retryMeta}）`
  }
  return `事件流异常：${status.message}`
}

const formatRelayForegroundRefreshStatus = (state: RelayForegroundRefreshState): string | null => {
  if (state.kind === 'idle') return null
  if (state.kind === 'checking') return '正在重新检查远程连接...'
  return state.message
}

const formatRelaySnapshotWarning = (status: RelayEventsStatus, now = Date.now()): string | null => {
  if (status.kind === 'idle') return null
  if (status.kind === 'connected') {
    if (now - status.updatedAt <= RELAY_EVENTS_STALE_MS) return null
    return `远程状态已暂停更新：事件流 ${formatRelayRuntimeAge(status.updatedAt, now)}未收到新数据。`
  }
  if (status.kind === 'reconnecting') {
    if (now - status.updatedAt < RELAY_EVENTS_RECONNECT_NOTICE_DELAY_MS) return null
    const retryMeta =
      typeof status.attempt === 'number' && typeof status.nextDelayMs === 'number'
        ? `，${formatRelayUptime(status.nextDelayMs)}后重试`
        : ''
    return `远程状态已暂停更新：事件流正在重连${retryMeta}，当前列表是上次收到的状态。`
  }
  return `远程状态已暂停更新：事件流异常，当前列表是上次收到的状态。`
}

const buildRelayEventsDiagnostic = (
  status: RelayEventsStatus,
  now = Date.now()
): { label: string; tone: 'error' | 'ok' | 'warn' } | null => {
  if (status.kind === 'idle') {
    return {
      label: '实时事件流尚未建立，当前列表依赖主动刷新。',
      tone: 'warn',
    }
  }
  if (status.kind === 'connected') {
    const age = formatRelayRuntimeAge(status.updatedAt, now)
    if (now - status.updatedAt > RELAY_EVENTS_STALE_MS) {
      return {
        label: `实时事件流可能过期：${age}未收到新快照。`,
        tone: 'warn',
      }
    }
    return {
      label: `实时事件流正常：最近 ${age}收到快照。`,
      tone: 'ok',
    }
  }
  if (status.kind === 'reconnecting') {
    const retryMeta =
      typeof status.attempt === 'number' && typeof status.nextDelayMs === 'number'
        ? `，第 ${status.attempt} 次，${formatRelayUptime(status.nextDelayMs)}后重试`
        : ''
    return {
      label: `实时事件流正在重连：${status.message}${retryMeta}`,
      tone: 'warn',
    }
  }
  return {
    label: `实时事件流异常：${status.message}`,
    tone: 'error',
  }
}

const getRelayEventsConnectionTone = (
  status: RelayEventsStatus,
  now = Date.now()
): MobileConnectionTone | null => {
  if (status.kind === 'idle') return null
  if (status.kind === 'connected') {
    return now - status.updatedAt > RELAY_EVENTS_STALE_MS ? 'warn' : 'ok'
  }
  if (status.kind === 'reconnecting') return 'warn'
  return 'error'
}

const combineConnectionTones = (
  primary: MobileConnectionTone,
  secondary: MobileConnectionTone | null
): MobileConnectionTone => {
  if (primary === 'error' || secondary === 'error') return 'error'
  if (primary === 'warn' || secondary === 'warn') return 'warn'
  return 'ok'
}

const isStaleTerminalError = (message: string): boolean =>
  /\b404\b|not found|missing run|run .*not/i.test(message)

const TERMINAL_ERROR_MAX_LENGTH = 160
const TERMINAL_BASE64_LIKE_PATTERN = /[A-Za-z0-9+/]{80,}={0,2}/gu
const TERMINAL_BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu
const TERMINAL_QUERY_TOKEN_PATTERN = /([?&](?:agent_token|pairing_token|token)=)[^&\s"'<>]+/giu
const TERMINAL_TOKEN_ASSIGNMENT_PATTERN =
  /\b(HIVE_AGENT_TOKEN|agent_token|authorization|x-hive-agent-token)\b\s*[:=]\s*["']?[^"'\s,;)]+/giu
const TERMINAL_UNIX_PATH_PATTERN =
  /(^|[\s("'=])\/(?:Users|home|mnt|private|tmp|var|Volumes)\/[^\s"'`<>]+/gu
const TERMINAL_WINDOWS_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\s"'`<>]+/gu

const sanitizeMobileTerminalErrorMessage = (message: string): string => {
  const sanitized = Array.from(message.trim())
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join('')
    .replace(TERMINAL_TOKEN_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=[redacted]`)
    .replace(TERMINAL_BEARER_TOKEN_PATTERN, 'Bearer [redacted]')
    .replace(TERMINAL_QUERY_TOKEN_PATTERN, '$1[redacted]')
    .replace(TERMINAL_WINDOWS_PATH_PATTERN, '[local path]')
    .replace(TERMINAL_UNIX_PATH_PATTERN, '$1[local path]')
    .replace(TERMINAL_BASE64_LIKE_PATTERN, '[redacted base64]')
    .replace(/\s+/gu, ' ')
    .trim()
  return sanitized.slice(0, TERMINAL_ERROR_MAX_LENGTH) || '未知错误'
}

const formatMobileTerminalErrorMessage = (message: string, mode: MobileRuntimeSession['mode']) => {
  const sanitized = sanitizeMobileTerminalErrorMessage(message)
  if (/local runtime|runtime request timed out|ui session|ECONNREFUSED/iu.test(message)) {
    return `电脑在线，但本地 yive runtime 终端代理失败：${sanitized}。请确认电脑端 yive 正在运行后重试。`
  }
  if (
    /desktop peer disconnected|terminal proxy|websocket|socket|closed|disconnect/iu.test(message)
  ) {
    return mode === 'relay'
      ? `远程终端连接已断开：${sanitized}。请刷新终端；如果反复出现，返回上一页打开 Relay 诊断，确认电脑 Bridge 和本地 runtime 在线。`
      : `终端连接已断开：${sanitized}。请刷新终端或重新进入 Agent。`
  }
  return mode === 'relay'
    ? `远程终端连接失败：${sanitized}。请确认 Relay、电脑 yive connect 和本地 runtime 在线。`
    : `终端连接失败：${sanitized}。请刷新终端或重新进入 Agent。`
}

const buildApprovalItems = (agents: AgentCardModel[]): ApprovalItem[] => {
  const pendingDispatches = agents
    .filter(
      (agent) =>
        agent.kind === 'worker' &&
        (agent.activeDispatchId !== null || agent.queuedDispatchCount > 0)
    )
    .map((agent) => ({
      id: `dispatch-${agent.id}`,
      agentName: agent.name,
      description: `${agent.activeDispatchId ? '1 个 active Dispatch' : '无 active Dispatch'}，${agent.queuedDispatchCount} 个排队 Dispatch。`,
      kind: 'dispatch' as const,
      title: '派发任务需要关注',
    }))

  const runningTerminals = agents
    .filter((agent) => agent.run && agent.run.status !== 'stopped')
    .map((agent) => ({
      id: `danger-${agent.id}`,
      agentName: agent.name,
      description: '停止该终端会影响电脑端真实 PTY，需要二次确认。',
      kind: 'danger' as const,
      title: '危险终端操作',
    }))

  const orchestrator = agents.find((agent) => agent.kind === 'orchestrator')
  const userInput =
    orchestrator && !orchestrator.run
      ? [
          {
            id: 'input-orchestrator-offline',
            agentName: orchestrator.name,
            description: 'Orchestrator 启动前，手机端输入无法送达。',
            kind: 'input' as const,
            title: '暂不可输入',
          },
        ]
      : []

  return [...pendingDispatches, ...runningTerminals, ...userInput].slice(0, 6)
}

export const MobileApp = () => {
  const relayEntry = useMemo(() => getRelayEntry(), [])
  if (relayEntry.kind === 'pairing') return <MobileRelayPairing entry={relayEntry} />
  if (relayEntry.kind === 'picker') return <MobileRelayDevicePicker entry={relayEntry} />
  return <MobileRuntimeApp />
}

const buildRelayPairingHref = ({
  absolute = false,
  claimShortToken = false,
  desktopId,
  deviceId,
  serverUrl,
  token,
  workspaceIds,
}: {
  absolute?: boolean
  claimShortToken?: boolean
  desktopId?: string
  deviceId?: string
  serverUrl?: string
  token?: string
  workspaceIds?: string[]
}): string => {
  const url = new URL(getCurrentRelayMobilePath(), window.location.origin)
  url.searchParams.set('relay', '1')
  if (token) url.searchParams.set('token', token)
  if (claimShortToken) url.searchParams.set('claim', '1')
  if (desktopId) url.searchParams.set('desktop_id', desktopId)
  if (deviceId) url.searchParams.set('device_id', deviceId)
  for (const workspaceId of workspaceIds ?? []) url.searchParams.append('workspace_id', workspaceId)
  const normalizedServerUrl = normalizeRelayServerUrl(serverUrl)
  if (normalizedServerUrl) url.searchParams.set('server', normalizedServerUrl)
  return absolute ? url.toString() : `${url.pathname}${url.search}`
}

const buildRelayReconnectHref = (serverUrl?: string): string => {
  const base =
    normalizeRelayServerUrl(serverUrl) ??
    getCurrentRelayAppBaseUrl() ??
    (typeof window === 'undefined' ? 'http://127.0.0.1' : window.location.origin)
  const url = new URL(getCurrentRelayMobilePath(), base)
  url.searchParams.set('relay', '1')
  return url.toString()
}

const parseRelayWorkspaceIdsText = (value: string): string[] => {
  const workspaceIds = value
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean)
  return Array.from(new Set(workspaceIds))
}

const buildRelayDesktopHref = (
  entry: Extract<MobileRelayEntry, { kind: 'picker' }>,
  desktop: RelayDesktopDevice
): string => {
  const url = new URL(getCurrentRelayMobilePath(), window.location.origin)
  url.searchParams.set('relay', '1')
  url.searchParams.set('desktop_id', desktop.device_id)
  if (entry.deviceId) url.searchParams.set('device_id', entry.deviceId)
  const serverUrl = normalizeRelayServerUrl(entry.serverUrl)
  if (serverUrl) url.searchParams.set('server', serverUrl)
  return `${url.pathname}${url.search}`
}

const quotePowershellArg = (value: string): string => `"${value.replace(/"/gu, '`"')}"`

const buildRelayDesktopConnectCommands = ({
  desktopId = 'desktop-windows',
  runtimeUrl = 'http://127.0.0.1:3001',
  serverUrl,
}: MobileRelayDesktopConnectGuideContext): { direct: string; supervisor: string } => {
  const normalizedServerUrl = normalizeRelayServerUrl(serverUrl) ?? '<relay-url>'
  const powershellArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'deploy\\run-windows-desktop-relay.ps1',
    '-RelayServer',
    normalizedServerUrl,
    '-RelayToken',
    '<relay-admin-token>',
    '-DeviceId',
    desktopId,
    '-RuntimeUrl',
    runtimeUrl,
  ]
  return {
    direct: [
      'yive',
      'connect',
      '--server',
      normalizedServerUrl,
      '--token',
      '<relay-admin-token>',
      '--device-id',
      desktopId,
      '--runtime',
      runtimeUrl,
      '--require-runtime',
    ].join(' '),
    supervisor: `powershell ${powershellArgs.map(quotePowershellArg).join(' ')}`,
  }
}

const buildRelayDiagnosticCommands = ({
  desktopId,
  serverUrl,
}: {
  desktopId: string
  serverUrl?: string | undefined
}): MobileRelayDiagnosticCommand[] => {
  const normalizedServerUrl = normalizeRelayServerUrl(serverUrl) ?? '<relay-url>'
  const relayOrigin = normalizeRelayServerUrl(serverUrl) ?? '<relay-origin>'
  return [
    {
      command: [
        'yive',
        'relay',
        'checklist',
        '--server',
        normalizedServerUrl,
        '--desktop-id',
        desktopId,
        '--workspace-id',
        '<workspace-id>',
        '--run-id',
        '<run-id>',
        '--workspace-file',
        '<relative-file>',
      ].join(' '),
      label: '公网验收清单',
      purpose: '一次性生成公网 Relay、终端接管、文件下载和图片粘贴的验收步骤',
    },
    {
      command: [
        'yive',
        'connect',
        'status',
        '--server',
        normalizedServerUrl,
        '--token',
        '<admin-or-device-token>',
        '--device-id',
        desktopId,
        '--runtime',
        'http://127.0.0.1:3001',
        '--status-file',
        '"$env:USERPROFILE\\.config\\yive\\desktop-relay-status.json"',
      ].join(' '),
      label: '本地连接状态自检',
      purpose: '在电脑端只读检查本地 runtime、Relay 注册和手机路由',
    },
    {
      command: [
        'yive',
        'relay',
        'doctor',
        '--server',
        normalizedServerUrl,
        '--token',
        '<relay-admin-token>',
        '--json',
      ].join(' '),
      label: '电脑端 Relay doctor',
      purpose: '输出 JSON，供 App 或管理端自动诊断',
    },
    {
      command: [
        'pnpm',
        'smoke:relay-all',
        '--',
        '--server',
        normalizedServerUrl,
        '--token',
        '<relay-admin-token>',
        '--desktop-id',
        desktopId,
        '--max-stale-ms',
        '30000',
        '--json',
      ].join(' '),
      label: '公网一键诊断验收',
      purpose: '输出结构化 JSON，失败时查看 next_commands 和 repair_commands',
    },
    {
      command: [
        'pnpm',
        'smoke:relay-all',
        '--',
        '--server',
        normalizedServerUrl,
        '--token',
        '<relay-admin-token>',
        '--desktop-id',
        desktopId,
        '--max-stale-ms',
        '30000',
        '--verify-terminal-output',
      ].join(' '),
      label: '公网终端闭环验收',
      purpose: '验证手机到本地 Agent 的终端输入输出闭环',
    },
    {
      command: [
        'pnpm',
        'smoke:relay-mobile-events',
        '--',
        '--server',
        normalizedServerUrl,
        '--token',
        '<relay-admin-token>',
        '--desktop-id',
        desktopId,
        '--max-stale-ms',
        '30000',
      ].join(' '),
      label: '公网实时状态验收',
      purpose: '验证手机看板能通过 Relay 收到本地电脑实时状态和心跳',
    },
    {
      command: [
        'pnpm',
        'smoke:relay-file-exchange',
        '--',
        '--server',
        normalizedServerUrl,
        '--token',
        '<relay-admin-token>',
        '--desktop-id',
        desktopId,
      ].join(' '),
      label: '公网文件交换验收',
      purpose: '验证手机和本地电脑之间的临时文件上传、列表、下载和清理链路',
    },
    {
      command: [
        'pnpm',
        'smoke:relay-all',
        '--',
        '--server',
        normalizedServerUrl,
        '--token',
        '<relay-admin-token>',
        '--desktop-id',
        desktopId,
        '--max-stale-ms',
        '30000',
        '--workspace-id',
        '<workspace-id>',
        '--run-id',
        '<run-id>',
        '--verify-image-paste',
      ].join(' '),
      label: '公网图片粘贴验收',
      purpose: '验证手机图片上传后能通过 Relay 绑定到本地 Agent 附件',
    },
    {
      command: [
        'pnpm',
        'mobile:android:check',
        '--',
        '--domain',
        relayOrigin,
        '--static-dir',
        'web/dist',
        '--out-dir',
        'android-twa',
        '--android-package',
        'com.example.yive',
        '--android-sha256',
        '<release-cert-sha256>',
        '--check-domain',
      ].join(' '),
      label: 'Android/TWA 发布检查',
      purpose: '生成并验证 Android App Links、静态手机页面和 TWA 包装文件',
    },
  ]
}

const RELAY_RECOMMENDED_SMOKE_LABELS: Record<
  MobileRelayRecommendedSmoke,
  { detail: string; label: string }
> = {
  checklist: {
    detail: '生成一份从 Relay doctor 到终端、文件和图片的完整公网验收步骤。',
    label: '公网验收清单',
  },
  doctor: {
    detail: '先确认 Relay 服务、协议、静态页面、token 和设备列表是否正常。',
    label: 'Relay doctor',
  },
  events: {
    detail: '确认手机可以收到本地电脑的实时状态、心跳和断线事件。',
    label: '实时状态验收',
  },
  file_exchange: {
    detail: '确认手机和本地电脑之间的上传、列表、下载和清理链路。',
    label: '文件交换验收',
  },
  image_paste: {
    detail: '确认手机上传图片后，Relay 能把附件绑定到本地 Agent。',
    label: '图片粘贴验收',
  },
  terminal: {
    detail: '确认手机接管后，终端输入和输出能通过公网 Relay 完成闭环。',
    label: '终端闭环验收',
  },
}

const getRelayDesktopRuntimeLabel = (desktop: RelayDesktopDevice): string => {
  if (desktop.runtime_status === 'online') return 'Runtime 在线'
  if (desktop.runtime_status === 'offline') return desktop.runtime_message ?? 'Runtime 不可用'
  return 'Runtime 状态未知'
}

const formatRelayRuntimeAge = (updatedAt: number, now = Date.now()): string => {
  const elapsedMs = Math.max(0, now - updatedAt)
  const elapsedSeconds = Math.round(elapsedMs / 1000)
  if (elapsedSeconds < 5) return '刚刚更新'
  if (elapsedSeconds < 60) return `${elapsedSeconds} 秒前`
  const elapsedMinutes = Math.round(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`
  const elapsedHours = Math.round(elapsedMinutes / 60)
  return `${elapsedHours} 小时前`
}

const formatRelayDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const totalMinutes = Math.round(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes} 分钟`
  const totalHours = Math.round(totalMinutes / 60)
  return `${totalHours} 小时`
}

const formatRelayPairingLinkExpiry = (
  pairingLink: Extract<RelayPairingLinkState, { kind: 'ready' }>,
  now = Date.now()
): string | null => {
  if (typeof pairingLink.expiresAt === 'number' && pairingLink.expiresAt > 0) {
    if (pairingLink.expiresAt <= now) return '配对链接已过期，请重新生成'
    return `有效期约 ${formatRelayDuration(pairingLink.expiresAt - now)}`
  }
  if (typeof pairingLink.ttlMs === 'number' && pairingLink.ttlMs > 0) {
    return `有效期约 ${formatRelayDuration(pairingLink.ttlMs)}`
  }
  return null
}

const isRelayPairingLinkExpired = (
  pairingLink: Extract<RelayPairingLinkState, { kind: 'ready' }>,
  now = Date.now()
): boolean =>
  typeof pairingLink.expiresAt === 'number' &&
  pairingLink.expiresAt > 0 &&
  pairingLink.expiresAt <= now

const getRelayDesktopRuntimeMeta = (
  desktop: RelayDesktopDevice,
  now = Date.now()
): string | null => {
  if (typeof desktop.runtime_updated_at !== 'number' || desktop.runtime_updated_at <= 0) return null
  const ageLabel = formatRelayRuntimeAge(desktop.runtime_updated_at, now)
  if (now - desktop.runtime_updated_at > RELAY_RUNTIME_STALE_MS) {
    return `状态可能过期 · ${ageLabel}`
  }
  return `状态更新于 ${ageLabel}`
}

const getRelayDesktopSupervisorDiagnostic = (
  desktop: RelayDesktopDevice,
  now = Date.now()
): MobileRelayDiagnosticCheck | null => {
  if (!desktop.supervisor_status || desktop.supervisor_status === 'missing') return null
  const phase = desktop.supervisor_phase ? `，阶段 ${desktop.supervisor_phase}` : ''
  const age =
    typeof desktop.supervisor_updated_at === 'number' && desktop.supervisor_updated_at > 0
      ? `，更新于 ${formatRelayRuntimeAge(desktop.supervisor_updated_at, now)}`
      : ''
  if (desktop.supervisor_status === 'running') {
    return {
      id: 'desktop_supervisor',
      label: `电脑端 Relay 守护正常${phase}${age}。`,
      tone: 'ok',
    }
  }
  if (desktop.supervisor_status === 'stale') {
    return {
      id: 'desktop_supervisor',
      label: `电脑端 Relay 守护状态过期${phase}${age}，请确认守护进程仍在运行。`,
      tone: 'warn',
    }
  }
  return {
    id: 'desktop_supervisor',
    label: `电脑端 Relay 守护状态异常${phase}${age}，请在电脑端运行 yive connect status。`,
    tone: 'warn',
  }
}

const isRelayDesktopRuntimeStale = (desktop: RelayDesktopDevice, now = Date.now()): boolean =>
  typeof desktop.runtime_updated_at === 'number' &&
  desktop.runtime_updated_at > 0 &&
  now - desktop.runtime_updated_at > RELAY_RUNTIME_STALE_MS

const getRelayDesktopConnectionMeta = (
  desktop: RelayDesktopDevice,
  now = Date.now()
): Array<{ label: string; stale: boolean }> => {
  const lines: Array<{ label: string; stale: boolean }> = []
  if (typeof desktop.connected_at === 'number' && desktop.connected_at > 0) {
    lines.push({
      label: `电脑连接于 ${formatRelayRuntimeAge(desktop.connected_at, now)}`,
      stale: false,
    })
  }
  if (
    typeof desktop.last_seen_at === 'number' &&
    desktop.last_seen_at > 0 &&
    desktop.last_seen_at !== desktop.runtime_updated_at
  ) {
    lines.push({
      label: `最近在线 ${formatRelayRuntimeAge(desktop.last_seen_at, now)}`,
      stale: now - desktop.last_seen_at > RELAY_RUNTIME_STALE_MS,
    })
  }
  return lines
}

const getRelayDesktopMobileMeta = (
  desktop: RelayDesktopDevice,
  mobiles: RelayMobileDevice[]
): string | null => {
  const connectedMobiles = mobiles.filter((mobile) => mobile.desktop_id === desktop.device_id)
  if (connectedMobiles.length === 0) return null
  const deviceIds = connectedMobiles.map((mobile) => mobile.device_id).join('、')
  return connectedMobiles.length === 1
    ? `已连接手机 ${deviceIds}`
    : `已连接 ${connectedMobiles.length} 台手机：${deviceIds}`
}

const buildRelayPickerDiagnostics = ({
  devices,
  health,
  healthRoundTripMs,
  message,
  serverUrl,
  state,
}: {
  devices: RelayDesktopDevice[]
  health: RelayHealthSnapshot | null
  healthRoundTripMs: number | null
  message: string | null
  serverUrl?: string | undefined
  state: 'error' | 'loading' | 'ready'
}): Array<{ label: string; tone: 'error' | 'ok' | 'warn' }> => {
  const lines: Array<{ label: string; tone: 'error' | 'ok' | 'warn' }> = []
  if (health) {
    lines.push({
      label: `Relay 服务在线，当前 ${health.desktop_count} 台电脑、${health.mobile_count} 台手机连接。`,
      tone: 'ok',
    })
    const featureWarning = formatRelayFeatureWarning(health)
    if (featureWarning) {
      lines.push({
        label: featureWarning,
        tone: 'error',
      })
    }
    const roundTripDiagnostic = buildRelayRoundTripDiagnostic(healthRoundTripMs)
    if (roundTripDiagnostic) lines.push(roundTripDiagnostic)
    const heartbeatDiagnostic = buildRelayHeartbeatDiagnostic(health)
    if (heartbeatDiagnostic) lines.push(heartbeatDiagnostic)
    if (health.deployment && !health.deployment.public_url_configured) {
      lines.push({
        label: 'Relay 未配置公网验收地址，服务器部署或回滚后不会自动做公网 smoke 检查。',
        tone: 'warn',
      })
    }
    if (health.static && !health.static.mobile_app_available) {
      lines.push({
        label: 'Relay 没有找到构建后的手机页面，请在服务器部署时执行 pnpm build 并配置静态目录。',
        tone: 'error',
      })
    }
    const androidReadiness = getMobileAndroidTwaReadiness({
      mobileAppAvailable: health.static?.mobile_app_available,
      relayServerUrl: serverUrl,
    })
    lines.push({
      label: androidReadiness.message,
      tone: androidReadiness.tone,
    })
    if (health.pairing_store && !health.pairing_store.persistent) {
      lines.push({
        label: 'Relay 配对信息只保存在内存里，服务器重启后手机需要重新配对。',
        tone: 'warn',
      })
    }
    if (health.pairing_store && health.pairing_store.require_desktop_binding === false) {
      lines.push({
        label: 'Relay 未开启桌面绑定严格模式，手机 token 可能被用于连接其他电脑。',
        tone: 'error',
      })
    }
    if (health.pairing_store?.admin_token_default) {
      lines.push({
        label: 'Relay 正在使用开发默认管理员 token，请在服务器上配置专用 token。',
        tone: 'error',
      })
    }
    if (!isRelayHttpProtocolSupported(health)) {
      lines.push({
        label: `Relay 协议 v${health.protocol_version} 高于当前手机端支持的 v${SUPPORTED_RELAY_HTTP_PROTOCOL_VERSION}。`,
        tone: 'error',
      })
    }
  } else if (state === 'loading') {
    lines.push({ label: '正在检查 Relay 服务状态。', tone: 'warn' })
  } else if (message) {
    lines.push({ label: message, tone: 'error' })
  } else {
    lines.push({ label: '暂时没有 Relay 健康状态。', tone: 'warn' })
  }

  if (state === 'error') {
    lines.push({
      label: '设备列表不可用，请先处理上方错误或重新配对。',
      tone: 'error',
    })
    return lines
  }

  for (const desktop of devices) {
    if (desktop.runtime_status !== 'offline') {
      const featureWarning = formatMissingRemoteFeatures(desktop.features, 'desktop')
      if (!featureWarning) continue
      lines.push({
        label: `电脑 ${desktop.device_id}：${featureWarning}`,
        tone: 'warn',
      })
    }
  }

  if (state === 'loading') {
    lines.push({ label: '正在验证配对 token 和在线电脑列表。', tone: 'warn' })
    return lines
  }

  lines.push({ label: '配对 token 可用，设备列表接口已返回。', tone: 'ok' })
  if (devices.length === 0) {
    lines.push({
      label: '没有在线电脑，请在本地电脑运行 yive connect。',
      tone: 'error',
    })
    return lines
  }

  const onlineRuntimeCount = devices.filter((device) => device.runtime_status !== 'offline').length
  const offlineRuntimeCount = devices.length - onlineRuntimeCount
  if (onlineRuntimeCount > 0) {
    lines.push({
      label: `${onlineRuntimeCount} 台电脑可连接。`,
      tone: 'ok',
    })
  }
  if (offlineRuntimeCount > 0) {
    lines.push({
      label: `${offlineRuntimeCount} 台电脑已连上 Relay，但本地 yive runtime 不可用。`,
      tone: 'warn',
    })
  }
  return lines
}

const buildRelayRuntimeDiagnosticReport = ({
  desktopId,
  diagnostics,
  deviceId,
  eventsNow,
  eventsStatus,
  serverUrl,
}: {
  desktopId: string
  deviceId?: string | undefined
  diagnostics: RelayRuntimeDiagnosticsState
  eventsNow: number
  eventsStatus: RelayEventsStatus
  serverUrl?: string | undefined
}): MobileRelayDiagnosticReport => {
  const generatedAt = new Date(eventsNow).toISOString()
  const createReport = (checks: MobileRelayDiagnosticCheck[]): MobileRelayDiagnosticReport => ({
    checks,
    desktop_id: desktopId,
    ...(deviceId ? { device_id: deviceId } : {}),
    generated_at: generatedAt,
    ...buildRelayRuntimeDiagnosticNextAction(checks),
    ok: checks.every((check) => check.tone !== 'error'),
    recommended_smoke: buildRelayRuntimeRecommendedSmoke(checks),
    relay: {
      devices_checked: diagnostics.kind === 'ready' && diagnostics.devices !== null,
      health_checked: diagnostics.kind === 'ready' && diagnostics.health !== null,
    },
    status: diagnostics.kind,
  })

  if (diagnostics.kind === 'idle') {
    return createReport([
      { id: 'diagnostics_idle', label: '等待连接失败后检查 Relay 链路。', tone: 'warn' },
    ])
  }
  if (diagnostics.kind === 'loading') {
    return createReport([
      {
        id: 'diagnostics_loading',
        label: '正在检查 Relay、配对 token 和本地电脑状态。',
        tone: 'warn',
      },
    ])
  }

  const checks: MobileRelayDiagnosticCheck[] = []
  if (diagnostics.health) {
    checks.push({
      id: 'relay_http',
      label: `Relay 服务在线，当前 ${diagnostics.health.desktop_count} 台电脑、${diagnostics.health.mobile_count} 台手机连接。`,
      tone: 'ok',
    })
    const roundTripDiagnostic = buildRelayRoundTripDiagnostic(diagnostics.healthRoundTripMs)
    if (roundTripDiagnostic) checks.push({ id: 'relay_latency', ...roundTripDiagnostic })
    const heartbeatDiagnostic = buildRelayHeartbeatDiagnostic(diagnostics.health)
    if (heartbeatDiagnostic) checks.push({ id: 'relay_heartbeat', ...heartbeatDiagnostic })
    if (typeof diagnostics.health.terminal_proxy_count === 'number') {
      checks.push({
        id: 'terminal_proxy',
        label: `终端代理连接 ${diagnostics.health.terminal_proxy_count} 个。`,
        tone: 'ok',
      })
    }
    if (diagnostics.health.deployment && !diagnostics.health.deployment.public_url_configured) {
      checks.push({
        id: 'relay_public_url',
        label: 'Relay 未配置公网验收地址，服务器部署或回滚后不会自动做公网 smoke 检查。',
        tone: 'warn',
      })
    }
    if (diagnostics.health.static && !diagnostics.health.static.mobile_app_available) {
      checks.push({
        id: 'relay_static_mobile',
        label: 'Relay 没有找到构建后的手机页面，请检查服务器静态目录配置。',
        tone: 'error',
      })
    }
    const androidReadiness = getMobileAndroidTwaReadiness({
      mobileAppAvailable: diagnostics.health.static?.mobile_app_available,
      relayServerUrl: serverUrl,
    })
    checks.push({
      id: `android_twa_${androidReadiness.kind}`,
      label: androidReadiness.message,
      tone: androidReadiness.tone,
    })
    if (diagnostics.health.pairing_store && !diagnostics.health.pairing_store.persistent) {
      checks.push({
        id: 'relay_pairing_store',
        label: 'Relay 配对信息未持久化，服务器重启后需要重新配对。',
        tone: 'warn',
      })
    }
    if (
      diagnostics.health.pairing_store &&
      diagnostics.health.pairing_store.require_desktop_binding === false
    ) {
      checks.push({
        id: 'relay_desktop_binding',
        label: 'Relay 未开启桌面绑定严格模式，手机 token 可能被用于连接其他电脑。',
        tone: 'error',
      })
    }
    if (!isRelayHttpProtocolSupported(diagnostics.health)) {
      checks.push({
        id: 'relay_protocol',
        label: `Relay 协议 v${diagnostics.health.protocol_version} 高于当前手机端支持的 v${SUPPORTED_RELAY_HTTP_PROTOCOL_VERSION}。`,
        tone: 'error',
      })
    }
  } else {
    checks.push({
      id: 'relay_http',
      label: diagnostics.healthMessage ?? 'Relay 健康检查失败。',
      tone: 'error',
    })
  }

  if (!diagnostics.devices) {
    checks.push({
      id: 'relay_devices',
      label: diagnostics.devicesMessage ?? '设备列表不可用，无法确认电脑是否在线。',
      tone: 'error',
    })
    checks.push({
      id: 'relay_devices_next',
      label: '请先点“重试连接”；如果仍失败，请重新配对或检查 Relay token 是否已被撤销。',
      tone: 'warn',
    })
    return createReport(checks)
  }

  checks.push({ id: 'relay_devices', label: '配对 token 可用，设备列表接口已返回。', tone: 'ok' })
  const eventsDiagnostic = buildRelayEventsDiagnostic(eventsStatus, eventsNow)
  if (eventsDiagnostic) checks.push({ id: 'relay_events', ...eventsDiagnostic })
  const desktopIds = new Set(diagnostics.devices.desktops.map((device) => device.device_id))
  const currentMobile = deviceId
    ? diagnostics.devices.mobiles.find((mobile) => mobile.device_id === deviceId)
    : null
  if (currentMobile && currentMobile.desktop_id !== desktopId) {
    checks.push({
      id: 'mobile_binding',
      label: `当前手机 ${deviceId} 连接到 ${currentMobile.desktop_id}，不是页面目标电脑 ${desktopId}。`,
      tone: 'error',
    })
    if (!desktopIds.has(currentMobile.desktop_id)) {
      checks.push({
        id: 'mobile_bound_desktop',
        label: `手机当前绑定的电脑 ${currentMobile.desktop_id} 不在线。`,
        tone: 'error',
      })
    }
    checks.push({
      id: 'mobile_binding_next',
      label: '请点“切换电脑”选择正确电脑，或重新用目标电脑生成配对链接。',
      tone: 'warn',
    })
    return createReport(checks)
  }
  if (currentMobile && !desktopIds.has(currentMobile.desktop_id)) {
    checks.push({
      id: 'mobile_bound_desktop',
      label: `当前手机 ${deviceId} 指向的电脑 ${currentMobile.desktop_id} 不在线。`,
      tone: 'error',
    })
    checks.push({
      id: 'mobile_bound_desktop_next',
      label: '请在目标电脑执行 yive connect，或切换到一台在线电脑。',
      tone: 'warn',
    })
    return createReport(checks)
  }

  const desktop = diagnostics.devices.desktops.find((device) => device.device_id === desktopId)
  if (!desktop) {
    checks.push({
      id: 'desktop_online',
      label: `目标电脑 ${desktopId} 不在线，请在该电脑执行 yive connect。`,
      tone: 'error',
    })
    checks.push({
      id: 'desktop_online_next',
      label:
        '如果要连接另一台电脑，请点“切换电脑”；如果仍使用这台电脑，请在电脑端重新执行 yive connect。',
      tone: 'warn',
    })
    return createReport(checks)
  }

  if (desktop.runtime_status === 'offline') {
    checks.push({
      id: 'desktop_runtime',
      label: `目标电脑已连接 Relay，但本地 yive runtime 不可用：${getRelayDesktopRuntimeLabel(desktop)}。`,
      tone: 'error',
    })
    checks.push({
      id: 'desktop_runtime_next',
      label: '请在目标电脑启动 yive runtime；启动后手机端点“重试连接”。',
      tone: 'warn',
    })
    return createReport(checks)
  }

  checks.push({
    id: 'desktop_runtime',
    label: `目标电脑 ${desktopId} 在线，${getRelayDesktopRuntimeLabel(desktop)}。`,
    tone: 'ok',
  })
  const runtimeMeta = getRelayDesktopRuntimeMeta(desktop)
  if (runtimeMeta) {
    checks.push({
      id: 'desktop_runtime_age',
      label: runtimeMeta,
      tone: runtimeMeta.includes('过期') ? 'warn' : 'ok',
    })
  }
  const supervisorDiagnostic = getRelayDesktopSupervisorDiagnostic(desktop)
  if (supervisorDiagnostic) checks.push(supervisorDiagnostic)
  for (const item of getRelayDesktopConnectionMeta(desktop)) {
    checks.push({
      id: `desktop_connection_${checks.length}`,
      label: item.label,
      tone: item.stale ? 'warn' : 'ok',
    })
  }
  return createReport(checks)
}

const buildRelayRuntimeDiagnosticNextAction = (
  checks: MobileRelayDiagnosticCheck[]
): { next_action?: string; next_action_id?: string } => {
  const errorPriority = [
    'desktop_runtime',
    'desktop_online',
    'mobile_binding',
    'mobile_bound_desktop',
    'relay_devices',
    'relay_http',
    'relay_protocol',
    'relay_static_mobile',
    'android_twa_blocked_http',
    'android_twa_blocked_static',
  ]
  const firstError =
    errorPriority
      .map((id) => checks.find((check) => check.id === id && check.tone === 'error'))
      .find((check) => check !== undefined) ?? checks.find((check) => check.tone === 'error')
  if (firstError) {
    const directNext = checks.find(
      (check) => check.id === `${firstError.id}_next` && check.tone !== 'error'
    )
    return {
      next_action: directNext?.label ?? firstError.label,
      next_action_id: getRelayRuntimeDiagnosticActionId(firstError.id),
    }
  }
  return {}
}

const buildRelayRuntimeRecommendedSmoke = (
  checks: MobileRelayDiagnosticCheck[]
): MobileRelayDiagnosticReport['recommended_smoke'] => {
  const hasError = (id: string) => checks.some((check) => check.id === id && check.tone === 'error')
  if (hasError('relay_http') || hasError('relay_static_mobile') || hasError('relay_protocol')) {
    return ['doctor']
  }
  if (hasError('relay_devices') || hasError('desktop_online') || hasError('mobile_binding')) {
    return ['doctor', 'events']
  }
  if (hasError('desktop_runtime')) return ['doctor', 'events']
  if (checks.some((check) => check.tone === 'error')) return ['doctor']
  return ['checklist', 'doctor', 'events', 'terminal', 'file_exchange', 'image_paste']
}

const getRelayRuntimeDiagnosticActionId = (checkId: string): string => {
  if (checkId === 'desktop_runtime') return 'start_desktop_runtime'
  if (checkId === 'desktop_online') return 'connect_desktop'
  if (checkId === 'mobile_binding' || checkId === 'mobile_bound_desktop') return 'switch_desktop'
  if (checkId === 'relay_devices' || checkId === 'relay_http') return 'retry_connection'
  if (checkId === 'relay_protocol') return 'update_relay'
  if (checkId === 'relay_static_mobile' || checkId === 'android_twa_blocked_static') {
    return 'deploy_mobile_static'
  }
  if (checkId === 'android_twa_blocked_http') return 'configure_https'
  return 'retry_connection'
}

const buildRelayPathItems = ({
  desktopId,
  deviceId,
  deviceState,
  eventsDetail,
  eventsStatus,
  eventsTone,
  serverUrl,
}: {
  desktopId: string
  deviceId?: string | undefined
  deviceState: RelayRuntimeDeviceState
  eventsDetail: string | null
  eventsStatus: RelayEventsStatus
  eventsTone: MobileConnectionTone | null
  serverUrl?: string | undefined
}): MobileRelayPathItem[] => {
  const relayLabel = serverUrl ? `Relay ${serverUrl}` : 'Relay 当前域名'
  const relay: MobileRelayPathItem = {
    detail: '已连接',
    label: relayLabel,
    tone: 'ok',
  }

  let desktop: MobileRelayPathItem = {
    detail: '确认中',
    label: `电脑 ${desktopId}`,
    tone: 'warn',
  }
  let runtime: MobileRelayPathItem = {
    detail: '等待电脑状态',
    label: '本地 runtime',
    tone: 'warn',
  }

  if (deviceState.kind === 'error') {
    desktop = {
      detail: '状态未知',
      label: `电脑 ${desktopId}`,
      tone: 'warn',
    }
    runtime = {
      detail: '状态未知',
      label: '本地 runtime',
      tone: 'warn',
    }
  } else if (deviceState.kind === 'ready') {
    if (!deviceState.desktop) {
      desktop = {
        detail: '离线',
        label: `电脑 ${desktopId}`,
        tone: 'error',
      }
      runtime = {
        detail: '不可达',
        label: '本地 runtime',
        tone: 'error',
      }
    } else {
      desktop = {
        detail: '在线',
        label: `电脑 ${desktopId}`,
        tone: 'ok',
      }
      if (deviceState.desktop.runtime_status === 'offline') {
        runtime = {
          detail: getRelayDesktopRuntimeLabel(deviceState.desktop),
          label: '本地 runtime',
          tone: 'error',
        }
      } else if (isRelayDesktopRuntimeStale(deviceState.desktop)) {
        runtime = {
          detail: getRelayDesktopRuntimeMeta(deviceState.desktop) ?? '状态可能过期',
          label: '本地 runtime',
          tone: 'warn',
        }
      } else {
        runtime = {
          detail: getRelayDesktopRuntimeLabel(deviceState.desktop),
          label: '本地 runtime',
          tone: 'ok',
        }
      }
    }
  }

  let events: MobileRelayPathItem = {
    detail: '等待事件流',
    label: '实时事件',
    tone: 'warn',
  }
  if (eventsStatus.kind === 'connected') {
    events = {
      detail: eventsDetail ?? '实时同步中',
      label: '实时事件',
      tone: eventsTone ?? 'ok',
    }
  } else if (eventsStatus.kind === 'reconnecting') {
    events = {
      detail: eventsDetail ?? '重连中',
      label: '实时事件',
      tone: 'warn',
    }
  } else if (eventsStatus.kind === 'error') {
    events = {
      detail: eventsDetail ?? eventsStatus.message,
      label: '实时事件',
      tone: 'error',
    }
  }

  const mobile: MobileRelayPathItem | null = deviceId
    ? {
        detail: '已配对',
        label: `当前手机 ${deviceId}`,
        tone: 'ok',
      }
    : null

  return mobile ? [relay, mobile, desktop, runtime, events] : [relay, desktop, runtime, events]
}

const MobileRelayDiagnostics = ({
  commands = [],
  id = 'mobile-relay-diagnostics-title',
  lines,
  onAction,
  report,
}: {
  commands?: MobileRelayDiagnosticCommand[]
  id?: string
  lines: Array<{ label: string; tone: 'error' | 'ok' | 'warn' }>
  onAction?: ((actionId: string) => void) | undefined
  report?: MobileRelayDiagnosticReport | undefined
}) => {
  const [copyMessage, setCopyMessage] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const lineKeyCounts = new Map<string, number>()
  const errorCount = report?.checks.filter((check) => check.tone === 'error').length ?? 0
  const warnCount = report?.checks.filter((check) => check.tone === 'warn').length ?? 0
  const reportTone: MobileConnectionTone | null = report
    ? errorCount > 0
      ? 'error'
      : warnCount > 0
        ? 'warn'
        : 'ok'
    : null
  const reportSummary = report
    ? report.ok
      ? `通过 ${report.checks.length} 项检查`
      : `${errorCount} 项失败，${warnCount} 项提醒`
    : null
  const actionLabel =
    report?.next_action_id === 'retry_connection'
      ? '重试连接'
      : report?.next_action_id === 'switch_desktop'
        ? '切换电脑'
        : null
  const copyDiagnostics = async () => {
    const text = [
      'Yive Relay 诊断',
      ...lines.map((item) => `[${item.tone}] ${item.label}`),
      ...(commands.length > 0
        ? ['', '推荐命令', ...commands.map((item) => `${item.label}: ${item.command}`)]
        : []),
      ...(commands.some((item) => item.purpose)
        ? [
            '',
            '用途',
            ...commands.flatMap((item) => (item.purpose ? [`${item.label}: ${item.purpose}`] : [])),
          ]
        : []),
      ...(report ? ['', '结构化诊断 JSON', JSON.stringify(report, null, 2)] : []),
    ].join('\n')
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable')
      await navigator.clipboard.writeText(text)
      setCopyMessage('已复制诊断信息')
    } catch {
      setCopyMessage('复制失败，请长按诊断内容手动复制')
    }
  }
  const runAction = (actionId: string, label: string) => {
    onAction?.(actionId)
    setActionMessage(`已执行：${label}`)
  }

  return (
    <section className="mobile-relay-diagnostics" aria-labelledby={id}>
      <div className="mobile-relay-diagnostics__header">
        <h2 id={id}>Relay 诊断</h2>
        <button className="mobile-text-button" onClick={() => void copyDiagnostics()} type="button">
          复制诊断
        </button>
      </div>
      {report && reportTone && reportSummary ? (
        <div className="mobile-relay-diagnostics__summary" data-tone={reportTone}>
          <strong>{report.ok ? '链路可用' : '链路异常'}</strong>
          <span>{reportSummary}</span>
          <small>
            目标电脑 {report.desktop_id}
            {report.device_id ? ` · 当前手机 ${report.device_id}` : ''}
          </small>
          {report.next_action ? (
            <em data-action={report.next_action_id}>下一步：{report.next_action}</em>
          ) : null}
          {actionLabel && report.next_action_id ? (
            <button
              className="mobile-text-button"
              onClick={() => runAction(report.next_action_id as string, actionLabel)}
              type="button"
            >
              {actionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
      {lines.map((item) => {
        const keyBase = `${item.tone}:${item.label}`
        const keyCount = lineKeyCounts.get(keyBase) ?? 0
        lineKeyCounts.set(keyBase, keyCount + 1)
        return (
          <span data-tone={item.tone} key={keyCount === 0 ? keyBase : `${keyBase}:${keyCount}`}>
            {item.label}
          </span>
        )
      })}
      {commands.length > 0 ? (
        <div className="mobile-relay-diagnostics__commands">
          {commands.map((item) => (
            <code key={item.label} title={item.purpose}>
              {item.label}
            </code>
          ))}
        </div>
      ) : null}
      {report?.recommended_smoke.length ? (
        <div className="mobile-relay-diagnostics__smoke">
          <strong>推荐验收</strong>
          <ul aria-label="推荐验收清单">
            {report.recommended_smoke.map((item) => {
              const smoke = RELAY_RECOMMENDED_SMOKE_LABELS[item]
              return (
                <li className="mobile-relay-diagnostics__smoke-item" key={item}>
                  <span>{smoke.label}</span>
                  <small>{smoke.detail}</small>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
      {copyMessage ? <small role="status">{copyMessage}</small> : null}
      {actionMessage ? <small role="status">{actionMessage}</small> : null}
    </section>
  )
}

const MobileRelayPath = ({ items }: { items: MobileRelayPathItem[] }) => (
  <section className="mobile-relay-path" aria-label="远程链路状态">
    {items.map((item) => (
      <div className="mobile-relay-path__item" data-tone={item.tone} key={item.label}>
        <span>{item.label}</span>
        <strong>{item.detail}</strong>
      </div>
    ))}
  </section>
)

const MobileRelayDesktopConnectGuide = ({
  context,
}: {
  context: MobileRelayDesktopConnectGuideContext
}) => {
  const [copyMessage, setCopyMessage] = useState<string | null>(null)
  const commands = buildRelayDesktopConnectCommands(context)
  const copyCommand = async (command: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable')
      await navigator.clipboard.writeText(command)
      setCopyMessage('已复制命令模板')
    } catch {
      setCopyMessage('复制失败，请长按命令手动复制')
    }
  }

  return (
    <section className="mobile-relay-connect-guide" aria-label="电脑端连接指引">
      <div>
        <h2>电脑端连接</h2>
        <p>在目标电脑启动本地 yive runtime 后，执行下面任一命令把电脑接入 Relay。</p>
      </div>
      <div className="mobile-relay-connect-guide__command">
        <span>推荐：Windows supervisor</span>
        <code>{commands.supervisor}</code>
        <button
          className="mobile-text-button"
          onClick={() => void copyCommand(commands.supervisor)}
          type="button"
        >
          复制
        </button>
      </div>
      <div className="mobile-relay-connect-guide__command">
        <span>直接连接</span>
        <code>{commands.direct}</code>
        <button
          className="mobile-text-button"
          onClick={() => void copyCommand(commands.direct)}
          type="button"
        >
          复制
        </button>
      </div>
      <small>
        命令里的 &lt;relay-admin-token&gt; 请在电脑端替换；也可以先配置
        ~/.config/yive/desktop-relay.env 后运行 supervisor。
      </small>
      {copyMessage ? <small role="status">{copyMessage}</small> : null}
    </section>
  )
}

const MobileRelayReconnectHint = ({
  desktopId,
  deviceId,
  onSwitchAccount,
  serverUrl,
}: {
  desktopId?: string | undefined
  deviceId?: string | undefined
  onSwitchAccount: () => void
  serverUrl?: string | undefined
}) => {
  const [copyMessage, setCopyMessage] = useState<string | null>(null)
  const reconnectHref = buildRelayReconnectHref(serverUrl)

  const copyReconnectHref = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable')
      await navigator.clipboard.writeText(reconnectHref)
      setCopyMessage('已复制固定入口')
    } catch {
      setCopyMessage('复制失败，请长按地址手动复制')
    }
  }

  return (
    <section className="mobile-relay-reconnect" aria-label="已保存的远程连接">
      <div>
        <strong>{desktopId ? '这台手机已长期配对' : '这台手机保存了配对信息'}</strong>
        <p>
          {desktopId
            ? `下次直接打开固定入口，会自动使用本机保存的 token 连接电脑 ${desktopId}。`
            : '当前还没有绑定具体电脑。请先选择在线电脑；如果列表不可用，请用电脑端生成的新配对链接重新配对。'}
        </p>
        {deviceId ? <small>手机设备名：{deviceId}</small> : null}
      </div>
      <div className="mobile-relay-reconnect__link">
        <code>{reconnectHref}</code>
        <button
          className="mobile-text-button"
          onClick={() => void copyReconnectHref()}
          type="button"
        >
          复制
        </button>
      </div>
      <button
        className="mobile-text-button mobile-text-button--danger"
        onClick={onSwitchAccount}
        type="button"
      >
        切换账号
      </button>
      {copyMessage ? <small role="status">{copyMessage}</small> : null}
    </section>
  )
}

const MobileInstallPrompt = ({ relayServerUrl }: { relayServerUrl?: string | undefined }) => {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [installState, setInstallState] = useState<'idle' | 'installing'>('idle')
  const [isStandalone, setIsStandalone] = useState(isStandaloneDisplayMode)
  const [showManualIosHint, setShowManualIosHint] = useState(readIsIosLikeBrowser)
  const installReadiness = getMobileAppInstallReadiness({
    installEvent,
    isStandalone,
    relayServerUrl,
    showManualIosHint,
  })

  useEffect(() => {
    const mediaQuery = window.matchMedia?.('(display-mode: standalone)')
    const updateStandalone = () => setIsStandalone(isStandaloneDisplayMode())
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallEvent(event as BeforeInstallPromptEvent)
      setInstallState('idle')
      setShowManualIosHint(false)
    }
    const handleInstalled = () => {
      setInstallEvent(null)
      setInstallState('idle')
      setIsStandalone(true)
      setShowManualIosHint(false)
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleInstalled)
    mediaQuery?.addEventListener?.('change', updateStandalone)
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleInstalled)
      mediaQuery?.removeEventListener?.('change', updateStandalone)
    }
  }, [])

  const promptInstall = async () => {
    if (!installEvent || installState === 'installing') return
    setInstallState('installing')
    try {
      await installEvent.prompt()
      const choice = await installEvent.userChoice?.catch(() => undefined)
      setInstallEvent(null)
      if (choice?.outcome !== 'accepted') setInstallState('idle')
    } catch {
      setInstallState('idle')
    }
  }

  if (installReadiness.kind === 'installed') return null

  if (installReadiness.kind === 'blocked_http') {
    return (
      <div className="mobile-install-prompt" data-readiness={installReadiness.kind}>
        <span>{installReadiness.message}</span>
      </div>
    )
  }

  if (installReadiness.kind === 'manual_ios') {
    return (
      <div className="mobile-install-prompt" data-readiness={installReadiness.kind}>
        <span>{installReadiness.message}</span>
      </div>
    )
  }

  if (installReadiness.kind !== 'installable') return null

  return (
    <div className="mobile-install-prompt" data-readiness={installReadiness.kind}>
      <span>{installReadiness.message}</span>
      <button
        className="mobile-text-button"
        disabled={installState === 'installing'}
        onClick={() => void promptInstall()}
        type="button"
      >
        {installState === 'installing' ? '打开安装...' : '安装到主屏幕'}
      </button>
    </div>
  )
}

const MobilePwaUpdateToast = () => {
  const [applyUpdate, setApplyUpdate] = useState<ServiceWorkerUpdateApply | null>(null)
  const [applying, setApplying] = useState(false)

  useEffect(
    () =>
      subscribeServiceWorkerUpdate((next) => {
        setApplyUpdate(() => next)
        if (!next) setApplying(false)
      }),
    []
  )

  if (!applyUpdate) return null

  return (
    <div className="mobile-pwa-update" data-testid="mobile-pwa-update-toast" role="status">
      <span>有新版本可用，重新加载后生效。</span>
      <button
        className="mobile-text-button"
        disabled={applying}
        onClick={() => {
          setApplying(true)
          applyUpdate()
        }}
        type="button"
      >
        {applying ? '正在刷新...' : '重新加载'}
      </button>
    </div>
  )
}

const MobileRelayPairing = ({
  entry,
}: {
  entry: Extract<MobileRelayEntry, { kind: 'pairing' }>
}) => {
  const [serverUrl, setServerUrl] = useState(entry.serverUrl ?? '')
  const [deviceId, setDeviceId] = useState(entry.deviceId ?? '')
  const [token, setToken] = useState(entry.token ?? '')
  const [accountUsername, setAccountUsername] = useState('')
  const [accountPassword, setAccountPassword] = useState('')
  const [accountDesktopId, setAccountDesktopId] = useState(entry.desktopId ?? '')
  const [adminPairingOpen, setAdminPairingOpen] = useState(false)
  const [adminToken, setAdminToken] = useState('')
  const [adminDesktopId, setAdminDesktopId] = useState(entry.desktopId ?? '')
  const [adminWorkspaceIdsText, setAdminWorkspaceIdsText] = useState(
    entry.workspaceIds?.join(', ') ?? ''
  )
  const [claimState, setClaimState] = useState<'idle' | 'saving'>('idle')
  const [claimError, setClaimError] = useState<string | null>(null)
  const [healthState, setHealthState] = useState<
    | { kind: 'checking' }
    | { kind: 'error'; message: string }
    | { health: RelayHealthSnapshot; kind: 'ready'; roundTripMs: number }
    | { kind: 'idle' }
  >({ kind: 'idle' })
  const claimRequestIdRef = useRef(0)
  const healthRequestIdRef = useRef(0)
  const trimmedToken = token.trim()
  const trimmedAccountUsername = accountUsername.trim()
  const trimmedAccountPassword = accountPassword.trim()
  const trimmedAdminToken = adminToken.trim()
  const trimmedServerUrl = serverUrl.trim()
  const normalizedServerUrl = normalizeRelayServerUrl(trimmedServerUrl)
  const trimmedDeviceId = deviceId.trim()
  const resolvedDeviceId = trimmedDeviceId || `mobile-${createBrowserId('relay-device')}`

  const checkRelayHealth = async () => {
    const requestId = healthRequestIdRef.current + 1
    healthRequestIdRef.current = requestId
    setHealthState({ kind: 'checking' })
    const startedAt = getHealthProbeTime()
    try {
      const health = await getRelayHealth({
        ...(normalizedServerUrl ? { serverUrl: normalizedServerUrl } : {}),
      })
      const roundTripMs = getHealthProbeTime() - startedAt
      if (healthRequestIdRef.current !== requestId) return
      setHealthState({ health, kind: 'ready', roundTripMs })
    } catch (error) {
      if (healthRequestIdRef.current !== requestId) return
      setHealthState({ kind: 'error', message: getRelayHealthErrorMessage(error) })
    }
  }

  const claimPairing = async ({
    desktopId,
    pairingToken,
    workspaceIds,
  }: {
    desktopId?: string | undefined
    pairingToken: string
    workspaceIds?: string[] | undefined
  }) => {
    if (!pairingToken.trim()) return
    const requestId = claimRequestIdRef.current + 1
    claimRequestIdRef.current = requestId
    setClaimState('saving')
    setClaimError(null)
    try {
      const claimed = await claimRelayPairingToken({
        ...(desktopId ? { desktopId } : {}),
        deviceKind: 'mobile',
        deviceId: resolvedDeviceId,
        ...(normalizedServerUrl ? { serverUrl: normalizedServerUrl } : {}),
        token: pairingToken.trim(),
        ...(workspaceIds ? { workspaceIds } : {}),
      })
      if (claimRequestIdRef.current !== requestId) return
      const claimedDesktopId = claimed.desktop_id ?? desktopId
      const saved = saveRelayPairing({
        ...(claimedDesktopId ? { desktopId: claimedDesktopId } : {}),
        deviceId: claimed.device_id,
        ...(normalizedServerUrl ? { serverUrl: normalizedServerUrl } : {}),
        token: claimed.token,
      })
      if (!saved) {
        setClaimError('浏览器无法保存配对信息。请允许网站存储数据后重新配对。')
        setClaimState('idle')
        return
      }
      window.location.href = buildRelayPairingHref({
        ...(claimedDesktopId ? { desktopId: claimedDesktopId } : {}),
        deviceId: claimed.device_id,
        ...(normalizedServerUrl ? { serverUrl: normalizedServerUrl } : {}),
        ...(workspaceIds ? { workspaceIds } : {}),
      })
    } catch (error) {
      if (claimRequestIdRef.current !== requestId) return
      setClaimError(getRelayPairingErrorMessage(error))
      setClaimState('idle')
    }
  }

  const claimEnteredPairingCode = async () => {
    await claimPairing({
      ...(entry.desktopId ? { desktopId: entry.desktopId } : {}),
      pairingToken: trimmedToken,
      ...(entry.workspaceIds ? { workspaceIds: entry.workspaceIds } : {}),
    })
  }

  const loginWithAccount = async () => {
    if (!trimmedAccountUsername || !trimmedAccountPassword) return
    const requestId = claimRequestIdRef.current + 1
    claimRequestIdRef.current = requestId
    setClaimState('saving')
    setClaimError(null)
    try {
      const workspaceIds = entry.workspaceIds
      const claimed = await loginRelayAccount({
        ...(accountDesktopId.trim() ? { desktopId: accountDesktopId.trim() } : {}),
        deviceId: resolvedDeviceId,
        password: trimmedAccountPassword,
        ...(normalizedServerUrl ? { serverUrl: normalizedServerUrl } : {}),
        username: trimmedAccountUsername,
        ...(workspaceIds ? { workspaceIds } : {}),
      })
      if (claimRequestIdRef.current !== requestId) return
      const saved = saveRelayPairing({
        desktopId: claimed.desktop_id,
        deviceId: claimed.device_id,
        ...(normalizedServerUrl ? { serverUrl: normalizedServerUrl } : {}),
        token: claimed.token,
      })
      if (!saved) {
        setClaimError('浏览器无法保存登录信息。请允许网站存储数据后重新登录。')
        setClaimState('idle')
        return
      }
      window.location.href = buildRelayPairingHref({
        desktopId: claimed.desktop_id,
        deviceId: claimed.device_id,
        ...(normalizedServerUrl ? { serverUrl: normalizedServerUrl } : {}),
        ...(claimed.workspace_ids ? { workspaceIds: claimed.workspace_ids } : {}),
      })
    } catch (error) {
      if (claimRequestIdRef.current !== requestId) return
      setClaimError(getRelayAccountLoginErrorMessage(error))
      setClaimState('idle')
    }
  }

  const createAndClaimAdminPairing = async () => {
    if (!trimmedAdminToken) return
    const requestId = claimRequestIdRef.current + 1
    claimRequestIdRef.current = requestId
    setClaimState('saving')
    setClaimError(null)
    try {
      const pairing = await createRelayPairingToken({
        adminToken: trimmedAdminToken,
        ...(normalizedServerUrl ? { serverUrl: normalizedServerUrl } : {}),
      })
      if (claimRequestIdRef.current !== requestId) return
      const targetDesktopId = adminDesktopId.trim()
      const workspaceIds = parseRelayWorkspaceIdsText(adminWorkspaceIdsText)
      await claimPairing({
        ...(targetDesktopId ? { desktopId: targetDesktopId } : {}),
        pairingToken: pairing.token,
        ...(workspaceIds.length > 0 ? { workspaceIds } : {}),
      })
    } catch (error) {
      if (claimRequestIdRef.current !== requestId) return
      setClaimError(getRelayDeviceAdminErrorMessage(error))
      setClaimState('idle')
    }
  }

  return (
    <main className="mobile-app">
      <div className="mobile-shell mobile-shell--centered">
        <section className="mobile-relay-entry" aria-labelledby="mobile-relay-pairing-title">
          <span className="mobile-brand__label">Yive Relay</span>
          <h1 id="mobile-relay-pairing-title">连接云端</h1>
          <p>输入账号密码登录。保存后，下次打开远程模式会直接连接，不需要再次配对。</p>
          {entry.desktopId ? (
            <p className="mobile-relay-entry__hint">配对后将直接进入电脑 {entry.desktopId}。</p>
          ) : null}
          <MobileInstallPrompt relayServerUrl={serverUrl} />
          <section
            className="mobile-relay-account-login"
            aria-labelledby="mobile-relay-account-title"
          >
            <div>
              <h2 className="mobile-section__title" id="mobile-relay-account-title">
                账号登录
              </h2>
              <p>登录后会自动把这台手机绑定到电脑，不需要手动填写 token。</p>
            </div>
            <label className="mobile-relay-field">
              <span>账号</span>
              <input
                autoCapitalize="off"
                autoComplete="username"
                onChange={(event) => {
                  setAccountUsername(event.currentTarget.value)
                  claimRequestIdRef.current += 1
                  setClaimError(null)
                  setClaimState('idle')
                }}
                placeholder="输入账号"
                spellCheck={false}
                type="text"
                value={accountUsername}
              />
            </label>
            <label className="mobile-relay-field">
              <span>密码</span>
              <input
                autoComplete="current-password"
                onChange={(event) => {
                  setAccountPassword(event.currentTarget.value)
                  claimRequestIdRef.current += 1
                  setClaimError(null)
                  setClaimState('idle')
                }}
                placeholder="输入密码"
                type="password"
                value={accountPassword}
              />
            </label>
            <button
              className="mobile-relay-primary"
              disabled={
                !trimmedAccountUsername || !trimmedAccountPassword || claimState === 'saving'
              }
              onClick={(event) => {
                event.preventDefault()
                void loginWithAccount()
              }}
              type="button"
            >
              {claimState === 'saving' ? '正在登录...' : '登录并进入电脑'}
            </button>
          </section>
          <details className="mobile-relay-advanced">
            <summary>高级连接设置</summary>
            <label className="mobile-relay-field">
              <span>Relay 地址</span>
              <input
                onChange={(event) => {
                  setServerUrl(event.target.value)
                  claimRequestIdRef.current += 1
                  setClaimError(null)
                  setClaimState('idle')
                  healthRequestIdRef.current += 1
                  setHealthState({ kind: 'idle' })
                }}
                placeholder="https://relay.example"
                type="url"
                value={serverUrl}
              />
            </label>
            <label className="mobile-relay-field">
              <span>目标电脑</span>
              <input
                autoCapitalize="off"
                autoComplete="off"
                onChange={(event) => {
                  setAccountDesktopId(event.currentTarget.value)
                  claimRequestIdRef.current += 1
                  setClaimError(null)
                  setClaimState('idle')
                }}
                placeholder="留空时使用账号绑定的电脑"
                spellCheck={false}
                type="text"
                value={accountDesktopId}
              />
            </label>
            <p>正常不用填写。服务器会根据当前入口和账号自动选择对应电脑。</p>
          </details>
          <div className="mobile-relay-health" aria-live="polite">
            <button
              className="mobile-text-button"
              disabled={healthState.kind === 'checking'}
              onClick={(event) => {
                event.preventDefault()
                void checkRelayHealth()
              }}
              type="button"
            >
              {healthState.kind === 'checking' ? '检查中...' : '检查 Relay'}
            </button>
            {healthState.kind === 'ready' ? (
              <>
                <span data-tone="ok">{formatRelayHealth(healthState.health)}</span>
                <span data-tone="ok">
                  本次检查耗时 {formatRelayRoundTrip(healthState.roundTripMs)}
                </span>
                {formatRelayProtocolWarning(healthState.health) ? (
                  <span data-tone="error" role="alert">
                    {formatRelayProtocolWarning(healthState.health)}
                  </span>
                ) : null}
                {formatRelayFeatureWarning(healthState.health) ? (
                  <span data-tone="error" role="alert">
                    {formatRelayFeatureWarning(healthState.health)}
                  </span>
                ) : null}
              </>
            ) : null}
            {healthState.kind === 'error' ? (
              <span data-tone="error" role="alert">
                {healthState.message}
              </span>
            ) : null}
          </div>
          <label className="mobile-relay-field">
            <span>配对码</span>
            <input
              autoComplete="one-time-code"
              onChange={(event) => {
                setToken(event.target.value)
                claimRequestIdRef.current += 1
                setClaimError(null)
                setClaimState('idle')
              }}
              placeholder="输入电脑端提供的配对码"
              type="text"
              value={token}
            />
          </label>
          <label className="mobile-relay-field">
            <span>手机设备名</span>
            <input
              onChange={(event) => {
                setDeviceId(event.target.value)
                claimRequestIdRef.current += 1
                setClaimError(null)
                setClaimState('idle')
              }}
              placeholder="可选"
              type="text"
              value={deviceId}
            />
          </label>
          <button
            disabled={!trimmedToken || claimState === 'saving'}
            className="mobile-relay-primary"
            onClick={(event) => {
              event.preventDefault()
              void claimEnteredPairingCode()
            }}
            type="button"
          >
            {claimState === 'saving' ? '正在配对...' : '查看在线电脑'}
          </button>
          <section
            className="mobile-relay-admin-bootstrap"
            aria-labelledby="mobile-relay-admin-bootstrap-title"
          >
            <button
              aria-expanded={adminPairingOpen}
              className="mobile-text-button"
              onClick={() => setAdminPairingOpen((open) => !open)}
              type="button"
            >
              {adminPairingOpen ? '收起管理员绑定' : '没有配对码？用管理员 token 绑定'}
            </button>
            {adminPairingOpen ? (
              <div className="mobile-relay-admin-bootstrap__body">
                <div>
                  <h2 className="mobile-section__title" id="mobile-relay-admin-bootstrap-title">
                    远程首次绑定
                  </h2>
                  <p>
                    电脑不在身边时，可以临时输入 Relay 管理员
                    token，手机会自动生成一次性配对码并换成长期手机 token。管理员 token 不会保存。
                  </p>
                </div>
                <label className="mobile-relay-field">
                  <span>管理员 token</span>
                  <input
                    autoCapitalize="off"
                    autoComplete="off"
                    onChange={(event) => {
                      setAdminToken(event.currentTarget.value)
                      claimRequestIdRef.current += 1
                      setClaimError(null)
                      setClaimState('idle')
                    }}
                    placeholder="只本次使用，不会保存"
                    spellCheck={false}
                    type="password"
                    value={adminToken}
                  />
                </label>
                <label className="mobile-relay-field">
                  <span>目标电脑</span>
                  <input
                    autoCapitalize="off"
                    autoComplete="off"
                    onChange={(event) => {
                      setAdminDesktopId(event.currentTarget.value)
                      claimRequestIdRef.current += 1
                      setClaimError(null)
                      setClaimState('idle')
                    }}
                    placeholder="例如 desktop-windows，可留空后选择"
                    spellCheck={false}
                    type="text"
                    value={adminDesktopId}
                  />
                </label>
                <label className="mobile-relay-field">
                  <span>授权工作区</span>
                  <input
                    autoCapitalize="off"
                    autoComplete="off"
                    onChange={(event) => {
                      setAdminWorkspaceIdsText(event.currentTarget.value)
                      claimRequestIdRef.current += 1
                      setClaimError(null)
                      setClaimState('idle')
                    }}
                    placeholder="可选，多个用逗号或空格分隔"
                    spellCheck={false}
                    type="text"
                    value={adminWorkspaceIdsText}
                  />
                </label>
                <button
                  className="mobile-relay-primary"
                  disabled={!trimmedAdminToken || claimState === 'saving'}
                  onClick={(event) => {
                    event.preventDefault()
                    void createAndClaimAdminPairing()
                  }}
                  type="button"
                >
                  {claimState === 'saving' ? '正在绑定...' : '绑定这台手机'}
                </button>
              </div>
            ) : null}
          </section>
          {claimError ? (
            <div className="mobile-empty" role="alert">
              {claimError}
            </div>
          ) : null}
        </section>
        <MobilePwaUpdateToast />
      </div>
    </main>
  )
}

const MobileRelayDevicePicker = ({
  entry,
}: {
  entry: Extract<MobileRelayEntry, { kind: 'picker' }>
}) => {
  const [devices, setDevices] = useState<RelayDesktopDevice[]>([])
  const [mobileDevices, setMobileDevices] = useState<RelayMobileDevice[]>([])
  const [forcePairing, setForcePairing] = useState(false)
  const [state, setState] = useState<'error' | 'loading' | 'ready'>(
    entry.storageUnavailable ? 'error' : 'loading'
  )
  const [message, setMessage] = useState<string | null>(
    entry.storageUnavailable
      ? '浏览器无法保存配对信息。请允许网站存储数据后重新打开配对链接。'
      : null
  )
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null)
  const [health, setHealth] = useState<RelayHealthSnapshot | null>(null)
  const [healthRoundTripMs, setHealthRoundTripMs] = useState<number | null>(null)
  const [errorAction, setErrorAction] = useState<'pairing' | 'retry'>(
    entry.storageUnavailable ? 'pairing' : 'retry'
  )
  const [retryKey, setRetryKey] = useState(0)
  const [deviceAdmin, setDeviceAdmin] = useState<RelayDeviceAdminState>({ kind: 'closed' })
  const [deviceAdminToken, setDeviceAdminToken] = useState('')
  const [pairingLink, setPairingLink] = useState<RelayPairingLinkState>({ kind: 'idle' })
  const [pairingLinkDesktopId, setPairingLinkDesktopId] = useState('')
  const [pairingLinkWorkspaceIdsText, setPairingLinkWorkspaceIdsText] = useState('')
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null)

  useEffect(() => {
    void retryKey
    if (forcePairing || entry.storageUnavailable) return
    let cancelled = false
    let timer: number | undefined
    let hasLoadedDevices = false
    const loadDevices = (showLoading: boolean) => {
      if (showLoading) setState('loading')
      if (showLoading) {
        setMessage(null)
        setRefreshMessage(null)
      }
      void listRelayDevices({ serverUrl: entry.serverUrl, token: entry.token })
        .then((snapshot) => {
          if (cancelled) return
          hasLoadedDevices = true
          setDevices(snapshot.desktops)
          setMobileDevices(snapshot.mobiles)
          setState('ready')
          setRefreshMessage(null)
          timer = window.setTimeout(() => loadDevices(false), REFRESH_INTERVAL_MS)
        })
        .catch((error: unknown) => {
          if (cancelled) return
          if (hasLoadedDevices && !showLoading) {
            setRefreshMessage(getRelayDevicePickerErrorMessage(error))
            setState('ready')
            timer = window.setTimeout(() => loadDevices(false), REFRESH_INTERVAL_MS)
            return
          }
          setMessage(getRelayDevicePickerErrorMessage(error))
          setErrorAction(getRelayDevicePickerErrorAction(error))
          setState('error')
        })
    }
    loadDevices(true)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [entry.serverUrl, entry.storageUnavailable, entry.token, forcePairing, retryKey])

  useEffect(() => {
    void retryKey
    if (forcePairing || entry.storageUnavailable) return
    let cancelled = false
    let timer: number | undefined
    const loadHealth = () => {
      const startedAt = getHealthProbeTime()
      void getRelayHealth({
        ...(entry.serverUrl ? { serverUrl: entry.serverUrl } : {}),
      })
        .then((snapshot) => {
          if (cancelled) return
          setHealth(snapshot)
          setHealthRoundTripMs(getHealthProbeTime() - startedAt)
        })
        .catch(() => {
          if (cancelled) return
          setHealth(null)
          setHealthRoundTripMs(null)
        })
        .finally(() => {
          if (!cancelled) timer = window.setTimeout(loadHealth, 10_000)
        })
    }
    loadHealth()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [entry.serverUrl, entry.storageUnavailable, forcePairing, retryKey])

  const resetPairing = () => {
    clearRelayPairing()
    setDevices([])
    setMobileDevices([])
    setMessage(null)
    setRefreshMessage(null)
    setHealth(null)
    setHealthRoundTripMs(null)
    setForcePairing(true)
  }

  const retryLoadingDevices = () => {
    setDevices([])
    setMobileDevices([])
    setMessage(null)
    setRefreshMessage(null)
    setHealth(null)
    setHealthRoundTripMs(null)
    setRetryKey((current) => current + 1)
  }
  const getDeviceAdminToken = () => deviceAdminToken.trim() || entry.token
  const loadPairedDevices = async () => {
    setDeviceAdmin({ kind: 'loading' })
    try {
      const result = await listRelayPairedDevices({
        adminToken: getDeviceAdminToken(),
        ...(entry.serverUrl ? { serverUrl: entry.serverUrl } : {}),
      })
      setDeviceAdmin({ devices: result.devices, kind: 'ready' })
    } catch (error) {
      setDeviceAdmin({ kind: 'error', message: getRelayDeviceAdminErrorMessage(error) })
    }
  }
  const toggleDeviceAdmin = () => {
    if (deviceAdmin.kind === 'closed') {
      setPairingLink({ kind: 'idle' })
      void loadPairedDevices()
      return
    }
    setDeviceAdmin({ kind: 'closed' })
    setPairingLink({ kind: 'idle' })
  }
  const createPairingLink = async () => {
    setPairingLink({ kind: 'creating' })
    try {
      const result = await createRelayPairingToken({
        adminToken: getDeviceAdminToken(),
        ...(entry.serverUrl ? { serverUrl: entry.serverUrl } : {}),
      })
      const targetDesktopId = pairingLinkDesktopId.trim()
      const workspaceIds = parseRelayWorkspaceIdsText(pairingLinkWorkspaceIdsText)
      setPairingLink({
        ...(typeof result.expires_at === 'number' ? { expiresAt: result.expires_at } : {}),
        href: buildRelayPairingHref({
          absolute: true,
          ...(targetDesktopId ? { claimShortToken: true, desktopId: targetDesktopId } : {}),
          serverUrl: entry.serverUrl,
          token: result.token,
          ...(workspaceIds.length > 0 ? { workspaceIds } : {}),
        }),
        kind: 'ready',
        ...(typeof result.ttl_ms === 'number' ? { ttlMs: result.ttl_ms } : {}),
      })
    } catch (error) {
      setPairingLink({ kind: 'error', message: getRelayDeviceAdminErrorMessage(error) })
    }
  }
  const copyPairingLink = async () => {
    if (pairingLink.kind !== 'ready') return
    const href = pairingLink.href
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable')
      await navigator.clipboard.writeText(href)
      setPairingLink((current) =>
        current.kind === 'ready' && current.href === href
          ? { ...current, copyMessage: '已复制配对链接' }
          : current
      )
    } catch {
      setPairingLink((current) =>
        current.kind === 'ready' && current.href === href
          ? { ...current, copyMessage: '复制失败，请长按链接手动复制' }
          : current
      )
    }
  }
  const sharePairingLink = async () => {
    if (pairingLink.kind !== 'ready') return
    const href = pairingLink.href
    try {
      if (!navigator.share) throw new Error('Web Share API is unavailable')
      await navigator.share({
        text: '用这个短期链接把手机配对到 Yive Relay。',
        title: 'Yive 手机配对链接',
        url: href,
      })
      setPairingLink((current) =>
        current.kind === 'ready' && current.href === href
          ? { ...current, shareMessage: '已打开系统分享' }
          : current
      )
    } catch (error) {
      const cancelled =
        error instanceof DOMException &&
        (error.name === 'AbortError' || error.name === 'NotAllowedError')
      if (cancelled) return
      setPairingLink((current) =>
        current.kind === 'ready' && current.href === href
          ? { ...current, shareMessage: '分享失败，请复制链接发送' }
          : current
      )
    }
  }
  const revokePairedDevice = async (deviceId: string) => {
    setRevokingDeviceId(deviceId)
    try {
      await revokeRelayPairedDevice({
        adminToken: getDeviceAdminToken(),
        deviceId,
        ...(entry.serverUrl ? { serverUrl: entry.serverUrl } : {}),
      })
      if (deviceId === entry.deviceId) {
        resetPairing()
        return
      }
      const result = await listRelayPairedDevices({
        adminToken: getDeviceAdminToken(),
        ...(entry.serverUrl ? { serverUrl: entry.serverUrl } : {}),
      })
      setDeviceAdmin({
        devices: result.devices,
        kind: 'ready',
        message: `已撤销 ${deviceId}。`,
      })
    } catch (error) {
      setDeviceAdmin({ kind: 'error', message: getRelayDeviceAdminErrorMessage(error) })
    } finally {
      setRevokingDeviceId(null)
    }
  }
  const diagnostics = buildRelayPickerDiagnostics({
    devices,
    health,
    healthRoundTripMs,
    message,
    serverUrl: entry.serverUrl,
    state,
  })

  if (forcePairing) {
    return (
      <MobileRelayPairing
        entry={{
          ...(entry.deviceId ? { deviceId: entry.deviceId } : {}),
          kind: 'pairing',
          ...(entry.serverUrl ? { serverUrl: entry.serverUrl } : {}),
        }}
      />
    )
  }

  return (
    <main className="mobile-app">
      <div className="mobile-shell mobile-shell--centered">
        <section className="mobile-relay-entry" aria-labelledby="mobile-relay-title">
          <span className="mobile-brand__label">Yive Relay</span>
          <h1 id="mobile-relay-title">选择电脑</h1>
          <p>选择一台在线电脑后，手机会通过云端 Relay 连接它的本地 yive。</p>
          <MobileRelayReconnectHint
            desktopId={entry.desktopId}
            deviceId={entry.deviceId}
            onSwitchAccount={resetPairing}
            serverUrl={entry.serverUrl}
          />
          <MobileInstallPrompt relayServerUrl={entry.serverUrl} />
          {health ? (
            <div className="mobile-relay-health" aria-live="polite">
              <span data-tone="ok">{formatRelayHealth(health)}</span>
              {typeof healthRoundTripMs === 'number' ? (
                <span data-tone="ok">最近检查耗时 {formatRelayRoundTrip(healthRoundTripMs)}</span>
              ) : null}
              {formatRelayProtocolWarning(health) ? (
                <span data-tone="error">{formatRelayProtocolWarning(health)}</span>
              ) : null}
            </div>
          ) : null}
          <MobileRelayDiagnostics lines={diagnostics} />
          {state === 'loading' ? <div className="mobile-empty">正在加载在线电脑...</div> : null}
          {state === 'error' ? (
            <div className="mobile-empty" role="alert">
              {message}
              <button
                className="mobile-text-button"
                onClick={errorAction === 'pairing' ? resetPairing : retryLoadingDevices}
                type="button"
              >
                {errorAction === 'pairing' ? '重新配对' : '重试'}
              </button>
            </div>
          ) : null}
          {state === 'ready' && devices.length === 0 ? (
            <>
              <div className="mobile-empty">暂无在线电脑。请先在电脑端执行 yive connect。</div>
              <MobileRelayDesktopConnectGuide
                context={{
                  ...(entry.serverUrl ? { serverUrl: entry.serverUrl } : {}),
                }}
              />
            </>
          ) : null}
          {state === 'ready' && refreshMessage ? (
            <div className="mobile-relay-refresh-message" role="status">
              {refreshMessage}
            </div>
          ) : null}
          {devices.length > 0 ? (
            <div className="mobile-relay-device-list">
              {devices.map((desktop) => {
                const runtimeMeta = getRelayDesktopRuntimeMeta(desktop)
                const connectionMeta = getRelayDesktopConnectionMeta(desktop)
                const mobileMeta = getRelayDesktopMobileMeta(desktop, mobileDevices)
                const content = (
                  <>
                    <span>
                      {desktop.device_id}
                      <small>{getRelayDesktopRuntimeLabel(desktop)}</small>
                      {runtimeMeta ? (
                        <small data-stale={runtimeMeta.includes('过期')}>{runtimeMeta}</small>
                      ) : null}
                      {connectionMeta.map((line) => (
                        <small data-stale={line.stale} key={line.label}>
                          {line.label}
                        </small>
                      ))}
                      {mobileMeta ? <small>{mobileMeta}</small> : null}
                    </span>
                    <span>{desktop.runtime_status === 'offline' ? '等待本地 yive' : '连接'}</span>
                  </>
                )
                return desktop.runtime_status === 'offline' ? (
                  <div
                    aria-disabled="true"
                    className="mobile-relay-device mobile-relay-device--disabled"
                    key={desktop.device_id}
                  >
                    {content}
                  </div>
                ) : (
                  <a
                    className="mobile-relay-device"
                    href={buildRelayDesktopHref(entry, desktop)}
                    key={desktop.device_id}
                    onClick={() => rememberRelayDesktopSelection(entry, desktop.device_id)}
                  >
                    {content}
                  </a>
                )
              })}
            </div>
          ) : null}
          {state === 'ready' ? (
            <div className="mobile-relay-actions">
              <button className="mobile-text-button" onClick={retryLoadingDevices} type="button">
                刷新
              </button>
              <button className="mobile-text-button" onClick={resetPairing} type="button">
                退出登录
              </button>
              <button className="mobile-text-button" onClick={toggleDeviceAdmin} type="button">
                {deviceAdmin.kind === 'closed' ? '管理设备' : '收起设备'}
              </button>
            </div>
          ) : null}
          {deviceAdmin.kind !== 'closed' ? (
            <MobileRelayDeviceAdmin
              adminToken={deviceAdminToken}
              currentDeviceId={entry.deviceId}
              desktops={devices}
              onlineMobiles={mobileDevices}
              onAdminTokenChange={setDeviceAdminToken}
              onCreatePairingLink={() => void createPairingLink()}
              onCopyPairingLink={() => void copyPairingLink()}
              onPairingLinkDesktopIdChange={(value) => {
                setPairingLinkDesktopId(value)
                setPairingLink({ kind: 'idle' })
              }}
              onPairingLinkWorkspaceIdsTextChange={(value) => {
                setPairingLinkWorkspaceIdsText(value)
                setPairingLink({ kind: 'idle' })
              }}
              onRefresh={() => void loadPairedDevices()}
              onRevoke={(deviceId) => void revokePairedDevice(deviceId)}
              onSharePairingLink={
                typeof navigator.share === 'function' ? () => void sharePairingLink() : undefined
              }
              pairingLinkDesktopId={pairingLinkDesktopId}
              pairingLinkWorkspaceIdsText={pairingLinkWorkspaceIdsText}
              pairingLink={pairingLink}
              revokingDeviceId={revokingDeviceId}
              state={deviceAdmin}
            />
          ) : null}
        </section>
        <MobilePwaUpdateToast />
      </div>
    </main>
  )
}

const MobileRelayDeviceAdmin = ({
  adminToken,
  currentDeviceId,
  desktops,
  onlineMobiles,
  onAdminTokenChange,
  onCreatePairingLink,
  onCopyPairingLink,
  onPairingLinkDesktopIdChange,
  onPairingLinkWorkspaceIdsTextChange,
  onRefresh,
  onRevoke,
  onSharePairingLink,
  pairingLinkDesktopId,
  pairingLinkWorkspaceIdsText,
  pairingLink,
  revokingDeviceId,
  state,
}: {
  adminToken: string
  currentDeviceId?: string
  desktops: RelayDesktopDevice[]
  onlineMobiles: RelayMobileDevice[]
  onAdminTokenChange: (value: string) => void
  onCreatePairingLink: () => void
  onCopyPairingLink: () => void
  onPairingLinkDesktopIdChange: (value: string) => void
  onPairingLinkWorkspaceIdsTextChange: (value: string) => void
  onRefresh: () => void
  onRevoke: (deviceId: string) => void
  onSharePairingLink?: (() => void) | undefined
  pairingLinkDesktopId: string
  pairingLinkWorkspaceIdsText: string
  pairingLink: RelayPairingLinkState
  revokingDeviceId: string | null
  state: RelayDeviceAdminState
}) => {
  const [pendingRevokeDeviceId, setPendingRevokeDeviceId] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    if (
      pairingLink.kind !== 'ready' ||
      typeof pairingLink.expiresAt !== 'number' ||
      pairingLink.expiresAt <= 0
    ) {
      return
    }
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pairingLink])

  const pairingLinkExpired =
    pairingLink.kind === 'ready' ? isRelayPairingLinkExpired(pairingLink, now) : false
  const pairingLinkExpiryLabel =
    pairingLink.kind === 'ready' ? formatRelayPairingLinkExpiry(pairingLink, now) : null

  return (
    <section
      className="mobile-relay-device-admin"
      aria-labelledby="mobile-relay-device-admin-title"
    >
      <div className="mobile-section-heading">
        <div>
          <h2 className="mobile-section__title" id="mobile-relay-device-admin-title">
            已配对手机
          </h2>
          <p className="mobile-section__description">
            使用 Relay 管理员 token 可以查看和撤销已配对的手机。
          </p>
        </div>
        <button
          className="mobile-text-button"
          disabled={state.kind === 'loading' || Boolean(revokingDeviceId)}
          onClick={onRefresh}
          type="button"
        >
          刷新
        </button>
      </div>
      <label className="mobile-relay-admin-token">
        <span>管理员 token</span>
        <input
          autoCapitalize="off"
          autoComplete="off"
          onChange={(event) => onAdminTokenChange(event.currentTarget.value)}
          placeholder="留空时尝试使用当前 token"
          spellCheck={false}
          type="password"
          value={adminToken}
        />
      </label>
      <p className="mobile-relay-admin-note">
        管理员 token 仅在当前页面临时使用，不会保存，也不会替换手机配对 token。
      </p>
      <div className="mobile-relay-pairing-link">
        <div>
          <strong>邀请新手机</strong>
          <small>生成短期配对链接，可发给朋友测试；链接不包含管理员 token。</small>
        </div>
        <button
          className="mobile-text-button"
          disabled={pairingLink.kind === 'creating'}
          onClick={onCreatePairingLink}
          type="button"
        >
          {pairingLink.kind === 'creating' ? '生成中...' : '生成配对链接'}
        </button>
      </div>
      <label className="mobile-relay-admin-token">
        <span>目标电脑</span>
        <select
          onChange={(event) => onPairingLinkDesktopIdChange(event.currentTarget.value)}
          value={pairingLinkDesktopId}
        >
          <option value="">让手机自己选择</option>
          {desktops.map((desktop) => (
            <option disabled={desktop.runtime_status === 'offline'} key={desktop.device_id}>
              {desktop.device_id}
            </option>
          ))}
        </select>
      </label>
      <label className="mobile-relay-admin-token">
        <span>授权工作区</span>
        <input
          autoCapitalize="off"
          autoComplete="off"
          onChange={(event) => onPairingLinkWorkspaceIdsTextChange(event.currentTarget.value)}
          placeholder="留空表示全部，多个用逗号分隔"
          spellCheck={false}
          type="text"
          value={pairingLinkWorkspaceIdsText}
        />
      </label>
      {pairingLink.kind === 'ready' ? (
        <div className="mobile-relay-generated-link">
          <label>
            <span>配对链接</span>
            <input readOnly value={pairingLink.href} />
          </label>
          {pairingLinkExpiryLabel ? <small>{pairingLinkExpiryLabel}</small> : null}
          <button
            className="mobile-text-button"
            disabled={pairingLinkExpired}
            onClick={onCopyPairingLink}
            type="button"
          >
            复制链接
          </button>
          {onSharePairingLink ? (
            <button
              className="mobile-text-button"
              disabled={pairingLinkExpired}
              onClick={onSharePairingLink}
              type="button"
            >
              分享链接
            </button>
          ) : null}
          {pairingLink.copyMessage ? <small role="status">{pairingLink.copyMessage}</small> : null}
          {pairingLink.shareMessage ? (
            <small role="status">{pairingLink.shareMessage}</small>
          ) : null}
        </div>
      ) : null}
      {pairingLink.kind === 'error' ? (
        <div className="mobile-relay-refresh-message" role="alert">
          {pairingLink.message}
        </div>
      ) : null}
      {state.kind === 'loading' ? <div className="mobile-empty">正在加载已配对手机...</div> : null}
      {state.kind === 'error' ? (
        <div className="mobile-relay-refresh-message" role="alert">
          {state.message}
        </div>
      ) : null}
      {state.kind === 'ready' && state.message ? (
        <div className="mobile-relay-refresh-message" role="status">
          {state.message}
        </div>
      ) : null}
      {state.kind === 'ready' && state.devices.length === 0 ? (
        <div className="mobile-empty">暂无已配对手机。</div>
      ) : null}
      {state.kind === 'ready' && state.devices.length > 0 ? (
        <div className="mobile-relay-paired-list">
          {state.devices.map((device) => {
            const isCurrent = Boolean(currentDeviceId && currentDeviceId === device.device_id)
            const isPendingRevoke = pendingRevokeDeviceId === device.device_id
            const onlineMobile = onlineMobiles.find(
              (mobile) => mobile.device_id === device.device_id
            )
            return (
              <article
                className="mobile-relay-paired-device"
                data-confirming={isPendingRevoke}
                key={device.device_id}
              >
                <div>
                  <strong>
                    {device.device_id}
                    {isCurrent ? <span>当前手机</span> : null}
                  </strong>
                  <small>token {device.token_hint}</small>
                  {device.desktop_id ? <small>绑定电脑 {device.desktop_id}</small> : null}
                  <small>
                    工作区{' '}
                    {device.workspace_ids && device.workspace_ids.length > 0
                      ? device.workspace_ids.join(', ')
                      : '全部'}
                  </small>
                  <small data-online={onlineMobile ? 'true' : 'false'}>
                    {onlineMobile ? `在线 · 连接 ${onlineMobile.desktop_id}` : '离线'}
                  </small>
                  {isPendingRevoke ? <small data-danger="true">再次点击确认撤销</small> : null}
                </div>
                <button
                  className="mobile-text-button mobile-text-button--danger"
                  disabled={Boolean(revokingDeviceId)}
                  onClick={() => {
                    if (isPendingRevoke) {
                      setPendingRevokeDeviceId(null)
                      onRevoke(device.device_id)
                      return
                    }
                    setPendingRevokeDeviceId(device.device_id)
                  }}
                  type="button"
                >
                  {revokingDeviceId === device.device_id
                    ? '撤销中...'
                    : isPendingRevoke
                      ? '确认撤销'
                      : '撤销'}
                </button>
              </article>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

const MobileRuntimeApp = () => {
  const runtimeSession = useMemo(() => createMobileRuntimeSession(), [])
  const initialAgentDeepLink = useMemo(readMobileAgentDeepLink, [])
  const [lastConnectionSnapshot, setLastConnectionSnapshot] =
    useState<MobileLastConnectionSnapshot | null>(readMobileLastConnectionSnapshot)
  const [workspaceState, setWorkspaceState] = useState<WorkspaceLoadState>({ kind: 'loading' })
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = useState(false)
  const [dashboardState, setDashboardState] = useState<WorkspaceDashboardState>({ kind: 'idle' })
  const [dispatchesState, setDispatchesState] = useState<MobileDispatchesState>({ kind: 'idle' })
  const [activeTab, setActiveTab] = useState<MobileTab>(readInitialMobileTab)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    initialAgentDeepLink?.agentId ?? null
  )
  const [agentActionMessage, setAgentActionMessage] = useState<string | null>(null)
  const [pendingAgentAction, setPendingAgentAction] = useState<MobileAgentAction | null>(null)
  const [dangerAction, setDangerAction] = useState<
    'checkpoint' | 'force' | 'restart' | 'stop' | null
  >(null)
  const [dispatchActionState, setDispatchActionState] = useState<MobileDispatchActionState>({
    busy: false,
    dispatchId: null,
    message: null,
    mode: null,
  })
  const pendingDispatchNoteRef = useRef<{
    actionId: string
    dispatchId: string
    text: string
  } | null>(null)
  const pendingDispatchReplaceRef = useRef<{
    actionId: string
    dispatchId: string
    interrupt: boolean
    text: string
  } | null>(null)
  const [fileItems, setFileItems] = useState<MobileFileExchangeItem[]>([])
  const [fileBusyLabel, setFileBusyLabel] = useState<string | null>(null)
  const [fileMessage, setFileMessage] = useState<string | null>(null)
  const [fileDownloadLink, setFileDownloadLink] = useState<{ href: string; name: string } | null>(
    null
  )
  const [fileDownloadRetry, setFileDownloadRetry] = useState<{ id: string; name: string } | null>(
    null
  )
  const [fileDownloadProgress, setFileDownloadProgress] =
    useState<MobileFileDownloadProgressState | null>(null)
  const [agentNotifications, setAgentNotifications] = useState<MobileAgentNotification[]>([])
  const [workspaceFilePath, setWorkspaceFilePath] = useState('')
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null)
  const [staleTerminalRunId, setStaleTerminalRunId] = useState<string | null>(null)
  const [connectionRetryKey, setConnectionRetryKey] = useState(0)
  const [relayDiagnosticsOpen, setRelayDiagnosticsOpen] = useState(false)
  const [relayDiagnosticsRequestKey, setRelayDiagnosticsRequestKey] = useState(0)
  const [relayRuntimeDeviceRefreshKey, setRelayRuntimeDeviceRefreshKey] = useState(0)
  const [relayRuntimeDiagnostics, setRelayRuntimeDiagnostics] =
    useState<RelayRuntimeDiagnosticsState>({ kind: 'idle' })
  const [relayRuntimeDeviceState, setRelayRuntimeDeviceState] = useState<RelayRuntimeDeviceState>({
    kind: 'idle',
  })
  const [relayForegroundRefresh, setRelayForegroundRefresh] = useState<RelayForegroundRefreshState>(
    { kind: 'idle' }
  )
  const [relayEventsStatus, setRelayEventsStatus] = useState<RelayEventsStatus>({ kind: 'idle' })
  const [relayEventsNow, setRelayEventsNow] = useState(Date.now)
  const [browserOnline, setBrowserOnline] = useState(getBrowserOnlineStatus)
  const pendingBrowserOnlineRetryRef = useRef(false)
  const [notificationState, setNotificationState] = useState<MobileNotificationState>(
    getMobileNotificationState
  )
  const [notificationRequesting, setNotificationRequesting] = useState(false)
  const activeWorkspaceIdRef = useRef<string | null>(null)
  const selectedAgentIdRef = useRef<string | null>(null)
  const notificationSnapshotRef = useRef<{
    crashed: number
    pending: number
    stopped: number
    busy: number
  } | null>(null)
  const connectionNotificationRef = useRef<{
    notifiedError: boolean
    wasReady: boolean
  }>({ notifiedError: false, wasReady: false })
  const seenAgentNotificationIdsRef = useRef<Set<string>>(new Set())
  const dashboardStateRef = useRef(dashboardState)

  useEffect(() => {
    dashboardStateRef.current = dashboardState
  }, [dashboardState])

  const getChatAgentName = useCallback((agentId: string) => {
    const dashboard = dashboardStateRef.current
    if (dashboard.kind !== 'ready') return 'Yive Agent'
    return (
      (dashboard.orchestrator?.id === agentId ? dashboard.orchestrator.name : undefined) ??
      dashboard.workers.find((candidate) => candidate.id === agentId)?.name ??
      'Yive Agent'
    )
  }, [])
  const openChatConversation = useCallback(
    (invalidation: import('../../../src/shared/types.js').MobileConversationInvalidation) => {
      setActiveWorkspaceId(invalidation.workspace_id)
      saveActiveWorkspaceId(invalidation.workspace_id)
      setActiveTab('agents')
      setSelectedAgentId(invalidation.agent_id)
      applyMobileChatDeepLink(invalidation)
    },
    []
  )
  const { handleConversationInvalidated, unreadIndex: chatUnreadIndex } =
    useMobileChatCompletionNotifications({
      getAgentName: getChatAgentName,
      onOpenConversation: openChatConversation,
      runtimeClient: runtimeSession.client,
    })

  useEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceId
  }, [activeWorkspaceId])

  useEffect(() => {
    selectedAgentIdRef.current = selectedAgentId
  }, [selectedAgentId])

  useEffect(() => {
    if (runtimeSession.mode !== 'relay') return
    setRelayEventsNow(Date.now())
    const timer = window.setInterval(() => setRelayEventsNow(Date.now()), REFRESH_INTERVAL_MS * 5)
    return () => window.clearInterval(timer)
  }, [runtimeSession.mode])

  const applyMobileEventsSnapshot = useCallback(
    (snapshot: MobileSnapshot) => {
      setWorkspaceState({ kind: 'ready', workspaces: snapshot.workspaces })
      setAgentNotifications(snapshot.notifications ?? [])
      setActiveWorkspaceId((current) => {
        if (current && snapshot.workspaces.some((workspace) => workspace.id === current)) {
          return current
        }
        if (
          initialAgentDeepLink &&
          snapshot.workspaces.some((workspace) => workspace.id === initialAgentDeepLink.workspaceId)
        ) {
          return initialAgentDeepLink.workspaceId
        }
        return snapshot.active_workspace_id ?? snapshot.workspaces[0]?.id ?? null
      })
      const dashboard = getMobileSnapshotDashboard(snapshot)
      const snapshotWorkspaceId = snapshot.active_workspace?.workspace.id
      const currentWorkspaceId = activeWorkspaceIdRef.current
      if (dashboard && (!currentWorkspaceId || snapshotWorkspaceId === currentWorkspaceId)) {
        setDashboardState({ kind: 'ready', ...dashboard })
        setStaleTerminalRunId((runId) =>
          runId && dashboard.runs.some((run) => run.run_id === runId && run.status !== 'stopped')
            ? null
            : runId
        )
      }
      setLastRefreshAt(snapshot.generated_at)
      setRelayEventsStatus({ kind: 'connected', updatedAt: snapshot.generated_at })
    },
    [initialAgentDeepLink]
  )

  useEffect(() => {
    let cancelled = false
    void connectionRetryKey

    const load = async () => {
      setWorkspaceState({ kind: 'loading' })
      setDashboardState({ kind: 'idle' })
      try {
        await runtimeSession.connect()
        const [workspaces, savedActiveWorkspaceId] = await Promise.all([
          runtimeSession.client.listWorkspaces(),
          runtimeSession.mode === 'local'
            ? getActiveWorkspaceId().catch(() => null)
            : runtimeSession.mode === 'relay'
              ? readStoredRelayWorkspaceId(runtimeSession.relayDiagnostics.desktopId)
              : null,
        ])
        if (cancelled) return
        setWorkspaceState({ kind: 'ready', workspaces })
        const savedWorkspaceExists = workspaces.some(
          (workspace) => workspace.id === savedActiveWorkspaceId
        )
        const deepLinkWorkspaceExists = workspaces.some(
          (workspace) => workspace.id === initialAgentDeepLink?.workspaceId
        )
        setActiveWorkspaceId(
          (current) =>
            current ??
            (deepLinkWorkspaceExists ? initialAgentDeepLink?.workspaceId : null) ??
            (savedWorkspaceExists ? savedActiveWorkspaceId : null) ??
            workspaces[0]?.id ??
            null
        )
        setLastRefreshAt(Date.now())
      } catch (error) {
        if (!cancelled) {
          setWorkspaceState({
            kind: 'error',
            message: getLoadErrorMessage(error, '加载移动端工作区失败'),
          })
        }
      }
    }

    void load()
    return () => {
      cancelled = true
      runtimeSession.close?.()
    }
  }, [connectionRetryKey, initialAgentDeepLink, runtimeSession])

  useEffect(() => {
    if (!activeWorkspaceId) {
      setDashboardState({ kind: 'idle' })
      return
    }
    let cancelled = false
    let inFlight = false
    let timer: number | undefined

    const loadDashboard = () => {
      if (inFlight) return
      inFlight = true
      setDashboardState((current) => (current.kind === 'ready' ? current : { kind: 'loading' }))

      void runtimeSession.client
        .listDashboard(activeWorkspaceId)
        .then(({ orchestrator, workers, runs }) => {
          if (!cancelled) {
            setDashboardState((current) => ({
              kind: 'ready',
              ...(orchestrator
                ? { orchestrator }
                : current.kind === 'ready' && current.orchestrator
                  ? { orchestrator: current.orchestrator }
                  : {}),
              workers,
              runs,
            }))
            setStaleTerminalRunId((runId) =>
              runId && runs.some((run) => run.run_id === runId && run.status !== 'stopped')
                ? null
                : runId
            )
            setLastRefreshAt(Date.now())
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            const message = getLoadErrorMessage(error, '加载工作区 Agent 失败')
            setDashboardState((current) =>
              current.kind === 'ready'
                ? { ...current, staleAt: Date.now(), staleMessage: message }
                : { kind: 'error', message }
            )
          }
        })
        .finally(() => {
          inFlight = false
          if (!cancelled) {
            const refreshDelay = selectedAgentIdRef.current
              ? AGENT_DETAIL_DASHBOARD_REFRESH_INTERVAL_MS
              : REFRESH_INTERVAL_MS
            timer = window.setTimeout(loadDashboard, refreshDelay)
          }
        })
    }

    loadDashboard()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [activeWorkspaceId, runtimeSession])

  const shouldPreloadTerminalAssets =
    dashboardState.kind === 'ready' &&
    (dashboardState.runs.length > 0 || dashboardState.workers.length > 0)

  useEffect(() => {
    if (!shouldPreloadTerminalAssets) return
    void preloadTerminalAssets().catch(() => {
      // The terminal detail view will surface load failures if the user opens it.
    })
  }, [shouldPreloadTerminalAssets])

  useEffect(() => {
    if (runtimeSession.mode !== 'local') return

    const client = createMobileEventsClient({
      onConversationInvalidated: (invalidation) => void handleConversationInvalidated(invalidation),
      onReconnect: ({ attempt, nextDelayMs }) => {
        setRelayEventsStatus({
          attempt,
          kind: 'reconnecting',
          message: '本地事件流已断开',
          nextDelayMs,
          updatedAt: Date.now(),
        })
      },
      onSnapshot: applyMobileEventsSnapshot,
    })

    client.connect()
    return () => client.dispose()
  }, [applyMobileEventsSnapshot, handleConversationInvalidated, runtimeSession.mode])

  useEffect(() => {
    if (runtimeSession.mode !== 'relay' || !runtimeSession.client.subscribeMobileEvents) return

    const subscription = runtimeSession.client.subscribeMobileEvents({
      onConversationInvalidated: (invalidation) => void handleConversationInvalidated(invalidation),
      onClose: (message, meta) => {
        setRelayEventsStatus({
          ...(meta ? { attempt: meta.attempt, nextDelayMs: meta.nextDelayMs } : {}),
          kind: 'reconnecting',
          message,
          updatedAt: Date.now(),
        })
      },
      onError: (error) => {
        setRelayEventsStatus({
          kind: 'error',
          message: getLoadErrorMessage(error, 'Relay 事件流异常'),
          updatedAt: Date.now(),
        })
      },
      onHeartbeat: (generatedAt) => {
        setRelayEventsStatus({ kind: 'connected', updatedAt: generatedAt })
      },
      onSnapshot: applyMobileEventsSnapshot,
    })
    return () => subscription.dispose()
  }, [applyMobileEventsSnapshot, handleConversationInvalidated, runtimeSession])

  useEffect(() => {
    if (dashboardState.kind !== 'ready' || activeTab !== 'files') return
    let cancelled = false
    void runtimeSession.client
      .listFiles()
      .then((items) => {
        if (!cancelled) setFileItems(items)
      })
      .catch((error: unknown) => {
        if (!cancelled) setFileMessage(getLoadErrorMessage(error, '加载文件失败'))
      })
    return () => {
      cancelled = true
    }
  }, [activeTab, dashboardState.kind, runtimeSession.client])

  useEffect(() => {
    if (!activeWorkspaceId || activeTab !== 'dispatches') {
      setDispatchesState({ kind: 'idle' })
      return
    }
    let cancelled = false
    setDispatchesState((current) => (current.kind === 'ready' ? current : { kind: 'loading' }))
    void runtimeSession.client
      .listDispatches(activeWorkspaceId)
      .then((dispatches) => {
        if (!cancelled) setDispatchesState({ dispatches, kind: 'ready' })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDispatchesState({
            kind: 'error',
            message: getLoadErrorMessage(error, '加载派单失败'),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, activeTab, runtimeSession.client])

  useEffect(() => {
    if (runtimeSession.mode !== 'relay') {
      setRelayRuntimeDeviceState({ kind: 'idle' })
      return
    }

    let cancelled = false
    let timer: number | undefined
    void relayRuntimeDeviceRefreshKey
    const { desktopId, serverUrl, token } = runtimeSession.relayDiagnostics
    setRelayRuntimeDeviceState((current) =>
      current.kind === 'ready' || current.kind === 'error' ? current : { kind: 'loading' }
    )

    const loadDeviceState = () => {
      void listRelayDevices({ ...(serverUrl ? { serverUrl } : {}), token })
        .then(({ desktops }) => {
          if (cancelled) return
          const desktop = desktops.find((candidate) => candidate.device_id === desktopId) ?? null
          setRelayRuntimeDeviceState({
            desktop,
            kind: 'ready',
            loadedAt: Date.now(),
          })
          setRelayForegroundRefresh((current) => {
            if (current.kind !== 'checking') return current
            if (!desktop) {
              return {
                checkedAt: Date.now(),
                kind: 'ready',
                message: '远程连接检查完成：目标电脑当前离线。',
                tone: 'error',
              }
            }
            if (desktop.runtime_status === 'offline') {
              return {
                checkedAt: Date.now(),
                kind: 'ready',
                message: `远程连接检查完成：本地 yive runtime 不可用，${getRelayDesktopRuntimeLabel(
                  desktop
                )}。`,
                tone: 'error',
              }
            }
            if (isRelayDesktopRuntimeStale(desktop)) {
              return {
                checkedAt: Date.now(),
                kind: 'ready',
                message: `远程连接检查完成：runtime 状态可能过期，${getRelayDesktopRuntimeMeta(
                  desktop
                )}。`,
                tone: 'warn',
              }
            }
            return {
              checkedAt: Date.now(),
              kind: 'ready',
              message: '远程连接已恢复：Runtime 在线。',
              tone: 'ok',
            }
          })
        })
        .catch((error: unknown) => {
          if (cancelled) return
          const message = getRelayDevicePickerErrorMessage(error)
          setRelayRuntimeDeviceState({
            kind: 'error',
            loadedAt: Date.now(),
            message,
          })
          setRelayForegroundRefresh((current) => {
            if (current.kind !== 'checking') return current
            return {
              checkedAt: Date.now(),
              kind: 'ready',
              message: `远程连接检查失败：${message}`,
              tone: 'warn',
            }
          })
        })
        .finally(() => {
          if (!cancelled) timer = window.setTimeout(loadDeviceState, REFRESH_INTERVAL_MS * 5)
        })
    }

    loadDeviceState()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [relayRuntimeDeviceRefreshKey, runtimeSession])

  useEffect(() => {
    if (
      runtimeSession.mode !== 'relay' ||
      (workspaceState.kind !== 'error' && dashboardState.kind !== 'error' && !relayDiagnosticsOpen)
    ) {
      setRelayRuntimeDiagnostics({ kind: 'idle' })
      return
    }

    let cancelled = false
    void relayDiagnosticsRequestKey
    setRelayRuntimeDiagnostics({ kind: 'loading' })
    const { serverUrl, token } = runtimeSession.relayDiagnostics

    const loadDiagnostics = async () => {
      const loadHealth = async () => {
        const healthStartedAt = getHealthProbeTime()
        const health = await getRelayHealth({ ...(serverUrl ? { serverUrl } : {}) })
        return { health, roundTripMs: getHealthProbeTime() - healthStartedAt }
      }
      const [healthResult, devicesResult] = await Promise.allSettled([
        loadHealth(),
        listRelayDevices({ ...(serverUrl ? { serverUrl } : {}), token }),
      ])
      if (cancelled) return
      setRelayRuntimeDiagnostics({
        devices: devicesResult.status === 'fulfilled' ? devicesResult.value : null,
        ...(devicesResult.status === 'rejected'
          ? { devicesMessage: getRelayDevicePickerErrorMessage(devicesResult.reason) }
          : {}),
        health: healthResult.status === 'fulfilled' ? healthResult.value.health : null,
        healthRoundTripMs:
          healthResult.status === 'fulfilled' ? healthResult.value.roundTripMs : null,
        ...(healthResult.status === 'rejected'
          ? { healthMessage: getRelayHealthErrorMessage(healthResult.reason) }
          : {}),
        kind: 'ready',
      })
    }

    void loadDiagnostics()
    return () => {
      cancelled = true
    }
  }, [
    dashboardState.kind,
    relayDiagnosticsOpen,
    relayDiagnosticsRequestKey,
    runtimeSession,
    workspaceState.kind,
  ])

  const workspaces = workspaceState.kind === 'ready' ? workspaceState.workspaces : []
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null
  const agentCards = useMemo<AgentCardModel[]>(() => {
    if (!activeWorkspace || dashboardState.kind !== 'ready') return []
    return [
      ...(dashboardState.orchestrator
        ? [deriveOrchestratorCard(dashboardState.runs, dashboardState.orchestrator)]
        : []),
      ...dashboardState.workers.map((worker) => deriveWorkerCard(worker, dashboardState.runs)),
    ]
  }, [activeWorkspace, dashboardState])
  const agentListCards = useMemo(
    () =>
      [...agentCards].sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'orchestrator' ? -1 : 1
        if (left.kind === 'orchestrator') return 0
        return (
          MOBILE_AGENT_STATUS_PRIORITY[presentAgentStatus(left).kind] -
          MOBILE_AGENT_STATUS_PRIORITY[presentAgentStatus(right).kind]
        )
      }),
    [agentCards]
  )
  const summary = summarizeAgents(agentCards)
  const allAgentsVerifiedIdle = areAllAgentsVerifiedIdle(agentCards)
  const approvals = useMemo(() => buildApprovalItems(agentCards), [agentCards])
  const pendingNotificationCount = agentCards.reduce(
    (total, agent) => total + agent.queuedDispatchCount + (agent.activeDispatchId === null ? 0 : 1),
    0
  )
  const selectedAgent = agentCards.find((agent) => agent.id === selectedAgentId) ?? null
  const terminalPaneAgent = selectedAgent
  const fileReviewRun =
    agentCards.find((agent) => agent.run && agent.run.status !== 'stopped')?.run ?? null
  const activeTabLabel = MOBILE_TABS.find((tab) => tab.id === activeTab)?.label ?? 'Agent'
  const accessAddress = typeof window === 'undefined' ? '当前浏览器地址' : window.location.href
  const relayRuntimeStatus = useMemo<{
    label: string
    message?: string
    tone: MobileConnectionTone
  }>(() => {
    if (runtimeSession.mode !== 'relay') {
      return { label: runtimeSession.runtimeLabel, tone: 'ok' }
    }
    if (relayRuntimeDeviceState.kind === 'loading') {
      return { label: 'Relay 在线 · 确认电脑中', tone: 'warn' }
    }
    if (relayRuntimeDeviceState.kind === 'error') {
      return {
        label: 'Relay 状态未知',
        message: `已连接 Relay，但无法确认目标电脑状态：${relayRuntimeDeviceState.message}`,
        tone: 'warn',
      }
    }
    if (relayRuntimeDeviceState.kind === 'ready') {
      const { desktop } = relayRuntimeDeviceState
      if (!desktop) {
        return {
          label: 'Relay 在线 · 电脑离线',
          message: `目标电脑 ${runtimeSession.relayDiagnostics.desktopId} 未出现在 Relay 在线设备列表。`,
          tone: 'error',
        }
      }
      if (desktop.runtime_status === 'offline') {
        return {
          label: 'Relay 在线 · Runtime 不可用',
          message: `目标电脑已连接 Relay，但本地 yive runtime 不可用：${getRelayDesktopRuntimeLabel(
            desktop
          )}。`,
          tone: 'error',
        }
      }
      if (isRelayDesktopRuntimeStale(desktop)) {
        return {
          label: 'Relay 在线 · 状态可能过期',
          message: `目标电脑在线，但 runtime 状态 ${getRelayDesktopRuntimeMeta(
            desktop
          )}，如操作失败请重试连接。`,
          tone: 'warn',
        }
      }
      return { label: 'Relay 在线 · Runtime 在线', tone: 'ok' }
    }
    return { label: runtimeSession.runtimeLabel, tone: 'ok' }
  }, [relayRuntimeDeviceState, runtimeSession])
  const relayRuntimeDeviceDetails = useMemo(() => {
    if (runtimeSession.mode !== 'relay') return []
    if (relayRuntimeDeviceState.kind === 'idle') return []
    if (relayRuntimeDeviceState.kind === 'loading') return ['正在确认电脑在线状态']
    if (relayRuntimeDeviceState.kind === 'error') {
      return [`设备状态检查失败：${relayRuntimeDeviceState.message}`]
    }
    if (!relayRuntimeDeviceState.desktop) return ['目标电脑未出现在 Relay 设备列表']

    const runtimeMeta = getRelayDesktopRuntimeMeta(relayRuntimeDeviceState.desktop)
    return [
      `电脑状态 ${getRelayDesktopRuntimeLabel(relayRuntimeDeviceState.desktop)}`,
      ...(runtimeMeta ? [runtimeMeta] : []),
      ...getRelayDesktopConnectionMeta(relayRuntimeDeviceState.desktop).map((line) => line.label),
    ]
  }, [relayRuntimeDeviceState, runtimeSession.mode])
  const relayEventsDetail =
    runtimeSession.mode === 'relay'
      ? formatRelayEventsStatus(relayEventsStatus, relayEventsNow)
      : null
  const relayForegroundRefreshDetail =
    runtimeSession.mode === 'relay'
      ? formatRelayForegroundRefreshStatus(relayForegroundRefresh)
      : null
  const relaySnapshotWarning =
    runtimeSession.mode === 'relay'
      ? formatRelaySnapshotWarning(relayEventsStatus, relayEventsNow)
      : null
  const relayEventsTone =
    runtimeSession.mode === 'relay'
      ? getRelayEventsConnectionTone(relayEventsStatus, relayEventsNow)
      : null
  const relayPathItems =
    runtimeSession.mode === 'relay'
      ? buildRelayPathItems({
          desktopId: runtimeSession.relayDiagnostics.desktopId,
          deviceId: runtimeSession.relayDiagnostics.deviceId,
          deviceState: relayRuntimeDeviceState,
          eventsDetail: relayEventsDetail,
          eventsStatus: relayEventsStatus,
          eventsTone: relayEventsTone,
          serverUrl: runtimeSession.relayDiagnostics.serverUrl,
        })
      : []
  const dashboardStaleMessage =
    dashboardState.kind === 'ready' && dashboardState.staleMessage
      ? `Agent 状态刷新失败，正在显示上次状态：${dashboardState.staleMessage}`
      : null
  const connectionDetails =
    runtimeSession.mode === 'relay'
      ? [
          ...(browserOnline ? [] : ['浏览器当前离线']),
          `目标电脑 ${runtimeSession.relayDiagnostics.desktopId}`,
          ...(runtimeSession.relayDiagnostics.deviceId
            ? [`当前手机 ${runtimeSession.relayDiagnostics.deviceId}`]
            : []),
          runtimeSession.relayDiagnostics.serverUrl
            ? `Relay ${runtimeSession.relayDiagnostics.serverUrl}`
            : 'Relay 当前域名',
          ...relayRuntimeDeviceDetails,
          ...(relayForegroundRefreshDetail ? [relayForegroundRefreshDetail] : []),
          ...(relayEventsDetail ? [relayEventsDetail] : []),
          ...(dashboardStaleMessage ? [dashboardStaleMessage] : []),
        ]
      : browserOnline
        ? []
        : ['浏览器当前离线']
  const connectionErrorMessage =
    workspaceState.kind === 'error'
      ? workspaceState.message
      : dashboardState.kind === 'error'
        ? dashboardState.message
        : null
  const connectionMessage = !browserOnline
    ? '浏览器当前离线，远程控制会在网络恢复后自动重试。'
    : connectionErrorMessage !== null
      ? connectionErrorMessage
      : dashboardStaleMessage !== null
        ? dashboardStaleMessage
        : (relayRuntimeStatus.message ?? runtimeSession.connectionMessage)
  const runtimeLabel = !browserOnline
    ? '浏览器离线'
    : workspaceState.kind === 'loading'
      ? '连接中'
      : workspaceState.kind === 'error'
        ? '离线'
        : relayRuntimeStatus.label
  const connectionTone: MobileConnectionTone =
    !browserOnline || workspaceState.kind === 'error' || dashboardState.kind === 'error'
      ? 'error'
      : dashboardStaleMessage !== null
        ? 'warn'
        : combineConnectionTones(relayRuntimeStatus.tone, relayEventsTone)
  const retryConnectionDisabled = !browserOnline
  const fileExchangeDisabled = connectionTone === 'error'
  const fileExchangeDisabledMessage = !fileExchangeDisabled
    ? null
    : !browserOnline
      ? '浏览器当前离线，文件交换操作会在网络恢复后重新启用。'
      : runtimeSession.mode === 'relay' && relayRuntimeStatus.tone === 'error'
        ? `${relayRuntimeStatus.message ?? 'Relay 链路不可用'} 文件交换需要本地电脑 runtime 在线。`
        : '当前连接不可用，文件交换操作会在恢复后重新启用。'
  const terminalConnectionWarning = !browserOnline
    ? connectionMessage
    : workspaceState.kind === 'error' || dashboardState.kind === 'error'
      ? connectionMessage
      : dashboardStaleMessage !== null
        ? dashboardStaleMessage
        : runtimeSession.mode === 'relay' && relayRuntimeStatus.tone === 'error'
          ? (relayRuntimeStatus.message ?? connectionMessage)
          : null
  const relayRuntimeDiagnosticReport =
    runtimeSession.mode === 'relay' &&
    (workspaceState.kind === 'error' || dashboardState.kind === 'error' || relayDiagnosticsOpen)
      ? buildRelayRuntimeDiagnosticReport({
          desktopId: runtimeSession.relayDiagnostics.desktopId,
          deviceId: runtimeSession.relayDiagnostics.deviceId,
          diagnostics: relayRuntimeDiagnostics,
          eventsNow: relayEventsNow,
          eventsStatus: relayEventsStatus,
          serverUrl: runtimeSession.relayDiagnostics.serverUrl,
        })
      : null
  const relayRuntimeDiagnosticLines = relayRuntimeDiagnosticReport?.checks ?? []
  const relayRuntimeDiagnosticCommands = useMemo(
    () =>
      runtimeSession.mode === 'relay'
        ? buildRelayDiagnosticCommands({
            desktopId: runtimeSession.relayDiagnostics.desktopId,
            serverUrl: runtimeSession.relayDiagnostics.serverUrl,
          })
        : [],
    [runtimeSession]
  )
  useEffect(() => {
    if (!activeWorkspace || dashboardState.kind !== 'ready') return
    const snapshot: MobileLastConnectionSnapshot = {
      agentCount: agentCards.length,
      ...(runtimeSession.mode === 'relay'
        ? {
            desktopId: runtimeSession.relayDiagnostics.desktopId,
            ...(runtimeSession.relayDiagnostics.deviceId
              ? { deviceId: runtimeSession.relayDiagnostics.deviceId }
              : {}),
            ...(runtimeSession.relayDiagnostics.serverUrl
              ? { serverUrl: runtimeSession.relayDiagnostics.serverUrl }
              : {}),
          }
        : {}),
      awaitingReport: summary.awaitingReport,
      busy: summary.busy,
      crashed: summary.crashed,
      idle: summary.idle,
      mode: runtimeSession.mode === 'relay' ? 'relay' : 'local',
      pending: pendingNotificationCount,
      runtimeLabel,
      stopped: summary.stopped,
      updatedAt: Date.now(),
      unknown: summary.unknown,
      workspaceId: activeWorkspace.id,
      workspaceName: activeWorkspace.name,
      workspacePath: activeWorkspace.path,
    }
    setLastConnectionSnapshot(snapshot)
    writeMobileLastConnectionSnapshot(snapshot)
  }, [
    activeWorkspace,
    agentCards.length,
    dashboardState.kind,
    pendingNotificationCount,
    runtimeLabel,
    runtimeSession,
    summary.awaitingReport,
    summary.busy,
    summary.crashed,
    summary.idle,
    summary.stopped,
    summary.unknown,
  ])

  const refreshDashboard = useCallback(() => {
    if (!activeWorkspaceId) return
    void runtimeSession.client
      .listDashboard(activeWorkspaceId)
      .then(({ orchestrator, workers, runs }) => {
        setDashboardState((current) => ({
          kind: 'ready',
          ...(orchestrator
            ? { orchestrator }
            : current.kind === 'ready' && current.orchestrator
              ? { orchestrator: current.orchestrator }
              : {}),
          workers,
          runs,
        }))
        setLastRefreshAt(Date.now())
      })
      .catch((error: unknown) =>
        setDashboardState((current) => {
          const message = getLoadErrorMessage(error, '加载工作区 Agent 失败')
          return current.kind === 'ready'
            ? { ...current, staleAt: Date.now(), staleMessage: message }
            : { kind: 'error', message }
        })
      )
  }, [activeWorkspaceId, runtimeSession.client])
  const retryConnection = useCallback(() => {
    setFileItems([])
    setFileBusyLabel(null)
    setFileMessage(null)
    setSelectedAgentId(null)
    setAgentActionMessage(null)
    setPendingAgentAction(null)
    setDangerAction(null)
    setStaleTerminalRunId(null)
    setRelayDiagnosticsOpen(false)
    setRelayRuntimeDiagnostics({ kind: 'idle' })
    setRelayForegroundRefresh({ kind: 'idle' })
    setConnectionRetryKey((key) => key + 1)
  }, [])
  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleBrowserOnline = () => {
      setBrowserOnline(true)
      pendingBrowserOnlineRetryRef.current = true
      if (workspaceState.kind === 'error' || dashboardState.kind === 'error') {
        pendingBrowserOnlineRetryRef.current = false
        retryConnection()
      }
    }
    const handleBrowserOffline = () => {
      pendingBrowserOnlineRetryRef.current = false
      setBrowserOnline(false)
    }

    setBrowserOnline(getBrowserOnlineStatus())
    window.addEventListener('online', handleBrowserOnline)
    window.addEventListener('offline', handleBrowserOffline)
    return () => {
      window.removeEventListener('online', handleBrowserOnline)
      window.removeEventListener('offline', handleBrowserOffline)
    }
  }, [dashboardState.kind, retryConnection, workspaceState.kind])
  useEffect(() => {
    if (!browserOnline || !pendingBrowserOnlineRetryRef.current) return
    if (workspaceState.kind !== 'error' && dashboardState.kind !== 'error') return
    pendingBrowserOnlineRetryRef.current = false
    retryConnection()
  }, [browserOnline, dashboardState.kind, retryConnection, workspaceState.kind])
  const runRelayDiagnostics = useCallback(() => {
    setRelayDiagnosticsOpen(true)
    setRelayRuntimeDiagnostics({ kind: 'loading' })
    setRelayDiagnosticsRequestKey((key) => key + 1)
  }, [])
  const openNotificationTabFromNotification = useCallback(() => {
    setSelectedAgentId(null)
    setAgentActionMessage(null)
    setPendingAgentAction(null)
    setDangerAction(null)
    setStaleTerminalRunId(null)
    setActiveTab('notifications')
  }, [])
  const openAgentTabFromNotification = useCallback(() => {
    setSelectedAgentId(null)
    setAgentActionMessage(null)
    setDangerAction(null)
    setStaleTerminalRunId(null)
    setActiveTab('agents')
  }, [])
  useEffect(() => {
    if (!selectedAgent || typeof window === 'undefined') return
    const dispatchResize = () => window.dispatchEvent(new Event('resize'))
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(dispatchResize)
      return
    }
    window.setTimeout(dispatchResize, 0)
  }, [selectedAgent])
  const requestMobileNotifications = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window) || notificationRequesting) {
      return
    }
    if (Notification.permission === 'granted') {
      setMobileNotificationPreference(true)
      setNotificationState('enabled')
      return
    }
    setNotificationRequesting(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission === 'granted') {
        setMobileNotificationPreference(true)
        setNotificationState('enabled')
      } else {
        setMobileNotificationPreference(false)
        setNotificationState(permission === 'denied' ? 'denied' : 'prompt')
      }
    } finally {
      setNotificationRequesting(false)
    }
  }, [notificationRequesting])
  useEffect(() => {
    if (dashboardState.kind !== 'ready') return
    updateMobileAppBadge(pendingNotificationCount)
  }, [dashboardState.kind, pendingNotificationCount])
  useEffect(() => {
    if (agentNotifications.length === 0) return
    const seenIds = seenAgentNotificationIdsRef.current
    const unseen = agentNotifications.filter((item) => !seenIds.has(item.id))
    for (const item of agentNotifications) seenIds.add(item.id)
    if (unseen.length === 0 || notificationState !== 'enabled') return
    for (const item of unseen) {
      sendMobileNotification({
        body: item.body,
        onClick: openNotificationTabFromNotification,
        tag: `yive-mobile-agent-${item.id}`,
        title: item.title,
      })
    }
  }, [agentNotifications, notificationState, openNotificationTabFromNotification])
  useEffect(() => {
    if (dashboardState.kind !== 'ready') return
    const snapshot = {
      crashed: summary.crashed,
      pending: pendingNotificationCount,
      stopped: summary.stopped,
      busy: summary.busy,
    }
    const previous = notificationSnapshotRef.current
    notificationSnapshotRef.current = snapshot
    if (!previous || notificationState !== 'enabled') return

    if (snapshot.pending > previous.pending) {
      sendMobileNotification({
        body: `${snapshot.pending} 个事项等待查看。`,
        onClick: openNotificationTabFromNotification,
        tag: 'yive-mobile-pending',
        title: 'Yive 有待处理事项',
      })
      return
    }
    if (previous.busy > 0 && snapshot.busy === 0 && allAgentsVerifiedIdle) {
      sendMobileNotification({
        body: '当前工作区没有正在工作的 Agent。',
        onClick: openNotificationTabFromNotification,
        tag: 'yive-mobile-idle',
        title: 'Yive Agent 已空闲',
      })
      return
    }
    if (snapshot.crashed > previous.crashed) {
      sendMobileNotification({
        body: `${snapshot.crashed} 个 Agent 的进程已崩溃。`,
        onClick: openNotificationTabFromNotification,
        tag: 'yive-mobile-crashed',
        title: 'Yive Agent 已崩溃',
      })
    }
  }, [
    dashboardState.kind,
    allAgentsVerifiedIdle,
    notificationState,
    openNotificationTabFromNotification,
    pendingNotificationCount,
    summary,
  ])
  useEffect(() => {
    const connectionRef = connectionNotificationRef.current
    const isReady =
      workspaceState.kind === 'ready' &&
      dashboardState.kind === 'ready' &&
      dashboardStaleMessage === null
    const isError =
      workspaceState.kind === 'error' ||
      dashboardState.kind === 'error' ||
      dashboardStaleMessage !== null

    if (isReady) {
      connectionRef.wasReady = true
      connectionRef.notifiedError = false
      return
    }
    if (!isError || !connectionRef.wasReady || connectionRef.notifiedError) return
    connectionRef.notifiedError = true
    if (notificationState !== 'enabled') return

    sendMobileNotification({
      body:
        runtimeSession.mode === 'relay'
          ? '公网 Relay 或本地电脑 runtime 连接中断，请回到 Yive 检查诊断。'
          : '手机和电脑的本地连接中断，请回到 Yive 重试。',
      onClick: openAgentTabFromNotification,
      tag: 'yive-mobile-connection',
      title: 'Yive 连接已断开',
    })
  }, [
    dashboardStaleMessage,
    dashboardState.kind,
    notificationState,
    openAgentTabFromNotification,
    runtimeSession.mode,
    workspaceState.kind,
  ])
  useEffect(() => {
    if (workspaceState.kind !== 'error' && dashboardState.kind !== 'error') return
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    const retryWhenVisible = () => {
      if (document.visibilityState === 'visible') retryConnection()
    }

    document.addEventListener('visibilitychange', retryWhenVisible)
    return () => {
      document.removeEventListener('visibilitychange', retryWhenVisible)
    }
  }, [dashboardState.kind, retryConnection, workspaceState.kind])
  useEffect(() => {
    if (!activeWorkspaceId || workspaceState.kind !== 'ready' || dashboardState.kind !== 'ready') {
      return
    }
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    const refreshWhenForeground = () => {
      if (document.visibilityState === 'hidden') return
      refreshDashboard()
      if (runtimeSession.mode === 'relay') {
        setRelayForegroundRefresh({ kind: 'checking', startedAt: Date.now() })
        setRelayRuntimeDeviceRefreshKey((key) => key + 1)
      }
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshDashboard()
      if (document.visibilityState === 'visible' && runtimeSession.mode === 'relay') {
        setRelayForegroundRefresh({ kind: 'checking', startedAt: Date.now() })
        setRelayRuntimeDeviceRefreshKey((key) => key + 1)
      }
    }

    window.addEventListener('online', refreshWhenForeground)
    window.addEventListener('focus', refreshWhenForeground)
    window.addEventListener('pageshow', refreshWhenForeground)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.removeEventListener('online', refreshWhenForeground)
      window.removeEventListener('focus', refreshWhenForeground)
      window.removeEventListener('pageshow', refreshWhenForeground)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [
    activeWorkspaceId,
    dashboardState.kind,
    refreshDashboard,
    runtimeSession.mode,
    workspaceState.kind,
  ])
  const switchRelayDesktop = useCallback(() => {
    if (runtimeSession.mode !== 'relay' || typeof window === 'undefined') return
    const pairing = clearStoredRelayDesktopSelection()
    const url = new URL('/mobile', window.location.origin)
    url.searchParams.set('relay', '1')
    const serverUrl = pairing?.serverUrl ?? runtimeSession.relayDiagnostics.serverUrl
    if (serverUrl) url.searchParams.set('server', serverUrl)
    window.location.href = `${url.pathname}${url.search}`
  }, [runtimeSession])
  const runRelayDiagnosticAction = useCallback(
    (actionId: string) => {
      if (actionId === 'retry_connection') {
        retryConnection()
        return
      }
      if (actionId === 'switch_desktop') {
        switchRelayDesktop()
      }
    },
    [retryConnection, switchRelayDesktop]
  )
  const handleWorkspaceSelect = (workspaceId: string) => {
    if (workspaceId !== activeWorkspaceId) {
      setDashboardState({ kind: 'loading' })
    }
    setActiveWorkspaceId(workspaceId)
    if (runtimeSession.mode === 'local') void saveActiveWorkspaceId(workspaceId).catch(() => {})
    if (runtimeSession.mode === 'relay') {
      saveStoredRelayWorkspaceId(runtimeSession.relayDiagnostics.desktopId, workspaceId)
    }
    setWorkspaceSwitcherOpen(false)
    setSelectedAgentId(null)
    setAgentActionMessage(null)
    setPendingAgentAction(null)
    setDangerAction(null)
    setStaleTerminalRunId(null)
  }

  const openTab = (tab: MobileTab) => {
    writeMobileTabToUrl(tab)
    setActiveTab(tab)
    setSelectedAgentId(null)
    setAgentActionMessage(null)
    setPendingAgentAction(null)
    setDangerAction(null)
    setStaleTerminalRunId(null)
  }

  const handleStart = async (agent: AgentCardModel) => {
    if (!activeWorkspace) return
    setAgentActionMessage('正在启动终端...')
    setPendingAgentAction(null)
    setStaleTerminalRunId(null)
    try {
      await runtimeSession.client.startAgentRun(activeWorkspace.id, agent.id)
      setAgentActionMessage('终端已启动')
      refreshDashboard()
    } catch (error) {
      setPendingAgentAction('start')
      setAgentActionMessage(getLoadErrorMessage(error, '启动终端失败'))
    }
  }

  const handleStop = async (agent: AgentCardModel, mode: AgentStopMode = 'safe') => {
    if (!activeWorkspace || !agent.run) return
    setAgentActionMessage(
      mode === 'checkpoint' ? '正在创建恢复点并等待 CLI 完成...' : '正在检查最新会话状态...'
    )
    setPendingAgentAction(null)
    try {
      const result = await runtimeSession.client.stopAgentRun(
        activeWorkspace.id,
        agent.run.run_id,
        mode
      )
      if (result.state === 'stopped') {
        setStaleTerminalRunId(agent.run.run_id)
        setAgentActionMessage(mode === 'force' ? '终端已强制停止' : '终端已安全停止')
        refreshDashboard()
        return
      }
      if (result.state === 'checkpoint_required' && mode === 'safe') {
        if (result.reason === 'provider_unsupported' || result.reason === 'session_changed') {
          setDangerAction('force')
          setAgentActionMessage(
            result.reason === 'session_changed'
              ? '当前终端已切换到其他 CLI 会话，无法为原会话创建恢复点'
              : '当前 CLI 不支持可验证的恢复点，终端仍在运行'
          )
          return
        }
        setDangerAction('checkpoint')
        setAgentActionMessage('最新会话状态尚未持久化，终端仍在运行')
        return
      }
      setAgentActionMessage('未能安全停止，终端仍在运行')
      setPendingAgentAction('stop')
    } catch (error) {
      setPendingAgentAction('stop')
      setAgentActionMessage(getLoadErrorMessage(error, '安全停止失败，终端仍在运行'))
    }
  }

  const handleRestart = async (agent: AgentCardModel) => {
    if (!activeWorkspace || !agent.run) return
    setAgentActionMessage('正在重启终端...')
    setPendingAgentAction(null)
    setStaleTerminalRunId(agent.run.run_id)
    try {
      await runtimeSession.client.restartAgentRun(activeWorkspace.id, agent.id, agent.run.run_id)
      setAgentActionMessage('终端已重启')
      refreshDashboard()
    } catch (error) {
      setStaleTerminalRunId(null)
      setPendingAgentAction('restart')
      setAgentActionMessage(getLoadErrorMessage(error, '重启终端失败'))
    }
  }

  const refreshDispatches = async () => {
    if (!activeWorkspace) return
    const dispatches = await runtimeSession.client.listDispatches(activeWorkspace.id)
    setDispatchesState({ dispatches, kind: 'ready' })
  }

  const handleDispatchNote = async (dispatch: MobileDispatchItem, text: string) => {
    if (!activeWorkspace) return
    const trimmed = text.trim()
    if (!trimmed) {
      setDispatchActionState({
        busy: false,
        dispatchId: dispatch.id,
        message: '请输入补充说明',
        mode: 'note',
      })
      return
    }
    setDispatchActionState({
      busy: true,
      dispatchId: dispatch.id,
      message: '正在发送补充说明...',
      mode: 'note',
    })
    const pending = pendingDispatchNoteRef.current
    const actionId =
      pending?.dispatchId === dispatch.id && pending.text === trimmed
        ? pending.actionId
        : createBrowserId('team-note')
    pendingDispatchNoteRef.current = { actionId, dispatchId: dispatch.id, text: trimmed }
    try {
      const result = await runtimeSession.client.sendTeamNote(
        activeWorkspace.id,
        dispatch.id,
        trimmed,
        { actionId }
      )
      if (pendingDispatchNoteRef.current?.actionId === actionId) {
        pendingDispatchNoteRef.current = null
      }
      setDispatchActionState({
        busy: false,
        dispatchId: dispatch.id,
        message:
          result.delivery_state === 'delivered' ? '补充说明已送达' : '补充说明已排队，等待安全边界',
        mode: 'note',
      })
      await refreshDispatches()
      refreshDashboard()
    } catch (error) {
      setDispatchActionState({
        busy: false,
        dispatchId: dispatch.id,
        message: getLoadErrorMessage(error, '发送补充说明失败'),
        mode: 'note',
      })
    }
  }

  const handleDispatchReport = async (dispatch: MobileDispatchItem, text: string) => {
    if (!activeWorkspace) return
    const trimmed = text.trim()
    if (!trimmed) {
      setDispatchActionState({
        busy: false,
        dispatchId: dispatch.id,
        message: '请输入汇报内容',
        mode: 'report',
      })
      return
    }
    setDispatchActionState({
      busy: true,
      dispatchId: dispatch.id,
      message: '正在提交汇报...',
      mode: 'report',
    })
    try {
      await runtimeSession.client.sendTeamReport(activeWorkspace.id, dispatch.to_agent_id, trimmed)
      setDispatchActionState({
        busy: false,
        dispatchId: dispatch.id,
        message: '汇报已提交',
        mode: 'report',
      })
      await refreshDispatches()
      refreshDashboard()
    } catch (error) {
      setDispatchActionState({
        busy: false,
        dispatchId: dispatch.id,
        message: getLoadErrorMessage(error, '提交汇报失败'),
        mode: 'report',
      })
    }
  }

  const handleDispatchStatus = async (dispatch: MobileDispatchItem, text: string) => {
    if (!activeWorkspace) return
    const trimmed = text.trim()
    if (!trimmed) {
      setDispatchActionState({
        busy: false,
        dispatchId: dispatch.id,
        message: '请输入进度状态',
        mode: 'status',
      })
      return
    }
    setDispatchActionState({
      busy: true,
      dispatchId: dispatch.id,
      message: '正在发送进度...',
      mode: 'status',
    })
    try {
      await runtimeSession.client.sendTeamStatus(activeWorkspace.id, dispatch.to_agent_id, trimmed)
      setDispatchActionState({
        busy: false,
        dispatchId: dispatch.id,
        message: '进度已发送',
        mode: 'status',
      })
      await refreshDispatches()
      refreshDashboard()
    } catch (error) {
      setDispatchActionState({
        busy: false,
        dispatchId: dispatch.id,
        message: getLoadErrorMessage(error, '发送进度失败'),
        mode: 'status',
      })
    }
  }

  const handleDispatchCancel = async (dispatch: MobileDispatchItem, reason: string) => {
    if (!activeWorkspace) return
    const trimmed = reason.trim()
    if (!trimmed) {
      setDispatchActionState({
        busy: false,
        dispatchId: dispatch.id,
        message: '请输入取消原因',
        mode: 'cancel',
      })
      return
    }
    setDispatchActionState({
      busy: true,
      dispatchId: dispatch.id,
      message: '正在取消派单...',
      mode: 'cancel',
    })
    try {
      await runtimeSession.client.cancelTeamTask(activeWorkspace.id, dispatch.id, trimmed)
      setDispatchActionState({
        busy: false,
        dispatchId: dispatch.id,
        message: '派单已取消',
        mode: 'cancel',
      })
      await refreshDispatches()
      refreshDashboard()
    } catch (error) {
      setDispatchActionState({
        busy: false,
        dispatchId: dispatch.id,
        message: getLoadErrorMessage(error, '取消派单失败'),
        mode: 'cancel',
      })
    }
  }

  const handleDispatchReplace = async (
    dispatch: MobileDispatchItem,
    text: string,
    interrupt: boolean
  ) => {
    if (!activeWorkspace) return
    const trimmed = text.trim()
    if (!trimmed) {
      setDispatchActionState({
        busy: false,
        dispatchId: dispatch.id,
        message: '请输入替换任务',
        mode: 'replace',
      })
      return
    }
    setDispatchActionState({
      busy: true,
      dispatchId: dispatch.id,
      message: '正在替换派单...',
      mode: 'replace',
    })
    const pending = pendingDispatchReplaceRef.current
    const actionId =
      pending?.dispatchId === dispatch.id &&
      pending.text === trimmed &&
      pending.interrupt === interrupt
        ? pending.actionId
        : createBrowserId('team-replace')
    pendingDispatchReplaceRef.current = {
      actionId,
      dispatchId: dispatch.id,
      interrupt,
      text: trimmed,
    }
    try {
      await runtimeSession.client.replaceTeamTask(activeWorkspace.id, dispatch.id, trimmed, {
        actionId,
        interrupt,
      })
      if (pendingDispatchReplaceRef.current?.actionId === actionId) {
        pendingDispatchReplaceRef.current = null
      }
      setDispatchActionState({
        busy: false,
        dispatchId: dispatch.id,
        message: '派单已替换',
        mode: 'replace',
      })
      await refreshDispatches()
      refreshDashboard()
    } catch (error) {
      setDispatchActionState({
        busy: false,
        dispatchId: dispatch.id,
        message: getLoadErrorMessage(error, '替换派单失败'),
        mode: 'replace',
      })
    }
  }

  const retryPendingAgentAction = () => {
    if (!selectedAgent || !pendingAgentAction) return
    if (pendingAgentAction === 'start') void handleStart(selectedAgent)
    if (pendingAgentAction === 'stop') void handleStop(selectedAgent)
    if (pendingAgentAction === 'restart') void handleRestart(selectedAgent)
  }

  const reloadFiles = async () => {
    setFileItems(await runtimeSession.client.listFiles())
  }

  useEffect(
    () => () => {
      if (fileDownloadLink) URL.revokeObjectURL(fileDownloadLink.href)
    },
    [fileDownloadLink]
  )

  const upsertFileItem = (item: MobileFileExchangeItem) => {
    setFileItems((items) => upsertMobileFileItem(items, item))
  }

  const removeFileItem = (fileId: string) => {
    setFileItems((items) => removeMobileFileItem(items, fileId))
    setFileDownloadRetry((retry) => (retry?.id === fileId ? null : retry))
  }

  const reloadFilesAfterMutation = async (successMessage: string) => {
    try {
      await reloadFiles()
      setFileMessage(successMessage)
    } catch (error) {
      setFileMessage(
        `${successMessage}，但刷新文件列表失败：${getLoadErrorMessage(error, '刷新文件列表失败')}`
      )
    }
  }

  const deleteDownloadedFileAfterSave = async (fileId: string, successMessage: string) => {
    try {
      await runtimeSession.client.deleteFile(fileId)
      removeFileItem(fileId)
      setFileMessage(`${successMessage} 已从文件交换区移除。`)
    } catch (error) {
      setFileMessage(
        `${successMessage} 但从文件交换区删除失败：${getLoadErrorMessage(error, '删除文件失败')}`
      )
    }
  }

  const handleFileUpload = async (file: File) => {
    if (shouldSkipMobileFileExchangeAction({ busyLabel: fileBusyLabel })) return
    const action = getMobileFileExchangeActionPresentation('upload')
    setFileMessage(null)
    if (fileExchangeDisabled) {
      setFileMessage(action.disabledMessage)
      return
    }
    const validation = validateMobileExchangeFile(file)
    if (!validation.ok) {
      setFileMessage(validation.message)
      return
    }
    setFileBusyLabel(action.busyLabel)
    setFileMessage(action.pendingMessage)
    try {
      if (!activeWorkspace) throw new Error('Choose a Workspace before uploading a file')
      const item = await runtimeSession.client.uploadFile(activeWorkspace.id, file)
      upsertFileItem(item)
      await reloadFilesAfterMutation('文件已上传')
    } catch (error) {
      setFileMessage(getLoadErrorMessage(error, '上传文件失败'))
    } finally {
      setFileBusyLabel(null)
    }
  }

  const handleWorkspaceFileSend = async () => {
    if (!activeWorkspace || shouldSkipMobileFileExchangeAction({ busyLabel: fileBusyLabel })) return
    const action = getMobileFileExchangeActionPresentation('send_workspace_file')
    if (fileExchangeDisabled) {
      setFileMessage(action.disabledMessage)
      return
    }
    const path = workspaceFilePath.trim()
    const validation = validateWorkspaceFileExchangePath(path)
    if (!validation.ok) {
      setFileMessage(validation.message)
      return
    }
    setFileBusyLabel(action.busyLabel)
    setFileMessage(action.pendingMessage)
    try {
      const item = await runtimeSession.client.sendWorkspaceFileToMobile(activeWorkspace.id, path)
      upsertFileItem(item)
      setWorkspaceFilePath('')
      await reloadFilesAfterMutation('工作区文件已发送到手机')
    } catch (error) {
      setFileMessage(getLoadErrorMessage(error, '发送工作区文件失败'))
    } finally {
      setFileBusyLabel(null)
    }
  }

  const handleFileDelete = async (fileId: string) => {
    if (shouldSkipMobileFileExchangeAction({ busyLabel: fileBusyLabel })) return
    const action = getMobileFileExchangeActionPresentation('delete')
    if (fileExchangeDisabled) {
      setFileMessage(action.disabledMessage)
      return
    }
    setFileBusyLabel(action.busyLabel)
    setFileMessage(action.pendingMessage)
    try {
      await runtimeSession.client.deleteFile(fileId)
      removeFileItem(fileId)
      await reloadFilesAfterMutation('文件已删除')
    } catch (error) {
      setFileMessage(getLoadErrorMessage(error, '删除文件失败'))
    } finally {
      setFileBusyLabel(null)
    }
  }

  const handleFileDownload = async (fileId: string) => {
    if (shouldSkipMobileFileExchangeAction({ busyLabel: fileBusyLabel })) return
    const action = getMobileFileExchangeActionPresentation('download')
    if (fileExchangeDisabled) {
      setFileMessage(action.disabledMessage)
      return
    }
    const fileItem = fileItems.find((item) => item.id === fileId)
    setFileBusyLabel(action.busyLabel)
    setFileMessage(action.pendingMessage)
    setFileDownloadLink(null)
    setFileDownloadRetry(null)
    setFileDownloadProgress({
      fileId,
      loadedBytes: 0,
      name: fileItem?.name ?? '文件',
      totalBytes: fileItem?.size ?? null,
    })
    try {
      const file = await runtimeSession.client.downloadFile(fileId, (progress) => {
        setFileDownloadProgress({
          fileId,
          loadedBytes: progress.loadedBytes,
          name: fileItem?.name ?? '文件',
          totalBytes: progress.totalBytes ?? fileItem?.size ?? null,
        })
      })
      setFileDownloadProgress(null)
      const androidBridge = getYiveAndroidBridge()
      if (androidBridge?.saveFile) {
        const result = androidBridge.saveFile(
          file.name,
          file.mime_type,
          await blobToBase64(file.content)
        )
        await deleteDownloadedFileAfterSave(
          fileId,
          typeof result === 'string' && result ? result : '文件已保存到手机 Downloads。'
        )
        return
      }
      const href = URL.createObjectURL(file.content)
      setFileDownloadLink({ href, name: file.name })
      const link = document.createElement('a')
      link.href = href
      link.download = file.name
      document.body.appendChild(link)
      link.click()
      link.remove()
      await deleteDownloadedFileAfterSave(
        fileId,
        '文件已开始下载。若没有自动下载，请点下面的备用链接。'
      )
    } catch (error) {
      setFileDownloadProgress(null)
      setFileMessage(getLoadErrorMessage(error, '下载文件失败'))
      if (fileItem) {
        setFileDownloadRetry({ id: fileItem.id, name: fileItem.name })
      }
    } finally {
      setFileBusyLabel(null)
    }
  }

  const handleFileReview = async (fileId: string, decision: MobileFileReviewDecision) => {
    if (!activeWorkspace || shouldSkipMobileFileExchangeAction({ busyLabel: fileBusyLabel })) return
    const action = getMobileFileExchangeActionPresentation('review')
    if (fileExchangeDisabled) {
      setFileMessage(action.disabledMessage)
      return
    }
    const fileItem = fileItems.find((item) => item.id === fileId)
    if (!fileItem) {
      setFileMessage('文件不存在或已过期')
      return
    }
    setFileBusyLabel(action.busyLabel)
    setFileMessage(action.pendingMessage)
    try {
      await runtimeSession.client.reviewFile(activeWorkspace.id, fileId, decision, {
        ...(fileReviewRun ? { runId: fileReviewRun.run_id } : {}),
      })
      const decisionLabel = getFileReviewDecisionLabel(decision)
      setFileMessage(
        fileReviewRun
          ? `已将 ${fileItem.name} 的审核结果「${decisionLabel}」回传到终端`
          : `已记录 ${fileItem.name} 的审核结果「${decisionLabel}」`
      )
      refreshDashboard()
    } catch (error) {
      setFileMessage(getLoadErrorMessage(error, '回传审核结果失败'))
    } finally {
      setFileBusyLabel(null)
    }
  }

  const handleFileClear = async () => {
    if (shouldSkipMobileFileExchangeAction({ busyLabel: fileBusyLabel })) return
    const action = getMobileFileExchangeActionPresentation('clear')
    if (fileExchangeDisabled) {
      setFileMessage(action.disabledMessage)
      return
    }
    setFileBusyLabel(action.busyLabel)
    setFileMessage(action.pendingMessage)
    try {
      await runtimeSession.client.clearFiles()
      setFileItems([])
      setFileDownloadRetry(null)
      await reloadFilesAfterMutation('文件交换区已清空')
    } catch (error) {
      setFileMessage(getLoadErrorMessage(error, '清空文件失败'))
    } finally {
      setFileBusyLabel(null)
    }
  }

  return (
    <main className="mobile-app">
      <div className="mobile-shell">
        {!selectedAgent ? (
          <>
            <header className="mobile-topbar">
              <div className="mobile-brand">
                <span className="mobile-brand__label">Yive 移动端</span>
                <span className="mobile-brand__title">
                  {activeTabLabel}
                  {activeTab === 'agents' && agentCards.length > 0 ? `(${agentCards.length})` : ''}
                </span>
              </div>
              <button
                aria-expanded={workspaceSwitcherOpen}
                aria-controls="mobile-workspace-switcher"
                className="mobile-pill"
                onClick={() => setWorkspaceSwitcherOpen((open) => !open)}
                type="button"
              >
                <span>{activeWorkspace?.name ?? '选择工作区'}</span>
                <span aria-hidden>{workspaceSwitcherOpen ? '收起' : '切换'}</span>
              </button>
            </header>

            <section
              className="mobile-workspace-switcher"
              hidden={!workspaceSwitcherOpen}
              id="mobile-workspace-switcher"
              aria-labelledby="mobile-workspaces-title"
            >
              <div className="mobile-section-heading">
                <div>
                  <h1 className="mobile-section__title" id="mobile-workspaces-title">
                    当前工作区
                  </h1>
                  <p className="mobile-section__description">选择要远程查看的 Yive 工作区。</p>
                </div>
              </div>
              {workspaceState.kind === 'loading' ? (
                <div className="mobile-empty">正在加载工作区...</div>
              ) : null}
              {workspaceState.kind === 'error' ? (
                <div className="mobile-empty" role="alert">
                  {workspaceState.message}
                </div>
              ) : null}
              {workspaceState.kind === 'ready' && workspaces.length === 0 ? (
                <div className="mobile-empty">暂无工作区。请先在电脑端创建工作区。</div>
              ) : null}
              {workspaces.length > 0 ? (
                <div className="mobile-workspace-strip">
                  {workspaces.map((workspace) => (
                    <button
                      type="button"
                      className="mobile-workspace-chip"
                      data-active={workspace.id === activeWorkspaceId || undefined}
                      key={workspace.id}
                      onClick={() => handleWorkspaceSelect(workspace.id)}
                    >
                      <span className="mobile-workspace-chip__name">{workspace.name}</span>
                      <span className="mobile-workspace-chip__path">{workspace.path}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </section>

            <MobileLanStatus
              address={accessAddress}
              compact={activeTab !== 'background'}
              details={connectionDetails}
              lastRefreshAt={lastRefreshAt}
              message={connectionMessage}
              onRetry={
                workspaceState.kind === 'error' || dashboardState.kind === 'error'
                  ? retryConnection
                  : undefined
              }
              retryDisabled={retryConnectionDisabled}
              onSwitchRelayDesktop={
                runtimeSession.mode === 'relay' ? switchRelayDesktop : undefined
              }
              onDiagnose={runtimeSession.mode === 'relay' ? runRelayDiagnostics : undefined}
              runtimeLabel={runtimeLabel}
              tone={connectionTone}
            />
            <MobileNotificationPrompt
              onEnable={() => void requestMobileNotifications()}
              pendingCount={pendingNotificationCount}
              requesting={notificationRequesting}
              state={notificationState}
            />
          </>
        ) : null}

        <div
          className={selectedAgent ? 'mobile-content mobile-content--terminal' : 'mobile-content'}
        >
          {terminalPaneAgent && activeWorkspace ? (
            <div aria-hidden="false" className="mobile-terminal-keepalive">
              <MobileAgentDetail
                agent={terminalPaneAgent}
                key={`${activeWorkspace.id}:${terminalPaneAgent.id}:${JSON.stringify(runtimeSession.terminalConnectionParams ?? {})}`}
                connectionTone={connectionTone}
                connectionWarning={terminalConnectionWarning}
                onRetryConnection={terminalConnectionWarning ? retryConnection : undefined}
                retryConnectionDisabled={retryConnectionDisabled}
                runtimeClient={runtimeSession.client}
                terminalConnectionParams={runtimeSession.terminalConnectionParams}
                staleRunId={staleTerminalRunId}
                workspaceId={activeWorkspace.id}
                message={agentActionMessage}
                onFilesChanged={() => void reloadFiles()}
                onBack={() => {
                  setSelectedAgentId(null)
                  setAgentActionMessage(null)
                  setPendingAgentAction(null)
                  setDangerAction(null)
                  setStaleTerminalRunId(null)
                  setActiveTab('agents')
                  refreshDashboard()
                }}
                dangerAction={dangerAction}
                formatError={getLoadErrorMessage}
                onRefresh={refreshDashboard}
                onTerminalError={(runId, errorMessage) => {
                  if (isStaleTerminalError(errorMessage)) {
                    setStaleTerminalRunId(runId)
                    setAgentActionMessage('终端会话已失效，正在重新获取最新会话...')
                    setPendingAgentAction(null)
                    refreshDashboard()
                    return
                  }
                  setAgentActionMessage(
                    formatMobileTerminalErrorMessage(errorMessage, runtimeSession.mode)
                  )
                  setPendingAgentAction(null)
                }}
                onCancelDanger={() => setDangerAction(null)}
                onConfirmDanger={() => {
                  const action = dangerAction
                  setDangerAction(null)
                  if (action === 'stop') void handleStop(terminalPaneAgent, 'safe')
                  if (action === 'checkpoint') void handleStop(terminalPaneAgent, 'checkpoint')
                  if (action === 'force') void handleStop(terminalPaneAgent, 'force')
                  if (action === 'restart') void handleRestart(terminalPaneAgent)
                }}
                onRequestForceStop={() => setDangerAction('force')}
                onRestart={() => setDangerAction('restart')}
                onRetryAgentAction={retryPendingAgentAction}
                onStart={() => handleStart(terminalPaneAgent)}
                onStop={() => setDangerAction('stop')}
                retryAgentActionLabel={pendingAgentAction ? '重试操作' : null}
              />
            </div>
          ) : null}
          {!selectedAgent ? (
            <>
              {activeTab === 'agents' ? (
                <MobileAgentsTab
                  agentCards={agentListCards}
                  chatUnreadIndex={chatUnreadIndex}
                  dashboardState={dashboardState}
                  remoteSnapshotWarning={relaySnapshotWarning}
                  runtimeLabel={runtimeLabel}
                  summary={summary}
                  workspaceId={activeWorkspaceId ?? ''}
                  onOpenAgent={(agentId) => {
                    setSelectedAgentId(agentId)
                    setAgentActionMessage(null)
                    setPendingAgentAction(null)
                    setDangerAction(null)
                  }}
                  workspaceState={workspaceState}
                />
              ) : null}
              {activeTab === 'dispatches' ? (
                <MobileDispatchesTab
                  agentCards={agentCards}
                  dispatchActionState={dispatchActionState}
                  dispatchesState={dispatchesState}
                  onCancelDispatch={(dispatch, reason) =>
                    void handleDispatchCancel(dispatch, reason)
                  }
                  onNoteDispatch={(dispatch, text) => void handleDispatchNote(dispatch, text)}
                  onReplaceDispatch={(dispatch, text, interrupt) =>
                    void handleDispatchReplace(dispatch, text, interrupt)
                  }
                  onReportDispatch={(dispatch, text) => void handleDispatchReport(dispatch, text)}
                  onStatusDispatch={(dispatch, text) => void handleDispatchStatus(dispatch, text)}
                />
              ) : null}
              {activeTab === 'notifications' ? (
                <MobileNotificationsPanel
                  approvals={approvals}
                  notifications={agentNotifications}
                  runtimeClient={runtimeSession.client}
                  summary={summary}
                />
              ) : null}
              {activeTab === 'files' ? (
                <MobileFileExchange
                  busyLabel={fileBusyLabel}
                  disabled={fileExchangeDisabled}
                  disabledMessage={fileExchangeDisabledMessage}
                  items={fileItems}
                  downloadProgress={fileDownloadProgress}
                  downloadLink={fileDownloadLink}
                  downloadRetry={fileDownloadRetry}
                  message={fileMessage}
                  onClear={() => void handleFileClear()}
                  onDelete={(fileId) => void handleFileDelete(fileId)}
                  onDownload={(fileId) => void handleFileDownload(fileId)}
                  onReview={(fileId, decision) => void handleFileReview(fileId, decision)}
                  onUpload={(file) => void handleFileUpload(file)}
                  onWorkspaceFilePathChange={setWorkspaceFilePath}
                  onWorkspaceFileSend={() => void handleWorkspaceFileSend()}
                  workspaceFilePath={workspaceFilePath}
                />
              ) : null}
              {activeTab === 'background' ? (
                <MobileBackgroundTab
                  lastConnectionSnapshot={lastConnectionSnapshot}
                  relayConnectContext={
                    runtimeSession.mode === 'relay' && relayRuntimeStatus.tone === 'error'
                      ? {
                          desktopId: runtimeSession.relayDiagnostics.desktopId,
                          serverUrl: runtimeSession.relayDiagnostics.serverUrl,
                        }
                      : null
                  }
                  relayDiagnosticsCommands={relayRuntimeDiagnosticCommands}
                  relayDiagnosticsLines={relayRuntimeDiagnosticLines}
                  relayDiagnosticsReport={relayRuntimeDiagnosticReport ?? undefined}
                  relayInstallServerUrl={
                    runtimeSession.mode === 'relay'
                      ? runtimeSession.relayDiagnostics.serverUrl
                      : undefined
                  }
                  relayPathItems={
                    relayDiagnosticsOpen || activeTab === 'background' ? relayPathItems : []
                  }
                  showLastConnection={
                    workspaceState.kind === 'error' || dashboardState.kind === 'error'
                  }
                  onRelayDiagnosticAction={runRelayDiagnosticAction}
                />
              ) : null}
            </>
          ) : null}
        </div>

        {!selectedAgent ? (
          <nav className="mobile-bottom-tabs" aria-label="移动端分页">
            {MOBILE_TABS.map((tab) => (
              <button
                aria-current={activeTab === tab.id ? 'page' : undefined}
                data-active={activeTab === tab.id ? 'true' : undefined}
                key={tab.id}
                onClick={() => openTab(tab.id)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </nav>
        ) : null}
        <MobilePwaUpdateToast />
      </div>
    </main>
  )
}

const MobileNotificationPrompt = ({
  onEnable,
  pendingCount,
  requesting,
  state,
}: {
  onEnable: () => void
  pendingCount: number
  requesting: boolean
  state: MobileNotificationState
}) => {
  if (state === 'unsupported') return null

  if (state === 'enabled') {
    return (
      <section className="mobile-notification-prompt" data-state="enabled">
        <span>手机提醒已开启{pendingCount > 0 ? ` · ${pendingCount} 个待处理` : ''}</span>
      </section>
    )
  }

  if (state === 'denied') {
    return (
      <section className="mobile-notification-prompt" data-state="denied">
        <span>浏览器已禁止手机提醒，可在系统或浏览器设置中重新允许。</span>
      </section>
    )
  }

  return (
    <section className="mobile-notification-prompt" data-state="prompt">
      <span>离开页面时也想知道 Agent 进展，可以开启手机提醒。</span>
      <button className="mobile-text-button" disabled={requesting} onClick={onEnable} type="button">
        {requesting ? '正在开启...' : '开启手机提醒'}
      </button>
    </section>
  )
}

const MobileLastConnection = ({ snapshot }: { snapshot: MobileLastConnectionSnapshot | null }) => {
  if (!snapshot) return null
  const details = [
    snapshot.mode === 'relay' ? '云端 Relay' : '本地直连',
    ...(snapshot.desktopId ? [`电脑 ${snapshot.desktopId}`] : []),
    ...(snapshot.deviceId ? [`手机 ${snapshot.deviceId}`] : []),
    ...(snapshot.serverUrl ? [`Relay ${snapshot.serverUrl}`] : []),
    ...(snapshot.workspaceName ? [`工作区 ${snapshot.workspaceName}`] : []),
    ...(snapshot.agentCount !== undefined ? [`Agent ${snapshot.agentCount}`] : []),
    ...(snapshot.pending !== undefined && snapshot.pending > 0
      ? [`待处理 ${snapshot.pending}`]
      : []),
  ]

  return (
    <section className="mobile-last-connection" aria-label="上次连接快照">
      <div className="mobile-last-connection__top">
        <span>上次连接</span>
        <span>{formatRefreshTime(snapshot.updatedAt)}</span>
      </div>
      <div className="mobile-last-connection__details">
        {details.map((detail) => (
          <span key={detail}>{detail}</span>
        ))}
      </div>
      {snapshot.workspacePath ? <p>{snapshot.workspacePath}</p> : null}
      {snapshot.busy !== undefined ||
      snapshot.awaitingReport !== undefined ||
      snapshot.unknown !== undefined ||
      snapshot.crashed !== undefined ||
      snapshot.idle !== undefined ||
      snapshot.stopped !== undefined ? (
        <div className="mobile-last-connection__summary">
          <span>忙碌 {snapshot.busy ?? 0}</span>
          <span>等待汇报 {snapshot.awaitingReport ?? 0}</span>
          <span>空闲 {snapshot.idle ?? 0}</span>
          <span>未知 {snapshot.unknown ?? 0}</span>
          <span>崩溃 {snapshot.crashed ?? 0}</span>
          <span>已停止 {snapshot.stopped ?? 0}</span>
        </div>
      ) : null}
    </section>
  )
}

const MobileBackgroundTab = ({
  lastConnectionSnapshot,
  onRelayDiagnosticAction,
  relayConnectContext,
  relayDiagnosticsCommands,
  relayDiagnosticsLines,
  relayDiagnosticsReport,
  relayInstallServerUrl,
  relayPathItems,
  showLastConnection,
}: {
  lastConnectionSnapshot: MobileLastConnectionSnapshot | null
  onRelayDiagnosticAction?: ((actionId: string) => void) | undefined
  relayConnectContext: MobileRelayDesktopConnectGuideContext | null
  relayDiagnosticsCommands: MobileRelayDiagnosticCommand[]
  relayDiagnosticsLines: Array<{ label: string; tone: 'error' | 'ok' | 'warn' }>
  relayDiagnosticsReport?: MobileRelayDiagnosticReport | undefined
  relayInstallServerUrl?: string | undefined
  relayPathItems: MobileRelayPathItem[]
  showLastConnection: boolean
}) => (
  <section className="mobile-section" aria-labelledby="mobile-background-title">
    <div className="mobile-section-heading">
      <div>
        <h2 className="mobile-section__title" id="mobile-background-title">
          后台
        </h2>
        <p className="mobile-section__description">连接、诊断和安装相关信息。</p>
      </div>
    </div>
    {relayPathItems.length > 0 ? <MobileRelayPath items={relayPathItems} /> : null}
    {relayConnectContext ? <MobileRelayDesktopConnectGuide context={relayConnectContext} /> : null}
    {showLastConnection ? <MobileLastConnection snapshot={lastConnectionSnapshot} /> : null}
    {relayInstallServerUrl ? <MobileInstallPrompt relayServerUrl={relayInstallServerUrl} /> : null}
    {relayDiagnosticsLines.length > 0 ? (
      <MobileRelayDiagnostics
        commands={relayDiagnosticsCommands}
        lines={relayDiagnosticsLines}
        onAction={onRelayDiagnosticAction}
        report={relayDiagnosticsReport}
      />
    ) : null}
    {relayPathItems.length === 0 &&
    !relayConnectContext &&
    !showLastConnection &&
    !relayInstallServerUrl &&
    relayDiagnosticsLines.length === 0 ? (
      <div className="mobile-empty">暂无后台信息。</div>
    ) : null}
  </section>
)

const MobileLanStatus = ({
  address,
  compact = false,
  details = [],
  lastRefreshAt,
  message,
  onRetry,
  retryDisabled = false,
  onSwitchRelayDesktop,
  onDiagnose,
  runtimeLabel,
  tone,
}: {
  address: string
  compact?: boolean
  details?: string[]
  lastRefreshAt: number | null
  message: string
  onRetry?: (() => void) | undefined
  retryDisabled?: boolean
  onSwitchRelayDesktop?: (() => void) | undefined
  onDiagnose?: (() => void) | undefined
  runtimeLabel: string
  tone: MobileConnectionTone
}) => {
  const [expanded, setExpanded] = useState(false)
  if (compact) {
    return (
      <section
        className="mobile-lan-status mobile-lan-status--compact"
        data-tone={tone}
        aria-label="局域网连接状态"
      >
        <span className="mobile-lan-status__compact-label">
          <span className="mobile-lan-status__dot" aria-hidden />
          <span>{runtimeLabel}</span>
        </span>
        <span className="mobile-visually-hidden">{message}</span>
        {onRetry ? (
          <button
            className="mobile-text-button"
            disabled={retryDisabled}
            onClick={onRetry}
            type="button"
          >
            重试连接
          </button>
        ) : null}
      </section>
    )
  }

  return (
    <section
      className="mobile-lan-status"
      data-expanded={expanded ? 'true' : 'false'}
      data-tone={tone}
      aria-label="局域网连接状态"
    >
      <div className="mobile-lan-status__top">
        <span>
          <span className="mobile-lan-status__dot" aria-hidden />
          {runtimeLabel}
        </span>
        <span>刷新 {formatRefreshTime(lastRefreshAt)}</span>
      </div>
      <div className="mobile-lan-status__summary">
        <span>{message}</span>
        <div className="mobile-lan-status__summary-actions">
          {onRetry ? (
            <button
              className="mobile-text-button"
              disabled={retryDisabled}
              onClick={onRetry}
              type="button"
            >
              重试连接
            </button>
          ) : null}
          {onSwitchRelayDesktop ? (
            <button className="mobile-text-button" onClick={onSwitchRelayDesktop} type="button">
              切换电脑
            </button>
          ) : null}
          {onDiagnose ? (
            <button className="mobile-text-button" onClick={onDiagnose} type="button">
              诊断
            </button>
          ) : null}
          <button
            aria-expanded={expanded}
            className="mobile-text-button"
            onClick={() => setExpanded((value) => !value)}
            type="button"
          >
            {expanded ? '收起' : '详情'}
          </button>
        </div>
      </div>
      {expanded ? <div className="mobile-lan-status__address">{address}</div> : null}
      {expanded && details.length > 0 ? (
        <div className="mobile-lan-status__details">
          {details.map((detail) => (
            <span key={detail}>{detail}</span>
          ))}
        </div>
      ) : null}
    </section>
  )
}

const MobileAgentsTab = ({
  agentCards,
  chatUnreadIndex,
  dashboardState,
  onOpenAgent,
  remoteSnapshotWarning,
  runtimeLabel,
  summary,
  workspaceId,
  workspaceState,
}: {
  agentCards: AgentCardModel[]
  chatUnreadIndex: Record<string, number>
  dashboardState: WorkspaceDashboardState
  onOpenAgent: (agentId: string) => void
  remoteSnapshotWarning?: string | null
  runtimeLabel: string
  summary: MobileAgentSummary
  workspaceId: string
  workspaceState: WorkspaceLoadState
}) => (
  <section className="mobile-section" aria-labelledby="mobile-agents-title">
    <div className="mobile-section-heading">
      <div>
        <h2 className="mobile-section__title" id="mobile-agents-title">
          当前工作区 Agent
        </h2>
        <p className="mobile-section__description">{runtimeLabel}，点击 Agent 进入 CLI 会话。</p>
      </div>
    </div>

    {dashboardState.kind === 'loading' ? (
      <div className="mobile-empty">正在加载 Agent...</div>
    ) : null}
    {dashboardState.kind === 'error' ? (
      <div className="mobile-empty" role="alert">
        {dashboardState.message}
      </div>
    ) : null}
    {dashboardState.kind === 'idle' && workspaceState.kind === 'ready' ? (
      <div className="mobile-empty">
        {workspaceState.workspaces.length === 0
          ? '暂无工作区。请先在电脑端创建或打开项目工作区。'
          : '请选择一个工作区查看 Agent。'}
      </div>
    ) : null}
    {dashboardState.kind === 'ready' ? (
      <>
        {dashboardState.staleMessage ? (
          <div className="mobile-empty mobile-empty--warn" role="status">
            正在显示上次 Agent 状态：{dashboardState.staleMessage}
          </div>
        ) : null}
        {remoteSnapshotWarning ? (
          <div className="mobile-empty mobile-empty--warn" role="status">
            {remoteSnapshotWarning}
          </div>
        ) : null}
        <div className="mobile-agent-summary mobile-agent-summary--compact">
          <SummaryPill label="忙碌" tone="busy" value={summary.busy} />
          <SummaryPill label="等待汇报" tone="awaiting-report" value={summary.awaitingReport} />
          <SummaryPill label="空闲" tone="idle" value={summary.idle} />
          <SummaryPill label="未知" tone="unknown" value={summary.unknown} />
          <SummaryPill label="崩溃" tone="crashed" value={summary.crashed} />
          <SummaryPill label="已停止" tone="stopped" value={summary.stopped} />
        </div>
        <div className="mobile-agent-list">
          {agentCards.map((agent) => (
            <AgentCard
              agent={agent}
              key={agent.id}
              onOpen={() => onOpenAgent(agent.id)}
              unreadCount={chatUnreadIndex[`${workspaceId}:${agent.id}`] ?? 0}
            />
          ))}
        </div>
      </>
    ) : null}
  </section>
)

const MobileDispatchesTab = ({
  agentCards,
  dispatchActionState,
  dispatchesState,
  onCancelDispatch,
  onNoteDispatch,
  onReplaceDispatch,
  onReportDispatch,
  onStatusDispatch,
}: {
  agentCards: AgentCardModel[]
  dispatchActionState: MobileDispatchActionState
  dispatchesState: MobileDispatchesState
  onCancelDispatch: (dispatch: MobileDispatchItem, reason: string) => void
  onNoteDispatch: (dispatch: MobileDispatchItem, text: string) => void
  onReplaceDispatch: (dispatch: MobileDispatchItem, text: string, interrupt: boolean) => void
  onReportDispatch: (dispatch: MobileDispatchItem, text: string) => void
  onStatusDispatch: (dispatch: MobileDispatchItem, text: string) => void
}) => (
  <MobileDispatchList
    actionState={dispatchActionState}
    agents={agentCards}
    dispatchesState={dispatchesState}
    onCancel={onCancelDispatch}
    onNote={onNoteDispatch}
    onReplace={onReplaceDispatch}
    onReport={onReportDispatch}
    onStatus={onStatusDispatch}
  />
)

const formatDispatchState = (dispatch: MobileDispatchItem): string => {
  if (dispatch.state === 'queued') return '等待接收'
  if (dispatch.state === 'submitted') return '处理中'
  if (dispatch.state === 'replacement_pending') return '替换准备中'
  if (dispatch.state === 'replaced') return '已替换'
  if (dispatch.state === 'reported') {
    if (dispatch.report_outcome === 'completed') return '已完成'
    if (dispatch.report_outcome === 'failed') return '失败'
    return '已汇报'
  }
  return '已取消'
}

const formatDispatchLifecycle = (dispatch: MobileDispatchItem): string | null => {
  const lifecycle = dispatch.lifecycle
  if (!lifecycle || lifecycle.state === 'completed') return null
  if (lifecycle.state === 'blocked') {
    return lifecycle.kind === 'cancel' ? '取消受阻' : '替换受阻'
  }
  if (lifecycle.state === 'delivering_replacement') return '正在投递替换任务'
  return lifecycle.kind === 'cancel' ? '正在等待取消' : '正在等待替换'
}

const MobileDispatchList = ({
  actionState,
  agents,
  dispatchesState,
  onCancel,
  onNote,
  onReplace,
  onReport,
  onStatus,
}: {
  actionState: MobileDispatchActionState
  agents: AgentCardModel[]
  dispatchesState: MobileDispatchesState
  onCancel: (dispatch: MobileDispatchItem, reason: string) => void
  onNote: (dispatch: MobileDispatchItem, text: string) => void
  onReplace: (dispatch: MobileDispatchItem, text: string, interrupt: boolean) => void
  onReport: (dispatch: MobileDispatchItem, text: string) => void
  onStatus: (dispatch: MobileDispatchItem, text: string) => void
}) => {
  const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name]))

  return (
    <section className="mobile-section mobile-dispatches" aria-labelledby="mobile-dispatches-title">
      <div className="mobile-section-heading">
        <div>
          <h2 className="mobile-section__title" id="mobile-dispatches-title">
            派单
          </h2>
          <p className="mobile-section__description">手机端可补充说明、汇报或取消未完成派单。</p>
        </div>
      </div>
      {dispatchesState.kind === 'idle' ? (
        <div className="mobile-empty">请选择一个工作区。</div>
      ) : dispatchesState.kind === 'loading' ? (
        <div className="mobile-empty">正在加载派单...</div>
      ) : dispatchesState.kind === 'error' ? (
        <div className="mobile-empty" role="alert">
          {dispatchesState.message}
        </div>
      ) : dispatchesState.dispatches.length === 0 ? (
        <div className="mobile-terminal__empty">当前工作区还没有派单记录。</div>
      ) : (
        <div className="mobile-dispatch-list">
          {dispatchesState.dispatches.map((dispatch) => (
            <MobileDispatchRow
              actionState={actionState.dispatchId === dispatch.id ? actionState : null}
              dispatch={dispatch}
              key={dispatch.id}
              onCancel={onCancel}
              onNote={onNote}
              onReplace={onReplace}
              onReport={onReport}
              onStatus={onStatus}
              toName={agentNameById.get(dispatch.to_agent_id) ?? dispatch.to_agent_id}
            />
          ))}
        </div>
      )}
    </section>
  )
}

const MobileDispatchRow = ({
  actionState,
  dispatch,
  onCancel,
  onNote,
  onReplace,
  onReport,
  onStatus,
  toName,
}: {
  actionState: MobileDispatchActionState | null
  dispatch: MobileDispatchItem
  onCancel: (dispatch: MobileDispatchItem, reason: string) => void
  onNote: (dispatch: MobileDispatchItem, text: string) => void
  onReplace: (dispatch: MobileDispatchItem, text: string, interrupt: boolean) => void
  onReport: (dispatch: MobileDispatchItem, text: string) => void
  onStatus: (dispatch: MobileDispatchItem, text: string) => void
  toName: string
}) => {
  const [reportText, setReportText] = useState('')
  const [cancelReason, setCancelReason] = useState('')
  const [noteText, setNoteText] = useState('')
  const [replacementInterrupt, setReplacementInterrupt] = useState(false)
  const [replacementText, setReplacementText] = useState('')
  const [statusText, setStatusText] = useState('')
  const isActive = dispatch.state === 'submitted'
  const isOpen = dispatch.state === 'queued' || isActive
  const busy = Boolean(actionState?.busy)
  const lifecycleLabel = formatDispatchLifecycle(dispatch)

  return (
    <article className="mobile-dispatch-item" data-state={dispatch.state}>
      <div className="mobile-dispatch-item__top">
        <div>
          <strong>{toName}</strong>
          <span>{dispatch.id}</span>
        </div>
        <em>{formatDispatchState(dispatch)}</em>
      </div>
      <p>{dispatch.text}</p>
      {dispatch.latest_status ? (
        <div className="mobile-dispatch-item__status">
          <strong>最新进度</strong>
          <span>{dispatch.latest_status.text}</span>
          {dispatch.latest_status.artifacts.length > 0 ? (
            <small>{dispatch.latest_status.artifacts.join(' · ')}</small>
          ) : null}
        </div>
      ) : null}
      {dispatch.report_text ? <small>{dispatch.report_text}</small> : null}
      {lifecycleLabel ? (
        <div className="mobile-dispatch-item__status" role="status">
          <strong>{lifecycleLabel}</strong>
          <span>已尝试 {dispatch.lifecycle?.attempts ?? 0} 次</span>
          {dispatch.lifecycle?.error ? <small>{dispatch.lifecycle.error}</small> : null}
        </div>
      ) : null}
      {isOpen ? (
        <div className="mobile-dispatch-item__forms">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              onNote(dispatch, noteText)
            }}
          >
            <label>
              <span>补充说明</span>
              <textarea
                disabled={busy}
                onChange={(event) => setNoteText(event.currentTarget.value)}
                rows={2}
                value={noteText}
              />
            </label>
            <button className="mobile-text-button" disabled={busy} type="submit">
              {busy && actionState?.mode === 'note' ? '发送中...' : '发送补充'}
            </button>
          </form>
          {isActive ? (
            <>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  onStatus(dispatch, statusText)
                }}
              >
                <label>
                  <span>进度状态</span>
                  <input
                    disabled={busy}
                    onChange={(event) => setStatusText(event.currentTarget.value)}
                    placeholder="例如：已开始排查，预计 10 分钟"
                    value={statusText}
                  />
                </label>
                <button className="mobile-text-button" disabled={busy} type="submit">
                  {busy && actionState?.mode === 'status' ? '发送中...' : '发送进度'}
                </button>
              </form>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  onReport(dispatch, reportText)
                }}
              >
                <label>
                  <span>汇报内容</span>
                  <textarea
                    disabled={busy}
                    onChange={(event) => setReportText(event.currentTarget.value)}
                    rows={2}
                    value={reportText}
                  />
                </label>
                <button className="mobile-primary-button" disabled={busy} type="submit">
                  {busy && actionState?.mode === 'report' ? '提交中...' : '提交汇报'}
                </button>
              </form>
            </>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault()
              onReplace(dispatch, replacementText, isActive && replacementInterrupt)
            }}
          >
            <label>
              <span>替换任务</span>
              <textarea
                disabled={busy}
                onChange={(event) => setReplacementText(event.currentTarget.value)}
                rows={2}
                value={replacementText}
              />
            </label>
            {isActive ? (
              <label>
                <input
                  checked={replacementInterrupt}
                  disabled={busy}
                  onChange={(event) => setReplacementInterrupt(event.currentTarget.checked)}
                  type="checkbox"
                />
                <span>中断当前回合</span>
              </label>
            ) : null}
            <button className="mobile-text-button" disabled={busy} type="submit">
              {busy && actionState?.mode === 'replace' ? '替换中...' : '替换派单'}
            </button>
          </form>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              onCancel(dispatch, cancelReason)
            }}
          >
            <label>
              <span>取消原因</span>
              <input
                disabled={busy}
                onChange={(event) => setCancelReason(event.currentTarget.value)}
                value={cancelReason}
              />
            </label>
            <button className="mobile-danger-button" disabled={busy} type="submit">
              {busy && actionState?.mode === 'cancel' ? '取消中...' : '取消派单'}
            </button>
          </form>
        </div>
      ) : null}
      {actionState?.message ? <small role="status">{actionState.message}</small> : null}
    </article>
  )
}

const SummaryPill = ({
  label,
  tone,
  value,
}: {
  label: string
  tone: AgentStatusPresentationKind
  value: number
}) => (
  <div className="mobile-agent-summary__pill" data-tone={tone}>
    <span className="mobile-agent-summary__value">{value}</span>
    <span className="mobile-agent-summary__label">{label}</span>
  </div>
)

const AgentCard = ({
  agent,
  onOpen,
  unreadCount = 0,
}: {
  agent: AgentCardModel
  onOpen: () => void
  unreadCount?: number
}) => {
  const status = presentAgentStatus(agent)
  const identityLabel = agent.kind === 'worker' ? 'Worker' : 'Orchestrator'

  return (
    <article className="mobile-agent-card" data-kind={agent.kind} data-status={status.kind}>
      <button
        aria-label={`打开 ${agent.name} 终端`}
        className="mobile-agent-card__open"
        onClick={onOpen}
        type="button"
      >
        <div className="mobile-agent-card__identity">
          <MobileAgentAvatar
            provider={agent.provider}
            kind={agent.kind}
            size={36}
            status={status.kind}
          />
          <div className="mobile-agent-card__name-wrap">
            <h3 className="mobile-agent-card__name">{agent.name}</h3>
            <span className="mobile-agent-card__role">{identityLabel}</span>
            <span className="mobile-agent-card__role">
              {formatLastObservedAt(agent.lastObservedAt)}
            </span>
            {agent.activeDispatchId ? (
              <span className="mobile-agent-card__role">Dispatch {agent.activeDispatchId}</span>
            ) : null}
            {agent.queuedDispatchCount > 0 ? (
              <span className="mobile-agent-card__role">{agent.queuedDispatchCount} queued</span>
            ) : null}
            {unreadCount > 0 ? (
              <span className="mobile-agent-card__unread" title={`${unreadCount} 条未读回复`}>
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            ) : null}
          </div>
        </div>
        <span className="mobile-agent-status" data-status={status.kind}>
          <span className={status.dotClass} aria-hidden />
          {status.label}
        </span>
      </button>
    </article>
  )
}

const Metric = ({ label, value }: { label: string; value: string }) => (
  <div className="mobile-agent-metric">
    <span className="mobile-agent-metric__label">{label}</span>
    <span className="mobile-agent-metric__value">{value}</span>
  </div>
)

const MobileNotificationsPanel = ({
  approvals,
  notifications,
  runtimeClient,
  summary,
}: {
  approvals: ApprovalItem[]
  notifications: MobileAgentNotification[]
  runtimeClient: MobileRuntimeClient
  summary: MobileAgentSummary
}) => {
  const [imagePreviews, setImagePreviews] = useState<
    Record<
      string,
      | { name: string; state: 'error'; text: string }
      | { name: string; state: 'loading' }
      | { name: string; state: 'ready'; url: string }
    >
  >({})
  const [expandedImageId, setExpandedImageId] = useState<string | null>(null)
  const activeImageIdsRef = useRef(new Set<string>())
  const loadingImageIdsRef = useRef(new Set<string>())
  const imageUrlRevokeRef = useRef(new Map<string, () => void>())

  useEffect(() => {
    const imageNotifications = notifications.filter((item) => item.image)
    const activeImageIds = new Set(imageNotifications.map((item) => item.image?.file_id ?? ''))
    activeImageIds.delete('')
    activeImageIdsRef.current = activeImageIds
    setImagePreviews((current) => {
      const next = { ...current }
      for (const [fileId, preview] of Object.entries(current)) {
        if (activeImageIds.has(fileId)) continue
        if (preview.state === 'ready') imageUrlRevokeRef.current.get(fileId)?.()
        imageUrlRevokeRef.current.delete(fileId)
        loadingImageIdsRef.current.delete(fileId)
        delete next[fileId]
      }
      for (const item of imageNotifications) {
        if (!item.image || next[item.image.file_id]) continue
        next[item.image.file_id] = { name: item.image.name, state: 'loading' }
      }
      return next
    })

    for (const item of imageNotifications) {
      if (!item.image) continue
      const fileId = item.image.file_id
      if (loadingImageIdsRef.current.has(fileId) || imageUrlRevokeRef.current.has(fileId)) continue
      loadingImageIdsRef.current.add(fileId)
      runtimeClient
        .downloadFile(fileId)
        .then(async (file) => {
          const previewUrl = await createPreviewImageUrl(file.content)
          imageUrlRevokeRef.current.set(fileId, previewUrl.revoke)
          if (!activeImageIdsRef.current.has(fileId)) {
            previewUrl.revoke()
            imageUrlRevokeRef.current.delete(fileId)
            return
          }
          setImagePreviews((current) => ({
            ...current,
            [fileId]: { name: file.name, state: 'ready', url: previewUrl.url },
          }))
        })
        .catch((error: unknown) => {
          if (!activeImageIdsRef.current.has(fileId)) return
          setImagePreviews((current) => ({
            ...current,
            [fileId]: {
              name: item.image?.name ?? fileId,
              state: 'error',
              text: error instanceof Error ? error.message : '图片加载失败',
            },
          }))
        })
        .finally(() => {
          loadingImageIdsRef.current.delete(fileId)
        })
    }
  }, [notifications, runtimeClient])

  useEffect(
    () => () => {
      for (const revoke of imageUrlRevokeRef.current.values()) revoke()
      imageUrlRevokeRef.current.clear()
      loadingImageIdsRef.current.clear()
    },
    []
  )

  const expandedImage =
    expandedImageId && imagePreviews[expandedImageId]?.state === 'ready'
      ? imagePreviews[expandedImageId]
      : null

  return (
    <section className="mobile-approvals" aria-labelledby="mobile-approvals-title">
      <div className="mobile-section-heading">
        <div>
          <h2 className="mobile-section__title" id="mobile-approvals-title">
            通知 / 审批
          </h2>
          <p className="mobile-section__description">
            查看可能需要手机端确认的事项，避免误影响电脑端 Agent。
          </p>
        </div>
      </div>
      <div className="mobile-approval-summary">
        <Metric label="提醒" value={String(notifications.length)} />
        <Metric label="待处理" value={String(approvals.length)} />
        <Metric label="忙碌" value={String(summary.busy)} />
      </div>
      {notifications.length > 0 ? (
        <div className="mobile-agent-notification-list">
          {notifications.map((item) => {
            const preview = item.image ? imagePreviews[item.image.file_id] : undefined
            return (
              <article className="mobile-agent-notification" key={item.id}>
                <div className="mobile-agent-notification__content">
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                  {item.image ? (
                    <div className="mobile-notification-image">
                      <button
                        aria-label={`查看图片：${item.image.name}`}
                        className="mobile-notification-image__thumb"
                        disabled={preview?.state !== 'ready'}
                        onClick={() => setExpandedImageId(item.image?.file_id ?? null)}
                        type="button"
                      >
                        {preview?.state === 'ready' ? (
                          <img alt={item.image.name} src={preview.url} />
                        ) : (
                          <span>{preview?.state === 'error' ? '加载失败' : '加载中'}</span>
                        )}
                      </button>
                      <span className="mobile-notification-image__meta">
                        {item.image.name} · {formatBytes(item.image.size)}
                      </span>
                      {preview?.state === 'error' ? (
                        <span className="mobile-notification-image__error">{preview.text}</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <time dateTime={new Date(item.created_at).toISOString()}>
                  {new Date(item.created_at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </article>
            )
          })}
        </div>
      ) : (
        <div className="mobile-terminal__empty">当前没有 Agent 主动发送的提醒。</div>
      )}
      {approvals.length > 0 ? (
        <div className="mobile-approval-list">
          {approvals.map((item) => (
            <article className="mobile-approval-item" data-kind={item.kind} key={item.id}>
              <div>
                <h3>{item.title}</h3>
                <p>{item.description}</p>
              </div>
              <span>{item.agentName}</span>
            </article>
          ))}
        </div>
      ) : (
        <div className="mobile-terminal__empty">当前看板快照中没有待审批事项。</div>
      )}
      {expandedImage ? (
        <div
          aria-label={expandedImage.name}
          className="mobile-notification-image-viewer"
          onClick={() => setExpandedImageId(null)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setExpandedImageId(null)
          }}
          role="dialog"
          tabIndex={-1}
        >
          <button
            className="mobile-notification-image-viewer__close"
            onClick={() => setExpandedImageId(null)}
            type="button"
          >
            关闭
          </button>
          <img alt={expandedImage.name} src={expandedImage.url} />
        </div>
      ) : null}
    </section>
  )
}

const formatBytes = (size: number): string => {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}

const getDownloadProgressPercent = (progress: MobileFileDownloadProgressState): number | null => {
  if (!progress.totalBytes || progress.totalBytes <= 0) return null
  return Math.min(100, Math.max(0, Math.round((progress.loadedBytes / progress.totalBytes) * 100)))
}

const formatDownloadProgress = (
  progress: MobileFileDownloadProgressState,
  busyLabel: string | null
): string => {
  const percent = getDownloadProgressPercent(progress)
  const state = busyLabel === '正在下载文件...' ? '正在下载' : '下载完成'
  const total =
    progress.totalBytes && progress.totalBytes > 0 ? ` / ${formatBytes(progress.totalBytes)}` : ''
  const percentText = percent === null ? '' : ` · ${percent}%`
  return `${state} ${progress.name} · ${formatBytes(progress.loadedBytes)}${total}${percentText}`
}

const formatFileExpiry = (expiresAt: number | undefined, now = Date.now()): string | null => {
  if (typeof expiresAt !== 'number' || expiresAt <= 0) return null
  const remainingMs = expiresAt - now
  if (remainingMs <= 0) return '已过期'
  const remainingMinutes = Math.ceil(remainingMs / 60_000)
  if (remainingMinutes < 60) return `${remainingMinutes} 分钟后过期`
  const remainingHours = Math.ceil(remainingMinutes / 60)
  if (remainingHours < 24) return `${remainingHours} 小时后过期`
  const remainingDays = Math.ceil(remainingHours / 24)
  return `${remainingDays} 天后过期`
}

const getFileExpiryState = (
  expiresAt: number | undefined,
  now = Date.now()
): {
  canDownload: boolean
  label: string | null
  tone: 'expired' | 'normal' | 'soon' | 'unknown'
} => {
  if (typeof expiresAt !== 'number' || expiresAt <= 0) {
    return { canDownload: true, label: null, tone: 'unknown' }
  }
  const label = formatFileExpiry(expiresAt, now)
  if (expiresAt <= now) return { canDownload: false, label, tone: 'expired' }
  if (expiresAt - now <= 30 * 60_000) return { canDownload: true, label, tone: 'soon' }
  return { canDownload: true, label, tone: 'normal' }
}

const formatFileExchangeSource = (item: MobileFileExchangeItem): string => {
  if (item.source === 'workspace') {
    return item.workspace_path ? `来自工作区 ${item.workspace_path}` : '来自工作区'
  }
  return '手机上传'
}

const getFileReviewDecisionLabel = (decision: MobileFileReviewDecision): string => {
  if (decision === 'approved') return '通过'
  if (decision === 'needs_changes') return '需要修改'
  return '退回'
}

const MobileFileExchange = ({
  busyLabel,
  disabled,
  disabledMessage,
  downloadLink,
  downloadProgress,
  downloadRetry,
  items,
  message,
  onClear,
  onDelete,
  onDownload,
  onReview,
  onUpload,
  onWorkspaceFilePathChange,
  onWorkspaceFileSend,
  workspaceFilePath,
}: {
  busyLabel: string | null
  disabled: boolean
  disabledMessage: string | null
  downloadLink: { href: string; name: string } | null
  downloadProgress: MobileFileDownloadProgressState | null
  downloadRetry: { id: string; name: string } | null
  items: MobileFileExchangeItem[]
  message: string | null
  onClear: () => void
  onDelete: (fileId: string) => void
  onDownload: (fileId: string) => void
  onReview: (fileId: string, decision: MobileFileReviewDecision) => void
  onUpload: (file: File) => void
  onWorkspaceFilePathChange: (path: string) => void
  onWorkspaceFileSend: () => void
  workspaceFilePath: string
}) => (
  <section className="mobile-file-exchange" aria-labelledby="mobile-file-exchange-title">
    <div className="mobile-section-heading">
      <div>
        <h2 className="mobile-section__title" id="mobile-file-exchange-title">
          文件交换区
        </h2>
        <p className="mobile-section__description">
          用于临时传输 .md、.mp4、.pdf、.zip、.log 和图片；图片 10MB 内，其他文件 100MB 内。
        </p>
      </div>
      <button
        className="mobile-text-button"
        disabled={disabled || items.length === 0 || Boolean(busyLabel)}
        onClick={onClear}
        type="button"
      >
        {busyLabel === '正在清空文件...' ? '清空中...' : '清空'}
      </button>
    </div>
    <label className="mobile-file-upload">
      <span>
        {busyLabel === '正在上传文件...' ? '上传中...' : '上传 .md / .mp4 / .pdf / .zip / 图片'}
      </span>
      <input
        accept=".md,.mp4,.pdf,.zip,.log,.png,.jpg,.jpeg,.webp,text/markdown,text/plain,video/mp4,application/pdf,application/zip,image/png,image/jpeg,image/webp"
        disabled={disabled || Boolean(busyLabel)}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) onUpload(file)
        }}
        type="file"
      />
    </label>
    <div className="mobile-workspace-file-send">
      <label htmlFor="mobile-workspace-file-path">发送工作区文件到手机</label>
      <div className="mobile-workspace-file-send__row">
        <input
          autoCapitalize="off"
          autoComplete="off"
          id="mobile-workspace-file-path"
          disabled={disabled}
          onChange={(event) => onWorkspaceFilePathChange(event.currentTarget.value)}
          placeholder="例如 dist/demo.mp4 或 logs/run.log"
          spellCheck={false}
          type="text"
          value={workspaceFilePath}
        />
        <button
          className="mobile-text-button"
          disabled={disabled || workspaceFilePath.trim().length === 0 || Boolean(busyLabel)}
          onClick={onWorkspaceFileSend}
          type="button"
        >
          {busyLabel === '正在发送工作区文件...' ? '发送中...' : '发送'}
        </button>
      </div>
    </div>
    {disabledMessage ? (
      <div className="mobile-terminal__message" data-tone="error" role="status">
        {disabledMessage}
      </div>
    ) : null}
    {message ? <div className="mobile-terminal__message">{message}</div> : null}
    {downloadProgress ? (
      <div className="mobile-file-progress" role="status">
        <div className="mobile-file-progress__meta">
          <span>{formatDownloadProgress(downloadProgress, busyLabel)}</span>
        </div>
        <div
          aria-label={`${downloadProgress.name} 下载进度`}
          aria-valuemax={downloadProgress.totalBytes ?? 100}
          aria-valuemin={0}
          aria-valuenow={downloadProgress.totalBytes ? downloadProgress.loadedBytes : undefined}
          className="mobile-file-progress__track"
          role="progressbar"
        >
          <div
            className="mobile-file-progress__bar"
            data-indeterminate={downloadProgress.totalBytes ? undefined : 'true'}
            style={{
              width: `${getDownloadProgressPercent(downloadProgress) ?? 100}%`,
            }}
          />
        </div>
      </div>
    ) : null}
    {downloadRetry ? (
      <div className="mobile-file-retry" role="status">
        <span>{downloadRetry.name} 下载失败</span>
        <button
          className="mobile-text-button"
          disabled={disabled || Boolean(busyLabel)}
          onClick={() => onDownload(downloadRetry.id)}
          type="button"
        >
          重试下载
        </button>
      </div>
    ) : null}
    {downloadLink ? (
      <div className="mobile-file-download-link">
        <a download={downloadLink.name} href={downloadLink.href}>
          备用下载链接
        </a>
      </div>
    ) : null}
    {items.length === 0 ? (
      <div className="mobile-terminal__empty">临时文件交换区暂无文件。</div>
    ) : (
      <div className="mobile-file-list">
        {items.map((item) => {
          const expiry = getFileExpiryState(item.expires_at)
          return (
            <article className="mobile-file-item" data-expiry={expiry.tone} key={item.id}>
              <div>
                <h3>{item.name}</h3>
                <p>
                  {formatBytes(item.size)} · {formatFileExchangeSource(item)}
                  {expiry.label ? ` · ${expiry.label}` : ''}
                </p>
              </div>
              <div className="mobile-file-item__actions">
                <button
                  className="mobile-text-button"
                  disabled={disabled || Boolean(busyLabel) || !expiry.canDownload}
                  onClick={() => onDownload(item.id)}
                  type="button"
                >
                  {expiry.canDownload
                    ? busyLabel === '正在下载文件...'
                      ? '下载中...'
                      : '下载'
                    : '已过期'}
                </button>
                <button
                  className="mobile-text-button"
                  disabled={disabled || Boolean(busyLabel)}
                  onClick={() => onDelete(item.id)}
                  type="button"
                >
                  {busyLabel === '正在删除文件...' ? '删除中...' : '删除'}
                </button>
              </div>
              {item.source === 'workspace' ? (
                <fieldset className="mobile-file-item__review">
                  <legend className="sr-only">{item.name} 审核结果</legend>
                  <button
                    className="mobile-text-button"
                    disabled={disabled || Boolean(busyLabel)}
                    onClick={() => onReview(item.id, 'approved')}
                    type="button"
                  >
                    通过
                  </button>
                  <button
                    className="mobile-text-button"
                    disabled={disabled || Boolean(busyLabel)}
                    onClick={() => onReview(item.id, 'needs_changes')}
                    type="button"
                  >
                    需修改
                  </button>
                  <button
                    className="mobile-text-button"
                    disabled={disabled || Boolean(busyLabel)}
                    onClick={() => onReview(item.id, 'rejected')}
                    type="button"
                  >
                    退回
                  </button>
                </fieldset>
              ) : null}
            </article>
          )
        })}
      </div>
    )}
  </section>
)
