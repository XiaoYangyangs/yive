import type { Database } from 'better-sqlite3'

const createDispatchNotesTable = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_notes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('agent', 'user')),
      actor_id TEXT NOT NULL,
      text TEXT NOT NULL,
      artifacts_json TEXT NOT NULL,
      delivery_state TEXT NOT NULL
        CHECK (delivery_state IN ('queued', 'delivering', 'delivered', 'failed')),
      delivered_at INTEGER,
      delivery_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dispatch_notes_dispatch_sequence
      ON dispatch_notes (workspace_id, dispatch_id, sequence);

    CREATE INDEX IF NOT EXISTS idx_dispatch_notes_delivery
      ON dispatch_notes (workspace_id, delivery_state, sequence);
  `)
}

/** v60: Notes have one safe-boundary delivery mode and no explicit acknowledgement. */
export const applySchemaVersion60 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(dispatch_notes)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!columns.has('delivery_mode') && !columns.has('acknowledged_at')) {
    createDispatchNotesTable(db)
    return
  }

  db.exec(`
    DROP INDEX IF EXISTS idx_dispatch_notes_dispatch_sequence;
    DROP INDEX IF EXISTS idx_dispatch_notes_delivery;
    ALTER TABLE dispatch_notes RENAME TO dispatch_notes_v59;
  `)
  createDispatchNotesTable(db)
  db.exec(`
    INSERT INTO dispatch_notes (
      sequence, id, workspace_id, dispatch_id, actor_type, actor_id, text, artifacts_json,
      delivery_state, delivered_at, delivery_error, created_at, updated_at
    )
    SELECT
      sequence,
      id,
      workspace_id,
      dispatch_id,
      CASE WHEN actor_type IN ('agent', 'user') THEN actor_type ELSE 'user' END,
      actor_id,
      text,
      artifacts_json,
      CASE
        WHEN delivery_state = 'acknowledged' THEN 'delivered'
        WHEN delivery_state IN ('queued', 'delivering', 'delivered', 'failed') THEN delivery_state
        ELSE 'queued'
      END,
      CASE
        WHEN delivery_state = 'acknowledged'
          THEN COALESCE(delivered_at, acknowledged_at)
        ELSE delivered_at
      END,
      delivery_error,
      created_at,
      updated_at
    FROM dispatch_notes_v59
    ORDER BY sequence;

    DROP TABLE dispatch_notes_v59;
  `)
}
