import Database from 'better-sqlite3'

/**
 * Builds a fixed v52 database instead of calling the current initializer first.
 * That keeps the migration contract meaningful after the Issue 02 migration lands.
 */
export const createLegacyAgentIdentityV52Database = (): Database.Database => {
  const db = new Database(':memory:')

  db.exec(`
    PRAGMA foreign_keys = OFF;

    CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE workers (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      last_session_id TEXT,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE agent_launch_configs (
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL,
      command_preset_id TEXT,
      interactive_command TEXT,
      preset_augmentation_disabled INTEGER NOT NULL DEFAULT 0,
      resume_args_template TEXT,
      session_id_capture_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, agent_id)
    );
    CREATE TABLE agent_runs (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      pid INTEGER,
      status TEXT NOT NULL,
      exit_code INTEGER,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_sessions (
      agent_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      last_session_id TEXT NOT NULL,
      saved_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, agent_id)
    );
    CREATE TABLE agent_conversations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      cli_session_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      recording_boundary INTEGER NOT NULL,
      source_checkpoint INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      stale INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      activity_state TEXT NOT NULL DEFAULT 'unknown'
    );
    CREATE TABLE conversation_turns (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      source_checkpoint INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE conversation_tool_activity (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      source_checkpoint INTEGER NOT NULL
    );
    CREATE TABLE dispatches (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      from_agent_id TEXT,
      to_agent_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      submitted_at INTEGER,
      reported_at INTEGER,
      report_text TEXT,
      artifacts TEXT
    );
    CREATE TABLE dispatch_notes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      text TEXT NOT NULL,
      artifacts_json TEXT NOT NULL,
      delivery_mode TEXT NOT NULL,
      delivery_state TEXT NOT NULL,
      delivered_at INTEGER,
      delivery_error TEXT,
      acknowledged_at INTEGER,
      acknowledged_by_agent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      type TEXT NOT NULL,
      from_agent_id TEXT,
      to_agent_id TEXT,
      text TEXT,
      status TEXT,
      artifacts TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE role_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role_type TEXT NOT NULL,
      description TEXT NOT NULL,
      default_command TEXT NOT NULL,
      default_args TEXT NOT NULL,
      default_env TEXT NOT NULL,
      is_builtin INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  const insertVersion = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
  for (let version = 1; version <= 52; version += 1) insertVersion.run(version, version)

  db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
    'ws-identity',
    'Identity Fixture',
    'C:/identity-fixture',
    100
  )
  db.prepare(
    `INSERT INTO workers
     (id, workspace_id, name, description, last_session_id, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'worker-coder',
    'ws-identity',
    'Builder',
    'Legacy builder description',
    'session-coder',
    'coder',
    101
  )
  db.prepare(
    `INSERT INTO workers
     (id, workspace_id, name, description, last_session_id, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'worker-tester',
    'ws-identity',
    'Verifier',
    'Legacy tester description',
    'session-tester',
    'tester',
    102
  )
  db.prepare(
    `INSERT INTO agent_launch_configs
     (workspace_id, agent_id, command, args_json, command_preset_id,
      interactive_command, preset_augmentation_disabled, resume_args_template,
      session_id_capture_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'ws-identity',
    'worker-coder',
    'codex',
    '["--no-alt-screen"]',
    'codex',
    null,
    0,
    '--resume {session_id}',
    '{"source":"codex_session_jsonl_dir","pattern":"sessions/*.jsonl"}',
    103,
    104
  )
  db.prepare(
    `INSERT INTO agent_runs
     (run_id, agent_id, pid, status, exit_code, started_at, ended_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('run-coder', 'worker-coder', 4242, 'running', null, 105, null, 105, 106)
  db.prepare(
    `INSERT INTO agent_sessions
     (agent_id, workspace_id, last_session_id, saved_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run('worker-coder', 'ws-identity', 'session-coder', 107, 108)
  db.prepare(
    `INSERT INTO agent_conversations
     (id, workspace_id, agent_id, provider, cli_session_id, source_path,
      recording_boundary, source_checkpoint, active, stale, created_at, updated_at, activity_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'conversation-coder',
    'ws-identity',
    'worker-coder',
    'codex',
    'session-coder',
    'C:/provider/session.jsonl',
    10,
    12,
    1,
    0,
    109,
    110,
    'idle'
  )
  db.prepare(
    `INSERT INTO conversation_turns
     (conversation_id, provider_event_id, role, text, created_at, source_checkpoint)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('conversation-coder', 'turn-1', 'assistant', 'Preserved reply', 111, 12)
  db.prepare(
    `INSERT INTO conversation_tool_activity
     (conversation_id, provider_event_id, label, status, started_at, completed_at, source_checkpoint)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('conversation-coder', 'tool-1', 'exec', 'completed', 112, 113, 12)
  db.prepare(
    `INSERT INTO dispatches
     (id, workspace_id, from_agent_id, to_agent_id, text, status, created_at,
      delivered_at, submitted_at, reported_at, report_text, artifacts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'dispatch-1',
    'ws-identity',
    'ws-identity:orchestrator',
    'worker-coder',
    'Preserve this dispatch',
    'reported',
    114,
    115,
    116,
    117,
    'Preserved report',
    '["result.md"]'
  )
  db.prepare(
    `INSERT INTO dispatch_notes
     (id, workspace_id, dispatch_id, actor_type, actor_id, text, artifacts_json,
      delivery_mode, delivery_state, delivered_at, delivery_error, acknowledged_at,
      acknowledged_by_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'note-1',
    'ws-identity',
    'dispatch-1',
    'orchestrator',
    'ws-identity:orchestrator',
    'Preserved note',
    '[]',
    'passive',
    'delivered',
    118,
    null,
    119,
    'worker-coder',
    118,
    119
  )
  db.prepare(
    `INSERT INTO messages
     (workspace_id, worker_id, type, from_agent_id, to_agent_id, text, status, artifacts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'ws-identity',
    'worker-coder',
    'status',
    'worker-coder',
    null,
    'Preserved status history',
    null,
    '[]',
    120
  )
  db.prepare(
    `INSERT INTO role_templates
     (id, name, role_type, description, default_command, default_args, default_env,
      is_builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('custom-legacy', 'Legacy Custom', 'custom', 'Retire me', 'codex', '[]', '{}', 0, 121, 122)

  return db
}
