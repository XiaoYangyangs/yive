import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { SessionCaptureSnapshot } from './session-capture.js'
import { doesCapturedSessionExist } from './session-capture.js'

const appendUniqueArgs = (prefix: string[], args: string[]) => {
  const seen = new Set(prefix)
  return prefix.concat(args.filter((arg) => !seen.has(arg)))
}

const hasResumeArgs = (args: string[]) =>
  args.includes('--resume') ||
  args.includes('-r') ||
  args.includes('--continue') ||
  args.includes('-c') ||
  args[0] === 'resume'

export const withProviderResumeArgs = (
  config: AgentLaunchConfigInput,
  lastSessionId: string | undefined,
  cwd?: string,
  discriminator?: SessionCaptureSnapshot['discriminator'],
  onInvalidSessionId?: (sessionId: string) => void
) => {
  const capture = config.sessionIdCapture
  const resumeArgsTemplate = config.resumeArgsTemplate
  if (!lastSessionId || !resumeArgsTemplate) return config
  if (
    cwd &&
    capture?.source === 'claude_project_jsonl_dir' &&
    !doesCapturedSessionExist(cwd, capture, lastSessionId, discriminator)
  ) {
    onInvalidSessionId?.(lastSessionId)
    return config
  }
  const args = config.args ?? []
  if (hasResumeArgs(args)) return config
  const resumeArgs = resumeArgsTemplate.replace('{session_id}', lastSessionId).trim().split(/\s+/)
  return {
    ...config,
    args: appendUniqueArgs(args, resumeArgs),
    resumedSessionId: lastSessionId,
  } satisfies AgentLaunchConfigInput
}
