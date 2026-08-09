import type { Database } from 'better-sqlite3'

export const applySchemaVersion23 = (db: Database) => {
  db.exec(`
    CREATE TABLE chat_submissions_v23 (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      body TEXT NOT NULL,
      confirmation_text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('accepted', 'queued', 'paused', 'sending', 'delivered', 'confirmed', 'undelivered', 'cancelled')
      ),
      error_code TEXT,
      provider_event_id TEXT,
      provider_turn_sequence INTEGER,
      queue_sequence INTEGER,
      accepted_at INTEGER NOT NULL,
      delivered_at INTEGER,
      confirmed_at INTEGER,
      paused_at INTEGER,
      pause_reason TEXT,
      cancelled_at INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
    );

    INSERT INTO chat_submissions_v23
      (id, conversation_id, body, confirmation_text, state, error_code,
       provider_event_id, provider_turn_sequence, queue_sequence, accepted_at,
       delivered_at, confirmed_at, paused_at, pause_reason, cancelled_at, updated_at)
    SELECT id, conversation_id, body, confirmation_text, state, error_code,
           provider_event_id, provider_turn_sequence, queue_sequence, accepted_at,
           delivered_at, confirmed_at, NULL, NULL, cancelled_at, updated_at
    FROM chat_submissions;

    DROP TABLE chat_submissions;
    ALTER TABLE chat_submissions_v23 RENAME TO chat_submissions;

    CREATE INDEX idx_chat_submissions_conversation
      ON chat_submissions (conversation_id, accepted_at, id);
  `)
}
