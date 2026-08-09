import type { Database } from 'better-sqlite3'

import { applySchemaVersion19 } from './sqlite-schema-v19.js'
import { applySchemaVersion21 } from './sqlite-schema-v21.js'

export const applySchemaVersion22 = (db: Database) => {
  applySchemaVersion19(db)
  applySchemaVersion21(db)
  const columns = new Set(
    (db.prepare('PRAGMA table_info(agent_conversations)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (columns.has('activity_state')) return
  db.exec(`
    ALTER TABLE agent_conversations
      ADD COLUMN activity_state TEXT NOT NULL DEFAULT 'unknown'
      CHECK (activity_state IN ('busy', 'idle', 'unknown'));
  `)
}
