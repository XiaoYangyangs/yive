import { resolveConversationProvider } from './conversation-provider-resolver.js'
import { BadRequestError, ConflictError, HttpError } from './http-errors.js'
import {
  buildManagedProviderLaunchConfig,
  isManagedProvider,
  type ManagedProvider,
} from './managed-provider.js'
import { autostartAgent } from './orchestrator-autostart.js'
import type { CreateWorkerBody } from './route-types.js'
import type { RuntimeStore } from './runtime-store.js'
import { enrichTeamList } from './team-list-enrichment.js'
import { serializeTeamListItem } from './team-list-serializer.js'

const RETIRED_WORKER_FIELDS = [
  'args',
  'command',
  'command_preset_id',
  'description',
  'env',
  'instructions',
  'role',
  'role_type',
  'startup_command',
  'template_id',
]

const WORKER_FIELDS = new Set(['autostart', 'name', 'provider'])
const TEAM_ADD_FIELDS = new Set([
  ...WORKER_FIELDS,
  'from_agent_id',
  'hive_port',
  'project_id',
  'token',
])

class UnsupportedAgentProviderConfigurationError extends HttpError {
  constructor(message: string) {
    super(400, message, 'unsupported_agent_provider_configuration')
    this.name = 'UnsupportedAgentProviderConfigurationError'
  }
}

export const rejectRetiredWorkerFields = (body: object) => {
  const retiredField = RETIRED_WORKER_FIELDS.find((field) => field in body)
  if (retiredField)
    throw new UnsupportedAgentProviderConfigurationError(
      `Managed Agent field is no longer supported: ${retiredField}`
    )
}

const rejectUnknownFields = (body: object, allowed: ReadonlySet<string>) => {
  const unsupportedField = Object.keys(body).find((field) => !allowed.has(field))
  if (unsupportedField) {
    throw new UnsupportedAgentProviderConfigurationError(
      `Managed Agent field is not supported: ${unsupportedField}`
    )
  }
}

export const validateWorkerConfigurationBody = (body: object) => {
  rejectRetiredWorkerFields(body)
  rejectUnknownFields(body, WORKER_FIELDS)
}

export const validateTeamAddBody = (body: object) => {
  rejectRetiredWorkerFields(body)
  rejectUnknownFields(body, TEAM_ADD_FIELDS)
}

const resolveWorkerProvider = (
  body: CreateWorkerBody,
  workspaceId: string,
  store: RuntimeStore
): ManagedProvider => {
  if (body.provider !== undefined) {
    if (!isManagedProvider(body.provider)) {
      throw new UnsupportedAgentProviderConfigurationError(
        `Unsupported managed Agent Provider: ${String(body.provider)}`
      )
    }
    return body.provider
  }
  const orchestratorProvider = resolveConversationProvider(
    store.peekAgentLaunchConfig(workspaceId, `${workspaceId}:orchestrator`)
  )
  if (!orchestratorProvider) {
    throw new BadRequestError('Orchestrator has no supported managed Agent Provider')
  }
  return orchestratorProvider
}

export const getSerializedWorker = (workspaceId: string, workerId: string, store: RuntimeStore) => {
  const worker = store.listWorkers(workspaceId).find((item) => item.id === workerId)
  if (!worker) {
    throw new Error(`Worker not found: ${workerId}`)
  }
  const [enriched] = enrichTeamList(workspaceId, store, [worker])
  if (!enriched) throw new Error(`Worker enrichment failed: ${workerId}`)
  return serializeTeamListItem(enriched)
}

export const createWorkerForWorkspace = async ({
  body,
  hivePort,
  store,
  workspaceId,
}: {
  body: CreateWorkerBody
  hivePort: string
  store: RuntimeStore
  workspaceId: string
}) => {
  validateWorkerConfigurationBody(body)
  const provider = resolveWorkerProvider(body, workspaceId, store)
  const launchConfig = buildManagedProviderLaunchConfig(provider)
  let worker: ReturnType<RuntimeStore['addWorker']>
  try {
    worker = store.addWorker(workspaceId, body)
  } catch (error) {
    if (error instanceof ConflictError) {
      throw new HttpError(409, error.message, 'worker_name_exists')
    }
    throw error
  }
  try {
    store.configureAgentLaunch(workspaceId, worker.id, launchConfig)
  } catch (error) {
    store.deleteWorker(workspaceId, worker.id)
    throw error
  }

  const agentStart =
    body.autostart === true
      ? await autostartAgent(store, workspaceId, worker.id, hivePort, {
          missingConfigError: 'No worker launch config available',
        })
      : { ok: false, error: null, run_id: null }

  return {
    ...getSerializedWorker(workspaceId, worker.id, store),
    agent_start: agentStart,
  }
}
