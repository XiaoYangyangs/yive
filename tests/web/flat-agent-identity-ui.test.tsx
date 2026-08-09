// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps, FormEvent } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { ToastProvider } from '../../web/src/ui/useToast.js'
import { AddWorkerDialog } from '../../web/src/worker/AddWorkerDialog.js'
import { OrchestratorPane } from '../../web/src/worker/OrchestratorPane.js'
import { WorkerCard } from '../../web/src/worker/WorkerCard.js'

afterEach(() => cleanup())

describe('flat agent identity desktop UI contract', () => {
  test('shows and renames the Orchestrator identity without exposing kind controls', async () => {
    const onRename = vi.fn(async () => ({ error: null }))

    render(
      <OrchestratorPane
        name="Lead Agent"
        onBindCurrentSession={vi.fn()}
        onRemoveWorkspace={vi.fn()}
        onRename={onRename}
        onRestart={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        sessionBinding={false}
        state={{ kind: 'stopped' }}
      />
    )

    expect(screen.getByText('Lead Agent')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Lead Agent' }))
    expect(screen.queryByLabelText(/kind|role/i)).toBeNull()
    fireEvent.change(screen.getByTestId('rename-orchestrator-input'), {
      target: { value: 'Principal Agent' },
    })
    fireEvent.click(screen.getByTestId('rename-orchestrator-save'))

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('Principal Agent'))
  })

  test('renders Worker creation without Role, instructions, or template controls', () => {
    const props = {
      provider: undefined,
      onClose: vi.fn(),
      onNameChange: vi.fn(),
      onProviderChange: vi.fn(),
      onRandomName: vi.fn(),
      onSubmit: (event: FormEvent<HTMLFormElement>) => event.preventDefault(),
      workerName: 'Flat Worker',
    } satisfies ComponentProps<typeof AddWorkerDialog>

    render(
      <ToastProvider>
        <AddWorkerDialog {...props} />
      </ToastProvider>
    )

    expect(screen.getByRole('form', { name: 'Add team member' })).toBeInTheDocument()
    expect(screen.queryByTestId('role-card-coder')).toBeNull()
    expect(screen.queryByTestId('role-card-reviewer')).toBeNull()
    expect(screen.queryByTestId('role-card-tester')).toBeNull()
    expect(screen.queryByTestId('role-card-custom')).toBeNull()
    expect(screen.queryByTestId('role-instructions-textarea')).toBeNull()
    expect(screen.queryByTestId('role-template-picker-trigger')).toBeNull()
    expect(screen.queryByTestId('open-marketplace')).toBeNull()
    expect(screen.getByTestId('agent-radio-inherit')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('agent-radio-codex')).toBeInTheDocument()
    expect(screen.getByTestId('agent-radio-claude')).toBeInTheDocument()
    expect(screen.queryByLabelText(/startup command/i)).toBeNull()
  })

  test('renders a Worker card without a permanent specialist label', () => {
    const worker = {
      activeDispatchId: null,
      conversationActivity: 'idle',
      provider: 'codex',
      id: 'worker-1',
      kind: 'worker',
      lastObservedAt: 1,
      name: 'Flat Worker',
      processState: 'running',
      queuePauseReason: null,
      queuedDispatchCount: 0,
      conversationProvider: 'codex',
    } satisfies ComponentProps<typeof WorkerCard>['worker']

    render(<WorkerCard hasRun onClick={vi.fn()} worker={worker} />)

    const card = screen.getByTestId('worker-card-worker-1')
    expect(within(card).getByText('Flat Worker')).toBeInTheDocument()
    expect(within(card).queryByText(/^(Coder|Reviewer|Tester|Custom)$/i)).toBeNull()
  })
})
