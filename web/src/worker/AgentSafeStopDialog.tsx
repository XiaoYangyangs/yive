import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, LoaderCircle, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

export type AgentSafeStopDialogState = {
  agentName: string
  kind: 'checking' | 'confirmation_required' | 'failed' | 'synchronizing'
}

type AgentSafeStopDialogProps = {
  onCancel: () => void
  onCheckpoint: () => void
  onForce: () => void
  state: AgentSafeStopDialogState
}

const isPending = (kind: AgentSafeStopDialogState['kind']) =>
  kind === 'checking' || kind === 'synchronizing'

export const AgentSafeStopDialog = ({
  onCancel,
  onCheckpoint,
  onForce,
  state,
}: AgentSafeStopDialogProps) => {
  const [forceConfirmationState, setForceConfirmationState] =
    useState<AgentSafeStopDialogState | null>(null)
  const forceConfirmation = forceConfirmationState === state

  const pending = isPending(state.kind)
  const title = forceConfirmation
    ? '强制停止可能丢失进度'
    : state.kind === 'confirmation_required'
      ? '最新会话状态尚未持久化'
      : state.kind === 'failed'
        ? '未能安全停止'
        : state.kind === 'synchronizing'
          ? '正在创建恢复点并等待 CLI 完成…'
          : '正在检查最新会话状态…'
  const description = forceConfirmation
    ? `${state.agentName} 尚未提交的终端尾部可能永久丢失，且无法从保存的 CLI 会话精确恢复。`
    : state.kind === 'confirmation_required'
      ? `Yive 无法确认 ${state.agentName} 的最新终端内容已写入原生 CLI 会话。创建恢复点会发送一条可见的最小消息；强制停止可能丢失未提交内容。`
      : state.kind === 'failed'
        ? `${state.agentName} 仍保持运行，最新状态没有被误报为已保存。你可以稍后重试或明确选择强制停止。`
        : state.kind === 'synchronizing'
          ? '已发送可见的恢复点请求。Yive 只会在同一 CLI 会话到达新的完成边界后停止进程。'
          : 'Yive 正在核对同一 CLI 会话的最新完成边界；此步骤不会发送任何消息。'

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !pending) onCancel()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            className="dialog-scale-pop elev-2 pointer-events-auto w-[480px] max-w-[calc(100vw-32px)] rounded-lg border p-5"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
          >
            <div className="flex items-start gap-3">
              <div
                aria-hidden
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded"
                style={{
                  background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
                  color:
                    forceConfirmation || state.kind === 'failed'
                      ? 'var(--status-red)'
                      : 'var(--accent)',
                }}
              >
                {pending ? (
                  <LoaderCircle className="animate-spin" size={18} />
                ) : forceConfirmation || state.kind === 'failed' ? (
                  <AlertTriangle size={18} />
                ) : (
                  <ShieldCheck size={18} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-lg font-semibold text-pri">{title}</Dialog.Title>
                <Dialog.Description className="mt-1.5 text-sm text-sec">
                  {description}
                </Dialog.Description>
              </div>
            </div>

            {!pending ? (
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button className="icon-btn" onClick={onCancel} type="button">
                  {state.kind === 'failed' ? '关闭' : '取消'}
                </button>
                {state.kind === 'confirmation_required' && !forceConfirmation ? (
                  <>
                    <button
                      className="icon-btn icon-btn--danger"
                      onClick={() => setForceConfirmationState(state)}
                      type="button"
                    >
                      强制停止
                    </button>
                    <button
                      className="icon-btn icon-btn--primary"
                      onClick={onCheckpoint}
                      type="button"
                    >
                      创建恢复点并停止
                    </button>
                  </>
                ) : state.kind === 'failed' && !forceConfirmation ? (
                  <button
                    className="icon-btn icon-btn--danger"
                    onClick={() => setForceConfirmationState(state)}
                    type="button"
                  >
                    强制停止
                  </button>
                ) : forceConfirmation ? (
                  <button
                    className="icon-btn icon-btn--danger-solid"
                    onClick={onForce}
                    type="button"
                  >
                    仍然强制停止
                  </button>
                ) : null}
              </div>
            ) : null}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
