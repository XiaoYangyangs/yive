// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { MobileConversationPage } from '../../src/shared/types.js'
import { MobileAgentChat } from '../../web/src/mobile/MobileAgentChat.js'
import '../../web/src/mobile/MobileApp.css'
import type { MobileRuntimeClient } from '../../web/src/mobile/mobile-runtime-client.js'

afterEach(() => cleanup())

const conversation = (activityState: MobileConversationPage['activity_state']) => ({
  activity_state: activityState,
  agent_id: 'agent-1',
  cli_session_id: 'session-1',
  cursor: 1,
  id: 'conversation-1',
  provider: 'codex' as const,
  recording_boundary: 0,
  source_checkpoint: 1,
  stale: false,
  submissions: [],
  tool_activity: [],
  turns: [
    {
      provider_event_id: 'assistant-1',
      role: 'assistant' as const,
      sequence: 1,
      source_checkpoint: 1,
      text: 'Latest answer',
    },
  ],
  workspace_id: 'workspace-1',
})

const renderChat = (
  conversationActivity: MobileConversationPage['activity_state'],
  agentActivity: MobileConversationPage['activity_state'] = conversationActivity
) => {
  const onOpenTerminal = vi.fn()
  const runtimeClient = {
    getCurrentConversation: vi.fn().mockResolvedValue(conversation(conversationActivity)),
    listRecordedConversations: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
  } as unknown as MobileRuntimeClient

  render(
    <MobileAgentChat
      agent={{
        activeDispatchId: null,
        conversationActivity: agentActivity,
        provider: 'codex',
        conversationProvider: 'codex',
        id: 'agent-1',
        kind: 'worker',
        lastObservedAt: 1,
        name: 'Coder',
        processState: 'running',
        queuePauseReason: null,
        queuedDispatchCount: 0,
        runStatus: 'running',
      }}
      connection={{ retryDisabled: false, tone: 'ok', warning: null }}
      onBack={vi.fn()}
      onOpenTerminal={onOpenTerminal}
      runtimeClient={runtimeClient}
      workspaceId="workspace-1"
    />
  )

  return { onOpenTerminal, runtimeClient }
}

describe('mobile Agent Chat activity', () => {
  test('keeps the latest Agent message dimmed without a working-state accent', async () => {
    renderChat('busy')

    await screen.findByText('Latest answer')
    const bubble = document.querySelector('.mobile-agent-chat__bubble[data-working="true"]')
    expect(bubble).toHaveAttribute('data-working', 'true')
    expect(bubble).toHaveTextContent('Latest answer')
    const style = getComputedStyle(bubble as Element)
    expect(style.opacity).toBe('0.88')
    const workingRule = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .find(
        (rule): rule is CSSStyleRule =>
          'selectorText' in rule &&
          rule.selectorText.startsWith('.mobile-agent-chat__bubble[data-working=')
      )
    expect(workingRule).toBeDefined()
    expect(workingRule?.style.getPropertyValue('border-left')).toBe('')
  })

  test.each([
    ['busy', '工作中'],
    ['idle', '空闲'],
    ['unknown', '状态未知'],
  ] as const)('shows canonical conversation %s state', async (activity, label) => {
    renderChat(activity)

    const indicator = await screen.findByTestId('mobile-agent-chat-activity')
    expect(indicator).toHaveAttribute('data-activity', activity)
    expect(indicator).toHaveTextContent(label)

    if (activity === 'busy') {
      expect(screen.getByTestId('mobile-agent-chat-working-message')).toHaveAccessibleName(
        'Coder 工作中'
      )
      expect(
        screen
          .getByTestId('mobile-agent-chat-working-message')
          .querySelectorAll('.mobile-agent-chat__typing-dots > span')
      ).toHaveLength(3)
    } else {
      expect(screen.queryByTestId('mobile-agent-chat-working-message')).not.toBeInTheDocument()
    }
  })

  test('does not revive stale conversation activity after canonical state becomes unknown', async () => {
    renderChat('idle', 'unknown')

    const indicator = await screen.findByTestId('mobile-agent-chat-activity')
    expect(indicator).toHaveAttribute('data-activity', 'unknown')
    expect(screen.queryByTestId('mobile-agent-chat-working-message')).not.toBeInTheDocument()
  })

  test('centers the identity and keeps history and terminal in the overflow menu', async () => {
    const { onOpenTerminal, runtimeClient } = renderChat('idle')

    await screen.findByTestId('mobile-agent-chat-activity')
    const title = screen.getByRole('heading', { name: 'Coder' })
    expect(title.closest('.mobile-agent-chat__header')).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: '历史' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: '终端' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '打开更多操作' }))
    expect(screen.getByRole('button', { name: '收起更多操作' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    fireEvent.click(screen.getByRole('menuitem', { name: '历史' }))
    await waitFor(() => expect(runtimeClient.listRecordedConversations).toHaveBeenCalledOnce())
    expect(screen.queryByRole('menu', { name: 'Agent 聊天操作' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '打开更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '终端' }))
    expect(onOpenTerminal).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu', { name: 'Agent 聊天操作' })).not.toBeInTheDocument()
  })
})
