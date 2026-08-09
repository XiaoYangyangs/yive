import type { AgentProvider } from '../../../src/shared/types.js'

export interface WorkspaceCreateInput {
  name: string
  path: string
  provider: AgentProvider
}
