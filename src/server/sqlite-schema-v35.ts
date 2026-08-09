import type { Database } from 'better-sqlite3'

/** v35: durable supplemental Notes attached to existing Dispatches. */
export const applySchemaVersion35 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_notes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      text TEXT NOT NULL,
      artifacts_json TEXT NOT NULL,
      delivery_mode TEXT NOT NULL,
      delivery_state TEXT NOT NULL,
      delivered_at INTEGER,
      delivery_error TEXT,
      acknowledged_at INTEGER,
      acknowledged_by_agent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dispatch_notes_dispatch_sequence
      ON dispatch_notes (workspace_id, dispatch_id, sequence);

    CREATE INDEX IF NOT EXISTS idx_dispatch_notes_delivery
      ON dispatch_notes (workspace_id, delivery_state, sequence);
  `)
}
