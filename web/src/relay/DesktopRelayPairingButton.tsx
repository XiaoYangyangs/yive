import * as Dialog from '@radix-ui/react-dialog'
import { Copy, LoaderCircle, RefreshCw, Smartphone, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { RelayDeviceTokenSummary } from '../../../src/shared/relay-types.js'
import type { WorkspaceSummary } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'
import {
  createRelayPairingToken,
  listRelayPairedDevices,
  normalizeRelayServerUrl,
  revokeRelayPairedDevice,
} from '../relay-api.js'
import { Tooltip } from '../ui/Tooltip.js'

type PairingLinkState =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { expiresAt: number; href: string; kind: 'ready'; token: string; ttlMs: number }
  | { kind: 'error'; message: string }

type PairedDevicesState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { devices: RelayDeviceTokenSummary[]; kind: 'ready'; message?: string }
  | { kind: 'error'; message: string }

const DEFAULT_RELAY_SERVER_URL = ''
const DEFAULT_DESKTOP_ID = 'desktop-windows'

const normalizeDesktopRelayServerUrl = (value: string): string => {
  const normalized = normalizeRelayServerUrl(value.trim()) ?? value.trim()
  return normalized
}

const getErrorMessage = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : fallback
  if (message.includes('Failed to create relay pairing token: 401')) {
    return '生成配对码失败：token 不对。这里要填服务器 /etc/yive/relay.env 里的 YIVE_RELAY_ADMIN_TOKEN；如果只是在本机桌面配对，也可以填本机 desktop-relay.env 里的 YIVE_RELAY_TOKEN。'
  }
  if (
    message.includes('Relay HTTP request failed') ||
    message.includes('Relay HTTP request timed out')
  ) {
    return `${message}。请确认 Relay 地址可访问，例如 https://relay.example.com。`
  }
  return message
}

const parseWorkspaceIds = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const buildMobilePairingUrl = ({
  desktopId,
  relayServerUrl,
  token,
  workspaceIds,
}: {
  desktopId: string
  relayServerUrl: string
  token: string
  workspaceIds: string[]
}) => {
  const url = new URL('/mobile', relayServerUrl)
  url.searchParams.set('relay', '1')
  url.searchParams.set('claim', '1')
  url.searchParams.set('server', relayServerUrl)
  url.searchParams.set('token', token)
  if (desktopId) url.searchParams.set('desktop_id', desktopId)
  for (const workspaceId of workspaceIds) url.searchParams.append('workspace_id', workspaceId)
  return url.toString()
}

const buildMobileReconnectUrl = (relayServerUrl: string) => {
  if (!relayServerUrl) return ''
  const url = new URL('/mobile', relayServerUrl)
  url.searchParams.set('relay', '1')
  return url.toString()
}

const formatExpiry = (expiresAt: number) => {
  const remainingMs = Math.max(0, expiresAt - Date.now())
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000))
  return `约 ${remainingMinutes} 分钟后过期`
}

export const DesktopRelayPairingButton = ({
  workspace,
}: {
  workspace: WorkspaceSummary | null | undefined
}) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [serverUrl, setServerUrl] = useState(DEFAULT_RELAY_SERVER_URL)
  const [adminToken, setAdminToken] = useState('')
  const [desktopId, setDesktopId] = useState(DEFAULT_DESKTOP_ID)
  const [workspaceIdsText, setWorkspaceIdsText] = useState('')
  const [pairingLink, setPairingLink] = useState<PairingLinkState>({ kind: 'idle' })
  const [devicesState, setDevicesState] = useState<PairedDevicesState>({ kind: 'idle' })
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null)
  const [copyMessage, setCopyMessage] = useState<string | null>(null)
  const [reconnectCopyMessage, setReconnectCopyMessage] = useState<string | null>(null)

  const normalizedServerUrl = useMemo(() => normalizeDesktopRelayServerUrl(serverUrl), [serverUrl])
  const canUseAdminApi = Boolean(normalizedServerUrl && adminToken.trim())
  const workspaceIds = useMemo(() => parseWorkspaceIds(workspaceIdsText), [workspaceIdsText])
  const reconnectUrl = useMemo(
    () => buildMobileReconnectUrl(normalizedServerUrl),
    [normalizedServerUrl]
  )

  const createPairing = async () => {
    if (!canUseAdminApi || pairingLink.kind === 'creating') return
    setPairingLink({ kind: 'creating' })
    setCopyMessage(null)
    try {
      const pairing = await createRelayPairingToken({
        adminToken: adminToken.trim(),
        serverUrl: normalizedServerUrl,
      })
      setPairingLink({
        expiresAt: pairing.expires_at,
        href: buildMobilePairingUrl({
          desktopId: desktopId.trim(),
          relayServerUrl: normalizedServerUrl,
          token: pairing.token,
          workspaceIds,
        }),
        kind: 'ready',
        token: pairing.token,
        ttlMs: pairing.ttl_ms,
      })
    } catch (error) {
      setPairingLink({ kind: 'error', message: getErrorMessage(error, '生成配对码失败') })
    }
  }

  const refreshDevices = async () => {
    if (!canUseAdminApi) return
    setDevicesState({ kind: 'loading' })
    try {
      const result = await listRelayPairedDevices({
        adminToken: adminToken.trim(),
        serverUrl: normalizedServerUrl,
      })
      setDevicesState({ devices: result.devices, kind: 'ready' })
    } catch (error) {
      setDevicesState({ kind: 'error', message: getErrorMessage(error, '加载已配对手机失败') })
    }
  }

  const revokeDevice = async (deviceId: string) => {
    if (!canUseAdminApi || revokingDeviceId) return
    setRevokingDeviceId(deviceId)
    try {
      await revokeRelayPairedDevice({
        adminToken: adminToken.trim(),
        deviceId,
        serverUrl: normalizedServerUrl,
      })
      const result = await listRelayPairedDevices({
        adminToken: adminToken.trim(),
        serverUrl: normalizedServerUrl,
      })
      setDevicesState({ devices: result.devices, kind: 'ready', message: `已撤销 ${deviceId}` })
    } catch (error) {
      setDevicesState({ kind: 'error', message: getErrorMessage(error, '撤销手机失败') })
    } finally {
      setRevokingDeviceId(null)
    }
  }

  const copyPairingLink = async () => {
    if (pairingLink.kind !== 'ready') return
    try {
      await navigator.clipboard.writeText(pairingLink.href)
      setCopyMessage('已复制配对链接')
    } catch {
      setCopyMessage('复制失败，请手动复制')
    }
  }

  const copyReconnectLink = async () => {
    try {
      await navigator.clipboard.writeText(reconnectUrl)
      setReconnectCopyMessage('已复制固定入口')
    } catch {
      setReconnectCopyMessage('复制失败，请手动复制')
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Tooltip label={t('relayPairing.button')}>
        <Dialog.Trigger asChild>
          <button
            type="button"
            aria-label={t('relayPairing.button')}
            data-testid="topbar-mobile-pairing"
            className="flex h-7 cursor-pointer items-center gap-1 rounded border px-2 text-xs font-medium text-ter transition-colors hover:bg-3 hover:text-pri focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
          >
            <Smartphone size={13} aria-hidden />
            <span>{t('relayPairing.button')}</span>
          </button>
        </Dialog.Trigger>
      </Tooltip>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            className="dialog-scale-pop elev-2 flex max-h-[calc(100vh-32px)] w-[720px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-lg border"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
          >
            <div
              className="flex items-start justify-between gap-4 border-b p-5"
              style={{ borderColor: 'var(--border)' }}
            >
              <div>
                <Dialog.Title className="text-lg font-semibold text-pri">
                  {t('relayPairing.title')}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-ter">
                  {t('relayPairing.description')}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="关闭手机配对"
                  className="flex h-8 w-8 items-center justify-center rounded border text-ter hover:bg-3 hover:text-pri"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <X size={16} aria-hidden />
                </button>
              </Dialog.Close>
            </div>

            <div className="grid min-h-0 gap-5 overflow-auto p-5 md:grid-cols-[1fr_280px]">
              <section className="space-y-4">
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-sec">{t('relayPairing.relayUrl')}</span>
                  <input
                    className="input"
                    onChange={(event) => {
                      setServerUrl(event.currentTarget.value)
                      setPairingLink({ kind: 'idle' })
                    }}
                    placeholder="https://relay.example.com"
                    type="url"
                    value={serverUrl}
                  />
                </label>
                {serverUrl.trim() && normalizedServerUrl !== serverUrl.trim() ? (
                  <div className="rounded border px-3 py-2 text-xs text-ter">
                    将使用可访问地址：{normalizedServerUrl}
                  </div>
                ) : null}
                <div
                  className="space-y-2 rounded border p-3"
                  data-testid="desktop-relay-reconnect"
                  style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
                >
                  <div>
                    <div className="text-xs font-medium text-sec">第二次连接</div>
                    <p className="mt-1 text-xs text-ter">
                      手机首次配对成功后，以后直接打开这个固定入口，不需要再次输入配对码。
                    </p>
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <input
                      aria-label="手机固定连接地址"
                      className="input input--readonly min-w-0 flex-1"
                      readOnly
                      value={reconnectUrl || '填写 Relay 地址后生成固定入口'}
                    />
                    <button
                      type="button"
                      aria-label="复制手机固定连接地址"
                      onClick={() => void copyReconnectLink()}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded border text-ter hover:bg-3 hover:text-pri"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <Copy size={14} aria-hidden />
                    </button>
                  </div>
                  {reconnectCopyMessage ? (
                    <span className="text-xs text-accent" role="status">
                      {reconnectCopyMessage}
                    </span>
                  ) : null}
                </div>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-sec">
                    {t('relayPairing.adminToken')}
                  </span>
                  <input
                    className="input"
                    onChange={(event) => {
                      setAdminToken(event.currentTarget.value)
                      setPairingLink({ kind: 'idle' })
                    }}
                    placeholder="输入服务器 YIVE_RELAY_ADMIN_TOKEN"
                    type="password"
                    value={adminToken}
                  />
                </label>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-sec">
                      {t('relayPairing.desktopId')}
                    </span>
                    <input
                      className="input"
                      onChange={(event) => {
                        setDesktopId(event.currentTarget.value)
                        setPairingLink({ kind: 'idle' })
                      }}
                      placeholder="desktop-windows"
                      value={desktopId}
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-sec">
                      {t('relayPairing.workspaceIds')}
                    </span>
                    <input
                      aria-label={t('relayPairing.workspaceIds')}
                      className="input"
                      onChange={(event) => {
                        setWorkspaceIdsText(event.currentTarget.value)
                        setPairingLink({ kind: 'idle' })
                      }}
                      placeholder={
                        workspace?.id
                          ? `留空共享全部；填 ${workspace.id} 可只共享当前工作区`
                          : '留空共享全部工作区'
                      }
                      value={workspaceIdsText}
                    />
                    <span className="block text-[11px] leading-4 text-ter">
                      默认共享全部工作区；只有需要限制手机访问范围时才填写工作区 ID。
                    </span>
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={!canUseAdminApi || pairingLink.kind === 'creating'}
                    onClick={() => void createPairing()}
                    className="flex h-8 items-center gap-2 rounded border px-3 text-sm font-medium text-pri hover:bg-3 disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
                  >
                    {pairingLink.kind === 'creating' ? (
                      <LoaderCircle size={14} className="animate-spin" aria-hidden />
                    ) : (
                      <Smartphone size={14} aria-hidden />
                    )}
                    {pairingLink.kind === 'creating' ? '生成中...' : t('relayPairing.createCode')}
                  </button>
                  <button
                    type="button"
                    disabled={!canUseAdminApi || devicesState.kind === 'loading'}
                    onClick={() => void refreshDevices()}
                    className="flex h-8 items-center gap-2 rounded border px-3 text-sm font-medium text-ter hover:bg-3 hover:text-pri disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <RefreshCw
                      size={14}
                      className={devicesState.kind === 'loading' ? 'animate-spin' : undefined}
                      aria-hidden
                    />
                    {t('relayPairing.refresh')}
                  </button>
                </div>

                {pairingLink.kind === 'ready' ? (
                  <div
                    className="space-y-3 rounded border p-3"
                    style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
                    data-testid="desktop-relay-pairing-result"
                  >
                    <div>
                      <span className="text-xs font-medium text-sec">配对码</span>
                      <div className="mt-1 rounded border px-3 py-2 font-mono text-sm text-pri">
                        {pairingLink.token}
                      </div>
                    </div>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-sec">配对链接</span>
                      <input className="input input--readonly" readOnly value={pairingLink.href} />
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void copyPairingLink()}
                        className="flex h-8 items-center gap-2 rounded border px-3 text-sm font-medium text-ter hover:bg-3 hover:text-pri"
                        style={{ borderColor: 'var(--border)' }}
                      >
                        <Copy size={14} aria-hidden />
                        复制链接
                      </button>
                      <span className="text-xs text-ter">
                        {formatExpiry(pairingLink.expiresAt)}
                      </span>
                      {copyMessage ? (
                        <span className="text-xs text-accent" role="status">
                          {copyMessage}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {pairingLink.kind === 'error' ? (
                  <div className="rounded border px-3 py-2 text-sm text-red-300" role="alert">
                    {pairingLink.message}
                  </div>
                ) : null}
              </section>

              <section className="min-w-0 space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-pri">
                    {t('relayPairing.pairedDevices')}
                  </h3>
                  <p className="mt-1 text-xs text-ter">可撤销测试设备或朋友设备的访问权限。</p>
                </div>
                {devicesState.kind === 'idle' ? (
                  <div
                    className="rounded border p-3 text-sm text-ter"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    输入管理员 token 后刷新列表。
                  </div>
                ) : null}
                {devicesState.kind === 'loading' ? (
                  <div
                    className="rounded border p-3 text-sm text-ter"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    正在加载...
                  </div>
                ) : null}
                {devicesState.kind === 'error' ? (
                  <div className="rounded border p-3 text-sm text-red-300" role="alert">
                    {devicesState.message}
                  </div>
                ) : null}
                {devicesState.kind === 'ready' && devicesState.message ? (
                  <div className="rounded border p-3 text-sm text-accent" role="status">
                    {devicesState.message}
                  </div>
                ) : null}
                {devicesState.kind === 'ready' && devicesState.devices.length === 0 ? (
                  <div
                    className="rounded border p-3 text-sm text-ter"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    {t('relayPairing.noDevices')}
                  </div>
                ) : null}
                {devicesState.kind === 'ready' && devicesState.devices.length > 0 ? (
                  <div className="space-y-2" data-testid="desktop-relay-paired-devices">
                    {devicesState.devices.map((device) => (
                      <div
                        key={`${device.device_id}:${device.token_hint}`}
                        className="rounded border p-3"
                        style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
                      >
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-pri">
                              {device.device_id}
                            </div>
                            <div className="mt-1 space-y-0.5 text-xs text-ter">
                              <div>token {device.token_hint}</div>
                              {device.desktop_id ? <div>电脑 {device.desktop_id}</div> : null}
                              {device.workspace_ids && device.workspace_ids.length > 0 ? (
                                <div>工作区 {device.workspace_ids.join(', ')}</div>
                              ) : null}
                            </div>
                          </div>
                          <button
                            type="button"
                            aria-label={`撤销 ${device.device_id}`}
                            disabled={Boolean(revokingDeviceId)}
                            onClick={() => void revokeDevice(device.device_id)}
                            className="flex h-8 w-8 items-center justify-center rounded border text-ter hover:bg-3 hover:text-pri disabled:cursor-not-allowed disabled:opacity-50"
                            style={{ borderColor: 'var(--border)' }}
                          >
                            {revokingDeviceId === device.device_id ? (
                              <LoaderCircle size={14} className="animate-spin" aria-hidden />
                            ) : (
                              <Trash2 size={14} aria-hidden />
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
