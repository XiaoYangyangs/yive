import type { Database } from 'better-sqlite3'

export const applySchemaVersion26 = (db: Database) => {
  const turnColumns = new Set(
    (db.prepare('PRAGMA table_info(conversation_turns)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!turnColumns.has('source_checkpoint')) {
    db.exec(
      'ALTER TABLE conversation_turns ADD COLUMN source_checkpoint INTEGER NOT NULL DEFAULT 0'
    )
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversation_turns_checkpoint
      ON conversation_turns (conversation_id, source_checkpoint);

    CREATE TABLE IF NOT EXISTS conversation_tool_activity (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      source_checkpoint INTEGER NOT NULL,
      UNIQUE (conversation_id, provider_event_id),
      FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_tool_activity_checkpoint
      ON conversation_tool_activity (conversation_id, source_checkpoint);
  `)
}
