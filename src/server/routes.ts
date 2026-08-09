import { matchPath } from './route-helpers.js'
import type {
  CreateWorkerBody,
  CreateWorkspaceBody,
  ReportTaskBody,
  RouteDefinition,
  SendTaskBody,
} from './route-types.js'
import { agentToolRoutes } from './routes-agent-tools.js'
import { dispatchNoteRoutes } from './routes-dispatch-notes.js'
import { dispatchRoutes } from './routes-dispatches.js'
import { fileExchangeRoutes } from './routes-file-exchange.js'
import { fsRoutes } from './routes-fs.js'
import { mobileRoutes } from './routes-mobile.js'
import { openWorkspaceRoutes } from './routes-open-workspace.js'
import { runtimeRoutes } from './routes-runtime.js'
import { settingsRoutes } from './routes-settings.js'
import { teamRoutes } from './routes-team.js'
import { uiRoutes } from './routes-ui.js'
import { versionRoutes } from './routes-version.js'
import { workspaceRoutes } from './routes-workspaces.js'

const routes: RouteDefinition[] = [
  ...agentToolRoutes,
  ...workspaceRoutes,
  ...openWorkspaceRoutes,
  ...dispatchRoutes,
  ...dispatchNoteRoutes,
  ...versionRoutes,
  ...uiRoutes,
  ...settingsRoutes,
  ...runtimeRoutes,
  ...mobileRoutes,
  ...fileExchangeRoutes,
  ...teamRoutes,
  ...fsRoutes,
]

export const matchRoute = (method: string, pathname: string) => {
  for (const routeDefinition of routes) {
    if (routeDefinition.method !== method) {
      continue
    }

    const params = matchPath(routeDefinition.path, pathname)
    if (!params) {
      continue
    }

    return {
      handler: routeDefinition.handler,
      params,
    }
  }

  return null
}

export type { CreateWorkerBody, CreateWorkspaceBody, ReportTaskBody, RouteDefinition, SendTaskBody }
