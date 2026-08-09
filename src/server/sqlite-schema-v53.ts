import type { Database } from 'better-sqlite3'

export const applySchemaVersion53 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(agent_sessions)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!columns.has('provider')) {
    db.exec('ALTER TABLE agent_sessions ADD COLUMN provider TEXT')
  }
  db.exec(`
    UPDATE agent_sessions
    SET provider = COALESCE(
      (
        SELECT intent.provider
        FROM agent_session_save_intents AS intent
        WHERE intent.workspace_id = agent_sessions.workspace_id
          AND intent.agent_id = agent_sessions.agent_id
          AND intent.session_id = agent_sessions.last_session_id
      ),
      (
        SELECT CASE
          WHEN config.command_preset_id IN ('codex', 'claude') THEN config.command_preset_id
          WHEN config.session_id_capture_json LIKE '%codex_session_jsonl_dir%' THEN 'codex'
          WHEN config.session_id_capture_json LIKE '%claude_project_jsonl_dir%' THEN 'claude'
          ELSE NULL
        END
        FROM agent_launch_configs AS config
        WHERE config.workspace_id = agent_sessions.workspace_id
          AND config.agent_id = agent_sessions.agent_id
      )
    )
    WHERE provider IS NULL;
  `)
}
