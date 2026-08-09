import type { IncomingMessage } from 'node:http'
import { serializeAgentSummary } from './agent-state-serializer.js'
import { HttpError } from './http-errors.js'
import { isManagedProvider } from './managed-provider.js'
import { autostartOrchestrator } from './orchestrator-autostart.js'
import { seedOrchestratorLaunchConfig } from './orchestrator-launch.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type {
  CreateWorkerBody,
  CreateWorkspaceBody,
  RouteDefinition,
  UserInputBody,
} from './route-types.js'
import { authenticateCliAgent, requireCommandForKind } from './team-authz.js'
import { getTeamCommand, renderTeamCommandHelp, renderTeamHelp } from './team-command-registry.js'
import { enrichTeamList } from './team-list-enrichment.js'
import { serializeTeamListItem } from './team-list-serializer.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import { createWorkerForWorkspace, getSerializedWorker } from './worker-create-service.js'
import { validateWorkspacePath } from './workspace-path-validation.js'
import { getOrchestratorId } from './workspace-store-support.js'

const getRuntimePort = (request: IncomingMessage) => String(request.socket.localPort ?? '')

const WORKSPACE_CREATE_FIELDS = new Set(['autostart_orchestrator', 'name', 'path', 'provider'])

const validateWorkspaceCreateBody = (body: object) => {
  const unsupportedField = Object.keys(body).find((field) => !WORKSPACE_CREATE_FIELDS.has(field))
  if (unsupportedField) {
    throw new HttpError(
      400,
      `Managed Agent field is not supported: ${unsupportedField}`,
      'unsupported_agent_provider_configuration'
    )
  }
}

export const workspaceRoutes: RouteDefinition[] = [
  route('GET', '/api/workspaces', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, store.listWorkspaces())
  }),
  route('POST', '/api/workspaces', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await readJsonBody<CreateWorkspaceBody>(request)
    validateWorkspaceCreateBody(body)
    if (body.provider !== undefined && !isManagedProvider(body.provider)) {
      throw new HttpError(
        400,
        `Unsupported managed Agent Provider: ${String(body.provider)}`,
        'unsupported_agent_provider_configuration'
      )
    }
    const provider = body.provider ?? 'codex'
    const workspacePath = validateWorkspacePath(body.path)
    const workspace = store.createWorkspace(workspacePath, body.name)
    seedOrchestratorLaunchConfig(store, workspace.id, provider)

    const autostart = body.autostart_orchestrator !== false
    if (!autostart) {
      sendJson(response, 201, {
        ...workspace,
        orchestrator_start: { ok: false, error: null, run_id: null },
      })
      return
    }

    // Spawn failure must NOT block workspace creation — see AGENTS.md §1
    // (no try/catch fallbacks in production code, but `autostartOrchestrator`
    // captures the failure as a structured result instead of throwing).
    const orchestratorStart = await autostartOrchestrator(
      store,
      workspace.id,
      getOrchestratorId(workspace.id),
      getRuntimePort(request)
    )
    sendJson(response, 201, { ...workspace, orchestrator_start: orchestratorStart })
  }),
  route('DELETE', '/api/workspaces/:workspaceId', async ({ params, request, response, store }) => {
    const workspaceId = getRequiredParam(
      response,
      params,
      'workspaceId',
      'Workspace id is required'
    )
    if (!workspaceId) {
      return
    }

    requireUiTokenFromRequest(request, store.validateUiToken)
    await store.deleteWorkspace(workspaceId)
    response.statusCode = 204
    response.end()
  }),
  route(
    'GET',
    '/api/workspaces/:workspaceId/agents/:agentId',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and agent id are required'
      )
      const agentId = getRequiredParam(
        response,
        params,
        'agentId',
        'Workspace id and agent id are required'
      )
      if (!workspaceId || !agentId) return

      requireUiTokenFromRequest(request, store.validateUiToken)
      sendJson(
        response,
        200,
        serializeAgentSummary(
          store.getAgent(workspaceId, agentId),
          store.getAgentState(workspaceId, agentId)
        )
      )
    }
  ),
  route(
    'PATCH',
    '/api/workspaces/:workspaceId/agents/:agentId',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and agent id are required'
      )
      const agentId = getRequiredParam(
        response,
        params,
        'agentId',
        'Workspace id and agent id are required'
      )
      if (!workspaceId || !agentId) return

      requireUiTokenFromRequest(request, store.validateUiToken)
      const body = await readJsonBody<Record<string, unknown>>(request)
      if (Object.keys(body).some((key) => key !== 'name') || typeof body.name !== 'string') {
        sendJson(response, 400, { error: 'Only name may be changed' })
        return
      }
      sendJson(
        response,
        200,
        serializeAgentSummary(
          store.renameAgent(workspaceId, agentId, body.name),
          store.getAgentState(workspaceId, agentId)
        )
      )
    }
  ),
  route('GET', '/api/ui/workspaces/:workspaceId/team', ({ params, request, response, store }) => {
    const workspaceId = getRequiredParam(
      response,
      params,
      'workspaceId',
      'Workspace id is required'
    )
    if (!workspaceId) {
      return
    }

    requireUiTokenFromRequest(request, store.validateUiToken)

    sendJson(
      response,
      200,
      enrichTeamList(workspaceId, store, store.listWorkers(workspaceId)).map(serializeTeamListItem)
    )
  }),
  route('GET', '/api/workspaces/:workspaceId/team/help', ({ params, request, response, store }) => {
    const workspaceId = getRequiredParam(
      response,
      params,
      'workspaceId',
      'Workspace id is required'
    )
    if (!workspaceId) return

    const agentId = request.headers['x-hive-agent-id']
    const token = request.headers['x-hive-agent-token']
    const agent = authenticateCliAgent({
      fromAgentId: typeof agentId === 'string' ? agentId : undefined,
      getAgent: store.getAgent,
      token: typeof token === 'string' ? token : undefined,
      validateToken: store.validateAgentToken,
      workspaceId,
    })
    requireCommandForKind(agent, 'help')
    sendJson(response, 200, { help: renderTeamHelp(agent.kind) })
  }),
  route(
    'GET',
    '/api/workspaces/:workspaceId/team/help/:command',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      const commandName = getRequiredParam(response, params, 'command', 'Team command is required')
      if (!workspaceId || !commandName) return

      const agentId = request.headers['x-hive-agent-id']
      const token = request.headers['x-hive-agent-token']
      const agent = authenticateCliAgent({
        fromAgentId: typeof agentId === 'string' ? agentId : undefined,
        getAgent: store.getAgent,
        token: typeof token === 'string' ? token : undefined,
        validateToken: store.validateAgentToken,
        workspaceId,
      })
      const command = getTeamCommand(commandName)
      if (!command || command.hidden) {
        throw new HttpError(404, `Unknown Team command: ${commandName}`, 'team_command_not_found')
      }
      requireCommandForKind(agent, command.name)
      const help = renderTeamCommandHelp(agent.kind, command.name)
      if (!help) {
        throw new HttpError(
          500,
          `Team Help is incomplete for command: ${commandName}`,
          'team_help_incomplete'
        )
      }
      sendJson(response, 200, { help })
    }
  ),
  route('GET', '/api/workspaces/:workspaceId/team', ({ params, request, response, store }) => {
    const workspaceId = getRequiredParam(
      response,
      params,
      'workspaceId',
      'Workspace id is required'
    )
    if (!workspaceId) {
      return
    }

    const agentId = request.headers['x-hive-agent-id']
    const token = request.headers['x-hive-agent-token']
    const agent = authenticateCliAgent({
      fromAgentId: typeof agentId === 'string' ? agentId : undefined,
      getAgent: store.getAgent,
      token: typeof token === 'string' ? token : undefined,
      validateToken: store.validateAgentToken,
      workspaceId,
    })
    requireCommandForKind(agent, 'list')

    sendJson(
      response,
      200,
      enrichTeamList(workspaceId, store, store.listWorkers(workspaceId)).map(serializeTeamListItem)
    )
  }),
  route(
    'POST',
    '/api/workspaces/:workspaceId/workers',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<CreateWorkerBody>(request)
      sendJson(
        response,
        201,
        await createWorkerForWorkspace({
          body,
          hivePort: getRuntimePort(request),
          store,
          workspaceId,
        })
      )
    }
  ),
  route(
    'DELETE',
    '/api/workspaces/:workspaceId/workers/:workerId',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and worker id are required'
      )
      const workerId = getRequiredParam(
        response,
        params,
        'workerId',
        'Workspace id and worker id are required'
      )
      if (!workspaceId || !workerId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)
      store.deleteWorker(workspaceId, workerId)
      response.statusCode = 204
      response.end()
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/workers/:workerId/stop',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and worker id are required'
      )
      const workerId = getRequiredParam(
        response,
        params,
        'workerId',
        'Workspace id and worker id are required'
      )
      if (!workspaceId || !workerId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)
      store.stopWorker(workspaceId, workerId)
      response.statusCode = 202
      response.end()
    }
  ),
  route(
    'PATCH',
    '/api/workspaces/:workspaceId/workers/:workerId',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and worker id are required'
      )
      const workerId = getRequiredParam(
        response,
        params,
        'workerId',
        'Workspace id and worker id are required'
      )
      if (!workspaceId || !workerId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)
      const body = await readJsonBody<{ name?: string }>(request)
      if (typeof body.name !== 'string') {
        sendJson(response, 400, { error: 'name is required' })
        return
      }
      store.renameWorker(workspaceId, workerId, body.name)
      sendJson(response, 200, getSerializedWorker(workspaceId, workerId, store))
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/user-input',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<UserInputBody>(request)
      store.recordUserInput(workspaceId, `${workspaceId}:orchestrator`, body.text)
      sendJson(response, 202, { ok: true })
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/start',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and agent id are required'
      )
      const agentId = getRequiredParam(
        response,
        params,
        'agentId',
        'Workspace id and agent id are required'
      )
      if (!workspaceId || !agentId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      const run = await store.startAgentForUser(workspaceId, agentId, {
        hivePort: getRuntimePort(request),
      })
      sendJson(response, 201, { run_id: run.runId })
    }
  ),
]
