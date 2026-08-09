import type { Database } from 'better-sqlite3'

export const applySchemaVersion20 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_submissions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      body TEXT NOT NULL,
      confirmation_text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('accepted', 'sending', 'delivered', 'confirmed', 'undelivered', 'cancelled')
      ),
      error_code TEXT,
      provider_event_id TEXT,
      provider_turn_sequence INTEGER,
      accepted_at INTEGER NOT NULL,
      delivered_at INTEGER,
      confirmed_at INTEGER,
      cancelled_at INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_submissions_conversation
      ON chat_submissions (conversation_id, accepted_at, id);
  `)
}
