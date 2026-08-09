import { closeSync, openSync, readSync, statSync } from 'node:fs'

export interface ConversationSourceRecord {
  byteOffset: number
  line: string
}

export interface ConversationSourceIncrement {
  checkpoint: number
  records: ConversationSourceRecord[]
  sourceSize: number
}

export interface ConversationTurn {
  provider_event_id: string
  role: 'assistant' | 'user'
  source_checkpoint: number
  text: string
}

export interface ConversationToolActivity {
  completed_at: number | null
  label: string | null
  provider_event_id: string
  source_checkpoint: number
  started_at: number | null
  status: 'completed' | 'failed' | 'running'
}

export interface ConversationIncrement {
  activity_state: 'busy' | 'idle' | null
  checkpoint: number
  context_compacted: boolean
  source_size: number
  tool_activity: ConversationToolActivity[]
  turns: ConversationTurn[]
}

export const isConversationSourceRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const parseConversationSourceRecord = (line: string): Record<string, unknown> | null => {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  return isConversationSourceRecord(value) ? value : null
}

export const readConversationRecordTimestamp = (record: Record<string, unknown>): number | null => {
  if (typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)) {
    return record.timestamp
  }
  if (typeof record.timestamp !== 'string') return null
  const timestamp = Date.parse(record.timestamp)
  return Number.isFinite(timestamp) ? timestamp : null
}

export const readConversationSourceIncrement = ({
  checkpoint,
  filePath,
}: {
  checkpoint: number | null
  filePath: string
}): ConversationSourceIncrement => {
  const sourceSize = statSync(filePath).size
  if (checkpoint === null) return { checkpoint: sourceSize, records: [], sourceSize }
  const start = Math.min(Math.max(0, checkpoint), sourceSize)
  if (start === sourceSize) return { checkpoint: start, records: [], sourceSize }

  const buffer = Buffer.allocUnsafe(sourceSize - start)
  const descriptor = openSync(filePath, 'r')
  try {
    readSync(descriptor, buffer, 0, buffer.length, start)
  } finally {
    closeSync(descriptor)
  }
  const lastNewline = buffer.lastIndexOf(0x0a)
  if (lastNewline < 0) return { checkpoint: start, records: [], sourceSize }

  const records: ConversationSourceRecord[] = []
  let byteOffset = start
  for (const lineBuffer of buffer
    .subarray(0, lastNewline + 1)
    .toString('utf8')
    .split('\n')) {
    const line = lineBuffer.replace(/\r$/u, '')
    if (line) records.push({ byteOffset, line })
    byteOffset += Buffer.byteLength(lineBuffer) + 1
  }
  return {
    checkpoint: start + lastNewline + 1,
    records,
    sourceSize,
  }
}
