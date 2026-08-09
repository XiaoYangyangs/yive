import type { TeamListItem, WorkspaceSummary } from '../../../src/shared/types.js'

export const DEMO_WORKSPACE: WorkspaceSummary = {
  id: 'demo-workspace',
  name: 'demo-todo-app',
  path: '/Users/you/demo-todo-app',
}

/**
 * The orchestrator is split out from `DEMO_WORKERS` to match production:
 * `listWorkers` excludes the orchestrator from the team list. Threading it
 * into the workers array would render queen as a worker card alongside alice
 * and bob, which is not how Hive actually behaves.
 */
export const DEMO_ORCHESTRATOR = {
  activeDispatchId: null,
  conversationActivity: 'idle' as const,
  id: 'demo-orch',
  kind: 'orchestrator' as const,
  lastObservedAt: Date.now(),
  name: 'queen',
  processState: 'running' as const,
  queuePauseReason: null,
  queuedDispatchCount: 0,
  workspaceId: DEMO_WORKSPACE.id,
}

export const DEMO_WORKERS: TeamListItem[] = [
  {
    activeDispatchId: 'demo-dispatch-alice',
    conversationActivity: 'busy',
    id: 'demo-worker-alice',
    kind: 'worker',
    lastObservedAt: Date.now(),
    name: 'alice',
    processState: 'running',
    queuePauseReason: null,
    queuedDispatchCount: 0,
    lastPtyLine: 'Editing src/routes/todos.ts (line 42)',
    provider: 'claude',
  },
  {
    activeDispatchId: null,
    conversationActivity: 'idle',
    id: 'demo-worker-bob',
    kind: 'worker',
    lastObservedAt: Date.now(),
    name: 'bob',
    processState: 'running',
    queuePauseReason: null,
    queuedDispatchCount: 0,
    provider: 'codex',
  },
]

export const DEMO_TERMINAL_SCROLLBACK: Record<string, string> = {
  'demo-orch':
    '$ team send alice "Implement POST /todos"\r\n' +
    '> dispatched to alice\r\n' +
    '$ team list\r\n' +
    '> alice: working (1 task)\r\n' +
    '> bob: idle\r\n',
  'demo-worker-alice':
    'Reading src/routes/todos.ts ...\r\n' +
    'Drafting POST handler ...\r\n' +
    'Editing src/routes/todos.ts (line 42)\r\n',
  'demo-worker-bob': 'Idle — waiting for review tasks.\r\n',
}
