import type { ConversationProvider } from '../shared/types.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'

type ConversationLaunchConfig = Pick<AgentLaunchConfigInput, 'provider' | 'sessionIdCapture'>

export const resolveConversationProvider = (
  config: ConversationLaunchConfig | null | undefined
): ConversationProvider | null => {
  if (config?.provider === 'codex' || config?.provider === 'claude') {
    return config.provider
  }
  return null
}
