import { BadRequestError, HttpError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition, WorkerLifecycleBody } from './route-types.js'
import { authenticateCliAgent, requireCommandForKind } from './team-authz.js'

const requireString = (value: unknown, field: string) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`Missing ${field}`)
  }
  return value
}

const readLifecycleRequest = async (
  request: Parameters<RouteDefinition['handler']>[0]['request'],
  store: Parameters<RouteDefinition['handler']>[0]['store'],
  command: 'restart' | 'start' | 'stop'
) => {
  const body = await readJsonBody<WorkerLifecycleBody>(request)
  const workspaceId = requireString(body.project_id, 'project_id')
  const fromAgentId = requireString(body.from_agent_id, 'from_agent_id')
  const workerName = requireString(body.worker, 'worker')
  const agent = authenticateCliAgent({
    fromAgentId,
    getAgent: store.getAgent,
    token: body.token,
    validateToken: store.validateAgentToken,
    workspaceId,
  })
  requireCommandForKind(agent, command)
  const worker = store
    .listWorkers(workspaceId)
    .find((candidate) => candidate.name.toLowerCase() === workerName.toLowerCase())
  if (!worker) throw new HttpError(404, `Worker not found: ${workerName}`, 'worker_not_found')
  return { worker, workspaceId }
}

const startWorkerRoute = (command: 'restart' | 'start') =>
  route('POST', `/api/team/${command}`, async ({ request, response, store }) => {
    const { worker, workspaceId } = await readLifecycleRequest(request, store, command)
    const run = await store.startWorkerForTeam(workspaceId, worker.id, {
      command,
      hivePort: String(request.socket.localPort ?? ''),
    })
    const processState = store.getAgentState(workspaceId, worker.id).processState
    sendJson(response, 201, {
      agent_id: worker.id,
      ok: true,
      process_state: processState,
      resumed_session_id: run.resumedSessionId ?? null,
      run_id: run.runId,
    })
  })

export const teamLifecycleRoutes: RouteDefinition[] = [
  startWorkerRoute('start'),
  startWorkerRoute('restart'),
  route('POST', '/api/team/stop', async ({ request, response, store }) => {
    const { worker, workspaceId } = await readLifecycleRequest(request, store, 'stop')
    const result = await store.stopWorkerForTeam(workspaceId, worker.id)
    sendJson(response, 200, {
      agent_id: worker.id,
      ok: true,
      process_state: 'stopped',
      run_id: result.runId,
      session_id: result.sessionId,
    })
  }),
]
