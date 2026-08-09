// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const terminalViewProps = vi.hoisted<
  Array<{
    autoTakeover?: boolean
    connectionParams?: Record<string, number | string | undefined>
    fitToContainer?: boolean
    initialSize?: { cols: number; rows: number }
    inputProfile?: string
    minimumSize?: { cols: number; rows: number }
    onError?: ((message: string) => void) | undefined
    onOwnershipChange?:
      | ((state: {
          mode: string
          ownedByThisClient: boolean
          ownerClientId: string | null
        }) => void)
      | undefined
    propagateResize?: boolean
    portalId?: string
    runId: string
    scrollFrameRatePreference?: string
    title: string
    touchScrollTarget?: HTMLElement
    viewerMode?: string
    workspaceId?: string
  }>
>(() => [])

const preloadTerminalAssetsMock = vi.hoisted(() => vi.fn(async () => ({})))
const disposeTerminalConnectionPreloadMock = vi.hoisted(() => vi.fn())
const preloadTerminalConnectionMock = vi.hoisted(() =>
  vi.fn(() => ({ dispose: disposeTerminalConnectionPreloadMock }))
)

type MockTerminalViewProps = {
  autoTakeover?: boolean
  connectionParams?: Record<string, number | string | undefined>
  fitToContainer?: boolean
  initialSize?: { cols: number; rows: number }
  inputProfile?: string
  minimumSize?: { cols: number; rows: number }
  onError?: ((message: string) => void) | undefined
  onOwnershipChange?:
    | ((state: { mode: string; ownedByThisClient: boolean; ownerClientId: string | null }) => void)
    | undefined
  portalId?: string
  propagateResize?: boolean
  runId: string
  scrollFrameRatePreference?: string
  title: string
  touchScrollTarget?: HTMLElement
  viewerMode?: string
  workspaceId?: string
}

vi.mock('../../web/src/terminal/TerminalView.js', () => ({
  TerminalView: (props: MockTerminalViewProps) => {
    terminalViewProps.push(props)
    return <div data-testid={`mock-terminal-${props.runId}`}>{props.title}</div>
  },
}))

vi.mock('../../web/src/terminal/preloadTerminalAssets.js', () => ({
  preloadTerminalAssets: preloadTerminalAssetsMock,
}))

vi.mock('../../web/src/terminal/terminal-client.js', () => ({
  preloadTerminalConnection: preloadTerminalConnectionMock,
}))

import { App } from '../../web/src/app.js'
import {
  __resetServiceWorkerUpdateStateForTests,
  __setServiceWorkerUpdateForTests,
} from '../../web/src/pwa/register-service-worker.js'

const REMOTE_CONTROL_FEATURES = [
  'mobile_confirmations',
  'mobile_events',
  'mobile_file_exchange',
  'terminal_proxy',
]

const json = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
  }) as Response

const failure = (status: number, body: unknown): Response =>
  ({
    clone: () => failure(status, body),
    ok: false,
    status,
    json: async () => body,
  }) as Response

const getLanStatus = () => screen.getByLabelText('局域网连接状态')

const getBottomTabs = () => screen.getByRole('navigation', { name: '移动端分页' })

const getBottomTab = (name: string) => within(getBottomTabs()).getByRole('button', { name })

const expandLanStatusDetails = () => {
  let lanStatus = getLanStatus()
  const detailsButton = within(lanStatus).queryByRole('button', { name: '详情' })
  if (detailsButton) {
    fireEvent.click(detailsButton)
  } else {
    fireEvent.click(getBottomTab('后台'))
    lanStatus = getLanStatus()
    const backgroundDetailsButton = within(lanStatus).queryByRole('button', { name: '详情' })
    if (backgroundDetailsButton) fireEvent.click(backgroundDetailsButton)
  }
  return lanStatus
}

const openBackgroundTab = () => {
  fireEvent.click(getBottomTab('后台'))
}

class MockRelayWebSocket {
  static OPEN = 1
  static instances: MockRelayWebSocket[] = []
  static sent: Record<string, unknown>[] = []
  static urls: string[] = []
  static workspaces = [{ id: 'workspace-1', name: 'Relay Workspace', path: '/relay/work' }]

  readyState = 0
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  constructor(readonly url: string) {
    MockRelayWebSocket.instances.push(this)
    MockRelayWebSocket.urls.push(url)
    queueMicrotask(() => {
      this.readyState = MockRelayWebSocket.OPEN
      this.dispatch('open', new Event('open'))
    })
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string): void {
    const envelope = JSON.parse(data) as Record<string, unknown>
    MockRelayWebSocket.sent.push(envelope)
    const response =
      envelope.type === 'list_workspaces'
        ? {
            payload: {
              workspaces: MockRelayWebSocket.workspaces,
            },
            type: 'list_workspaces_result',
          }
        : envelope.type === 'mobile_action'
          ? {
              payload: {
                action_id:
                  typeof envelope.payload === 'object' &&
                  envelope.payload !== null &&
                  'action_id' in envelope.payload
                    ? envelope.payload.action_id
                    : 'action-1',
                kind:
                  typeof envelope.payload === 'object' &&
                  envelope.payload !== null &&
                  'kind' in envelope.payload
                    ? envelope.payload.kind
                    : 'unknown',
                ok: true,
                result: { dispatch_id: 'dispatch-relay-1', to: 'Remote Worker' },
                workspace_id: 'workspace-1',
              },
              type: 'mobile_action_result',
            }
          : envelope.type === 'list_dispatches'
            ? {
                payload: {
                  dispatches: [
                    {
                      artifacts: [],
                      created_at: 1,
                      delivered_at: null,
                      from_agent_id: 'workspace-1:orchestrator',
                      id: 'dispatch-relay-open',
                      latest_status: {
                        artifacts: ['relay-progress.md'],
                        notify: false,
                        request_id: 'relay-status-1',
                        text: 'Relay persisted progress.',
                        updated_at: 2,
                      },
                      reported_at: null,
                      report_outcome: null,
                      report_text: null,
                      state: 'submitted',
                      submitted_at: 2,
                      text: 'Relay dispatch waiting for phone report.',
                      to_agent_id: 'worker-1',
                      workspace_id: 'workspace-1',
                    },
                    {
                      artifacts: [],
                      created_at: 3,
                      delivered_at: 4,
                      from_agent_id: 'workspace-1:orchestrator',
                      id: 'dispatch-relay-failed',
                      reported_at: 5,
                      report_outcome: 'failed',
                      report_text: 'Relay failure result.',
                      state: 'reported',
                      submitted_at: 4,
                      text: 'Historical failed Relay dispatch.',
                      to_agent_id: 'worker-1',
                      workspace_id: 'workspace-1',
                    },
                  ],
                  workspace_id: 'workspace-1',
                },
                type: 'list_dispatches_result',
              }
            : envelope.type === 'list_mobile_files'
              ? {
                  payload: [],
                  type: 'list_mobile_files_result',
                }
              : {
                  payload: {
                    agents: [
                      {
                        active_dispatch_id: null,
                        conversation_activity: 'busy',
                        provider: 'codex',
                        id: 'worker-1',
                        last_observed_at: 1,
                        last_pty_line: 'relay ready',
                        name: 'Remote Worker',
                        process_state: 'running',
                        queue_pause_reason: null,
                        queued_dispatch_count: 1,
                        kind: 'worker',
                      },
                    ],
                    runs: [
                      {
                        agent_id: 'worker-1',
                        agent_name: 'Remote Worker',
                        run_id: 'run-relay',
                        status: 'running',
                      },
                    ],
                    workspace_id: 'workspace-1',
                  },
                  type: 'list_agents_and_runs_result',
                }
    this.dispatch(
      'message',
      new MessageEvent('message', {
        data: JSON.stringify({
          channel: envelope.channel,
          from: envelope.to,
          request_id: envelope.request_id,
          to: envelope.from,
          ...response,
        }),
      })
    )
  }

  close(): void {
    this.readyState = 3
    this.dispatch('close', new Event('close'))
  }

  receive(envelope: Record<string, unknown>): void {
    this.dispatch(
      'message',
      new MessageEvent('message', {
        data: JSON.stringify(envelope),
      })
    )
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

class FailingRelayWebSocket {
  static OPEN = 1
  static sent: Record<string, unknown>[] = []
  static urls: string[] = []

  readyState = 0
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  constructor(readonly url: string) {
    FailingRelayWebSocket.urls.push(url)
    queueMicrotask(() => {
      this.readyState = FailingRelayWebSocket.OPEN
      this.dispatch('open', new Event('open'))
    })
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string): void {
    const envelope = JSON.parse(data) as Record<string, unknown>
    FailingRelayWebSocket.sent.push(envelope)
    this.dispatch(
      'message',
      new MessageEvent('message', {
        data: JSON.stringify({
          channel: envelope.channel,
          from: 'relay',
          payload: {
            code: 'desktop_runtime_unavailable',
            desktop_id: envelope.to,
            message: 'Desktop runtime unavailable',
          },
          request_id: envelope.request_id,
          to: envelope.from,
          type: 'relay_error',
        }),
      })
    )
  }

  close(): void {
    this.readyState = 3
    this.dispatch('close', new Event('close'))
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

class InterruptingOnceRelayWebSocket {
  static OPEN = 1
  static interruptNextWorkspaceRequest = true
  static sent: Record<string, unknown>[] = []
  static urls: string[] = []

  readyState = 0
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  constructor(readonly url: string) {
    InterruptingOnceRelayWebSocket.urls.push(url)
    queueMicrotask(() => {
      this.readyState = InterruptingOnceRelayWebSocket.OPEN
      this.dispatch('open', new Event('open'))
    })
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string): void {
    const envelope = JSON.parse(data) as Record<string, unknown>
    InterruptingOnceRelayWebSocket.sent.push(envelope)
    if (
      InterruptingOnceRelayWebSocket.interruptNextWorkspaceRequest &&
      envelope.type === 'list_workspaces'
    ) {
      InterruptingOnceRelayWebSocket.interruptNextWorkspaceRequest = false
      this.readyState = 3
      this.dispatch('close', new CloseEvent('close', { reason: 'network changed' }))
      return
    }
    const response =
      envelope.type === 'list_workspaces'
        ? {
            payload: {
              workspaces: [
                { id: 'workspace-1', name: 'Recovered Relay', path: '/relay/recovered' },
              ],
            },
            type: 'list_workspaces_result',
          }
        : envelope.type === 'list_mobile_files'
          ? {
              payload: [],
              type: 'list_mobile_files_result',
            }
          : {
              payload: {
                agents: [],
                runs: [],
                workspace_id: 'workspace-1',
              },
              type: 'list_agents_and_runs_result',
            }
    this.dispatch(
      'message',
      new MessageEvent('message', {
        data: JSON.stringify({
          channel: envelope.channel,
          from: envelope.to,
          request_id: envelope.request_id,
          to: envelope.from,
          ...response,
        }),
      })
    )
  }

  close(): void {
    this.readyState = 3
    this.dispatch('close', new Event('close'))
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

class LocalRuntimeErrorRelayWebSocket {
  static OPEN = 1
  static sent: Record<string, unknown>[] = []
  static urls: string[] = []

  readyState = 0
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  constructor(readonly url: string) {
    LocalRuntimeErrorRelayWebSocket.urls.push(url)
    queueMicrotask(() => {
      this.readyState = LocalRuntimeErrorRelayWebSocket.OPEN
      this.dispatch('open', new Event('open'))
    })
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string): void {
    const envelope = JSON.parse(data) as Record<string, unknown>
    LocalRuntimeErrorRelayWebSocket.sent.push(envelope)
    this.dispatch(
      'message',
      new MessageEvent('message', {
        data: JSON.stringify({
          channel: envelope.channel,
          from: 'desktop-1',
          payload: {
            code: 'local_runtime_error',
            desktop_id: 'desktop-1',
            message: 'Local runtime request timed out after 15000ms',
          },
          request_id: envelope.request_id,
          to: envelope.from,
          type: 'relay_error',
        }),
      })
    )
  }

  close(): void {
    this.readyState = 3
    this.dispatch('close', new Event('close'))
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

class MockMobileEventsWebSocket {
  static instances: MockMobileEventsWebSocket[] = []
  static urls: string[] = []

  onclose: ((event: CloseEvent | Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  readyState = 0

  constructor(readonly url: string) {
    MockMobileEventsWebSocket.instances.push(this)
    MockMobileEventsWebSocket.urls.push(url)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.(new Event('open'))
    })
  }

  close(): void {
    this.readyState = 3
    this.onclose?.(new Event('close'))
  }

  receive(payload: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }))
  }
}

const workerPayload = ({
  conversationActivity = 'busy',
  id = 'worker-1',
  name = 'Safe Worker',
  processState = 'running',
  queuedDispatchCount = 0,
}: {
  conversationActivity?: 'busy' | 'idle' | 'unknown'
  id?: string
  name?: string
  processState?: 'crashed' | 'running' | 'stopped'
  queuedDispatchCount?: number
} = {}) => ({
  active_dispatch_id: null,
  provider: 'codex',
  conversation_activity: conversationActivity,
  conversation_provider: 'codex',
  id,
  last_observed_at: 1,
  last_pty_line: 'ready',
  name,
  kind: 'worker',
  process_state: processState,
  queue_pause_reason: null,
  queued_dispatch_count: queuedDispatchCount,
})

const orchestratorPayload = () => ({
  active_dispatch_id: null,
  active_run_id: null,
  conversation_activity: 'idle',
  id: 'workspace-1:orchestrator',
  kind: 'orchestrator',
  last_observed_at: 1,
  last_pty_line: null,
  name: 'Orchestrator',
  process_state: 'running',
  queue_pause_reason: null,
  queued_dispatch_count: 0,
})

const runPayload = ({
  agentId = 'worker-1',
  agentName = 'Safe Worker',
  runId = 'run-worker',
  status = 'running',
}: {
  agentId?: string
  agentName?: string
  runId?: string
  status?: string
} = {}) => ({
  agent_id: agentId,
  agent_name: agentName,
  run_id: runId,
  status,
})

const stringifyCall = (call: {
  body?: unknown
  headers?: HeadersInit
  method?: string
  url: string
}) => JSON.stringify(call)

const openWorkerTerminal = async (name = 'Safe Worker') => {
  fireEvent.click(getBottomTab('Agent'))
  const buttons = await screen.findAllByRole('button', {
    name: (_, element) => element?.getAttribute('aria-label')?.includes(name) ?? false,
  })
  const button = buttons[buttons.length - 1]
  if (!button) throw new Error('Expected an agent terminal button')
  fireEvent.click(button)
  fireEvent.click(await screen.findByRole('button', { name: '打开更多操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '终端' }))
}

const openTerminalTools = async () => {
  const confirmTakeoverButton = screen.queryByRole('button', { name: '确认接管' })
  if (confirmTakeoverButton) {
    fireEvent.click(confirmTakeoverButton)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '确认接管' })).not.toBeInTheDocument()
    )
  }
  fireEvent.click(screen.getByRole('button', { name: '打开终端工具' }))
  expect(screen.getByRole('button', { name: '收起终端工具' })).toHaveAttribute(
    'aria-expanded',
    'true'
  )
}

const openAgentActions = () => {
  const actionToggle = screen.getByRole('button', { name: '打开 Agent 操作' })
  expect(actionToggle).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(actionToggle)
  expect(screen.getByRole('button', { name: '收起 Agent 操作' })).toHaveAttribute(
    'aria-expanded',
    'true'
  )
}

const createBeforeInstallPromptEvent = (outcome: 'accepted' | 'dismissed' = 'accepted') => {
  const prompt = vi.fn().mockResolvedValue(undefined)
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: typeof prompt
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
  }
  event.prompt = prompt
  event.userChoice = Promise.resolve({ outcome, platform: 'web' })
  return { event, prompt }
}

const stubMobileNotification = ({
  permission = 'default',
  requestResult = permission,
}: {
  permission?: NotificationPermission
  requestResult?: NotificationPermission
} = {}) => {
  let currentPermission = permission
  const instances: MockNotification[] = []
  const notifications: Array<{ options?: NotificationOptions; title: string }> = []
  const requestPermission = vi.fn(async () => {
    currentPermission = requestResult
    return requestResult
  })
  class MockNotification {
    static get permission() {
      return currentPermission
    }

    static requestPermission = requestPermission

    onclick: (() => void) | null = null

    constructor(title: string, options?: NotificationOptions) {
      notifications.push({ options, title })
      instances.push(this)
    }
  }
  vi.stubGlobal('Notification', MockNotification as unknown as typeof Notification)
  return { instances, notifications, requestPermission }
}

afterEach(() => {
  cleanup()
  __resetServiceWorkerUpdateStateForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  terminalViewProps.splice(0)
  preloadTerminalAssetsMock.mockClear()
  preloadTerminalConnectionMock.mockClear()
  disposeTerminalConnectionPreloadMock.mockClear()
  MockRelayWebSocket.instances = []
  MockRelayWebSocket.sent = []
  MockRelayWebSocket.urls = []
  MockRelayWebSocket.workspaces = [
    { id: 'workspace-1', name: 'Relay Workspace', path: '/relay/work' },
  ]
  FailingRelayWebSocket.sent = []
  FailingRelayWebSocket.urls = []
  InterruptingOnceRelayWebSocket.interruptNextWorkspaceRequest = true
  InterruptingOnceRelayWebSocket.sent = []
  InterruptingOnceRelayWebSocket.urls = []
  LocalRuntimeErrorRelayWebSocket.sent = []
  LocalRuntimeErrorRelayWebSocket.urls = []
  MockMobileEventsWebSocket.instances = []
  MockMobileEventsWebSocket.urls = []
  delete (window.navigator as Navigator & { clearAppBadge?: unknown }).clearAppBadge
  delete (window.navigator as Navigator & { setAppBadge?: unknown }).setAppBadge
  delete (window.navigator as Navigator & { wakeLock?: unknown }).wakeLock
  window.localStorage.clear()
  window.history.pushState({}, '', '/')
})

describe('mobile route', () => {
  test('/mobile shows a PWA update prompt and applies it', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    const apply = vi.fn()

    render(<App />)

    expect(screen.queryByTestId('mobile-pwa-update-toast')).not.toBeInTheDocument()
    act(() => {
      __setServiceWorkerUpdateForTests(apply)
    })

    expect(await screen.findByTestId('mobile-pwa-update-toast')).toHaveTextContent(
      '有新版本可用，重新加载后生效。'
    )
    const button = screen.getByRole('button', { name: '重新加载' })
    fireEvent.click(button)

    expect(apply).toHaveBeenCalledOnce()
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('正在刷新...')
  })

  test('/mobile relay pairing shows manual iOS home-screen install guidance', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
    )
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('iPhone')

    render(<App />)

    const manualHint = await screen.findByText('在 Safari 中点分享按钮，然后选择“添加到主屏幕”。')
    expect(manualHint.closest('.mobile-install-prompt[data-readiness="manual_ios"]')).toBeTruthy()
  })

  test('/mobile relay pairing explains that public HTTP relay URLs cannot be installed as an app', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')

    render(<App />)

    fireEvent.change(screen.getByLabelText('Relay 地址'), {
      target: { value: 'http://203.0.113.10' },
    })

    const blockedHint = await screen.findByText(
      '当前 Relay 地址不是 HTTPS，浏览器通常不会允许安装为 App；远程控制仍可临时使用。'
    )
    expect(
      blockedHint.closest('.mobile-install-prompt[data-readiness="blocked_http"]')
    ).toBeTruthy()
  })

  test('/mobile relay pairing can prompt the browser PWA install flow', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
    )
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('iPhone')

    render(<App />)

    expect(
      await screen.findByText('在 Safari 中点分享按钮，然后选择“添加到主屏幕”。')
    ).toBeInTheDocument()
    const { event, prompt } = createBeforeInstallPromptEvent()
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    const installButton = await screen.findByRole('button', { name: '安装到主屏幕' })
    expect(
      screen
        .getByText('可以把 Yive 添加到手机主屏幕。')
        .closest('.mobile-install-prompt[data-readiness="installable"]')
    ).toBeTruthy()
    expect(
      screen.queryByText('在 Safari 中点分享按钮，然后选择“添加到主屏幕”。')
    ).not.toBeInTheDocument()
    fireEvent.click(installButton)

    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: '安装到主屏幕' })).not.toBeInTheDocument()
  })

  test('/mobile relay pairing hides the PWA install prompt in standalone mode', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: true,
        removeEventListener: vi.fn(),
      }))
    )

    render(<App />)

    const { event } = createBeforeInstallPromptEvent()
    window.dispatchEvent(event)

    await waitFor(() => expect(event.defaultPrevented).toBe(true))
    expect(screen.queryByRole('button', { name: '安装到主屏幕' })).not.toBeInTheDocument()
  })

  test('/mobile relay mode without a token shows a pairing form and saves it', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    const fetchCalls: Array<{ body?: string; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push({ body: String(init?.body ?? ''), url })
      if (url === 'https://relay.test/pairings/claim') {
        return json({ device_id: 'phone-1', token: 'device-token' })
      }
      throw new Error(`Unexpected fetch in pairing claim: ${url}`)
    })

    render(<App />)

    expect(screen.getByRole('heading', { name: '连接云端' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Relay 地址'), {
      target: { value: 'https://relay.test' },
    })
    fireEvent.change(screen.getByLabelText('配对码'), {
      target: { value: 'pair-token' },
    })
    fireEvent.change(screen.getByLabelText('手机设备名'), {
      target: { value: 'phone-1' },
    })

    const button = screen.getByRole('button', { name: '查看在线电脑' })
    fireEvent.click(button)
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem('yive.mobile.relay.pairing') ?? '{}')).toEqual({
        deviceId: 'phone-1',
        serverUrl: 'https://relay.test',
        token: 'device-token',
      })
    )
    expect(fetchCalls).toEqual([
      {
        body: JSON.stringify({ device_id: 'phone-1', device_kind: 'mobile', token: 'pair-token' }),
        url: 'https://relay.test/pairings/claim',
      },
    ])
  })

  test('/mobile relay pairing stores a claimed desktop binding for future direct reconnects', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/pairings/claim') {
        return json({
          desktop_id: 'desktop-home',
          device_id: 'phone-home',
          token: 'device-token',
        })
      }
      throw new Error(`Unexpected fetch in persistent pairing claim: ${url}`)
    })

    render(<App />)

    fireEvent.change(screen.getByLabelText('Relay 地址'), {
      target: { value: 'https://relay.test' },
    })
    fireEvent.change(screen.getByLabelText('配对码'), {
      target: { value: 'pair-token' },
    })
    fireEvent.change(screen.getByLabelText('手机设备名'), {
      target: { value: 'phone-home' },
    })
    fireEvent.click(screen.getByRole('button', { name: '查看在线电脑' }))

    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem('yive.mobile.relay.pairing') ?? '{}')).toEqual({
        desktopId: 'desktop-home',
        deviceId: 'phone-home',
        serverUrl: 'https://relay.test',
        token: 'device-token',
      })
    )
  })

  test('/mobile relay pairing can bootstrap itself once with a temporary admin token', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    const fetchCalls: Array<{
      body?: string
      headers?: HeadersInit
      method?: string
      url: string
    }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push({
        body: typeof init?.body === 'string' ? init.body : undefined,
        headers: init?.headers,
        method: init?.method,
        url,
      })
      if (url === 'https://relay.test/pairings' && init?.method === 'POST') {
        return json({ expires_at: Date.now() + 600_000, token: 'short-token', ttl_ms: 600_000 })
      }
      if (url === 'https://relay.test/pairings/claim') {
        return json({
          desktop_id: 'desktop-home',
          device_id: 'phone-home',
          token: 'device-token',
          workspace_ids: ['workspace-alpha', 'workspace-beta'],
        })
      }
      throw new Error(`Unexpected fetch in mobile admin bootstrap pairing: ${url}`)
    })

    render(<App />)

    fireEvent.change(screen.getByLabelText('Relay 地址'), {
      target: { value: 'https://relay.test' },
    })
    fireEvent.change(screen.getByLabelText('手机设备名'), {
      target: { value: 'phone-home' },
    })
    fireEvent.click(screen.getByRole('button', { name: '没有配对码？用管理员 token 绑定' }))
    const adminBootstrap = screen.getByRole('heading', { name: '远程首次绑定' }).closest('section')
    if (!adminBootstrap) throw new Error('Expected admin bootstrap panel')
    fireEvent.change(within(adminBootstrap).getByLabelText('管理员 token'), {
      target: { value: 'admin-token' },
    })
    fireEvent.change(within(adminBootstrap).getByLabelText('目标电脑'), {
      target: { value: 'desktop-home' },
    })
    fireEvent.change(within(adminBootstrap).getByLabelText('授权工作区'), {
      target: { value: 'workspace-alpha, workspace-beta workspace-alpha' },
    })
    fireEvent.click(screen.getByRole('button', { name: '绑定这台手机' }))

    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem('yive.mobile.relay.pairing') ?? '{}')).toEqual({
        desktopId: 'desktop-home',
        deviceId: 'phone-home',
        serverUrl: 'https://relay.test',
        token: 'device-token',
      })
    )
    expect(fetchCalls).toEqual([
      {
        headers: { authorization: 'Bearer admin-token' },
        method: 'POST',
        url: 'https://relay.test/pairings',
      },
      {
        body: JSON.stringify({
          desktop_id: 'desktop-home',
          device_id: 'phone-home',
          device_kind: 'mobile',
          token: 'short-token',
          workspace_ids: ['workspace-alpha', 'workspace-beta'],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: 'https://relay.test/pairings/claim',
      },
    ])
    expect(window.localStorage.getItem('yive.mobile.relay.pairing')).not.toContain('admin-token')
    expect(window.location.href).not.toContain('admin-token')
  })

  test('/mobile relay account login stores a desktop-bound token without showing pairing codes', async () => {
    window.history.pushState({}, '', '/mobile?relay=1&server=https%3A%2F%2Frelay.test')
    const fetchCalls: Array<{ body?: string; method?: string; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push({
        body: typeof init?.body === 'string' ? init.body : undefined,
        method: init?.method,
        url,
      })
      if (url === 'https://relay.test/accounts/login' && init?.method === 'POST') {
        return json({
          desktop_id: 'desktop-windows',
          device_id: 'phone-app',
          token: 'device-token',
        })
      }
      throw new Error(`Unexpected fetch in mobile account login: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('heading', { name: '连接云端' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret-password' } })
    fireEvent.change(screen.getByLabelText('目标电脑', { selector: 'input' }), {
      target: { value: 'desktop-windows' },
    })
    fireEvent.change(screen.getByLabelText('手机设备名'), {
      target: { value: 'phone-app' },
    })
    fireEvent.click(screen.getByRole('button', { name: '登录并进入电脑' }))

    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem('yive.mobile.relay.pairing') ?? '{}')).toEqual({
        desktopId: 'desktop-windows',
        deviceId: 'phone-app',
        serverUrl: 'https://relay.test',
        token: 'device-token',
      })
    )
    expect(fetchCalls).toContainEqual({
      body: JSON.stringify({
        desktop_id: 'desktop-windows',
        device_id: 'phone-app',
        password: 'secret-password',
        username: 'alice',
      }),
      method: 'POST',
      url: 'https://relay.test/accounts/login',
    })
    expect(window.location.href).not.toContain('secret-password')
    expect(window.location.href).not.toContain('device-token')
  })

  test('/mobile relay direct desktop URL claims the short token before opening runtime', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&token=short-token&server=https%3A%2F%2Frelay.test&claim=1&workspace_id=workspace-alpha&workspace_id=workspace-beta'
    )
    const fetchCalls: Array<{ body?: string; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push({ body: String(init?.body ?? ''), url })
      if (url === 'https://relay.test/pairings/claim') {
        return json({ device_id: 'phone-1', token: 'device-token' })
      }
      throw new Error(`Unexpected fetch in direct desktop pairing claim: ${url}`)
    })
    vi.stubGlobal('WebSocket', FailingRelayWebSocket)

    render(<App />)

    expect(screen.getByRole('heading', { name: '连接云端' })).toBeInTheDocument()
    expect(screen.getByText('配对后将直接进入电脑 desktop-1。')).toBeInTheDocument()
    expect(screen.getByLabelText('Relay 地址')).toHaveValue('https://relay.test')
    expect(screen.getByLabelText('配对码')).toHaveValue('short-token')
    fireEvent.change(screen.getByLabelText('手机设备名'), {
      target: { value: 'phone-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: '查看在线电脑' }))

    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem('yive.mobile.relay.pairing') ?? '{}')).toEqual({
        desktopId: 'desktop-1',
        deviceId: 'phone-1',
        serverUrl: 'https://relay.test',
        token: 'device-token',
      })
    )
    expect(fetchCalls).toEqual([
      {
        body: JSON.stringify({
          desktop_id: 'desktop-1',
          device_id: 'phone-1',
          device_kind: 'mobile',
          token: 'short-token',
          workspace_ids: ['workspace-alpha', 'workspace-beta'],
        }),
        url: 'https://relay.test/pairings/claim',
      },
    ])
    expect(MockRelayWebSocket.urls).toEqual([])
  })

  test('/mobile relay pairing normalizes bare relay domains before saving', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    const fetchCalls: Array<{ body?: string; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push({ body: String(init?.body ?? ''), url })
      if (url === 'https://relay.test/pairings/claim') {
        return json({ device_id: 'phone-1', token: 'device-token' })
      }
      throw new Error(`Unexpected fetch in normalized pairing claim: ${url}`)
    })

    render(<App />)

    fireEvent.change(screen.getByLabelText('Relay 地址'), {
      target: { value: 'relay.test' },
    })
    fireEvent.change(screen.getByLabelText('配对码'), {
      target: { value: 'pair-token' },
    })
    fireEvent.change(screen.getByLabelText('手机设备名'), {
      target: { value: 'phone-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: '查看在线电脑' }))

    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem('yive.mobile.relay.pairing') ?? '{}')).toEqual({
        deviceId: 'phone-1',
        serverUrl: 'https://relay.test',
        token: 'device-token',
      })
    )
    expect(fetchCalls).toEqual([
      {
        body: JSON.stringify({ device_id: 'phone-1', device_kind: 'mobile', token: 'pair-token' }),
        url: 'https://relay.test/pairings/claim',
      },
    ])
  })

  test('/mobile relay pairing ignores stale claim responses after the address changes', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    let resolveClaim!: (response: Response) => void
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/pairings/claim') {
        return new Promise<Response>((resolve) => {
          resolveClaim = resolve
        })
      }
      throw new Error(`Unexpected fetch in stale pairing claim: ${url}`)
    })

    render(<App />)

    const relayInput = screen.getByLabelText('Relay 地址')
    fireEvent.change(relayInput, {
      target: { value: 'https://relay.test' },
    })
    fireEvent.change(screen.getByLabelText('配对码'), {
      target: { value: 'pair-token' },
    })
    fireEvent.change(screen.getByLabelText('手机设备名'), {
      target: { value: 'phone-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: '查看在线电脑' }))
    expect(screen.getByRole('button', { name: '正在配对...' })).toBeDisabled()

    fireEvent.change(relayInput, {
      target: { value: 'https://other-relay.test' },
    })
    expect(screen.getByRole('button', { name: '查看在线电脑' })).not.toBeDisabled()

    resolveClaim(json({ device_id: 'phone-1', token: 'stale-device-token' }))
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(window.localStorage.getItem('yive.mobile.relay.pairing')).toBeNull()
    expect(window.location.href).not.toContain('stale-device-token')
  })

  test('/mobile relay pairing can check relay health before pairing', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/health') {
        return json({
          desktop_count: 1,
          features: REMOTE_CONTROL_FEATURES,
          heartbeat_interval_ms: 30_000,
          heartbeat_timeout_ms: 75_000,
          mobile_count: 2,
          ok: true,
          protocol_version: 1,
          service: 'hive-relay',
          version: '1.4.0',
        })
      }
      throw new Error(`Unexpected fetch in relay health check: ${url}`)
    })

    render(<App />)

    fireEvent.change(screen.getByLabelText('Relay 地址'), {
      target: { value: 'https://relay.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: '检查 Relay' }))

    expect(
      await screen.findByText('Relay 在线：hive-relay 1.4.0，协议 v1，1 台电脑，2 台手机连接。')
    ).toBeInTheDocument()
  })

  test('/mobile relay pairing shows the health check round trip time', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/health') {
        return json({
          desktop_count: 1,
          mobile_count: 0,
          ok: true,
          protocol_version: 1,
          service: 'hive-relay',
          version: '1.4.0',
        })
      }
      throw new Error(`Unexpected fetch in relay health latency check: ${url}`)
    })

    render(<App />)

    fireEvent.change(screen.getByLabelText('Relay 地址'), {
      target: { value: 'https://relay.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: '检查 Relay' }))

    expect(await screen.findByText(/本次检查耗时 \d+ms/u)).toBeInTheDocument()
  })

  test('/mobile relay health shows uptime and start time diagnostics', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/health') {
        return json({
          desktop_count: 1,
          mobile_count: 0,
          ok: true,
          protocol_version: 1,
          service: 'hive-relay',
          started_at: new Date('2026-06-09T02:30:00.000Z').getTime(),
          uptime_ms: 65_000,
          version: '1.4.0',
        })
      }
      throw new Error(`Unexpected fetch in relay uptime health check: ${url}`)
    })

    render(<App />)

    fireEvent.change(screen.getByLabelText('Relay 地址'), {
      target: { value: 'https://relay.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: '检查 Relay' }))

    expect(
      await screen.findByText(
        /Relay 在线：hive-relay 1\.4\.0，协议 v1，1 台电脑，0 台手机连接，已运行 1 分钟 5 秒，启动于/u
      )
    ).toBeInTheDocument()
  })

  test('/mobile relay health check normalizes IP relay addresses to HTTP', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'http://203.0.113.11:3001/health') {
        return json({
          desktop_count: 0,
          mobile_count: 1,
          ok: true,
          protocol_version: 1,
          service: 'hive-relay',
          version: '1.4.0',
        })
      }
      throw new Error(`Unexpected fetch in normalized IP relay health check: ${url}`)
    })

    render(<App />)

    fireEvent.change(screen.getByLabelText('Relay 地址'), {
      target: { value: '203.0.113.11:3001' },
    })
    fireEvent.click(screen.getByRole('button', { name: '检查 Relay' }))

    expect(
      await screen.findByText('Relay 在线：hive-relay 1.4.0，协议 v1，0 台电脑，1 台手机连接。')
    ).toBeInTheDocument()
  })

  test('/mobile relay pairing clears old health results when the relay address changes', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/health') {
        return json({
          desktop_count: 1,
          mobile_count: 0,
          ok: true,
          protocol_version: 1,
          service: 'hive-relay',
          version: '1.4.0',
        })
      }
      throw new Error(`Unexpected fetch in relay health reset: ${url}`)
    })

    render(<App />)

    const relayInput = screen.getByLabelText('Relay 地址')
    fireEvent.change(relayInput, {
      target: { value: 'https://relay.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: '检查 Relay' }))

    const healthMessage = await screen.findByText(
      'Relay 在线：hive-relay 1.4.0，协议 v1，1 台电脑，0 台手机连接。'
    )
    expect(healthMessage).toBeInTheDocument()

    fireEvent.change(relayInput, {
      target: { value: 'https://other-relay.test' },
    })

    expect(
      screen.queryByText('Relay 在线：hive-relay 1.4.0，协议 v1，1 台电脑，0 台手机连接。')
    ).not.toBeInTheDocument()
  })

  test('/mobile relay pairing ignores stale health responses after the address changes', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    let resolveHealth!: (response: Response) => void
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/health') {
        return new Promise<Response>((resolve) => {
          resolveHealth = resolve
        })
      }
      throw new Error(`Unexpected fetch in stale relay health check: ${url}`)
    })

    render(<App />)

    const relayInput = screen.getByLabelText('Relay 地址')
    fireEvent.change(relayInput, {
      target: { value: 'https://relay.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: '检查 Relay' }))
    expect(screen.getByRole('button', { name: '检查中...' })).toBeInTheDocument()

    fireEvent.change(relayInput, {
      target: { value: 'https://other-relay.test' },
    })
    expect(screen.getByRole('button', { name: '检查 Relay' })).toBeInTheDocument()

    resolveHealth(
      json({
        desktop_count: 1,
        mobile_count: 0,
        ok: true,
        protocol_version: 1,
        service: 'hive-relay',
        version: '1.4.0',
      })
    )
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(
      screen.queryByText('Relay 在线：hive-relay 1.4.0，协议 v1，1 台电脑，0 台手机连接。')
    ).not.toBeInTheDocument()
  })

  test('/mobile relay health warns when the relay protocol is newer than the client', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/health') {
        return json({
          desktop_count: 0,
          features: REMOTE_CONTROL_FEATURES,
          mobile_count: 0,
          ok: true,
          protocol_version: 3,
          service: 'hive-relay',
          version: '1.5.0',
        })
      }
      throw new Error(`Unexpected fetch in relay health protocol warning: ${url}`)
    })

    render(<App />)

    fireEvent.change(screen.getByLabelText('Relay 地址'), {
      target: { value: 'https://relay.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: '检查 Relay' }))

    expect(
      await screen.findByText('Relay 在线：hive-relay 1.5.0，协议 v3，0 台电脑，0 台手机连接。')
    ).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Relay 协议 v3 高于当前客户端支持的 v2，请更新手机端或使用匹配版本。'
    )
  })

  test('/mobile relay health warns when required remote-control features are missing', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/health') {
        return json({
          desktop_count: 0,
          features: [],
          mobile_count: 0,
          ok: true,
          protocol_version: 1,
          service: 'hive-relay',
          version: '1.4.0',
        })
      }
      throw new Error(`Unexpected fetch in relay health feature warning: ${url}`)
    })

    render(<App />)

    fireEvent.change(screen.getByLabelText('Relay 地址'), {
      target: { value: 'https://relay.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: '检查 Relay' }))

    expect(
      await screen.findByText('Relay 在线：hive-relay 1.4.0，协议 v1，0 台电脑，0 台手机连接。')
    ).toBeInTheDocument()
    expect(
      await screen.findByText(
        'Relay 版本较旧或能力未知，缺少：危险操作确认、实时状态事件、手机文件交换、远程原始终端。请更新服务器端 yive。'
      )
    ).toBeInTheDocument()
  })

  test('/mobile relay health explains when the URL is not a Yive relay', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/health') {
        return json({
          desktop_count: 0,
          mobile_count: 0,
          ok: true,
          service: 'other-service',
        })
      }
      throw new Error(`Unexpected fetch in non-relay health check: ${url}`)
    })

    render(<App />)

    fireEvent.change(screen.getByLabelText('Relay 地址'), {
      target: { value: 'https://relay.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: '检查 Relay' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '这个地址可访问，但它不是 Yive Relay 服务。请检查 Relay 地址。'
    )
  })

  test('/mobile relay pairing explains invalid codes and network failures', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => failure(401, { error: 'Invalid pairing token' }))
    )

    const { unmount } = render(<App />)

    fireEvent.change(screen.getByLabelText('Relay 地址'), {
      target: { value: 'https://relay.test' },
    })
    fireEvent.change(screen.getByLabelText('配对码'), {
      target: { value: 'expired-code' },
    })
    fireEvent.click(screen.getByRole('button', { name: '查看在线电脑' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '配对码无效或已过期，请在电脑端重新生成配对码。'
    )
    unmount()

    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      })
    )
    render(<App />)

    fireEvent.change(screen.getByLabelText('Relay 地址'), {
      target: { value: 'https://relay.test' },
    })
    fireEvent.change(screen.getByLabelText('配对码'), {
      target: { value: 'pair-code' },
    })
    fireEvent.click(screen.getByRole('button', { name: '查看在线电脑' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '无法连接 Relay 服务器，请检查 Relay 地址、网络和服务器是否在线。'
    )
  })

  test('/mobile relay pairing clears claim errors when the user edits the form', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => failure(401, { error: 'Invalid pairing token' }))
    )

    render(<App />)

    fireEvent.change(screen.getByLabelText('Relay 地址'), {
      target: { value: 'https://relay.test' },
    })
    const tokenInput = screen.getByLabelText('配对码')
    fireEvent.change(tokenInput, {
      target: { value: 'expired-code' },
    })
    fireEvent.click(screen.getByRole('button', { name: '查看在线电脑' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '配对码无效或已过期，请在电脑端重新生成配对码。'
    )

    fireEvent.change(tokenInput, {
      target: { value: 'new-code' },
    })

    expect(
      screen.queryByText('配对码无效或已过期，请在电脑端重新生成配对码。')
    ).not.toBeInTheDocument()
  })

  test('/mobile relay pairing stops when browser storage is unavailable', async () => {
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ device_id: 'phone-1', token: 'device-token' }))
    )

    render(<App />)

    fireEvent.change(screen.getByLabelText('Relay 地址'), {
      target: { value: 'https://relay.test' },
    })
    fireEvent.change(screen.getByLabelText('配对码'), {
      target: { value: 'pair-token' },
    })
    fireEvent.change(screen.getByLabelText('手机设备名'), {
      target: { value: 'phone-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: '查看在线电脑' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '浏览器无法保存配对信息。请允许网站存储数据后重新配对。'
    )
    expect(screen.getByRole('heading', { name: '连接云端' })).toBeInTheDocument()
    expect(window.location.href).not.toContain('device-token')
  })

  test('/mobile relay mode reuses saved pairing to show online desktop choices', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({ deviceId: 'phone-1', serverUrl: 'https://relay.test', token: 'pair-token' })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const now = Date.now()
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        expect(init).toMatchObject({
          headers: { authorization: 'Bearer pair-token' },
        })
        return json({
          desktops: [
            {
              connected_at: now - 60_000,
              device_id: 'desktop-1',
              last_seen_at: now - 1_000,
              runtime_status: 'online',
              runtime_updated_at: now,
            },
          ],
          mobiles: [],
        })
      }
      throw new Error(`Unexpected fetch in saved relay picker: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('heading', { name: '选择电脑' })).toBeInTheDocument()
    const reconnect = screen.getByLabelText('已保存的远程连接')
    expect(within(reconnect).getByText('这台手机保存了配对信息')).toBeInTheDocument()
    expect(within(reconnect).getByText(/当前还没有绑定具体电脑/u)).toBeInTheDocument()
    expect(within(reconnect).getByText('手机设备名：phone-1')).toBeInTheDocument()
    expect(within(reconnect).getByText('https://relay.test/mobile?relay=1')).toBeInTheDocument()
    expect(reconnect).not.toHaveTextContent('pair-token')
    fireEvent.click(within(reconnect).getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('https://relay.test/mobile?relay=1')
    expect(await within(reconnect).findByText('已复制固定入口')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /desktop-1/ })).toHaveAttribute(
      'href',
      '/mobile?relay=1&desktop_id=desktop-1&device_id=phone-1&server=https%3A%2F%2Frelay.test'
    )
    expect(screen.getByText('Runtime 在线')).toBeInTheDocument()
    expect(screen.getByText('状态更新于 刚刚更新')).toBeInTheDocument()
    expect(screen.getByText('电脑连接于 1 分钟前')).toBeInTheDocument()
    expect(screen.getByText('最近在线 刚刚更新')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Relay 诊断' })).toBeInTheDocument()
    expect(screen.getByText('配对 token 可用，设备列表接口已返回。')).toBeInTheDocument()
    expect(screen.getByText('1 台电脑可连接。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument()
  })

  test('/mobile relay picker shows relay health diagnostics after pairing', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({ serverUrl: 'https://relay.test', token: 'pair-token' })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        expect(init).toMatchObject({
          headers: { authorization: 'Bearer pair-token' },
        })
        return json({
          desktops: [
            { device_id: 'desktop-1', features: REMOTE_CONTROL_FEATURES, runtime_status: 'online' },
          ],
          mobiles: [
            { desktop_id: 'desktop-1', device_id: 'phone-1' },
            { desktop_id: 'desktop-1', device_id: 'phone-2' },
          ],
        })
      }
      if (url === 'https://relay.test/health') {
        return json({
          desktop_count: 1,
          deployment: {
            public_url_configured: false,
          },
          heartbeat_interval_ms: 30_000,
          heartbeat_timeout_ms: 75_000,
          features: REMOTE_CONTROL_FEATURES,
          mobile_count: 2,
          ok: true,
          pairing_store: {
            admin_token_default: true,
            device_token_count: 1,
            issued_token_count: 0,
            persistent: false,
            require_desktop_binding: false,
          },
          protocol_version: 1,
          service: 'hive-relay',
          started_at: new Date('2026-06-09T02:30:00.000Z').getTime(),
          static: { mobile_app_available: false },
          uptime_ms: 65_000,
          version: '1.4.0',
        })
      }
      throw new Error(`Unexpected fetch in relay picker health diagnostics: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('link', { name: /desktop-1/ })).toBeInTheDocument()
    expect(
      await screen.findByText(
        /Relay 在线：hive-relay 1\.4\.0，协议 v1，1 台电脑，2 台手机连接，已运行 1 分钟 5 秒，启动于/u
      )
    ).toBeInTheDocument()
    await screen.findByText(/Relay 网络正常：最近检查耗时 \d+ms。/u)
    expect(screen.getAllByText(/最近检查耗时 \d+ms/u).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Relay 服务在线，当前 1 台电脑、2 台手机连接。')).toBeInTheDocument()
    expect(screen.getByText(/Relay 网络正常：最近检查耗时 \d+ms。/u)).toBeInTheDocument()
    expect(
      screen.getByText('Relay 心跳：每 30 秒 检查一次，1 分钟 15 秒 无响应会断开设备。')
    ).toBeInTheDocument()
    expect(screen.getByText('已连接 2 台手机：phone-1、phone-2')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Relay 没有找到构建后的手机页面，请在服务器部署时执行 pnpm build 并配置静态目录。'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText('Relay 还没有发布构建后的手机页面，Android App 打包前需要先部署 web/dist。')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Relay 配对信息只保存在内存里，服务器重启后手机需要重新配对。')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Relay 未配置公网验收地址，服务器部署或回滚后不会自动做公网 smoke 检查。')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Relay 未开启桌面绑定严格模式，手机 token 可能被用于连接其他电脑。')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Relay 正在使用开发默认管理员 token，请在服务器上配置专用 token。')
    ).toBeInTheDocument()
    const diagnosticsHeading = screen.getByRole('heading', { name: 'Relay 诊断' })
    const diagnosticsPanel = diagnosticsHeading.closest('section')
    if (!diagnosticsPanel) throw new Error('Expected relay diagnostics panel')
    fireEvent.click(within(diagnosticsPanel).getByRole('button', { name: '复制诊断' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    const copiedText = String(writeText.mock.calls[0]?.[0] ?? '')
    expect(copiedText).toContain('Yive Relay 诊断')
    expect(copiedText).toContain('[ok] Relay 服务在线，当前 1 台电脑、2 台手机连接。')
    expect(copiedText).toContain(
      '[ok] Relay 心跳：每 30 秒 检查一次，1 分钟 15 秒 无响应会断开设备。'
    )
    expect(copiedText).toContain(
      '[error] Relay 正在使用开发默认管理员 token，请在服务器上配置专用 token。'
    )
    expect(copiedText).toContain(
      '[error] Relay 还没有发布构建后的手机页面，Android App 打包前需要先部署 web/dist。'
    )
    expect(copiedText).toContain(
      '[warn] Relay 未配置公网验收地址，服务器部署或回滚后不会自动做公网 smoke 检查。'
    )
    expect(copiedText).toContain(
      '[error] Relay 未开启桌面绑定严格模式，手机 token 可能被用于连接其他电脑。'
    )
    expect(copiedText).not.toContain('pair-token')
    expect(await within(diagnosticsPanel).findByText('已复制诊断信息')).toBeInTheDocument()
  })

  test('/mobile relay picker can list and revoke paired phones with an admin token', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({
        deviceId: 'phone-1',
        serverUrl: 'https://relay.test',
        token: 'admin-token',
      })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    const fetchCalls: Array<{ method?: string; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push({ method: init?.method, url })
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      if (url === 'https://relay.test/pairings/devices' && !init?.method) {
        return json({
          devices: [
            {
              desktop_id: 'desktop-1',
              device_id: 'phone-1',
              token_hint: 'aaaa...1111',
              workspace_ids: ['workspace-alpha'],
            },
            { device_id: 'friend-phone', token_hint: 'bbbb...2222' },
          ],
        })
      }
      if (url === 'https://relay.test/pairings/devices/friend-phone' && init?.method === 'DELETE') {
        return json({ device_id: 'friend-phone', revoked: true })
      }
      throw new Error(`Unexpected fetch in relay paired device admin: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('link', { name: /desktop-1/ })).toBeInTheDocument()
    expect(fetchCalls.some((call) => call.url.endsWith('/pairings/devices'))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '管理设备' }))

    expect(await screen.findByRole('heading', { name: '已配对手机' })).toBeInTheDocument()
    expect(screen.getByText('phone-1')).toBeInTheDocument()
    expect(screen.getByText('当前手机')).toBeInTheDocument()
    expect(screen.getByText('token aaaa...1111')).toBeInTheDocument()
    expect(screen.getByText('绑定电脑 desktop-1')).toBeInTheDocument()
    expect(screen.getByText('工作区 workspace-alpha')).toBeInTheDocument()
    expect(screen.getByText('在线 · 连接 desktop-1')).toBeInTheDocument()
    expect(screen.getByText('friend-phone')).toBeInTheDocument()
    expect(
      screen.getByText('管理员 token 仅在当前页面临时使用，不会保存，也不会替换手机配对 token。')
    ).toBeInTheDocument()

    const friendDevice = screen.getByText('friend-phone').closest('article')
    if (!friendDevice) throw new Error('Expected friend paired device row')
    expect(within(friendDevice).getByText('工作区 全部')).toBeInTheDocument()
    expect(within(friendDevice).getByText('离线')).toBeInTheDocument()
    fireEvent.click(within(friendDevice).getByRole('button', { name: '撤销' }))
    expect(within(friendDevice).getByText('再次点击确认撤销')).toBeInTheDocument()
    expect(
      fetchCalls.some(
        (call) =>
          call.method === 'DELETE' &&
          call.url === 'https://relay.test/pairings/devices/friend-phone'
      )
    ).toBe(false)
    fireEvent.click(within(friendDevice).getByRole('button', { name: '确认撤销' }))

    await waitFor(() =>
      expect(
        fetchCalls.some(
          (call) =>
            call.method === 'DELETE' &&
            call.url === 'https://relay.test/pairings/devices/friend-phone'
        )
      ).toBe(true)
    )
    expect(await screen.findByText('已撤销 friend-phone。')).toBeInTheDocument()
  })

  test('/mobile relay picker clears local pairing after revoking the current phone', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({
        deviceId: 'phone-1',
        serverUrl: 'https://relay.test',
        token: 'admin-token',
      })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    const fetchCalls: Array<{ method?: string; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push({ method: init?.method, url })
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      if (url === 'https://relay.test/pairings/devices' && !init?.method) {
        return json({
          devices: [{ device_id: 'phone-1', token_hint: 'aaaa...1111' }],
        })
      }
      if (url === 'https://relay.test/pairings/devices/phone-1' && init?.method === 'DELETE') {
        return json({ device_id: 'phone-1', revoked: true })
      }
      throw new Error(`Unexpected fetch in current relay paired device revoke: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('link', { name: /desktop-1/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '管理设备' }))

    const currentDevice = await screen.findByText('phone-1')
    const currentDeviceRow = currentDevice.closest('article')
    if (!currentDeviceRow) throw new Error('Expected current paired device row')
    fireEvent.click(within(currentDeviceRow).getByRole('button', { name: '撤销' }))
    fireEvent.click(within(currentDeviceRow).getByRole('button', { name: '确认撤销' }))

    await waitFor(() =>
      expect(
        fetchCalls.some(
          (call) =>
            call.method === 'DELETE' && call.url === 'https://relay.test/pairings/devices/phone-1'
        )
      ).toBe(true)
    )
    await waitFor(() => expect(window.localStorage.getItem('yive.mobile.relay.pairing')).toBeNull())
    expect(screen.getByRole('heading', { name: '连接云端' })).toBeInTheDocument()
    expect(screen.getByLabelText('Relay 地址')).toHaveValue('https://relay.test')
    expect(screen.getByLabelText('手机设备名')).toHaveValue('phone-1')
  })

  test('/mobile relay picker can use a temporary admin token for device management', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({ serverUrl: 'https://relay.test', token: 'pair-token' })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
          mobiles: [],
        })
      }
      if (url === 'https://relay.test/pairings/devices') {
        const headers = init?.headers as Record<string, string> | undefined
        if (headers?.authorization === 'Bearer admin-token') {
          return json({
            devices: [{ device_id: 'phone-2', token_hint: 'cccc...3333' }],
          })
        }
        return failure(401, { error: 'Invalid relay admin token' })
      }
      throw new Error(`Unexpected fetch in relay paired device admin error: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('link', { name: /desktop-1/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '管理设备' }))

    const adminHeading = await screen.findByRole('heading', { name: '已配对手机' })
    const adminPanel = adminHeading.closest('section')
    if (!adminPanel) throw new Error('Expected relay device admin panel')
    expect(await within(adminPanel).findByRole('alert')).toHaveTextContent(
      '当前 token 不能管理设备，请使用 Relay 管理员 token。'
    )

    fireEvent.change(within(adminPanel).getByLabelText('管理员 token'), {
      target: { value: 'admin-token' },
    })
    fireEvent.click(within(adminPanel).getByRole('button', { name: '刷新' }))

    expect(await within(adminPanel).findByText('phone-2')).toBeInTheDocument()
    expect(within(adminPanel).getByText('token cccc...3333')).toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem('yive.mobile.relay.pairing') ?? '{}')).toEqual({
      serverUrl: 'https://relay.test',
      token: 'pair-token',
    })
  })

  test('/mobile relay picker can generate a short pairing link with a temporary admin token', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-06-10T01:00:00Z'))
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({ serverUrl: 'https://relay.test', token: 'pair-token' })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    const writeText = vi.fn(async () => undefined)
    const share = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: share,
    })
    const fetchCalls: Array<{ headers?: Record<string, string>; method?: string; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const headers = init?.headers as Record<string, string> | undefined
      fetchCalls.push({ headers, method: init?.method, url })
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
          mobiles: [],
        })
      }
      if (url === 'https://relay.test/pairings/devices') {
        if (headers?.authorization === 'Bearer admin-token') {
          return json({ devices: [] })
        }
        return failure(401, { error: 'Invalid relay admin token' })
      }
      if (url === 'https://relay.test/pairings' && init?.method === 'POST') {
        if (headers?.authorization === 'Bearer admin-token') {
          return json({ expires_at: Date.now() + 5_000, token: 'short-token', ttl_ms: 600_000 })
        }
        return failure(401, { error: 'Invalid relay admin token' })
      }
      throw new Error(`Unexpected fetch in relay pairing link generation: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('link', { name: /desktop-1/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '管理设备' }))

    const adminHeading = await screen.findByRole('heading', { name: '已配对手机' })
    const adminPanel = adminHeading.closest('section')
    if (!adminPanel) throw new Error('Expected relay device admin panel')
    fireEvent.change(within(adminPanel).getByLabelText('管理员 token'), {
      target: { value: 'admin-token' },
    })
    fireEvent.change(within(adminPanel).getByLabelText('目标电脑'), {
      target: { value: 'desktop-1' },
    })
    fireEvent.change(within(adminPanel).getByLabelText('授权工作区'), {
      target: { value: 'workspace-alpha, workspace-beta workspace-alpha' },
    })
    fireEvent.click(within(adminPanel).getByRole('button', { name: '生成配对链接' }))

    const generatedLink = await within(adminPanel).findByLabelText('配对链接')
    const expectedPairingLink =
      'http://localhost:3000/mobile?relay=1&token=short-token&claim=1&desktop_id=desktop-1&workspace_id=workspace-alpha&workspace_id=workspace-beta&server=https%3A%2F%2Frelay.test'
    expect(generatedLink).toHaveValue(expectedPairingLink)
    expect(within(adminPanel).getByText('有效期约 5 秒')).toBeInTheDocument()
    expect(String((generatedLink as HTMLInputElement).value)).not.toContain('admin-token')
    fireEvent.click(within(adminPanel).getByRole('button', { name: '复制链接' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expectedPairingLink))
    expect(await within(adminPanel).findByText('已复制配对链接')).toBeInTheDocument()
    fireEvent.click(within(adminPanel).getByRole('button', { name: '分享链接' }))
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith({
        text: '用这个短期链接把手机配对到 Yive Relay。',
        title: 'Yive 手机配对链接',
        url: expectedPairingLink,
      })
    )
    expect(JSON.stringify(share.mock.calls)).not.toContain('admin-token')
    expect(await within(adminPanel).findByText('已打开系统分享')).toBeInTheDocument()
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(within(adminPanel).getByText('配对链接已过期，请重新生成')).toBeInTheDocument()
    expect(within(adminPanel).getByRole('button', { name: '复制链接' })).toBeDisabled()
    expect(within(adminPanel).getByRole('button', { name: '分享链接' })).toBeDisabled()
    expect(
      fetchCalls.some(
        (call) =>
          call.method === 'POST' &&
          call.url === 'https://relay.test/pairings' &&
          call.headers?.authorization === 'Bearer admin-token'
      )
    ).toBe(true)
    expect(JSON.parse(window.localStorage.getItem('yive.mobile.relay.pairing') ?? '{}')).toEqual({
      serverUrl: 'https://relay.test',
      token: 'pair-token',
    })
  })

  test('/mobile relay picker disables desktops with an offline local runtime', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({ serverUrl: 'https://relay.test', token: 'pair-token' })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [
            {
              device_id: 'desktop-1',
              runtime_message: 'Local runtime down',
              runtime_status: 'offline',
              runtime_updated_at: Date.now() - 60_000,
            },
          ],
          mobiles: [],
        })
      }
      throw new Error(`Unexpected fetch in offline relay picker: ${url}`)
    })

    render(<App />)

    expect(await screen.findByText('Local runtime down')).toBeInTheDocument()
    expect(screen.getByText('状态可能过期 · 1 分钟前')).toBeInTheDocument()
    expect(screen.getByText('等待本地 yive')).toBeInTheDocument()
    expect(
      screen.getByText('1 台电脑已连上 Relay，但本地 yive runtime 不可用。')
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /desktop-1/ })).not.toBeInTheDocument()
  })

  test('/mobile relay picker auto-refreshes desktop runtime status', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({ serverUrl: 'https://relay.test', token: 'pair-token' })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    let attempts = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        attempts += 1
        expect(init).toMatchObject({
          headers: { authorization: 'Bearer pair-token' },
        })
        return json({
          desktops: [
            attempts === 1
              ? {
                  device_id: 'desktop-1',
                  runtime_message: 'Local runtime down',
                  runtime_status: 'offline',
                }
              : {
                  device_id: 'desktop-1',
                  runtime_status: 'online',
                },
          ],
          mobiles: [],
        })
      }
      throw new Error(`Unexpected fetch in auto-refresh relay picker: ${url}`)
    })

    render(<App />)

    expect(await screen.findByText('Local runtime down')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Runtime 在线')).toBeInTheDocument(), {
      timeout: 2_000,
    })
    expect(screen.queryByText('Local runtime down')).not.toBeInTheDocument()
    expect(attempts).toBeGreaterThanOrEqual(2)
  })

  test('/mobile relay picker keeps devices visible when a background refresh fails', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({ serverUrl: 'https://relay.test', token: 'pair-token' })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    let attempts = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        attempts += 1
        if (attempts > 1) throw new TypeError('Failed to fetch')
        return json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
          mobiles: [],
        })
      }
      throw new Error(`Unexpected fetch in failed background relay refresh: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('link', { name: /desktop-1/ })).toBeInTheDocument()
    await waitFor(
      () =>
        expect(
          screen.getByText('无法连接 Relay 服务器，请检查 Relay 地址、网络和服务器是否在线。')
        ).toBeInTheDocument(),
      { timeout: 2_000 }
    )

    expect(screen.getByRole('link', { name: /desktop-1/ })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(attempts).toBeGreaterThanOrEqual(2)
  })

  test('/mobile relay mode normalizes stored bare relay domains for picker links', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({ serverUrl: 'relay.test', token: 'pair-token' })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        expect(init).toMatchObject({
          headers: { authorization: 'Bearer pair-token' },
        })
        return json({ desktops: [{ device_id: 'desktop-1' }], mobiles: [] })
      }
      throw new Error(`Unexpected fetch in normalized saved relay picker: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('heading', { name: '选择电脑' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /desktop-1/ })).toHaveAttribute(
      'href',
      '/mobile?relay=1&desktop_id=desktop-1&server=https%3A%2F%2Frelay.test'
    )
  })

  test('/mobile relay picker can refresh empty device lists and change pairing', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({ serverUrl: 'https://relay.test', token: 'pair-token' })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    let attempts = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        attempts += 1
        expect(init).toMatchObject({
          headers: { authorization: 'Bearer pair-token' },
        })
        return json({
          desktops: attempts === 1 ? [] : [{ device_id: 'desktop-after-refresh' }],
          mobiles: [],
        })
      }
      throw new Error(`Unexpected fetch in relay refresh picker: ${url}`)
    })

    render(<App />)

    expect(
      await screen.findByText('暂无在线电脑。请先在电脑端执行 yive connect。')
    ).toBeInTheDocument()
    expect(screen.getByText('没有在线电脑，请在本地电脑运行 yive connect。')).toBeInTheDocument()
    const connectGuide = screen.getByLabelText('电脑端连接指引')
    expect(within(connectGuide).getByText('电脑端连接')).toBeInTheDocument()
    expect(within(connectGuide).getByText('推荐：Windows supervisor')).toBeInTheDocument()
    expect(
      within(connectGuide).getByText(/deploy\\run-windows-desktop-relay\.ps1/u)
    ).toHaveTextContent('https://relay.test')
    expect(within(connectGuide).getAllByText(/<relay-admin-token>/u)).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByRole('link', { name: /desktop-after-refresh/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))

    expect(window.localStorage.getItem('yive.mobile.relay.pairing')).toBeNull()
    expect(screen.getByRole('heading', { name: '连接云端' })).toBeInTheDocument()
    expect(screen.getByLabelText('Relay 地址')).toHaveValue('https://relay.test')
  })

  test('/mobile relay mode can recover when the saved pairing token is rejected', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({
        deviceId: 'phone-1',
        serverUrl: 'https://relay.test',
        token: 'revoked-token',
      })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        expect(init).toMatchObject({
          headers: { authorization: 'Bearer revoked-token' },
        })
        return failure(401, { error: 'Invalid relay token' })
      }
      throw new Error(`Unexpected fetch in revoked relay picker: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('alert')).toHaveTextContent('配对已失效或被撤销，请重新配对。')
    fireEvent.click(screen.getByRole('button', { name: '重新配对' }))

    expect(window.localStorage.getItem('yive.mobile.relay.pairing')).toBeNull()
    expect(screen.getByRole('heading', { name: '连接云端' })).toBeInTheDocument()
    expect(screen.getByLabelText('Relay 地址')).toHaveValue('https://relay.test')
    expect(screen.getByLabelText('手机设备名')).toHaveValue('phone-1')
  })

  test('/mobile relay mode can recover when the saved pairing is not desktop-bound', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({
        deviceId: 'phone-1',
        serverUrl: 'https://relay.test',
        token: 'unbound-token',
      })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        expect(init).toMatchObject({
          headers: { authorization: 'Bearer unbound-token' },
        })
        return failure(403, { error: 'Relay device token is not bound to a desktop' })
      }
      throw new Error(`Unexpected fetch in unbound relay picker: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '当前手机配对没有绑定电脑，请用电脑端生成的新配对链接重新配对。'
    )
    fireEvent.click(screen.getByRole('button', { name: '重新配对' }))

    expect(window.localStorage.getItem('yive.mobile.relay.pairing')).toBeNull()
    expect(screen.getByRole('heading', { name: '连接云端' })).toBeInTheDocument()
    expect(screen.getByLabelText('Relay 地址')).toHaveValue('https://relay.test')
    expect(screen.getByLabelText('手机设备名')).toHaveValue('phone-1')
  })

  test('/mobile relay picker explains network and relay endpoint failures', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({
        serverUrl: 'https://relay.test',
        token: 'pair-token',
      })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    let networkAttempts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        networkAttempts += 1
        if (networkAttempts > 1) {
          return json({ desktops: [{ device_id: 'desktop-after-retry' }], mobiles: [] })
        }
        throw new TypeError('Failed to fetch')
      })
    )

    const { unmount } = render(<App />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '无法连接 Relay 服务器，请检查 Relay 地址、网络和服务器是否在线。'
    )
    expect(screen.queryByRole('button', { name: '重新配对' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('link', { name: /desktop-after-retry/ })).toBeInTheDocument()
    unmount()

    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => failure(404, { error: 'Not found' }))
    )
    const secondRender = render(<App />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Relay 地址可访问，但没有找到设备列表接口。请确认服务器运行的是 yive relay。'
    )
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    secondRender.unmount()

    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Relay HTTP request timed out: /devices')
      })
    )
    render(<App />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '无法连接 Relay 服务器，请检查 Relay 地址、网络和服务器是否在线。'
    )
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  test('/mobile relay mode without a desktop id shows online desktop choices', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        expect(init).toMatchObject({
          headers: { authorization: 'Bearer pair-token' },
        })
        return json({
          desktops: [{ device_id: 'desktop-1' }, { device_id: 'desktop-2' }],
          mobiles: [],
        })
      }
      throw new Error(`Unexpected fetch in relay picker: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('heading', { name: '选择电脑' })).toBeInTheDocument()
    const desktopLink = screen.getByRole('link', { name: /desktop-1/ })
    expect(desktopLink).toHaveAttribute(
      'href',
      '/mobile?relay=1&desktop_id=desktop-1&server=https%3A%2F%2Frelay.test'
    )
    expect(window.location.href).not.toContain('pair-token')
    expect(JSON.parse(window.localStorage.getItem('yive.mobile.relay.pairing') ?? '{}')).toEqual({
      serverUrl: 'https://relay.test',
      token: 'pair-token',
    })
    expect(screen.getByRole('link', { name: /desktop-2/ })).toBeInTheDocument()
  })

  test('/mobile relay picker remembers the selected desktop before navigation', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({ deviceId: 'phone-1', serverUrl: 'https://relay.test', token: 'pair-token' })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      throw new Error(`Unexpected fetch in relay desktop selection persistence: ${url}`)
    })

    render(<App />)

    const desktopLink = await screen.findByRole('link', { name: /desktop-1/ })
    fireEvent.click(desktopLink)

    expect(JSON.parse(window.localStorage.getItem('yive.mobile.relay.pairing') ?? '{}')).toEqual({
      desktopId: 'desktop-1',
      deviceId: 'phone-1',
      serverUrl: 'https://relay.test',
      token: 'pair-token',
    })
    expect(window.location.href).not.toContain('pair-token')
  })

  test('/mobile relay token URL stops before device selection when browser storage is unavailable', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    const fetchSpy = vi.fn(async () =>
      json({ desktops: [{ device_id: 'desktop-1' }], mobiles: [] })
    )
    vi.stubGlobal('fetch', fetchSpy)

    render(<App />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '浏览器无法保存配对信息。请允许网站存储数据后重新打开配对链接。'
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: /desktop-1/ })).not.toBeInTheDocument()
    expect(window.location.href).not.toContain('pair-token')
  })

  test('/mobile relay runtime can use a saved token without exposing it in the page URL', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({
        deviceId: 'phone-1',
        serverUrl: 'https://relay.test',
        token: 'stored-token',
      })
    )
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in tokenless relay runtime: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    expect(await screen.findByText('Remote Worker')).toBeInTheDocument()
    openBackgroundTab()
    expect(screen.getByText('当前手机 phone-1')).toBeInTheDocument()
    expect(window.location.href).not.toContain('stored-token')
    expect(MockRelayWebSocket.urls[0]).toContain('pairing_token=stored-token')
    expect(MockRelayWebSocket.urls[0]).toContain('device_id=phone-1')
    expect(JSON.parse(window.localStorage.getItem('yive.mobile.relay.pairing') ?? '{}')).toEqual({
      desktopId: 'desktop-1',
      deviceId: 'phone-1',
      serverUrl: 'https://relay.test',
      token: 'stored-token',
    })
  })

  test('/mobile relay runtime explains that public HTTP URLs cannot be installed as an app', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({
        deviceId: 'phone-1',
        serverUrl: 'http://203.0.113.10',
        token: 'stored-token',
      })
    )
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&server=http%3A%2F%2F203.0.113.10'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in HTTP relay runtime install prompt: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    expect(await screen.findByText('Remote Worker')).toBeInTheDocument()
    openBackgroundTab()
    expect(
      screen.getByText(
        '当前 Relay 地址不是 HTTPS，浏览器通常不会允许安装为 App；远程控制仍可临时使用。'
      )
    ).toBeInTheDocument()
    expect(window.location.href).not.toContain('stored-token')
  })

  test('/mobile relay runtime reports HTTP as an Android app release blocker', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({
        deviceId: 'phone-1',
        serverUrl: 'http://203.0.113.10',
        token: 'stored-token',
      })
    )
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&server=http%3A%2F%2F203.0.113.10'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'http://203.0.113.10/health') {
        return json({
          desktop_count: 1,
          mobile_count: 1,
          ok: true,
          protocol_version: 1,
          service: 'hive-relay',
          static: { mobile_app_available: true },
        })
      }
      if (url === 'http://203.0.113.10/devices') {
        expect(init).toMatchObject({ headers: { authorization: 'Bearer stored-token' } })
        return json({
          desktops: [
            { device_id: 'desktop-1', features: REMOTE_CONTROL_FEATURES, runtime_status: 'online' },
          ],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      throw new Error(`Unexpected fetch in HTTP Android readiness diagnostics: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    expect(await screen.findByText('Remote Worker')).toBeInTheDocument()
    openBackgroundTab()
    fireEvent.click(screen.getByRole('button', { name: '诊断' }))

    expect(
      await screen.findByText('Android App 需要 HTTPS 域名；当前 Relay 只能作为临时网页远程控制。')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '复制诊断' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled())
    const copiedDiagnostics = String(
      vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0] ?? ''
    )
    const structuredReport = JSON.parse(
      copiedDiagnostics.split('结构化诊断 JSON\n')[1] ?? '{}'
    ) as {
      checks: Array<{ id: string; tone: string }>
      next_action?: string
      next_action_id?: string
      ok: boolean
    }
    expect(structuredReport).toMatchObject({
      next_action_id: 'configure_https',
      ok: false,
    })
    expect(structuredReport.next_action).toContain('Android App 需要 HTTPS 域名')
    expect(structuredReport.checks).toContainEqual({
      id: 'android_twa_blocked_http',
      label: 'Android App 需要 HTTPS 域名；当前 Relay 只能作为临时网页远程控制。',
      tone: 'error',
    })
  })

  test('/mobile relay home screen reopens the last selected desktop', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({
        desktopId: 'desktop-1',
        deviceId: 'phone-1',
        serverUrl: 'https://relay.test',
        token: 'stored-token',
      })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in saved desktop relay runtime: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    expect(await screen.findByText('Remote Worker')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '选择电脑' })).not.toBeInTheDocument()
    expect(MockRelayWebSocket.urls[0]).toContain('desktop_id=desktop-1')
    expect(MockRelayWebSocket.urls[0]).toContain('pairing_token=stored-token')
    expect(MockRelayWebSocket.urls[0]).toContain('device_id=phone-1')
  })

  test('/mobile relay runtime can clear the remembered desktop without losing pairing', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({
        desktopId: 'desktop-1',
        deviceId: 'phone-1',
        serverUrl: 'https://relay.test',
        token: 'stored-token',
      })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in relay desktop switch: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    expect(await screen.findByText('Remote Worker')).toBeInTheDocument()
    openBackgroundTab()
    fireEvent.click(screen.getByRole('button', { name: '切换电脑' }))

    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem('yive.mobile.relay.pairing') ?? '{}')).toEqual({
        deviceId: 'phone-1',
        serverUrl: 'https://relay.test',
        token: 'stored-token',
      })
    )
  })

  test('/mobile relay token URL ignores an older saved desktop until the user selects a desktop', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({
        desktopId: 'old-desktop',
        serverUrl: 'https://old-relay.test',
        token: 'old-token',
      })
    )
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        expect(init).toMatchObject({
          headers: { authorization: 'Bearer pair-token' },
        })
        return json({
          desktops: [{ device_id: 'desktop-1' }],
          mobiles: [],
        })
      }
      throw new Error(`Unexpected fetch in relay token desktop reset: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('heading', { name: '选择电脑' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /desktop-1/ })).toBeInTheDocument()
    expect(MockRelayWebSocket.urls).toEqual([])
    expect(JSON.parse(window.localStorage.getItem('yive.mobile.relay.pairing') ?? '{}')).toEqual({
      serverUrl: 'https://relay.test',
      token: 'pair-token',
    })
  })

  test('/mobile can load workspace and agents through relay mode', async () => {
    const now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    const fetchCalls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push(url)
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [
            {
              connected_at: now - 60_000,
              device_id: 'desktop-1',
              last_seen_at: now - 2_000,
              runtime_status: 'online',
              runtime_updated_at: now - 6_000,
            },
          ],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in relay mode: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    expect(await screen.findByText('Agent(1)')).toBeInTheDocument()
    expect(screen.getAllByText('Relay Workspace').length).toBeGreaterThan(0)
    expect(screen.getByText('Remote Worker')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开 Remote Worker 终端' })).toBeInTheDocument()
    expect(screen.queryByText('relay ready')).not.toBeInTheDocument()
    expect(document.querySelector('.mobile-agent-card__metrics')).toBeNull()
    expect(screen.getByLabelText('局域网连接状态')).toHaveTextContent('Relay 在线 · Runtime 在线')
    expect(screen.queryByText(/当前手机/u)).not.toBeInTheDocument()
    openBackgroundTab()
    expect(screen.getAllByText('Relay https://relay.test').length).toBeGreaterThanOrEqual(1)
    const relayPath = screen.getByLabelText('远程链路状态')
    expect(within(relayPath).getByText('Relay https://relay.test')).toBeInTheDocument()
    expect(within(relayPath).getByText('已连接')).toBeInTheDocument()
    expect(within(relayPath).getByText('电脑 desktop-1')).toBeInTheDocument()
    expect(within(relayPath).getByText('在线')).toBeInTheDocument()
    expect(within(relayPath).getByText('本地 runtime')).toBeInTheDocument()
    expect(within(relayPath).getByText('Runtime 在线')).toBeInTheDocument()
    expect(within(relayPath).getByText('实时事件')).toBeInTheDocument()
    expect(window.location.href).not.toContain('pair-token')
    expect(JSON.parse(window.localStorage.getItem('yive.mobile.relay.pairing') ?? '{}')).toEqual({
      desktopId: 'desktop-1',
      serverUrl: 'https://relay.test',
      token: 'pair-token',
    })
    expect(fetchCalls).not.toContain('/api/ui/session')
    expect(fetchCalls).not.toContain('/api/workspaces')
    expect(MockRelayWebSocket.sent.map((item) => item.type)).toEqual(
      expect.arrayContaining(['list_workspaces', 'list_agents_and_runs', 'subscribe_mobile_events'])
    )
  })

  test('/mobile relay runtime restores the last selected workspace for the paired desktop', async () => {
    window.localStorage.setItem(
      'yive.mobile.relay.activeWorkspace',
      JSON.stringify({ desktopId: 'desktop-1', workspaceId: 'workspace-beta' })
    )
    MockRelayWebSocket.workspaces = [
      { id: 'workspace-alpha', name: 'Relay Alpha', path: '/relay/alpha' },
      { id: 'workspace-beta', name: 'Relay Beta', path: '/relay/beta' },
    ]
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [
            { device_id: 'desktop-1', features: REMOTE_CONTROL_FEATURES, runtime_status: 'online' },
          ],
          mobiles: [],
        })
      }
      throw new Error(`Unexpected fetch in relay workspace restore: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    expect(await screen.findByRole('button', { name: /Relay Beta/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    await waitFor(() =>
      expect(
        MockRelayWebSocket.sent.some(
          (item) =>
            item.type === 'list_agents_and_runs' &&
            JSON.stringify(item.payload).includes('workspace-beta')
        )
      ).toBe(true)
    )
  })

  test('/mobile relay runtime hides agent-list task dispatch controls', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in relay team dispatch: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    const remoteWorker = await screen.findByText('Remote Worker')
    const agentCard = remoteWorker.closest('.mobile-agent-card')
    if (!agentCard) throw new Error('Expected Remote Worker agent card')

    expect(within(agentCard as HTMLElement).queryByRole('button', { name: '派任务' })).toBeNull()
    expect(screen.queryByLabelText('任务内容')).toBeNull()
    expect(JSON.stringify(MockRelayWebSocket.sent)).not.toContain('team_send')
    expect(JSON.stringify(MockRelayWebSocket.sent)).not.toContain('agent_token')
    expect(JSON.stringify(MockRelayWebSocket.sent)).not.toContain('HIVE_AGENT_TOKEN')
  })

  test('/mobile applies relay mobile events snapshots to the dashboard', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&device_id=phone-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [
            {
              device_id: 'desktop-1',
              runtime_status: 'online',
            },
          ],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in relay mobile events dashboard test: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    expect(await screen.findByText('Remote Worker')).toBeInTheDocument()
    const subscribeEnvelope = await waitFor(() => {
      const envelope = MockRelayWebSocket.sent.find(
        (item) => item.type === 'subscribe_mobile_events'
      )
      expect(envelope).toBeTruthy()
      return envelope as Record<string, unknown>
    })
    expect(subscribeEnvelope).toMatchObject({
      channel: 'mobile_events',
      from: 'phone-1',
      to: 'desktop-1',
    })
    const socket = MockRelayWebSocket.instances.at(-1)
    if (!socket) throw new Error('Expected relay websocket')

    act(() => {
      socket.receive({
        channel: 'mobile_events',
        from: 'desktop-1',
        payload: {
          snapshot: {
            active_workspace: {
              orchestrator: orchestratorPayload(),
              terminal_runs: [
                runPayload({
                  agentId: 'worker-relay-events',
                  agentName: 'Relay Events Worker',
                  runId: 'run-relay-events',
                  status: 'running',
                }),
              ],
              workspace: { id: 'workspace-1', name: 'Relay Event Lab', path: '/relay/events' },
              workers: [
                workerPayload({
                  id: 'worker-relay-events',
                  name: 'Relay Events Worker',
                  conversationActivity: 'busy',
                }),
              ],
            },
            active_workspace_id: 'workspace-1',
            connection: {},
            generated_at: Date.now(),
            workspaces: [
              {
                id: 'workspace-1',
                is_active: true,
                name: 'Relay Event Lab',
                path: '/relay/events',
              },
            ],
          },
          type: 'mobile-snapshot',
        },
        request_id: subscribeEnvelope.request_id,
        to: 'phone-1',
        type: 'mobile_events_message',
      })
    })

    expect(await screen.findByText('Relay Events Worker')).toBeInTheDocument()
    expect(screen.queryByText('Remote Worker')).not.toBeInTheDocument()
    expect(await screen.findByText('Agent(2)')).toBeInTheDocument()
    openBackgroundTab()
    await waitFor(() => {
      expect(screen.getAllByText(/事件流已恢复/u).length).toBeGreaterThanOrEqual(1)
    })
  })

  test('/mobile warns when relay mobile events become stale', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&device_id=phone-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [
            {
              device_id: 'desktop-1',
              runtime_status: 'online',
            },
          ],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in relay stale mobile events test: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    await screen.findByText('Remote Worker')
    const subscribeEnvelope = await waitFor(() => {
      const envelope = MockRelayWebSocket.sent.find(
        (item) => item.type === 'subscribe_mobile_events'
      )
      expect(envelope).toBeTruthy()
      return envelope as Record<string, unknown>
    })
    const socket = MockRelayWebSocket.instances.at(-1)
    if (!socket) throw new Error('Expected relay websocket')

    act(() => {
      socket.receive({
        channel: 'mobile_events',
        from: 'desktop-1',
        payload: {
          snapshot: {
            active_workspace: {
              orchestrator: orchestratorPayload(),
              terminal_runs: [
                runPayload({
                  agentId: 'worker-stale-events',
                  agentName: 'Stale Events Worker',
                  runId: 'run-stale-events',
                  status: 'running',
                }),
              ],
              workspace: { id: 'workspace-1', name: 'Relay Event Lab', path: '/relay/events' },
              workers: [
                workerPayload({
                  id: 'worker-stale-events',
                  name: 'Stale Events Worker',
                  conversationActivity: 'busy',
                }),
              ],
            },
            active_workspace_id: 'workspace-1',
            connection: {},
            generated_at: new Date('2020-01-01T08:30:00.000Z').getTime(),
            workspaces: [
              {
                id: 'workspace-1',
                is_active: true,
                name: 'Relay Event Lab',
                path: '/relay/events',
              },
            ],
          },
          type: 'mobile-snapshot',
        },
        request_id: subscribeEnvelope.request_id,
        to: 'phone-1',
        type: 'mobile_events_message',
      })
    })

    expect(await screen.findByText('Stale Events Worker')).toBeInTheDocument()
    openBackgroundTab()
    await waitFor(() => {
      expect(screen.getAllByText(/事件流可能过期/u).length).toBeGreaterThanOrEqual(1)
    })
    expect(document.querySelector('.mobile-lan-status')).toHaveAttribute('data-tone', 'warn')
  })

  test('/mobile shows relay mobile events reconnect status after the socket closes', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&device_id=phone-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [
            {
              device_id: 'desktop-1',
              runtime_status: 'online',
            },
          ],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in relay mobile events reconnect status test: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    await screen.findByText('Remote Worker')
    await waitFor(() => {
      expect(MockRelayWebSocket.sent.some((item) => item.type === 'subscribe_mobile_events')).toBe(
        true
      )
    })
    const socket = MockRelayWebSocket.instances.at(-1)
    if (!socket) throw new Error('Expected relay websocket')

    act(() => {
      socket.close()
    })

    openBackgroundTab()
    await waitFor(() => {
      expect(
        screen.getAllByText('事件流重连中：Relay mobile socket closed（第 1 次，1 秒后重试）')
          .length
      ).toBeGreaterThanOrEqual(1)
    })
    expect(document.querySelector('.mobile-lan-status')).toHaveAttribute('data-tone', 'warn')
  })

  test('/mobile clears relay reconnect warnings after mobile events resubscribe succeeds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&device_id=phone-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [
            {
              device_id: 'desktop-1',
              runtime_status: 'online',
            },
          ],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in relay mobile events recovery status test: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    await screen.findByText('Remote Worker')
    await waitFor(() => {
      expect(MockRelayWebSocket.sent.some((item) => item.type === 'subscribe_mobile_events')).toBe(
        true
      )
    })
    const firstSocket = MockRelayWebSocket.instances.at(-1)
    if (!firstSocket) throw new Error('Expected first relay websocket')

    act(() => {
      firstSocket.close()
    })

    expect(screen.queryByText(/远程状态已暂停更新/u)).not.toBeInTheDocument()
    await act(async () => {
      vi.advanceTimersByTime(4_000)
      await Promise.resolve()
    })

    expect(
      await screen.findByText(
        '远程状态已暂停更新：事件流正在重连，1 秒后重试，当前列表是上次收到的状态。'
      )
    ).toBeInTheDocument()
    expect(document.querySelector('.mobile-lan-status')).toHaveAttribute('data-tone', 'warn')

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })

    const secondSocket = MockRelayWebSocket.instances.at(-1)
    if (!secondSocket || secondSocket === firstSocket) {
      throw new Error('Expected relay websocket reconnect')
    }
    const secondSubscribeEnvelope = await waitFor(() => {
      const envelope = MockRelayWebSocket.sent
        .filter((item) => item.type === 'subscribe_mobile_events')
        .at(-1)
      expect(envelope).toBeTruthy()
      return envelope as Record<string, unknown>
    })

    act(() => {
      secondSocket.receive({
        channel: 'mobile_events',
        from: 'desktop-1',
        payload: {
          snapshot: {
            active_workspace: {
              orchestrator: orchestratorPayload(),
              terminal_runs: [
                runPayload({
                  agentId: 'worker-recovered-events',
                  agentName: 'Recovered Events Worker',
                  runId: 'run-recovered-events',
                  status: 'running',
                }),
              ],
              workspace: { id: 'workspace-1', name: 'Relay Event Lab', path: '/relay/events' },
              workers: [
                workerPayload({
                  id: 'worker-recovered-events',
                  name: 'Recovered Events Worker',
                  conversationActivity: 'busy',
                }),
              ],
            },
            active_workspace_id: 'workspace-1',
            connection: {},
            generated_at: Date.now(),
            workspaces: [
              {
                id: 'workspace-1',
                is_active: true,
                name: 'Relay Event Lab',
                path: '/relay/events',
              },
            ],
          },
          type: 'mobile-snapshot',
        },
        request_id: secondSubscribeEnvelope.request_id,
        to: 'phone-1',
        type: 'mobile_events_message',
      })
    })

    expect(await screen.findByText('Recovered Events Worker')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByText(/远程状态已暂停更新/u)).not.toBeInTheDocument()
    })
    openBackgroundTab()
    expect(screen.getAllByText(/事件流已恢复/u).length).toBeGreaterThanOrEqual(1)
    expect(document.querySelector('.mobile-lan-status')).toHaveAttribute('data-tone', 'ok')
  })

  test('/mobile refreshes relay desktop runtime freshness when the phone returns foreground', async () => {
    const now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    let deviceLoads = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        deviceLoads += 1
        return json({
          desktops: [
            deviceLoads === 1
              ? {
                  device_id: 'desktop-1',
                  runtime_message: 'Local runtime down',
                  runtime_status: 'offline',
                  runtime_updated_at: now - 45_000,
                }
              : {
                  device_id: 'desktop-1',
                  last_seen_at: now,
                  runtime_status: 'online',
                  runtime_updated_at: now,
                },
          ],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in relay foreground status refresh: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    expect(await screen.findByText('Remote Worker')).toBeInTheDocument()
    expect(screen.getByLabelText('局域网连接状态')).toHaveTextContent('Relay 在线 · Runtime 不可用')
    expect(screen.getByLabelText('局域网连接状态')).toHaveTextContent(
      '目标电脑已连接 Relay，但本地 yive runtime 不可用：Local runtime down。'
    )
    openBackgroundTab()
    const relayPath = screen.getByLabelText('远程链路状态')
    expect(within(relayPath).getByText('电脑 desktop-1')).toBeInTheDocument()
    expect(within(relayPath).getByText('在线')).toBeInTheDocument()
    expect(within(relayPath).getByText('本地 runtime')).toBeInTheDocument()
    expect(within(relayPath).getByText('Local runtime down')).toBeInTheDocument()
    const connectGuide = screen.getByLabelText('电脑端连接指引')
    expect(within(connectGuide).getByText(/--device-id desktop-1/u)).toBeInTheDocument()
    expect(within(connectGuide).queryAllByText(/pair-token/u)).toHaveLength(0)
    act(() => {
      window.dispatchEvent(new Event('pageshow'))
    })

    await waitFor(() => expect(deviceLoads).toBeGreaterThanOrEqual(2))
    expect(screen.getByLabelText('局域网连接状态')).toHaveTextContent('Relay 在线 · Runtime 在线')
    expect(within(relayPath).getByText('Runtime 在线')).toBeInTheDocument()
  })

  test('/mobile relay runtime surfaces stale desktop runtime status in the top card', async () => {
    const now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [
            {
              device_id: 'desktop-1',
              last_seen_at: now - 2_000,
              runtime_status: 'online',
              runtime_updated_at: now - 45_000,
            },
          ],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in relay stale runtime status: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    await waitFor(() =>
      expect(screen.getByLabelText('局域网连接状态')).toHaveTextContent('Relay 在线 · 状态可能过期')
    )
    expect(screen.getByLabelText('局域网连接状态')).toHaveTextContent(
      '目标电脑在线，但 runtime 状态 状态可能过期 · 45 秒前，如操作失败请重试连接。'
    )
    openBackgroundTab()
    const relayPath = screen.getByLabelText('远程链路状态')
    expect(within(relayPath).getByText('状态可能过期 · 45 秒前')).toBeInTheDocument()
  })

  test('/mobile relay runtime can run diagnostics from a healthy status card', async () => {
    const now = Date.now()
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const fetchCalls: Array<{ headers?: HeadersInit; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push({ ...(init?.headers ? { headers: init.headers } : {}), url })
      if (url === 'https://relay.test/health') {
        return json({
          desktop_count: 1,
          deployment: {
            public_url_configured: true,
          },
          heartbeat_interval_ms: 30_000,
          heartbeat_timeout_ms: 75_000,
          mobile_count: 1,
          ok: true,
          pairing_store: {
            device_token_count: 1,
            issued_token_count: 0,
            persistent: true,
            require_desktop_binding: true,
          },
          protocol_version: 1,
          service: 'hive-relay',
          static: { mobile_app_available: true },
          terminal_proxy_count: 1,
          version: '1.4.0',
        })
      }
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [
            {
              device_id: 'desktop-1',
              features: REMOTE_CONTROL_FEATURES,
              last_seen_at: now - 5000,
              runtime_status: 'online',
              runtime_updated_at: now,
              supervisor_phase: 'running',
              supervisor_status: 'running',
              supervisor_updated_at: now - 6000,
            },
          ],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      throw new Error(`Unexpected fetch in healthy relay runtime diagnostics: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    expect(await screen.findByText('Remote Worker')).toBeInTheDocument()
    openBackgroundTab()
    fireEvent.click(screen.getByRole('button', { name: '诊断' }))

    const diagnosticsHeading = await screen.findByRole('heading', { name: 'Relay 诊断' })
    const diagnosticsPanel = diagnosticsHeading.closest('section')
    expect(diagnosticsPanel).not.toBeNull()
    expect(
      await within(diagnosticsPanel as HTMLElement).findByText(
        'Relay 服务在线，当前 1 台电脑、1 台手机连接。'
      )
    ).toBeInTheDocument()
    expect(
      within(diagnosticsPanel as HTMLElement).getByText(/Relay 网络正常：最近检查耗时 \d+ms。/u)
    ).toBeInTheDocument()
    expect(
      within(diagnosticsPanel as HTMLElement).getByText(
        'Relay 心跳：每 30 秒 检查一次，1 分钟 15 秒 无响应会断开设备。'
      )
    ).toBeInTheDocument()
    expect(
      within(diagnosticsPanel as HTMLElement).getByText('终端代理连接 1 个。')
    ).toBeInTheDocument()
    expect(
      within(diagnosticsPanel as HTMLElement).getByText(
        'Android App 基础条件已具备；下一步用 release 证书 SHA-256 生成并校验 assetlinks.json。'
      )
    ).toBeInTheDocument()
    expect(
      within(diagnosticsPanel as HTMLElement).getByText('配对 token 可用，设备列表接口已返回。')
    ).toBeInTheDocument()
    expect(
      within(diagnosticsPanel as HTMLElement).getByText(
        '实时事件流尚未建立，当前列表依赖主动刷新。'
      )
    ).toBeInTheDocument()
    expect(
      within(diagnosticsPanel as HTMLElement).getByText('目标电脑 desktop-1 在线，Runtime 在线。')
    ).toBeInTheDocument()
    expect(
      within(diagnosticsPanel as HTMLElement).getByText(
        '电脑端 Relay 守护正常，阶段 running，更新于 6 秒前。'
      )
    ).toBeInTheDocument()
    expect(within(diagnosticsPanel as HTMLElement).getByText(/最近在线/u)).toBeInTheDocument()
    expect(within(diagnosticsPanel as HTMLElement).getByText('链路可用')).toBeInTheDocument()
    expect(
      within(diagnosticsPanel as HTMLElement).getByText(/通过 \d+ 项检查/u)
    ).toBeInTheDocument()
    expect(
      within(diagnosticsPanel as HTMLElement).getByText('目标电脑 desktop-1')
    ).toBeInTheDocument()
    fireEvent.click(
      within(diagnosticsPanel as HTMLElement).getByRole('button', { name: '复制诊断' })
    )
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    const copiedDiagnostics = String(writeText.mock.calls[0]?.[0] ?? '')
    expect(copiedDiagnostics).toContain('[ok] 终端代理连接 1 个。')
    expect(copiedDiagnostics).toContain('[ok] 电脑端 Relay 守护正常，阶段 running，更新于 6 秒前。')
    expect(copiedDiagnostics).toContain('[warn] 实时事件流尚未建立，当前列表依赖主动刷新。')
    expect(copiedDiagnostics).toContain('推荐命令')
    expect(copiedDiagnostics).toContain(
      '公网验收清单: yive relay checklist --server https://relay.test --desktop-id desktop-1 --workspace-id <workspace-id> --run-id <run-id> --workspace-file <relative-file>'
    )
    expect(copiedDiagnostics).toContain(
      '本地连接状态自检: yive connect status --server https://relay.test --token <admin-or-device-token> --device-id desktop-1 --runtime http://127.0.0.1:3001 --status-file "$env:USERPROFILE\\.config\\yive\\desktop-relay-status.json"'
    )
    expect(copiedDiagnostics).toContain(
      '电脑端 Relay doctor: yive relay doctor --server https://relay.test --token <relay-admin-token> --json'
    )
    expect(copiedDiagnostics).toContain(
      '公网一键诊断验收: pnpm smoke:relay-all -- --server https://relay.test --token <relay-admin-token> --desktop-id desktop-1 --max-stale-ms 30000 --json'
    )
    expect(copiedDiagnostics).toContain(
      '公网终端闭环验收: pnpm smoke:relay-all -- --server https://relay.test --token <relay-admin-token> --desktop-id desktop-1 --max-stale-ms 30000 --verify-terminal-output'
    )
    expect(copiedDiagnostics).toContain(
      '公网实时状态验收: pnpm smoke:relay-mobile-events -- --server https://relay.test --token <relay-admin-token> --desktop-id desktop-1 --max-stale-ms 30000'
    )
    expect(copiedDiagnostics).toContain(
      '公网文件交换验收: pnpm smoke:relay-file-exchange -- --server https://relay.test --token <relay-admin-token> --desktop-id desktop-1'
    )
    expect(copiedDiagnostics).toContain(
      '公网图片粘贴验收: pnpm smoke:relay-all -- --server https://relay.test --token <relay-admin-token> --desktop-id desktop-1 --max-stale-ms 30000 --workspace-id <workspace-id> --run-id <run-id> --verify-image-paste'
    )
    expect(copiedDiagnostics).toContain(
      'Android/TWA 发布检查: pnpm mobile:android:check -- --domain https://relay.test --static-dir web/dist --out-dir android-twa --android-package com.example.yive --android-sha256 <release-cert-sha256> --check-domain'
    )
    expect(copiedDiagnostics).toContain('用途')
    expect(copiedDiagnostics).toContain(
      '本地连接状态自检: 在电脑端只读检查本地 runtime、Relay 注册和手机路由'
    )
    expect(copiedDiagnostics).toContain(
      '公网验收清单: 一次性生成公网 Relay、终端接管、文件下载和图片粘贴的验收步骤'
    )
    expect(copiedDiagnostics).toContain('电脑端 Relay doctor: 输出 JSON，供 App 或管理端自动诊断')
    expect(copiedDiagnostics).toContain(
      '公网一键诊断验收: 输出结构化 JSON，失败时查看 next_commands 和 repair_commands'
    )
    expect(copiedDiagnostics).toContain('公网终端闭环验收: 验证手机到本地 Agent 的终端输入输出闭环')
    expect(copiedDiagnostics).toContain(
      '公网实时状态验收: 验证手机看板能通过 Relay 收到本地电脑实时状态和心跳'
    )
    expect(copiedDiagnostics).toContain(
      '公网文件交换验收: 验证手机和本地电脑之间的临时文件上传、列表、下载和清理链路'
    )
    expect(copiedDiagnostics).toContain(
      '公网图片粘贴验收: 验证手机图片上传后能通过 Relay 绑定到本地 Agent 附件'
    )
    expect(copiedDiagnostics).toContain(
      'Android/TWA 发布检查: 生成并验证 Android App Links、静态手机页面和 TWA 包装文件'
    )
    const structuredReportText = copiedDiagnostics.split('结构化诊断 JSON\n')[1]
    expect(structuredReportText).toBeTruthy()
    const structuredReport = JSON.parse(structuredReportText ?? '{}') as {
      checks: Array<{ id: string; label: string; tone: string }>
      desktop_id: string
      next_action?: string
      next_action_id?: string
      ok: boolean
      recommended_smoke: string[]
      relay: { devices_checked: boolean; health_checked: boolean }
      status: string
    }
    expect(structuredReport).toMatchObject({
      desktop_id: 'desktop-1',
      ok: true,
      relay: { devices_checked: true, health_checked: true },
      status: 'ready',
    })
    expect(structuredReport.next_action).toBeUndefined()
    expect(structuredReport.next_action_id).toBeUndefined()
    expect(structuredReport.recommended_smoke).toEqual([
      'checklist',
      'doctor',
      'events',
      'terminal',
      'file_exchange',
      'image_paste',
    ])
    expect(structuredReport.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        'relay_http',
        'relay_devices',
        'relay_events',
        'desktop_runtime',
        'desktop_supervisor',
      ])
    )
    expect(
      within(diagnosticsPanel as HTMLElement)
        .getAllByText('公网验收清单')
        .some((node) => node.tagName.toLowerCase() === 'code')
    ).toBe(true)
    expect(
      within(diagnosticsPanel as HTMLElement).getByText('本地连接状态自检')
    ).toBeInTheDocument()
    expect(
      within(diagnosticsPanel as HTMLElement).getByText('电脑端 Relay doctor')
    ).toBeInTheDocument()
    expect(
      within(diagnosticsPanel as HTMLElement).getByText('公网一键诊断验收')
    ).toBeInTheDocument()
    expect(
      within(diagnosticsPanel as HTMLElement).getByText('公网终端闭环验收')
    ).toBeInTheDocument()
    expect(
      within(diagnosticsPanel as HTMLElement).getByText('公网实时状态验收')
    ).toBeInTheDocument()
    expect(
      within(diagnosticsPanel as HTMLElement).getByText('公网文件交换验收')
    ).toBeInTheDocument()
    expect(
      within(diagnosticsPanel as HTMLElement).getByText('公网图片粘贴验收')
    ).toBeInTheDocument()
    expect(within(diagnosticsPanel as HTMLElement).getByText('推荐验收')).toBeInTheDocument()
    const smokeList = within(diagnosticsPanel as HTMLElement).getByLabelText('推荐验收清单')
    expect(within(smokeList).getByText('公网验收清单')).toBeInTheDocument()
    expect(within(smokeList).getByText('Relay doctor')).toBeInTheDocument()
    expect(within(smokeList).getByText('实时状态验收')).toBeInTheDocument()
    expect(within(smokeList).getByText('终端闭环验收')).toBeInTheDocument()
    expect(within(smokeList).getByText('文件交换验收')).toBeInTheDocument()
    expect(within(smokeList).getByText('图片粘贴验收')).toBeInTheDocument()
    expect(
      within(smokeList).getByText('生成一份从 Relay doctor 到终端、文件和图片的完整公网验收步骤。')
    ).toBeInTheDocument()
    expect(
      within(smokeList).getByText('确认手机接管后，终端输入和输出能通过公网 Relay 完成闭环。')
    ).toBeInTheDocument()
    expect(
      within(smokeList).getByText('确认手机上传图片后，Relay 能把附件绑定到本地 Agent。')
    ).toBeInTheDocument()
    expect(copiedDiagnostics).not.toContain('pair-token')
    expect(window.location.href).not.toContain('pair-token')
    expect(fetchCalls).toContainEqual({
      headers: { authorization: 'Bearer pair-token' },
      url: 'https://relay.test/devices',
    })
  })

  test('/mobile relay runtime diagnoses target desktop and local runtime failures', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    const fetchCalls: Array<{ headers?: HeadersInit; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push({ ...(init?.headers ? { headers: init.headers } : {}), url })
      if (url === 'https://relay.test/health') {
        return json({
          desktop_count: 1,
          features: REMOTE_CONTROL_FEATURES,
          mobile_count: 1,
          ok: true,
          pairing_store: {
            device_token_count: 1,
            issued_token_count: 0,
            persistent: false,
          },
          protocol_version: 1,
          service: 'hive-relay',
          static: { mobile_app_available: false },
          version: '1.4.0',
        })
      }
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [
            {
              device_id: 'desktop-1',
              runtime_message: 'Local runtime down',
              runtime_status: 'offline',
              runtime_updated_at: Date.now() - 60_000,
            },
          ],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      throw new Error(`Unexpected fetch in relay runtime diagnostics: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    await waitFor(() =>
      expect(screen.getByLabelText('局域网连接状态')).toHaveTextContent(
        '目标电脑已连接 Relay，但本地 yive runtime 不可用：Local runtime down。'
      )
    )
    expect(
      screen.queryByText('连接失败，请确认云端 Relay 在线、本地电脑已执行 yive connect。')
    ).not.toBeInTheDocument()
    openBackgroundTab()
    fireEvent.click(screen.getByRole('button', { name: '诊断' }))
    expect(screen.getByRole('heading', { name: 'Relay 诊断' })).toBeInTheDocument()
    expect(
      await screen.findByText('Relay 服务在线，当前 1 台电脑、1 台手机连接。')
    ).toBeInTheDocument()
    expect(screen.getByText(/Relay 网络正常：最近检查耗时 \d+ms。/u)).toBeInTheDocument()
    expect(
      screen.getByText('Relay 没有找到构建后的手机页面，请检查服务器静态目录配置。')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Relay 还没有发布构建后的手机页面，Android App 打包前需要先部署 web/dist。')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Relay 配对信息未持久化，服务器重启后需要重新配对。')
    ).toBeInTheDocument()
    expect(screen.getByText('配对 token 可用，设备列表接口已返回。')).toBeInTheDocument()
    expect(
      screen.getAllByText('目标电脑已连接 Relay，但本地 yive runtime 不可用：Local runtime down。')
        .length
    ).toBeGreaterThan(0)
    expect(screen.getByText('链路异常')).toBeInTheDocument()
    const nextAction = screen.getByText(/下一步：请在目标电脑启动 yive runtime/u)
    expect(nextAction).toBeInTheDocument()
    expect(nextAction).toHaveAttribute('data-action', 'start_desktop_runtime')
    expect(
      screen.getByText('请在目标电脑启动 yive runtime；启动后手机端点“重试连接”。')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '复制诊断' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled())
    const copiedDiagnostics = String(
      vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0] ?? ''
    )
    const structuredReport = JSON.parse(
      copiedDiagnostics.split('结构化诊断 JSON\n')[1] ?? '{}'
    ) as {
      next_action?: string
      next_action_id?: string
      ok: boolean
      recommended_smoke: string[]
    }
    expect(structuredReport).toMatchObject({
      next_action: expect.stringContaining('请在目标电脑启动 yive runtime'),
      next_action_id: 'start_desktop_runtime',
      ok: false,
      recommended_smoke: ['doctor'],
    })
    const smokeList = screen.getByLabelText('推荐验收清单')
    expect(within(smokeList).getByText('Relay doctor')).toBeInTheDocument()
    expect(within(smokeList).queryByText('实时状态验收')).not.toBeInTheDocument()
    expect(within(smokeList).queryByText('终端闭环验收')).not.toBeInTheDocument()
    expect(within(smokeList).queryByText('文件交换验收')).not.toBeInTheDocument()
    expect(window.location.href).not.toContain('pair-token')
    expect(fetchCalls).toContainEqual({
      headers: { authorization: 'Bearer pair-token' },
      url: 'https://relay.test/devices',
    })
  })

  test('/mobile disables relay file exchange while the desktop runtime is offline', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/health') {
        return json({
          desktop_count: 1,
          mobile_count: 1,
          ok: true,
          protocol_version: 1,
          service: 'hive-relay',
          static: { mobile_app_available: true },
          version: '1.4.0',
        })
      }
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [
            {
              device_id: 'desktop-1',
              runtime_message: 'Local runtime down',
              runtime_status: 'offline',
              runtime_updated_at: Date.now() - 60_000,
            },
          ],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      throw new Error(`Unexpected fetch in relay offline file exchange test: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    await waitFor(() =>
      expect(screen.getByLabelText('局域网连接状态')).toHaveTextContent(
        'Relay 在线 · Runtime 不可用'
      )
    )
    fireEvent.click(screen.getByRole('button', { name: '文件' }))

    expect(
      await screen.findByText(
        '目标电脑已连接 Relay，但本地 yive runtime 不可用：Local runtime down。 文件交换需要本地电脑 runtime 在线。'
      )
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '清空' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(screen.getByLabelText('发送工作区文件到手机')).toBeDisabled()
    expect(document.querySelector('.mobile-file-upload input')).toBeDisabled()
    expect(MockRelayWebSocket.sent.map((item) => item.type)).not.toContain('upload_mobile_file')
    expect(MockRelayWebSocket.sent.map((item) => item.type)).not.toContain(
      'send_workspace_file_to_mobile'
    )
  })

  test('/mobile relay runtime explains local runtime proxy failures', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/health') {
        return json({
          desktop_count: 1,
          mobile_count: 1,
          ok: true,
          protocol_version: 1,
          service: 'hive-relay',
          static: { mobile_app_available: true },
          version: '1.4.0',
        })
      }
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      throw new Error(`Unexpected fetch in relay local runtime error: ${url}`)
    })
    vi.stubGlobal('WebSocket', LocalRuntimeErrorRelayWebSocket)

    render(<App />)

    await waitFor(() =>
      expect(screen.getByLabelText('局域网连接状态')).toHaveTextContent(
        '目标电脑在线，但本地 yive runtime 请求失败：Local runtime request timed out after 15000ms。请确认电脑端 yive 正在运行后重试。'
      )
    )
    expect(screen.queryByText(/Relay 返回错误/u)).not.toBeInTheDocument()
    openBackgroundTab()
    fireEvent.click(screen.getByRole('button', { name: '诊断' }))
    expect(await screen.findByText('配对 token 可用，设备列表接口已返回。')).toBeInTheDocument()
    expect(screen.getByText('目标电脑 desktop-1 在线，Runtime 在线。')).toBeInTheDocument()
    expect(window.location.href).not.toContain('pair-token')
  })

  test('/mobile relay runtime diagnoses phones bound to a different desktop', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&device_id=phone-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/health') {
        return json({
          desktop_count: 1,
          mobile_count: 1,
          ok: true,
          protocol_version: 1,
          service: 'hive-relay',
          static: { mobile_app_available: true },
          version: '1.4.0',
        })
      }
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
          mobiles: [{ desktop_id: 'desktop-2', device_id: 'phone-1' }],
        })
      }
      throw new Error(`Unexpected fetch in relay mismatched mobile diagnostics: ${url}`)
    })
    vi.stubGlobal('WebSocket', FailingRelayWebSocket)

    render(<App />)

    await waitFor(() =>
      expect(screen.getByLabelText('局域网连接状态')).toHaveTextContent(
        '目标电脑已连接 Relay，但本地 yive runtime 不可用，请在电脑端启动 yive。'
      )
    )
    openBackgroundTab()
    fireEvent.click(screen.getByRole('button', { name: '诊断' }))
    const diagnosticsHeading = screen.getByRole('heading', { name: 'Relay 诊断' })
    const diagnosticsPanel = diagnosticsHeading.closest('section')
    expect(diagnosticsPanel).toBeTruthy()
    expect(await screen.findByText('配对 token 可用，设备列表接口已返回。')).toBeInTheDocument()
    expect(
      screen.getByText('当前手机 phone-1 连接到 desktop-2，不是页面目标电脑 desktop-1。')
    ).toBeInTheDocument()
    expect(screen.getByText('手机当前绑定的电脑 desktop-2 不在线。')).toBeInTheDocument()
    expect(
      screen.getByText('请点“切换电脑”选择正确电脑，或重新用目标电脑生成配对链接。')
    ).toBeInTheDocument()
    const nextAction = screen.getByText(/下一步：请点“切换电脑”选择正确电脑/u)
    expect(nextAction).toHaveAttribute('data-action', 'switch_desktop')
    fireEvent.click(
      within(diagnosticsPanel as HTMLElement).getByRole('button', { name: '切换电脑' })
    )
    expect(
      within(diagnosticsPanel as HTMLElement).getByText('已执行：切换电脑')
    ).toBeInTheDocument()
    expect(window.location.href).not.toContain('pair-token')
  })

  test('/mobile loads dispatches through relay mode without task envelopes', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    const fetchCalls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push(url)
      throw new Error(`Unexpected fetch in relay dispatch mode: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '派单' }))

    expect(await screen.findByText('Relay dispatch waiting for phone report.')).toBeInTheDocument()
    expect(MockRelayWebSocket.sent.map((item) => item.type)).not.toContain('list_workspace_tasks')
    expect(MockRelayWebSocket.sent.map((item) => item.type)).not.toContain('save_workspace_tasks')
    expect(MockRelayWebSocket.sent.map((item) => item.type)).toContain('list_dispatches')
  })

  test('/mobile can report a relay dispatch from the dispatches tab', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '派单' }))
    const dispatchCard = (
      await screen.findByText('Relay dispatch waiting for phone report.')
    ).closest('.mobile-dispatch-item')
    expect(dispatchCard).not.toBeNull()
    expect(within(dispatchCard as HTMLElement).getByText('Relay persisted progress.')).toBeVisible()
    const failedDispatchCard = screen
      .getByText('Historical failed Relay dispatch.')
      .closest('.mobile-dispatch-item')
    expect(failedDispatchCard).not.toBeNull()
    expect(within(failedDispatchCard as HTMLElement).getByText('失败')).toBeVisible()
    expect(
      within(failedDispatchCard as HTMLElement).queryByRole('button', { name: '发送补充' })
    ).toBeNull()
    fireEvent.change(within(dispatchCard as HTMLElement).getByLabelText('补充说明'), {
      target: { value: 'Relay supplemental context.' },
    })
    fireEvent.click(within(dispatchCard as HTMLElement).getByRole('button', { name: '发送补充' }))

    let noteRequest: Record<string, unknown> | undefined
    await waitFor(() => {
      noteRequest = MockRelayWebSocket.sent.find(
        (item) =>
          item.type === 'mobile_action' && JSON.stringify(item.payload).includes('team_note')
      )
      expect(noteRequest).toMatchObject({
        payload: {
          kind: 'team_note',
          payload: { text: 'Relay supplemental context.' },
          target: { dispatch_id: 'dispatch-relay-open' },
          workspace_id: 'workspace-1',
        },
        type: 'mobile_action',
      })
    })
    fireEvent.change(within(dispatchCard as HTMLElement).getByLabelText('进度状态'), {
      target: { value: 'Relay status update.' },
    })
    fireEvent.click(within(dispatchCard as HTMLElement).getByRole('button', { name: '发送进度' }))

    await waitFor(() =>
      expect(
        MockRelayWebSocket.sent.some(
          (item) =>
            item.type === 'mobile_action' &&
            JSON.stringify(item.payload).includes('team_status') &&
            JSON.stringify(item.payload).includes('Relay status update.')
        )
      ).toBe(true)
    )

    fireEvent.change(within(dispatchCard as HTMLElement).getByLabelText('汇报内容'), {
      target: { value: 'Relay phone report.' },
    })
    fireEvent.click(within(dispatchCard as HTMLElement).getByRole('button', { name: '提交汇报' }))

    let reportRequest: Record<string, unknown> | undefined
    await waitFor(() => {
      reportRequest = MockRelayWebSocket.sent.find(
        (item) =>
          item.type === 'mobile_action' && JSON.stringify(item.payload).includes('team_report')
      )
      expect(reportRequest).toMatchObject({
        payload: {
          kind: 'team_report',
          payload: { text: 'Relay phone report.' },
          target: { agent_id: 'worker-1' },
          workspace_id: 'workspace-1',
        },
        type: 'mobile_action',
      })
    })
    expect(JSON.stringify(reportRequest)).not.toContain('dispatch-relay-open')
    expect(JSON.stringify(reportRequest)).not.toContain('"status"')
    expect(JSON.stringify(MockRelayWebSocket.sent)).not.toContain('pair-token')
    expect(JSON.stringify(MockRelayWebSocket.sent)).not.toContain('agent_token')
    expect(JSON.stringify(MockRelayWebSocket.sent)).not.toContain('HIVE_AGENT_TOKEN')
  })

  test('/mobile relay runtime does not connect the local mobile events websocket', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    expect((await screen.findAllByText('Relay Workspace')).length).toBeGreaterThan(0)
    expect(MockRelayWebSocket.urls.some((url) => url.includes('/ws/mobile/events'))).toBe(false)
  })

  test('/mobile renders the phone-first workspace and agent dashboard', async () => {
    window.history.pushState({}, '', '/mobile')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([
          {
            id: 'workspace-1',
            name: 'Hive Lab',
            path: 'C:/work/hive-lab',
          },
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([
          {
            active_dispatch_id: null,
            conversation_activity: 'busy',
            provider: 'codex',
            id: 'worker-1',
            last_observed_at: 1,
            last_pty_line: 'review complete',
            name: 'Alice',
            process_state: 'running',
            queue_pause_reason: null,
            queued_dispatch_count: 2,
            kind: 'worker',
          },
          {
            active_dispatch_id: null,
            conversation_activity: 'idle',
            provider: null,
            id: 'worker-2',
            last_observed_at: 1,
            last_pty_line: null,
            name: 'Bob',
            process_state: 'running',
            queue_pause_reason: null,
            queued_dispatch_count: 0,
            kind: 'worker',
          },
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([
          {
            agent_id: 'workspace-1:orchestrator',
            agent_name: 'Orchestrator',
            run_id: 'run-1',
            status: 'running',
          },
        ])
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    expect(await screen.findByText('Agent(2)')).toBeInTheDocument()
    expect((await screen.findAllByText('Hive Lab')).length).toBeGreaterThan(0)
    expect(getBottomTab('Agent')).toHaveAttribute('aria-current', 'page')
    let lanStatus = getLanStatus()
    expect(lanStatus).toBeInTheDocument()
    expect(lanStatus).not.toHaveTextContent(/http:\/\/localhost(?::\d+)?\/mobile/)
    lanStatus = expandLanStatusDetails()
    expect(lanStatus).toHaveTextContent(/http:\/\/localhost(?::\d+)?\/mobile/)
    expect(lanStatus).toHaveTextContent(/\d{2}:\d{2}:\d{2}/)
    expect(lanStatus).toHaveTextContent('Yive runtime')
    fireEvent.click(getBottomTab('Agent'))
    const workspaceToggle = screen.getByRole('button', { name: /Hive Lab/ })
    expect(workspaceToggle).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById('mobile-workspace-switcher')).not.toBeVisible()
    expect(screen.getByRole('button', { name: '打开 Alice 终端' })).toHaveTextContent('2 queued')
    expect(screen.queryByText('review complete')).not.toBeInTheDocument()

    fireEvent.click(workspaceToggle)

    expect(workspaceToggle).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById('mobile-workspace-switcher')).toBeVisible()

    expect(screen.queryByText('Orchestrator')).toBeNull()
    expect((await screen.findAllByText('Alice')).length).toBeGreaterThan(0)
    expect(screen.getByText('Bob')).toBeInTheDocument()
    expect(screen.queryByText('review complete')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '通知' }))

    expect(await screen.findByText('通知 / 审批')).toBeInTheDocument()
    expect(window.localStorage.getItem('yive.mobile.activeTab')).toBe('notifications')
    expect(document.querySelectorAll('.mobile-approval-item').length).toBeGreaterThanOrEqual(1)
    expect(document.querySelector('.mobile-approval-summary')).not.toBeNull()
  })

  test('/mobile can open a requested initial tab from the URL', async () => {
    window.history.pushState({}, '', '/mobile?tab=files')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Files Lab', path: 'C:/work/files-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in initial mobile tab test: ${url}`)
    })

    render(<App />)

    expect(await screen.findByText('文件交换区')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '文件' })).toHaveAttribute('aria-current', 'page')
  })

  test('/mobile restores the last app tab when launched without a tab URL parameter', async () => {
    window.localStorage.setItem('yive.mobile.activeTab', 'files')
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({
        desktopId: 'desktop-1',
        serverUrl: 'https://relay.test',
        token: 'pair-token',
      })
    )
    window.history.pushState({}, '', '/mobile?relay=1')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [
            { device_id: 'desktop-1', features: REMOTE_CONTROL_FEATURES, runtime_status: 'online' },
          ],
          mobiles: [],
        })
      }
      throw new Error(`Unexpected fetch in restored mobile tab test: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    expect(await screen.findByText('文件交换区')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '文件' })).toHaveAttribute('aria-current', 'page')
  })

  test('/mobile falls back to Agent for an invalid requested tab', async () => {
    window.history.pushState({}, '', '/mobile?tab=terminal')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Hive Lab', path: 'C:/work/hive-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in invalid mobile tab test: ${url}`)
    })

    render(<App />)

    expect(screen.getByRole('button', { name: 'Agent' })).toHaveAttribute('aria-current', 'page')
  })

  test('/mobile applies local mobile events snapshots to the dashboard', async () => {
    window.history.pushState({}, '', '/mobile')
    vi.stubGlobal('WebSocket', MockMobileEventsWebSocket)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/settings/app-state/active_workspace_id') {
        return json({ key: 'active_workspace_id', value: null })
      }
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Event Lab', path: 'C:/work/events' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([
          workerPayload({
            conversationActivity: 'idle',
            id: 'worker-old',
            name: 'Polling Worker',
          }),
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in mobile events dashboard test: ${url}`)
    })

    render(<App />)

    expect(await screen.findByText('Polling Worker')).toBeInTheDocument()
    expect(MockMobileEventsWebSocket.urls).toContain('ws://localhost:3000/ws/mobile/events')
    const socket = MockMobileEventsWebSocket.instances.at(-1)
    if (!socket) throw new Error('Expected mobile events websocket')

    act(() => {
      socket.receive({
        snapshot: {
          active_workspace: {
            orchestrator: orchestratorPayload(),
            terminal_runs: [
              runPayload({
                agentId: 'worker-events',
                agentName: 'Events Worker',
                runId: 'run-events',
                status: 'running',
              }),
            ],
            workspace: { id: 'workspace-1', name: 'Event Lab', path: 'C:/work/events' },
            workers: [
              workerPayload({
                id: 'worker-events',
                name: 'Events Worker',
                conversationActivity: 'busy',
              }),
            ],
          },
          active_workspace_id: 'workspace-1',
          connection: {},
          generated_at: new Date('2026-06-10T08:00:00.000Z').getTime(),
          workspaces: [
            { id: 'workspace-1', is_active: true, name: 'Event Lab', path: 'C:/work/events' },
          ],
        },
        type: 'mobile-snapshot',
      })
    })

    expect(await screen.findByText('Events Worker')).toBeInTheDocument()
    expect(screen.queryByText('Polling Worker')).not.toBeInTheDocument()
    expect(await screen.findByText('Agent(2)')).toBeInTheDocument()
  })

  test('/mobile shows agent-authored notifications from mobile event snapshots', async () => {
    window.history.pushState({}, '', '/mobile')
    window.localStorage.setItem('yive.mobile.notifications.enabled', '1')
    const { notifications } = stubMobileNotification({ permission: 'granted' })
    vi.stubGlobal('WebSocket', MockMobileEventsWebSocket)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/settings/app-state/active_workspace_id') {
        return json({ key: 'active_workspace_id', value: null })
      }
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Notify Lab', path: 'C:/work/notify' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in mobile agent notification test: ${url}`)
    })

    render(<App />)

    expect(await screen.findByText('手机提醒已开启')).toBeInTheDocument()
    const socket = MockMobileEventsWebSocket.instances.at(-1)
    if (!socket) throw new Error('Expected mobile events websocket')

    act(() => {
      socket.receive({
        snapshot: {
          active_workspace: {
            orchestrator: orchestratorPayload(),
            terminal_runs: [],
            workspace: { id: 'workspace-1', name: 'Notify Lab', path: 'C:/work/notify' },
            workers: [],
          },
          active_workspace_id: 'workspace-1',
          connection: {},
          generated_at: new Date('2026-06-10T08:00:00.000Z').getTime(),
          notifications: [
            {
              body: 'Open Files tab to download demo.mp4',
              created_at: new Date('2026-06-10T08:00:00.000Z').getTime(),
              id: 'notification-agent-1',
              source: 'agent',
              title: 'Build done',
              workspace_id: 'workspace-1',
            },
          ],
          workspaces: [
            { id: 'workspace-1', is_active: true, name: 'Notify Lab', path: 'C:/work/notify' },
          ],
        },
        type: 'mobile-snapshot',
      })
    })

    await waitFor(() =>
      expect(notifications).toEqual([
        {
          options: {
            body: 'Open Files tab to download demo.mp4',
            tag: 'yive-mobile-agent-notification-agent-1',
          },
          title: 'Build done',
        },
      ])
    )
    fireEvent.click(getBottomTab('通知'))
    expect(await screen.findByText('Build done')).toBeInTheDocument()
    expect(screen.getByText('Open Files tab to download demo.mp4')).toBeInTheDocument()
  })

  test('/mobile shows notification image thumbnails and opens a larger preview', async () => {
    window.history.pushState({}, '', '/mobile')
    vi.stubGlobal('WebSocket', MockMobileEventsWebSocket)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/settings/app-state/active_workspace_id') {
        return json({ key: 'active_workspace_id', value: null })
      }
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Notify Lab', path: 'C:/work/notify' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/files/file-preview') {
        return new Response(new Blob(['pixels'], { type: 'image/png' }), {
          headers: {
            'content-disposition': 'attachment; filename="preview.png"',
            'content-type': 'image/png',
          },
        })
      }
      throw new Error(`Unexpected fetch in mobile notification image test: ${url}`)
    })

    render(<App />)
    const socket = await waitFor(() => {
      const instance = MockMobileEventsWebSocket.instances.at(-1)
      if (!instance) throw new Error('Expected mobile events websocket')
      return instance
    })

    act(() => {
      socket.receive({
        snapshot: {
          active_workspace: {
            orchestrator: orchestratorPayload(),
            terminal_runs: [],
            workspace: { id: 'workspace-1', name: 'Notify Lab', path: 'C:/work/notify' },
            workers: [],
          },
          active_workspace_id: 'workspace-1',
          connection: {},
          generated_at: new Date('2026-06-10T08:00:00.000Z').getTime(),
          notifications: [
            {
              body: 'Open the image.',
              created_at: new Date('2026-06-10T08:00:00.000Z').getTime(),
              id: 'notification-agent-image',
              image: {
                file_id: 'file-preview',
                mime_type: 'image/png',
                name: 'preview.png',
                size: 6,
              },
              source: 'agent',
              title: 'Preview ready',
              workspace_id: 'workspace-1',
            },
          ],
          workspaces: [
            { id: 'workspace-1', is_active: true, name: 'Notify Lab', path: 'C:/work/notify' },
          ],
        },
        type: 'mobile-snapshot',
      })
    })

    fireEvent.click(getBottomTab('通知'))
    expect(await screen.findByText('Preview ready')).toBeInTheDocument()
    const thumbnail = await screen.findByRole('button', { name: '查看图片：preview.png' })
    expect(await within(thumbnail).findByRole('img', { name: 'preview.png' })).toBeInTheDocument()

    fireEvent.click(thumbnail)
    expect(screen.getByRole('dialog', { name: 'preview.png' })).toBeInTheDocument()
    expect(screen.getAllByRole('img', { name: 'preview.png' })).toHaveLength(2)
  })

  test('/mobile refreshes a healthy dashboard when the phone returns to the foreground', async () => {
    window.history.pushState({}, '', '/mobile')
    let teamLoads = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/settings/app-state/active_workspace_id') {
        return json({ key: 'active_workspace_id', value: null })
      }
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Focus Lab', path: 'C:/work/focus' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        teamLoads += 1
        return json([
          {
            ...workerPayload({
              conversationActivity: 'busy',
              id: 'worker-focus',
              name: teamLoads === 1 ? 'Alice' : 'Focus Worker',
              queuedDispatchCount: teamLoads === 1 ? 0 : 1,
            }),
          },
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in foreground refresh: ${url}`)
    })

    render(<App />)

    expect(await screen.findByText('Alice')).toBeInTheDocument()
    window.dispatchEvent(new Event('pageshow'))

    expect(await screen.findByText('Focus Worker')).toBeInTheDocument()
    expect(teamLoads).toBeGreaterThanOrEqual(2)
  })

  test('/mobile can enable phone notifications from the dashboard', async () => {
    window.history.pushState({}, '', '/mobile')
    const { requestPermission } = stubMobileNotification({ requestResult: 'granted' })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/settings/app-state/active_workspace_id') {
        return json({ key: 'active_workspace_id', value: null })
      }
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Notify Lab', path: 'C:/work/notify' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([
          {
            ...workerPayload({
              conversationActivity: 'idle',
              name: 'Notifier',
              queuedDispatchCount: 1,
            }),
          },
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '开启手机提醒' }))

    await waitFor(() => expect(requestPermission).toHaveBeenCalledOnce())
    expect(await screen.findByText('手机提醒已开启 · 1 个待处理')).toBeInTheDocument()
    expect(window.localStorage.getItem('yive.mobile.notifications.enabled')).toBe('1')
  })

  test('/mobile sends a phone notification when pending work increases after initial load', async () => {
    window.history.pushState({}, '', '/mobile')
    window.localStorage.setItem('yive.mobile.notifications.enabled', '1')
    const focus = vi.fn()
    Object.defineProperty(window, 'focus', { configurable: true, value: focus })
    const { instances, notifications } = stubMobileNotification({ permission: 'granted' })
    const snapshots = [
      {
        runs: [runPayload({ agentName: 'Notifier', runId: 'run-notify', status: 'running' })],
        workers: [
          {
            ...workerPayload({
              conversationActivity: 'idle',
              name: 'Notifier',
              queuedDispatchCount: 0,
            }),
          },
        ],
      },
      {
        runs: [runPayload({ agentName: 'Notifier', runId: 'run-notify', status: 'running' })],
        workers: [
          {
            ...workerPayload({
              conversationActivity: 'idle',
              name: 'Notifier',
              queuedDispatchCount: 2,
            }),
          },
        ],
      },
    ]
    let dashboardIndex = 0
    let currentSnapshot = snapshots[0]

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/settings/app-state/active_workspace_id') {
        return json({ key: 'active_workspace_id', value: null })
      }
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Notify Lab', path: 'C:/work/notify' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        currentSnapshot = snapshots[Math.min(dashboardIndex, snapshots.length - 1)]
        dashboardIndex += 1
        return json(currentSnapshot.workers)
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') return json(currentSnapshot.runs)
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    expect(await screen.findByText('手机提醒已开启')).toBeInTheDocument()
    expect(notifications).toEqual([])

    await waitFor(
      () =>
        expect(notifications).toEqual([
          {
            options: { body: '2 个事项等待查看。', tag: 'yive-mobile-pending' },
            title: 'Yive 有待处理事项',
          },
        ]),
      { timeout: 3000 }
    )
    instances.at(-1)?.onclick?.()
    expect(focus).toHaveBeenCalledOnce()
    expect(await screen.findByText('通知 / 审批')).toBeInTheDocument()
  })

  test('/mobile sends a phone notification when a healthy runtime disconnects', async () => {
    window.history.pushState({}, '', '/mobile')
    window.localStorage.setItem('yive.mobile.notifications.enabled', '1')
    const focus = vi.fn()
    Object.defineProperty(window, 'focus', { configurable: true, value: focus })
    const { instances, notifications } = stubMobileNotification({ permission: 'granted' })
    let dashboardCalls = 0

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/settings/app-state/active_workspace_id') {
        return json({ key: 'active_workspace_id', value: null })
      }
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Disconnect Lab', path: 'C:/work/disconnect' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        dashboardCalls += 1
        if (dashboardCalls > 1) throw new TypeError('Failed to fetch')
        return json([workerPayload({ conversationActivity: 'busy', name: 'Connected' })])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([runPayload({ agentName: 'Connected', runId: 'run-connected' })])
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    expect(await screen.findByText('手机提醒已开启')).toBeInTheDocument()
    expect(notifications).toEqual([])

    await waitFor(
      () =>
        expect(notifications).toEqual([
          {
            options: {
              body: '手机和电脑的本地连接中断，请回到 Yive 重试。',
              tag: 'yive-mobile-connection',
            },
            title: 'Yive 连接已断开',
          },
        ]),
      { timeout: 3000 }
    )
    instances.at(-1)?.onclick?.()
    expect(focus).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Agent' })).toHaveAttribute('aria-current', 'page')
  })

  test('/mobile updates the installed app badge from pending work snapshots', async () => {
    window.history.pushState({}, '', '/mobile')
    const setAppBadge = vi.fn(async () => undefined)
    const clearAppBadge = vi.fn(async () => undefined)
    Object.defineProperty(window.navigator, 'setAppBadge', {
      configurable: true,
      value: setAppBadge,
    })
    Object.defineProperty(window.navigator, 'clearAppBadge', {
      configurable: true,
      value: clearAppBadge,
    })
    const snapshots = [
      {
        runs: [],
        workers: [
          {
            ...workerPayload({
              conversationActivity: 'idle',
              name: 'Notifier',
              queuedDispatchCount: 2,
            }),
          },
        ],
      },
      {
        runs: [],
        workers: [
          {
            ...workerPayload({
              conversationActivity: 'idle',
              name: 'Notifier',
              queuedDispatchCount: 0,
            }),
          },
        ],
      },
    ]
    let dashboardIndex = 0
    let currentSnapshot = snapshots[0]

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/settings/app-state/active_workspace_id') {
        return json({ key: 'active_workspace_id', value: null })
      }
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Badge Lab', path: 'C:/work/badge' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        currentSnapshot = snapshots[Math.min(dashboardIndex, snapshots.length - 1)]
        dashboardIndex += 1
        return json(currentSnapshot.workers)
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') return json(currentSnapshot.runs)
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(2))
    expect(clearAppBadge).not.toHaveBeenCalled()

    await waitFor(() => expect(clearAppBadge).toHaveBeenCalledOnce(), { timeout: 3000 })
  })

  test('/mobile initializes the UI session before reading runtime workspaces', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: Array<{ mode: RequestMode | undefined; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ mode: init?.mode, url })
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/settings/app-state/active_workspace_id') {
        return json({ key: 'active_workspace_id', value: null })
      }
      if (url === '/api/workspaces') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await waitFor(() => expect(calls.length).toBe(3))
    expect(calls.map((call) => call.url)).toEqual([
      '/api/ui/session',
      '/api/workspaces',
      '/api/settings/app-state/active_workspace_id',
    ])
    expect(calls[0]).toEqual({ mode: 'same-origin', url: '/api/ui/session' })
  })

  test('/mobile shows an actionable empty state when there are no workspaces', async () => {
    window.history.pushState({}, '', '/mobile')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/settings/app-state/active_workspace_id') {
        return json({ key: 'active_workspace_id', value: null })
      }
      if (url === '/api/workspaces') return json([])
      throw new Error(`Unexpected fetch in empty workspace mobile test: ${url}`)
    })

    render(<App />)

    expect(
      await screen.findByText('暂无工作区。请先在电脑端创建或打开项目工作区。')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Agent' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByText('请选择一个工作区查看 Agent。')).not.toBeInTheDocument()
  })

  test('/mobile refreshes a stale UI token once and retries workspace loading', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/settings/app-state/active_workspace_id') {
        return json({ key: 'active_workspace_id', value: null })
      }
      if (url === '/api/workspaces' && calls.filter((call) => call === url).length === 1) {
        return failure(403, { error: 'UI endpoint requires valid UI token' })
      }
      if (url === '/api/workspaces') {
        return json([
          {
            id: 'workspace-1',
            name: 'Recovered',
            path: 'C:/work/recovered',
          },
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    expect((await screen.findAllByText('Recovered')).length).toBeGreaterThan(0)
    await waitFor(() => {
      expect(calls).toEqual(
        expect.arrayContaining([
          '/api/ui/workspaces/workspace-1/team',
          '/api/ui/workspaces/workspace-1/runs',
        ])
      )
    })
    expect(calls).toEqual(
      expect.arrayContaining([
        '/api/ui/session',
        '/api/workspaces',
        '/api/settings/app-state/active_workspace_id',
        '/api/ui/workspaces/workspace-1/team',
        '/api/ui/workspaces/workspace-1/runs',
      ])
    )
  })

  test('/mobile keeps the last ready agent dashboard when a later refresh fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    window.history.pushState({}, '', '/mobile')
    let teamLoads = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/settings/app-state/active_workspace_id') {
        return json({ key: 'active_workspace_id', value: null })
      }
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Weak Network Lab', path: 'C:/work/weak-net' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        teamLoads += 1
        if (teamLoads > 1) throw new TypeError('Failed to fetch')
        return json([
          workerPayload({
            conversationActivity: 'busy',
            id: 'worker-weak-net',
            name: 'Weak Net Worker',
          }),
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([
          runPayload({
            agentId: 'worker-weak-net',
            agentName: 'Weak Net Worker',
            runId: 'run-weak-net',
            status: 'running',
          }),
        ])
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in weak dashboard refresh test: ${url}`)
    })

    render(<App />)

    expect(await screen.findByText('Weak Net Worker')).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })

    expect(await screen.findByText(/正在显示上次 Agent 状态/u)).toBeInTheDocument()
    expect(screen.getByText('Weak Net Worker')).toBeInTheDocument()
    expect(getLanStatus()).toHaveTextContent('Runtime 在线')
    expect(screen.getByText(/正在显示上次 Agent 状态/u)).toHaveTextContent('加载工作区 Agent 失败')
  })

  test('/mobile shows an offline error state when UI session initialization fails', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url === '/api/ui/session') return failure(403, { error: 'no session' })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await waitFor(() => expect(calls).toEqual(['/api/ui/session']))
    expect(getLanStatus()).toHaveTextContent('离线')
    expect(expandLanStatusDetails()).toHaveTextContent('加载移动端工作区失败')
  })

  test('/mobile shows the last safe connection snapshot when runtime reconnect fails', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&server=https%3A%2F%2Frelay.test'
    )
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({
        desktopId: 'desktop-1',
        deviceId: 'phone-1',
        serverUrl: 'https://relay.test',
        token: 'device-token',
      })
    )
    let offline = false
    vi.stubGlobal('WebSocket', MockRelayWebSocket)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (offline) throw new TypeError('Failed to fetch')
      if (url === 'https://relay.test/health') {
        return json({
          ok: true,
          protocol_version: 1,
          service: 'hive-relay',
          static: { mobile_app_available: true },
        })
      }
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [
            {
              connected_at: Date.now(),
              device_id: 'desktop-1',
              last_seen_at: Date.now(),
              runtime_status: 'online',
              runtime_updated_at: Date.now(),
            },
          ],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      throw new Error(`Unexpected fetch in relay last connection snapshot: ${url}`)
    })

    const { unmount } = render(<App />)

    expect((await screen.findAllByText('Relay Workspace')).length).toBeGreaterThan(0)
    await waitFor(() =>
      expect(window.localStorage.getItem('yive.mobile.lastConnection')).toContain('desktop-1')
    )
    const storedSnapshot = window.localStorage.getItem('yive.mobile.lastConnection') ?? ''
    expect(storedSnapshot).toContain('Relay Workspace')
    expect(storedSnapshot).not.toContain('device-token')
    expect(storedSnapshot).not.toContain('pair-token')

    unmount()
    offline = true
    vi.stubGlobal('WebSocket', FailingRelayWebSocket)
    MockRelayWebSocket.sent = []
    MockRelayWebSocket.urls = []
    render(<App />)

    openBackgroundTab()
    await waitFor(() =>
      expect(getLanStatus()).toHaveTextContent(
        '目标电脑已连接 Relay，但本地 yive runtime 不可用，请在电脑端启动 yive。'
      )
    )
    expect(screen.getByLabelText('上次连接快照')).toHaveTextContent('上次连接')
    expect(screen.getByLabelText('上次连接快照')).toHaveTextContent('电脑 desktop-1')
    expect(screen.getByLabelText('上次连接快照')).toHaveTextContent('工作区 Relay Workspace')
  })

  test('/mobile can retry the initial runtime connection after an offline error', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url === '/api/ui/session' && calls.filter((call) => call === url).length === 1) {
        return failure(503, { error: 'runtime offline' })
      }
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/settings/app-state/active_workspace_id') {
        return json({ key: 'active_workspace_id', value: null })
      }
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Recovered Runtime', path: 'C:/work/recovered' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await waitFor(() => expect(getLanStatus()).toHaveTextContent('离线'))
    expect(expandLanStatusDetails()).toHaveTextContent('加载移动端工作区失败')
    fireEvent.click(screen.getByRole('button', { name: '重试连接' }))

    expect((await screen.findAllByText('Recovered Runtime')).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('局域网连接状态')).toHaveTextContent('Runtime 在线')
    expect(calls.filter((call) => call === '/api/ui/session')).toHaveLength(2)
  })

  test('/mobile relay runtime can retry after an interrupted workspace request', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('WebSocket', InterruptingOnceRelayWebSocket)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/health') {
        return json({
          desktop_count: 1,
          mobile_count: 1,
          ok: true,
          protocol_version: 1,
          service: 'hive-relay',
          static: { mobile_app_available: true },
          version: '1.4.0',
        })
      }
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [
            {
              connected_at: Date.now(),
              device_id: 'desktop-1',
              last_seen_at: Date.now(),
              runtime_status: 'online',
              runtime_updated_at: Date.now(),
            },
          ],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      throw new Error(`Unexpected fetch in relay interrupted retry test: ${url}`)
    })

    render(<App />)

    openBackgroundTab()
    await waitFor(() =>
      expect(getLanStatus()).toHaveTextContent(
        '远程连接中断或超时，请确认 Relay 在线、本地电脑已执行 yive connect，然后重试。'
      )
    )
    expect(InterruptingOnceRelayWebSocket.urls).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '重试连接' }))

    expect((await screen.findAllByText('Recovered Relay')).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('局域网连接状态')).toHaveTextContent('Relay 在线')
    expect(InterruptingOnceRelayWebSocket.urls).toHaveLength(2)
    expect(
      InterruptingOnceRelayWebSocket.sent.filter((sent) => sent.type === 'list_workspaces')
    ).toHaveLength(2)
  })

  test('/mobile automatically retries a failed runtime connection when the browser comes online', async () => {
    window.history.pushState({}, '', '/mobile')
    let browserOnline = false
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => browserOnline)
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url === '/api/ui/session' && calls.filter((call) => call === url).length === 1) {
        return failure(503, { error: 'runtime offline' })
      }
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/settings/app-state/active_workspace_id') {
        return json({ key: 'active_workspace_id', value: null })
      }
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Online Again', path: 'C:/work/online' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await waitFor(() => expect(getLanStatus()).toHaveTextContent('浏览器离线'))
    expect(getLanStatus()).toHaveAttribute('data-tone', 'error')
    expect(screen.getByRole('button', { name: '重试连接' })).toBeDisabled()

    browserOnline = true
    window.dispatchEvent(new Event('online'))

    expect((await screen.findAllByText('Online Again')).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('局域网连接状态')).toHaveTextContent('Runtime 在线')
    expect(calls.filter((call) => call === '/api/ui/session')).toHaveLength(2)
  })

  test('/mobile immediately surfaces browser offline state while a runtime was healthy', async () => {
    window.history.pushState({}, '', '/mobile')
    let browserOnline = true
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => browserOnline)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/settings/app-state/active_workspace_id') {
        return json({ key: 'active_workspace_id', value: null })
      }
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Offline Signal', path: 'C:/work/offline-signal' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in browser offline signal test: ${url}`)
    })

    render(<App />)

    expect((await screen.findAllByText('Offline Signal')).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('局域网连接状态')).toHaveTextContent('Runtime 在线')

    browserOnline = false
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })

    expect(getLanStatus()).toHaveTextContent('浏览器离线')
    expect(expandLanStatusDetails()).toHaveTextContent(
      '浏览器当前离线，远程控制会在网络恢复后自动重试。'
    )
    expect(getLanStatus()).toHaveAttribute('data-tone', 'error')
  })

  test('/mobile renders active and missing terminal run states for agents', async () => {
    window.history.pushState({}, '', '/mobile')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Terminal Lab', path: 'C:/work/terminal-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([
          {
            active_dispatch_id: null,
            conversation_activity: 'busy',
            provider: 'codex',
            id: 'worker-running',
            last_observed_at: 1,
            last_pty_line: 'worker prompt ready',
            name: 'Runner',
            process_state: 'running',
            queue_pause_reason: null,
            queued_dispatch_count: 0,
            kind: 'worker',
          },
          {
            active_dispatch_id: null,
            conversation_activity: 'idle',
            provider: null,
            id: 'worker-without-run',
            last_observed_at: 1,
            last_pty_line: null,
            name: 'No Run',
            process_state: 'stopped',
            queue_pause_reason: null,
            queued_dispatch_count: 0,
            kind: 'worker',
          },
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([
          {
            agent_id: 'workspace-1:orchestrator',
            agent_name: 'Orchestrator',
            run_id: 'run-orchestrator',
            status: 'running',
          },
          {
            agent_id: 'worker-running',
            agent_name: 'Runner',
            run_id: 'run-worker',
            status: 'running',
          },
        ])
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Agent' }))

    expect((await screen.findAllByText('Runner')).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '打开 Runner 终端' })).toBeInTheDocument()
    expect(screen.getByText('No Run')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开 Orchestrator 终端' })).toBeNull()
    expect(document.querySelectorAll('.mobile-agent-card')).toHaveLength(2)
    expect(screen.queryByText('run-orchestrator', { exact: false })).not.toBeInTheDocument()
    expect(screen.queryByText('worker prompt ready')).not.toBeInTheDocument()
  })

  test('/mobile orders agents by orchestrator, working, idle, then stopped', async () => {
    window.history.pushState({}, '', '/mobile')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Order Lab', path: 'C:/work/order-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([
          workerPayload({ id: 'stopped-first', name: 'Stopped First', processState: 'stopped' }),
          workerPayload({ conversationActivity: 'idle', id: 'idle-worker', name: 'Idle Worker' }),
          workerPayload({ id: 'working-alpha', name: 'Working Alpha' }),
          workerPayload({ id: 'working-beta', name: 'Working Beta' }),
          workerPayload({ id: 'stopped-last', name: 'Stopped Last', processState: 'stopped' }),
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([
          runPayload({
            agentId: 'workspace-1:orchestrator',
            agentName: 'Orchestrator',
            runId: 'run-orchestrator',
          }),
        ])
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in mobile agent ordering test: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Agent' }))
    await screen.findByText('Working Beta')
    const agentList = document.querySelector('.mobile-agent-list')
    if (!agentList) throw new Error('Expected mobile agent list')

    expect(
      within(agentList)
        .getAllByRole('button')
        .map((button) => button.ariaLabel)
    ).toEqual([
      '打开 Working Alpha 终端',
      '打开 Working Beta 终端',
      '打开 Idle Worker 终端',
      '打开 Stopped First 终端',
      '打开 Stopped Last 终端',
    ])
  })

  test('/mobile preloads terminal assets from the Agent surface without preconnecting a terminal', async () => {
    window.history.pushState({}, '', '/mobile')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Preload Lab', path: 'C:/work/preload' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([workerPayload({ name: 'Preload Worker' })])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([runPayload({ agentName: 'Preload Worker', runId: 'run-preload' })])
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in terminal preload test: ${url}`)
    })

    const view = render(<App />)

    expect(await screen.findByText('Preload Worker')).toBeInTheDocument()
    await waitFor(() => expect(preloadTerminalAssetsMock).toHaveBeenCalledOnce())
    expect(preloadTerminalConnectionMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('mock-terminal-run-preload')).not.toBeInTheDocument()
    expect(terminalViewProps).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: '打开 Preload Worker 终端' }))
    fireEvent.click(await screen.findByRole('button', { name: '打开更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '终端' }))
    expect(await screen.findByTestId('mock-terminal-run-preload')).toBeInTheDocument()
    expect(preloadTerminalConnectionMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(preloadTerminalConnectionMock).not.toHaveBeenCalled()
    expect(disposeTerminalConnectionPreloadMock).not.toHaveBeenCalled()

    view.unmount()
    expect(disposeTerminalConnectionPreloadMock).not.toHaveBeenCalled()
  })

  test.each([
    { label: 'Codex', provider: 'codex' as const },
    { label: 'Claude Code', provider: 'claude' as const },
  ])('/mobile opens verified $label Chat by default without mounting the terminal', async ({
    label,
    provider,
  }) => {
    window.history.pushState({}, '', '/mobile')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Chat Lab', path: 'C:/work/chat' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([workerPayload({ name: 'Chat Worker' })])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([runPayload({ agentName: 'Chat Worker', runId: 'run-chat' })])
      }
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/agents/worker-1/conversation?workspace_id=workspace-1') {
        return json({
          conversation: {
            agent_id: 'worker-1',
            activity_state: 'idle',
            cli_session_id: 'session-chat',
            id: 'conversation-1',
            provider,
            recording_boundary: 10,
            source_checkpoint: 20,
            stale: false,
            turns: [
              { provider_event_id: 'user-1', role: 'user', sequence: 1, text: '你好' },
              { provider_event_id: 'agent-1', role: 'assistant', sequence: 2, text: '你好！' },
            ],
            workspace_id: 'workspace-1',
          },
        })
      }
      throw new Error(`Unexpected fetch in ${label} Chat test: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '打开 Chat Worker 终端' }))
    await waitFor(() => expect(screen.getByText('你好！')).toBeInTheDocument(), { timeout: 5000 })
    expect(screen.getByText(`${label} · session-`)).toBeInTheDocument()
    expect(screen.queryByTestId('mock-terminal-run-chat')).not.toBeInTheDocument()
    expect(terminalViewProps).toEqual([])
    expect(preloadTerminalConnectionMock).not.toHaveBeenCalled()
  })

  test('/mobile ignores the legacy Terminal default and opens Chat unless a link is explicit', async () => {
    window.history.pushState({}, '', '/mobile')
    window.localStorage.setItem('yive.mobile.agent-detail.default-view', 'raw-terminal')
    const requestedUrls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      requestedUrls.push(url)
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Preference Lab', path: 'C:/work/preference' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([workerPayload({ name: 'Preference Worker' })])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([runPayload({ agentName: 'Preference Worker', runId: 'run-preference' })])
      }
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/agents/worker-1/conversation?workspace_id=workspace-1') {
        return json({
          conversation: {
            activity_state: 'idle',
            agent_id: 'worker-1',
            cli_session_id: 'session-preference',
            id: 'conversation-preference',
            provider: 'codex',
            recording_boundary: 10,
            source_checkpoint: 20,
            stale: false,
            submissions: [],
            turns: [
              {
                provider_event_id: 'reply-1',
                role: 'assistant',
                sequence: 1,
                text: 'Back in Chat',
              },
            ],
            workspace_id: 'workspace-1',
          },
        })
      }
      throw new Error(`Unexpected fetch in Agent detail preference test: ${url}`)
    })

    const view = render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '打开 Preference Worker 终端' }))

    await waitFor(() => expect(screen.getByText('Back in Chat')).toBeInTheDocument())
    expect(screen.queryByTestId('mock-terminal-run-preference')).not.toBeInTheDocument()
    expect(
      requestedUrls.some((url) => url.includes('/api/mobile/agents/worker-1/conversation'))
    ).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '打开更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '终端' }))
    expect(await screen.findByTestId('mock-terminal-run-preference')).toBeInTheDocument()

    const returnToChat = document.querySelector<HTMLButtonElement>(
      '.mobile-agent-detail__chat-return'
    )
    if (!returnToChat) throw new Error('Expected return-to-Chat button')
    fireEvent.click(returnToChat)
    expect(screen.queryByTestId('mock-terminal-run-preference')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Back in Chat')).toBeInTheDocument())

    view.unmount()
    window.history.replaceState(
      {},
      '',
      '/mobile?workspace_id=workspace-1&agent_id=worker-1&view=terminal'
    )
    render(<App />)
    expect(await screen.findByTestId('mock-terminal-run-preference')).toBeInTheDocument()
  })

  test('/mobile submits a session-scoped multiline Chat draft with an explicit action', async () => {
    window.history.pushState({}, '', '/mobile')
    const actions: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Composer Lab', path: 'C:/work/composer' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([workerPayload({ conversationActivity: 'idle', name: 'Composer Worker' })])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([runPayload({ agentName: 'Composer Worker', runId: 'run-composer' })])
      }
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/agents/worker-1/conversation?workspace_id=workspace-1') {
        return json({
          conversation: {
            agent_id: 'worker-1',
            activity_state: 'idle',
            cli_session_id: 'session-composer',
            id: 'conversation-composer',
            provider: 'codex',
            recording_boundary: 10,
            source_checkpoint: 20,
            stale: false,
            submissions: [],
            turns: [],
            workspace_id: 'workspace-1',
          },
        })
      }
      if (url === '/api/mobile/actions' && init?.method === 'POST') {
        const action = JSON.parse(String(init.body)) as Record<string, unknown>
        actions.push(action)
        if (action.kind === 'chat_edit') {
          return json({
            action_id: action.action_id,
            kind: 'chat_edit',
            ok: true,
            result: { ...queued[0], body: 'edited queued' },
            workspace_id: 'workspace-1',
          })
        }
        return json({
          action_id: action.action_id,
          kind: 'chat_submit',
          ok: true,
          result: {
            body: 'first line\nsecond line',
            conversation_id: 'conversation-composer',
            id: action.action_id,
            state: 'delivered',
          },
          workspace_id: 'workspace-1',
        })
      }
      throw new Error(`Unexpected fetch in Chat composer test: ${url}`)
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '打开 Composer Worker 终端' }))
    const composer = await screen.findByLabelText('消息')
    fireEvent.change(composer, { target: { value: 'first line\nsecond line' } })
    expect(composer).toHaveValue('first line\nsecond line')
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(actions).toHaveLength(1))
    expect(actions[0]).toMatchObject({
      kind: 'chat_submit',
      payload: { body: 'first line\nsecond line' },
      target: { conversation_id: 'conversation-composer' },
      workspace_id: 'workspace-1',
    })
    expect(String(actions[0]?.action_id)).toMatch(/^[0-9a-f-]{36}$/u)
    expect(await screen.findByText('已送达')).toBeInTheDocument()
    expect(composer).toHaveValue('')
    expect(terminalViewProps).toEqual([])
  })

  test('/mobile waits for image upload before atomically submitting Chat text and file IDs', async () => {
    window.history.pushState({}, '', '/mobile')
    const actions: Array<Record<string, unknown>> = []
    const attachmentDownloads: string[] = []
    let uploadAttempts = 0
    let finishUpload: (() => void) | undefined
    const uploadGate = new Promise<void>((resolve) => {
      finishUpload = resolve
    })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:chat-preview'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Image Chat', path: 'C:/work/image-chat' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([workerPayload({ conversationActivity: 'idle', name: 'Image Worker' })])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([runPayload({ agentName: 'Image Worker', runId: 'run-image-chat' })])
      }
      if (url === '/api/mobile/files' && init?.method === 'POST') {
        uploadAttempts += 1
        if (uploadAttempts === 1) {
          await uploadGate
          return failure(503, { error: 'upload unavailable' })
        }
        return json({
          created_at: 1,
          id: 'file-chat-image',
          local_path: 'C:/secret/upload.png',
          mime_type: 'image/png',
          name: 'diagram.png',
          size: 8,
        })
      }
      if (url === '/api/mobile/files') return json([])
      if (url.startsWith('/api/mobile/files/file-chat-image?')) {
        attachmentDownloads.push(url)
        return new Response(new Blob(['pixels'], { type: 'image/png' }), {
          headers: {
            'content-disposition': 'attachment; filename="diagram.png"',
            'content-type': 'image/png',
          },
        })
      }
      if (url === '/api/mobile/agents/worker-1/conversation?workspace_id=workspace-1') {
        return json({
          conversation: {
            activity_state: 'idle',
            agent_id: 'worker-1',
            cli_session_id: 'session-image-chat',
            id: 'conversation-image-chat',
            provider: 'codex',
            recording_boundary: 10,
            source_checkpoint: 20,
            stale: false,
            submissions: [],
            turns: [],
            workspace_id: 'workspace-1',
          },
        })
      }
      if (url === '/api/mobile/actions' && init?.method === 'POST') {
        const action = JSON.parse(String(init.body)) as Record<string, unknown>
        actions.push(action)
        return json({
          action_id: action.action_id,
          kind: 'chat_submit',
          ok: true,
          result: {
            accepted_at: 1,
            attachments: [
              {
                file_id: 'file-chat-image',
                mime_type: 'image/png',
                name: 'diagram.png',
                placeholder: '[Image abc #1]',
                size: 8,
              },
            ],
            body: '看这张图',
            conversation_id: 'conversation-image-chat',
            id: action.action_id,
            state: 'delivered',
          },
          workspace_id: 'workspace-1',
        })
      }
      throw new Error(`Unexpected fetch in image Chat test: ${url}`)
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '打开 Image Worker 终端' }))
    fireEvent.change(await screen.findByLabelText('消息'), { target: { value: '看这张图' } })
    fireEvent.change(screen.getByLabelText('添加图片'), {
      target: { files: [new File(['pixels'], 'diagram.png', { type: 'image/png' })] },
    })

    expect(await screen.findByAltText('diagram.png')).toHaveAttribute('src', 'blob:chat-preview')
    expect(screen.getByText('上传中…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    finishUpload?.()
    fireEvent.click(await screen.findByRole('button', { name: '重试上传 diagram.png' }))
    expect(await screen.findByText('已上传')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(actions).toHaveLength(1))
    expect(actions[0]).toMatchObject({
      kind: 'chat_submit',
      payload: { attachments: [{ file_id: 'file-chat-image' }], body: '看这张图' },
    })
    expect(JSON.stringify(actions[0])).not.toContain('content_base64')
    expect(JSON.stringify(actions[0])).not.toContain('local_path')
    expect(document.body.textContent).not.toContain('C:/secret/upload.png')
    const attachmentButton = await screen.findByRole('button', { name: /diagram.png/u })
    const submissionId = String(actions[0]?.action_id)
    fireEvent.click(attachmentButton)
    await waitFor(() =>
      expect(attachmentDownloads).toContain(
        `/api/mobile/files/file-chat-image?submission_id=${submissionId}&workspace_id=workspace-1`
      )
    )
  })

  test('/mobile keeps a draft at queue capacity and confirms forced delivery order', async () => {
    window.history.pushState({}, '', '/mobile')
    const actions: Array<Record<string, unknown>> = []
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const queued = [1, 2, 3].map((index) => ({
      accepted_at: index,
      body: `queued ${index}`,
      cancelled_at: null,
      confirmed_at: null,
      conversation_id: 'conversation-queue',
      delivered_at: null,
      error_code: null,
      id: `${index}${index}${index}${index}${index}${index}${index}${index}-1111-4111-8111-111111111111`,
      provider_event_id: null,
      provider_turn_sequence: null,
      queue_sequence: index,
      state: 'queued',
    }))
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Queue Lab', path: 'C:/work/queue' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([workerPayload({ name: 'Queue Worker' })])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([runPayload({ agentName: 'Queue Worker', runId: 'run-queue' })])
      }
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/agents/worker-1/conversation?workspace_id=workspace-1') {
        return json({
          conversation: {
            activity_state: 'busy',
            agent_id: 'worker-1',
            cli_session_id: 'session-queue',
            id: 'conversation-queue',
            provider: 'codex',
            recording_boundary: 10,
            source_checkpoint: 20,
            stale: false,
            submissions: queued,
            turns: [],
            workspace_id: 'workspace-1',
          },
        })
      }
      if (url === '/api/mobile/actions' && init?.method === 'POST') {
        const action = JSON.parse(String(init.body)) as Record<string, unknown>
        actions.push(action)
        return json({
          action_id: action.action_id,
          kind: 'chat_force',
          ok: true,
          result: { ...queued[1], delivered_at: 4, state: 'delivered' },
          workspace_id: 'workspace-1',
        })
      }
      throw new Error(`Unexpected fetch in Chat queue test: ${url}`)
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '打开 Queue Worker 终端' }))
    const composer = await screen.findByLabelText('消息')
    fireEvent.change(composer, { target: { value: 'keep this draft' } })
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(composer).toHaveValue('keep this draft')

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0] as HTMLElement)
    expect(composer).toHaveValue('queued 1')
    fireEvent.change(composer, { target: { value: 'edited queued' } })
    const saveButton = screen.getByRole('button', { name: '保存' })
    expect(saveButton).toBeEnabled()
    fireEvent.click(saveButton)
    await waitFor(() => expect(actions).toHaveLength(1))
    expect(actions[0]).toMatchObject({
      kind: 'chat_edit',
      payload: { body: 'edited queued' },
      target: { submission_id: queued[0]?.id },
    })

    fireEvent.change(composer, { target: { value: 'keep this draft' } })

    const secondQueuedBubble = screen.getByText('queued 2').closest('article')
    if (!secondQueuedBubble) throw new Error('Expected the second queued Chat bubble')
    fireEvent.click(within(secondQueuedBubble).getByRole('button', { name: '立即发送' }))
    await waitFor(() => expect(actions).toHaveLength(2))
    expect(confirm).toHaveBeenCalledWith('立即发送这条消息并跳过前面的 1 条排队消息？')
    expect(actions[1]).toMatchObject({
      kind: 'chat_force',
      payload: { skipped_count: 1 },
      target: { submission_id: queued[1]?.id },
      workspace_id: 'workspace-1',
    })
    expect(composer).toHaveValue('keep this draft')
  })

  test('/mobile restores a draft when queue capacity changes before acceptance', async () => {
    window.history.pushState({}, '', '/mobile')
    const queued = [1, 2].map((index) => ({
      accepted_at: index,
      body: `queued ${index}`,
      cancelled_at: null,
      confirmed_at: null,
      conversation_id: 'conversation-capacity-race',
      delivered_at: null,
      error_code: null,
      id: `${index}${index}${index}${index}${index}${index}${index}${index}-2222-4222-8222-222222222222`,
      provider_event_id: null,
      provider_turn_sequence: null,
      queue_sequence: index,
      state: 'queued',
    }))
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Capacity Lab', path: 'C:/work/capacity' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([workerPayload({ name: 'Capacity Worker' })])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([runPayload({ agentName: 'Capacity Worker', runId: 'run-capacity' })])
      }
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/agents/worker-1/conversation?workspace_id=workspace-1') {
        return json({
          conversation: {
            activity_state: 'busy',
            agent_id: 'worker-1',
            cli_session_id: 'session-capacity',
            id: 'conversation-capacity-race',
            provider: 'codex',
            recording_boundary: 10,
            source_checkpoint: 20,
            stale: false,
            submissions: queued,
            turns: [],
            workspace_id: 'workspace-1',
          },
        })
      }
      if (url === '/api/mobile/actions' && init?.method === 'POST') {
        return failure(409, {
          code: 'chat_queue_capacity',
          error: 'A conversation can have at most three queued submissions',
        })
      }
      throw new Error(`Unexpected fetch in Chat capacity race test: ${url}`)
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '打开 Capacity Worker 终端' }))
    const composer = await screen.findByLabelText('消息')
    fireEvent.change(composer, { target: { value: 'fourth draft' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(
      await screen.findByText('A conversation can have at most three queued submissions')
    ).toBeInTheDocument()
    expect(composer).toHaveValue('fourth draft')
    expect(screen.queryByText('未送达')).not.toBeInTheDocument()
    expect(
      window.localStorage.getItem(
        'yive.mobile.chat-draft:workspace-1:worker-1:codex:session-capacity'
      )
    ).toBe('fourth draft')
  })

  test('/mobile relay does not preconnect remembered terminal runs before the dashboard response', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&server=https%3A%2F%2Frelay.test'
    )
    window.localStorage.setItem(
      'yive.mobile.relay.pairing',
      JSON.stringify({
        desktopId: 'desktop-1',
        deviceId: 'phone-1',
        serverUrl: 'https://relay.test',
        token: 'device-token',
      })
    )
    window.localStorage.setItem(
      'yive.mobile.lastConnection',
      JSON.stringify({
        mode: 'relay',
        runtimeLabel: 'Relay · desktop-1',
        terminalRunIds: ['run-relay'],
        updatedAt: Date.now(),
        workspaceId: 'workspace-1',
      })
    )
    vi.stubGlobal('WebSocket', MockRelayWebSocket)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/health') {
        return json({ ok: true, protocol_version: 1, service: 'hive-relay' })
      }
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [
            {
              connected_at: Date.now(),
              device_id: 'desktop-1',
              last_seen_at: Date.now(),
              runtime_status: 'online',
              runtime_updated_at: Date.now(),
            },
          ],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      throw new Error(`Unexpected fetch in remembered terminal preload: ${url}`)
    })

    render(<App />)

    expect(preloadTerminalConnectionMock).not.toHaveBeenCalled()
    expect(await screen.findByText('Remote Worker')).toBeInTheDocument()
    expect(preloadTerminalConnectionMock).not.toHaveBeenCalled()
  })

  test('/mobile hides task dispatch controls from the agent list', async () => {
    window.history.pushState({}, '', '/mobile')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Dispatch Lab', path: 'C:/work/dispatch-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/actions') {
        throw new Error(`Unexpected mobile action from agent list: ${String(init?.body)}`)
      }
      throw new Error(`Unexpected fetch in mobile team dispatch: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Agent' }))
    const safeWorker = await screen.findByText('Safe Worker')
    const agentCard = safeWorker.closest('.mobile-agent-card')
    if (!agentCard) throw new Error('Expected Safe Worker agent card')

    expect(within(agentCard as HTMLElement).queryByRole('button', { name: '派任务' })).toBeNull()
    expect(screen.queryByLabelText('任务内容')).toBeNull()
  })

  test('/mobile opens an agent terminal detail pane, sends auxiliary CLI input, and returns', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: string[] = []
    const mobileActions: Array<Record<string, unknown>> = []
    vi.stubGlobal('WebSocket', class UnexpectedMobileInputWebSocket {})
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Detail Lab', path: 'C:/work/detail-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/actions') {
        mobileActions.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return json({ ok: true })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()

    expect(await screen.findByTestId('mock-terminal-run-worker')).toHaveTextContent('Safe Worker')
    expect(screen.queryByRole('tab', { name: '聊天' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '原始终端' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('终端摘要')).not.toBeInTheDocument()
    expect(screen.queryByText('閸樺棗褰舵潏鎾冲毉')).not.toBeInTheDocument()
    expect(calls).not.toContain('/api/runtime/runs/run-worker')
    expect(terminalViewProps.at(-1)).toEqual({
      connectionParams: undefined,
      autoTakeover: true,
      fitToContainer: true,
      initialSize: undefined,
      inputProfile: 'default',
      minimumSize: { cols: 24, rows: 10 },
      onError: expect.any(Function),
      onOwnershipChange: expect.any(Function),
      onSyncStatusChange: expect.any(Function),
      portalId: 'worker-pty-workspace-1-run-worker',
      propagateResize: true,
      runId: 'run-worker',
      scrollFrameRatePreference: 'auto',
      title: 'Safe Worker',
      touchScrollTarget: expect.any(HTMLDivElement),
      viewerMode: 'takeover',
      workspaceId: 'workspace-1',
    })

    expect(screen.queryByRole('button', { name: 'Agent' })).not.toBeInTheDocument()

    expect(screen.queryByLabelText(/CLI/)).not.toBeInTheDocument()
    expect(document.querySelector('.mobile-terminal__input-row')).toBeNull()
    expect(screen.queryByLabelText('输入给 Agent 的消息')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '发送' })).not.toBeInTheDocument()

    await openTerminalTools()
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl+C' }))

    await waitFor(() => {
      expect(mobileActions).toEqual([
        expect.objectContaining({
          kind: 'terminal_input',
          payload: { input: '\x03' },
          target: { run_id: 'run-worker' },
          workspace_id: 'workspace-1',
        }),
      ])
    })

    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    expect(await screen.findByRole('button', { name: 'Agent' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.getByRole('button', { name: '打开 Safe Worker 终端' })).toBeInTheDocument()
    expect(screen.queryByText('ready')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mock-terminal-run-worker')).not.toBeInTheDocument()

    await openWorkerTerminal()

    const restoredTerminal = screen.getByTestId('mock-terminal-run-worker')
    const restoredWrapper = restoredTerminal.closest('.mobile-terminal-keepalive')
    expect(restoredWrapper).not.toHaveClass('mobile-terminal-keepalive--hidden')
    expect(restoredWrapper).toHaveAttribute('aria-hidden', 'false')
    expect(screen.queryByRole('button', { name: 'Agent' })).not.toBeInTheDocument()
  })

  test('/mobile terminal settings persist the local scroll frame-rate preference', async () => {
    window.history.pushState({}, '', '/mobile')
    window.localStorage.setItem('yive.mobile.terminal.scrollFrameRate', '90')
    vi.stubGlobal('WebSocket', class UnexpectedMobileSettingsWebSocket {})
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Settings Lab', path: 'C:/work/settings-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in terminal settings test: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()

    expect(await screen.findByTestId('mock-terminal-run-worker')).toBeInTheDocument()
    expect(terminalViewProps.at(-1)?.scrollFrameRatePreference).toBe('90')

    fireEvent.click(screen.getByRole('button', { name: '打开终端设置' }))

    expect(screen.getByRole('dialog', { name: '终端设置' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /90fps/ })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: /120fps/ }))

    expect(window.localStorage.getItem('yive.mobile.terminal.scrollFrameRate')).toBe('120')

    fireEvent.click(
      within(screen.getByRole('dialog', { name: '终端设置' })).getByRole('button', {
        name: '返回',
      })
    )

    expect(screen.queryByRole('dialog', { name: '终端设置' })).not.toBeInTheDocument()
    expect(screen.getByTestId('mock-terminal-run-worker')).toBeInTheDocument()
    expect(terminalViewProps.at(-1)?.scrollFrameRatePreference).toBe('120')
  })

  test('/mobile clears the parked terminal and uses the next workspace run after switching workspaces', async () => {
    window.history.pushState({}, '', '/mobile')
    const dashboardCalls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([
          { id: 'workspace-1', name: 'Workspace One', path: 'C:/work/one' },
          { id: 'workspace-2', name: 'Workspace Two', path: 'C:/work/two' },
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        dashboardCalls.push(url)
        return json([workerPayload({ name: 'Worker One' })])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        dashboardCalls.push(url)
        return json([
          runPayload({
            agentName: 'Worker One',
            runId: 'shared-run-id',
          }),
        ])
      }
      if (url === '/api/ui/workspaces/workspace-2/team') {
        dashboardCalls.push(url)
        return json([workerPayload({ name: 'Worker Two' })])
      }
      if (url === '/api/ui/workspaces/workspace-2/runs') {
        dashboardCalls.push(url)
        return json([
          runPayload({
            agentName: 'Worker Two',
            runId: 'shared-run-id',
          }),
        ])
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch while switching workspaces: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal('Worker One')

    expect(await screen.findByTestId('mock-terminal-shared-run-id')).toHaveTextContent('Worker One')
    expect(terminalViewProps.at(-1)).toMatchObject({
      portalId: 'worker-pty-workspace-1-shared-run-id',
      runId: 'shared-run-id',
      title: 'Worker One',
    })
    const firstTouchTarget = terminalViewProps.at(-1)?.touchScrollTarget

    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(screen.queryByTestId('mock-terminal-shared-run-id')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Workspace One/u }))
    const workspaceSwitcher = document.getElementById('mobile-workspace-switcher')
    expect(workspaceSwitcher).not.toBeNull()
    fireEvent.click(
      within(workspaceSwitcher as HTMLElement).getByRole('button', { name: /Workspace Two/u })
    )

    await waitFor(() =>
      expect(dashboardCalls).toEqual(
        expect.arrayContaining([
          '/api/ui/workspaces/workspace-2/team',
          '/api/ui/workspaces/workspace-2/runs',
        ])
      )
    )
    expect(screen.queryByText('Worker One')).not.toBeInTheDocument()

    await openWorkerTerminal('Worker Two')

    expect(await screen.findByTestId('mock-terminal-shared-run-id')).toHaveTextContent('Worker Two')
    expect(terminalViewProps.at(-1)).toMatchObject({
      portalId: 'worker-pty-workspace-2-shared-run-id',
      runId: 'shared-run-id',
      title: 'Worker Two',
    })
    expect(terminalViewProps.at(-1)?.touchScrollTarget).toEqual(expect.any(HTMLDivElement))
    expect(terminalViewProps.at(-1)?.touchScrollTarget).not.toBe(firstTouchTarget)
  })

  test('/mobile agent detail keeps raw passive terminal and shows a safe transcript preview', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Transcript Lab', path: 'C:/work/transcript-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([
          workerPayload({
            name: 'Transcript Worker',
          }),
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([
          runPayload({
            agentName: 'Transcript Worker',
            runId: 'run-transcript',
          }),
        ])
      }
      if (url.startsWith('/api/mobile/transcript?')) {
        return json({
          attachments: [],
          events: [
            {
              created_at: 1,
              id: 'terminal-output-1',
              raw_summary: 'safe output summary',
              run_id: 'run-transcript',
              text: 'transcript terminal output line',
              truncated: false,
              type: 'terminal_output',
            },
            {
              bytes: null,
              confirmed: true,
              created_at: 2,
              id: 'action:stop-run-1',
              kind: 'stop_run',
              raw_summary:
                'RAW_SUMMARY_SECRET HIVE_AGENT_TOKEN C:\\Temp\\hive-mobile-files\\image-1.png content_base64 registry_path session-secret-1 cGl4ZWxz nonce-stop-secret',
              run_id: 'run-transcript',
              type: 'mobile_action_echo',
            },
            {
              attachments: [],
              bytes: 41,
              confirmed: false,
              created_at: 3,
              file_review: {
                decision: 'needs_changes',
                file_id: 'file-review',
                name: 'review.md',
                workspace_path: 'dist/review.md',
              },
              id: 'action:file-review-1',
              kind: 'file_review',
              run_id: 'run-transcript',
              type: 'mobile_action_echo',
            },
          ],
          generated_at: 3,
          run: {
            agent_id: 'worker-1',
            agent_name: 'Transcript Worker',
            exit_code: null,
            status: 'running',
            terminal_input_profile: 'default',
          },
          run_id: 'run-transcript',
          workspace_id: 'workspace-1',
        })
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal('Transcript Worker')

    expect(await screen.findByTestId('mock-terminal-run-transcript')).toHaveTextContent(
      'Transcript Worker'
    )
    expect(calls.some((url) => url.startsWith('/api/mobile/transcript?'))).toBe(false)
    expect(screen.queryByText('停止终端已确认并记录')).not.toBeInTheDocument()
    expect(screen.queryByText('文件审核：dist/review.md 需要修改')).not.toBeInTheDocument()
    expect(screen.queryByText('transcript terminal output line')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('最近远程记录')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '聊天' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '原始终端' })).not.toBeInTheDocument()
    expect(screen.queryByText('终端会话 run-transcript')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('RAW_SUMMARY_SECRET')
    expect(document.body.textContent).not.toContain('HIVE_AGENT_TOKEN')
    expect(document.body.textContent).not.toContain('C:\\Temp\\hive-mobile-files\\image-1.png')
    expect(document.body.textContent).not.toContain('content_base64')
    expect(document.body.textContent).not.toContain('registry_path')
    expect(document.body.textContent).not.toContain('session-secret-1')
    expect(document.body.textContent).not.toContain('cGl4ZWxz')
    expect(document.body.textContent).not.toContain('nonce-stop-secret')
  })

  test('/mobile keeps the raw terminal even when agent last output exists', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Fallback Lab', path: 'C:/work/fallback-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([
          {
            ...workerPayload({
              name: 'Fallback Worker',
            }),
            last_pty_line: 'fallback terminal output',
          },
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([
          runPayload({
            agentName: 'Fallback Worker',
            runId: 'run-fallback',
          }),
        ])
      }
      if (url.startsWith('/api/mobile/transcript?')) {
        return json({
          attachments: [],
          events: [
            {
              created_at: 1,
              id: 'terminal-output-1',
              raw_summary: 'safe',
              run_id: 'run-fallback',
              text: 'relay visible terminal output',
              truncated: false,
              type: 'terminal_output',
            },
          ],
          generated_at: 2,
          run: {
            agent_id: 'worker-1',
            agent_name: 'Fallback Worker',
            exit_code: null,
            status: 'running',
            terminal_input_profile: 'default',
          },
          run_id: 'run-fallback',
          workspace_id: 'workspace-1',
        })
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal('Fallback Worker')

    expect(calls.some((url) => url.startsWith('/api/mobile/transcript?'))).toBe(false)
    expect(await screen.findByTestId('mock-terminal-run-fallback')).toHaveTextContent(
      'Fallback Worker'
    )
    expect(screen.queryByText('relay visible terminal output')).not.toBeInTheDocument()
    expect(screen.queryByText('fallback terminal output')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('agent_token')
    expect(document.body.textContent).not.toContain('x-hive-agent-token')
  })

  test('/mobile uploads an image attachment and tries native CLI image paste first', async () => {
    window.history.pushState({}, '', '/mobile')
    const mobileActions: Array<Record<string, unknown>> = []
    const uploads: Array<Record<string, unknown>> = []
    const deletes: Array<string> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Image Lab', path: 'C:/work/image-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files' && init?.method === 'POST') {
        uploads.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return json({
          created_at: 1,
          id: 'image-1',
          local_path: 'C:\\Temp\\hive-mobile-files\\image-1.png',
          mime_type: 'image/png',
          name: 'shot.png',
          size: 6,
        })
      }
      if (url === '/api/mobile/files/image-1' && init?.method === 'DELETE') {
        deletes.push(url)
        return new Response(null, { status: 204 })
      }
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/actions') {
        mobileActions.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return json({ ok: true })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()
    await openTerminalTools()

    const imageInput = document.querySelector(
      'input[accept*="image/png"]'
    ) as HTMLInputElement | null
    expect(imageInput).not.toBeNull()
    fireEvent.change(imageInput as HTMLInputElement, {
      target: { files: [new File(['pixels'], 'shot.png', { type: 'image/png' })] },
    })
    expect(screen.getByRole('button', { name: '收起终端工具' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )

    await waitFor(() => {
      expect(uploads).toHaveLength(1)
      expect(mobileActions).toHaveLength(1)
      expect(deletes).toHaveLength(1)
    })
    expect(uploads[0]).toEqual(
      expect.objectContaining({
        name: 'shot.png',
      })
    )
    expect(String(uploads[0]?.content_base64)).toContain('cGl4ZWxz')
    const action = mobileActions[0] as {
      kind?: string
      payload?: { file_id?: string; placeholder?: string }
      target?: { run_id?: string }
      workspace_id?: string
    }
    expect(action.kind).toBe('native_image_paste')
    expect(action.target).toEqual({ run_id: 'run-worker' })
    expect(action.workspace_id).toBe('workspace-1')
    expect(action.payload).toEqual({
      file_id: 'image-1',
      placeholder: '[Image #1]',
    })
    expect(JSON.stringify(action)).not.toContain('C:\\Temp\\hive-mobile-files\\image-1.png')
    expect(JSON.stringify(action)).not.toContain('cGl4ZWxz')
    expect(screen.getByText(/已尝试按电脑粘贴图片方式送入 CLI/)).toBeInTheDocument()
    expect(screen.getByText(/已从文件交换区移除/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('C:\\Temp\\hive-mobile-files\\image-1.png')
    expect(document.body.textContent).not.toContain('cGl4ZWxz')
    expect(document.body.textContent).not.toContain('HIVE_AGENT_TOKEN')
    expect(document.body.textContent).not.toContain('x-hive-agent-token')
    expect(document.body.textContent).not.toContain('agent_token')
  })

  test('/mobile falls back to a server image reference when native paste fails', async () => {
    window.history.pushState({}, '', '/mobile')
    const mobileActions: Array<Record<string, unknown>> = []
    const deletes: Array<string> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Image Lab', path: 'C:/work/image-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files' && init?.method === 'POST') {
        return json({
          created_at: 1,
          id: 'image-1',
          local_path: 'C:\\Temp\\hive-mobile-files\\image-1.png',
          mime_type: 'image/png',
          name: 'shot.png',
          size: 6,
        })
      }
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/files/image-1' && init?.method === 'DELETE') {
        deletes.push(url)
        return new Response(null, { status: 204 })
      }
      if (url === '/api/mobile/actions') {
        const action = JSON.parse(String(init?.body)) as Record<string, unknown>
        mobileActions.push(action)
        if (action.kind === 'native_image_paste') {
          return failure(409, { error: 'native paste unavailable' })
        }
        return json({ ok: true })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()
    await openTerminalTools()

    const imageInput = document.querySelector(
      'input[accept*="image/png"]'
    ) as HTMLInputElement | null
    expect(imageInput).not.toBeNull()
    fireEvent.change(imageInput as HTMLInputElement, {
      target: { files: [new File(['pixels'], 'shot.png', { type: 'image/png' })] },
    })

    await waitFor(() => {
      expect(mobileActions).toHaveLength(2)
    })
    expect(mobileActions[0]).toEqual(
      expect.objectContaining({
        kind: 'native_image_paste',
        payload: {
          file_id: 'image-1',
          placeholder: '[Image #1]',
        },
        target: { run_id: 'run-worker' },
        workspace_id: 'workspace-1',
      })
    )
    const fallback = mobileActions[1] as {
      payload?: { attachments?: Array<{ file_id?: string; placeholder?: string }>; input?: string }
    }
    expect(fallback).toEqual(
      expect.objectContaining({
        kind: 'terminal_input',
        target: { run_id: 'run-worker' },
        workspace_id: 'workspace-1',
      })
    )
    expect(deletes).toHaveLength(0)
    expect(fallback.payload?.input?.startsWith(`${String.fromCharCode(27)}[200~`)).toBe(true)
    expect(fallback.payload?.input?.endsWith(`${String.fromCharCode(27)}[201~`)).toBe(true)
    expect(fallback.payload?.input).not.toContain('[Image #1]')
    expect(fallback.payload?.input).toContain('Mobile image attachment: shot.png')
    expect(fallback.payload?.input).toContain(
      'Yive Runtime will bind this upload to a validated Workspace-relative Artifact.'
    )
    expect(fallback.payload?.input).not.toContain('file_id')
    expect(fallback.payload?.input).not.toContain('.hive/mobile-attachments.json')
    expect(fallback.payload?.input).not.toContain('local_path')
    expect(fallback.payload?.input).not.toContain('Ctrl+V')
    expect(fallback.payload?.input).not.toContain('paste image')
    expect(fallback.payload?.input).not.toContain('C:\\Temp\\hive-mobile-files\\image-1.png')
    expect(fallback.payload?.attachments).toEqual([
      {
        file_id: 'image-1',
        placeholder: '[Image #1]',
      },
    ])
    expect(await screen.findByText('已将图片作为服务器附件发送给 CLI')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('C:\\Temp\\hive-mobile-files\\image-1.png')
    expect(document.body.textContent).not.toContain('cGl4ZWxz')
    expect(document.body.textContent).not.toContain('HIVE_AGENT_TOKEN')
    expect(document.body.textContent).not.toContain('x-hive-agent-token')
    expect(document.body.textContent).not.toContain('agent_token')
    expect(JSON.stringify(mobileActions)).not.toContain('.hive/mobile-attachments.json')
    expect(JSON.stringify(mobileActions)).not.toContain('local_path')
  })

  test('/mobile explains when native image paste falls back to an AI attachment reference', async () => {
    window.history.pushState({}, '', '/mobile')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Image Lab', path: 'C:/work/image-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files' && init?.method === 'POST') {
        return json({
          created_at: 1,
          id: 'image-1',
          local_path: 'C:\\Temp\\hive-mobile-files\\image-1.png',
          mime_type: 'image/png',
          name: 'shot.png',
          size: 6,
        })
      }
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/actions') {
        return json({
          ok: true,
          result: {
            fallback_reason: 'native_clipboard_unavailable',
            input: 'server_attachment_prompt',
          },
        })
      }
      throw new Error(`Unexpected fetch in image paste fallback reason test: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()
    await openTerminalTools()
    const imageInput = document.querySelector(
      'input[accept*="image/png"]'
    ) as HTMLInputElement | null
    expect(imageInput).not.toBeNull()
    fireEvent.change(imageInput as HTMLInputElement, {
      target: { files: [new File(['pixels'], 'shot.png', { type: 'image/png' })] },
    })

    expect(
      await screen.findByText(
        '电脑端暂时不能原生粘贴图片，已改为附件引用发给 AI（native_clipboard_unavailable）'
      )
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('C:\\Temp\\hive-mobile-files\\image-1.png')
  })

  test('/mobile can retry an uploaded image reference when relay delivery fails', async () => {
    window.history.pushState({}, '', '/mobile')
    const mobileActions: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Image Retry Lab', path: 'C:/work/image-retry' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files' && init?.method === 'POST') {
        return json({
          created_at: 1,
          id: 'image-1',
          local_path: 'C:\\Temp\\hive-mobile-files\\image-1.png',
          mime_type: 'image/png',
          name: 'shot.png',
          size: 6,
        })
      }
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/actions') {
        const action = JSON.parse(String(init?.body)) as Record<string, unknown>
        mobileActions.push(action)
        if (action.kind === 'native_image_paste') {
          return failure(409, { error: 'native paste unavailable' })
        }
        if (action.kind === 'terminal_input' && mobileActions.length === 2) {
          return failure(503, { error: 'Relay request timed out: mobile_action' })
        }
        return json({ ok: true })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()
    await openTerminalTools()

    const imageInput = document.querySelector(
      'input[accept*="image/png"]'
    ) as HTMLInputElement | null
    expect(imageInput).not.toBeNull()
    fireEvent.change(imageInput as HTMLInputElement, {
      target: { files: [new File(['pixels'], 'shot.png', { type: 'image/png' })] },
    })

    expect(await screen.findByText(/图片已上传到文件交换区，但引用未送达 CLI/u)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新发送' }))

    await waitFor(() => expect(mobileActions).toHaveLength(3))
    const firstFallback = mobileActions[1] as {
      action_id?: string
      payload?: { attachments?: Array<{ file_id?: string; placeholder?: string }>; input?: string }
    }
    const retryFallback = mobileActions[2] as {
      action_id?: string
      payload?: { attachments?: Array<{ file_id?: string; placeholder?: string }>; input?: string }
    }
    expect(retryFallback.action_id).toBe(firstFallback.action_id)
    expect(retryFallback.payload?.input).toBe(firstFallback.payload?.input)
    expect(retryFallback.payload?.attachments).toEqual([
      {
        file_id: 'image-1',
        placeholder: '[Image #1]',
      },
    ])
    expect(await screen.findByText('已发送到电脑端 PTY')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新发送' })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('C:\\Temp\\hive-mobile-files\\image-1.png')
    expect(document.body.textContent).not.toContain('cGl4ZWxz')
  })

  test('/mobile disables the retry button while terminal input is being resent', async () => {
    window.history.pushState({}, '', '/mobile')
    const mobileActions: Array<Record<string, unknown>> = []
    let resolveRetry!: (response: Response) => void
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Retry Busy Lab', path: 'C:/work/retry-busy' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/actions') {
        mobileActions.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        if (mobileActions.length === 1) return failure(503, { error: 'Relay request timed out' })
        return new Promise<Response>((resolve) => {
          resolveRetry = resolve
        })
      }
      throw new Error(`Unexpected fetch in terminal retry busy test: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()
    await openTerminalTools()
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl+C' }))

    expect(await screen.findByText(/远程连接中断或超时.*未送达电脑端/u)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新发送' }))

    expect(await screen.findByRole('button', { name: '重发中...' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '重发中...' }))
    expect(mobileActions).toHaveLength(2)

    resolveRetry(json({ ok: true }))

    expect(await screen.findByText('已发送到电脑端 PTY')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新发送' })).not.toBeInTheDocument()
  })

  test('/mobile refreshes and reconnects when the selected terminal run is stale', async () => {
    window.history.pushState({}, '', '/mobile')
    let runsRequestCount = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Reconnect Lab', path: 'C:/work/reconnect' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        runsRequestCount += 1
        return json([
          runPayload({
            runId: runsRequestCount >= 2 ? 'run-worker-new' : 'run-worker-old',
          }),
        ])
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()

    expect(await screen.findByTestId('mock-terminal-run-worker-old')).toBeInTheDocument()
    terminalViewProps.at(-1)?.onError?.('Not found')

    expect(await screen.findByText('终端会话已失效，正在重新获取最新会话...')).toBeInTheDocument()
    expect(await screen.findByTestId('mock-terminal-run-worker-new')).toBeInTheDocument()
    expect(screen.queryByTestId('mock-terminal-run-worker-old')).not.toBeInTheDocument()
  })

  test('/mobile surfaces non-stale terminal errors without leaking sensitive details', async () => {
    window.history.pushState({}, '', '/mobile')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Terminal Error Lab', path: 'C:/work/error' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()

    expect(await screen.findByTestId('mock-terminal-run-worker')).toBeInTheDocument()
    const longBase64 = 'cGl4ZWxz'.repeat(12)
    terminalViewProps
      .at(-1)
      ?.onError?.(
        `WebSocket closed HIVE_AGENT_TOKEN=secret-token C:\\Users\\dev\\secret.png ${longBase64}`.repeat(
          12
        )
      )

    expect(await screen.findByText(/终端连接已断开：/u)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('secret-token')
    expect(document.body.textContent).not.toContain('C:\\Users\\dev\\secret.png')
    expect(document.body.textContent).not.toContain(longBase64)
  })

  test('/mobile explains relay terminal proxy failures in the terminal pane', async () => {
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&device_id=phone-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in relay terminal proxy failure test: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    await openWorkerTerminal('Remote Worker')

    expect(await screen.findByTestId('mock-terminal-run-relay')).toBeInTheDocument()
    expect(screen.queryByLabelText('远程链路状态')).not.toBeInTheDocument()
    terminalViewProps.at(-1)?.onError?.('Desktop peer disconnected')

    expect(
      await screen.findByText(/远程终端连接已断开：Desktop peer disconnected/u)
    ).toBeInTheDocument()
    expect(screen.getByText(/电脑 Bridge 和本地 runtime 在线/u)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('pair-token')
  })

  test('/control/mobile relay terminal uses the control websocket base path', async () => {
    window.history.pushState(
      {},
      '',
      '/control/mobile?relay=1&desktop_id=desktop-control&device_id=phone-control&token=pair-token&server=http%3A%2F%2Flocalhost%3A3000%2Fcontrol'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'http://localhost:3000/control/devices') {
        return json({
          desktops: [{ device_id: 'desktop-control', runtime_status: 'online' }],
          mobiles: [{ desktop_id: 'desktop-control', device_id: 'phone-control' }],
        })
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in control relay terminal test: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    await openWorkerTerminal('Remote Worker')

    expect(await screen.findByTestId('mock-terminal-run-relay')).toBeInTheDocument()
    expect(terminalViewProps.at(-1)?.connectionParams).toEqual(
      expect.objectContaining({
        desktop_id: 'desktop-control',
        device_id: 'phone-control',
        server: 'http://localhost:3000/control',
        token: 'pair-token',
        websocket_base_path: '/control',
      })
    )
  })

  test('/mobile terminal pane hides transient relay event stream warnings', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    window.history.pushState(
      {},
      '',
      '/mobile?relay=1&desktop_id=desktop-1&device_id=phone-1&token=pair-token&server=https%3A%2F%2Frelay.test'
    )
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://relay.test/devices') {
        return json({
          desktops: [{ device_id: 'desktop-1', runtime_status: 'online' }],
          mobiles: [{ desktop_id: 'desktop-1', device_id: 'phone-1' }],
        })
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in relay terminal warning test: ${url}`)
    })
    vi.stubGlobal('WebSocket', MockRelayWebSocket)

    render(<App />)

    await openWorkerTerminal('Remote Worker')
    expect(document.querySelector('.mobile-lan-status')).toBeNull()
    const socket = MockRelayWebSocket.instances.at(-1)
    if (!socket) throw new Error('Expected relay websocket')

    act(() => {
      socket.close()
    })

    expect(screen.queryByText(/远程状态已暂停更新/u)).not.toBeInTheDocument()
    expect(screen.queryByText(/事件流重连中/u)).not.toBeInTheDocument()
    await act(async () => {
      vi.advanceTimersByTime(4_000)
      await Promise.resolve()
    })

    expect(screen.queryByText(/远程状态已暂停更新/u)).not.toBeInTheDocument()
    expect(screen.queryByText(/事件流重连中/u)).not.toBeInTheDocument()

    expect(screen.getByTestId('mock-terminal-run-relay')).toBeInTheDocument()
  })

  test('/mobile disables terminal input tools while the browser is offline', async () => {
    window.history.pushState({}, '', '/mobile')
    let browserOnline = true
    const mobileActions: Array<Record<string, unknown>> = []
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => browserOnline)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([
          { id: 'workspace-1', name: 'Offline Terminal Lab', path: 'C:/work/offline-terminal' },
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/actions') {
        mobileActions.push(JSON.parse(String(init?.body)))
        return json({ ok: true })
      }
      throw new Error(`Unexpected fetch in offline terminal tools test: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()
    await openTerminalTools()
    expect(await screen.findByRole('button', { name: 'Ctrl+C' })).toBeInTheDocument()

    browserOnline = false
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })

    expect(
      await screen.findByText(/浏览器当前离线，远程控制会在网络恢复后自动重试。/u)
    ).toBeInTheDocument()
    expect(screen.getByText('连接恢复前不会发送终端输入、快捷键或图片。')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Ctrl+C' })).not.toBeInTheDocument()
    )
    expect(screen.getByRole('button', { name: '打开终端工具' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重试连接' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '打开 Agent 操作' }))
    expect(screen.getByRole('menuitem', { name: '刷新' })).not.toBeDisabled()
    expect(screen.getByRole('menuitem', { name: '重启终端' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: '停止终端' })).toBeDisabled()
    expect(mobileActions).toHaveLength(0)
  })

  test('/mobile cancels an open dangerous confirmation when the browser goes offline', async () => {
    window.history.pushState({}, '', '/mobile')
    let browserOnline = true
    const calls: string[] = []
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => browserOnline)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([
          { id: 'workspace-1', name: 'Offline Confirm Lab', path: 'C:/work/offline-confirm' },
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/actions') return json({ ok: true })
      throw new Error(`Unexpected fetch in offline confirm test: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()
    openAgentActions()
    fireEvent.click(await screen.findByRole('menuitem', { name: '停止终端' }))
    expect(screen.getByText('确认安全停止')).toBeInTheDocument()

    browserOnline = false
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })

    await waitFor(() => expect(screen.queryByText('确认安全停止')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '确认' })).not.toBeInTheDocument()
    expect(calls).not.toContain('/api/mobile/actions')
  })

  test('/mobile detail hides the outer app header and keeps fixed terminal controls', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Runtime Detail Lab', path: 'C:/work/detail' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const view = render(<App />)

    await openWorkerTerminal()

    expect(await screen.findByTestId('mock-terminal-run-worker')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '聊天' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '原始终端' })).not.toBeInTheDocument()
    expect(view.container.querySelector('.mobile-topbar')).toBeNull()
    expect(view.container.querySelector('.mobile-lan-status')).toBeNull()
    expect(document.getElementById('mobile-workspace-switcher')).toBeNull()
    expect(view.container.querySelector('.mobile-agent-summary')).toBeNull()
    expect(
      view.container.querySelector('.mobile-terminal__title-row .mobile-agent-status')
    ).not.toBeNull()
    expect(view.container.querySelector('.mobile-agent-terminal')).not.toBeNull()
    expect(view.container.querySelector('.mobile-agent-composer')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开终端工具' }))
    expect(screen.getByRole('button', { name: '收起终端工具' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.queryByLabelText('输入给 Agent 的消息')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ctrl+C' })).toBeInTheDocument()
    expect(view.container.querySelector('.mobile-terminal__stream')).not.toBeNull()
    expect(screen.queryByRole('button', { name: '确认接管' })).not.toBeInTheDocument()
    expect(terminalViewProps.at(-1)?.autoTakeover).toBe(true)
    expect(terminalViewProps.at(-1)?.fitToContainer).toBe(true)
    expect(terminalViewProps.at(-1)?.initialSize).toBeUndefined()
    expect(terminalViewProps.at(-1)?.minimumSize).toEqual({ cols: 24, rows: 10 })
    expect(terminalViewProps.at(-1)?.portalId).toBe(`worker-pty-workspace-1-${runPayload().run_id}`)
    expect(terminalViewProps.at(-1)?.propagateResize).toBe(true)
    expect(terminalViewProps.at(-1)?.viewerMode).toBe('takeover')
    expect(calls).not.toContain('/api/runtime/runs/run-worker')
  })

  test('/mobile opens a running agent terminal in takeover mode sized to the phone', async () => {
    window.history.pushState({}, '', '/mobile')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Takeover Lab', path: 'C:/work/takeover' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in takeover terminal test: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()

    await waitFor(() => expect(terminalViewProps.at(-1)?.viewerMode).toBe('takeover'))
    expect(terminalViewProps.at(-1)?.autoTakeover).toBe(true)
    expect(terminalViewProps.at(-1)?.propagateResize).toBe(true)
    expect(screen.queryByRole('button', { name: '确认接管' })).not.toBeInTheDocument()
  })

  test('/mobile keeps terminal input tools active while the phone owns terminal sizing', async () => {
    window.history.pushState({}, '', '/mobile')
    const mobileActions: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([
          { id: 'workspace-1', name: 'Desktop Owned Lab', path: 'C:/work/desktop-owned' },
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/actions') {
        mobileActions.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return json({ ok: true })
      }
      throw new Error(`Unexpected fetch in takeover terminal input test: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()
    await openTerminalTools()
    expect(await screen.findByRole('button', { name: 'Ctrl+C' })).toBeInTheDocument()

    act(() => {
      terminalViewProps.at(-1)?.onOwnershipChange?.({
        mode: 'active',
        ownedByThisClient: false,
        ownerClientId: 'desktop-client',
      })
    })

    expect(screen.queryByText('电脑端正在接管终端，手机端暂不发送输入、快捷键或图片。')).toBeNull()
    expect(screen.getByRole('button', { name: 'Ctrl+C' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '收起终端工具' })).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Ctrl+C' }))

    await waitFor(() => expect(mobileActions).toHaveLength(1))
    expect(mobileActions[0]).toMatchObject({
      kind: 'terminal_input',
      payload: { input: '\x03' },
      target: { run_id: 'run-worker' },
      workspace_id: 'workspace-1',
    })
  })

  test('/mobile keeps the screen awake while a terminal is open', async () => {
    window.history.pushState({}, '', '/mobile')
    const release = vi.fn(async () => undefined)
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    const request = vi.fn(async () => ({
      addEventListener,
      release,
      removeEventListener,
    }))
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request },
    })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Wake Lock Lab', path: 'C:/work/wake-lock' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch in wake lock test: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()

    await waitFor(() => expect(request).toHaveBeenCalledWith('screen'))
    expect(addEventListener).toHaveBeenCalledWith('release', expect.any(Function))

    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Agent' })).toBeInTheDocument())
    await waitFor(() => expect(release).toHaveBeenCalledOnce())
    await openWorkerTerminal()
    expect(screen.getByTestId('mock-terminal-run-worker')).toBeVisible()
    expect(request).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    fireEvent.click(screen.getByRole('button', { name: /Wake Lock Lab/u }))
    const workspaceSwitcher = document.getElementById('mobile-workspace-switcher')
    expect(workspaceSwitcher).not.toBeNull()
    fireEvent.click(
      within(workspaceSwitcher as HTMLElement).getByRole('button', { name: /Wake Lock Lab/u })
    )

    await waitFor(() => expect(release).toHaveBeenCalledTimes(2))
    expect(removeEventListener).toHaveBeenCalledWith('release', expect.any(Function))
  })

  test('/mobile reports worker status separately from terminal run status in detail', async () => {
    window.history.pushState({}, '', '/mobile')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Status Lab', path: 'C:/work/status-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([workerPayload({ conversationActivity: 'idle', name: 'Idle Runner' })])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([
          runPayload({
            agentName: 'Idle Runner',
            runId: 'run-idle-worker',
            status: 'running',
          }),
        ])
      }
      if (url === '/api/runtime/runs/run-idle-worker') {
        return json({
          output: 'running despite idle worker',
          run_id: 'run-idle-worker',
          status: 'running',
        })
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal('Idle Runner')

    expect(await screen.findByRole('heading', { name: 'Idle Runner' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Idle Runner' })).toBeInTheDocument()
    expect(
      document.querySelector('.mobile-terminal__title-row .mobile-agent-status')
    ).not.toBeNull()
    expect(screen.queryByRole('menuitem', { name: '停止终端' })).not.toBeInTheDocument()
    openAgentActions()
    expect(screen.getByRole('menuitem', { name: '停止终端' })).toBeInTheDocument()
  })

  test('/mobile shows a safe error when terminal input action fails', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: string[] = []
    const mobileActions: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Failure Lab', path: 'C:/work/failure-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/actions') {
        mobileActions.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        if (mobileActions.length === 1) return failure(503, { error: '发送失败' })
        return json({ ok: true })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()
    await openTerminalTools()
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl+C' }))

    expect(await screen.findByText(/发送失败.*未送达电脑端/u)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新发送' }))
    await waitFor(() => expect(mobileActions).toHaveLength(2))
    expect(mobileActions[0]?.action_id).toEqual(expect.stringMatching(/^terminal-input-/))
    expect(mobileActions[1]?.action_id).toBe(mobileActions[0]?.action_id)
    expect(mobileActions).toEqual([
      expect.objectContaining({
        kind: 'terminal_input',
        payload: { input: '\x03' },
        target: { run_id: 'run-worker' },
        workspace_id: 'workspace-1',
      }),
      expect.objectContaining({
        kind: 'terminal_input',
        payload: { input: '\x03' },
        target: { run_id: 'run-worker' },
        workspace_id: 'workspace-1',
      }),
    ])
    expect(await screen.findByText('已发送到电脑端 PTY')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新发送' })).not.toBeInTheDocument()
    expect(calls).not.toContain('/api/runtime/runs/run-worker')
    expect(document.body.textContent).not.toContain('HIVE_AGENT_TOKEN')
    expect(document.body.textContent).not.toContain('x-hive-agent-token')
    expect(document.body.textContent).not.toContain('agent_token')
  })

  test('/mobile disables pending terminal input retry while the browser is offline', async () => {
    window.history.pushState({}, '', '/mobile')
    let browserOnline = true
    const mobileActions: Array<Record<string, unknown>> = []
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => browserOnline)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([
          { id: 'workspace-1', name: 'Retry Offline Lab', path: 'C:/work/retry-offline' },
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/actions') {
        mobileActions.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return failure(503, { error: 'relay delivery failed' })
      }
      throw new Error(`Unexpected fetch in offline retry test: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()
    await openTerminalTools()
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl+C' }))

    const retryButton = await screen.findByRole('button', { name: '重新发送' })
    expect(retryButton).not.toBeDisabled()
    expect(mobileActions).toHaveLength(1)

    browserOnline = false
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })

    await waitFor(() => expect(screen.getByRole('button', { name: '重新发送' })).toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '重新发送' }))
    expect(mobileActions).toHaveLength(1)
  })

  test('/mobile does not infer an Orchestrator from an empty Agent and run snapshot', async () => {
    window.history.pushState({}, '', '/mobile')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Quiet Lab', path: 'C:/work/quiet-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Agent' }))

    await screen.findByRole('heading', { name: '当前工作区 Agent' })
    expect(screen.queryByRole('button', { name: '打开 Orchestrator 终端' })).toBeNull()
    expect(screen.queryByText('Orchestrator 暂无运行中的终端')).not.toBeInTheDocument()
    expect(screen.queryByText('未运行')).not.toBeInTheDocument()
    expect(document.querySelectorAll('.mobile-agent-card')).toHaveLength(0)
    expect(document.querySelectorAll('.mobile-agent-summary__pill').length).toBeGreaterThan(0)
  })

  test('/mobile surfaces dashboard token or offline failures without exposing agent controls', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Offline Lab', path: 'C:/work/offline-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return failure(403, { error: 'UI endpoint requires valid UI token' })
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return failure(503, { error: 'runtime offline' })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(document.querySelector('.mobile-danger-button')).toBeNull()
    expect(calls).toContain('/api/ui/session')
    expect(document.body.textContent).not.toContain('HIVE_AGENT_TOKEN')
    expect(document.body.textContent).not.toContain('agent_token')
  })

  test('/mobile does not send CLI agent tokens or stop runs from agent cards', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: Array<{ body?: unknown; headers?: HeadersInit; method?: string; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ body: init?.body, headers: init?.headers, method: init?.method, url })
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Safe Lab', path: 'C:/work/safe-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([
          {
            active_dispatch_id: null,
            conversation_activity: 'busy',
            provider: 'codex',
            id: 'worker-1',
            last_observed_at: 1,
            last_pty_line: 'ready',
            name: 'Safe Worker',
            process_state: 'running',
            queue_pause_reason: null,
            queued_dispatch_count: 0,
            kind: 'worker',
          },
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([
          {
            agent_id: 'worker-1',
            agent_name: 'Safe Worker',
            run_id: 'run-worker',
            status: 'running',
          },
        ])
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()

    openAgentActions()
    expect(await screen.findByRole('menuitem', { name: '停止终端' })).toBeInTheDocument()
    expect(calls.some((call) => call.url === '/api/runtime/runs/run-worker/stop')).toBe(false)
    for (const call of calls) {
      expect(JSON.stringify(call)).not.toContain('HIVE_AGENT_TOKEN')
      expect(JSON.stringify(call)).not.toContain('x-hive-agent-token')
      expect(JSON.stringify(call)).not.toContain('agent_token')
    }
  })

  test('/mobile dashboard exposes notification and approval review state without action buttons', async () => {
    window.history.pushState({}, '', '/mobile')
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Approval Lab', path: 'C:/work/approval-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '通知' }))

    expect(await screen.findByText('通知 / 审批')).toBeInTheDocument()
    expect(document.querySelector('.mobile-approval-item')).not.toBeNull()
    expect(document.querySelector('.mobile-approval-summary')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /needs changes/i })).not.toBeInTheDocument()
  })

  test('/mobile requires a second confirmation before dangerous 閸嬫粍顒?calls the runtime', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: Array<{ body?: unknown; headers?: HeadersInit; method?: string; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ body: init?.body, headers: init?.headers, method: init?.method, url })
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: '閸嬫粍顒?Lab', path: 'C:/work/stop-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/confirmations') {
        return json({ expires_in_ms: 60000, nonce: 'nonce-stop-test', ok: true })
      }
      if (url === '/api/mobile/actions') {
        return json({
          action_id: 'stop-test',
          kind: 'stop_run',
          ok: true,
          result: { run_id: 'run-worker' },
          workspace_id: 'workspace-1',
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()
    openAgentActions()
    fireEvent.click(await screen.findByRole('menuitem', { name: '停止终端' }))

    expect(calls.some((call) => call.url === '/api/runtime/runs/run-worker/stop')).toBe(false)
    expect(document.querySelector('.mobile-approval-confirm')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '确认' }))

    await waitFor(() =>
      expect(calls.some((call) => call.url === '/api/mobile/confirmations')).toBe(true)
    )
    await waitFor(() => expect(calls.some((call) => call.url === '/api/mobile/actions')).toBe(true))
    const confirmationCall = calls.find((call) => call.url === '/api/mobile/confirmations')
    expect(JSON.parse(String(confirmationCall?.body))).toEqual({
      kind: 'stop_run',
      target: { run_id: 'run-worker' },
      workspace_id: 'workspace-1',
    })
    const actionCall = calls.find((call) => call.url === '/api/mobile/actions')
    expect(actionCall).toEqual(
      expect.objectContaining({
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    )
    expect(JSON.parse(String(actionCall?.body))).toEqual({
      action_id: expect.stringMatching(/^stop-run-/),
      kind: 'stop_run',
      payload: { confirmation_nonce: 'nonce-stop-test' },
      target: { run_id: 'run-worker' },
      workspace_id: 'workspace-1',
    })
  })

  test('/mobile keeps the terminal visible and can retry a failed stop action', async () => {
    window.history.pushState({}, '', '/mobile')
    const mobileActions: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Retry Stop Lab', path: 'C:/work/retry-stop' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/confirmations') {
        return json({ expires_in_ms: 60000, nonce: `nonce-${mobileActions.length + 1}`, ok: true })
      }
      if (url === '/api/mobile/actions') {
        const action = JSON.parse(String(init?.body)) as Record<string, unknown>
        mobileActions.push(action)
        if (mobileActions.length === 1) {
          return failure(503, { error: 'relay delivery failed' })
        }
        return json({
          action_id: action.action_id,
          kind: 'stop_run',
          ok: true,
          result: { run_id: 'run-worker' },
          workspace_id: 'workspace-1',
        })
      }
      throw new Error(`Unexpected fetch in failed stop retry test: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()
    openAgentActions()
    fireEvent.click(await screen.findByRole('menuitem', { name: '停止终端' }))
    fireEvent.click(screen.getByRole('button', { name: '确认' }))

    expect(await screen.findByRole('button', { name: '重试操作' })).toBeInTheDocument()
    expect(screen.getByTestId('mock-terminal-run-worker')).toBeInTheDocument()
    expect(screen.queryByText('终端会话已重启或失效。')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试操作' }))

    await waitFor(() => expect(mobileActions).toHaveLength(2))
    expect(mobileActions.map((action) => action.kind)).toEqual(['stop_run', 'stop_run'])
    expect(await screen.findByText('终端已安全停止')).toBeInTheDocument()
  })

  test('/mobile keeps the run alive until a confirmed checkpoint stop completes', async () => {
    window.history.pushState({}, '', '/mobile')
    const confirmations: Array<Record<string, unknown>> = []
    const mobileActions: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Checkpoint Lab', path: 'C:/work/checkpoint' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/confirmations') {
        confirmations.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return json({ expires_in_ms: 60000, nonce: `nonce-${confirmations.length}`, ok: true })
      }
      if (url === '/api/mobile/actions') {
        const action = JSON.parse(String(init?.body)) as Record<string, unknown>
        mobileActions.push(action)
        const target = action.target as Record<string, unknown>
        return json({
          action_id: action.action_id,
          kind: 'stop_run',
          ok: true,
          result: {
            mode: target.mode ?? 'safe',
            reason: target.mode === 'checkpoint' ? null : 'uncommitted_input',
            run_id: 'run-worker',
            session_id: 'session-worker',
            state: target.mode === 'checkpoint' ? 'stopped' : 'checkpoint_required',
          },
          workspace_id: 'workspace-1',
        })
      }
      throw new Error(`Unexpected fetch in checkpoint stop test: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()
    openAgentActions()
    fireEvent.click(await screen.findByRole('menuitem', { name: '停止终端' }))
    fireEvent.click(screen.getByRole('button', { name: '确认' }))

    expect(await screen.findByText('最新会话状态尚未持久化')).toBeInTheDocument()
    expect(screen.getByTestId('mock-terminal-run-worker')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '强制停止' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '创建恢复点并停止' }))

    await waitFor(() => expect(mobileActions).toHaveLength(2))
    expect(confirmations[1]).toEqual({
      kind: 'stop_run',
      target: { mode: 'checkpoint', run_id: 'run-worker' },
      workspace_id: 'workspace-1',
    })
    expect(mobileActions[1]).toEqual(
      expect.objectContaining({
        kind: 'stop_run',
        target: { mode: 'checkpoint', run_id: 'run-worker' },
      })
    )
    expect(await screen.findByText('终端已安全停止')).toBeInTheDocument()
  })

  test('/mobile terminal actions never send CLI agent tokens', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: Array<{ body?: unknown; headers?: HeadersInit; method?: string; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ body: init?.body, headers: init?.headers, method: init?.method, url })
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Token Lab', path: 'C:/work/token-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([runPayload()])
      if (url === '/api/mobile/files') return json([])
      if (url === '/api/mobile/confirmations') {
        return json({ expires_in_ms: 60000, nonce: 'nonce-token-test', ok: true })
      }
      if (url === '/api/mobile/actions') {
        return json({
          action_id: 'stop-token',
          kind: 'stop_run',
          ok: true,
          result: { run_id: 'run-worker' },
          workspace_id: 'workspace-1',
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    await openWorkerTerminal()
    openAgentActions()
    fireEvent.click(await screen.findByRole('menuitem', { name: '停止终端' }))
    fireEvent.click(screen.getByRole('button', { name: '确认' }))

    await waitFor(() => expect(calls.some((call) => call.url === '/api/mobile/actions')).toBe(true))
    for (const call of calls) {
      expect(stringifyCall(call)).not.toContain('HIVE_AGENT_TOKEN')
      expect(stringifyCall(call)).not.toContain('x-hive-agent-token')
      expect(stringifyCall(call)).not.toContain('agent_token')
    }
  })

  test('/mobile terminal error state does not trigger start or stop actions accidentally', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Error Lab', path: 'C:/work/error-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return failure(500, { error: 'notifications unavailable' })
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return failure(503, { error: 'runtime offline' })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(calls.some((url) => /\/api\/runtime\/runs\/.+\/stop$/.test(url))).toBe(false)
    expect(calls.some((url) => /\/api\/workspaces\/.+\/agents\/.+\/start$/.test(url))).toBe(false)
    expect(screen.queryByRole('button', { name: /approve|reject|stop/i })).not.toBeInTheDocument()
  })

  test('/mobile treats file-like and dangerous worker output as inert text', async () => {
    window.history.pushState({}, '', '/mobile')
    const dangerousWindow = window as Window & { __hiveDanger?: number }
    dangerousWindow.__hiveDanger = undefined
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Files Lab', path: 'C:/work/files-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([
          workerPayload({
            conversationActivity: 'idle',
            name: 'File Worker',
          }),
          {
            ...workerPayload({
              id: 'worker-danger',
              name: 'Danger Output',
            }),
            last_pty_line:
              '<script>window.__hiveDanger=1</script> report.md clip.mp4 [run](javascript:alert(1))',
          },
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Agent' }))

    expect(await screen.findByText('Danger Output')).toBeInTheDocument()
    expect(screen.queryByText(/report\.md clip\.mp4/)).not.toBeInTheDocument()
    expect(dangerousWindow.__hiveDanger).toBeUndefined()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /preview|execute/i })).not.toBeInTheDocument()
  })

  test('/mobile shows the temporary file exchange list without auto-previewing files', async () => {
    window.history.pushState({}, '', '/mobile')
    const now = 1_780_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Files Lab', path: 'C:/work/files-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') {
        return json([
          {
            created_at: 1,
            expires_at: now + 24 * 60 * 60 * 1000,
            id: 'file-1',
            mime_type: 'text/markdown',
            name: 'review.md',
            size: 12,
          },
        ])
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '文件' }))

    expect(await screen.findByText('文件交换区')).toBeInTheDocument()
    expect(await screen.findByText('review.md')).toBeInTheDocument()
    expect(screen.getByText(/1 天后过期/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下载' })).toBeInTheDocument()
    expect(screen.queryByText('# Review')).not.toBeInTheDocument()
  })

  test('/mobile sends workspace file review decisions without leaking local paths', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: Array<{ body?: unknown; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const parsedBody =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
      calls.push({ ...(parsedBody ? { body: parsedBody } : {}), url })
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Files Lab', path: 'C:/work/files-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') {
        return json([
          workerPayload({
            conversationActivity: 'idle',
            id: 'worker-review',
            name: 'Reviewer',
          }),
        ])
      }
      if (url === '/api/ui/workspaces/workspace-1/runs') {
        return json([
          {
            agent_id: 'worker-review',
            agent_name: 'Reviewer',
            run_id: 'run-review',
            status: 'running',
          },
        ])
      }
      if (url === '/api/mobile/files') {
        return json([
          {
            created_at: 1,
            id: 'file-review',
            local_path: 'C:/work/files-lab/dist/review.md',
            mime_type: 'text/markdown',
            name: 'review.md',
            size: 12,
            source: 'workspace',
            workspace_path: 'dist/review.md',
          },
        ])
      }
      if (url === '/api/mobile/actions' && init?.method === 'POST') {
        return json(
          {
            action_id: 'file-review-1',
            kind: 'file_review',
            ok: true,
            result: {
              decision: 'needs_changes',
              file_id: 'file-review',
              run_id: 'run-review',
            },
            workspace_id: 'workspace-1',
          },
          { status: 202 }
        )
      }
      throw new Error(`Unexpected fetch in file review test: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '文件' }))
    expect(await screen.findByText('review.md')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: '需修改' }))

    expect(await screen.findByText(/已将 review\.md 的审核结果/)).toBeInTheDocument()
    const actionCall = calls.find((call) => call.url === '/api/mobile/actions')
    expect(actionCall?.body).toEqual(
      expect.objectContaining({
        kind: 'file_review',
        payload: { decision: 'needs_changes' },
        target: { file_id: 'file-review', run_id: 'run-review' },
        workspace_id: 'workspace-1',
      })
    )
    expect(JSON.stringify(actionCall?.body)).not.toContain('C:/work/files-lab')
    expect(JSON.stringify(actionCall?.body)).not.toContain('content_base64')
    expect(document.body.textContent).not.toContain('C:/work/files-lab/dist/review.md')
  })

  test('/mobile keeps a manual fallback link after downloading a workspace file', async () => {
    window.history.pushState({}, '', '/mobile')
    const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    const createObjectUrl = vi
      .fn()
      .mockReturnValueOnce('blob:yive-download-fallback')
      .mockReturnValueOnce('blob:yive-download-auto')
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectUrl,
    })
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const deletes: Array<string> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Files Lab', path: 'C:/work/files-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') {
        return json([
          {
            created_at: 1,
            id: 'file-video',
            local_path: 'C:/work/files-lab/dist/demo.mp4',
            mime_type: 'video/mp4',
            name: 'demo.mp4',
            size: 12,
            source: 'workspace',
            workspace_path: 'dist/demo.mp4',
          },
        ])
      }
      if (url === '/api/mobile/files/file-video') {
        if (init?.method === 'DELETE') {
          deletes.push(url)
          return new Response(null, { status: 204 })
        }
        return new Response('video', {
          headers: {
            'content-disposition': 'attachment; filename="demo.mp4"',
            'content-type': 'video/mp4',
          },
        })
      }
      throw new Error(`Unexpected fetch in file download fallback test: ${url}`)
    })

    const view = render(<App />)
    let unmounted = false

    try {
      fireEvent.click(await screen.findByRole('button', { name: '文件' }))
      fireEvent.click(await screen.findByRole('button', { name: '下载' }))

      expect(await screen.findByText('备用下载链接')).toBeInTheDocument()
      const fallback = screen.getByRole('link', { name: '备用下载链接' })
      expect(fallback).toHaveAttribute('href', 'blob:yive-download-fallback')
      expect(fallback).toHaveAttribute('download', 'demo.mp4')
      expect(
        await screen.findByText(
          '文件已开始下载。若没有自动下载，请点下面的备用链接。 已从文件交换区移除。'
        )
      ).toBeInTheDocument()
      expect(createObjectUrl).toHaveBeenCalledTimes(1)
      expect(clickAnchor).toHaveBeenCalled()
      expect(deletes).toEqual(['/api/mobile/files/file-video'])
      expect(document.body.textContent).not.toContain('C:/work/files-lab/dist/demo.mp4')
      expect(document.body.textContent).not.toContain('content_base64')

      view.unmount()
      unmounted = true
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:yive-download-fallback')
    } finally {
      if (!unmounted) view.unmount()
      if (originalCreateObjectUrl) {
        Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl)
      } else {
        delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
      }
      if (originalRevokeObjectUrl) {
        Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl)
      } else {
        delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
      }
    }
  })

  test('/mobile shows progress while downloading a workspace file', async () => {
    window.history.pushState({}, '', '/mobile')
    const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    const createObjectUrl = vi.fn().mockReturnValueOnce('blob:yive-download-progress')
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectUrl,
    })
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    let downloadController: ReadableStreamDefaultController<Uint8Array> | null = null
    const encoder = new TextEncoder()
    const deletes: Array<string> = []

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Files Lab', path: 'C:/work/files-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') {
        return json([
          {
            created_at: 1,
            id: 'file-video',
            local_path: 'C:/work/files-lab/dist/demo.mp4',
            mime_type: 'video/mp4',
            name: 'demo.mp4',
            size: 8,
            source: 'workspace',
            workspace_path: 'dist/demo.mp4',
          },
        ])
      }
      if (url === '/api/mobile/files/file-video') {
        if (init?.method === 'DELETE') {
          deletes.push(url)
          return new Response(null, { status: 204 })
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              downloadController = controller
              controller.enqueue(encoder.encode('vide'))
            },
          }),
          {
            headers: {
              'content-disposition': 'attachment; filename="demo.mp4"',
              'content-length': '8',
              'content-type': 'video/mp4',
            },
          }
        )
      }
      throw new Error(`Unexpected fetch in file download progress test: ${url}`)
    })

    const view = render(<App />)
    let unmounted = false

    try {
      fireEvent.click(await screen.findByRole('button', { name: '文件' }))
      fireEvent.click(await screen.findByRole('button', { name: '下载' }))

      expect(await screen.findByText('正在下载 demo.mp4 · 4 B / 8 B · 50%')).toBeInTheDocument()

      await act(async () => {
        downloadController?.enqueue(encoder.encode('done'))
        downloadController?.close()
      })

      await waitFor(() => {
        expect(screen.queryByText(/下载完成 demo\.mp4/u)).not.toBeInTheDocument()
      })
      expect(await screen.findByText('备用下载链接')).toBeInTheDocument()
      fireEvent.click(await screen.findByRole('button', { name: 'Agent' }))
      fireEvent.click(await screen.findByRole('button', { name: '文件' }))
      expect(screen.queryByText(/下载完成 demo\.mp4/u)).not.toBeInTheDocument()
      expect(screen.queryByText(/正在下载 demo\.mp4/u)).not.toBeInTheDocument()
      expect(createObjectUrl).toHaveBeenCalledTimes(1)
      expect(clickAnchor).toHaveBeenCalled()
      expect(deletes).toEqual(['/api/mobile/files/file-video'])
      expect(document.body.textContent).not.toContain('C:/work/files-lab/dist/demo.mp4')

      view.unmount()
      unmounted = true
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:yive-download-progress')
    } finally {
      if (!unmounted) view.unmount()
      if (originalCreateObjectUrl) {
        Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl)
      } else {
        delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
      }
      if (originalRevokeObjectUrl) {
        Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl)
      } else {
        delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
      }
    }
  })

  test('/mobile saves file downloads through the Android app bridge when available', async () => {
    window.history.pushState({}, '', '/mobile')
    const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const createObjectUrl = vi.fn().mockReturnValue('blob:should-not-be-used')
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    })
    const saveFile = vi.fn(() => '文件已保存到 Downloads/Yive/demo.mp4')
    Object.defineProperty(window, 'YiveAndroid', {
      configurable: true,
      value: { saveFile },
    })
    const deletes: Array<string> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Files Lab', path: 'C:/work/files-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') {
        return json([
          {
            created_at: 1,
            id: 'file-video',
            local_path: 'C:/work/files-lab/dist/demo.mp4',
            mime_type: 'video/mp4',
            name: 'demo.mp4',
            size: 5,
            source: 'workspace',
            workspace_path: 'dist/demo.mp4',
          },
        ])
      }
      if (url === '/api/mobile/files/file-video') {
        if (init?.method === 'DELETE') {
          deletes.push(url)
          return new Response(null, { status: 204 })
        }
        return new Response('video', {
          headers: {
            'content-disposition': 'attachment; filename="demo.mp4"',
            'content-type': 'video/mp4',
          },
        })
      }
      throw new Error(`Unexpected fetch in Android file save test: ${url}`)
    })

    try {
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: '文件' }))
      fireEvent.click(await screen.findByRole('button', { name: '下载' }))

      expect(
        await screen.findByText('文件已保存到 Downloads/Yive/demo.mp4 已从文件交换区移除。')
      ).toBeInTheDocument()
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledWith('demo.mp4', 'video/mp4', 'dmlkZW8=')
      })
      expect(deletes).toEqual(['/api/mobile/files/file-video'])
      expect(createObjectUrl).not.toHaveBeenCalled()
      expect(screen.queryByText('备用下载链接')).not.toBeInTheDocument()
      expect(document.body.textContent).not.toContain('C:/work/files-lab/dist/demo.mp4')
    } finally {
      delete (window as typeof window & { YiveAndroid?: unknown }).YiveAndroid
      if (originalCreateObjectUrl) {
        Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl)
      } else {
        delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
      }
    }
  })

  test('/mobile can retry a failed file download without leaking local paths', async () => {
    window.history.pushState({}, '', '/mobile')
    const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    const createObjectUrl = vi.fn().mockReturnValueOnce('blob:yive-retry-fallback')
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectUrl,
    })
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    let downloadAttempts = 0
    const deletes: Array<string> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Retry Files Lab', path: 'C:/work/files-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') {
        return json([
          {
            created_at: 1,
            id: 'file-video',
            local_path: 'C:/work/files-lab/dist/demo.mp4',
            mime_type: 'video/mp4',
            name: 'demo.mp4',
            size: 12,
            source: 'workspace',
            workspace_path: 'dist/demo.mp4',
          },
        ])
      }
      if (url === '/api/mobile/files/file-video') {
        if (init?.method === 'DELETE') {
          deletes.push(url)
          return new Response(null, { status: 204 })
        }
        downloadAttempts += 1
        if (downloadAttempts === 1) {
          return new Response(JSON.stringify({ error: 'temporary relay failure' }), {
            headers: { 'content-type': 'application/json' },
            status: 502,
          })
        }
        return new Response('video', {
          headers: {
            'content-disposition': 'attachment; filename="demo.mp4"',
            'content-type': 'video/mp4',
          },
        })
      }
      throw new Error(`Unexpected fetch in file download retry test: ${url}`)
    })

    const view = render(<App />)
    let unmounted = false

    try {
      fireEvent.click(await screen.findByRole('button', { name: '文件' }))
      fireEvent.click(await screen.findByRole('button', { name: '下载' }))

      expect(await screen.findByText('demo.mp4 下载失败')).toBeInTheDocument()
      expect(await screen.findByRole('button', { name: '重试下载' })).toBeInTheDocument()
      expect(document.body.textContent).not.toContain('C:/work/files-lab/dist/demo.mp4')

      fireEvent.click(screen.getByRole('button', { name: '重试下载' }))

      expect(await screen.findByText('备用下载链接')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '重试下载' })).not.toBeInTheDocument()
      expect(downloadAttempts).toBe(2)
      expect(createObjectUrl).toHaveBeenCalledTimes(1)
      expect(clickAnchor).toHaveBeenCalled()
      expect(deletes).toEqual(['/api/mobile/files/file-video'])

      view.unmount()
      unmounted = true
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:yive-retry-fallback')
    } finally {
      if (!unmounted) view.unmount()
      if (originalCreateObjectUrl) {
        Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl)
      } else {
        delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
      }
      if (originalRevokeObjectUrl) {
        Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl)
      } else {
        delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
      }
    }
  })

  test('/mobile marks expired exchange files and disables stale downloads', async () => {
    window.history.pushState({}, '', '/mobile')
    const now = 1_780_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const calls: Array<{ url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ url })
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Expired Files Lab', path: 'C:/work/files-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') {
        return json([
          {
            created_at: 1,
            expires_at: now - 60_000,
            id: 'file-expired',
            local_path: 'C:/work/files-lab/dist/expired.mp4',
            mime_type: 'video/mp4',
            name: 'expired.mp4',
            size: 12,
            source: 'workspace',
            workspace_path: 'dist/expired.mp4',
          },
          {
            created_at: 2,
            expires_at: now + 10 * 60_000,
            id: 'file-soon',
            mime_type: 'application/pdf',
            name: 'soon.pdf',
            size: 24,
            source: 'workspace',
            workspace_path: 'docs/soon.pdf',
          },
        ])
      }
      throw new Error(`Unexpected fetch in expired file exchange test: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '文件' }))

    expect(await screen.findByText('expired.mp4')).toBeInTheDocument()
    expect(screen.getAllByText(/已过期/).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/10 分钟后过期/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已过期' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下载' })).not.toBeDisabled()
    const expiredItem = document.querySelector('[data-expiry="expired"]')
    expect(expiredItem).not.toBeNull()
    expect(document.querySelector('[data-expiry="soon"]')).not.toBeNull()
    expect(expiredItem?.textContent).not.toContain('C:/work/files-lab')

    fireEvent.click(screen.getByRole('button', { name: '已过期' }))
    expect(calls.some((call) => call.url === '/api/mobile/files/file-expired')).toBe(false)
  })

  test('/mobile disables file exchange actions while the browser is offline', async () => {
    window.history.pushState({}, '', '/mobile')
    let browserOnline = true
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => browserOnline)
    const calls: Array<{ method?: string; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ method: init?.method, url })
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Offline Files Lab', path: 'C:/work/files-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') {
        return json([
          {
            created_at: 1,
            id: 'file-1',
            mime_type: 'video/mp4',
            name: 'demo.mp4',
            size: 12,
          },
        ])
      }
      throw new Error(`Unexpected fetch while offline file exchange test: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '文件' }))
    expect(await screen.findByText('demo.mp4')).toBeInTheDocument()

    browserOnline = false
    fireEvent(window, new Event('offline'))

    expect(
      await screen.findByText('浏览器当前离线，文件交换操作会在网络恢复后重新启用。')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '清空' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下载' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '删除' })).toBeDisabled()
    expect(screen.getByLabelText('发送工作区文件到手机')).toBeDisabled()
    expect(document.querySelector('.mobile-file-upload input')).toBeDisabled()

    expect(
      calls.filter(
        (call) =>
          (call.url === '/api/mobile/files' && call.method === 'POST') ||
          call.url === '/api/mobile/files/from-workspace' ||
          call.url === '/api/mobile/files/file-1'
      )
    ).toHaveLength(0)
  })

  test('/mobile sends a workspace file path to the phone exchange list', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: Array<{ body?: unknown; headers?: HeadersInit; method?: string; url: string }> = []
    let files = [
      {
        created_at: 1,
        id: 'file-existing',
        mime_type: 'text/markdown',
        name: 'notes.md',
        size: 5,
        source: 'uploaded',
      },
    ]
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ body: init?.body, headers: init?.headers, method: init?.method, url })
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Files Lab', path: 'C:/work/files-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files/from-workspace' && init?.method === 'POST') {
        files = [
          ...files,
          {
            created_at: 2,
            id: 'file-log',
            mime_type: 'text/plain',
            name: 'run.log',
            size: 1024,
            source: 'workspace',
            workspace_path: 'logs/run.log',
          },
        ]
        return {
          ok: true,
          status: 201,
          json: async () => files[files.length - 1],
        } as Response
      }
      if (url === '/api/mobile/files') return json(files)
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '文件' }))
    const pathInput = await screen.findByLabelText('发送工作区文件到手机')
    fireEvent.change(pathInput, { target: { value: 'logs/run.log' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    await screen.findByText('工作区文件已发送到手机')
    expect(await screen.findByText('run.log')).toBeInTheDocument()
    const workspaceFileSource = screen.getByText(/来自工作区 logs\/run\.log/)
    expect(workspaceFileSource).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '下载' }).at(-1)).toBeInTheDocument()

    const sendCall = calls.find((call) => call.url === '/api/mobile/files/from-workspace')
    expect(sendCall).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ path: 'logs/run.log', workspace_id: 'workspace-1' }),
        method: 'POST',
      })
    )
    expect(document.body.textContent).not.toContain('local_path')
    expect(document.body.textContent).not.toContain('content_base64')
    expect(workspaceFileSource.textContent).not.toContain('C:/work/files-lab')
  })

  test('/mobile disables file exchange controls while sending a workspace file', async () => {
    window.history.pushState({}, '', '/mobile')
    let resolveSend!: (response: Response) => void
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Slow Files Lab', path: 'C:/work/slow-files' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files/from-workspace') {
        return new Promise<Response>((resolve) => {
          resolveSend = resolve
        })
      }
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '文件' }))
    fireEvent.change(await screen.findByLabelText('发送工作区文件到手机'), {
      target: { value: 'dist/demo.mp4' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(await screen.findByText('正在发送工作区文件...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送中...' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '清空' })).toBeDisabled()
    expect(document.querySelector('.mobile-file-upload input')).toBeDisabled()

    resolveSend(
      json({
        created_at: 2,
        id: 'file-video',
        mime_type: 'video/mp4',
        name: 'demo.mp4',
        size: 1024,
      })
    )

    expect(await screen.findByText('工作区文件已发送到手机')).toBeInTheDocument()
  })

  test('/mobile keeps a sent workspace file visible when the exchange list refresh fails', async () => {
    window.history.pushState({}, '', '/mobile')
    let fileListLoads = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Weak Files Lab', path: 'C:/work/weak-files' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files/from-workspace' && init?.method === 'POST') {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            created_at: 2,
            id: 'file-video',
            mime_type: 'video/mp4',
            name: 'demo.mp4',
            size: 1024,
            source: 'workspace',
            workspace_path: 'dist/demo.mp4',
          }),
        } as Response
      }
      if (url === '/api/mobile/files') {
        fileListLoads += 1
        if (fileListLoads > 1) throw new TypeError('Failed to fetch')
        return json([])
      }
      throw new Error(`Unexpected fetch in weak file exchange refresh test: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '文件' }))
    fireEvent.change(await screen.findByLabelText('发送工作区文件到手机'), {
      target: { value: 'dist/demo.mp4' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(
      await screen.findByText(/工作区文件已发送到手机，但刷新文件列表失败/u)
    ).toBeInTheDocument()
    expect(await screen.findByText('demo.mp4')).toBeInTheDocument()
    expect(screen.getByText(/来自工作区 dist\/demo\.mp4/)).toBeInTheDocument()
  })

  test('/mobile disables file exchange controls while uploading a local file', async () => {
    window.history.pushState({}, '', '/mobile')
    let resolveUpload: ((response: Response) => void) | undefined
    let files: Array<{
      created_at: number
      id: string
      mime_type: string
      name: string
      size: number
    }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Slow Upload Lab', path: 'C:/work/upload' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files' && init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          resolveUpload = resolve
        })
      }
      if (url === '/api/mobile/files') return json(files)
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '文件' }))
    const input = document.querySelector('.mobile-file-upload input') as HTMLInputElement
    expect(input).not.toBeNull()
    fireEvent.change(input, {
      target: {
        files: [new File(['video'], 'demo.mp4', { type: 'video/mp4' })],
      },
    })

    expect(await screen.findByText('正在上传文件...')).toBeInTheDocument()
    expect(screen.getByText('上传中...')).toBeInTheDocument()
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    await waitFor(() => expect(resolveUpload).toBeTypeOf('function'))

    files = [
      {
        created_at: 2,
        id: 'file-uploaded',
        mime_type: 'video/mp4',
        name: 'demo.mp4',
        size: 5,
      },
    ]
    resolveUpload?.(json(files[0]))

    expect(await screen.findByText('文件已上传')).toBeInTheDocument()
    expect(await screen.findByText('demo.mp4')).toBeInTheDocument()
  })

  test('/mobile drops a cached Tasks tab selection and does not request Tasks APIs', async () => {
    window.history.pushState({}, '', '/mobile')
    window.localStorage.setItem('yive.mobile.activeTab', 'tasks')
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Dispatch Lab', path: 'C:/work/dispatch-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      if (url.startsWith('/api/mobile/dispatches?')) return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    expect(await screen.findByRole('button', { name: 'Agent' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.queryByRole('button', { name: '任务' })).toBeNull()
    expect(calls.some((url) => url.includes('/tasks'))).toBe(false)
  })

  test('/mobile can report, cancel, and replace dispatches from the dispatches tab', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: Array<{ body?: Record<string, unknown>; url: string }> = []
    let dispatches = [
      {
        artifacts: [],
        created_at: 1,
        delivered_at: null,
        from_agent_id: 'workspace-1:orchestrator',
        id: 'dispatch-report',
        reported_at: null,
        report_text: null,
        state: 'submitted',
        submitted_at: 2,
        text: 'Report this dispatch from phone.',
        to_agent_id: 'worker-1',
        workspace_id: 'workspace-1',
      },
      {
        artifacts: [],
        created_at: 5,
        delivered_at: 5,
        from_agent_id: 'workspace-1:orchestrator',
        id: 'dispatch-blocked',
        lifecycle: {
          attempts: 2,
          error: 'Provider remained busy after two interruption attempts',
          kind: 'cancel',
          request_id: 'cancel-blocked',
          state: 'blocked',
          updated_at: 6,
        },
        reported_at: null,
        report_text: null,
        state: 'submitted',
        submitted_at: 5,
        text: 'Blocked cancellation remains active.',
        to_agent_id: 'worker-1',
        workspace_id: 'workspace-1',
      },
      {
        artifacts: [],
        created_at: 4,
        delivered_at: null,
        from_agent_id: 'workspace-1:orchestrator',
        id: 'dispatch-replace',
        reported_at: null,
        report_text: null,
        state: 'queued',
        submitted_at: null,
        text: 'Replace this queued dispatch from phone.',
        to_agent_id: 'worker-1',
        workspace_id: 'workspace-1',
      },
      {
        artifacts: [],
        created_at: 3,
        delivered_at: null,
        from_agent_id: 'workspace-1:orchestrator',
        id: 'dispatch-cancel',
        reported_at: null,
        report_text: null,
        state: 'queued',
        submitted_at: null,
        text: 'Cancel this dispatch from phone.',
        to_agent_id: 'worker-1',
        workspace_id: 'workspace-1',
      },
    ]
    let noteAttempts = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      calls.push({ body, url })
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Dispatch Tasks', path: 'C:/work/dispatch-tasks' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([workerPayload()])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      if (url.startsWith('/api/mobile/dispatches?')) return json(dispatches)
      if (url === '/api/mobile/confirmations') return json({ nonce: 'nonce-cancel' })
      if (url === '/api/mobile/actions') {
        if (body.kind === 'team_note') {
          noteAttempts += 1
          if (noteAttempts === 1) throw new Error('accepted response was lost')
        }
        if (body.kind === 'team_report') {
          dispatches = dispatches.map((dispatch) =>
            dispatch.id === 'dispatch-report'
              ? {
                  ...dispatch,
                  report_outcome: 'completed',
                  report_text: '手机端汇报完成。',
                  state: 'reported',
                }
              : dispatch
          )
        }
        if (body.kind === 'team_cancel') {
          dispatches = dispatches.map((dispatch) =>
            dispatch.id === 'dispatch-cancel'
              ? { ...dispatch, report_text: '手机端取消。', state: 'cancelled' }
              : dispatch
          )
        }
        if (body.kind === 'team_replace') {
          dispatches = dispatches.flatMap((dispatch) =>
            dispatch.id === 'dispatch-replace'
              ? [
                  {
                    ...dispatch,
                    replaced_by: 'dispatch-replacement',
                    state: 'replaced',
                  },
                  {
                    ...dispatch,
                    id: 'dispatch-replacement',
                    replaces_dispatch_id: dispatch.id,
                    state: 'queued',
                    text: 'Corrected queued dispatch from phone.',
                  },
                ]
              : [dispatch]
          )
        }
        return json({
          ok: true,
          result: {
            ...(body.kind === 'team_note' ? { delivery_state: 'queued' } : {}),
            dispatch_id:
              body.kind === 'team_report'
                ? 'dispatch-report'
                : body.kind === 'team_note'
                  ? 'dispatch-report'
                  : body.kind === 'team_replace'
                    ? 'dispatch-replacement'
                    : 'dispatch-cancel',
            ...(body.kind === 'team_replace' ? { replaced_dispatch_id: 'dispatch-replace' } : {}),
          },
        })
      }
      throw new Error(`Unexpected fetch in mobile dispatch management: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '派单' }))
    expect(await screen.findByText('Report this dispatch from phone.')).toBeInTheDocument()
    const reportCard = screen
      .getByText('Report this dispatch from phone.')
      .closest('.mobile-dispatch-item')
    expect(reportCard).not.toBeNull()
    const cancelCard = screen
      .getByText('Cancel this dispatch from phone.')
      .closest('.mobile-dispatch-item')
    expect(cancelCard).not.toBeNull()
    const replaceCard = screen
      .getByText('Replace this queued dispatch from phone.')
      .closest('.mobile-dispatch-item')
    expect(replaceCard).not.toBeNull()
    expect(screen.getByText('取消受阻')).toBeVisible()
    expect(screen.getByText('Provider remained busy after two interruption attempts')).toBeVisible()
    expect(within(reportCard as HTMLElement).getByLabelText('中断当前回合')).toBeVisible()
    expect(
      within(reportCard as HTMLElement).getByRole('button', { name: '发送补充' })
    ).toBeVisible()
    expect(
      within(cancelCard as HTMLElement).getByRole('button', { name: '发送补充' })
    ).toBeVisible()
    fireEvent.change(within(reportCard as HTMLElement).getByLabelText('补充说明'), {
      target: { value: '手机端补充上下文。' },
    })
    fireEvent.click(within(reportCard as HTMLElement).getByRole('button', { name: '发送补充' }))

    expect(await screen.findByText('accepted response was lost')).toBeVisible()
    fireEvent.click(within(reportCard as HTMLElement).getByRole('button', { name: '发送补充' }))
    await waitFor(() =>
      expect(calls.filter((call) => call.body?.kind === 'team_note')).toHaveLength(2)
    )
    const noteRequests = calls.filter((call) => call.body?.kind === 'team_note')
    const noteRequest = noteRequests[1]?.body
    expect(noteRequest).toMatchObject({
      payload: { text: '手机端补充上下文。' },
      target: { dispatch_id: 'dispatch-report' },
    })
    expect(noteRequests[0]?.body?.action_id).toBe(noteRequests[1]?.body?.action_id)
    expect(await screen.findByText('补充说明已排队，等待安全边界')).toBeVisible()
    fireEvent.change(within(reportCard as HTMLElement).getByLabelText('进度状态'), {
      target: { value: '手机端正在处理。' },
    })
    fireEvent.click(within(reportCard as HTMLElement).getByRole('button', { name: '发送进度' }))

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url === '/api/mobile/actions' &&
            call.body?.kind === 'team_status' &&
            JSON.stringify(call.body).includes('手机端正在处理。')
        )
      ).toBe(true)
    )
    const statusRequest = calls.find((call) => call.body?.kind === 'team_status')?.body
    expect(statusRequest).toMatchObject({
      payload: { text: '手机端正在处理。' },
      target: { agent_id: 'worker-1' },
    })
    expect(JSON.stringify(statusRequest)).not.toContain('dispatch_id')

    fireEvent.change(within(reportCard as HTMLElement).getByLabelText('汇报内容'), {
      target: { value: '手机端汇报完成。' },
    })
    fireEvent.click(within(reportCard as HTMLElement).getByRole('button', { name: '提交汇报' }))

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url === '/api/mobile/actions' &&
            call.body?.kind === 'team_report' &&
            JSON.stringify(call.body).includes('手机端汇报完成。')
        )
      ).toBe(true)
    )
    const reportRequest = calls.find((call) => call.body?.kind === 'team_report')?.body
    expect(reportRequest).toMatchObject({
      payload: { text: '手机端汇报完成。' },
      target: { agent_id: 'worker-1' },
    })
    expect(JSON.stringify(reportRequest)).not.toContain('dispatch_id')
    expect(JSON.stringify(reportRequest)).not.toContain('"status"')
    const completedResult = await screen.findByText('手机端汇报完成。')
    expect(completedResult).toBeInTheDocument()
    expect(
      within(completedResult.closest('.mobile-dispatch-item') as HTMLElement).getByText('已完成')
    ).toBeVisible()
    expect(
      within(completedResult.closest('.mobile-dispatch-item') as HTMLElement).queryByRole(
        'button',
        { name: '发送补充' }
      )
    ).toBeNull()

    expect(within(cancelCard as HTMLElement).queryByRole('button', { name: '发送进度' })).toBeNull()
    expect(within(cancelCard as HTMLElement).queryByRole('button', { name: '提交汇报' })).toBeNull()
    fireEvent.change(within(cancelCard as HTMLElement).getByLabelText('取消原因'), {
      target: { value: '手机端取消。' },
    })
    fireEvent.click(within(cancelCard as HTMLElement).getByRole('button', { name: '取消派单' }))

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url === '/api/mobile/actions' &&
            call.body?.kind === 'team_cancel' &&
            JSON.stringify(call.body).includes('nonce-cancel')
        )
      ).toBe(true)
    )
    expect(await screen.findByText('手机端取消。')).toBeInTheDocument()
    expect(within(cancelCard as HTMLElement).queryByRole('button', { name: '发送补充' })).toBeNull()

    fireEvent.change(within(replaceCard as HTMLElement).getByLabelText('替换任务'), {
      target: { value: 'Corrected queued dispatch from phone.' },
    })
    fireEvent.click(within(replaceCard as HTMLElement).getByRole('button', { name: '替换派单' }))
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url === '/api/mobile/actions' &&
            call.body?.kind === 'team_replace' &&
            JSON.stringify(call.body).includes('Corrected queued dispatch from phone.')
        )
      ).toBe(true)
    )
    const replacementRequest = calls.find(
      (call) => call.url === '/api/mobile/actions' && call.body?.kind === 'team_replace'
    )?.body
    expect(replacementRequest).toMatchObject({
      payload: {
        confirmation_nonce: 'nonce-cancel',
        text: 'Corrected queued dispatch from phone.',
      },
      target: { dispatch_id: 'dispatch-replace' },
    })
    expect(await screen.findByText('Corrected queued dispatch from phone.')).toBeVisible()
    expect(within(replaceCard as HTMLElement).getByText('已替换')).toBeVisible()
    expect(
      within(replaceCard as HTMLElement).queryByRole('button', { name: '发送补充' })
    ).toBeNull()
    expect(calls.some((call) => call.url === '/api/mobile/confirmations')).toBe(true)
    expect(JSON.stringify(calls)).not.toContain('agent_token')
    expect(JSON.stringify(calls)).not.toContain('HIVE_AGENT_TOKEN')
  })

  test('/mobile rejects oversized exchange content and pasted files without leaking tokens', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: Array<{ body?: unknown; headers?: HeadersInit; method?: string; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ body: init?.body, headers: init?.headers, method: init?.method, url })
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Image Upload Lab', path: 'C:/work/upload-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const view = render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '文件' }))

    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    expect(input?.getAttribute('accept')).toContain('.png')

    const oversizedVideo = new File(['video'], 'large.mp4', { type: 'video/mp4' })
    Object.defineProperty(oversizedVideo, 'size', {
      configurable: true,
      value: 100 * 1024 * 1024 + 1,
    })
    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [oversizedVideo],
      },
    })

    const exchange = view.container.querySelector('.mobile-file-exchange')
    expect(exchange).not.toBeNull()
    fireEvent.paste(exchange as Element, {
      clipboardData: {
        files: [new File(['fake'], 'paste.png', { type: 'image/png' })],
        getData: () => 'HIVE_AGENT_TOKEN=C:/Users/example/projects/yive/.env',
      },
    })

    expect(
      calls.filter((call) => call.url === '/api/mobile/files' && call.method === 'POST')
    ).toHaveLength(0)
    for (const call of calls) {
      expect(stringifyCall(call)).not.toContain('HIVE_AGENT_TOKEN')
      expect(stringifyCall(call)).not.toContain('x-hive-agent-token')
      expect(stringifyCall(call)).not.toContain('agent_token')
      expect(stringifyCall(call)).not.toContain('C:/Users/example/projects/yive/.env')
    }
    expect(document.body.textContent).not.toContain('HIVE_AGENT_TOKEN')
    expect(document.body.textContent).not.toContain('x-hive-agent-token')
    expect(document.body.textContent).not.toContain('agent_token')
    expect(document.body.textContent).not.toContain('C:/Users/example/projects/yive/.env')
  })

  test('/mobile rejects unsupported exchange files before upload', async () => {
    window.history.pushState({}, '', '/mobile')
    const calls: Array<{ method?: string; url: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ method: init?.method, url })
      if (url === '/api/ui/session') return json({ ok: true })
      if (url === '/api/workspaces') {
        return json([{ id: 'workspace-1', name: 'Upload Lab', path: 'C:/work/upload-lab' }])
      }
      if (url === '/api/ui/workspaces/workspace-1/team') return json([])
      if (url === '/api/ui/workspaces/workspace-1/runs') return json([])
      if (url === '/api/mobile/files') return json([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '文件' }))

    const input = document.querySelector('.mobile-file-upload input') as HTMLInputElement
    expect(input).not.toBeNull()
    fireEvent.change(input, {
      target: {
        files: [new File(['bad'], 'bad.exe', { type: 'application/octet-stream' })],
      },
    })

    expect(await screen.findByText(/仅支持 .*zip.*webp/)).toBeInTheDocument()
    expect(
      calls.filter((call) => call.url === '/api/mobile/files' && call.method === 'POST')
    ).toHaveLength(0)
  })
})
