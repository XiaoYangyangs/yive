import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import {
  createMobileFileExchangeItemFromWorkspacePath,
  getMobileFileExchangeItem,
} from '../../src/server/routes-file-exchange.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []

const countPreservedRecords = (database: Database.Database) => {
  const tables = new Set(
    (
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string
      }>
    ).map((row) => row.name)
  )
  const agentTable = tables.has('agents') ? 'agents' : 'workers'
  return {
    agents: database.prepare(`SELECT COUNT(*) AS count FROM ${agentTable}`).get(),
    conversations: database.prepare('SELECT COUNT(*) AS count FROM agent_conversations').get(),
    dispatches: database.prepare('SELECT COUNT(*) AS count FROM dispatches').get(),
    messages: database.prepare('SELECT COUNT(*) AS count FROM messages').get(),
    chatSubmissions: database.prepare('SELECT COUNT(*) AS count FROM chat_submissions').get(),
    dispatchNotes: database.prepare('SELECT COUNT(*) AS count FROM dispatch_notes').get(),
    runs: database.prepare('SELECT COUNT(*) AS count FROM agent_runs').get(),
    toolActivity: database
      .prepare('SELECT COUNT(*) AS count FROM conversation_tool_activity')
      .get(),
    turns: database.prepare('SELECT COUNT(*) AS count FROM conversation_turns').get(),
    workspaces: database.prepare('SELECT COUNT(*) AS count FROM workspaces').get(),
  }
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { force: true, recursive: true })
})

describe('retired Workspace file cleanup during Runtime startup', () => {
  test('preserves Runtime records and unrelated Workspace data', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'yive-retired-workspace-runtime-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(join(workspacePath, '.hive'), { recursive: true })

    const first = createRuntimeStore({ dataDir })
    const workspace = first.createWorkspace(workspacePath, 'Preserved Workspace')
    const worker = first.addWorker(workspace.id, { name: 'Preserved Worker' })
    const dispatch = await first.dispatchTask(workspace.id, worker.id, 'Preserve this Dispatch')
    const note = await first.appendDispatchNote(workspace.id, {
      actorId: 'user',
      actorType: 'user',
      artifacts: [],
      dispatchId: dispatch.id,
      id: 'note-preserved',
      text: 'Preserve this Dispatch Note',
    })
    const exchangeSourcePath = join(workspacePath, 'preserved.md')
    writeFileSync(exchangeSourcePath, 'preserved file exchange\n', 'utf8')
    const exchangeItem = createMobileFileExchangeItemFromWorkspacePath({
      store: first,
      workspaceId: workspace.id,
      workspacePath: 'preserved.md',
    })
    await first.close()

    const databasePath = join(dataDir, 'runtime.sqlite')
    const database = new Database(databasePath)
    database
      .prepare(
        `INSERT INTO agent_runs
         (run_id, agent_id, pid, status, process_state, exit_code, started_at, ended_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('run-preserved', worker.id, 42, 'exited', 'stopped', 0, 10, 20, 10, 20)
    database
      .prepare(
        `INSERT INTO agent_conversations
         (id, workspace_id, agent_id, provider, cli_session_id, source_path,
          recording_boundary, source_checkpoint, active, stale, created_at, updated_at, activity_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'conversation-preserved',
        workspace.id,
        worker.id,
        'codex',
        'session-preserved',
        'provider-session.jsonl',
        1,
        2,
        1,
        0,
        30,
        31,
        'idle'
      )
    database
      .prepare(
        `INSERT INTO conversation_turns
         (conversation_id, provider_event_id, role, text, created_at, source_checkpoint)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('conversation-preserved', 'turn-preserved', 'assistant', 'Preserved reply', 32, 2)
    database
      .prepare(
        `INSERT INTO conversation_tool_activity
         (conversation_id, provider_event_id, label, status, started_at, completed_at, source_checkpoint)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('conversation-preserved', 'tool-preserved', 'exec', 'completed', 33, 34, 2)
    database
      .prepare(
        `INSERT INTO chat_submissions
         (id, conversation_id, body, delivery_text, confirmation_text, attachments_json,
          state, accepted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`
      )
      .run(
        'submission-preserved',
        'conversation-preserved',
        'Preserved attachment message',
        'Preserved attachment message',
        'Preserved attachment message',
        JSON.stringify([
          {
            artifact: '.hive/chat-attachments/submission-preserved/attachment-preserved.png',
            file_id: 'attachment-preserved',
            mime_type: 'image/png',
            name: 'preserved.png',
            placeholder: '[Image #1]',
            size: 8,
          },
        ]),
        35,
        35
      )
    database
      .prepare(
        `UPDATE dispatches
         SET status = 'reported', reported_at = ?, report_text = ?, artifacts = ?
         WHERE id = ?`
      )
      .run(36, 'Preserved Dispatch Report', '["artifact.txt"]', dispatch.id)
    const countsBefore = countPreservedRecords(database)
    database.close()

    writeFileSync(join(workspacePath, '.hive', 'tasks.md'), '- [ ] retired\n', 'utf8')
    writeFileSync(join(workspacePath, 'tasks.md'), 'root file stays\n', 'utf8')
    const attachmentReference =
      '.hive/chat-attachments/submission-preserved/attachment-preserved.png'
    const attachmentPath = join(workspacePath, ...attachmentReference.split('/'))
    mkdirSync(join(workspacePath, '.hive', 'chat-attachments', 'submission-preserved'), {
      recursive: true,
    })
    writeFileSync(attachmentPath, Buffer.from('89504e470d0a1a0a', 'hex'))
    writeFileSync(
      join(workspacePath, '.hive', 'mobile-attachments.json'),
      JSON.stringify({
        attachments: [
          {
            artifact: attachmentReference,
            created_at: 35,
            file_id: 'attachment-preserved',
            local_path: attachmentPath,
            mime_type: 'image/png',
            name: 'preserved.png',
            placeholder: '[Image #1]',
            size: 8,
          },
        ],
        updated_at: 35,
      }),
      'utf8'
    )
    writeFileSync(join(workspacePath, 'artifact.txt'), 'preserved artifact\n', 'utf8')

    const second = createRuntimeStore({ dataDir })
    try {
      expect(second.listWorkspaces()).toEqual([workspace])
      expect(second.listWorkers(workspace.id)).toEqual([
        expect.objectContaining({ id: worker.id, name: 'Preserved Worker' }),
      ])
      expect(second.listDispatches(workspace.id)).toEqual([
        expect.objectContaining({
          artifacts: ['artifact.txt'],
          id: dispatch.id,
          reportText: 'Preserved Dispatch Report',
          status: 'reported',
          text: 'Preserve this Dispatch',
        }),
      ])
      expect(second.listDispatchNotes(workspace.id, dispatch.id)).toEqual([
        expect.objectContaining({
          id: note.note.id,
          text: 'Preserve this Dispatch Note',
        }),
      ])
      expect(second.listAgentRuns(worker.id)).toEqual([
        expect.objectContaining({ runId: 'run-preserved', status: 'exited' }),
      ])
      expect(second.listAgentConversations(workspace.id, worker.id).items).toEqual([
        expect.objectContaining({ id: 'conversation-preserved' }),
      ])
      expect(
        second.getAgentConversation(workspace.id, worker.id, 'conversation-preserved')
      ).toEqual(
        expect.objectContaining({
          submissions: [
            expect.objectContaining({
              attachments: [
                expect.objectContaining({
                  file_id: 'attachment-preserved',
                  name: 'preserved.png',
                }),
              ],
              id: 'submission-preserved',
            }),
          ],
        })
      )
    } finally {
      await second.close()
    }

    const reopenedDatabase = new Database(databasePath, { readonly: true })
    const countsAfter = countPreservedRecords(reopenedDatabase)
    reopenedDatabase.close()

    expect(countsAfter).toEqual(countsBefore)
    expect(existsSync(join(workspacePath, '.hive', 'tasks.md'))).toBe(false)
    expect(readFileSync(join(workspacePath, 'tasks.md'), 'utf8')).toBe('root file stays\n')
    expect(
      JSON.parse(readFileSync(join(workspacePath, '.hive', 'mobile-attachments.json'), 'utf8'))
    ).toEqual({
      attachments: [
        {
          artifact: attachmentReference,
          created_at: 35,
          file_id: 'attachment-preserved',
          local_path: attachmentPath,
          mime_type: 'image/png',
          name: 'preserved.png',
          placeholder: '[Image #1]',
          size: 8,
        },
      ],
      updated_at: 35,
    })
    const preservedExchangeItem = getMobileFileExchangeItem(exchangeItem.id)
    expect(preservedExchangeItem).toEqual(
      expect.objectContaining({
        id: exchangeItem.id,
        name: 'preserved.md',
        source: 'workspace',
      })
    )
    expect(preservedExchangeItem?.localPath).toBeTruthy()
    expect(readFileSync(preservedExchangeItem?.localPath ?? '', 'utf8')).toBe(
      'preserved file exchange\n'
    )
    expect(readFileSync(join(workspacePath, 'artifact.txt'), 'utf8')).toBe('preserved artifact\n')
  })

  test('does not block Runtime startup when a retired path is a directory', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'yive-retired-workspace-directory-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(join(workspacePath, '.hive'), { recursive: true })

    const first = createRuntimeStore({ dataDir })
    const workspace = first.createWorkspace(workspacePath, 'Directory Workspace')
    await first.close()

    const tasksPath = join(workspacePath, '.hive', 'tasks.md')
    mkdirSync(tasksPath)
    writeFileSync(join(tasksPath, 'keep.txt'), 'directory data stays\n', 'utf8')

    const second = createRuntimeStore({ dataDir })
    try {
      expect(second.listWorkspaces()).toEqual([workspace])
      expect(readFileSync(join(tasksPath, 'keep.txt'), 'utf8')).toBe('directory data stays\n')
    } finally {
      await second.close()
    }
  })
})
