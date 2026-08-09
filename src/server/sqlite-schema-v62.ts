import type { Database } from 'better-sqlite3'

/** v62: Persist recoverable cancellation and replacement lifecycle operations. */
export const applySchemaVersion62 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  const additions = [
    ['operation_kind', 'TEXT'],
    ['operation_state', 'TEXT'],
    ['operation_error', 'TEXT'],
    ['operation_request_id', 'TEXT'],
    ['operation_request_fingerprint', 'TEXT'],
    ['operation_reason', 'TEXT'],
    ['operation_session_id', 'TEXT'],
    ['operation_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['operation_requested_at', 'INTEGER'],
    ['operation_updated_at', 'INTEGER'],
    ['pending_replacement_id', 'TEXT'],
  ] as const
  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE dispatches ADD COLUMN ${name} ${definition}`)
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatches_operation_request
      ON dispatches (workspace_id, operation_request_id)
      WHERE operation_request_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_dispatches_operation_state
      ON dispatches (operation_state, operation_updated_at);
  `)
}
