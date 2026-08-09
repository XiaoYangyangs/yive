import type { Database } from 'better-sqlite3'

import { isManagedProvider } from './managed-provider.js'
import { applySchemaVersion24 } from './sqlite-schema-v24.js'

const PROVIDER_CHECK = "NEW.provider NOT IN ('codex', 'claude')"

const installManagedProviderTriggers = (db: Database) => {
  db.exec(`
    CREATE TRIGGER managed_provider_agent_sessions_insert
    BEFORE INSERT ON agent_sessions
    WHEN NEW.provider IS NULL OR ${PROVIDER_CHECK}
    BEGIN
      SELECT RAISE(ABORT, 'unsupported managed Agent Provider');
    END;

    CREATE TRIGGER managed_provider_agent_sessions_update
    BEFORE UPDATE OF provider ON agent_sessions
    WHEN NEW.provider IS NULL OR ${PROVIDER_CHECK}
    BEGIN
      SELECT RAISE(ABORT, 'unsupported managed Agent Provider');
    END;

    CREATE TRIGGER managed_provider_session_intents_insert
    BEFORE INSERT ON agent_session_save_intents
    WHEN ${PROVIDER_CHECK}
      OR (NEW.provider = 'codex' AND NEW.capture_source != 'codex_session_jsonl_dir')
      OR (NEW.provider = 'claude' AND NEW.capture_source != 'claude_project_jsonl_dir')
    BEGIN
      SELECT RAISE(ABORT, 'unsupported managed Agent Provider Session capture');
    END;

    CREATE TRIGGER managed_provider_session_intents_update
    BEFORE UPDATE OF provider, capture_source ON agent_session_save_intents
    WHEN ${PROVIDER_CHECK}
      OR (NEW.provider = 'codex' AND NEW.capture_source != 'codex_session_jsonl_dir')
      OR (NEW.provider = 'claude' AND NEW.capture_source != 'claude_project_jsonl_dir')
    BEGIN
      SELECT RAISE(ABORT, 'unsupported managed Agent Provider Session capture');
    END;

    CREATE TRIGGER managed_provider_conversations_insert
    BEFORE INSERT ON agent_conversations
    WHEN ${PROVIDER_CHECK}
    BEGIN
      SELECT RAISE(ABORT, 'unsupported managed Agent Provider');
    END;

    CREATE TRIGGER managed_provider_conversations_update
    BEFORE UPDATE OF provider ON agent_conversations
    WHEN ${PROVIDER_CHECK}
    BEGIN
      SELECT RAISE(ABORT, 'unsupported managed Agent Provider');
    END;

    CREATE TRIGGER managed_provider_dismissed_conversations_insert
    BEFORE INSERT ON dismissed_conversations
    WHEN ${PROVIDER_CHECK}
    BEGIN
      SELECT RAISE(ABORT, 'unsupported managed Agent Provider');
    END;

    CREATE TRIGGER managed_provider_dismissed_conversations_update
    BEFORE UPDATE OF provider ON dismissed_conversations
    WHEN ${PROVIDER_CHECK}
    BEGIN
      SELECT RAISE(ABORT, 'unsupported managed Agent Provider');
    END;
  `)
}

const launchColumns = (db: Database) =>
  new Set(
    (db.prepare('PRAGMA table_info(agent_launch_configs)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )

export const applySchemaVersion56 = (db: Database) => {
  const columns = launchColumns(db)

  // Some legacy databases recorded v24 without materializing this derived-history table.
  applySchemaVersion24(db)

  if (columns.has('command_preset_id')) {
    const legacyRows = db
      .prepare(
        'SELECT workspace_id, agent_id, command, command_preset_id FROM agent_launch_configs'
      )
      .all() as Array<{
      agent_id: string
      command: string
      command_preset_id: string | null
      workspace_id: string
    }>

    const trustedRows = legacyRows.filter((row) => {
      const provider = row.command_preset_id
      const command = row.command
        .split(/[\\/]/u)
        .pop()
        ?.toLowerCase()
        .replace(/\.(?:cmd|bat|exe)$/u, '')
      return isManagedProvider(provider) && command === provider
    })

    db.exec('ALTER TABLE agent_launch_configs RENAME TO agent_launch_configs_legacy_v56')
    db.exec(`
      CREATE TABLE agent_launch_configs (
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      )
    `)
    const insert = db.prepare(
      'INSERT INTO agent_launch_configs (workspace_id, agent_id, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    for (const row of trustedRows) {
      insert.run(row.workspace_id, row.agent_id, row.command_preset_id, Date.now(), Date.now())
    }
    db.exec('DROP TABLE agent_launch_configs_legacy_v56')
  } else if (!columns.has('provider')) {
    db.exec('DROP TABLE IF EXISTS agent_launch_configs')
    db.exec(`
      CREATE TABLE agent_launch_configs (
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      )
    `)
  }

  db.exec(`
    DELETE FROM agent_session_save_intents
    WHERE provider NOT IN ('codex', 'claude')
      OR (provider = 'codex' AND capture_source != 'codex_session_jsonl_dir')
      OR (provider = 'claude' AND capture_source != 'claude_project_jsonl_dir')
      OR NOT EXISTS (
        SELECT 1
        FROM agent_launch_configs AS config
        WHERE config.workspace_id = agent_session_save_intents.workspace_id
          AND config.agent_id = agent_session_save_intents.agent_id
          AND config.provider = agent_session_save_intents.provider
      );

    DELETE FROM agent_sessions
    WHERE provider IS NULL
      OR provider NOT IN ('codex', 'claude')
      OR NOT EXISTS (
        SELECT 1
        FROM agent_launch_configs AS config
        WHERE config.workspace_id = agent_sessions.workspace_id
          AND config.agent_id = agent_sessions.agent_id
          AND config.provider = agent_sessions.provider
      );

    UPDATE workers
    SET last_session_id = NULL
    WHERE last_session_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM agent_sessions AS session
        WHERE session.workspace_id = workers.workspace_id
          AND session.agent_id = workers.id
          AND session.last_session_id = workers.last_session_id
      );

    DELETE FROM agent_conversations
    WHERE provider NOT IN ('codex', 'claude')
      OR NOT EXISTS (
        SELECT 1
        FROM agent_launch_configs AS config
        WHERE config.workspace_id = agent_conversations.workspace_id
          AND config.agent_id = agent_conversations.agent_id
          AND config.provider = agent_conversations.provider
      );

    DELETE FROM dismissed_conversations
    WHERE provider NOT IN ('codex', 'claude')
      OR NOT EXISTS (
        SELECT 1
        FROM agent_launch_configs AS config
        WHERE config.workspace_id = dismissed_conversations.workspace_id
          AND config.agent_id = dismissed_conversations.agent_id
          AND config.provider = dismissed_conversations.provider
      );
    DROP TABLE IF EXISTS command_presets;
  `)

  installManagedProviderTriggers(db)
}
