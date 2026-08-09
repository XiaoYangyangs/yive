import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeCrossPlatformNodeCli } from './node-cli-fixtures.js'

export type FixtureProvider = 'claude' | 'codex'

export interface ProviderFixtureEvent {
  args?: string[]
  kind:
    | 'invocation'
    | 'launch_invocation'
    | 'native_instruction'
    | 'native_resume'
    | 'prompt_ready'
    | 'stdin'
  role?: 'developer' | 'system'
  sessionId?: string
  text?: string
}

export interface ProviderAdapterFixture {
  appendAssistant: (text: string) => void
  appendCompaction: (summary: string) => void
  appendCompletion: (kind?: 'completed' | 'interrupted') => void
  appendUser: (text: string) => void
  clearCrash: () => void
  command: string
  crash: () => void
  eventsPath: string
  provider: FixtureProvider
  readEvents: () => ProviderFixtureEvent[]
  releasePromptReady: () => void
  sessionId: string
  sessionPath: string
}

const sessionIds: Record<FixtureProvider, string> = {
  claude: '22222222-2222-4222-8222-222222222222',
  codex: '11111111-1111-4111-8111-111111111111',
}

const readJsonLines = <T>(path: string): T[] => {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

export const writeProviderAdapterFixture = ({
  advanceSessionOnResume = true,
  capabilityProbe = 'available',
  fixtureId = 'default',
  promptReady = 'immediate',
  root,
  sessionId: requestedSessionId,
  workspacePath,
  provider,
}: {
  advanceSessionOnResume?: boolean
  capabilityProbe?: 'available' | 'unavailable'
  fixtureId?: string
  promptReady?: 'immediate' | 'manual'
  root: string
  sessionId?: string
  workspacePath: string
  provider: FixtureProvider
}): ProviderAdapterFixture => {
  const binDir = join(root, fixtureId, 'bin')
  const eventsPath = join(root, `${provider}-${fixtureId}-events.jsonl`)
  const promptReadyPath = join(root, `${provider}-${fixtureId}-prompt-ready`)
  const crashPath = join(root, `${provider}-${fixtureId}-crash`)
  const sessionId = requestedSessionId ?? sessionIds[provider]
  const sessionRoot =
    provider === 'codex' ? join(root, 'codex-home') : join(root, 'claude-projects')
  const sessionPath =
    provider === 'codex'
      ? join(sessionRoot, 'sessions', '2026', '08', '02', `rollout-contract-${sessionId}.jsonl`)
      : join(sessionRoot, workspacePath.replace(/[\\/:\s]/gu, '-'), `${sessionId}.jsonl`)
  mkdirSync(binDir, { recursive: true })

  const command = writeCrossPlatformNodeCli(
    binDir,
    provider,
    [
      'const fs = require("node:fs")',
      'const path = require("node:path")',
      `const provider = ${JSON.stringify(provider)}`,
      `const advanceSessionOnResume = ${JSON.stringify(advanceSessionOnResume)}`,
      `const capabilityProbe = ${JSON.stringify(capabilityProbe)}`,
      `const promptReady = ${JSON.stringify(promptReady)}`,
      `const eventsPath = ${JSON.stringify(eventsPath)}`,
      `const promptReadyPath = ${JSON.stringify(promptReadyPath)}`,
      `const crashPath = ${JSON.stringify(crashPath)}`,
      `const sessionPath = ${JSON.stringify(sessionPath)}`,
      `const sessionId = ${JSON.stringify(sessionId)}`,
      `const workspacePath = ${JSON.stringify(workspacePath)}`,
      'const args = process.argv.slice(2)',
      'const record = (event) => fs.appendFileSync(eventsPath, JSON.stringify(event) + "\\n")',
      'record({ kind: "invocation", args })',
      'if (capabilityProbe === "unavailable") {',
      '  process.stderr.write(provider + " native instruction capability unavailable\\n")',
      '  process.exit(64)',
      '}',
      'const readConfig = (key) => {',
      '  for (let index = 0; index < args.length; index += 1) {',
      '    const value = args[index] === "-c" || args[index] === "--config" ? args[index + 1] : args[index]',
      '    if (!value || !value.startsWith(key + "=")) continue',
      '    const raw = value.slice(key.length + 1)',
      '    try { return JSON.parse(raw) } catch { return raw.replace(/^"|"$/g, "") }',
      '  }',
      '  return null',
      '}',
      'const readFlag = (...flags) => {',
      '  for (const flag of flags) {',
      '    const index = args.indexOf(flag)',
      '    if (index >= 0) return args[index + 1] ?? null',
      '    const inline = args.find((arg) => arg.startsWith(flag + "="))',
      '    if (inline) return inline.slice(flag.length + 1)',
      '  }',
      '  return null',
      '}',
      'const instruction = provider === "codex"',
      '  ? readConfig("developer_instructions")',
      '  : readFlag("--append-system-prompt", "--system-prompt")',
      'const resumeIndex = args.indexOf("resume")',
      'const resumeSessionId = provider === "codex"',
      '  ? (resumeIndex >= 0 ? args[resumeIndex + 1] ?? null : null)',
      '  : readFlag("--resume", "-r")',
      'const isCodexProbe = provider === "codex" && args[0] === "debug" && args[1] === "prompt-input"',
      'const isHelpProbe = args.some((arg) => ["--help", "-h", "--version"].includes(arg))',
      'if (isCodexProbe) {',
      '  process.stdout.write(JSON.stringify([{ type: "message", role: "developer", content: [{ type: "input_text", text: instruction ?? "" }] }]))',
      '  process.exit(0)',
      '}',
      'if (isHelpProbe) {',
      '  process.stdout.write((provider === "claude" ? "--append-system-prompt <prompt>\\n" : "") + "resume <session-id>\\n--resume <session-id>\\n")',
      '  process.exit(0)',
      '}',
      'record({ kind: "launch_invocation", args })',
      'if (instruction) record({ kind: "native_instruction", role: provider === "codex" ? "developer" : "system", text: instruction })',
      'if (resumeSessionId) record({ kind: "native_resume", sessionId: resumeSessionId })',
      'fs.mkdirSync(path.dirname(sessionPath), { recursive: true })',
      'const initialRecords = provider === "codex"',
      '  ? [',
      '      { type: "session_meta", payload: { cwd: workspacePath, id: sessionId } },',
      '      ...(instruction ? [{ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: instruction }] } }] : []),',
      '      { type: "event_msg", payload: { type: "task_complete" } },',
      '    ]',
      '  : [',
      '      ...(instruction ? [{ type: "system", subtype: "system_prompt", content: instruction }] : []),',
      '      { type: "system", subtype: "turn_duration" },',
      '    ]',
      'const initialJsonl = initialRecords.map((item) => JSON.stringify(item)).join("\\n") + "\\n"',
      'if (resumeSessionId && fs.existsSync(sessionPath)) {',
      '  if (advanceSessionOnResume) fs.appendFileSync(sessionPath, initialJsonl)',
      '}',
      'else fs.writeFileSync(sessionPath, initialJsonl)',
      'process.stdin.setEncoding("utf8")',
      'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
      'process.stdin.on("data", (text) => {',
      '  record({ kind: "stdin", text })',
      '  if (text.includes("\\u001b[201~")) process.stdout.write("\\n[Pasted text #1]\\n")',
      '  if (/^[\\r\\n]+$/.test(text)) process.stdout.write("\\n\\u276f ")',
      '})',
      'let emittedPromptReady = false',
      'const emitPromptReady = () => {',
      '  if (emittedPromptReady) return',
      '  emittedPromptReady = true',
      '  record({ kind: "prompt_ready" })',
      '  process.stdout.write("\\n\\u276f ")',
      '}',
      'if (promptReady === "immediate") emitPromptReady()',
      'process.stdin.resume()',
      'setInterval(() => {',
      '  if (fs.existsSync(crashPath)) process.exit(17)',
      '  if (promptReady === "manual" && fs.existsSync(promptReadyPath)) emitPromptReady()',
      '}, 10)',
    ].join('\n')
  )

  let nextEvent = 1
  const appendRecord = (record: unknown) =>
    appendFileSync(sessionPath, `${JSON.stringify(record)}\n`)
  const appendTurn = (role: 'assistant' | 'user', text: string) => {
    const id = `${role}-${nextEvent++}`
    if (provider === 'codex') {
      appendRecord({
        id,
        type: 'response_item',
        payload: {
          content: [{ text, type: role === 'user' ? 'input_text' : 'output_text' }],
          role,
          type: 'message',
        },
      })
      return
    }
    appendRecord({
      isSidechain: false,
      message: {
        content: role === 'user' ? text : [{ text, type: 'text' }],
        ...(role === 'assistant' ? { id } : {}),
        role,
      },
      type: role,
      uuid: id,
    })
  }

  return {
    appendAssistant: (text) => appendTurn('assistant', text),
    appendCompaction: (summary) =>
      appendRecord(
        provider === 'codex'
          ? { payload: { message: summary, type: 'context_compacted' }, type: 'event_msg' }
          : { compact_metadata: { summary }, subtype: 'compact_boundary', type: 'system' }
      ),
    appendCompletion: (kind = 'completed') =>
      appendRecord(
        provider === 'codex'
          ? {
              type: 'event_msg',
              payload: { type: kind === 'interrupted' ? 'turn_aborted' : 'task_complete' },
            }
          : { type: 'system', subtype: 'turn_duration' }
      ),
    appendUser: (text) => appendTurn('user', text),
    clearCrash: () => rmSync(crashPath, { force: true }),
    command,
    crash: () => writeFileSync(crashPath, 'crash\n'),
    eventsPath,
    provider,
    readEvents: () => readJsonLines<ProviderFixtureEvent>(eventsPath),
    releasePromptReady: () => writeFileSync(promptReadyPath, 'ready\n'),
    sessionId,
    sessionPath,
  }
}
