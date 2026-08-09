import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const path of tempDirs.splice(0)) rmSync(path, { force: true, recursive: true })
})

describe('managed Agent Provider contract', () => {
  test('migrates trusted configs and never guesses a Provider for retired launch state', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'yive-provider-migration-'))
    tempDirs.push(dataDir)
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    initializeRuntimeDatabase(db)
    db.prepare('DELETE FROM schema_version WHERE version = 56').run()
    const providerTriggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'managed_provider_%'"
      )
      .all() as Array<{ name: string }>
    for (const trigger of providerTriggers) db.exec(`DROP TRIGGER ${trigger.name}`)
    db.exec(`
      INSERT INTO workspaces (id, name, path, orchestrator_name, created_at)
      VALUES ('ws', 'Legacy Providers', '${dataDir.replaceAll("'", "''")}', 'Orchestrator', 1);
      INSERT INTO workers (id, workspace_id, name, last_session_id, created_at)
      VALUES
        ('gemini-agent', 'ws', 'Gemini', 'gemini-session', 1);
      DROP TABLE agent_launch_configs;
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
      INSERT INTO agent_launch_configs VALUES
        ('ws', 'codex-agent', 'codex', '[]', 'codex', NULL, 0, NULL, NULL, 1, 1),
        ('ws', 'claude-agent', 'claude', '[]', 'claude', NULL, 0, NULL, NULL, 1, 1),
        ('ws', 'mismatch-agent', 'codex', '[]', 'codex', NULL, 0, NULL, NULL, 1, 1),
        ('ws', 'gemini-agent', 'gemini', '[]', 'gemini', NULL, 0, NULL, NULL, 1, 1),
        ('ws', 'ws:orchestrator', 'gemini', '[]', 'gemini', NULL, 0, NULL, NULL, 1, 1),
        ('ws', 'custom-agent', 'node', '["custom.js"]', NULL, NULL, 1, NULL, NULL, 1, 1);
      INSERT INTO agent_sessions
        (agent_id, workspace_id, provider, last_session_id, saved_at, updated_at)
      VALUES
        ('codex-agent', 'ws', 'codex', 'codex-session', 1, 1),
        ('mismatch-agent', 'ws', 'gemini', 'mismatch-session', 1, 1),
        ('gemini-agent', 'ws', NULL, 'gemini-session', 1, 1),
        ('ws:orchestrator', 'ws', NULL, 'orchestrator-session', 1, 1);
      INSERT INTO agent_session_save_intents
        (workspace_id, agent_id, request_id, run_id, provider, capture_source, state,
         previous_session_id, session_id, failure_reason, requested_at, updated_at)
      VALUES
        ('ws', 'codex-agent', 'request-codex', 'run-codex', 'codex',
         'codex_session_jsonl_dir', 'saved', NULL, 'codex-session', NULL, 1, 1),
        ('ws', 'mismatch-agent', 'request-mismatch', 'run-mismatch', 'gemini',
         'gemini_session_json_dir', 'saved', NULL, 'mismatch-session', NULL, 1, 1);
      INSERT INTO agent_conversations
        (id, workspace_id, agent_id, provider, cli_session_id, source_path,
         recording_boundary, source_checkpoint, activity_state, active, stale, created_at,
         updated_at)
      VALUES
        ('conversation-codex', 'ws', 'codex-agent', 'codex', 'codex-session', 'codex.jsonl',
         0, 1, 'idle', 1, 0, 1, 1),
        ('conversation-custom', 'ws', 'custom-agent', 'codex', 'custom-session', 'custom.jsonl',
         0, 1, 'idle', 1, 0, 1, 1),
        ('conversation-gemini', 'ws', 'gemini-agent', 'gemini', 'gemini-session', 'gemini.json',
         0, 1, 'idle', 1, 0, 1, 1);
      INSERT INTO conversation_turns
        (conversation_id, provider_event_id, role, text, created_at, source_checkpoint)
      VALUES
        ('conversation-codex', 'turn-codex', 'assistant', 'preserved', 1, 1),
        ('conversation-custom', 'turn-custom', 'assistant', 'retired custom', 1, 1),
        ('conversation-gemini', 'turn-gemini', 'assistant', 'retired', 1, 1);
      INSERT INTO conversation_tool_activity
        (conversation_id, provider_event_id, label, status, started_at, completed_at,
         source_checkpoint)
      VALUES
        ('conversation-codex', 'tool-codex', 'Preserved tool', 'completed', 1, 1, 1),
        ('conversation-custom', 'tool-custom', 'Retired custom tool', 'completed', 1, 1, 1),
        ('conversation-gemini', 'tool-gemini', 'Retired tool', 'completed', 1, 1, 1);
      INSERT INTO dismissed_conversations
        (workspace_id, agent_id, provider, cli_session_id, dismissed_at)
      VALUES
        ('ws', 'codex-agent', 'codex', 'dismissed-codex', 1),
        ('ws', 'custom-agent', 'codex', 'dismissed-custom', 1),
        ('ws', 'gemini-agent', 'gemini', 'dismissed-gemini', 1);
    `)

    initializeRuntimeDatabase(db)

    expect(db.prepare('PRAGMA table_info(agent_launch_configs)').all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'provider' })])
    )
    const columns = (
      db.prepare('PRAGMA table_info(agent_launch_configs)').all() as Array<{
        name: string
      }>
    ).map((column) => column.name)
    expect(columns).toEqual(['workspace_id', 'agent_id', 'provider', 'created_at', 'updated_at'])
    expect(
      db.prepare('SELECT agent_id, provider FROM agent_launch_configs ORDER BY agent_id').all()
    ).toEqual([
      { agent_id: 'claude-agent', provider: 'claude' },
      { agent_id: 'codex-agent', provider: 'codex' },
      { agent_id: 'mismatch-agent', provider: 'codex' },
    ])
    expect(
      db.prepare('SELECT agent_id, provider, last_session_id FROM agent_sessions').all()
    ).toEqual([{ agent_id: 'codex-agent', last_session_id: 'codex-session', provider: 'codex' }])
    expect(
      db.prepare('SELECT agent_id, provider, capture_source FROM agent_session_save_intents').all()
    ).toEqual([
      {
        agent_id: 'codex-agent',
        capture_source: 'codex_session_jsonl_dir',
        provider: 'codex',
      },
    ])
    expect(db.prepare('SELECT id, provider FROM agent_conversations ORDER BY id').all()).toEqual([
      { id: 'conversation-codex', provider: 'codex' },
    ])
    expect(db.prepare('SELECT text FROM conversation_turns').all()).toEqual([{ text: 'preserved' }])
    expect(db.prepare('SELECT label FROM conversation_tool_activity').all()).toEqual([
      { label: 'Preserved tool' },
    ])
    expect(db.prepare('SELECT provider FROM dismissed_conversations').all()).toEqual([
      { provider: 'codex' },
    ])
    expect(db.prepare('SELECT id, last_session_id FROM workers ORDER BY id').all()).toEqual([
      { id: 'gemini-agent', last_session_id: null },
    ])
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_sessions
             (agent_id, workspace_id, provider, last_session_id, saved_at, updated_at)
           VALUES ('invalid-session', 'ws', 'gemini', 'session', 1, 1)`
        )
        .run()
    ).toThrow(/unsupported managed Agent Provider/u)
    expect(() =>
      db
        .prepare(
          `UPDATE agent_session_save_intents
           SET capture_source = 'stdout_regex'
           WHERE workspace_id = 'ws' AND agent_id = 'codex-agent'`
        )
        .run()
    ).toThrow(/unsupported managed Agent Provider Session capture/u)
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_conversations
             (id, workspace_id, agent_id, provider, cli_session_id, source_path,
              recording_boundary, source_checkpoint, activity_state, active, stale, created_at,
              updated_at)
           VALUES ('invalid-conversation', 'ws', 'gemini-agent', 'gemini', 'session', 'source',
                   0, 0, 'unknown', 1, 0, 1, 1)`
        )
        .run()
    ).toThrow(/unsupported managed Agent Provider/u)
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'command_presets'")
        .get()
    ).toBeUndefined()
    db.close()

    const server = await startTestServer({ dataDir })
    servers.push(server)
    await expect(
      server.store.autostartConfiguredAgents({ hivePort: new URL(server.baseUrl).port })
    ).resolves.toEqual([])
    expect(server.store.peekAgentLaunchConfig('ws', 'ws:orchestrator')).toBeUndefined()

    const cookie = await getUiCookie(server.baseUrl)
    const startResponse = await fetch(
      `${server.baseUrl}/api/workspaces/ws/agents/${encodeURIComponent('ws:orchestrator')}/start`,
      { headers: { cookie }, method: 'POST' }
    )
    expect(startResponse.status).toBe(500)
    expect(server.store.peekAgentLaunchConfig('ws', 'ws:orchestrator')).toBeUndefined()
  })

  test('creates Provider-bound Workers, inherits the Orchestrator Provider, and rejects legacy input atomically', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      body: JSON.stringify({
        autostart_orchestrator: false,
        name: 'Provider contract',
        path: server.dataDir,
        provider: 'codex',
      }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(workspaceResponse.status).toBe(201)
    const workspace = (await workspaceResponse.json()) as { id: string }

    const inheritedResponse = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/workers`,
      {
        body: JSON.stringify({ name: 'Inherited' }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      }
    )
    expect(inheritedResponse.status).toBe(201)
    await expect(inheritedResponse.json()).resolves.toMatchObject({ provider: 'codex' })

    const crossProviderResponse = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/workers`,
      {
        body: JSON.stringify({ name: 'Cross Provider', provider: 'claude' }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      }
    )
    expect(crossProviderResponse.status).toBe(201)
    await expect(crossProviderResponse.json()).resolves.toMatchObject({ provider: 'claude' })

    for (const body of [
      { name: 'Gemini', provider: 'gemini' },
      { name: 'Raw command', startup_command: 'node custom.js' },
      { command_preset_id: 'codex', name: 'Legacy preset' },
      { args: ['--model', 'secret'], name: 'Raw args', provider: 'codex' },
      { env: { API_KEY: 'secret' }, name: 'Raw env', provider: 'codex' },
    ]) {
      const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        code: 'unsupported_agent_provider_configuration',
        error: expect.any(String),
      })
    }

    const teamResponse = await fetch(`${server.baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
      headers: { cookie },
    })
    const workers = (await teamResponse.json()) as Array<{ name: string }>
    expect(workers.map((worker) => worker.name)).toEqual(['Inherited', 'Cross Provider'])

    const retiredSettingsResponse = await fetch(`${server.baseUrl}/api/settings/command-presets`, {
      headers: { cookie },
    })
    expect(retiredSettingsResponse.status).toBe(404)

    const arbitraryConfigResponse = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${workers[0]?.name}/config`,
      {
        body: JSON.stringify({ command: 'node', args: ['custom.js'] }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      }
    )
    expect(arbitraryConfigResponse.status).toBe(404)
  })
})
