import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import type { AgentLaunchConfigInput } from '../../src/server/agent-run-store.js'
import type { ManagedProvider } from '../../src/server/managed-provider.js'
import { writeCrossPlatformNodeCli } from './node-cli-fixtures.js'

let nextFixtureId = 1

export const writeManagedProviderScriptLaunchConfig = ({
  provider = 'codex',
  root,
  targetScript,
}: {
  provider?: ManagedProvider
  root: string
  targetScript: string
}): AgentLaunchConfigInput => {
  const binDir = join(root, '.managed-provider-fixtures')
  const fixtureId = nextFixtureId++
  const targetName = basename(targetScript)
    .replace(/[^a-z0-9]+/giu, '-')
    .replace(/^-|-$/gu, '')
  mkdirSync(binDir, { recursive: true })

  const command = writeCrossPlatformNodeCli(
    binDir,
    `${provider}-${targetName || 'script'}-${fixtureId}`,
    [
      'const args = process.argv.slice(2)',
      `const provider = ${JSON.stringify(provider)}`,
      `const targetScript = ${JSON.stringify(targetScript)}`,
      'const readConfig = (key) => {',
      '  for (let index = 0; index < args.length; index += 1) {',
      '    const value = args[index] === "-c" ? args[index + 1] : args[index]',
      '    if (!value || !value.startsWith(key + "=")) continue',
      '    return value.slice(key.length + 1)',
      '  }',
      '  return ""',
      '}',
      'const isCodexProbe = provider === "codex" && args[0] === "debug" && args[1] === "prompt-input"',
      'if (isCodexProbe) {',
      '  const instruction = readConfig("developer_instructions")',
      '  process.stdout.write(JSON.stringify([{ role: "developer", content: [{ type: "input_text", text: instruction }] }]))',
      '  process.exit(0)',
      '}',
      'if (args.includes("--help") || args.includes("-h")) {',
      '  process.stdout.write(provider === "claude" ? "--append-system-prompt <prompt>\\n--resume <session-id>\\n" : "resume <session-id>\\n")',
      '  process.exit(0)',
      '}',
      'process.argv = [process.execPath, targetScript]',
      'require(targetScript)',
    ].join('\n')
  )

  return {
    args: [],
    command,
    provider,
  }
}
