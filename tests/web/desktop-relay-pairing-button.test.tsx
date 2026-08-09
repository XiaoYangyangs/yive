// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { I18nProvider } from '../../web/src/i18n.js'
import { DesktopRelayPairingButton } from '../../web/src/relay/DesktopRelayPairingButton.js'
import { Toaster } from '../../web/src/ui/toast.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'

const wrap = (children: ReactNode) => (
  <I18nProvider>
    <ToastProvider>
      {children}
      <Toaster />
    </ToastProvider>
  </I18nProvider>
)

const mkResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  })

beforeEach(() => {
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('DesktopRelayPairingButton', () => {
  test('uses the configured relay address and shares all workspaces by default', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
      return mkResponse({ expires_at: 1_700_000_000_000, token: 'pair-123', ttl_ms: 300000 })
    })

    render(wrap(<DesktopRelayPairingButton workspace={{ id: 'ws-1', name: 'Alpha', path: '/' }} />))

    fireEvent.click(screen.getByTestId('topbar-mobile-pairing'))
    const dialog = await screen.findByRole('dialog', { name: 'Phone pairing' })
    fireEvent.change(within(dialog).getByLabelText('Relay URL'), {
      target: { value: 'https://relay.example.com' },
    })
    fireEvent.change(within(dialog).getByLabelText('Admin token'), {
      target: { value: 'admin-token' },
    })
    expect(within(dialog).getByLabelText('Workspace ids')).toHaveValue('')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create pairing code' }))

    expect(await within(dialog).findByText('pair-123')).toBeInTheDocument()
    expect(calls).toEqual(['POST https://relay.example.com/pairings'])
    expect(
      within(dialog).getByDisplayValue(
        'https://relay.example.com/mobile?relay=1&claim=1&server=https%3A%2F%2Frelay.example.com&token=pair-123&desktop_id=desktop-windows'
      )
    ).toBeInTheDocument()
  })

  test('adds workspace scope only when explicitly requested', async () => {
    vi.stubGlobal('fetch', async () =>
      mkResponse({ expires_at: 1_700_000_000_000, token: 'pair-123', ttl_ms: 300000 })
    )

    render(wrap(<DesktopRelayPairingButton workspace={{ id: 'ws-1', name: 'Alpha', path: '/' }} />))

    fireEvent.click(screen.getByTestId('topbar-mobile-pairing'))
    const dialog = await screen.findByRole('dialog', { name: 'Phone pairing' })
    fireEvent.change(within(dialog).getByLabelText('Relay URL'), {
      target: { value: 'https://relay.example.com' },
    })
    fireEvent.change(within(dialog).getByLabelText('Admin token'), {
      target: { value: 'admin-token' },
    })
    fireEvent.change(within(dialog).getByLabelText('Workspace ids'), {
      target: { value: 'ws-1, ws-2' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create pairing code' }))

    expect(await within(dialog).findByText('pair-123')).toBeInTheDocument()
    expect(
      within(dialog).getByDisplayValue(
        'https://relay.example.com/mobile?relay=1&claim=1&server=https%3A%2F%2Frelay.example.com&token=pair-123&desktop_id=desktop-windows&workspace_id=ws-1&workspace_id=ws-2'
      )
    ).toBeInTheDocument()
  })

  test('shows the fixed reconnect URL that phones use after the first pairing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(wrap(<DesktopRelayPairingButton workspace={{ id: 'ws-1', name: 'Alpha', path: '/' }} />))

    fireEvent.click(screen.getByTestId('topbar-mobile-pairing'))
    const dialog = await screen.findByRole('dialog', { name: 'Phone pairing' })

    expect(within(dialog).getByText('第二次连接')).toBeInTheDocument()
    expect(within(dialog).getByDisplayValue('填写 Relay 地址后生成固定入口')).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('Relay URL'), {
      target: { value: 'https://relay.example.com' },
    })
    expect(
      within(dialog).getByDisplayValue('https://relay.example.com/mobile?relay=1')
    ).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: '复制手机固定连接地址' }))

    expect(writeText).toHaveBeenCalledWith('https://relay.example.com/mobile?relay=1')
    expect(await within(dialog).findByText('已复制固定入口')).toBeInTheDocument()
  })

  test('normalizes relay server URLs without private deployment rewrites', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
      return mkResponse({ expires_at: 1_700_000_000_000, token: 'pair-123', ttl_ms: 300000 })
    })

    render(wrap(<DesktopRelayPairingButton workspace={{ id: 'ws-1', name: 'Alpha', path: '/' }} />))

    fireEvent.click(screen.getByTestId('topbar-mobile-pairing'))
    const dialog = await screen.findByRole('dialog', { name: 'Phone pairing' })
    fireEvent.change(within(dialog).getByLabelText('Relay URL'), {
      target: { value: 'relay.example.com' },
    })
    expect(
      await within(dialog).findByText('将使用可访问地址：https://relay.example.com')
    ).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('Admin token'), {
      target: { value: 'admin-token' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create pairing code' }))

    expect(await within(dialog).findByText('pair-123')).toBeInTheDocument()
    expect(calls).toEqual(['POST https://relay.example.com/pairings'])

    fireEvent.change(within(dialog).getByLabelText('Relay URL'), {
      target: { value: 'http://203.0.113.10:4020' },
    })
    expect(
      within(dialog).getByDisplayValue('http://203.0.113.10:4020/mobile?relay=1')
    ).toBeInTheDocument()
  })

  test('creates a pairing code and lists paired devices', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (url.endsWith('/pairings') && method === 'POST') {
        return mkResponse({ expires_at: 1_700_000_000_000, token: 'pair-123', ttl_ms: 300000 })
      }
      if (url.endsWith('/pairings/devices') && method === 'GET') {
        return mkResponse({
          devices: [
            {
              device_id: 'phone-1',
              token_hint: 'abcd1234',
              desktop_id: 'desktop-windows',
              device_kind: 'mobile',
              workspace_ids: ['ws-1'],
            },
          ],
        })
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    })

    render(wrap(<DesktopRelayPairingButton workspace={{ id: 'ws-1', name: 'Alpha', path: '/' }} />))

    fireEvent.click(screen.getByTestId('topbar-mobile-pairing'))
    const dialog = await screen.findByRole('dialog', { name: 'Phone pairing' })
    fireEvent.change(within(dialog).getByLabelText('Relay URL'), {
      target: { value: 'https://relay.example' },
    })
    fireEvent.change(within(dialog).getByLabelText('Admin token'), {
      target: { value: 'admin-token' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create pairing code' }))

    expect(await within(dialog).findByText('pair-123')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh paired devices' }))
    expect(await within(dialog).findByText('phone-1')).toBeInTheDocument()
    expect(within(dialog).getByText('token abcd1234')).toBeInTheDocument()
  })

  test('revoke removes a paired device', async () => {
    let deviceListCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (url.endsWith('/pairings') && method === 'POST') {
        return mkResponse({ expires_at: 1_700_000_000_000, token: 'pair-123', ttl_ms: 300000 })
      }
      if (url.endsWith('/pairings/devices') && method === 'GET') {
        deviceListCalls += 1
        return mkResponse({
          devices:
            deviceListCalls === 1
              ? [
                  {
                    device_id: 'phone-1',
                    token_hint: 'abcd1234',
                  },
                ]
              : [],
        })
      }
      if (url.includes('/pairings/devices/phone-1') && method === 'DELETE') {
        return mkResponse({ device_id: 'phone-1', revoked: true })
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    })

    render(wrap(<DesktopRelayPairingButton workspace={{ id: 'ws-1', name: 'Alpha', path: '/' }} />))

    fireEvent.click(screen.getByTestId('topbar-mobile-pairing'))
    const dialog = await screen.findByRole('dialog', { name: 'Phone pairing' })
    fireEvent.change(within(dialog).getByLabelText('Relay URL'), {
      target: { value: 'https://relay.example' },
    })
    fireEvent.change(within(dialog).getByLabelText('Admin token'), {
      target: { value: 'admin-token' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh paired devices' }))
    expect(await within(dialog).findByText('phone-1')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: '撤销 phone-1' }))

    expect(await within(dialog).findByText('已撤销 phone-1')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(dialog).getByText('No paired phones yet.')).toBeInTheDocument()
    )
  })
})
