import type { Database } from 'better-sqlite3'

export const applySchemaVersion55 = (db: Database) => {
  const workspaceColumns = new Set(
    (db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )

  if (!workspaceColumns.has('orchestrator_name')) {
    db.exec(
      "ALTER TABLE workspaces ADD COLUMN orchestrator_name TEXT NOT NULL DEFAULT 'Orchestrator'"
    )
  }
}
