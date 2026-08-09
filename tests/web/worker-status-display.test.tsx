// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { TeamListItem } from '../../src/shared/types.js'
import type { TerminalRunSummary } from '../../web/src/api.js'
import { WorkerCard } from '../../web/src/worker/WorkerCard.js'
import { WorkersPane } from '../../web/src/worker/WorkersPane.js'
import { areAllAgentsVerifiedIdle } from '../../web/src/worker/worker-status.js'

afterEach(() => {
  cleanup()
})

const worker = (overrides: Partial<TeamListItem> = {}): TeamListItem => ({
  activeDispatchId: null,
  conversationActivity: 'idle',
  id: 'worker-1',
  kind: 'worker',
  lastObservedAt: Date.UTC(2026, 7, 5, 2, 3, 4),
  name: 'ember-check-23',
  processState: 'running',
  queuePauseReason: null,
  queuedDispatchCount: 0,
  ...overrides,
})

const terminalRun = (agentId: string): TerminalRunSummary => ({
  agent_id: agentId,
  agent_name: agentId,
  run_id: `run-${agentId}`,
  status: 'running',
})

describe('worker status presentation', () => {
  test('requires every Agent to be verified idle before declaring global idle', () => {
    expect(areAllAgentsVerifiedIdle([worker()])).toBe(true)
    expect(areAllAgentsVerifiedIdle([])).toBe(false)
    expect(areAllAgentsVerifiedIdle([worker({ conversationActivity: 'unknown' })])).toBe(false)
    expect(areAllAgentsVerifiedIdle([worker({ processState: 'stopped' })])).toBe(false)
    expect(areAllAgentsVerifiedIdle([worker({ processState: 'crashed' })])).toBe(false)
    expect(areAllAgentsVerifiedIdle([worker({ activeDispatchId: 'dispatch-1' })])).toBe(false)
  })

  test('worker card keeps an idle worker idle even when its PTY is running', () => {
    render(
      <WorkerCard
        hasRun
        onClick={vi.fn()}
        onAction={vi.fn()}
        worker={worker({ id: 'idle-worker' })}
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent('idle')
    expect(screen.getByTestId('worker-card-idle-worker')).toHaveAttribute('data-status', 'idle')
    expect(screen.queryByLabelText('Start ember-check-23')).toBeNull()
  })

  test('workers pane keeps process, conversation, and Dispatch states distinguishable', () => {
    const idleWorker = worker({ id: 'idle-worker', name: 'idle-agent' })
    const activeWorker = worker({
      activeDispatchId: 'dispatch-busy',
      conversationActivity: 'busy',
      id: 'active-worker',
      name: 'active-agent',
    })
    const awaitingWorker = worker({
      activeDispatchId: 'dispatch-awaiting',
      id: 'awaiting-worker',
      name: 'awaiting-agent',
    })
    const unknownWorker = worker({
      conversationActivity: 'unknown',
      id: 'unknown-worker',
      name: 'unknown-agent',
    })
    const crashedWorker = worker({
      activeDispatchId: 'dispatch-crashed',
      conversationActivity: 'unknown',
      id: 'crashed-worker',
      name: 'crashed-agent',
      processState: 'crashed',
    })
    const stoppedWorker = worker({
      id: 'stopped-worker',
      name: 'stopped-agent',
      conversationActivity: 'unknown',
      processState: 'stopped',
    })

    render(
      <WorkersPane
        onAddWorkerClick={vi.fn()}
        onDeleteWorker={vi.fn()}
        onOpenShellTerminal={vi.fn()}
        onOpenWorker={vi.fn()}
        onRenameWorker={vi.fn()}
        onStartWorker={vi.fn()}
        onStopWorker={vi.fn()}
        startingWorkerId={null}
        terminalRuns={[terminalRun(idleWorker.id), terminalRun(activeWorker.id)]}
        workers={[
          idleWorker,
          activeWorker,
          awaitingWorker,
          unknownWorker,
          crashedWorker,
          stoppedWorker,
        ]}
      />
    )

    expect(screen.getByRole('list', { name: 'busy team members' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'awaiting report team members' })).toBeInTheDocument()
    const idleList = screen.getByRole('list', { name: 'idle team members' })
    expect(screen.getByRole('list', { name: 'unknown team members' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'crashed team members' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'stopped team members' })).toBeInTheDocument()

    expect(within(idleList).getByText('idle-agent')).toBeInTheDocument()
    expect(within(idleList).queryByText('active-agent')).toBeNull()
    expect(screen.queryByText(/team --help/iu)).toBeNull()
    expect(screen.queryByText(/Current bounded Runtime Context/iu)).toBeNull()
  })
})
