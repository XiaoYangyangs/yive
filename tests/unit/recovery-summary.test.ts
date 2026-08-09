import { describe, expect, test } from 'vitest'

import {
  buildRecoverySummary,
  buildRuntimeContextPrompt,
} from '../../src/server/recovery-summary.js'
import type { AgentIdentity } from '../../src/shared/types.js'

const orchestrator: AgentIdentity = {
  id: 'workspace-secret:orchestrator',
  kind: 'orchestrator',
  name: 'Orchestrator',
  workspaceId: 'workspace-secret',
}
const worker: AgentIdentity = {
  id: 'worker-secret',
  kind: 'worker',
  name: 'Alice',
  workspaceId: 'workspace-secret',
}
const workspace = { id: 'workspace-secret', name: 'Alpha', path: 'C:/alpha' }

describe('recovery summary', () => {
  test('injects only bounded Orchestrator Runtime Context', () => {
    const summary = buildRecoverySummary({
      agent: orchestrator,
      context: {
        members: [
          {
            active_dispatch: { id: 'dispatch-1', task_first_line: 'Current task' },
            conversation_activity: 'idle',
            kind: 'worker',
            name: 'Alice',
            process_state: 'running',
            queued_dispatch_count: 2,
          },
        ],
        scope: 'team',
      },
      workspace,
    })

    expect(summary).toContain('"scope":"team"')
    expect(summary).toContain('"task_first_line":"Current task"')
    expect(summary).toContain('"queued_dispatch_count":2')
    expect(summary).not.toContain('Secret queued task body')
    expect(summary).not.toContain('.hive/tasks.md')
    expect(summary).not.toContain('Recent user input')
    expect(summary).not.toContain('team send')
    expect(summary).not.toContain('workspace-secret')
    expect(summary).not.toContain('worker-secret')
  })

  test('injects only the Worker current responsibility and queued count', () => {
    const summary = buildRecoverySummary({
      agent: worker,
      context: {
        active_dispatch: {
          id: 'dispatch-active',
          latest_status: { artifacts: [], text: 'Running tests', updated_at: 1 },
          notes: [
            {
              artifacts: [],
              created_at: 1,
              delivered_at: 2,
              delivery_state: 'delivered',
              id: 'note-1',
              text: 'Use the v2 API',
            },
          ],
          status: 'submitted',
          task: 'Current responsibility',
        },
        queued_dispatch_count: 1,
        scope: 'responsibility',
        worker: { kind: 'worker', name: 'Alice' },
      },
      workspace,
    })

    expect(summary).toContain('"scope":"responsibility"')
    expect(summary).toContain('Current responsibility')
    expect(summary).toContain('Use the v2 API')
    expect(summary).toContain('"queued_dispatch_count":1')
    expect(summary).not.toContain('Secret queued task body')
    expect(summary).not.toContain('workspace-secret')
    expect(summary).not.toContain('worker-secret')
  })

  test('falls back to one discovery instruction when Runtime Context is unavailable', () => {
    const summary = buildRecoverySummary({ agent: worker, context: null, workspace })

    expect(summary).toContain('run `team context`')
    expect(summary).not.toContain('.hive/tasks.md')
    expect(summary).not.toContain('team report')
  })

  test('renders a bounded compression prompt without credentials or machine IDs', () => {
    const prompt = buildRuntimeContextPrompt({
      members: [{ kind: 'worker', name: 'Alice', queued_dispatch_count: 1 }],
      scope: 'team',
      token: 'agent-secret',
      workspace_id: 'workspace-secret',
    })

    expect(prompt).toContain('"scope":"team"')
    expect(prompt).not.toContain('agent-secret')
    expect(prompt).not.toContain('workspace-secret')
    expect(prompt).toContain('run `team context`')
  })

  test('falls back to discovery instead of injecting Context beyond the prompt budget', () => {
    const prompt = buildRuntimeContextPrompt({
      active_dispatch: {
        notes: Array.from({ length: 100 }, (_, index) => ({
          id: `note-${index}`,
          text: 'x'.repeat(1000),
        })),
        task: 'large current responsibility',
      },
      scope: 'responsibility',
    })

    expect(prompt.length).toBeLessThan(20_000)
    expect(prompt).toContain('run `team context`')
    expect(prompt).not.toContain('note-99')
  })
})
