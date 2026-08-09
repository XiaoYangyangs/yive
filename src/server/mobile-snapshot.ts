import type { IncomingMessage } from 'node:http'

import type {
  AgentIdentity,
  MobileConnectionSnapshot,
  MobileSnapshot,
  MobileSnapshotActiveWorkspace,
  MobileSnapshotAgentPayload,
  TeamListItem,
  WorkspaceSummary,
} from '../shared/types.js'
import { serializeAgentRuntimeState } from './agent-state-serializer.js'
import { resolveConversationProvider } from './conversation-provider-resolver.js'
import { serializeDispatchRecord } from './dispatch-ledger-serializer.js'
import type { DispatchRecord, DispatchStatus } from './dispatch-ledger-store.js'
import type { RuntimeStore } from './runtime-store.js'
import type { MobileAccessContext } from './ui-auth-helpers.js'
import { getOrchestratorId } from './workspace-store-support.js'

const RECENT_DISPATCH_LIMIT = 5
export const MOBILE_HEARTBEAT_INTERVAL_MS = 15_000
export const MOBILE_STALE_AFTER_MS = 45_000
const DISPATCH_STATES: DispatchStatus[] = [
  'queued',
  'submitted',
  'reported',
  'cancelled',
  'replaced',
  'replacement_pending',
]

const firstHeader = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value

const buildConnectionSnapshot = (
  request: IncomingMessage,
  access: MobileAccessContext
): MobileConnectionSnapshot => ({
  auth: {
    http: access.kind,
    websocket: access.kind,
    workspace_scope: access.workspaceScope,
    ...(access.workspaceIds ? { workspace_ids: access.workspaceIds } : {}),
  },
  health: {
    heartbeat_interval_ms: MOBILE_HEARTBEAT_INTERVAL_MS,
    stale_after_ms: MOBILE_STALE_AFTER_MS,
    version_endpoint: '/api/version',
  },
  lan: {
    dev_lan_enabled: process.env.HIVE_DEV_LAN === '1',
    private_network_only: true,
    relay_enabled: false,
  },
  request: {
    host: firstHeader(request.headers.host) ?? null,
    origin: firstHeader(request.headers.origin) ?? null,
    remote_address: request.socket.remoteAddress ?? null,
  },
  ...(access.relay
    ? {
        relay: {
          ...(access.relay.desktopId ? { desktop_id: access.relay.desktopId } : {}),
          ...(access.relay.mobileDeviceId ? { mobile_device_id: access.relay.mobileDeviceId } : {}),
        },
      }
    : {}),
  websocket: {
    mobile_events_path: '/ws/mobile/events',
    terminal_control_path_template: '/ws/terminal/:runId/control',
    terminal_io_path_template: '/ws/terminal/:runId/io',
  },
})

const serializeAgent = (
  store: RuntimeStore,
  workspaceId: string,
  agent: AgentIdentity | TeamListItem
): MobileSnapshotAgentPayload => {
  const activeRun = store.getActiveRunByAgentId(workspaceId, agent.id)
  const state = 'processState' in agent ? agent : store.getAgentState(workspaceId, agent.id)
  const conversationProvider = resolveConversationProvider(
    store.peekAgentLaunchConfig(workspaceId, agent.id)
  )
  const payload = {
    ...serializeAgentRuntimeState(state),
    id: agent.id,
    kind: agent.kind,
    name: agent.name,
    active_run_id: activeRun?.runId ?? null,
    last_pty_line: store.getLastPtyLineForAgent(workspaceId, agent.id),
    provider: conversationProvider,
    conversation_provider: conversationProvider,
  }
  return payload
}

const summarizeDispatches = (dispatches: DispatchRecord[]) => {
  const counts = Object.fromEntries(DISPATCH_STATES.map((state) => [state, 0])) as Record<
    DispatchStatus,
    number
  >
  for (const dispatch of dispatches) counts[dispatch.status] += 1

  return {
    counts,
    pending_count: counts.queued + counts.submitted + counts.replacement_pending,
    recent: dispatches
      .slice(-RECENT_DISPATCH_LIMIT)
      .map((dispatch) => serializeDispatchRecord(dispatch)),
    total_count: dispatches.length,
  }
}

const resolveActiveWorkspaceId = (store: RuntimeStore, workspaces: WorkspaceSummary[]) => {
  const activeValue = store.settings.getAppState('active_workspace_id')?.value
  if (
    typeof activeValue === 'string' &&
    workspaces.some((workspace) => workspace.id === activeValue)
  ) {
    return activeValue
  }
  return workspaces[0]?.id ?? null
}

const filterVisibleWorkspaces = (
  access: MobileAccessContext,
  workspaces: WorkspaceSummary[]
): WorkspaceSummary[] => {
  if (access.workspaceScope === 'all') return workspaces
  const allowed = new Set(access.workspaceIds ?? [])
  return workspaces.filter((workspace) => allowed.has(workspace.id))
}

const buildWorkspaceSnapshot = (
  store: RuntimeStore,
  workspaceId: string
): MobileSnapshotActiveWorkspace => {
  const workspace = store.getWorkspaceSnapshot(workspaceId)
  const orchestrator = store.getAgent(workspaceId, getOrchestratorId(workspaceId))
  const dispatches = store.listDispatches(workspaceId)

  return {
    workspace: workspace.summary,
    orchestrator: serializeAgent(store, workspaceId, orchestrator),
    workers: store
      .listWorkers(workspaceId)
      .map((worker) => serializeAgent(store, workspaceId, worker)),
    terminal_runs: store.listTerminalRuns(workspaceId),
    dispatch_summary: summarizeDispatches(dispatches),
  }
}

export const buildMobileSnapshot = (
  request: IncomingMessage,
  store: RuntimeStore,
  access: MobileAccessContext = { kind: 'mobile-token', workspaceScope: 'all' }
): MobileSnapshot => {
  const workspaces = filterVisibleWorkspaces(access, store.listWorkspaces())
  const activeWorkspaceId = resolveActiveWorkspaceId(store, workspaces)

  return {
    generated_at: Date.now(),
    connection: buildConnectionSnapshot(request, access),
    active_workspace_id: activeWorkspaceId,
    notifications: store.listMobileNotifications(access.workspaceIds),
    workspaces: workspaces.map((workspace) => ({
      ...workspace,
      is_active: workspace.id === activeWorkspaceId,
    })),
    active_workspace:
      activeWorkspaceId === null ? null : buildWorkspaceSnapshot(store, activeWorkspaceId),
  }
}
