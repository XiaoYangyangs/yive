import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'
import {
  CURRENT_SCHEMA_VERSION,
  initializeRuntimeDatabase,
} from '../../src/server/sqlite-schema.js'

const tempDirs: string[] = []
const stores: Array<ReturnType<typeof createRuntimeStore>> = []

const RETIRED_TABLE_NAMES = [
  'candidate_acceptance_artifacts',
  'candidate_acceptance_attempt_runs',
  'candidate_acceptance_barrier_aggregates',
  'candidate_acceptance_brief_amendments',
  'candidate_acceptance_cache_entries',
  'candidate_acceptance_cache_leases',
  'candidate_acceptance_candidates',
  'candidate_acceptance_ci_runs',
  'candidate_acceptance_coder_recoveries',
  'candidate_acceptance_finding_relationships',
  'candidate_acceptance_finding_sources',
  'candidate_acceptance_findings',
  'candidate_acceptance_gate_dispatch_contexts',
  'candidate_acceptance_gate_reassignments',
  'candidate_acceptance_gates',
  'candidate_acceptance_observation_sources',
  'candidate_acceptance_observations',
  'candidate_acceptance_preflights',
  'candidate_acceptance_remediation_proposals',
  'candidate_acceptance_rounds',
  'candidate_acceptance_stale_gate_reports',
  'candidate_acceptance_workflows',
  'execution_profile_pins',
  'execution_profile_revisions',
  'execution_profiles',
  'model_providers',
  'orchestrator_wake_events',
  'provider_credentials',
  'workflow_intents',
  'workspace_role_profile_defaults',
] as const

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
  }
})

const expectDispatchSchema = (db: Database) => {
  const dispatchTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dispatches'")
    .get() as { name: string } | undefined
  const dispatchIndexes = new Set(
    (db.prepare('PRAGMA index_list(dispatches)').all() as Array<{ name: string }>).map(
      (index) => index.name
    )
  )

  expect(dispatchTable).toEqual({ name: 'dispatches' })
  expect(dispatchIndexes.has('idx_dispatches_workspace_created_at')).toBe(true)
  expect(dispatchIndexes.has('idx_dispatches_open_by_worker')).toBe(true)
  expect(dispatchIndexes.has('idx_dispatches_one_submitted_per_worker')).toBe(true)
  expect(dispatchIndexes.has('idx_dispatches_report_request_id')).toBe(true)
}

const indexColumns = (db: Database, indexName: string) =>
  (db.prepare(`PRAGMA index_info(${indexName})`).all() as Array<{ name: string }>).map(
    (column) => column.name
  )

const listRetiredTables = (db: Database) => {
  const placeholders = RETIRED_TABLE_NAMES.map(() => '?').join(', ')
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (${placeholders})
         ORDER BY name`
      )
      .all(...RETIRED_TABLE_NAMES) as Array<{ name: string }>
  ).map((row) => row.name)
}

describe('schema version', () => {
  test('runtime sqlite initializes a schema_version table', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-version-'))
    tempDirs.push(dataDir)

    stores.push(createRuntimeStore({ dataDir }))

    const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
      .get() as { name: string } | undefined

    expect(row).toEqual({ name: 'schema_version' })
    expect(
      db.prepare('SELECT version FROM schema_version WHERE version = ?').get(CURRENT_SCHEMA_VERSION)
    ).toEqual({ version: CURRENT_SCHEMA_VERSION })
    const agentRunColumns = new Set(
      (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    expect(agentRunColumns.has('process_state')).toBe(true)
    const dispatchColumns = new Set(
      (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const requestIndex = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_dispatches_request_id'"
      )
      .get()
    const statusTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_status_updates'"
      )
      .get()
    const retiredTables = listRetiredTables(db)
    db.close()
    expect(dispatchColumns.has('request_id')).toBe(true)
    expect(dispatchColumns.has('request_fingerprint')).toBe(true)
    expect(requestIndex).toEqual({ name: 'idx_dispatches_request_id' })
    expect(statusTable).toEqual({ name: 'dispatch_status_updates' })
    expect(retiredTables).toEqual([])
  })

  test('v57 conservatively marks ambiguous legacy terminal runs as crashed', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    db.prepare('DELETE FROM schema_version WHERE version = ?').run(57)
    db.exec('ALTER TABLE agent_runs DROP COLUMN process_state')
    const insert = db.prepare(
      `INSERT INTO agent_runs
       (run_id, agent_id, pid, status, exit_code, started_at, ended_at, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, 1, 2, 1, 2)`
    )
    insert.run('legacy-exited', 'agent-1', 'exited', 0)
    insert.run('legacy-error', 'agent-1', 'error', 1)
    insert.run('legacy-running', 'agent-1', 'running', null)

    initializeRuntimeDatabase(db)

    expect(
      db.prepare('SELECT run_id, process_state FROM agent_runs ORDER BY run_id').all()
    ).toEqual([
      { process_state: 'crashed', run_id: 'legacy-error' },
      { process_state: 'crashed', run_id: 'legacy-exited' },
      { process_state: 'crashed', run_id: 'legacy-running' },
    ])
    db.close()
  })

  test('v57 reconciles legacy active Dispatches and enforces one submitted row per Worker', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    db.prepare('DELETE FROM schema_version WHERE version = ?').run(57)
    db.exec('DROP INDEX IF EXISTS idx_dispatches_one_submitted_per_worker')
    const insert = db.prepare(
      `INSERT INTO dispatches
       (id, workspace_id, from_agent_id, to_agent_id, text, status, created_at, submitted_at)
       VALUES (?, 'workspace-1', 'orchestrator-1', ?, ?, 'submitted', ?, ?)`
    )
    insert.run('dispatch-1', 'worker-1', 'First delivered task', 1, 1)
    insert.run('dispatch-2', 'worker-1', 'Second delivered task', 2, 2)
    insert.run('dispatch-3', 'worker-1', 'Third delivered task', 3, 3)
    insert.run('dispatch-other', 'worker-2', 'Other Worker task', 4, 4)

    initializeRuntimeDatabase(db)

    expect(
      db
        .prepare(
          'SELECT id, status, delivered_at, submitted_at FROM dispatches ORDER BY sequence ASC'
        )
        .all() as Array<{
        delivered_at: number | null
        id: string
        status: string
        submitted_at: number | null
      }>
    ).toEqual([
      { delivered_at: null, id: 'dispatch-1', status: 'submitted', submitted_at: 1 },
      { delivered_at: null, id: 'dispatch-2', status: 'queued', submitted_at: null },
      { delivered_at: null, id: 'dispatch-3', status: 'queued', submitted_at: null },
      { delivered_at: null, id: 'dispatch-other', status: 'submitted', submitted_at: 4 },
    ])
    expect(
      (db.prepare('PRAGMA index_list(dispatches)').all() as Array<{ name: string }>).map(
        (index) => index.name
      )
    ).toContain('idx_dispatches_one_submitted_per_worker')
    expect(() =>
      db.prepare("UPDATE dispatches SET status = 'submitted' WHERE id = 'dispatch-2'").run()
    ).toThrow()
    db.close()
  })

  test('v58 adds idempotency metadata without changing existing Dispatch order or content', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    db.prepare('DELETE FROM schema_version WHERE version = ?').run(58)
    db.exec(`
      DROP INDEX IF EXISTS idx_dispatches_request_id;
      ALTER TABLE dispatches DROP COLUMN request_fingerprint;
      ALTER TABLE dispatches DROP COLUMN request_id;
    `)
    db.prepare(
      `INSERT INTO dispatches
       (id, workspace_id, from_agent_id, to_agent_id, text, status, created_at, artifacts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'legacy-dispatch',
      'workspace-1',
      'orchestrator-1',
      'worker-1',
      'Preserve this task',
      'queued',
      123,
      JSON.stringify(['src/preserved.ts'])
    )

    initializeRuntimeDatabase(db)

    expect(
      db
        .prepare(
          `SELECT id, text, status, artifacts, request_id, request_fingerprint
           FROM dispatches
           ORDER BY sequence ASC`
        )
        .all()
    ).toEqual([
      {
        artifacts: JSON.stringify(['src/preserved.ts']),
        id: 'legacy-dispatch',
        request_fingerprint: null,
        request_id: null,
        status: 'queued',
        text: 'Preserve this task',
      },
    ])
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(58)).toEqual({
      version: 58,
    })
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_dispatches_request_id'"
        )
        .get()
    ).toEqual({ name: 'idx_dispatches_request_id' })
    db.close()
  })

  test('v59 adds immutable final Report metadata without changing legacy terminal content', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    db.prepare('DELETE FROM schema_version WHERE version = ?').run(59)
    db.exec(`
      DROP TABLE IF EXISTS coordination_events;
      DROP TABLE IF EXISTS dispatch_status_updates;
      DROP TABLE IF EXISTS worker_queue_state;
      DROP INDEX IF EXISTS idx_dispatches_report_request_id;
      ALTER TABLE dispatches DROP COLUMN report_request_fingerprint;
      ALTER TABLE dispatches DROP COLUMN report_request_id;
      ALTER TABLE dispatches DROP COLUMN report_outcome;
    `)
    db.prepare(
      `INSERT INTO dispatches
       (id, workspace_id, from_agent_id, to_agent_id, text, status, created_at,
        reported_at, report_text, artifacts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'legacy-report',
      'workspace-1',
      'orchestrator-1',
      'worker-1',
      'Preserve this task',
      'reported',
      123,
      456,
      'Preserve this result',
      JSON.stringify(['src/preserved.ts'])
    )

    initializeRuntimeDatabase(db)

    expect(
      db
        .prepare(
          `SELECT id, status, reported_at, report_text, artifacts,
                  report_outcome, report_request_id, report_request_fingerprint
           FROM dispatches`
        )
        .get()
    ).toEqual({
      artifacts: JSON.stringify(['src/preserved.ts']),
      id: 'legacy-report',
      report_outcome: null,
      report_request_fingerprint: null,
      report_request_id: null,
      report_text: 'Preserve this result',
      reported_at: 456,
      status: 'reported',
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(59)).toEqual({
      version: 59,
    })
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_dispatches_report_request_id'"
        )
        .get()
    ).toEqual({ name: 'idx_dispatches_report_request_id' })
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_status_updates'"
        )
        .get()
    ).toEqual({ name: 'dispatch_status_updates' })
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coordination_events'"
        )
        .get()
    ).toEqual({ name: 'coordination_events' })
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worker_queue_state'"
        )
        .get()
    ).toEqual({ name: 'worker_queue_state' })
    db.close()
  })

  test('v52 removes retired orchestration tables without deleting general coordination data', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const foreignKeysBefore = db.pragma('foreign_keys', { simple: true })
    db.prepare('DELETE FROM schema_version WHERE version = ?').run(52)
    const insertVersion = db.prepare(
      'INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)'
    )
    for (let version = 30; version <= 51; version += 1) insertVersion.run(version, version)
    for (const table of RETIRED_TABLE_NAMES) {
      db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`)
      db.prepare(`INSERT INTO ${table} (id) VALUES (?)`).run(`legacy-${table}`)
    }

    db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
      'ws-keep',
      'Keep me',
      'C:/keep-me',
      1
    )
    db.prepare(
      `INSERT INTO dispatches
       (id, workspace_id, to_agent_id, text, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('dispatch-keep', 'ws-keep', 'worker-keep', 'Keep this task', 'queued', 2)
    db.prepare(
      `INSERT INTO dispatch_notes
       (id, workspace_id, dispatch_id, actor_type, actor_id, text, artifacts_json,
        delivery_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'note-keep',
      'ws-keep',
      'dispatch-keep',
      'user',
      'user',
      'Keep this note',
      '[]',
      'queued',
      3,
      3
    )

    initializeRuntimeDatabase(db)

    expect(listRetiredTables(db)).toEqual([])
    expect(db.prepare('SELECT name FROM workspaces WHERE id = ?').get('ws-keep')).toEqual({
      name: 'Keep me',
    })
    expect(db.prepare('SELECT text FROM dispatches WHERE id = ?').get('dispatch-keep')).toEqual({
      text: 'Keep this task',
    })
    expect(db.prepare('SELECT text FROM dispatch_notes WHERE id = ?').get('note-keep')).toEqual({
      text: 'Keep this note',
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(52)).toEqual({
      version: 52,
    })
    expect(db.pragma('foreign_keys', { simple: true })).toBe(foreignKeysBefore)
    db.close()
  })

  test('latest schema uses flat Worker records and drops retired Role templates', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-columns-'))
    tempDirs.push(dataDir)

    stores.push(createRuntimeStore({ dataDir }))

    const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    const workerColumns = new Set(
      (db.prepare('PRAGMA table_info(workers)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const agentRunColumns = new Set(
      (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const launchConfigColumns = new Set(
      (db.prepare('PRAGMA table_info(agent_launch_configs)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const appStateColumns = new Set(
      (db.prepare('PRAGMA table_info(app_state)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const messageColumns = new Set(
      (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const dispatchColumns = new Set(
      (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const chatSubmissionColumns = new Set(
      (db.prepare('PRAGMA table_info(chat_submissions)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const sessionSaveIntentColumns = new Set(
      (
        db.prepare('PRAGMA table_info(agent_session_save_intents)').all() as Array<{ name: string }>
      ).map((column) => column.name)
    )
    const dispatchNoteColumns = new Set(
      (db.prepare('PRAGMA table_info(dispatch_notes)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )

    expect(workerColumns).toEqual(
      new Set(['id', 'workspace_id', 'name', 'last_session_id', 'created_at'])
    )
    expect(agentRunColumns.has('pid')).toBe(true)
    expect(agentRunColumns.has('ended_at')).toBe(true)
    expect(launchConfigColumns).toEqual(
      new Set(['workspace_id', 'agent_id', 'provider', 'created_at', 'updated_at'])
    )
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'command_presets'")
        .get()
    ).toBeUndefined()
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_templates'")
        .get()
    ).toBeUndefined()
    expect(appStateColumns).toEqual(new Set(['key', 'value', 'updated_at']))
    expect(messageColumns.has('kind')).toBe(false)
    expect(dispatchColumns).toEqual(
      new Set([
        'sequence',
        'id',
        'workspace_id',
        'from_agent_id',
        'to_agent_id',
        'text',
        'status',
        'created_at',
        'delivered_at',
        'submitted_at',
        'reported_at',
        'report_text',
        'artifacts',
        'request_id',
        'request_fingerprint',
        'queue_position',
        'replaced_by',
        'replaces_dispatch_id',
        'report_outcome',
        'report_request_id',
        'report_request_fingerprint',
        'operation_kind',
        'operation_state',
        'operation_error',
        'operation_request_id',
        'operation_request_fingerprint',
        'operation_reason',
        'operation_session_id',
        'operation_attempts',
        'operation_requested_at',
        'operation_updated_at',
        'pending_replacement_id',
      ])
    )
    expect(dispatchNoteColumns).toEqual(
      new Set([
        'sequence',
        'id',
        'workspace_id',
        'dispatch_id',
        'actor_type',
        'actor_id',
        'text',
        'artifacts_json',
        'delivery_state',
        'delivered_at',
        'delivery_error',
        'created_at',
        'updated_at',
      ])
    )
    expect(chatSubmissionColumns).toContain('attachments_json')
    expect(chatSubmissionColumns).toContain('delivery_text')
    expect(sessionSaveIntentColumns).toEqual(
      new Set([
        'workspace_id',
        'agent_id',
        'request_id',
        'run_id',
        'provider',
        'capture_source',
        'state',
        'previous_session_id',
        'session_id',
        'failure_reason',
        'requested_at',
        'updated_at',
      ])
    )
    expectDispatchSchema(db)

    const appState = db
      .prepare('SELECT key, value FROM app_state WHERE key = ?')
      .get('active_workspace_id') as { key: string; value: string | null } | undefined

    expect(appState).toEqual({ key: 'active_workspace_id', value: null })

    db.close()
  })

  test('migration removes legacy Role templates from v11 databases', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-role-template-descriptions-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version, applied_at)
      VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9), (10, 10), (11, 11);

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
    const insert = db.prepare(
      `INSERT INTO role_templates (
        id,
        name,
        role_type,
        description,
        default_command,
        default_args,
        default_env,
        is_builtin,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const [id, name, roleType, description] of [
      ['orchestrator', 'Orchestrator', 'orchestrator', 'old orch'],
      ['coder', 'Coder', 'coder', 'old coder'],
      ['reviewer', 'Reviewer', 'reviewer', 'old reviewer'],
      ['tester', 'Tester', 'tester', 'old tester'],
    ] as const) {
      insert.run(id, name, roleType, description, 'claude', '[]', '{}', 1, 1, 1)
    }

    initializeRuntimeDatabase(db)

    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_templates'")
        .get()
    ).toBeUndefined()
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(12)).toEqual({
      version: 12,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(13)).toEqual({
      version: 13,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(14)).toEqual({
      version: 14,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(54)).toEqual({
      version: 54,
    })
    expectDispatchSchema(db)

    db.close()
  })

  test('migration removes legacy Role templates from v12 databases', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-v13-role-template-descriptions-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version, applied_at)
      VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9), (10, 10), (11, 11), (12, 12);

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

      INSERT INTO role_templates (
        id,
        name,
        role_type,
        description,
        default_command,
        default_args,
        default_env,
        is_builtin,
        created_at,
        updated_at
      )
      VALUES (
        'orchestrator',
        'Orchestrator',
        'orchestrator',
        '你是 Hive 的 Orchestrator。维护 tasks.md。',
        'claude',
        '[]',
        '{}',
        1,
        1,
        1
      );
    `)

    initializeRuntimeDatabase(db)

    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_templates'")
        .get()
    ).toBeUndefined()
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(13)).toEqual({
      version: 13,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(14)).toEqual({
      version: 14,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(54)).toEqual({
      version: 54,
    })
    expectDispatchSchema(db)

    db.close()
  })

  test('migration backfills dispatch ledger from legacy send and report messages', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-v14-dispatch-backfill-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version, applied_at)
      VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9), (10, 10), (11, 11), (12, 12), (13, 13);

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
    `)
    const insert = db.prepare(
      `INSERT INTO messages (
         workspace_id,
         worker_id,
         type,
         from_agent_id,
         to_agent_id,
         text,
         status,
         artifacts,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    insert.run('ws-1', 'worker-1', 'send', 'orch-1', 'worker-1', 'task 1', null, null, 100)
    insert.run('ws-1', 'worker-1', 'send', 'orch-1', 'worker-1', 'task 2', null, null, 200)
    insert.run(
      'ws-1',
      'worker-1',
      'report',
      'worker-1',
      'orch-1',
      'done 1',
      null,
      JSON.stringify(['src/a.ts']),
      300
    )

    initializeRuntimeDatabase(db)

    const dispatches = db
      .prepare(
        'SELECT workspace_id, to_agent_id, text, status, reported_at, report_text, artifacts FROM dispatches ORDER BY sequence'
      )
      .all() as Array<{
      artifacts: string
      reported_at: number | null
      report_text: string | null
      status: string
      text: string
      to_agent_id: string
      workspace_id: string
    }>

    expect(dispatches).toEqual([
      {
        artifacts: JSON.stringify(['src/a.ts']),
        reported_at: 300,
        report_text: 'done 1',
        status: 'reported',
        text: 'task 1',
        to_agent_id: 'worker-1',
        workspace_id: 'ws-1',
      },
      {
        artifacts: '[]',
        reported_at: null,
        report_text: null,
        status: 'queued',
        text: 'task 2',
        to_agent_id: 'worker-1',
        workspace_id: 'ws-1',
      },
    ])
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(14)).toEqual({
      version: 14,
    })
    expectDispatchSchema(db)

    db.close()
  })

  test('migration repairs v14 dispatch tables that were created without sequence', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-v15-dispatch-sequence-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version, applied_at)
      VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9), (10, 10), (11, 11), (12, 12), (13, 13), (14, 14);

      CREATE TABLE dispatches (
        id TEXT PRIMARY KEY,
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

      CREATE INDEX idx_dispatches_workspace_created_at
        ON dispatches (workspace_id, created_at);

      CREATE INDEX idx_dispatches_open_by_worker
        ON dispatches (workspace_id, to_agent_id, status, created_at);
    `)
    db.prepare(
      `INSERT INTO dispatches (
         id,
         workspace_id,
         from_agent_id,
         to_agent_id,
         text,
         status,
         created_at,
         delivered_at,
         submitted_at,
         reported_at,
         report_text,
         artifacts
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'dispatch-2',
      'ws-1',
      'orch-1',
      'worker-1',
      'second',
      'submitted',
      200,
      210,
      220,
      null,
      null,
      '[]'
    )
    db.prepare(
      `INSERT INTO dispatches (
         id,
         workspace_id,
         from_agent_id,
         to_agent_id,
         text,
         status,
         created_at,
         delivered_at,
         submitted_at,
         reported_at,
         report_text,
         artifacts
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'dispatch-1',
      'ws-1',
      'orch-1',
      'worker-1',
      'first',
      'reported',
      100,
      110,
      120,
      130,
      'done',
      '["a.md"]'
    )

    initializeRuntimeDatabase(db)

    const dispatchColumns = new Set(
      (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const rows = db
      .prepare('SELECT sequence, id, text FROM dispatches ORDER BY sequence ASC')
      .all() as Array<{ id: string; sequence: number; text: string }>

    expect(dispatchColumns.has('sequence')).toBe(true)
    expect(rows).toEqual([
      { id: 'dispatch-1', sequence: 1, text: 'first' },
      { id: 'dispatch-2', sequence: 2, text: 'second' },
    ])
    expect(indexColumns(db, 'idx_dispatches_workspace_created_at')).toEqual([
      'workspace_id',
      'sequence',
    ])
    expect(indexColumns(db, 'idx_dispatches_open_by_worker')).toEqual([
      'workspace_id',
      'to_agent_id',
      'status',
      'sequence',
    ])
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(15)).toEqual({
      version: 15,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(16)).toEqual({
      version: 16,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(17)).toEqual({
      version: 17,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = ?').get(18)).toEqual({
      version: 18,
    })

    db.close()
  })

  test('migration upgrades legacy messages.kind data into messages.type', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-schema-migrate-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version, applied_at) VALUES (1, 1), (2, 2), (3, 3), (4, 4);

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
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        type TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT,
        text TEXT,
        status TEXT,
        artifacts TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE agent_launch_configs (
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      );

      CREATE TABLE agent_runs (
        run_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        started_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    db.prepare(
      `INSERT INTO messages (
         workspace_id,
         worker_id,
         type,
         kind,
         from_agent_id,
         to_agent_id,
         text,
         status,
         artifacts,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('ws-1', 'worker-1', 'send', 'send', 'orch-1', 'worker-1', 'hello', null, null, 123)

    initializeRuntimeDatabase(db)

    const migratedColumns = new Set(
      (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const message = db
      .prepare('SELECT type, text FROM messages WHERE workspace_id = ?')
      .get('ws-1') as { text: string; type: string } | undefined

    expect(migratedColumns.has('kind')).toBe(false)
    expect(message).toEqual({ type: 'send', text: 'hello' })
    db.close()
  })

  test('v60 removes force and acknowledgement storage while preserving legacy Notes', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
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
    `)
    const insertVersion = db.prepare(
      'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)'
    )
    for (let version = 1; version <= 59; version += 1) insertVersion.run(version, version)
    const insertNote = db.prepare(
      `INSERT INTO dispatch_notes
       (id, workspace_id, dispatch_id, actor_type, actor_id, text, artifacts_json,
        delivery_mode, delivery_state, delivered_at, acknowledged_at,
        acknowledged_by_agent_id, created_at, updated_at)
       VALUES (?, 'ws-1', 'dispatch-1', 'agent', 'orchestrator-1', ?, '[]', ?, ?, ?, ?, ?, ?, ?)`
    )
    insertNote.run(
      'note-acknowledged',
      'Preserve delivered Note',
      'force',
      'acknowledged',
      20,
      21,
      'worker-1',
      10,
      21
    )
    insertNote.run(
      'note-queued',
      'Preserve queued Note',
      'queued',
      'queued',
      null,
      null,
      null,
      30,
      30
    )

    initializeRuntimeDatabase(db)

    const columns = new Set(
      (db.prepare('PRAGMA table_info(dispatch_notes)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    expect(columns.has('delivery_mode')).toBe(false)
    expect(columns.has('acknowledged_at')).toBe(false)
    expect(columns.has('acknowledged_by_agent_id')).toBe(false)
    expect(
      db
        .prepare(
          'SELECT id, actor_id, text, delivery_state, delivered_at FROM dispatch_notes ORDER BY sequence'
        )
        .all()
    ).toEqual([
      {
        actor_id: 'orchestrator-1',
        delivered_at: 20,
        delivery_state: 'delivered',
        id: 'note-acknowledged',
        text: 'Preserve delivered Note',
      },
      {
        actor_id: 'orchestrator-1',
        delivered_at: null,
        delivery_state: 'queued',
        id: 'note-queued',
        text: 'Preserve queued Note',
      },
    ])
    expect(db.prepare('SELECT version FROM schema_version WHERE version = 60').get()).toEqual({
      version: 60,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = 63').get()).toEqual({
      version: 63,
    })
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coordination_events'"
        )
        .get()
    ).toEqual({ name: 'coordination_events' })
    db.close()
  })

  test('v61 and v62 preserve Dispatch order while adding replacement operation recovery', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
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
        artifacts TEXT,
        request_id TEXT,
        request_fingerprint TEXT,
        report_outcome TEXT,
        report_request_id TEXT,
        report_request_fingerprint TEXT
      );
    `)
    const insertVersion = db.prepare(
      'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)'
    )
    for (let version = 1; version <= 60; version += 1) insertVersion.run(version, version)
    db.prepare(
      `INSERT INTO dispatches
       (id, workspace_id, to_agent_id, text, status, created_at)
       VALUES (?, 'ws-1', 'worker-1', ?, 'queued', ?)`
    ).run('dispatch-1', 'first', 10)
    db.prepare(
      `INSERT INTO dispatches
       (id, workspace_id, to_agent_id, text, status, created_at)
       VALUES (?, 'ws-1', 'worker-1', ?, 'queued', ?)`
    ).run('dispatch-2', 'second', 20)

    initializeRuntimeDatabase(db)

    expect(
      db
        .prepare(
          `SELECT id, sequence, queue_position, replaced_by, replaces_dispatch_id,
                  operation_kind, operation_state, operation_attempts
           FROM dispatches ORDER BY sequence`
        )
        .all()
    ).toEqual([
      {
        id: 'dispatch-1',
        operation_attempts: 0,
        operation_kind: null,
        operation_state: null,
        queue_position: 1,
        replaced_by: null,
        replaces_dispatch_id: null,
        sequence: 1,
      },
      {
        id: 'dispatch-2',
        operation_attempts: 0,
        operation_kind: null,
        operation_state: null,
        queue_position: 2,
        replaced_by: null,
        replaces_dispatch_id: null,
        sequence: 2,
      },
    ])
    expect(db.prepare('SELECT version FROM schema_version WHERE version = 62').get()).toEqual({
      version: 62,
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = 63').get()).toEqual({
      version: 63,
    })
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coordination_events'"
        )
        .get()
    ).toEqual({ name: 'coordination_events' })
    db.close()
  })

  test('v63 preserves coordination events and permits a Dispatch-optional crash event', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    db.exec(`
      DROP TABLE coordination_events;
      CREATE TABLE coordination_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        dispatch_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('status', 'report')),
        request_id TEXT NOT NULL,
        outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'failed')),
        text TEXT NOT NULL,
        artifacts TEXT NOT NULL,
        delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending', 'delivering', 'delivered')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        UNIQUE (workspace_id, worker_id, kind, request_id)
      );
      CREATE INDEX idx_coordination_events_pending
        ON coordination_events (workspace_id, delivery_state, sequence);
      DELETE FROM schema_version WHERE version = 63;
    `)
    db.prepare(
      `INSERT INTO coordination_events (
         id, workspace_id, dispatch_id, worker_id, kind, request_id, outcome,
         text, artifacts, delivery_state, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'event-1',
      'workspace-1',
      'dispatch-1',
      'worker-1',
      'report',
      'report-1',
      'completed',
      'Preserve report',
      '[]',
      'pending',
      1
    )

    initializeRuntimeDatabase(db)

    expect(
      db
        .prepare(
          `SELECT id, dispatch_id, kind, text, delivery_state
           FROM coordination_events WHERE id = 'event-1'`
        )
        .get()
    ).toEqual({
      delivery_state: 'pending',
      dispatch_id: 'dispatch-1',
      id: 'event-1',
      kind: 'report',
      text: 'Preserve report',
    })
    expect(
      (
        db.prepare('PRAGMA table_info(coordination_events)').all() as Array<{
          name: string
          notnull: number
        }>
      ).find((column) => column.name === 'dispatch_id')
    ).toMatchObject({ notnull: 0 })
    db.prepare(
      `INSERT INTO coordination_events (
         id, workspace_id, dispatch_id, worker_id, kind, request_id,
         text, artifacts, delivery_state, created_at
       ) VALUES (?, ?, NULL, ?, 'crash', ?, ?, '[]', 'pending', ?)`
    ).run('event-crash', 'workspace-1', 'worker-1', 'crash:run-1', 'Process crashed.', 2)
    expect(
      db
        .prepare(
          `SELECT dispatch_id, kind, request_id
           FROM coordination_events WHERE id = 'event-crash'`
        )
        .get()
    ).toEqual({
      dispatch_id: null,
      kind: 'crash',
      request_id: 'crash:run-1',
    })
    expect(db.prepare('SELECT version FROM schema_version WHERE version = 63').get()).toEqual({
      version: 63,
    })
    db.close()
  })
})
