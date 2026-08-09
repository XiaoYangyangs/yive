import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const writeCrossPlatformNodeCli = (binDir: string, name: string, script: string) => {
  const scriptPath = join(binDir, `${name}.js`)
  writeFileSync(scriptPath, script)

  if (process.platform === 'win32') {
    const cmdPath = join(binDir, `${name}.cmd`)
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`)
    return cmdPath
  }

  const shellPath = join(binDir, name)
  writeFileSync(shellPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`)
  chmodSync(shellPath, 0o755)
  return shellPath
}
