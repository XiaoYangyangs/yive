import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { readCodexConversationIncrement } from '../../src/server/codex-conversation-provider.js'

const temporaryDirectories: string[] = []

const createSessionFile = (records: unknown[]) => {
  const directory = mkdtempSync(join(tmpdir(), 'yive-codex-conversation-'))
  temporaryDirectories.push(directory)
  const filePath = join(directory, 'rollout-session.jsonl')
  writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return filePath
}

const message = (role: string, text: string, id: string) => ({
  id,
  type: 'response_item',
  payload: {
    content: [{ text, type: role === 'user' ? 'input_text' : 'output_text' }],
    role,
    type: 'message',
  },
})

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('Codex conversation provider', () => {
  test('records the first observation boundary without importing existing history', () => {
    const filePath = createSessionFile([
      { type: 'session_meta', payload: { cwd: 'C:/workspace', id: 'session-1' } },
      message('user', 'old question', 'old-user'),
      message('assistant', 'old answer', 'old-assistant'),
    ])

    const increment = readCodexConversationIncrement({ checkpoint: null, filePath })

    expect(increment.turns).toEqual([])
    expect(increment.activity_state).toBe('busy')
    expect(increment.checkpoint).toBeGreaterThan(0)
  })

  test('projects only complete verified user and assistant messages appended after the boundary', () => {
    const filePath = createSessionFile([
      { type: 'session_meta', payload: { cwd: 'C:/workspace', id: 'session-1' } },
      message('user', 'old question', 'old-user'),
    ])
    const boundary = readCodexConversationIncrement({ checkpoint: null, filePath })
    appendFileSync(
      filePath,
      `${[
        message(
          'user',
          'new question\n<hive-system-reminder>internal routing</hive-system-reminder>',
          'new-user'
        ),
        {
          id: 'wrong-content-kind',
          type: 'response_item',
          payload: {
            content: [{ text: 'not verified user input', type: 'output_text' }],
            role: 'user',
            type: 'message',
          },
        },
        message(
          'user',
          [
            'Yive startup',
            'Hive session binding: workspace_id=workspace-1; agent_id=agent-1',
            'Mobile file direction: .hive/mobile-attachments.json is only the phone-uploaded attachment registry',
            'To send a generated workspace file to the phone, run yive mobile send-file',
          ].join('\n'),
          'startup'
        ),
        message(
          'user',
          'What does Hive session binding: workspace_id=workspace-1 mean?',
          'marker-question'
        ),
        { type: 'response_item', payload: { role: 'developer', type: 'message', content: [] } },
        { type: 'response_item', payload: { type: 'reasoning', summary: ['hidden'] } },
        {
          id: 'call-record',
          timestamp: '2026-07-12T00:00:00.000Z',
          type: 'response_item',
          payload: {
            arguments: '{"command":"type C:/private/secret.txt"}',
            call_id: 'call-1',
            name: 'shell',
            type: 'function_call',
          },
        },
        {
          timestamp: '2026-07-12T00:00:01.250Z',
          type: 'response_item',
          payload: {
            call_id: 'call-1',
            output: 'raw private stdout',
            type: 'function_call_output',
          },
        },
        message('assistant', 'new answer', 'new-assistant'),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`
    )
    appendFileSync(filePath, '{"type":"response_item","payload":')

    const increment = readCodexConversationIncrement({
      checkpoint: boundary.checkpoint,
      filePath,
    })

    expect(increment.turns).toEqual([
      {
        provider_event_id: 'new-user',
        role: 'user',
        source_checkpoint: expect.any(Number),
        text: 'new question',
      },
      {
        provider_event_id: 'marker-question',
        role: 'user',
        source_checkpoint: expect.any(Number),
        text: 'What does Hive session binding: workspace_id=workspace-1 mean?',
      },
      {
        provider_event_id: 'new-assistant',
        role: 'assistant',
        source_checkpoint: expect.any(Number),
        text: 'new answer',
      },
    ])
    expect(increment.tool_activity).toEqual([
      {
        completed_at: Date.parse('2026-07-12T00:00:01.250Z'),
        label: 'shell',
        provider_event_id: 'call-1',
        source_checkpoint: expect.any(Number),
        started_at: Date.parse('2026-07-12T00:00:00.000Z'),
        status: 'completed',
      },
    ])
    expect(JSON.stringify(increment.tool_activity)).not.toContain('private')
    expect(increment.checkpoint).toBeLessThan(increment.source_size)
  })

  test('projects modern custom tool activity without exposing inputs or outputs', () => {
    const filePath = createSessionFile([
      { type: 'session_meta', payload: { cwd: 'C:/workspace', id: 'session-1' } },
    ])
    const boundary = readCodexConversationIncrement({ checkpoint: null, filePath })
    appendFileSync(
      filePath,
      `${[
        {
          timestamp: '2026-08-01T00:00:00.000Z',
          type: 'response_item',
          payload: {
            call_id: 'custom-1',
            id: 'custom-call-1',
            input: '{"patch":"C:/private/secret.txt"}',
            name: 'apply_patch',
            status: 'completed',
            type: 'custom_tool_call',
          },
        },
        {
          timestamp: '2026-08-01T00:00:01.500Z',
          type: 'response_item',
          payload: {
            call_id: 'custom-1',
            output: 'raw private patch result',
            type: 'custom_tool_call_output',
          },
        },
        {
          timestamp: '2026-08-01T00:00:02.000Z',
          type: 'response_item',
          payload: {
            call_id: 'custom-2',
            input: '{"command":"type C:/private/secret.txt"}',
            name: 'exec',
            status: 'completed',
            type: 'custom_tool_call',
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`
    )

    const increment = readCodexConversationIncrement({
      checkpoint: boundary.checkpoint,
      filePath,
    })

    expect(increment.tool_activity).toEqual([
      {
        completed_at: Date.parse('2026-08-01T00:00:01.500Z'),
        label: 'apply_patch',
        provider_event_id: 'custom-1',
        source_checkpoint: expect.any(Number),
        started_at: Date.parse('2026-08-01T00:00:00.000Z'),
        status: 'completed',
      },
      {
        completed_at: null,
        label: 'exec',
        provider_event_id: 'custom-2',
        source_checkpoint: expect.any(Number),
        started_at: Date.parse('2026-08-01T00:00:02.000Z'),
        status: 'running',
      },
    ])
    expect(JSON.stringify(increment.tool_activity)).not.toContain('private')
    expect(JSON.stringify(increment.tool_activity)).not.toContain('raw')
  })

  test('reports idle only after a provider-native completion event', () => {
    const filePath = createSessionFile([
      { type: 'session_meta', payload: { cwd: 'C:/workspace', id: 'session-1' } },
    ])
    const boundary = readCodexConversationIncrement({ checkpoint: null, filePath })
    appendFileSync(
      filePath,
      `${[
        message('user', 'new question', 'new-user'),
        message('assistant', 'I will inspect that.', 'working-assistant'),
        { type: 'response_item', payload: { type: 'function_call', name: 'shell' } },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`
    )

    const working = readCodexConversationIncrement({
      checkpoint: boundary.checkpoint,
      filePath,
    })

    expect(working.activity_state).toBe('busy')
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
    )
    expect(
      readCodexConversationIncrement({ checkpoint: working.checkpoint, filePath }).activity_state
    ).toBe('idle')
  })

  test('reports a Provider compact boundary without exposing its summary', () => {
    const filePath = createSessionFile([])
    const boundary = readCodexConversationIncrement({ checkpoint: null, filePath })
    appendFileSync(
      filePath,
      `${JSON.stringify({
        payload: {
          message: 'private provider compression summary',
          type: 'context_compacted',
        },
        type: 'event_msg',
      })}\n`
    )

    const increment = readCodexConversationIncrement({
      checkpoint: boundary.checkpoint,
      filePath,
    })

    expect(increment.context_compacted).toBe(true)
    expect(increment.turns).toEqual([])
    expect(JSON.stringify(increment)).not.toContain('private provider compression summary')
  })
})
