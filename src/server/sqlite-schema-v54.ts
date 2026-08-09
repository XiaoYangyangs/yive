import type { Database } from 'better-sqlite3'

export const applySchemaVersion54 = (db: Database) => {
  const workerColumns = new Set(
    (db.prepare('PRAGMA table_info(workers)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )

  if (workerColumns.has('role') || workerColumns.has('description')) {
    db.exec(`
      ALTER TABLE workers RENAME TO workers_legacy_v54;

      CREATE TABLE workers (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        last_session_id TEXT,
        created_at INTEGER NOT NULL
      );

      INSERT INTO workers (id, workspace_id, name, last_session_id, created_at)
      SELECT id, workspace_id, name, last_session_id, created_at
      FROM workers_legacy_v54;

      DROP TABLE workers_legacy_v54;
    `)
  }

  db.exec('DROP TABLE IF EXISTS role_templates')
}
