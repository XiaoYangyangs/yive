import {
  isYiveStartupInstruction,
  normalizeVerifiedConversationText,
} from './conversation-content.js'
import type {
  ConversationIncrement,
  ConversationToolActivity,
  ConversationTurn,
} from './conversation-source.js'
import {
  isConversationSourceRecord,
  parseConversationSourceRecord,
  readConversationRecordTimestamp,
  readConversationSourceIncrement,
} from './conversation-source.js'

export type CodexConversationTurn = ConversationTurn
export type CodexConversationIncrement = ConversationIncrement

const readMessageText = (content: unknown, contentType: 'input_text' | 'output_text'): string => {
  if (!Array.isArray(content)) return ''
  return normalizeVerifiedConversationText(
    content
      .flatMap((item) =>
        isConversationSourceRecord(item) &&
        item.type === contentType &&
        typeof item.text === 'string'
          ? [item.text]
          : []
      )
      .join('')
  )
}

const parseTurn = (line: string, byteOffset: number): ConversationTurn | null => {
  const record = parseConversationSourceRecord(line)
  if (!record || record.type !== 'response_item' || !isConversationSourceRecord(record.payload)) {
    return null
  }
  const payload = record.payload
  if (payload.type !== 'message' || (payload.role !== 'user' && payload.role !== 'assistant')) {
    return null
  }
  const text = readMessageText(
    payload.content,
    payload.role === 'user' ? 'input_text' : 'output_text'
  )
  if (!text) return null
  if (payload.role === 'user' && isYiveStartupInstruction(text)) return null
  const providerEventId =
    typeof record.id === 'string'
      ? record.id
      : typeof payload.id === 'string'
        ? payload.id
        : `codex-byte-${byteOffset}`
  return {
    provider_event_id: providerEventId,
    role: payload.role,
    source_checkpoint: byteOffset + Buffer.byteLength(line) + 1,
    text,
  }
}

const parseToolActivity = (line: string, byteOffset: number): ConversationToolActivity | null => {
  const record = parseConversationSourceRecord(line)
  if (!record || record.type !== 'response_item' || !isConversationSourceRecord(record.payload)) {
    return null
  }
  const payload = record.payload
  const isToolCall = payload.type === 'function_call' || payload.type === 'custom_tool_call'
  const isToolOutput =
    payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output'
  if (!isToolCall && !isToolOutput) return null
  const providerEventId =
    typeof payload.call_id === 'string'
      ? payload.call_id
      : typeof payload.id === 'string'
        ? payload.id
        : typeof record.id === 'string'
          ? record.id
          : `codex-tool-byte-${byteOffset}`
  return {
    completed_at: isToolOutput ? readConversationRecordTimestamp(record) : null,
    label: isToolCall && typeof payload.name === 'string' ? payload.name : null,
    provider_event_id: providerEventId,
    source_checkpoint: byteOffset + Buffer.byteLength(line) + 1,
    started_at: isToolCall ? readConversationRecordTimestamp(record) : null,
    status: isToolCall ? 'running' : 'completed',
  }
}

const readActivityState = (line: string): ConversationIncrement['activity_state'] => {
  const record = parseConversationSourceRecord(line)
  if (!record) return null
  if (
    record.type === 'event_msg' &&
    isConversationSourceRecord(record.payload) &&
    (record.payload.type === 'task_complete' || record.payload.type === 'turn_aborted')
  ) {
    return 'idle'
  }
  const turn = parseTurn(line, 0)
  return turn?.role === 'user' ? 'busy' : null
}

export const readCodexConversationIncrement = ({
  checkpoint,
  filePath,
}: {
  checkpoint: number | null
  filePath: string
}): ConversationIncrement => {
  const source = readConversationSourceIncrement({ checkpoint: checkpoint ?? 0, filePath })
  const turns: ConversationTurn[] = []
  const toolActivity = new Map<string, ConversationToolActivity>()
  let activityState: ConversationIncrement['activity_state'] = null
  let contextCompacted = false
  for (const record of source.records) {
    activityState = readActivityState(record.line) ?? activityState
    const parsed = parseConversationSourceRecord(record.line)
    if (
      parsed?.type === 'event_msg' &&
      isConversationSourceRecord(parsed.payload) &&
      parsed.payload.type === 'context_compacted'
    ) {
      contextCompacted = true
    }
    if (checkpoint !== null) {
      const turn = parseTurn(record.line, record.byteOffset)
      if (turn) turns.push(turn)
      const tool = parseToolActivity(record.line, record.byteOffset)
      if (tool) {
        const previous = toolActivity.get(tool.provider_event_id)
        toolActivity.set(tool.provider_event_id, {
          ...tool,
          completed_at: tool.completed_at ?? previous?.completed_at ?? null,
          label: tool.label ?? previous?.label ?? null,
          started_at: tool.started_at ?? previous?.started_at ?? null,
        })
      }
    }
  }
  return {
    activity_state: activityState,
    checkpoint: source.checkpoint,
    context_compacted: contextCompacted,
    source_size: source.sourceSize,
    tool_activity: Array.from(toolActivity.values()),
    turns,
  }
}
