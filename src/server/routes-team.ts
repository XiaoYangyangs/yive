import { serializeDispatchNote } from './dispatch-note-serializer.js'
import { parseDispatchNoteArtifacts } from './dispatch-note-validation.js'
import { BadRequestError, HttpError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type {
  AddWorkerBody,
  CancelTaskBody,
  ReplaceTaskBody,
  ReportTaskBody,
  RouteDefinition,
  SendTaskBody,
  StatusTaskBody,
} from './route-types.js'
import { authenticateCliAgent, requireCommandForKind } from './team-authz.js'
import {
  buildDefaultOrchestratorContext,
  buildFocusedDispatchContext,
  buildFocusedWorkerContext,
  buildWorkerResponsibilityContext,
} from './team-context.js'
import { teamLifecycleRoutes } from './team-lifecycle-routes.js'
import { createWorkerForWorkspace, validateTeamAddBody } from './worker-create-service.js'

const requireNonEmptyString = (value: unknown, field: string, code?: string) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    if (code) throw new HttpError(400, `Missing ${field}`, code)
    throw new BadRequestError(`Missing ${field}`)
  }
  return value
}

const hasControlCharacter = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })

const getDispatchRequestId = (value: unknown) => {
  const requestId = requireNonEmptyString(value, 'request_id', 'invalid_dispatch_request').trim()
  if (requestId.length > 200 || hasControlCharacter(requestId)) {
    throw new HttpError(400, 'Invalid request_id', 'invalid_dispatch_request')
  }
  return requestId
}

const getReportRequestId = (value: unknown) => {
  const requestId = requireNonEmptyString(value, 'request_id', 'invalid_report').trim()
  if (requestId.length > 200 || hasControlCharacter(requestId)) {
    throw new HttpError(400, 'Invalid request_id', 'invalid_report')
  }
  return requestId
}

const getReportOutcome = (value: unknown) => {
  if (value === undefined) return 'completed' as const
  if (value === 'completed' || value === 'failed') return value
  throw new HttpError(400, 'Report outcome must be completed or failed', 'invalid_report')
}

const getStatusRequestId = (value: unknown) => {
  const requestId = requireNonEmptyString(value, 'request_id', 'invalid_status').trim()
  if (requestId.length > 200 || hasControlCharacter(requestId)) {
    throw new HttpError(400, 'Invalid request_id', 'invalid_status')
  }
  return requestId
}

export const teamRoutes: RouteDefinition[] = [
  route('POST', '/api/team/context', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      dispatch_id?: unknown
      from_agent_id?: unknown
      project_id?: unknown
      token?: unknown
      worker?: unknown
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: typeof body.token === 'string' ? body.token : undefined,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForKind(agent, 'context')
    if (body.worker !== undefined && body.dispatch_id !== undefined) {
      throw new HttpError(
        400,
        'Choose either worker or dispatch focus, not both',
        'invalid_context_focus'
      )
    }
    if (agent.kind === 'worker') {
      if (body.worker !== undefined || body.dispatch_id !== undefined) {
        throw new HttpError(
          403,
          'Worker Team Context is limited to its own responsibility',
          'context_scope_forbidden'
        )
      }
      const context = buildWorkerResponsibilityContext(store, projectId, agent.id)
      if (!context) {
        throw new HttpError(404, 'Worker Context not found', 'context_target_not_found')
      }
      sendJson(response, 200, context)
      return
    }
    if (body.dispatch_id !== undefined) {
      const dispatchId = requireNonEmptyString(body.dispatch_id, 'dispatch_id')
      const context = buildFocusedDispatchContext(store, projectId, dispatchId)
      if (!context) {
        throw new HttpError(
          404,
          `Dispatch Context not found: ${dispatchId}`,
          'context_target_not_found'
        )
      }
      sendJson(response, 200, context)
      return
    }
    if (body.worker !== undefined) {
      const workerName = requireNonEmptyString(body.worker, 'worker')
      const context = buildFocusedWorkerContext(store, projectId, workerName)
      if (!context) {
        throw new HttpError(
          404,
          `Worker Context not found: ${workerName}`,
          'context_target_not_found'
        )
      }
      sendJson(response, 200, context)
      return
    }
    sendJson(response, 200, buildDefaultOrchestratorContext(store, projectId))
  }),
  route('POST', '/api/team/add', async ({ request, response, store }) => {
    const body = await readJsonBody<AddWorkerBody>(request)
    validateTeamAddBody(body)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const name = requireNonEmptyString(body.name, 'name', 'invalid_worker')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForKind(agent, 'add')

    sendJson(
      response,
      201,
      await createWorkerForWorkspace({
        body: {
          autostart: body.autostart === true,
          name,
          ...(body.provider !== undefined ? { provider: body.provider } : {}),
        },
        hivePort: body.hive_port ?? String(request.socket.localPort ?? ''),
        store,
        workspaceId: projectId,
      })
    )
  }),
  ...teamLifecycleRoutes,
  route('POST', '/api/team/send', async ({ request, response, store }) => {
    const body = await readJsonBody<SendTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const to = requireNonEmptyString(body.to, 'to')
    const text = requireNonEmptyString(body.text, 'text')
    if (body.queue !== undefined && typeof body.queue !== 'boolean') {
      throw new HttpError(400, 'queue must be a boolean', 'invalid_dispatch_request')
    }
    const requestId =
      body.request_id === undefined ? undefined : getDispatchRequestId(body.request_id)
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForKind(agent, 'send')
    const result = await store.dispatchTaskByWorkerName(projectId, to, text, {
      fromAgentId,
      hivePort: String(request.socket.localPort ?? ''),
      artifacts: parseDispatchNoteArtifacts(body.artifacts),
      queue: body.queue === true,
      ...(requestId ? { requestId } : {}),
    })

    sendJson(response, 202, {
      dispatch_id: result.id,
      ok: true,
      request_id: result.requestId,
      start_error: result.startError,
      worker_started: result.workerStarted,
    })
  }),
  route('POST', '/api/team/cancel', async ({ request, response, store }) => {
    const body = await readJsonBody<CancelTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const dispatchId = requireNonEmptyString(body.dispatch_id, 'dispatch_id', 'invalid_dispatch')
    const reason = requireNonEmptyString(body.reason, 'reason', 'invalid_dispatch')
    const requestId = requireNonEmptyString(
      body.request_id,
      'request_id',
      'invalid_dispatch'
    ).trim()
    if (requestId.length > 200 || hasControlCharacter(requestId)) {
      throw new HttpError(400, 'Invalid request_id', 'invalid_dispatch')
    }
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForKind(agent, 'cancel')
    const result = await store.cancelTask(projectId, dispatchId, {
      fromAgentId,
      reason,
      requestId,
    })
    sendJson(response, 202, {
      dispatch_id: result.dispatch?.id ?? null,
      forward_error: result.forwardError,
      forwarded: result.forwarded,
      ok: true,
      request_id: result.dispatch?.operationRequestId ?? requestId,
      state: result.dispatch?.status ?? null,
    })
  }),
  route('POST', '/api/team/replace', async ({ request, response, store }) => {
    const body = await readJsonBody<ReplaceTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const dispatchId = requireNonEmptyString(body.dispatch_id, 'dispatch_id', 'invalid_replacement')
    const text = requireNonEmptyString(body.text, 'text', 'invalid_replacement')
    if (body.interrupt !== undefined && typeof body.interrupt !== 'boolean') {
      throw new HttpError(400, 'interrupt must be a boolean', 'invalid_replacement')
    }
    const requestId = requireNonEmptyString(
      body.request_id,
      'request_id',
      'invalid_replacement'
    ).trim()
    if (requestId.length > 200 || hasControlCharacter(requestId)) {
      throw new HttpError(400, 'Invalid request_id', 'invalid_replacement')
    }
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForKind(agent, 'replace')
    const result = await store.replaceTask(projectId, dispatchId, {
      artifacts: parseDispatchNoteArtifacts(body.artifacts),
      fromAgentId,
      interrupt: body.interrupt === true,
      requestId,
      text,
    })
    sendJson(response, 202, {
      dispatch_id: result.dispatch.id,
      ok: true,
      replaced_dispatch_id: result.replacedDispatch.id,
      request_id: result.dispatch.requestId,
    })
  }),
  route('POST', '/api/team/report', async ({ request, response, store }) => {
    const body = await readJsonBody<ReportTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const resultText = requireNonEmptyString(body.result, 'result', 'invalid_report')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForKind(agent, 'report')
    if (body.dispatch_id !== undefined) {
      throw new HttpError(
        400,
        'team report binds automatically; dispatch_id is not accepted',
        'invalid_report'
      )
    }
    if (body.status !== undefined) {
      throw new HttpError(400, 'Use outcome instead of legacy status', 'invalid_report')
    }
    const outcome = getReportOutcome(body.outcome)
    const requestId = getReportRequestId(body.request_id)
    const result = store.reportTask(projectId, fromAgentId, {
      artifacts: parseDispatchNoteArtifacts(body.artifacts),
      outcome,
      requestId,
      text: resultText,
    })
    sendJson(response, 202, {
      dispatch_id: result.dispatch?.id ?? null,
      ok: true,
      outcome: result.dispatch?.reportOutcome ?? outcome,
      reported_at: result.dispatch?.reportedAt ?? null,
      request_id: result.dispatch?.reportRequestId ?? requestId,
    })
    return
  }),
  route('POST', '/api/team/note', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      artifacts?: unknown
      dispatch_id?: unknown
      force?: unknown
      from_agent_id?: unknown
      note_id?: unknown
      project_id?: unknown
      text?: unknown
      token?: unknown
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const dispatchId = requireNonEmptyString(body.dispatch_id, 'dispatch_id', 'invalid_note')
    const text = requireNonEmptyString(body.text, 'text', 'invalid_note')
    if (body.force !== undefined) {
      throw new HttpError(400, 'force delivery is not supported for Dispatch Notes', 'invalid_note')
    }
    const artifacts = parseDispatchNoteArtifacts(body.artifacts)
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: typeof body.token === 'string' ? body.token : undefined,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForKind(agent, 'note')
    const result = await store.appendDispatchNote(projectId, {
      actorId: agent.id,
      actorType: 'agent',
      artifacts,
      dispatchId,
      id: requireNonEmptyString(body.note_id, 'note_id', 'invalid_note').trim(),
      text,
    })
    sendJson(response, result.created ? 201 : 200, {
      note: serializeDispatchNote(result.note),
      ok: true,
    })
  }),
  route('POST', '/api/team/status', async ({ request, response, store }) => {
    const body = await readJsonBody<StatusTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const resultText = requireNonEmptyString(body.result, 'result', 'invalid_status')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForKind(agent, 'status')
    if (body.dispatch_id !== undefined) {
      throw new HttpError(
        400,
        'team status binds automatically; dispatch_id is not accepted',
        'invalid_status'
      )
    }
    if (body.notify !== undefined && typeof body.notify !== 'boolean') {
      throw new HttpError(400, 'notify must be a boolean', 'invalid_status')
    }
    const requestId = getStatusRequestId(body.request_id)
    const result = store.statusTask(projectId, fromAgentId, {
      artifacts: parseDispatchNoteArtifacts(body.artifacts),
      notify: body.notify === true,
      requestId,
      text: resultText,
    })
    sendJson(response, 202, {
      dispatch_id: result.status.dispatchId,
      notify: result.status.notify,
      ok: true,
      request_id: result.status.requestId,
      updated_at: result.status.createdAt,
    })
    return
  }),
  route('POST', '/api/team/queue/resume', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      from_agent_id?: unknown
      project_id?: unknown
      token?: unknown
      worker?: unknown
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const workerName = requireNonEmptyString(body.worker, 'worker')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: typeof body.token === 'string' ? body.token : undefined,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForKind(agent, 'queue')
    const worker = store
      .listWorkers(projectId)
      .find((candidate) => candidate.name.toLowerCase() === workerName.toLowerCase())
    if (!worker) throw new HttpError(404, `Worker not found: ${workerName}`, 'worker_not_found')
    const state = store.resumeQueue(projectId, worker.id)
    sendJson(response, 200, {
      ok: true,
      queue_pause_reason: state.pauseReason,
      worker_id: state.workerId,
    })
  }),
]
