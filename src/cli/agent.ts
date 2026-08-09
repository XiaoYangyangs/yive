const REQUIRED_ENV_KEYS = [
  'HIVE_PORT',
  'HIVE_PROJECT_ID',
  'HIVE_AGENT_ID',
  'HIVE_AGENT_TOKEN',
] as const

interface AgentEnv {
  HIVE_AGENT_ID: string
  HIVE_AGENT_TOKEN: string
  HIVE_PORT: string
  HIVE_PROJECT_ID: string
}

const UNAUTHENTICATED_HELP =
  'Yive Agent Help is role-aware and available inside an authenticated managed Agent session.'

const hasAgentEnv = () => REQUIRED_ENV_KEYS.every((key) => Boolean(process.env[key]))

const getAgentEnv = (): AgentEnv => {
  if (!hasAgentEnv()) throw new Error('Missing required Hive environment variables')
  return Object.fromEntries(
    REQUIRED_ENV_KEYS.map((key) => [key, process.env[key]])
  ) as unknown as AgentEnv
}

const readHttpError = async (response: Response) => {
  const text = (await response.text().catch(() => '')).trim()
  if (!text) return `Request failed with status ${response.status}`
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return `Request failed with status ${response.status}: ${parsed.error.trim()}`
    }
  } catch {
    // Plain text is still a useful runtime diagnostic.
  }
  return `Request failed with status ${response.status}: ${text}`
}

const requestRuntime = async (path: string, init: RequestInit = {}) => {
  const env = getAgentEnv()
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${env.HIVE_PORT}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        'x-hive-agent-id': env.HIVE_AGENT_ID,
        'x-hive-agent-token': env.HIVE_AGENT_TOKEN,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to reach Yive Runtime: ${message}`)
  }
  if (!response.ok) throw new Error(await readHttpError(response))
  return response
}

const printRuntimeHelp = async (tool?: string) => {
  const env = getAgentEnv()
  const suffix = tool ? `/${encodeURIComponent(tool)}` : ''
  const response = await requestRuntime(
    `/api/workspaces/${encodeURIComponent(env.HIVE_PROJECT_ID)}/agent/help${suffix}`
  )
  const payload = (await response.json()) as { help?: unknown }
  if (typeof payload.help !== 'string' || !payload.help.trim()) {
    throw new Error('Runtime returned invalid Agent Help')
  }
  console.log(payload.help)
}

const readFlag = (argv: string[], name: string) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const findPositionals = (argv: string[], valueOptions: ReadonlySet<string>) =>
  argv.filter((argument, index) => {
    if (!argument || argument.startsWith('-')) return false
    return !valueOptions.has(argv[index - 1] ?? '')
  })

const validateOptions = (argv: string[], valueOptions: ReadonlySet<string>) => {
  const allowed = new Set([...valueOptions, '--json'])
  const seen = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument?.startsWith('-')) continue
    if (!allowed.has(argument)) throw new Error(`Unknown option: ${argument}`)
    if (seen.has(argument)) throw new Error(`Duplicate option: ${argument}`)
    seen.add(argument)
    if (valueOptions.has(argument)) {
      const value = argv[index + 1]
      if (!value || value.startsWith('-')) throw new Error(`${argument} requires a value`)
      index += 1
    }
  }
}

const postAgentTool = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
  const env = getAgentEnv()
  const response = await requestRuntime(path, {
    body: JSON.stringify({ ...body, workspace_id: env.HIVE_PROJECT_ID }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  return (await response.json()) as T
}

export const runAgentSendFileCommand = async (argv: string[]) => {
  validateOptions(argv, new Set())
  const artifacts = findPositionals(argv, new Set())
  if (artifacts.length !== 1) throw new Error('Usage: yive agent send-file <artifact> [--json]')
  const artifact = artifacts[0] as string
  const result = await postAgentTool<{ artifact: string; name: string; ok: true; size: number }>(
    '/api/agent/send-file',
    { path: artifact }
  )
  if (argv.includes('--json')) console.log(JSON.stringify(result))
  else {
    console.log(`Sent Artifact to mobile Files: ${result.artifact}`)
    console.log(`Name: ${result.name}`)
    console.log(`Size: ${result.size} bytes`)
  }
}

export const runAgentNotifyCommand = async (argv: string[]) => {
  const valueOptions = new Set(['--body', '--image'])
  validateOptions(argv, valueOptions)
  const titles = findPositionals(argv, valueOptions)
  const body = readFlag(argv, '--body')
  const image = readFlag(argv, '--image')
  if (titles.length !== 1 || !body?.trim()) {
    throw new Error('Usage: yive agent notify <title> --body <text> [--image <artifact>] [--json]')
  }
  const title = titles[0] as string
  const result = await postAgentTool<{
    image_artifact?: string
    ok: true
    title: string
  }>('/api/agent/notify', {
    body,
    ...(image ? { image_path: image } : {}),
    title,
  })
  if (argv.includes('--json')) console.log(JSON.stringify(result))
  else {
    console.log(`Notified user: ${result.title}`)
    if (result.image_artifact) console.log(`Image Artifact: ${result.image_artifact}`)
  }
}

export const runAgentCommand = async (argv: string[]) => {
  const [tool, ...args] = argv
  if (!tool || tool === 'help' || tool === '--help' || tool === '-h') {
    if (!hasAgentEnv()) {
      console.log(UNAUTHENTICATED_HELP)
      return
    }
    await printRuntimeHelp(tool === 'help' ? args[0] : undefined)
    return
  }
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    if (!hasAgentEnv()) {
      console.log(UNAUTHENTICATED_HELP)
      return
    }
    await printRuntimeHelp(tool)
    return
  }
  if (tool === 'send-file') return runAgentSendFileCommand(args)
  if (tool === 'notify') return runAgentNotifyCommand(args)
  throw new Error('Usage: yive agent <notify|send-file>')
}
