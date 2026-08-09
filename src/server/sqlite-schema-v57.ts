import type { Database } from 'better-sqlite3'

export const applySchemaVersion57 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!columns.has('process_state')) {
    db.exec(`
      ALTER TABLE agent_runs
      ADD COLUMN process_state TEXT NOT NULL DEFAULT 'stopped'
        CHECK (process_state IN ('running', 'stopped', 'crashed'));

      UPDATE agent_runs
      SET process_state = 'crashed';
    `)
  }

  db.exec(`
    UPDATE dispatches AS candidate
    SET status = 'queued',
        delivered_at = NULL,
        submitted_at = NULL
    WHERE candidate.status = 'submitted'
      AND EXISTS (
        SELECT 1
        FROM dispatches AS earlier
        WHERE earlier.workspace_id = candidate.workspace_id
          AND earlier.to_agent_id = candidate.to_agent_id
          AND earlier.status = 'submitted'
          AND earlier.sequence < candidate.sequence
      );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatches_one_submitted_per_worker
      ON dispatches (workspace_id, to_agent_id)
      WHERE status = 'submitted';
  `)
}
