import type { Database } from 'better-sqlite3'

/** v61: Dispatch replacements preserve FIFO position and immutable audit links. */
export const applySchemaVersion61 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!columns.has('queue_position')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN queue_position INTEGER')
  }
  if (!columns.has('replaced_by')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN replaced_by TEXT')
  }
  if (!columns.has('replaces_dispatch_id')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN replaces_dispatch_id TEXT')
  }

  db.exec(`
    UPDATE dispatches
    SET queue_position = sequence
    WHERE queue_position IS NULL;

    CREATE INDEX IF NOT EXISTS idx_dispatches_queue_position
      ON dispatches (workspace_id, to_agent_id, status, queue_position, sequence);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatches_replaced_by
      ON dispatches (replaced_by)
      WHERE replaced_by IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatches_replaces_dispatch
      ON dispatches (replaces_dispatch_id)
      WHERE replaces_dispatch_id IS NOT NULL;
  `)
}
