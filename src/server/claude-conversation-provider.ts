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

const readTextBlocks = (content: unknown): string => {
  if (!Array.isArray(content)) return ''
  return normalizeVerifiedConversationText(
    content
      .flatMap((item) =>
        isConversationSourceRecord(item) && item.type === 'text' && typeof item.text === 'string'
          ? [item.text]
          : []
      )
      .join('')
  )
}

const parseClaudeTurn = (line: string, byteOffset: number): ConversationTurn | null => {
  const record = parseConversationSourceRecord(line)
  if (
    !record ||
    record.isSidechain === true ||
    record.isMeta === true ||
    record.isCompactSummary === true ||
    !isConversationSourceRecord(record.message)
  ) {
    return null
  }
  const message = record.message

  if (record.type === 'user' && message.role === 'user') {
    const text =
      typeof message.content === 'string'
        ? normalizeVerifiedConversationText(message.content)
        : readTextBlocks(message.content)
    if (!text || isYiveStartupInstruction(text) || typeof record.uuid !== 'string') return null
    return {
      provider_event_id: record.uuid,
      role: 'user',
      source_checkpoint: byteOffset + Buffer.byteLength(line) + 1,
      text,
    }
  }

  if (record.type === 'assistant' && message.role === 'assistant') {
    const text = readTextBlocks(message.content)
    const providerEventId =
      typeof message.id === 'string'
        ? message.id
        : typeof record.uuid === 'string'
          ? record.uuid
          : null
    if (!text || !providerEventId) return null
    return {
      provider_event_id: providerEventId,
      role: 'assistant',
      source_checkpoint: byteOffset + Buffer.byteLength(line) + 1,
      text,
    }
  }
  return null
}

const parseClaudeToolActivity = (line: string, byteOffset: number): ConversationToolActivity[] => {
  const record = parseConversationSourceRecord(line)
  if (
    !record ||
    record.isSidechain === true ||
    !isConversationSourceRecord(record.message) ||
    !Array.isArray(record.message.content)
  ) {
    return []
  }
  const checkpoint = byteOffset + Buffer.byteLength(line) + 1
  const timestamp = readConversationRecordTimestamp(record)
  const activity: ConversationToolActivity[] = []
  for (const item of record.message.content) {
    if (!isConversationSourceRecord(item)) continue
    if (record.type === 'assistant' && item.type === 'tool_use' && typeof item.id === 'string') {
      activity.push({
        completed_at: null,
        label: typeof item.name === 'string' ? item.name : 'Tool',
        provider_event_id: item.id,
        source_checkpoint: checkpoint,
        started_at: timestamp,
        status: 'running' as const,
      })
      continue
    }
    if (
      record.type === 'user' &&
      item.type === 'tool_result' &&
      typeof item.tool_use_id === 'string'
    ) {
      activity.push({
        completed_at: timestamp,
        label: null,
        provider_event_id: item.tool_use_id,
        source_checkpoint: checkpoint,
        started_at: null,
        status: item.is_error === true ? ('failed' as const) : ('completed' as const),
      })
    }
  }
  return activity
}

const readActivityState = (line: string): ConversationIncrement['activity_state'] => {
  const record = parseConversationSourceRecord(line)
  if (!record || record.isSidechain === true) return null
  if (record.type === 'system' && record.subtype === 'turn_duration') return 'idle'
  return parseClaudeTurn(line, 0)?.role === 'user' ? 'busy' : null
}

export const readClaudeConversationIncrement = ({
  checkpoint,
  filePath,
}: {
  checkpoint: number | null
  filePath: string
}): ConversationIncrement => {
  const source = readConversationSourceIncrement({ checkpoint: checkpoint ?? 0, filePath })
  const turns = new Map<string, ConversationTurn>()
  const toolActivity = new Map<string, ConversationToolActivity>()
  let activityState: ConversationIncrement['activity_state'] = null
  let contextCompacted = false
  for (const record of source.records) {
    activityState = readActivityState(record.line) ?? activityState
    const parsed = parseConversationSourceRecord(record.line)
    if (parsed?.type === 'system' && parsed.subtype === 'compact_boundary') {
      contextCompacted = true
    }
    if (checkpoint !== null) {
      const turn = parseClaudeTurn(record.line, record.byteOffset)
      if (turn) turns.set(`${turn.role}:${turn.provider_event_id}`, turn)
      for (const tool of parseClaudeToolActivity(record.line, record.byteOffset)) {
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
    turns: Array.from(turns.values()),
  }
}
