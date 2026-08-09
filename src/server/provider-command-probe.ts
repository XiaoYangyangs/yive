import { spawnSync } from 'node:child_process'
import { extname } from 'node:path'

import { resolveCommandPath } from './agent-command-resolver.js'
import { buildCmdCallCommand } from './windows-command-line.js'

export interface ProviderCapabilityProbe {
  status: number | null
  stderr: string
  stdout: string
}

export type ProviderCapabilityProbeRunner = (input: {
  args: string[]
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
}) => ProviderCapabilityProbe

const resolveProbeCommand = (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
) => {
  const resolved = resolveCommandPath(command, cwd, env)
  if (process.platform !== 'win32' || !['.bat', '.cmd'].includes(extname(resolved).toLowerCase())) {
    return { args, command: resolved, windowsVerbatimArguments: false }
  }
  return {
    args: ['/d', '/s', '/c', buildCmdCallCommand(resolved, args)],
    command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
    windowsVerbatimArguments: true,
  }
}

export const runProviderCapabilityProbe: ProviderCapabilityProbeRunner = (input) => {
  const resolved = resolveProbeCommand(input.command, input.args, input.cwd, input.env)
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: input.cwd,
    encoding: 'utf8',
    env: { ...input.env, NO_COLOR: '1' },
    timeout: 15_000,
    windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    windowsHide: true,
  })
  return {
    status: result.status,
    stderr: result.stderr ?? result.error?.message ?? '',
    stdout: result.stdout ?? '',
  }
}
