import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createCoordinationEventStore } from '../../src/server/coordination-event-store.js'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import { DataCorruptionError } from '../../src/server/http-errors.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { createStatusSnapshotStore } from '../../src/server/status-snapshot-store.js'

const tempDirs: string[] = []
const stores: Array<ReturnType<typeof createRuntimeStore>> = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('coordination state restart recovery', () => {
  test('fails explicitly when persisted Status or event artifacts are corrupt', () => {
    const db = openRuntimeDatabase()
    const statusStore = createStatusSnapshotStore(db)
    const eventStore = createCoordinationEventStore(db)
    const common = {
      dispatchId: 'dispatch-corrupt',
      workerId: 'worker-corrupt',
      workspaceId: 'workspace-corrupt',
    }
    try {
      statusStore.record({
        artifacts: ['valid.txt'],
        dispatchSequence: 1,
        notify: false,
        requestId: 'status-corrupt',
        text: 'status',
        ...common,
      })
      db.prepare(
        `UPDATE dispatch_status_updates SET artifacts = ?
         WHERE workspace_id = ? AND worker_id = ?`
      ).run('not-json', common.workspaceId, common.workerId)
      expect(() => statusStore.getLatest(common.workspaceId, common.workerId)).toThrow(
        DataCorruptionError
      )

      const event = eventStore.create({
        artifacts: ['valid.txt'],
        kind: 'report',
        outcome: 'completed',
        requestId: 'event-corrupt',
        text: 'report',
        ...common,
      })
      db.prepare('UPDATE coordination_events SET artifacts = ? WHERE id = ?').run(
        'not-json',
        event.id
      )
      expect(() => eventStore.listPending(common.workspaceId)).toThrow(DataCorruptionError)

      const dispatchStore = createDispatchLedgerStore(db)
      const dispatch = dispatchStore.createDispatch({
        queue: true,
        requestId: 'dispatch-corrupt-outcome',
        text: 'dispatch',
        toAgentId: common.workerId,
        workspaceId: common.workspaceId,
      })
      db.prepare('UPDATE dispatches SET report_outcome = ? WHERE id = ?').run(
        'ambiguous',
        dispatch.id
      )
      expect(() => dispatchStore.findDispatchById(common.workspaceId, dispatch.id)).toThrow(
        DataCorruptionError
      )
    } finally {
      db.close()
    }
  })

  test('requeues interrupted events and preserves Status snapshots and queue pauses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yive-coordination-restart-'))
    const workspacePath = join(root, 'workspace')
    const dataDir = join(root, 'runtime')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(root)

    const first = createRuntimeStore({ dataDir })
    const workspace = first.createWorkspace(workspacePath, 'Restart Contract')
    const worker = first.addWorker(workspace.id, { name: 'Alice' })
    await first.close()

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    const eventStore = createCoordinationEventStore(db)
    eventStore.create({
      artifacts: ['reports/restart.md'],
      dispatchId: 'dispatch-restart',
      kind: 'report',
      outcome: 'completed',
      requestId: 'report-restart-request',
      text: 'Recover this event',
      workerId: worker.id,
      workspaceId: workspace.id,
    })
    expect(eventStore.claimPending(workspace.id)).toHaveLength(1)
    createStatusSnapshotStore(db).record({
      artifacts: ['status/restart.txt'],
      dispatchId: 'dispatch-restart',
      dispatchSequence: 1,
      notify: true,
      requestId: 'status-restart-request',
      text: 'Recover this snapshot',
      workerId: worker.id,
      workspaceId: workspace.id,
    })
    db.prepare(
      `INSERT INTO worker_queue_state
       (workspace_id, worker_id, pause_reason, paused_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(workspace.id, worker.id, 'Recover this pause', 100, 100)
    db.close()

    const reopened = createRuntimeStore({ dataDir })
    stores.push(reopened)
    expect(reopened.getLatestStatus(workspace.id, worker.id)).toMatchObject({
      dispatchId: 'dispatch-restart',
      notify: true,
      requestId: 'status-restart-request',
      text: 'Recover this snapshot',
    })
    expect(reopened.getAgentState(workspace.id, worker.id)).toMatchObject({
      queuePauseReason: 'Recover this pause',
    })

    const recoveredDb = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    const recoveredEvent = recoveredDb
      .prepare(
        `SELECT delivery_state, last_error, attempt_count
         FROM coordination_events`
      )
      .get()
    recoveredDb.close()
    expect(recoveredEvent).toEqual({
      attempt_count: 1,
      delivery_state: 'pending',
      last_error: 'runtime_restarted_during_delivery',
    })
  })
})
