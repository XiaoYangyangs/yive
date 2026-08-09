import type { Database } from 'better-sqlite3'

export const applySchemaVersion21 = (db: Database) => {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_submissions'")
    .get()
  if (!table) {
    db.exec(`
      CREATE TABLE chat_submissions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        body TEXT NOT NULL,
        confirmation_text TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('accepted', 'queued', 'sending', 'delivered', 'confirmed', 'undelivered', 'cancelled')
        ),
        error_code TEXT,
        provider_event_id TEXT,
        provider_turn_sequence INTEGER,
        queue_sequence INTEGER,
        accepted_at INTEGER NOT NULL,
        delivered_at INTEGER,
        confirmed_at INTEGER,
        cancelled_at INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_chat_submissions_conversation
        ON chat_submissions (conversation_id, accepted_at, id);
    `)
    return
  }

  const columns = new Set(
    (db.prepare('PRAGMA table_info(chat_submissions)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (columns.has('queue_sequence')) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chat_submissions_conversation
        ON chat_submissions (conversation_id, accepted_at, id);
    `)
    return
  }

  db.exec(`
    CREATE TABLE chat_submissions_v21 (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      body TEXT NOT NULL,
      confirmation_text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('accepted', 'queued', 'sending', 'delivered', 'confirmed', 'undelivered', 'cancelled')
      ),
      error_code TEXT,
      provider_event_id TEXT,
      provider_turn_sequence INTEGER,
      queue_sequence INTEGER,
      accepted_at INTEGER NOT NULL,
      delivered_at INTEGER,
      confirmed_at INTEGER,
      cancelled_at INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
    );

    INSERT INTO chat_submissions_v21
      (id, conversation_id, body, confirmation_text, state, error_code,
       provider_event_id, provider_turn_sequence, queue_sequence, accepted_at,
       delivered_at, confirmed_at, cancelled_at, updated_at)
    SELECT id, conversation_id, body, confirmation_text, state, error_code,
           provider_event_id, provider_turn_sequence, NULL, accepted_at,
           delivered_at, confirmed_at, cancelled_at, updated_at
    FROM chat_submissions;

    DROP TABLE chat_submissions;
    ALTER TABLE chat_submissions_v21 RENAME TO chat_submissions;

    CREATE INDEX idx_chat_submissions_conversation
      ON chat_submissions (conversation_id, accepted_at, id);
  `)
}
