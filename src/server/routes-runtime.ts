import type { AgentStopMode } from './agent-runtime-contract.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import { getWorkspaceShellAgentId } from './workspace-shell-runtime.js'

export const runtimeRoutes: RouteDefinition[] = [
  route('GET', '/api/ui/workspaces/:workspaceId/runs', ({ params, request, response, store }) => {
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

    sendJson(response, 200, store.listTerminalRuns(workspaceId))
  }),
  route(
    'POST',
    '/api/workspaces/:workspaceId/shell/start',
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

      const run = await store.startWorkspaceShell(workspaceId)
      const summary = store
        .listTerminalRuns(workspaceId)
        .find((terminalRun) => terminalRun.run_id === run.runId)
      sendJson(response, 201, {
        agent_id: getWorkspaceShellAgentId(workspaceId),
        agent_name: summary?.agent_name ?? 'Shell',
        run_id: run.runId,
        status: run.status,
        terminal_input_profile: summary?.terminal_input_profile ?? 'default',
      })
    }
  ),
  route(
    'DELETE',
    '/api/workspaces/:workspaceId/shell/:runId',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and run id are required'
      )
      const runId = getRequiredParam(
        response,
        params,
        'runId',
        'Workspace id and run id are required'
      )
      if (!workspaceId || !runId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)
      if (!store.closeWorkspaceShell(workspaceId, runId)) {
        sendJson(response, 404, { error: 'Shell run not found' })
        return
      }
      response.statusCode = 204
      response.end()
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/session/refresh',
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
      if (!workspaceId || !agentId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      const result = store.refreshAgentSessionBinding(workspaceId, agentId)
      sendJson(response, 200, {
        capture_source: result.captureSource,
        failure_reason: result.failureReason,
        previous_session_id: result.previousSessionId,
        request_id: result.requestId,
        run_id: result.runId,
        session_id: result.sessionId,
        state: result.state,
        unchanged: result.unchanged,
      })
    }
  ),
  route('POST', '/api/runtime/runs/:runId/stop', async ({ params, request, response, store }) => {
    const runId = getRequiredParam(response, params, 'runId', 'Run id is required')
    if (!runId) {
      return
    }

    requireUiTokenFromRequest(request, store.validateUiToken)

    const contentLength = Number(request.headers['content-length'] ?? 0)
    const body = contentLength > 0 ? await readJsonBody<{ mode?: unknown }>(request) : {}
    const mode = body.mode ?? 'safe'
    if (mode !== 'safe' && mode !== 'checkpoint' && mode !== 'force') {
      sendJson(response, 400, { error: `Unsupported stop mode: ${String(mode)}` })
      return
    }
    const result = await store.stopAgentRunSafely(runId, { mode: mode as AgentStopMode })
    sendJson(response, 200, {
      mode: result.mode,
      reason: result.reason,
      run_id: result.runId,
      session_id: result.sessionId,
      state: result.state,
    })
  }),
  route('GET', '/api/runtime/runs/:runId', ({ params, request, response, store }) => {
    const runId = getRequiredParam(response, params, 'runId', 'Run id is required')
    if (!runId) {
      return
    }

    requireUiTokenFromRequest(request, store.validateUiToken)

    sendJson(response, 200, store.getLiveRun(runId))
  }),
]
