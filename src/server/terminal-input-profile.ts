import type { TerminalInputProfile } from '../shared/types.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'

export type { TerminalRunSummary } from '../shared/types.js'

export const resolveTerminalInputProfile = (
  _config: AgentLaunchConfigInput | undefined
): TerminalInputProfile => {
  return 'default'
}
