import { accessSync, constants } from 'node:fs'
import { basename, delimiter, extname, isAbsolute, join } from 'node:path'
import { buildCmdCallCommand } from './windows-command-line.js'

const hasPathSeparator = (command: string) => command.includes('/') || command.includes('\\')

const canExecute = (path: string, platform = process.platform): boolean => {
  try {
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

const createCommandNotFoundError = (command: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${command} CLI not found in PATH`), {
    code: 'ENOENT',
    path: command,
  })

interface ResolvedSpawnCommand {
  args: string | string[]
  command: string
}

const getEnvValue = (
  env: NodeJS.ProcessEnv,
  key: string,
  platform = process.platform
): string | undefined => {
  if (platform !== 'win32') return env[key]
  const matchedKey = Object.keys(env).find((item) => item.toLowerCase() === key.toLowerCase())
  return matchedKey ? env[matchedKey] : undefined
}

const getWindowsExecutableNames = (
  command: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string[] => {
  if (extname(command)) return [command]

  const extensions = (getEnvValue(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
  return [...extensions.map((extension) => `${command}${extension}`), command]
}

const getExecutableNames = (
  command: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string[] =>
  platform === 'win32' ? getWindowsExecutableNames(command, env, platform) : [command]

export const resolveCommandPath = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string => {
  if (hasPathSeparator(command)) {
    for (const name of getExecutableNames(command, env, platform)) {
      const candidate = isAbsolute(name) ? name : join(cwd, name)
      if (canExecute(candidate, platform)) return candidate
    }
    throw createCommandNotFoundError(command)
  }

  for (const pathEntry of (getEnvValue(env, 'PATH', platform) ?? '').split(delimiter)) {
    if (!pathEntry) continue
    for (const name of getExecutableNames(command, env, platform)) {
      const candidate = join(pathEntry, name)
      if (canExecute(candidate, platform)) return candidate
    }
  }

  throw createCommandNotFoundError(command)
}

const isWindowsBatchFile = (command: string) => {
  const extension = extname(command).toLowerCase()
  return extension === '.cmd' || extension === '.bat'
}

const buildWindowsBatchCommandLine = (command: string, args: string[]) =>
  `/d /s /c ${buildCmdCallCommand(command, args)}`

const isCmdExeShellLaunch = (resolvedCommand: string, args: string[]) =>
  basename(resolvedCommand).toLowerCase() === 'cmd.exe' &&
  args.length === 4 &&
  args[0] === '/d' &&
  args[1] === '/s' &&
  (args[2] === '/c' || args[2] === '/k')

export const resolveSpawnCommand = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[] = [],
  platform = process.platform
): ResolvedSpawnCommand => {
  const resolvedCommand = resolveCommandPath(command, cwd, env, platform)
  if (platform === 'win32' && isWindowsBatchFile(resolvedCommand)) {
    return {
      args: buildWindowsBatchCommandLine(resolvedCommand, args),
      command: getEnvValue(env, 'ComSpec', platform) ?? 'cmd.exe',
    }
  }
  if (platform === 'win32' && isCmdExeShellLaunch(resolvedCommand, args)) {
    return {
      args: args.join(' '),
      command: resolvedCommand,
    }
  }
  return { args, command: resolvedCommand }
}

export const assertCommandIsExecutable = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): void => {
  resolveCommandPath(command, cwd, env)
}

export type { ResolvedSpawnCommand }
