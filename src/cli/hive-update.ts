import { spawn } from 'node:child_process'

import {
  getNpmCommand,
  INSTALL_COMMAND_ARGS,
  INSTALL_COMMAND_DISPLAY,
} from '../server/package-version.js'

export const HIVE_UPDATE_USAGE = [
  'Usage:',
  '  yive update',
  '',
  `Runs \`${INSTALL_COMMAND_DISPLAY}\` to upgrade Yive in place.`,
  'Restart any running Yive process afterwards to pick up the new version.',
  '',
  'Note: only npm-installed Yive can be upgraded this way. If you installed',
  'Yive via pnpm or yarn, upgrade through the same package manager instead;',
  'otherwise the npm copy will shadow your existing install.',
  '',
  'Options:',
  '  -h, --help      Print this help.',
].join('\n')

export interface RunUpdateResult {
  exitCode: number
  spawnError?: Error
}

export type RunUpdate = (command: string, args: readonly string[]) => Promise<RunUpdateResult>

export const defaultRunUpdate: RunUpdate = (command, args) =>
  new Promise<RunUpdateResult>((resolve) => {
    const child = spawn(command, [...args], { stdio: 'inherit' })
    let resolved = false

    // Forward Ctrl+C / SIGTERM to the npm child so it can clean up rather
    // than getting orphaned mid-install. The handlers are registered with
    // `once` so they don't accumulate across invocations, and we also
    // explicitly remove them when the child exits in case the user only
    // sent one signal (Node would otherwise keep the handler alive).
    const handleSignal = (signal: NodeJS.Signals) => () => {
      child.kill(signal)
    }
    const handleSigint = handleSignal('SIGINT')
    const handleSigterm = handleSignal('SIGTERM')
    process.once('SIGINT', handleSigint)
    process.once('SIGTERM', handleSigterm)

    const finalize = (result: RunUpdateResult) => {
      if (resolved) return
      resolved = true
      process.off('SIGINT', handleSigint)
      process.off('SIGTERM', handleSigterm)
      resolve(result)
    }

    child.on('error', (error) => {
      finalize({ exitCode: 1, spawnError: error })
    })
    child.on('close', (code) => {
      finalize({ exitCode: typeof code === 'number' ? code : 1 })
    })
  })

const printManualFallback = () => {
  console.error(`You can run the upgrade manually: ${INSTALL_COMMAND_DISPLAY}`)
}

interface RunHiveUpdateOptions {
  /** Inject a fake spawn for tests. */
  runUpdate?: RunUpdate
  /** Override platform detection for tests. */
  platform?: NodeJS.Platform
}

export const runHiveUpdateCommand = async (
  argv: string[],
  options: RunHiveUpdateOptions = {}
): Promise<number> => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HIVE_UPDATE_USAGE)
    return 0
  }

  // Reject unknown flags rather than silently ignoring them — keeps behavior
  // consistent with how `parsePort` validates `yive` itself.
  const extra = argv.find((arg) => arg !== '--help' && arg !== '-h')
  if (extra !== undefined) {
    console.error(`Unknown argument: ${extra}`)
    console.error(HIVE_UPDATE_USAGE)
    return 1
  }

  const run = options.runUpdate ?? defaultRunUpdate
  const command = getNpmCommand(options.platform)
  console.log(`Running: ${INSTALL_COMMAND_DISPLAY}`)

  const result = await run(command, INSTALL_COMMAND_ARGS)

  if (result.spawnError) {
    console.error(`Failed to spawn npm: ${result.spawnError.message}`)
    printManualFallback()
    return 1
  }

  if (result.exitCode === 0) {
    console.log('Yive updated. Restart any running Yive process to pick up the new version.')
    return 0
  }

  console.error(`npm install exited with code ${result.exitCode}.`)
  // Permission failures (EACCES on root-owned /usr/bin/npm) and other
  // non-spawn errors leave the user with copy-paste recovery either way.
  printManualFallback()
  return result.exitCode
}
