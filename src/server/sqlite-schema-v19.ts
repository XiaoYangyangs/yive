import type { Database } from 'better-sqlite3'

export const applySchemaVersion19 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_conversations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      cli_session_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      recording_boundary INTEGER NOT NULL,
      source_checkpoint INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      stale INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (workspace_id, agent_id, provider, cli_session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_conversations_active
      ON agent_conversations (workspace_id, agent_id, active, updated_at DESC);

    CREATE TABLE IF NOT EXISTS conversation_turns (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (conversation_id, provider_event_id),
      FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_turns_page
      ON conversation_turns (conversation_id, sequence DESC);
  `)
}
