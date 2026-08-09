import type { IncomingMessage, ServerResponse } from 'node:http'

import type { PickFolderResponse } from './fs-pick-folder.js'
import type { ManagedProvider } from './managed-provider.js'
import type {
  OpenCommandResult,
  OpenWorkspaceInput as OpenWorkspaceServiceInput,
} from './open-target-commands.js'
import type { RuntimeStore } from './runtime-store.js'
import type { VersionService } from './version-service.js'

export interface SendTaskBody {
  hive_port?: string
  project_id: string
  from_agent_id: string
  artifacts?: unknown
  queue?: boolean
  request_id?: unknown
  token?: string
  to: string
  text: string
}

export interface ReportTaskBody {
  dispatch_id?: unknown
  project_id: string
  from_agent_id: string
  outcome?: unknown
  request_id?: unknown
  token?: string
  result: string
  status?: unknown
  artifacts?: unknown[]
}

export interface StatusTaskBody {
  artifacts?: unknown
  dispatch_id?: unknown
  from_agent_id: string
  notify?: unknown
  project_id: string
  request_id?: unknown
  result: string
  token?: string
}

export interface CancelTaskBody {
  dispatch_id?: string
  project_id: string
  from_agent_id: string
  token?: string
  reason?: string
  request_id?: unknown
}

export interface ReplaceTaskBody {
  artifacts?: unknown
  dispatch_id?: unknown
  from_agent_id: string
  interrupt?: unknown
  project_id: string
  request_id?: unknown
  text?: unknown
  token?: string
}

export interface AddWorkerBody extends CreateWorkerBody {
  hive_port?: string
  project_id: string
  from_agent_id: string
  token?: string
}

export interface WorkerLifecycleBody {
  project_id: string
  from_agent_id: string
  token?: string
  worker: string
}

export interface CreateWorkspaceBody {
  path: string
  name: string
  /** Default true. When false, skip orchestrator PTY spawn after creation. */
  autostart_orchestrator?: boolean
  provider?: ManagedProvider
}

export interface CreateWorkerBody {
  autostart?: boolean
  name: string
  provider?: ManagedProvider
}

export interface UserInputBody {
  text: string
}

export interface OpenWorkspaceBody {
  target_id: string
}

export type OpenWorkspaceService = (input: OpenWorkspaceServiceInput) => Promise<OpenCommandResult>

export interface RouteContext {
  request: IncomingMessage
  response: ServerResponse
  store: RuntimeStore
  pickFolderService: () => Promise<PickFolderResponse>
  openWorkspaceService: OpenWorkspaceService
  versionService: VersionService
  params: Record<string, string>
}

export interface RouteDefinition {
  method: string
  path: string
  handler: (context: RouteContext) => Promise<void> | void
}
