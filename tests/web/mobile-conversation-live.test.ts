import { describe, expect, test } from 'vitest'

import type { MobileConversationPage } from '../../src/shared/types.js'
import { mergeMobileConversationUpdate } from '../../web/src/mobile/mobile-conversation-live.js'

const page = (overrides: Partial<MobileConversationPage> = {}): MobileConversationPage => ({
  activity_state: 'busy',
  agent_id: 'agent-1',
  cli_session_id: 'session-1',
  cursor: 10,
  id: 'conversation-1',
  provider: 'codex',
  recording_boundary: 0,
  source_checkpoint: 10,
  stale: false,
  submissions: [],
  tool_activity: [],
  turns: [],
  workspace_id: 'workspace-1',
  ...overrides,
})

describe('mobile live conversation merge', () => {
  test('updates one working reply and tool without duplicating provider events', () => {
    const current = page({
      turns: [
        {
          provider_event_id: 'reply-1',
          role: 'assistant',
          sequence: 1,
          source_checkpoint: 10,
          text: 'draft',
        },
      ],
    })
    const update = page({
      activity_state: 'idle',
      cursor: 30,
      source_checkpoint: 30,
      tool_activity: [
        {
          completed_at: 200,
          duration_ms: 100,
          label: 'Read',
          provider_event_id: 'tool-1',
          sequence: 1,
          source_checkpoint: 20,
          started_at: 100,
          status: 'completed',
        },
      ],
      turns: [
        {
          provider_event_id: 'reply-1',
          role: 'assistant',
          sequence: 1,
          source_checkpoint: 30,
          text: 'final',
        },
      ],
    })

    const merged = mergeMobileConversationUpdate(current, update)

    expect(merged.turns).toHaveLength(1)
    expect(merged.turns[0]).toMatchObject({ provider_event_id: 'reply-1', text: 'final' })
    expect(merged.tool_activity).toHaveLength(1)
    expect(merged).toMatchObject({ activity_state: 'idle', cursor: 30 })
  })

  test('does not regress cursor or activity when an older request resolves last', () => {
    const current = page({
      activity_state: 'idle',
      cursor: 30,
      source_checkpoint: 30,
      turns: [
        {
          provider_event_id: 'reply-1',
          role: 'assistant',
          sequence: 1,
          source_checkpoint: 30,
          text: 'final',
        },
      ],
    })
    const stale = page({
      activity_state: 'busy',
      cursor: 20,
      source_checkpoint: 20,
      turns: [
        {
          provider_event_id: 'reply-1',
          role: 'assistant',
          sequence: 1,
          source_checkpoint: 20,
          text: 'draft',
        },
      ],
    })

    expect(mergeMobileConversationUpdate(current, stale)).toMatchObject({
      activity_state: 'idle',
      cursor: 30,
      source_checkpoint: 30,
      turns: [{ provider_event_id: 'reply-1', text: 'final' }],
    })
  })
})
