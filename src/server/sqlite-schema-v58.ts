import type { Database } from 'better-sqlite3'

export const applySchemaVersion58 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!columns.has('request_id')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN request_id TEXT')
  }
  if (!columns.has('request_fingerprint')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN request_fingerprint TEXT')
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatches_request_id
      ON dispatches (workspace_id, COALESCE(from_agent_id, ''), request_id)
      WHERE request_id IS NOT NULL;
  `)
}
