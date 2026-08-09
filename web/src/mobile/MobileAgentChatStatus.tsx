import type { AgentProcessState, MobileConversationPage } from '../../../src/shared/types.js'

export type MobileAgentChatConnection = {
  onRetry?: (() => void) | undefined
  retryDisabled: boolean
  tone: 'error' | 'ok' | 'warn'
  warning: string | null
}

export const MobileAgentChatConnectionStatus = ({
  connection,
}: {
  connection: MobileAgentChatConnection
}) =>
  connection.warning ? (
    <div className="mobile-agent-chat__connection" data-tone={connection.tone} role="status">
      <span>{connection.warning}</span>
      {connection.onRetry ? (
        <button
          className="mobile-text-button"
          disabled={connection.retryDisabled}
          onClick={connection.onRetry}
          type="button"
        >
          重试连接
        </button>
      ) : null}
    </div>
  ) : null

export const MobileAgentChatAvailability = ({
  processState,
  conversation,
  error,
  loading,
  onLoadHistory,
  onOpenTerminal,
  onReload,
  selectedHistorical,
  supportsLiveChat,
}: {
  processState: AgentProcessState
  conversation: MobileConversationPage | null
  error: string | null
  loading: boolean
  onLoadHistory: () => void
  onOpenTerminal: () => void
  onReload: () => void
  selectedHistorical: boolean
  supportsLiveChat: boolean
}) => (
  <>
    {selectedHistorical ? (
      <p className="mobile-agent-chat__state" role="status">
        历史会话为只读记录。
      </p>
    ) : null}
    {conversation?.stale ? (
      <div className="mobile-agent-chat__state" role="status">
        <p>对话来源暂时不可用，正在显示上次已验证的内容；不会自动发送任何消息。</p>
        <button className="mobile-text-button" onClick={onReload} type="button">
          重新检查来源
        </button>
      </div>
    ) : null}
    {conversation && processState !== 'running' && !selectedHistorical ? (
      <div className="mobile-agent-chat__state" role="status">
        <p>
          Agent {processState === 'crashed' ? '已崩溃' : '已停止'}
          ；当前记录为只读，重新启动前不会发送排队内容。
        </p>
        <button className="mobile-text-button" onClick={onOpenTerminal} type="button">
          前往终端启动
        </button>
      </div>
    ) : null}
    {loading ? <p className="mobile-agent-chat__state">正在读取当前对话...</p> : null}
    {error ? (
      <div className="mobile-agent-chat__state" role="alert">
        <p>{error}</p>
        <button className="mobile-text-button" onClick={onReload} type="button">
          重试
        </button>
      </div>
    ) : null}
    {!loading && !error && !conversation && !supportsLiveChat ? (
      <div className="mobile-agent-chat__state">
        <p>
          此 CLI 暂不支持聊天气泡。Yive
          不会猜测终端输出；你仍可查看已记录的只读历史，或打开原始终端。
        </p>
        <div className="mobile-agent-chat__state-actions">
          <button className="mobile-text-button" onClick={onLoadHistory} type="button">
            查看历史
          </button>
          <button className="mobile-primary-button" onClick={onOpenTerminal} type="button">
            打开原始终端
          </button>
        </div>
      </div>
    ) : null}
    {!loading && !error && !conversation && supportsLiveChat && processState !== 'running' ? (
      <div className="mobile-agent-chat__state">
        <p>
          Agent {processState === 'crashed' ? '已崩溃' : '已停止'}
          ，当前没有可继续的活跃会话。Yive 不会自动恢复或发送内容。
        </p>
        <button className="mobile-primary-button" onClick={onOpenTerminal} type="button">
          前往终端启动
        </button>
      </div>
    ) : null}
    {!loading && !error && !conversation && supportsLiveChat && processState === 'running' ? (
      <div className="mobile-agent-chat__state">
        <p>当前还没有可验证的 Codex 或 Claude Code 对话。Yive 会从首次观察之后开始记录。</p>
        <button className="mobile-primary-button" onClick={onOpenTerminal} type="button">
          打开终端
        </button>
      </div>
    ) : null}
    {!loading && !error && conversation?.turns.length === 0 ? (
      <p className="mobile-agent-chat__state">已从现在开始记录，等待新的对话内容。</p>
    ) : null}
  </>
)
