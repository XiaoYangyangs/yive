import type { Database } from 'better-sqlite3'

export const applySchemaVersion59 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!columns.has('report_outcome')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN report_outcome TEXT')
  }
  if (!columns.has('report_request_id')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN report_request_id TEXT')
  }
  if (!columns.has('report_request_fingerprint')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN report_request_fingerprint TEXT')
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatches_report_request_id
      ON dispatches (workspace_id, to_agent_id, report_request_id)
      WHERE report_request_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS dispatch_status_updates (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL,
      dispatch_sequence INTEGER NOT NULL,
      worker_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      text TEXT NOT NULL,
      artifacts TEXT NOT NULL,
      notify INTEGER NOT NULL CHECK (notify IN (0, 1)),
      created_at INTEGER NOT NULL,
      UNIQUE (workspace_id, worker_id, request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_dispatch_status_updates_latest
      ON dispatch_status_updates (workspace_id, worker_id, sequence DESC);

    CREATE TABLE IF NOT EXISTS coordination_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('status', 'report')),
      request_id TEXT NOT NULL,
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'failed')),
      text TEXT NOT NULL,
      artifacts TEXT NOT NULL,
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending', 'delivering', 'delivered')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      UNIQUE (workspace_id, worker_id, kind, request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_coordination_events_pending
      ON coordination_events (workspace_id, delivery_state, sequence);

    CREATE TABLE IF NOT EXISTS worker_queue_state (
      workspace_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      pause_reason TEXT,
      paused_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, worker_id)
    );
  `)
}
