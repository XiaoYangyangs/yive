import type { Database } from 'better-sqlite3'

export const applySchemaVersion24 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dismissed_conversations (
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      cli_session_id TEXT NOT NULL,
      dismissed_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, agent_id, provider, cli_session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_dismissed_conversations_agent
      ON dismissed_conversations (workspace_id, agent_id, dismissed_at DESC);
  `)
}
