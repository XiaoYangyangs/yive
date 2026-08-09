import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REQUIRED_ENV_KEYS = [
  'HIVE_PORT',
  'HIVE_PROJECT_ID',
  'HIVE_AGENT_ID',
  'HIVE_AGENT_TOKEN',
] as const

type HiveEnvKey = (typeof REQUIRED_ENV_KEYS)[number]

interface HiveEnv {
  HIVE_PORT: string
  HIVE_PROJECT_ID: string
  HIVE_AGENT_ID: string
  HIVE_AGENT_TOKEN: string
}

const UNAUTHENTICATED_TEAM_HELP =
  'Team Help is role-aware and available inside an authenticated Yive Agent session.'

const getHiveEnv = (): HiveEnv => {
  const values = Object.fromEntries(
    REQUIRED_ENV_KEYS.map((key) => [key, process.env[key]])
  ) as Partial<Record<HiveEnvKey, string>>

  if (REQUIRED_ENV_KEYS.some((key) => !values[key])) {
    throw new Error('Missing required Hive environment variables')
  }

  return values as HiveEnv
}

const getBaseUrl = (env: HiveEnv) => `http://127.0.0.1:${env.HIVE_PORT}`

const hasHiveEnv = () => REQUIRED_ENV_KEYS.every((key) => Boolean(process.env[key]))

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const describeFetchError = (baseUrl: string, error: unknown) => {
  const cause =
    error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : ''
  const message = error instanceof Error ? error.message : String(error)
  return `Failed to reach Hive runtime at ${baseUrl}: ${message}${cause}. Check HIVE_PORT and make sure the Hive runtime is still running.`
}

const fetchRuntime = async (baseUrl: string, path: string, init: RequestInit) => {
  try {
    return await fetch(`${baseUrl}${path}`, init)
  } catch (error) {
    throw new Error(describeFetchError(baseUrl, error))
  }
}

const readHttpErrorDetail = async (response: Response) => {
  const text = await response.text().catch(() => '')
  const trimmed = text.trim()
  if (!trimmed) return ''

  try {
    const body = JSON.parse(trimmed) as { error?: unknown }
    if (typeof body.error === 'string' && body.error.trim()) {
      return body.error.trim()
    }
  } catch {
    // Non-JSON responses still carry useful diagnostics in their text body.
  }

  return trimmed
}

const throwHttpError = async (response: Response): Promise<never> => {
  const detail = await readHttpErrorDetail(response)
  throw new Error(
    detail
      ? `Request failed with status ${response.status}: ${detail}`
      : `Request failed with status ${response.status}`
  )
}

const postJson = async (
  baseUrl: string,
  path: string,
  body: unknown,
  input: { retryTransportOnce?: boolean } = {}
) => {
  const request = () =>
    fetchRuntime(baseUrl, path, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
  let response: Response
  try {
    response = await request()
  } catch (error) {
    if (!input.retryTransportOnce) throw error
    response = await request()
  }

  if (!response.ok) {
    await throwHttpError(response)
  }

  return response
}

const printRuntimeHelp = async (command?: string) => {
  const env = getHiveEnv()
  const baseUrl = getBaseUrl(env)
  const suffix = command ? `/${encodeURIComponent(command)}` : ''
  const response = await fetchRuntime(
    baseUrl,
    `/api/workspaces/${env.HIVE_PROJECT_ID}/team/help${suffix}`,
    {
      headers: {
        'x-hive-agent-id': env.HIVE_AGENT_ID,
        'x-hive-agent-token': env.HIVE_AGENT_TOKEN,
      },
      method: 'GET',
    }
  )
  if (!response.ok) await throwHttpError(response)
  const payload = (await response.json()) as { help?: unknown }
  if (typeof payload.help !== 'string' || !payload.help.trim()) {
    throw new Error('Runtime returned invalid Team Help')
  }
  console.log(payload.help)
}

interface TeamSendResponse {
  dispatch_id: string
  ok: true
  request_id: string
  start_error?: string | null
  worker_started?: boolean
}

interface TeamAddResponse {
  active_dispatch_id: string | null
  agent_start?: { error: string | null; ok: boolean; run_id: string | null }
  conversation_activity: 'busy' | 'idle' | 'unknown'
  provider: 'claude' | 'codex' | null
  id: string
  kind: 'worker'
  last_observed_at: number
  name: string
  process_state: 'crashed' | 'running' | 'stopped'
  queue_pause_reason: string | null
  queued_dispatch_count: number
}

interface ParsedAddArgs {
  autostart: boolean
  name: string
  provider: 'claude' | 'codex' | undefined
}

interface ParsedCancelArgs {
  dispatchId: string
  reason: string
  requestId: string | undefined
}

interface ParsedContextArgs {
  dispatchId: string | undefined
  workerName: string | undefined
}

interface ParsedQueueArgs {
  action: 'resume'
  workerName: string
}

export interface ParsedReplaceArgs {
  artifacts: string[]
  dispatchId: string
  interrupt: boolean
  requestId: string | undefined
  task: string
}

interface ParsedSendArgs {
  artifacts: string[]
  queue: boolean
  task: string
  workerName: string
}

const ADD_USAGE = 'Usage: team add <worker-name> [--provider codex|claude] [--start]'
const REPORT_USAGE = 'Usage: team report (<result> | --stdin) [--failed] [--artifact <path>]'
const STATUS_USAGE =
  'Usage: team status (<current status> | --stdin) [--notify] [--artifact <path>]'
const CANCEL_USAGE =
  'Usage: team cancel --dispatch <dispatch-id> <reason> [--request-id <request-id>]'
const REPLACE_USAGE =
  'Usage: team replace --dispatch <dispatch-id> <task> [--artifact <path>] [--interrupt] [--request-id <request-id>]'
const QUEUE_USAGE = 'Usage: team queue resume <worker-name>'
const NOTE_USAGE = 'Usage: team note --dispatch <dispatch-id> <text> [--artifact <path>]'
const CONTEXT_USAGE = 'Usage: team context [--worker <worker-name> | --dispatch <dispatch-id>]'
const SEND_USAGE = 'Usage: team send <worker-name> <task> [--artifact <path>] [--queue]'

const parseWorkerLifecycleArgs = (args: string[], command: 'restart' | 'start' | 'stop') => {
  const usage = `Usage: team ${command} <worker-name>`
  if (args.length === 0 || !args[0]?.trim()) throw new Error(`Missing worker name\n\n${usage}`)
  if (args.length > 1) throw new Error(`Unexpected arguments\n\n${usage}`)
  if (args[0].startsWith('-')) throw new Error(`Invalid worker name\n\n${usage}`)
  return args[0]
}

const usageFor = (command: string) => (command === 'status' ? STATUS_USAGE : REPORT_USAGE)

const withUsage = (message: string, command: string) => `${message}\n\n${usageFor(command)}`

export interface ParsedReportArgs {
  artifacts: string[]
  notify?: boolean
  outcome?: 'completed' | 'failed'
  result: string | null
  useStdin: boolean
}

export const parseReportArgs = (args: string[], command = 'report'): ParsedReportArgs => {
  const positionals: string[] = []
  const artifacts: string[] = []
  let outcome: 'completed' | 'failed' = 'completed'
  let outcomeFlag: '--failed' | '--success' | undefined
  let notify = false
  let useStdin = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--success' || arg === '--failed') {
      if (command === 'status') {
        throw new Error(withUsage(`Unknown argument: ${arg}`, command))
      }
      if (outcomeFlag) {
        throw new Error(withUsage('Choose only one Report outcome', command))
      }
      outcomeFlag = arg
      outcome = arg === '--failed' ? 'failed' : 'completed'
      continue
    }

    if (arg === '--stdin') {
      useStdin = true
      continue
    }

    if (arg === '--notify' && command === 'status') {
      if (notify) throw new Error(withUsage('--notify may only be specified once', command))
      notify = true
      continue
    }

    if (arg === '--artifact') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(withUsage('--artifact requires a value', command))
      }
      artifacts.push(next)
      index += 1
      continue
    }

    if (arg === '--dispatch') {
      throw new Error(
        withUsage(`team ${command} binds automatically; --dispatch is not accepted`, command)
      )
    }

    if (arg.startsWith('--')) {
      throw new Error(withUsage(`Unknown argument: ${arg}`, command))
    }

    positionals.push(arg)
  }

  if (useStdin && positionals.length > 0) {
    throw new Error(
      withUsage(
        '--stdin is mutually exclusive with a positional argument; pass the body on stdin or as an argument, not both',
        command
      )
    )
  }

  if (!useStdin && positionals.length === 0) {
    const label = command === 'status' ? '<current status>' : '<result>'
    throw new Error(withUsage(`Missing ${label} (or pass --stdin to read it from stdin)`, command))
  }
  if (positionals.length > 1) {
    const label = command === 'status' ? 'status' : 'result'
    throw new Error(
      withUsage(
        `Expected exactly one ${label} positional, got ${positionals.length}: ${positionals
          .map((value) => JSON.stringify(value))
          .join(', ')}`,
        command
      )
    )
  }

  return {
    result: useStdin ? null : (positionals[0] ?? null),
    artifacts,
    ...(command === 'report' ? { outcome } : { notify }),
    useStdin,
  }
}

export const parseCancelArgs = (args: string[]): ParsedCancelArgs => {
  const positionals: string[] = []
  let dispatchId: string | undefined
  let requestId: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--dispatch' || arg === '--request-id') {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${arg} requires a value\n\n${CANCEL_USAGE}`)
      }
      if (arg === '--dispatch') {
        if (dispatchId) throw new Error(`Duplicate --dispatch\n\n${CANCEL_USAGE}`)
        dispatchId = next
      } else {
        if (requestId) throw new Error(`Duplicate --request-id\n\n${CANCEL_USAGE}`)
        requestId = next
      }
      index += 1
      continue
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}\n\n${CANCEL_USAGE}`)
    }

    positionals.push(arg)
  }

  if (!dispatchId) {
    throw new Error(`Missing --dispatch <dispatch-id>\n\n${CANCEL_USAGE}`)
  }
  if (positionals.length === 0) {
    throw new Error(`Missing <reason>\n\n${CANCEL_USAGE}`)
  }

  const reason = positionals.join(' ').trim()
  if (!reason) {
    throw new Error(`Missing <reason>\n\n${CANCEL_USAGE}`)
  }

  return { dispatchId, reason, requestId }
}

export const parseReplaceArgs = (args: string[]): ParsedReplaceArgs => {
  const artifacts: string[] = []
  const positionals: string[] = []
  let dispatchId: string | undefined
  let interrupt = false
  let requestId: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--interrupt') {
      if (interrupt) throw new Error(`Duplicate --interrupt\n\n${REPLACE_USAGE}`)
      interrupt = true
      continue
    }
    if (arg === '--artifact' || arg === '--dispatch' || arg === '--request-id') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value\n\n${REPLACE_USAGE}`)
      }
      if (arg === '--artifact') artifacts.push(value)
      else if (arg === '--dispatch') {
        if (dispatchId) throw new Error(`Duplicate --dispatch\n\n${REPLACE_USAGE}`)
        dispatchId = value
      } else {
        if (requestId) throw new Error(`Duplicate --request-id\n\n${REPLACE_USAGE}`)
        requestId = value
      }
      index += 1
      continue
    }
    if (arg?.startsWith('--')) throw new Error(`Unknown argument: ${arg}\n\n${REPLACE_USAGE}`)
    if (arg) positionals.push(arg)
  }

  if (!dispatchId) throw new Error(`Missing --dispatch <dispatch-id>\n\n${REPLACE_USAGE}`)
  const task = positionals.join(' ').trim()
  if (!task) throw new Error(`Missing <task>\n\n${REPLACE_USAGE}`)
  return { artifacts, dispatchId, interrupt, requestId, task }
}

export const parseQueueArgs = (args: string[]): ParsedQueueArgs => {
  if (args[0] !== 'resume') throw new Error(`Missing queue action\n\n${QUEUE_USAGE}`)
  const workerNames = args.slice(1)
  if (workerNames.length === 0 || !workerNames[0]?.trim()) {
    throw new Error(`Missing <worker-name>\n\n${QUEUE_USAGE}`)
  }
  if (workerNames.length > 1) {
    throw new Error(`Expected exactly one worker name\n\n${QUEUE_USAGE}`)
  }
  return { action: 'resume', workerName: workerNames[0].trim() }
}

const parseSendArgs = (args: string[]): ParsedSendArgs => {
  const artifacts: string[] = []
  const positionals: string[] = []
  let queue = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue
    if (arg === '--queue') {
      queue = true
      continue
    }
    if (arg === '--artifact') {
      const next = args[index + 1]
      if (!next || next.startsWith('--')) {
        throw new Error(`--artifact requires a value\n\n${SEND_USAGE}`)
      }
      artifacts.push(next)
      index += 1
      continue
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}\n\n${SEND_USAGE}`)
    }
    positionals.push(arg)
  }

  const [workerName, ...taskParts] = positionals
  const task = taskParts.join(' ').trim()
  if (!workerName || !task || uuidPattern.test(workerName)) {
    throw new Error(SEND_USAGE)
  }

  return { artifacts, queue, task, workerName }
}

const parseContextArgs = (args: string[]): ParsedContextArgs => {
  let dispatchId: string | undefined
  let workerName: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg !== '--worker' && arg !== '--dispatch') {
      throw new Error(`Unknown argument: ${arg ?? ''}\n\n${CONTEXT_USAGE}`)
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`${arg} requires a value\n\n${CONTEXT_USAGE}`)
    }
    if (arg === '--worker') {
      if (workerName) throw new Error(`Duplicate --worker\n\n${CONTEXT_USAGE}`)
      workerName = value
    } else {
      if (dispatchId) throw new Error(`Duplicate --dispatch\n\n${CONTEXT_USAGE}`)
      dispatchId = value
    }
    index += 1
  }

  if (workerName && dispatchId) {
    throw new Error(`Choose either --worker or --dispatch\n\n${CONTEXT_USAGE}`)
  }
  return { dispatchId, workerName }
}

interface ParsedNoteArgs {
  artifacts: string[]
  dispatchId: string
  text: string
}

const parseNoteArgs = (args: string[]): ParsedNoteArgs => {
  const artifacts: string[] = []
  const positionals: string[] = []
  let dispatchId: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--artifact' || arg === '--dispatch') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value\n\n${NOTE_USAGE}`)
      }
      if (arg === '--artifact') artifacts.push(value)
      else if (dispatchId) throw new Error(`Duplicate --dispatch\n\n${NOTE_USAGE}`)
      else dispatchId = value
      index += 1
      continue
    }
    if (arg?.startsWith('--')) throw new Error(`Unknown argument: ${arg}\n\n${NOTE_USAGE}`)
    if (arg) positionals.push(arg)
  }
  if (!dispatchId) throw new Error(`Missing --dispatch <dispatch-id>\n\n${NOTE_USAGE}`)
  if (positionals.length !== 1 || !positionals[0]?.trim()) {
    throw new Error(`Expected exactly one Note text positional\n\n${NOTE_USAGE}`)
  }
  return { artifacts, dispatchId, text: positionals[0].trim() }
}

export const parseAddArgs = (args: string[]): ParsedAddArgs => {
  const positionals: string[] = []
  let autostart = false
  let provider: 'claude' | 'codex' | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--start') {
      autostart = true
      continue
    }

    if (arg === '--provider') {
      if (provider !== undefined) {
        throw new Error(`Duplicate --provider\n\n${ADD_USAGE}`)
      }
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--provider requires a value\n\n${ADD_USAGE}`)
      }
      if (next !== 'codex' && next !== 'claude') {
        throw new Error(`Unsupported Provider: ${next}\n\n${ADD_USAGE}`)
      }
      provider = next
      index += 1
      continue
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}\n\n${ADD_USAGE}`)
    }

    positionals.push(arg)
  }

  if (positionals.length === 0) {
    throw new Error(`Missing <worker-name>\n\n${ADD_USAGE}`)
  }
  if (positionals.length > 1) {
    throw new Error(`Expected exactly one worker name\n\n${ADD_USAGE}`)
  }

  return {
    autostart,
    name: positionals[0] ?? '',
    provider,
  }
}

export const readStdinToString = async (command = 'report'): Promise<string> => {
  if (process.stdin.isTTY) {
    throw new Error(
      withUsage(
        '--stdin requires piped input, but stdin is a TTY. Did you forget to pipe content in?',
        command
      )
    )
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const content = Buffer.concat(chunks).toString('utf8')
  if (!content.trim()) {
    throw new Error(withUsage('--stdin received empty input', command))
  }
  return content
}

export const runTeamCommand = async (argv: string[]) => {
  const [command, ...args] = argv

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    if (hasHiveEnv()) {
      await printRuntimeHelp(command === 'help' ? args[0] : undefined)
      return
    }
    console.log(UNAUTHENTICATED_TEAM_HELP)
    return
  }

  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    if (hasHiveEnv()) {
      await printRuntimeHelp(command)
      return
    }
    console.log(UNAUTHENTICATED_TEAM_HELP)
    return
  }

  if (command === 'list') {
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await fetchRuntime(baseUrl, `/api/workspaces/${env.HIVE_PROJECT_ID}/team`, {
      method: 'GET',
      headers: {
        'x-hive-agent-id': env.HIVE_AGENT_ID,
        'x-hive-agent-token': env.HIVE_AGENT_TOKEN,
      },
    })

    if (!response.ok) {
      await throwHttpError(response)
    }

    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'context') {
    const context = parseContextArgs(args)
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/context', {
      ...(context.dispatchId ? { dispatch_id: context.dispatchId } : {}),
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      ...(context.workerName ? { worker: context.workerName } : {}),
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'add') {
    const input = parseAddArgs(args)
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/add', {
      autostart: input.autostart,
      ...(input.provider ? { provider: input.provider } : {}),
      hive_port: env.HIVE_PORT,
      project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID,
      token: env.HIVE_AGENT_TOKEN,
      name: input.name,
    })
    const payload = (await response.json()) as TeamAddResponse
    if (payload.agent_start?.ok === false && payload.agent_start.error) {
      console.error(
        `Hive created the worker, but could not start it in real time: ${payload.agent_start.error}`
      )
    }
    console.log(JSON.stringify(payload))
    return
  }

  if (command === 'start' || command === 'restart' || command === 'stop') {
    const worker = parseWorkerLifecycleArgs(args, command)
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, `/api/team/${command}`, {
      from_agent_id: env.HIVE_AGENT_ID,
      project_id: env.HIVE_PROJECT_ID,
      token: env.HIVE_AGENT_TOKEN,
      worker,
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'send') {
    const { artifacts, queue, task, workerName } = parseSendArgs(args)

    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const requestId = randomUUID()
    const response = await postJson(
      baseUrl,
      '/api/team/send',
      {
        hive_port: env.HIVE_PORT,
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        ...(artifacts.length > 0 ? { artifacts } : {}),
        ...(queue ? { queue: true } : {}),
        request_id: requestId,
        to: workerName,
        text: task,
      },
      { retryTransportOnce: true }
    )
    const payload = (await response.json()) as TeamSendResponse
    if (payload.worker_started === false && payload.start_error) {
      console.error(
        `Hive recorded the dispatch, but could not start the worker in real time: ${payload.start_error}`
      )
    }
    console.log(JSON.stringify(payload))
    return
  }

  if (command === 'cancel') {
    const cancel = parseCancelArgs(args)
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const requestId = cancel.requestId ?? randomUUID()
    await postJson(
      baseUrl,
      '/api/team/cancel',
      {
        dispatch_id: cancel.dispatchId,
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        reason: cancel.reason,
        request_id: requestId,
      },
      { retryTransportOnce: true }
    )
    return
  }

  if (command === 'replace') {
    const replacement = parseReplaceArgs(args)
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const requestId = replacement.requestId ?? randomUUID()
    const response = await postJson(
      baseUrl,
      '/api/team/replace',
      {
        artifacts: replacement.artifacts,
        dispatch_id: replacement.dispatchId,
        from_agent_id: env.HIVE_AGENT_ID,
        interrupt: replacement.interrupt,
        project_id: env.HIVE_PROJECT_ID,
        request_id: requestId,
        text: replacement.task,
        token: env.HIVE_AGENT_TOKEN,
      },
      { retryTransportOnce: true }
    )
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'queue') {
    const queue = parseQueueArgs(args)
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const response = await postJson(baseUrl, '/api/team/queue/resume', {
      from_agent_id: env.HIVE_AGENT_ID,
      project_id: env.HIVE_PROJECT_ID,
      token: env.HIVE_AGENT_TOKEN,
      worker: queue.workerName,
    })
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'status') {
    const report = parseReportArgs(args, 'status')
    const body = report.useStdin ? await readStdinToString('status') : (report.result ?? '')

    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const requestId = randomUUID()
    await postJson(
      baseUrl,
      '/api/team/status',
      {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        notify: report.notify,
        request_id: requestId,
        result: body,
        artifacts: report.artifacts,
      },
      { retryTransportOnce: true }
    )
    return
  }

  if (command === 'report') {
    const report = parseReportArgs(args)
    const body = report.useStdin ? await readStdinToString('report') : (report.result ?? '')

    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const requestId = randomUUID()
    await postJson(
      baseUrl,
      '/api/team/report',
      {
        project_id: env.HIVE_PROJECT_ID,
        from_agent_id: env.HIVE_AGENT_ID,
        token: env.HIVE_AGENT_TOKEN,
        outcome: report.outcome,
        request_id: requestId,
        result: body,
        artifacts: report.artifacts,
      },
      { retryTransportOnce: true }
    )
    return
  }

  if (command === 'note') {
    const env = getHiveEnv()
    const baseUrl = getBaseUrl(env)
    const note = parseNoteArgs(args)
    const noteId = randomUUID()
    const response = await postJson(
      baseUrl,
      '/api/team/note',
      {
        artifacts: note.artifacts,
        dispatch_id: note.dispatchId,
        from_agent_id: env.HIVE_AGENT_ID,
        note_id: noteId,
        project_id: env.HIVE_PROJECT_ID,
        text: note.text,
        token: env.HIVE_AGENT_TOKEN,
      },
      { retryTransportOnce: true }
    )
    console.log(JSON.stringify(await response.json()))
    return
  }

  throw new Error('Unsupported team command')
}

const isMainModule = process.argv[1]
  ? fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  : false

if (isMainModule) {
  void runTeamCommand(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
