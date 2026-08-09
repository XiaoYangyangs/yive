import type { Database } from 'better-sqlite3'

const createCoordinationEventsV63 = (db: Database) => {
  db.exec(`
    CREATE TABLE coordination_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      dispatch_id TEXT,
      worker_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('status', 'report', 'crash')),
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
  `)
}

const createPendingCoordinationEventsIndex = (db: Database) => {
  db.exec(`
    CREATE INDEX idx_coordination_events_pending
      ON coordination_events (workspace_id, delivery_state, sequence);
  `)
}

const createAgentRunExitIntentsV63 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_run_exit_intents (
      run_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('exited', 'error')),
      process_state TEXT NOT NULL CHECK (process_state IN ('stopped', 'crashed')),
      exit_code INTEGER,
      ended_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_run_exit_intents_agent
      ON agent_run_exit_intents (workspace_id, agent_id, ended_at);
  `)
}

/** v63: Allow one Dispatch-optional crash event for a managed Worker exit. */
export const applySchemaVersion63 = (db: Database) => {
  createAgentRunExitIntentsV63(db)
  const hasLegacyTable = Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coordination_events'")
      .get()
  )
  if (!hasLegacyTable) {
    createCoordinationEventsV63(db)
    createPendingCoordinationEventsIndex(db)
    return
  }

  db.exec(`
    ALTER TABLE coordination_events RENAME TO coordination_events_v62;
  `)
  createCoordinationEventsV63(db)
  db.exec(`
     INSERT INTO coordination_events (
      sequence, id, workspace_id, dispatch_id, worker_id, kind, request_id, outcome,
      text, artifacts, delivery_state, attempt_count, last_error, created_at, delivered_at
    )
    SELECT
      sequence, id, workspace_id, dispatch_id, worker_id, kind, request_id, outcome,
      text, artifacts, delivery_state, attempt_count, last_error, created_at, delivered_at
    FROM coordination_events_v62;

    DROP TABLE coordination_events_v62;
  `)
  createPendingCoordinationEventsIndex(db)
}
