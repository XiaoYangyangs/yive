import { serializeDispatchRecord } from './dispatch-ledger-serializer.js'
import { serializeDispatchNote } from './dispatch-note-serializer.js'
import { parseDispatchNoteArtifacts } from './dispatch-note-validation.js'
import { BadRequestError } from './http-errors.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const requireString = (value: unknown, field: string) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`${field} is required`)
  }
  return value.trim()
}

const getDispatchParams = (
  response: Parameters<typeof getRequiredParam>[0],
  params: Record<string, string>
) => {
  const workspaceId = getRequiredParam(response, params, 'workspaceId', 'Workspace id is required')
  const dispatchId = getRequiredParam(response, params, 'dispatchId', 'Dispatch id is required')
  return workspaceId && dispatchId ? { dispatchId, workspaceId } : null
}

export const dispatchNoteRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/dispatches/:dispatchId',
    ({ params, request, response, store }) => {
      const ids = getDispatchParams(response, params)
      if (!ids) return
      requireUiTokenFromRequest(request, store.validateUiToken)
      const dispatch = store.getDispatch(ids.workspaceId, ids.dispatchId)
      if (!dispatch) {
        sendJson(response, 404, { error: `Dispatch not found: ${ids.dispatchId}` })
        return
      }
      sendJson(response, 200, {
        ...serializeDispatchRecord(dispatch),
        notes: store.listDispatchNotes(ids.workspaceId, ids.dispatchId).map(serializeDispatchNote),
      })
    }
  ),
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/dispatches/:dispatchId/notes',
    ({ params, request, response, store }) => {
      const ids = getDispatchParams(response, params)
      if (!ids) return
      requireUiTokenFromRequest(request, store.validateUiToken)
      sendJson(
        response,
        200,
        store.listDispatchNotes(ids.workspaceId, ids.dispatchId).map(serializeDispatchNote)
      )
    }
  ),
  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/dispatches/:dispatchId/notes',
    async ({ params, request, response, store }) => {
      const ids = getDispatchParams(response, params)
      if (!ids) return
      requireUiTokenFromRequest(request, store.validateUiToken)
      const body = await readJsonBody<{
        artifacts?: unknown
        force?: unknown
        note_id?: unknown
        text?: unknown
      }>(request)
      if (body.force !== undefined) {
        throw new BadRequestError('force delivery is not supported for Dispatch Notes')
      }
      const result = await store.appendDispatchNote(ids.workspaceId, {
        actorId: 'ui-user',
        actorType: 'user',
        artifacts: parseDispatchNoteArtifacts(body.artifacts),
        dispatchId: ids.dispatchId,
        id: requireString(body.note_id, 'note_id'),
        text: requireString(body.text, 'text'),
      })
      sendJson(response, result.created ? 201 : 200, serializeDispatchNote(result.note))
    }
  ),
]
