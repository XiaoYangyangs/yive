// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'

import { MobileAgentTerminal } from '../../web/src/mobile/MobileAgentTerminal.js'
import type { MobileRuntimeClient } from '../../web/src/mobile/mobile-runtime-client.js'

vi.mock('../../web/src/terminal/TerminalView.js', () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}))

describe('mobile Agent safe stop', () => {
  test('shows a waiting state when the active CLI session is not verified yet', async () => {
    const bindCurrentSession = vi
      .fn()
      .mockResolvedValueOnce({
        agent_id: 'agent-1',
        capture_source: 'codex_session_jsonl_dir',
        failure_reason: null,
        previous_session_id: 'session-old',
        request_id: 'request-1',
        run_id: 'run-1',
        session_id: null,
        state: 'waiting',
        unchanged: false,
      })
      .mockResolvedValue({
        agent_id: 'agent-1',
        capture_source: 'codex_session_jsonl_dir',
        failure_reason: null,
        previous_session_id: 'session-old',
        request_id: 'request-1',
        run_id: 'run-1',
        session_id: 'session-new',
        state: 'saved',
        unchanged: false,
      })
    render(
      <MobileAgentTerminal
        agent={{
          activeDispatchId: null,
          conversationActivity: 'idle',
          id: 'agent-1',
          kind: 'worker',
          lastObservedAt: 1,
          name: 'Alice',
          processState: 'running',
          queuePauseReason: null,
          queuedDispatchCount: 0,
          run: {
            agent_id: 'agent-1',
            agent_name: 'Alice',
            run_id: 'run-1',
            status: 'running',
          },
          runStatus: 'running',
        }}
        connectionTone="ok"
        connectionWarning={null}
        dangerAction={null}
        formatError={(_error, fallback) => fallback}
        message={null}
        onBack={vi.fn()}
        onCancelDanger={vi.fn()}
        onConfirmDanger={vi.fn()}
        onFilesChanged={vi.fn()}
        onRefresh={vi.fn()}
        onRequestForceStop={vi.fn()}
        onRestart={vi.fn()}
        onRetryAgentAction={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onTerminalError={vi.fn()}
        retryAgentActionLabel={null}
        retryConnectionDisabled={false}
        runtimeClient={{ bindCurrentSession } as unknown as MobileRuntimeClient}
        staleRunId={null}
        workspaceId="workspace-1"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '打开 Agent 操作' }))
    fireEvent.click(screen.getAllByRole('menuitem')[1])

    await waitFor(() => {
      expect(screen.getByText('等待 CLI 确认当前会话，确认后会自动保存')).toBeInTheDocument()
    })
    await waitFor(() => expect(bindCurrentSession).toHaveBeenCalledTimes(2), { timeout: 2000 })
    await waitFor(() => expect(screen.getByText(/session-/)).toBeInTheDocument())
    expect(bindCurrentSession).toHaveBeenCalledWith('workspace-1', 'agent-1')
  })

  test('requires a data-loss acknowledgement after choosing force stop', () => {
    const onConfirm = vi.fn()
    const Harness = () => {
      const [dangerAction, setDangerAction] = useState<
        'checkpoint' | 'force' | 'restart' | 'stop' | null
      >('checkpoint')
      return (
        <MobileAgentTerminal
          agent={{
            activeDispatchId: null,
            conversationActivity: 'idle',
            id: 'agent-1',
            kind: 'worker',
            lastObservedAt: 1,
            name: 'Alice',
            processState: 'running',
            queuePauseReason: null,
            queuedDispatchCount: 0,
            runStatus: 'running',
          }}
          connectionTone="ok"
          connectionWarning={null}
          dangerAction={dangerAction}
          formatError={(_error, fallback) => fallback}
          message={null}
          onBack={vi.fn()}
          onCancelDanger={() => setDangerAction(null)}
          onConfirmDanger={onConfirm}
          onFilesChanged={vi.fn()}
          onRefresh={vi.fn()}
          onRequestForceStop={() => setDangerAction('force')}
          onRestart={vi.fn()}
          onRetryAgentAction={vi.fn()}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onTerminalError={vi.fn()}
          retryAgentActionLabel={null}
          retryConnectionDisabled={false}
          runtimeClient={{} as MobileRuntimeClient}
          staleRunId={null}
          workspaceId="workspace-1"
        />
      )
    }
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: '强制停止' }))
    expect(screen.getByText('强制停止可能丢失进度')).toBeInTheDocument()
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '仍然强制停止' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
