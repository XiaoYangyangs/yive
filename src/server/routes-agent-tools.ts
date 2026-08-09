import { requireAgentToolForKind } from './agent-tool-authz.js'
import { getAgentTool, renderAgentHelp, renderAgentToolHelp } from './agent-tool-registry.js'
import { BadRequestError, HttpError } from './http-errors.js'
import { sendMobileNotification } from './mobile-notification-service.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { createMobileFileExchangeItemFromWorkspacePath } from './routes-file-exchange.js'
import { authenticateCliAgent } from './team-authz.js'

const requireString = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestError(`${field} is required`)
  return value.trim()
}

const authenticateAgentRequest = (
  context: Parameters<RouteDefinition['handler']>[0],
  workspaceId: string
) => {
  const agentId = context.request.headers['x-hive-agent-id']
  const token = context.request.headers['x-hive-agent-token']
  return authenticateCliAgent({
    fromAgentId: typeof agentId === 'string' ? agentId : undefined,
    getAgent: context.store.getAgent,
    token: typeof token === 'string' ? token : undefined,
    validateToken: context.store.validateAgentToken,
    workspaceId,
  })
}

export const agentToolRoutes: RouteDefinition[] = [
  route('GET', '/api/workspaces/:workspaceId/agent/help', (context) => {
    const workspaceId = getRequiredParam(
      context.response,
      context.params,
      'workspaceId',
      'Workspace id is required'
    )
    if (!workspaceId) return
    const agent = authenticateAgentRequest(context, workspaceId)
    requireAgentToolForKind(agent, 'help')
    sendJson(context.response, 200, { help: renderAgentHelp(agent.kind) })
  }),
  route('GET', '/api/workspaces/:workspaceId/agent/help/:tool', (context) => {
    const workspaceId = getRequiredParam(
      context.response,
      context.params,
      'workspaceId',
      'Workspace id is required'
    )
    const toolName = getRequiredParam(
      context.response,
      context.params,
      'tool',
      'Agent tool is required'
    )
    if (!workspaceId || !toolName) return
    const agent = authenticateAgentRequest(context, workspaceId)
    const tool = getAgentTool(toolName)
    if (!tool || tool.hidden) {
      throw new HttpError(404, `Unknown Agent tool: ${toolName}`, 'agent_tool_not_found')
    }
    requireAgentToolForKind(agent, tool.name)
    const help = renderAgentToolHelp(agent.kind, tool.name)
    if (!help) {
      throw new HttpError(
        500,
        `Agent Help is incomplete for tool: ${toolName}`,
        'agent_help_incomplete'
      )
    }
    sendJson(context.response, 200, { help })
  }),
  route('POST', '/api/agent/send-file', async (context) => {
    const body = await readJsonBody<{ path?: unknown; workspace_id?: unknown }>(context.request, {
      limitBytes: 16 * 1024,
    })
    const workspaceId = requireString(body.workspace_id, 'workspace_id')
    const agent = authenticateAgentRequest(context, workspaceId)
    requireAgentToolForKind(agent, 'send-file')
    const item = createMobileFileExchangeItemFromWorkspacePath({
      store: context.store,
      workspaceId,
      workspacePath: requireString(body.path, 'path'),
    })
    sendJson(context.response, 201, {
      artifact: item.workspacePath,
      name: item.name,
      ok: true,
      size: item.size,
    })
  }),
  route('POST', '/api/agent/notify', async (context) => {
    const body = await readJsonBody<{
      body?: unknown
      image_path?: unknown
      title?: unknown
      workspace_id?: unknown
    }>(context.request, { limitBytes: 64 * 1024 })
    const workspaceId = requireString(body.workspace_id, 'workspace_id')
    const agent = authenticateAgentRequest(context, workspaceId)
    requireAgentToolForKind(agent, 'notify')
    const title = requireString(body.title, 'title')
    const notificationBody = requireString(body.body, 'body')
    if (title.length > 160) throw new BadRequestError('title is too long')
    if (notificationBody.length > 4_000) throw new BadRequestError('body is too long')
    const imagePath =
      body.image_path === undefined ? undefined : requireString(body.image_path, 'image_path')
    const result = await sendMobileNotification({
      body: notificationBody,
      ...(imagePath ? { imagePath } : {}),
      store: context.store,
      title,
      workspaceId,
    })
    sendJson(context.response, 201, {
      delivery: {
        feishu: result.feishu,
        fcm: result.fcm,
        wechat: result.wechat,
        xiaomi: result.xiaomi,
      },
      ...(result.imageArtifact ? { image_artifact: result.imageArtifact } : {}),
      ok: true,
      title,
    })
  }),
]
