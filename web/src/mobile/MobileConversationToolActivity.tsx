import { ChevronDown } from 'lucide-react'

import type { MobileConversationToolActivity as ToolActivity } from '../../../src/shared/types.js'

const getStatusLabel = (status: ToolActivity['status']) => {
  if (status === 'running') return '进行中'
  if (status === 'failed') return '失败'
  return '完成'
}

export const MobileConversationToolActivity = ({ items }: { items: ToolActivity[] }) => {
  if (items.length === 0) return null

  return (
    <details className="mobile-agent-chat__tool-group">
      <summary>
        <span>工具活动（{items.length}）</span>
        <ChevronDown aria-hidden="true" size={16} strokeWidth={1.8} />
      </summary>
      <div className="mobile-agent-chat__tool-list">
        {items.map((tool) => (
          <div
            className="mobile-agent-chat__tool-activity"
            data-status={tool.status}
            key={tool.provider_event_id}
          >
            <span>{getStatusLabel(tool.status)}</span>
            <strong>{tool.label}</strong>
            {tool.duration_ms !== null ? (
              <small>{(tool.duration_ms / 1000).toFixed(1)}s</small>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  )
}
