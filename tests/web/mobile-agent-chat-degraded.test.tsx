// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { MobileAgentChat } from '../../web/src/mobile/MobileAgentChat.js'
import type { MobileRuntimeClient } from '../../web/src/mobile/mobile-runtime-client.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
  window.history.replaceState({}, '', '/mobile')
})

describe('mobile Agent Chat degraded states', () => {
  test('enables Chat for a supported Agent with a verified conversation Provider', async () => {
    const getCurrentConversation = vi.fn().mockResolvedValue({
      activity_state: 'idle',
      agent_id: 'agent-1',
      cli_session_id: 'session-1',
      cursor: 0,
      id: 'conversation-1',
      provider: 'codex',
      recording_boundary: 0,
      source_checkpoint: 0,
      submissions: [],
      tool_activity: [],
      turns: [],
      workspace_id: 'workspace-1',
    })
    const runtimeClient = {
      getCurrentConversation,
      listRecordedConversations: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    } as unknown as MobileRuntimeClient

    render(
      <MobileAgentChat
        agent={{
          activeDispatchId: null,
          conversationActivity: 'idle',
          conversationProvider: 'codex',
          id: 'agent-1',
          kind: 'worker',
          lastObservedAt: 1,
          name: 'Codex',
          processState: 'running',
          queuePauseReason: null,
          queuedDispatchCount: 0,
          runStatus: 'running',
        }}
        connection={{ retryDisabled: false, tone: 'ok', warning: null }}
        onBack={vi.fn()}
        onOpenTerminal={vi.fn()}
        runtimeClient={runtimeClient}
        workspaceId="workspace-1"
      />
    )

    expect(await screen.findByRole('textbox')).toBeInTheDocument()
    expect(getCurrentConversation).toHaveBeenCalledWith('workspace-1', 'agent-1')
  })

  test('explains that a stopped supported Agent will not resume or send automatically', async () => {
    const runtimeClient = {
      getCurrentConversation: vi.fn().mockResolvedValue(null),
    } as unknown as MobileRuntimeClient
    render(
      <MobileAgentChat
        agent={{
          activeDispatchId: null,
          conversationActivity: 'unknown',
          provider: 'codex',
          conversationProvider: 'codex',
          id: 'agent-1',
          kind: 'worker',
          lastObservedAt: 1,
          name: 'Codex',
          processState: 'stopped',
          queuePauseReason: null,
          queuedDispatchCount: 0,
          runStatus: 'stopped',
        }}
        connection={{ retryDisabled: false, tone: 'ok', warning: null }}
        onBack={vi.fn()}
        onOpenTerminal={vi.fn()}
        runtimeClient={runtimeClient}
        workspaceId="workspace-1"
      />
    )

    await waitFor(() =>
      expect(screen.getByText(/Agent 已停止.*不会自动恢复或发送内容/u)).toBeInTheDocument()
    )
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  test('distinguishes a crashed Agent when no active conversation is available', async () => {
    const runtimeClient = {
      getCurrentConversation: vi.fn().mockResolvedValue(null),
    } as unknown as MobileRuntimeClient
    render(
      <MobileAgentChat
        agent={{
          activeDispatchId: 'dispatch-1',
          conversationActivity: 'unknown',
          provider: 'codex',
          conversationProvider: 'codex',
          id: 'agent-1',
          kind: 'worker',
          lastObservedAt: 1,
          name: 'Codex',
          processState: 'crashed',
          queuePauseReason: null,
          queuedDispatchCount: 0,
          runStatus: 'error',
        }}
        connection={{ retryDisabled: false, tone: 'ok', warning: null }}
        onBack={vi.fn()}
        onOpenTerminal={vi.fn()}
        runtimeClient={runtimeClient}
        workspaceId="workspace-1"
      />
    )

    expect(await screen.findByText(/Agent 已崩溃.*不会自动恢复或发送内容/u)).toBeInTheDocument()
    expect(screen.queryByText(/Agent 已停止/u)).not.toBeInTheDocument()
  })

  test('distinguishes a crashed Agent while keeping its recorded conversation read-only', async () => {
    const runtimeClient = {
      getCurrentConversation: vi.fn().mockResolvedValue({
        activity_state: 'unknown',
        agent_id: 'agent-1',
        cli_session_id: 'session-1',
        cursor: 0,
        id: 'conversation-1',
        provider: 'codex',
        recording_boundary: 0,
        source_checkpoint: 0,
        submissions: [],
        tool_activity: [],
        turns: [],
        workspace_id: 'workspace-1',
      }),
      listRecordedConversations: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    } as unknown as MobileRuntimeClient
    render(
      <MobileAgentChat
        agent={{
          activeDispatchId: 'dispatch-1',
          conversationActivity: 'unknown',
          provider: 'codex',
          conversationProvider: 'codex',
          id: 'agent-1',
          kind: 'worker',
          lastObservedAt: 1,
          name: 'Codex',
          processState: 'crashed',
          queuePauseReason: null,
          queuedDispatchCount: 0,
          runStatus: 'error',
        }}
        connection={{ retryDisabled: false, tone: 'ok', warning: null }}
        onBack={vi.fn()}
        onOpenTerminal={vi.fn()}
        runtimeClient={runtimeClient}
        workspaceId="workspace-1"
      />
    )

    expect(await screen.findByText(/Agent 已崩溃；当前记录为只读/u)).toBeInTheDocument()
    expect(screen.queryByText(/Agent 已停止/u)).not.toBeInTheDocument()
  })

  test('shows an actionable offline Runtime state without inventing content', async () => {
    const retry = vi.fn()
    const runtimeClient = {
      getCurrentConversation: vi.fn().mockResolvedValue(null),
    } as unknown as MobileRuntimeClient
    render(
      <MobileAgentChat
        agent={{
          activeDispatchId: null,
          conversationActivity: 'unknown',
          provider: 'codex',
          conversationProvider: 'codex',
          id: 'agent-1',
          kind: 'worker',
          lastObservedAt: 1,
          name: 'Codex',
          processState: 'running',
          queuePauseReason: null,
          queuedDispatchCount: 0,
          runStatus: 'running',
        }}
        connection={{
          onRetry: retry,
          retryDisabled: false,
          tone: 'error',
          warning: 'Runtime offline',
        }}
        onBack={vi.fn()}
        onOpenTerminal={vi.fn()}
        runtimeClient={runtimeClient}
        workspaceId="workspace-1"
      />
    )

    expect(await screen.findByText('Runtime offline')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试连接' }))
    expect(retry).toHaveBeenCalledOnce()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
