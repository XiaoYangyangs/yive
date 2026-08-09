// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { AgentSafeStopDialog } from '../../web/src/worker/AgentSafeStopDialog.js'

afterEach(cleanup)

describe('AgentSafeStopDialog', () => {
  test('offers an explicit checkpoint and requires a second acknowledgement for force stop', () => {
    const onCheckpoint = vi.fn()
    const onForce = vi.fn()
    render(
      <AgentSafeStopDialog
        state={{ agentName: 'Alice', kind: 'confirmation_required' }}
        onCancel={vi.fn()}
        onCheckpoint={onCheckpoint}
        onForce={onForce}
      />
    )

    expect(screen.getByText('最新会话状态尚未持久化')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '创建恢复点并停止' }))
    expect(onCheckpoint).toHaveBeenCalledTimes(1)

    const dialog = within(screen.getAllByRole('dialog').at(-1) as HTMLElement)
    fireEvent.click(dialog.getByRole('button', { name: '强制停止' }))
    expect(dialog.getByText('强制停止可能丢失进度')).toBeInTheDocument()
    expect(onForce).not.toHaveBeenCalled()
    fireEvent.click(dialog.getByRole('button', { name: '仍然强制停止' }))
    expect(onForce).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['checking', '正在检查最新会话状态…'],
    ['synchronizing', '正在创建恢复点并等待 CLI 完成…'],
    ['failed', '未能安全停止'],
  ] as const)('shows the %s safe-stop state', (kind, message) => {
    render(
      <AgentSafeStopDialog
        state={{ agentName: 'Alice', kind }}
        onCancel={vi.fn()}
        onCheckpoint={vi.fn()}
        onForce={vi.fn()}
      />
    )

    expect(screen.getByText(message)).toBeInTheDocument()
  })

  test('keeps force stop available after a safe-stop failure and still requires acknowledgement', () => {
    const onForce = vi.fn()
    render(
      <AgentSafeStopDialog
        state={{ agentName: 'Alice', kind: 'failed' }}
        onCancel={vi.fn()}
        onCheckpoint={vi.fn()}
        onForce={onForce}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '强制停止' }))
    expect(screen.getByText('强制停止可能丢失进度')).toBeInTheDocument()
    expect(onForce).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '仍然强制停止' }))
    expect(onForce).toHaveBeenCalledTimes(1)
  })
})
