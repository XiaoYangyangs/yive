import { describe, expect, test } from 'vitest'
import type { TeamListItem } from '../../src/shared/types.js'

describe('shared types contract', () => {
  test('team list item keeps process, conversation, and Dispatch state independent', () => {
    const item: TeamListItem = {
      activeDispatchId: 'dispatch-1',
      conversationActivity: 'idle',
      id: 'alice',
      kind: 'worker',
      lastObservedAt: 1_754_360_000_000,
      name: 'Alice',
      processState: 'running',
      queuePauseReason: null,
      queuedDispatchCount: 1,
    }

    expect(item).toMatchObject({
      activeDispatchId: 'dispatch-1',
      conversationActivity: 'idle',
      processState: 'running',
      queuedDispatchCount: 1,
    })
  })
})
