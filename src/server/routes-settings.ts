import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const settingsRoutes: RouteDefinition[] = [
  route('GET', '/api/settings/app-state/:key', ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const key = getRequiredParam(response, params, 'key', 'App state key is required')
    if (!key) return
    sendJson(response, 200, store.settings.getAppState(key) ?? { key, value: null })
  }),
  route('PUT', '/api/settings/app-state/:key', async ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const key = getRequiredParam(response, params, 'key', 'App state key is required')
    if (!key) return
    const body = await readJsonBody<{ value: string | null }>(request)
    store.settings.setAppState(key, body.value)
    response.statusCode = 204
    response.end()
  }),
]
