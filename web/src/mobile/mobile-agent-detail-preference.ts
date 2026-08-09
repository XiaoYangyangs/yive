export type MobileAgentDetailMode = 'chat' | 'raw-terminal'

export const readMobileAgentDeepLink = () => {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const workspaceId = params.get('workspace_id')
  const agentId = params.get('agent_id')
  return workspaceId && agentId ? { agentId, workspaceId } : null
}

export const readInitialMobileAgentDetailMode = (): MobileAgentDetailMode => {
  if (typeof window === 'undefined') return 'chat'
  const params = new URLSearchParams(window.location.search)
  if (params.has('conversation_id')) return 'chat'
  return params.get('view') === 'terminal' ? 'raw-terminal' : 'chat'
}
