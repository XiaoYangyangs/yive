import type { Database } from 'better-sqlite3'

export const applySchemaVersion29 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_session_save_intents (
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      capture_source TEXT NOT NULL,
      state TEXT NOT NULL,
      previous_session_id TEXT,
      session_id TEXT,
      failure_reason TEXT,
      requested_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, agent_id)
    );
  `)
}
