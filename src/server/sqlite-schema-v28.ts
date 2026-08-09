import type { Database } from 'better-sqlite3'

export const applySchemaVersion28 = (db: Database) => {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_sessions'")
    .get()
  if (!table) return

  const columns = new Set(
    (db.prepare('PRAGMA table_info(agent_sessions)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!columns.has('saved_at')) {
    db.exec('ALTER TABLE agent_sessions ADD COLUMN saved_at INTEGER')
  }
}
