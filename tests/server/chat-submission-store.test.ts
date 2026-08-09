import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createChatSubmissionStore } from '../../src/server/chat-submission-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const databases: Database.Database[] = []

const createStore = () => {
  const database = new Database(':memory:')
  databases.push(database)
  initializeRuntimeDatabase(database)
  database
    .prepare(
      `INSERT INTO agent_conversations
         (id, workspace_id, agent_id, provider, cli_session_id, source_path,
          recording_boundary, source_checkpoint, active, stale, created_at, updated_at)
       VALUES ('conversation-1', 'workspace-1', 'agent-1', 'codex', 'session-1',
               'session.jsonl', 0, 0, 1, 0, 1, 1)`
    )
    .run()
  return createChatSubmissionStore(database)
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('chat submission store', () => {
  test('accepts one stable submission identity idempotently', () => {
    const store = createStore()
    const input = {
      body: 'hello from C:/Users/example/private with HIVE_AGENT_TOKEN=secret-token',
      conversationId: 'conversation-1',
      id: '11111111-1111-4111-8111-111111111111',
      workspaceId: 'workspace-1',
    }

    const first = store.accept(input)
    const duplicate = store.accept(input)
    const bodylessDuplicate = store.accept({ ...input, body: undefined })

    expect(first).toMatchObject({
      body: 'hello from [local path] with HIVE_AGENT_TOKEN=[redacted]',
      conversation_id: 'conversation-1',
      id: input.id,
      state: 'sending',
    })
    expect(duplicate).toEqual(first)
    expect(bodylessDuplicate).toEqual(first)
    expect(() => store.accept({ ...input, body: 'changed' })).toThrow(/different payload/u)
  })

  test('allows edits and cancellation only before PTY delivery', () => {
    const store = createStore()
    const id = '22222222-2222-4222-8222-222222222222'
    store.accept({
      body: 'draft',
      conversationId: 'conversation-1',
      id,
      workspaceId: 'workspace-1',
    })

    expect(store.edit('workspace-1', id, 'revised')).toMatchObject({
      body: 'revised',
      state: 'sending',
    })
    expect(store.cancel('workspace-1', id)).toMatchObject({ state: 'cancelled' })

    const deliveredId = '33333333-3333-4333-8333-333333333333'
    store.accept({
      body: 'immutable',
      conversationId: 'conversation-1',
      id: deliveredId,
      workspaceId: 'workspace-1',
    })
    store.markDelivered(deliveredId)
    expect(() => store.edit('workspace-1', deliveredId, 'changed')).toThrow(/already delivered/u)
    expect(() => store.cancel('workspace-1', deliveredId)).toThrow(/already delivered/u)
  })

  test('keeps at most three durable queued submissions in acceptance order', () => {
    const store = createStore()
    const ids = [
      '66666666-6666-4666-8666-666666666666',
      '55555555-5555-4555-8555-555555555555',
      '44444444-4444-4444-8444-444444444444',
    ]
    for (const [index, id] of ids.entries()) {
      expect(
        store.acceptQueued({
          body: `queued ${index + 1}`,
          conversationId: 'conversation-1',
          id,
          workspaceId: 'workspace-1',
        })
      ).toMatchObject({ id, state: 'queued' })
    }

    expect(() =>
      store.acceptQueued({
        body: 'queued 4',
        conversationId: 'conversation-1',
        id: '77777777-7777-4777-8777-777777777777',
        workspaceId: 'workspace-1',
      })
    ).toThrow(/three queued submissions/u)
    expect(store.listQueued('conversation-1').map((item) => item.id)).toEqual(ids)
  })

  test('edits and cancels queued entries and validates forced skip counts atomically', () => {
    const store = createStore()
    const firstId = '88888888-8888-4888-8888-888888888888'
    const secondId = '99999999-9999-4999-8999-999999999999'
    for (const [id, body] of [
      [firstId, 'first'],
      [secondId, 'second'],
    ]) {
      store.acceptQueued({
        body,
        conversationId: 'conversation-1',
        id,
        workspaceId: 'workspace-1',
      })
    }

    expect(store.edit('workspace-1', firstId, 'first edited')).toMatchObject({
      body: 'first edited',
      state: 'queued',
    })
    expect(() => store.beginForcedDelivery('workspace-1', secondId, 0)).toThrow(/queue changed/u)
    expect(store.beginForcedDelivery('workspace-1', secondId, 1)).toMatchObject({
      body: 'second',
      skippedCount: 1,
      started: true,
    })
    expect(store.listQueued('conversation-1').map((item) => item.id)).toEqual([firstId])
    expect(store.cancel('workspace-1', firstId)).toMatchObject({ state: 'cancelled' })
  })

  test('excludes an undelivered retry from its own blocker and can requeue it', () => {
    const store = createStore()
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    store.accept({
      body: 'retry me',
      conversationId: 'conversation-1',
      id,
      workspaceId: 'workspace-1',
    })
    store.markUndelivered(id, 'pty_delivery_failed')

    expect(store.hasDeliveryBlocker('conversation-1')).toBe(true)
    expect(store.hasDeliveryBlocker('conversation-1', id)).toBe(false)
    expect(store.requeueUndelivered('workspace-1', id)).toMatchObject({
      error_code: null,
      id,
      state: 'queued',
    })
  })

  test('pauses every pending submission during Runtime restart recovery', () => {
    const store = createStore()
    const queuedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const undeliveredId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    store.acceptQueued({
      body: 'queued before restart',
      conversationId: 'conversation-1',
      id: queuedId,
      workspaceId: 'workspace-1',
    })
    store.accept({
      body: 'failed before restart',
      conversationId: 'conversation-1',
      id: undeliveredId,
      workspaceId: 'workspace-1',
    })
    store.markUndelivered(undeliveredId, 'pty_delivery_failed')

    expect(store.pauseForRuntimeRestart()).toBe(2)
    expect(store.listForConversation('conversation-1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: queuedId, state: 'paused' }),
        expect.objectContaining({ id: undeliveredId, state: 'paused' }),
      ])
    )
    expect(store.getNextAutomaticCandidate('conversation-1')).toBeNull()
  })

  test('continues or forces a paused submission only after explicit action', () => {
    const store = createStore()
    const continuedId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const forcedId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    for (const id of [continuedId, forcedId]) {
      store.acceptQueued({
        body: id === continuedId ? 'continue me' : 'force me',
        conversationId: 'conversation-1',
        id,
        workspaceId: 'workspace-1',
      })
    }
    store.pauseConversation('conversation-1', 'session_changed')

    expect(store.continuePaused('workspace-1', continuedId)).toMatchObject({
      id: continuedId,
      pause_reason: null,
      queue_sequence: 3,
      state: 'queued',
    })
    expect(store.beginForcedDelivery('workspace-1', forcedId, 1)).toMatchObject({
      body: 'force me',
      skippedCount: 1,
      started: true,
    })
  })

  test('a delivery completion wins over a concurrent pause without leaving a resendable row', () => {
    const store = createStore()
    const id = '13131313-1313-4313-8313-131313131313'
    store.accept({
      body: 'already written',
      conversationId: 'conversation-1',
      id,
      workspaceId: 'workspace-1',
    })
    store.beginDelivery(id)
    store.pauseConversation('conversation-1', 'session_changed')

    expect(store.markDelivered(id)).toMatchObject({ state: 'delivered' })
    expect(() => store.continuePaused('workspace-1', id)).toThrow(/Only a paused/u)
  })

  test('pauses pending submissions for one agent without changing completed messages', () => {
    const store = createStore()
    const pendingId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    const deliveredId = '10101010-1010-4010-8010-101010101010'
    for (const id of [pendingId, deliveredId]) {
      store.accept({
        body: id === pendingId ? 'pending' : 'delivered',
        conversationId: 'conversation-1',
        id,
        workspaceId: 'workspace-1',
      })
    }
    store.markDelivered(deliveredId)

    expect(store.pauseAgent('workspace-1', 'agent-1', 'agent_stopped')).toBe(1)
    expect(store.get(pendingId)).toMatchObject({
      pause_reason: 'agent_stopped',
      state: 'paused',
    })
    expect(store.get(deliveredId)).toMatchObject({ state: 'delivered' })
  })

  test('reads a paused source body without retargeting or mutating it', () => {
    const store = createStore()
    const id = '12121212-1212-4212-8212-121212121212'
    store.acceptQueued({
      body: 'migrate this copy',
      conversationId: 'conversation-1',
      id,
      workspaceId: 'workspace-1',
    })
    store.pauseConversation('conversation-1', 'session_changed')

    expect(store.getPausedBody('workspace-1', id)).toEqual({
      attachments: [],
      body: 'migrate this copy',
      conversationId: 'conversation-1',
      deliveryText: 'migrate this copy',
    })
    expect(store.get(id)).toMatchObject({
      conversation_id: 'conversation-1',
      state: 'paused',
    })
  })
})
