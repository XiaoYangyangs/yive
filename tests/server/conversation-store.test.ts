import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createConversationStore } from '../../src/server/conversation-store.js'
import {
  CURRENT_SCHEMA_VERSION,
  initializeRuntimeDatabase,
} from '../../src/server/sqlite-schema.js'

const databases: Database.Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('conversation store', () => {
  test('schema creates durable conversation projection tables', () => {
    const database = new Database(':memory:')
    databases.push(database)
    initializeRuntimeDatabase(database)

    const tables = new Set(
      (
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string
        }>
      ).map((row) => row.name)
    )
    const version = database
      .prepare('SELECT MAX(version) AS version FROM schema_version')
      .get() as {
      version: number
    }

    expect(version.version).toBe(CURRENT_SCHEMA_VERSION)
    expect(tables.has('agent_conversations')).toBe(true)
    expect(tables.has('conversation_turns')).toBe(true)
  })

  test('repairs missing conversation tables when old schema markers already exist', () => {
    const database = new Database(':memory:')
    databases.push(database)
    database.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_version (version, applied_at) VALUES (19, 1), (20, 1), (21, 1);
    `)

    initializeRuntimeDatabase(database)

    const tables = new Set(
      (
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string
        }>
      ).map((row) => row.name)
    )
    const conversationColumns = new Set(
      (
        database.prepare('PRAGMA table_info(agent_conversations)').all() as Array<{ name: string }>
      ).map((column) => column.name)
    )
    expect(tables.has('agent_conversations')).toBe(true)
    expect(tables.has('chat_submissions')).toBe(true)
    expect(tables.has('conversation_turns')).toBe(true)
    expect(conversationColumns.has('activity_state')).toBe(true)
  })

  test('upserts one session identity and appends provider turns idempotently', () => {
    const database = new Database(':memory:')
    databases.push(database)
    initializeRuntimeDatabase(database)
    const store = createConversationStore(database)

    const conversation = store.observeConversation({
      agentId: 'agent-1',
      activityState: 'idle',
      checkpoint: 120,
      cliSessionId: 'session-1',
      provider: 'codex',
      sourcePath: 'C:/private/session.jsonl',
      workspaceId: 'workspace-1',
    })
    store.appendTurns(
      conversation.id,
      [
        { providerEventId: 'event-1', role: 'user', text: 'hello' },
        { providerEventId: 'event-2', role: 'assistant', text: 'hi' },
      ],
      240,
      'idle'
    )
    store.appendTurns(
      conversation.id,
      [{ providerEventId: 'event-2', role: 'assistant', text: 'hi' }],
      240,
      'idle'
    )

    expect(store.getCurrentConversation('workspace-1', 'agent-1', 30)).toMatchObject({
      activity_state: 'idle',
      agent_id: 'agent-1',
      cli_session_id: 'session-1',
      provider: 'codex',
      turns: [
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'hi' },
      ],
      workspace_id: 'workspace-1',
    })
    expect(
      JSON.stringify(store.getCurrentConversation('workspace-1', 'agent-1', 30))
    ).not.toContain('C:/private')
  })

  test('returns only the latest requested page in chronological order', () => {
    const database = new Database(':memory:')
    databases.push(database)
    initializeRuntimeDatabase(database)
    const store = createConversationStore(database)
    const conversation = store.observeConversation({
      agentId: 'agent-1',
      activityState: 'busy',
      checkpoint: 0,
      cliSessionId: 'session-1',
      provider: 'codex',
      sourcePath: 'session.jsonl',
      workspaceId: 'workspace-1',
    })
    store.appendTurns(
      conversation.id,
      Array.from({ length: 35 }, (_, index) => ({
        providerEventId: `event-${index + 1}`,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        text: `turn ${index + 1}`,
      })),
      350,
      'busy'
    )

    const page = store.getCurrentConversation('workspace-1', 'agent-1', 30)
    expect(page?.turns).toHaveLength(30)
    expect(page?.activity_state).toBe('busy')
    expect(page?.turns[0]?.text).toBe('turn 6')
    expect(page?.turns[29]?.text).toBe('turn 35')
  })

  test('reconciles a streamed provider message without creating a duplicate turn', () => {
    const database = new Database(':memory:')
    databases.push(database)
    initializeRuntimeDatabase(database)
    const store = createConversationStore(database)
    const conversation = store.observeConversation({
      agentId: 'agent-1',
      activityState: 'busy',
      checkpoint: 0,
      cliSessionId: 'session-1',
      provider: 'claude',
      sourcePath: 'session.jsonl',
      workspaceId: 'workspace-1',
    })
    store.appendTurns(
      conversation.id,
      [{ providerEventId: 'message-1', role: 'assistant', text: 'draft' }],
      100
    )
    store.appendTurns(
      conversation.id,
      [{ providerEventId: 'message-1', role: 'assistant', text: 'final answer' }],
      200
    )

    expect(store.getCurrentConversation('workspace-1', 'agent-1', 30)?.turns).toEqual([
      expect.objectContaining({ provider_event_id: 'message-1', text: 'final answer' }),
    ])
  })

  test('reports unknown activity when the provider projection becomes stale', () => {
    const database = new Database(':memory:')
    databases.push(database)
    initializeRuntimeDatabase(database)
    const store = createConversationStore(database)
    const conversation = store.observeConversation({
      agentId: 'agent-1',
      activityState: 'idle',
      checkpoint: 0,
      cliSessionId: 'session-1',
      provider: 'codex',
      sourcePath: 'session.jsonl',
      workspaceId: 'workspace-1',
    })

    expect(store.getCurrentConversation('workspace-1', 'agent-1', 30)?.activity_state).toBe('idle')
    store.markStale(conversation.id)
    expect(store.getCurrentConversation('workspace-1', 'agent-1', 30)?.activity_state).toBe(
      'unknown'
    )
  })

  test('lists recorded conversations with local titles and stable cursors', () => {
    const database = new Database(':memory:')
    databases.push(database)
    initializeRuntimeDatabase(database)
    const store = createConversationStore(database)
    const first = store.observeConversation({
      agentId: 'agent-1',
      activityState: 'idle',
      checkpoint: 10,
      cliSessionId: 'session-1',
      provider: 'codex',
      sourcePath: 'first.jsonl',
      workspaceId: 'workspace-1',
    })
    store.appendTurns(
      first.id,
      [
        {
          providerEventId: 'first-user',
          role: 'user',
          text: '  Design the mobile history list\nwith details  ',
        },
      ],
      20
    )
    const second = store.observeConversation({
      agentId: 'agent-1',
      activityState: 'idle',
      checkpoint: 30,
      cliSessionId: 'session-2',
      provider: 'claude',
      sourcePath: 'second.jsonl',
      workspaceId: 'workspace-1',
    })
    store.appendTurns(
      second.id,
      [{ providerEventId: 'second-user', role: 'user', text: 'Fix queue recovery' }],
      40
    )

    const page = store.listConversations('workspace-1', 'agent-1', 1)
    expect(page.items).toEqual([
      expect.objectContaining({
        active: true,
        id: second.id,
        provider: 'claude',
        title: 'Fix queue recovery',
      }),
    ])
    expect(page.next_cursor).toBeTruthy()
    expect(store.listConversations('workspace-1', 'agent-1', 1, page.next_cursor).items).toEqual([
      expect.objectContaining({
        active: false,
        id: first.id,
        title: 'Design the mobile history list with details',
      }),
    ])
  })

  test('pages one recorded conversation backward in stable groups of thirty turns', () => {
    const database = new Database(':memory:')
    databases.push(database)
    initializeRuntimeDatabase(database)
    const store = createConversationStore(database)
    const conversation = store.observeConversation({
      agentId: 'agent-1',
      activityState: 'idle',
      checkpoint: 0,
      cliSessionId: 'session-1',
      provider: 'codex',
      sourcePath: 'session.jsonl',
      workspaceId: 'workspace-1',
    })
    store.appendTurns(
      conversation.id,
      Array.from({ length: 35 }, (_, index) => ({
        providerEventId: `event-${index + 1}`,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        text: `turn ${index + 1}`,
      })),
      35
    )

    const latest = store.getConversationPage('workspace-1', 'agent-1', conversation.id, 30)
    expect(latest?.turns.map((turn) => turn.text)).toEqual(
      Array.from({ length: 30 }, (_, index) => `turn ${index + 6}`)
    )
    expect(latest?.next_cursor).toBe('6')
    const older = store.getConversationPage(
      'workspace-1',
      'agent-1',
      conversation.id,
      30,
      latest?.next_cursor
    )
    expect(older?.turns.map((turn) => turn.text)).toEqual(
      Array.from({ length: 5 }, (_, index) => `turn ${index + 1}`)
    )
    expect(older?.next_cursor).toBeNull()
  })

  test('dismisses only historical projections and does not re-import their session identity', () => {
    const database = new Database(':memory:')
    databases.push(database)
    initializeRuntimeDatabase(database)
    const store = createConversationStore(database)
    const historical = store.observeConversation({
      agentId: 'agent-1',
      activityState: 'idle',
      checkpoint: 10,
      cliSessionId: 'session-old',
      provider: 'codex',
      sourcePath: 'provider-old.jsonl',
      workspaceId: 'workspace-1',
    })
    const current = store.observeConversation({
      agentId: 'agent-1',
      activityState: 'idle',
      checkpoint: 20,
      cliSessionId: 'session-current',
      provider: 'codex',
      sourcePath: 'provider-current.jsonl',
      workspaceId: 'workspace-1',
    })

    expect(() => store.dismissConversation('workspace-1', 'agent-1', current.id)).toThrow(
      /historical/u
    )
    expect(store.dismissConversation('workspace-1', 'agent-1', historical.id)).toEqual({
      dismissed: true,
      id: historical.id,
    })
    expect(store.getConversationPage('workspace-1', 'agent-1', historical.id, 30)).toBeNull()
    expect(
      store.observeConversation({
        agentId: 'agent-1',
        activityState: 'idle',
        checkpoint: 30,
        cliSessionId: 'session-old',
        provider: 'codex',
        sourcePath: 'provider-old.jsonl',
        workspaceId: 'workspace-1',
      })
    ).toBeNull()
    expect(store.getConversationPage('workspace-1', 'agent-1', current.id, 30)).not.toBeNull()
    expect(store.listConversations('workspace-1', 'agent-1').items).toEqual([
      expect.objectContaining({ active: false, id: current.id }),
    ])
  })

  test('deleting one agent cascades its projections and dismissals without affecting another', () => {
    const database = new Database(':memory:')
    databases.push(database)
    initializeRuntimeDatabase(database)
    const store = createConversationStore(database)
    const removed = store.observeConversation({
      agentId: 'agent-1',
      activityState: 'idle',
      checkpoint: 10,
      cliSessionId: 'session-removed',
      provider: 'codex',
      sourcePath: 'removed.jsonl',
      workspaceId: 'workspace-1',
    })
    store.observeConversation({
      agentId: 'agent-1',
      activityState: 'idle',
      checkpoint: 20,
      cliSessionId: 'session-current',
      provider: 'codex',
      sourcePath: 'current.jsonl',
      workspaceId: 'workspace-1',
    })
    store.dismissConversation('workspace-1', 'agent-1', removed.id)
    const preserved = store.observeConversation({
      agentId: 'agent-2',
      activityState: 'idle',
      checkpoint: 10,
      cliSessionId: 'session-preserved',
      provider: 'claude',
      sourcePath: 'preserved.jsonl',
      workspaceId: 'workspace-1',
    })

    store.deleteAgent('workspace-1', 'agent-1')

    expect(store.listConversations('workspace-1', 'agent-1').items).toEqual([])
    expect(store.getConversationPage('workspace-1', 'agent-2', preserved.id, 30)).not.toBeNull()
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM dismissed_conversations WHERE agent_id = ?')
        .get('agent-1')
    ).toEqual({ count: 0 })
  })
})
