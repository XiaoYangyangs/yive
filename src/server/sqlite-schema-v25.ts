import type { Database } from 'better-sqlite3'

export const applySchemaVersion25 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(chat_submissions)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!columns.has('attachments_json')) {
    db.exec("ALTER TABLE chat_submissions ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'")
  }
  if (!columns.has('delivery_text')) {
    db.exec('ALTER TABLE chat_submissions ADD COLUMN delivery_text TEXT')
    db.exec('UPDATE chat_submissions SET delivery_text = body WHERE delivery_text IS NULL')
  }
}
