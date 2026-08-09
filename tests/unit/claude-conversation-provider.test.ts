import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { readClaudeConversationIncrement } from '../../src/server/claude-conversation-provider.js'

const temporaryDirectories: string[] = []

const createSessionFile = (records: unknown[]) => {
  const directory = mkdtempSync(join(tmpdir(), 'yive-claude-conversation-'))
  temporaryDirectories.push(directory)
  const filePath = join(directory, 'session.jsonl')
  writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return filePath
}

const userRecord = (uuid: string, content: unknown) => ({
  isSidechain: false,
  message: { content, role: 'user' },
  type: 'user',
  timestamp: '2026-07-12T00:00:01.000Z',
  uuid,
})

const assistantRecord = (uuid: string, messageId: string, content: unknown[]) => ({
  isSidechain: false,
  message: { content, id: messageId, role: 'assistant', type: 'message' },
  type: 'assistant',
  timestamp: '2026-07-12T00:00:00.000Z',
  uuid,
})

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('Claude conversation provider', () => {
  test('records the first observation boundary without importing existing history', () => {
    const filePath = createSessionFile([
      userRecord('old-user', 'old question'),
      assistantRecord('old-agent', 'message-old', [{ type: 'text', text: 'old answer' }]),
    ])

    const increment = readClaudeConversationIncrement({ checkpoint: null, filePath })

    expect(increment.turns).toEqual([])
    expect(increment.activity_state).toBe('busy')
    expect(increment.checkpoint).toBeGreaterThan(0)
  })

  test('normalizes verified messages while excluding provider internals and partial records', () => {
    const filePath = createSessionFile([userRecord('old-user', 'old question')])
    const boundary = readClaudeConversationIncrement({ checkpoint: null, filePath })
    appendFileSync(
      filePath,
      `${[
        userRecord(
          'new-user',
          'new question from C:/Users/example/private and /etc/yive/config and \\\\server\\share\\secret HIVE_AGENT_TOKEN=secret-token Bearer bearer-secret sk-ant-abcdefghijklmnopqrst ghp_abcdefghijklmnopqrstuvwxyz\n<hive-system-reminder>internal routing</hive-system-reminder>'
        ),
        {
          ...userRecord('compact-summary', 'invented compression summary'),
          isCompactSummary: true,
          isMeta: true,
        },
        userRecord('tool-result', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'raw' }]),
        assistantRecord('stream-1', 'message-1', [
          { type: 'thinking', thinking: 'hidden reasoning' },
          { type: 'text', text: 'draft' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'C:/private' } },
        ]),
        assistantRecord('stream-2', 'message-1', [{ type: 'text', text: 'final answer' }]),
        {
          type: 'system',
          subtype: 'compact_boundary',
          content: 'compression summary',
          uuid: 'compact-1',
        },
        { type: 'progress', data: { message: 'tool log' }, uuid: 'progress-1' },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`
    )
    appendFileSync(filePath, '{"type":"assistant","message":')

    const increment = readClaudeConversationIncrement({
      checkpoint: boundary.checkpoint,
      filePath,
    })

    expect(increment.turns).toEqual([
      {
        provider_event_id: 'new-user',
        role: 'user',
        source_checkpoint: expect.any(Number),
        text: 'new question from [local path] and [local path] and [local path] HIVE_AGENT_TOKEN=[redacted] Bearer [redacted] [redacted token] [redacted token]',
      },
      {
        provider_event_id: 'message-1',
        role: 'assistant',
        source_checkpoint: expect.any(Number),
        text: 'final answer',
      },
    ])
    expect(increment.tool_activity).toEqual([
      {
        completed_at: Date.parse('2026-07-12T00:00:01.000Z'),
        label: 'Read',
        provider_event_id: 'tool-1',
        source_checkpoint: expect.any(Number),
        started_at: Date.parse('2026-07-12T00:00:00.000Z'),
        status: 'running',
      },
    ])
    expect(JSON.stringify(increment.turns)).not.toContain('C:/private')
    expect(JSON.stringify(increment.tool_activity)).not.toContain('raw')
    expect(increment.checkpoint).toBeLessThan(increment.source_size)
  })

  test('reports idle only after the provider turn-duration boundary', () => {
    const filePath = createSessionFile([])
    const boundary = readClaudeConversationIncrement({ checkpoint: null, filePath })
    appendFileSync(
      filePath,
      `${[
        userRecord('new-user', 'new question'),
        assistantRecord('working', 'message-1', [
          { type: 'text', text: 'I will inspect that.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
        ]),
        userRecord('tool-result', [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
        ]),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`
    )

    const working = readClaudeConversationIncrement({
      checkpoint: boundary.checkpoint,
      filePath,
    })

    expect(working.activity_state).toBe('busy')
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 10 })}\n`
    )
    expect(
      readClaudeConversationIncrement({ checkpoint: working.checkpoint, filePath }).activity_state
    ).toBe('idle')
  })

  test('reports a Provider compact boundary without exposing its summary', () => {
    const filePath = createSessionFile([])
    const boundary = readClaudeConversationIncrement({ checkpoint: null, filePath })
    appendFileSync(
      filePath,
      `${JSON.stringify({
        content: 'private provider compression summary',
        subtype: 'compact_boundary',
        type: 'system',
        uuid: 'compact-1',
      })}\n`
    )

    const increment = readClaudeConversationIncrement({
      checkpoint: boundary.checkpoint,
      filePath,
    })

    expect(increment.context_compacted).toBe(true)
    expect(increment.turns).toEqual([])
    expect(JSON.stringify(increment)).not.toContain('private provider compression summary')
  })
})
