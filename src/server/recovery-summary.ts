import type { AgentIdentity, WorkspaceSummary } from '../shared/types.js'
import { wrapSystemMessage } from './system-message.js'

const PRIVATE_CONTEXT_KEY =
  /(?:token|credential|password|secret|workspace[_-]?id|agent[_-]?id|session[_-]?id|provider[_-]?session)/iu
const MAX_RUNTIME_CONTEXT_PROMPT_CHARS = 16_384

export const RUNTIME_CONTEXT_UNAVAILABLE_MESSAGE =
  'Runtime Context unavailable; run `team context` for a fresh snapshot.'

const serializeSafeContext = (context: unknown) =>
  JSON.stringify(context, (key, value) => (PRIVATE_CONTEXT_KEY.test(key) ? undefined : value))

export const buildRuntimeContextPrompt = (context: unknown) =>
  (() => {
    const serialized = serializeSafeContext(context)
    if (serialized.length > MAX_RUNTIME_CONTEXT_PROMPT_CHARS) {
      return 'Runtime Context exceeds the safe prompt budget; run `team context` for a fresh snapshot.'
    }
    return [
      'Current bounded Runtime Context:',
      serialized,
      'run `team context` whenever you need a fresh snapshot.',
    ].join('\n')
  })()

export const buildRecoverySummary = ({
  agent,
  context,
  workspace,
}: {
  agent: AgentIdentity
  context: unknown | null
  workspace: WorkspaceSummary
}) => {
  const header = `Yive restarted the process for ${agent.name} (${agent.kind}) in ${workspace.name}.`
  if (context === null) {
    return wrapSystemMessage(`${header}\n${RUNTIME_CONTEXT_UNAVAILABLE_MESSAGE}`)
  }
  return wrapSystemMessage([header, buildRuntimeContextPrompt(context)].join('\n'))
}
