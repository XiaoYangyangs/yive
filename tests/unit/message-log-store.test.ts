import { describe, expect, test } from 'vitest'

import { DataCorruptionError } from '../../src/server/http-errors.js'
import { createMessageLogStore } from '../../src/server/message-log-store.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'

describe('message log status lifecycle metadata', () => {
  test('fails explicitly when persisted lifecycle metadata is corrupt', () => {
    const db = openRuntimeDatabase()
    try {
      db.prepare(
        `INSERT INTO messages (
          workspace_id, worker_id, type, from_agent_id, text, status, created_at
        ) VALUES (?, ?, 'status', ?, ?, ?, ?)`
      ).run('workspace-1', 'worker-1', 'worker-1', 'broken', 'not-json', 1)

      expect(() => createMessageLogStore(db).getLatestStatus('workspace-1', 'worker-1')).toThrow(
        DataCorruptionError
      )
    } finally {
      db.close()
    }
  })
})
