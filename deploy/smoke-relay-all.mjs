#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const usage = `Usage: node deploy/smoke-relay-all.mjs --server <url> --token <admin-token> --desktop-id <id> [--run-id <run-id>] [--workspace-id <id>] [--workspace-file <relative-path>] [--terminal-input <text>] [--expect-output <text>] [--verify-terminal-output] [--verify-image-paste] [--no-terminal-enter] [--takeover-cols <n>] [--takeover-rows <n>] [--timeout-ms <ms>] [--settle-ms <ms>] [--max-stale-ms <ms>] [--require-live-update] [--allow-http-only] [--json]
       node deploy/smoke-relay-all.mjs --server <url> --desktop-id <id> [--workspace-id <id>] [--run-id <run-id>] [--allow-http-only] [--android-package <id> --android-sha256 <fingerprint>] --checklist

Examples:
  node deploy/smoke-relay-all.mjs --server http://203.0.113.10 --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows --allow-http-only
  node deploy/smoke-relay-all.mjs --server https://relay.example.com --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows --run-id run-123
  node deploy/smoke-relay-all.mjs --server https://relay.example.com --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows --json
  node deploy/smoke-relay-all.mjs --server https://relay.example.com --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows --require-live-update
  node deploy/smoke-relay-all.mjs --server https://relay.example.com --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows --verify-terminal-output
  node deploy/smoke-relay-all.mjs --server https://relay.example.com --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows --workspace-id workspace-1 --run-id run-1 --verify-image-paste
  node deploy/smoke-relay-all.mjs --server https://relay.example.com --token "$YIVE_RELAY_ADMIN_TOKEN" --desktop-id desktop-windows --terminal-input "node -e \\"console.log('YIVE_RELAY_OK')\\"" --expect-output "YIVE_RELAY_OK"
  node deploy/smoke-relay-all.mjs --server https://relay.example.com --desktop-id desktop-windows --workspace-id workspace-1 --run-id run-1 --checklist
`

const scriptDir = dirname(fileURLToPath(import.meta.url))

const readFlag = (argv, name) => {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  return argv[index + 1]
}

const hasInvalidFlagValue = (value) => !value || value.startsWith('--')

const optionalFlag = (argv, name) => {
  const value = readFlag(argv, name)
  return value && !value.startsWith('--') ? [name, value] : []
}

export const redactSmokeRelayAllArgs = (args) => {
  const redacted = []
  for (let index = 0; index < args.length; index += 1) {
    redacted.push(args[index])
    if (args[index] === '--token' && index + 1 < args.length) {
      redacted.push('[redacted]')
      index += 1
    }
  }
  return redacted
}

const shellQuote = (value) => {
  const text = String(value)
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(text)) return text
  return JSON.stringify(text)
}

export const buildSmokeRelayAllRecommendedCommands = ({ desktopId, serverUrl }) => ({
  connect_status: `yive connect status --server ${shellQuote(
    serverUrl
  )} --token <admin-or-device-token> --device-id ${shellQuote(desktopId)}`,
  doctor: `yive relay doctor --server ${shellQuote(serverUrl)} --token <admin-token> --json`,
  pair_phone: `yive relay pair --server ${shellQuote(
    serverUrl
  )} --token <admin-token> --desktop-id ${shellQuote(desktopId)}`,
  verify_terminal_output: `pnpm smoke:relay-all -- --server ${shellQuote(
    serverUrl
  )} --token <admin-token> --desktop-id ${shellQuote(
    desktopId
  )} --max-stale-ms 30000 --verify-terminal-output`,
  verify_image_paste: `pnpm smoke:relay-all -- --server ${shellQuote(
    serverUrl
  )} --token <admin-token> --desktop-id ${shellQuote(
    desktopId
  )} --max-stale-ms 30000 --workspace-id <workspace-id> --run-id <run-id> --verify-image-paste`,
})

const buildSmokeRelayCommand = ({ args = [], desktopId, serverUrl }) =>
  [
    'pnpm smoke:relay-all --',
    '--server',
    shellQuote(serverUrl),
    '--token',
    '<admin-token>',
    '--desktop-id',
    shellQuote(desktopId),
    ...args,
  ].join(' ')

export const buildSmokeRelayAllChecklist = (argv, env = process.env) => {
  const serverUrl = readFlag(argv, '--server')
  const desktopId = readFlag(argv, '--desktop-id')

  if (hasInvalidFlagValue(serverUrl) || hasInvalidFlagValue(desktopId)) {
    throw new Error(usage)
  }

  const commands = buildSmokeRelayAllRecommendedCommands({ desktopId, serverUrl })
  const workspaceId = readFlag(argv, '--workspace-id')
  const runId = readFlag(argv, '--run-id')
  const workspaceFile = readFlag(argv, '--workspace-file')
  const androidPackage = readFlag(argv, '--android-package')
  const androidSha256 = readFlag(argv, '--android-sha256')
  if (Boolean(androidPackage) !== Boolean(androidSha256)) {
    throw new Error('--android-package and --android-sha256 must be provided together')
  }
  const allowHttpOnly = argv.includes('--allow-http-only')
  const timeoutMs = readFlag(argv, '--timeout-ms') ?? '60000'
  const maxStaleMs = readFlag(argv, '--max-stale-ms') ?? '30000'
  const hasTerminalTarget =
    workspaceId && !workspaceId.startsWith('--') && runId && !runId.startsWith('--')
  const hasWorkspaceFileTarget =
    workspaceId && !workspaceId.startsWith('--') && workspaceFile && !workspaceFile.startsWith('--')
  const hasAndroidTarget =
    androidPackage &&
    !androidPackage.startsWith('--') &&
    androidSha256 &&
    !androidSha256.startsWith('--')
  const relayOrigin = new URL(serverUrl).origin
  const relayHost = new URL(serverUrl).host
  const httpArgs = allowHttpOnly ? ['--allow-http-only'] : []
  const targetArgs = hasTerminalTarget
    ? ['--workspace-id', shellQuote(workspaceId), '--run-id', shellQuote(runId)]
    : ['--workspace-id', '<workspace-id>', '--run-id', '<run-id>']
  const workspaceFileArgs = hasWorkspaceFileTarget
    ? ['--workspace-id', shellQuote(workspaceId), '--workspace-file', shellQuote(workspaceFile)]
    : ['--workspace-id', '<workspace-id>', '--workspace-file', '<relative-file>']
  const terminalCommand = buildSmokeRelayCommand({
    args: ['--max-stale-ms', maxStaleMs, ...targetArgs, '--verify-terminal-output'],
    desktopId,
    serverUrl,
  })
  const imageCommand = buildSmokeRelayCommand({
    args: ['--max-stale-ms', maxStaleMs, ...targetArgs, '--verify-image-paste'],
    desktopId,
    serverUrl,
  })
  const workspaceFileCommand = buildSmokeRelayCommand({
    args: ['--max-stale-ms', maxStaleMs, ...workspaceFileArgs],
    desktopId,
    serverUrl,
  })
  const fullCommand = buildSmokeRelayCommand({
    args: [...httpArgs, '--timeout-ms', timeoutMs, '--max-stale-ms', maxStaleMs],
    desktopId,
    serverUrl,
  })
  const terminalTargetNote = hasTerminalTarget
    ? `已带入 workspace/run：${workspaceId} / ${runId}`
    : '如果要验收终端输入、图片粘贴和文件交换，先在电脑端打开一个 Agent，然后把 <workspace-id> 和 <run-id> 换成真实值。'
  const workspaceFileNote = hasWorkspaceFileTarget
    ? `已带入 workspace 文件：${workspaceFile}`
    : '如果要验收电脑发送文件到手机下载，把 <relative-file> 换成 workspace 内真实存在的相对路径，例如 README.md 或 demo.mp4。'
  const envToken = env.YIVE_RELAY_ADMIN_TOKEN ? '已检测到环境变量 YIVE_RELAY_ADMIN_TOKEN。' : ''

  return [
    '# Yive 公网部署验收清单',
    '',
    `Relay：${serverUrl}`,
    `电脑设备：${desktopId}`,
    terminalTargetNote,
    workspaceFileNote,
    envToken,
    '',
    '1. 在服务器确认 Relay 和管理员诊断正常：',
    `   ${commands.doctor}`,
    '',
    '2. 在本地电脑确认 desktop bridge 已经连上公网 Relay：',
    `   ${commands.connect_status}`,
    '',
    '3. 生成手机配对链接，并在手机浏览器打开：',
    `   ${commands.pair_phone}`,
    '',
    '4. 跑完整公网验收，确认 HTTP/PWA、手机事件、文件交换和终端代理都可用：',
    `   ${fullCommand}`,
    '',
    '5. 跑终端接管与输出验收：',
    `   ${terminalCommand}`,
    '',
    '6. 跑电脑 workspace 文件发送到手机下载验收：',
    `   ${workspaceFileCommand}`,
    '',
    '7. 跑手机图片粘贴/上传验收：',
    `   ${imageCommand}`,
    '',
    ...(hasAndroidTarget
      ? [
          '8. 准备并离线验证 Android/TWA 外壳材料：',
          '   pnpm build',
          `   pnpm mobile:android:assetlinks -- --out-dir web/dist --android-package ${shellQuote(
            androidPackage
          )} --android-sha256 ${shellQuote(androidSha256)}`,
          `   pnpm mobile:android:twa -- --domain ${shellQuote(
            relayOrigin
          )} --static-dir web/dist --out-dir android-twa --android-package ${shellQuote(
            androidPackage
          )} --android-sha256 ${shellQuote(androidSha256)}`,
          `   pnpm mobile:android:verify -- --domain ${shellQuote(
            relayOrigin
          )} --static-dir web/dist --twa-dir android-twa --android-package ${shellQuote(
            androidPackage
          )} --android-sha256 ${shellQuote(androidSha256)}`,
          `   pnpm smoke:relay-domain -- --domain ${shellQuote(
            relayHost
          )} --android-package ${shellQuote(androidPackage)} --android-sha256 ${shellQuote(
            androidSha256
          )}`,
          '',
          '9. 手工检查：手机能打开 /mobile 或 Android/TWA 外壳，能看到工作区，点进 Agent 后能接管原始终端；电脑端会显示手机正在接管，并且可以重新接管。',
        ]
      : [
          '8. 手工检查：手机能打开 /mobile，能看到工作区，点进 Agent 后能接管原始终端；电脑端会显示手机正在接管，并且可以重新接管。',
        ]),
    '',
    '安全提醒：上面的命令只使用 <admin-token> 或 <admin-or-device-token> 占位符，不要把真实 token 发给别人。',
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}

export const buildSmokeRelayAllRepairCommands = ({ desktopId, label, serverUrl }) => {
  const commands = buildSmokeRelayAllRecommendedCommands({ desktopId, serverUrl })
  const common = [commands.doctor, commands.connect_status]
  if (label === 'Relay doctor diagnostics') return [commands.doctor]
  if (label === 'Relay HTTP/PWA smoke') return [commands.doctor]
  if (label === 'Relay mobile events smoke') return [...common, commands.pair_phone]
  if (label === 'Relay file exchange smoke') return [...common, commands.verify_image_paste]
  if (label === 'Relay terminal takeover smoke') {
    return [...common, commands.verify_terminal_output]
  }
  if (label === 'Relay terminal IO open-only smoke') {
    return [...common, commands.verify_terminal_output]
  }
  return common
}

export const getSmokeRelayAllFailureHint = ({
  error = '',
  label = '',
  stderr = '',
  stdout = '',
}) => {
  const detail = `${error}\n${stderr}\n${stdout}`
  if (
    /desktop '.+' is not connected|desktop .+ is not connected|not connected to relay/iu.test(
      detail
    )
  ) {
    return '本地电脑没有连上 Relay：先在本地电脑运行 yive connect，确认 desktop-id 和 smoke 命令一致，再运行 yive relay doctor。'
  }
  if (/local yive runtime is offline|runtime is offline|local_runtime_error/iu.test(detail)) {
    return '本地电脑已连上 Relay，但本地 Yive runtime 不在线：先打开本地 yive，确认 3001/本地 runtime 正常，再重新运行 smoke。'
  }
  if (
    /no terminal run|has no terminal run|workspace .+ was not found|run.+not found/iu.test(detail)
  ) {
    return 'Relay 能访问本地 runtime，但没有可验收的终端 run：先启动一个 Agent，或给 smoke 命令传入正确的 --workspace-id 和 --run-id。'
  }
  if (/expected terminal output was not visible|expect-output/iu.test(detail)) {
    return '终端输入已经送达，但没有在手机 transcript 里看到期望输出：确认命令会真实执行、--expect-output 文本正确，并等待 Agent 输出刷新。'
  }
  if (
    /native image paste|verify-image-paste|image paste|mobile_action native_image_paste/iu.test(
      detail
    )
  ) {
    return '手机图片链路异常：确认本地 runtime 文件交换 API 可用，传入了正确的 --workspace-id 和 --run-id，并且目标 Agent 终端正在运行。'
  }
  if (
    /websocket|socket|terminal proxy|closed before opening|timed out while opening/iu.test(detail)
  ) {
    return 'WebSocket 或终端代理链路异常：检查服务器反向代理是否放行 WebSocket upgrade，确认 Relay、desktop bridge、本地 runtime 都在线。'
  }
  if (/403|401|unauthorized|forbidden|token|pairing/iu.test(detail)) {
    return '鉴权或配对失败：确认 --token 是 Relay admin token，手机测试设备没有被撤销，必要时重新生成配对链接。'
  }
  if (/manifest|service worker|pwa|static|mobile app/iu.test(detail)) {
    return 'Relay HTTP 可达但 PWA 静态资源异常：检查 web/dist 是否是最新构建，确认 YIVE_RELAY_STATIC_DIR 和反向代理静态资源路径。'
  }
  if (label === 'Relay HTTP/PWA smoke') {
    return '先修 Relay 基础访问：检查服务器进程、端口、安全组、Nginx 转发、/health、/mobile、manifest 和 service worker。'
  }
  if (label === 'Relay mobile events smoke') {
    return '先修手机实时状态链路：确认本地 desktop bridge 在线、本地 runtime 在线，并且 /ws/mobile 事件流可以从 Relay 转发。'
  }
  if (label === 'Relay file exchange smoke') {
    return '先修文件交换链路：确认本地 runtime 的文件 API 可用；如传了 --workspace-file，确认路径存在且 workspace-id 正确。'
  }
  if (label === 'Relay terminal takeover smoke') {
    return '先修终端接管链路：确认目标 Agent 有运行中的 PTY，Relay 终端代理 WebSocket 可打开，并且 takeover_request 能返回。'
  }
  if (label === 'Relay terminal IO open-only smoke') {
    return '先修终端 IO 代理链路：确认 /ws/terminal/.../io 可以通过 Relay 和反向代理打开。'
  }
  return '查看失败步骤的 stdout/stderr，并按顺序确认 Relay /health、设备列表、本地 desktop bridge、本地 runtime、Agent run 和 WebSocket 代理。'
}

export const buildSmokeRelayAllSteps = (argv, env = process.env) => {
  const serverUrl = readFlag(argv, '--server')
  const token = readFlag(argv, '--token') ?? env.YIVE_RELAY_ADMIN_TOKEN
  const desktopId = readFlag(argv, '--desktop-id')

  if (
    hasInvalidFlagValue(serverUrl) ||
    hasInvalidFlagValue(token) ||
    hasInvalidFlagValue(desktopId)
  ) {
    throw new Error(usage)
  }

  const baseArgs = ['--server', serverUrl, '--token', token]
  const allowHttpOnlyArgs = argv.includes('--allow-http-only') ? ['--allow-http-only'] : []
  const androidAppLinkArgs = [
    ...optionalFlag(argv, '--android-package'),
    ...optionalFlag(argv, '--android-sha256'),
  ]
  const desktopArgs = [...baseArgs, '--desktop-id', desktopId]
  const timeoutArgs = optionalFlag(argv, '--timeout-ms')
  const settleArgs = optionalFlag(argv, '--settle-ms')
  const maxStaleArgs = optionalFlag(argv, '--max-stale-ms')
  const liveUpdateArgs = argv.includes('--require-live-update') ? ['--require-live-update'] : []
  const workspaceIdArgs = optionalFlag(argv, '--workspace-id')
  const runIdArgs = optionalFlag(argv, '--run-id')
  const terminalTargetArgs = [...workspaceIdArgs, ...runIdArgs]
  const terminalInputArgs = optionalFlag(argv, '--terminal-input')
  const terminalOutputArgs = optionalFlag(argv, '--expect-output')
  const verifyTerminalOutputArgs = argv.includes('--verify-terminal-output')
    ? ['--verify-terminal-output']
    : []
  const takeoverSizeArgs = [
    ...optionalFlag(argv, '--takeover-cols'),
    ...optionalFlag(argv, '--takeover-rows'),
  ]
  const verifyImagePaste = argv.includes('--verify-image-paste')
  const verifyImagePasteArgs = verifyImagePaste ? ['--verify-image-paste'] : []
  const terminalEnterArgs = argv.includes('--no-terminal-enter') ? ['--no-terminal-enter'] : []
  const workspaceFileArgs = optionalFlag(argv, '--workspace-file')
  const fileExchangeArgs = [
    ...(workspaceFileArgs.length > 0 || verifyImagePaste ? workspaceIdArgs : []),
    ...workspaceFileArgs,
    ...(verifyImagePaste ? runIdArgs : []),
    ...verifyImagePasteArgs,
  ]

  return {
    desktopId,
    jsonMode: argv.includes('--json'),
    serverUrl,
    steps: [
      {
        args: ['relay', 'doctor', '--server', serverUrl, '--token', token, '--json'],
        label: 'Relay doctor diagnostics',
        script: 'yive-cli',
      },
      {
        args: [...baseArgs, ...allowHttpOnlyArgs, ...androidAppLinkArgs],
        label: 'Relay HTTP/PWA smoke',
        script: 'smoke-relay.mjs',
      },
      {
        args: [...desktopArgs, ...timeoutArgs, ...maxStaleArgs, ...liveUpdateArgs],
        label: 'Relay mobile events smoke',
        script: 'smoke-mobile-events-relay.mjs',
      },
      {
        args: [...desktopArgs, ...fileExchangeArgs, ...timeoutArgs],
        label: 'Relay file exchange smoke',
        script: 'smoke-file-exchange-relay.mjs',
      },
      {
        args: [
          ...desktopArgs,
          ...terminalTargetArgs,
          ...terminalInputArgs,
          ...terminalOutputArgs,
          ...verifyTerminalOutputArgs,
          ...terminalEnterArgs,
          ...takeoverSizeArgs,
          ...timeoutArgs,
          ...settleArgs,
        ],
        label: 'Relay terminal takeover smoke',
        script: 'smoke-terminal-relay.mjs',
      },
      {
        args: [
          ...desktopArgs,
          ...terminalTargetArgs,
          '--open-only',
          '--stream',
          'io',
          ...timeoutArgs,
          ...settleArgs,
        ],
        label: 'Relay terminal IO open-only smoke',
        script: 'smoke-terminal-relay.mjs',
      },
    ],
  }
}

const buildYiveCliCommand = (args) => {
  const distCli = join(scriptDir, '..', 'dist', 'src', 'cli', 'hive.js')
  if (existsSync(distCli)) return [process.execPath, [distCli, ...args]]
  return [
    process.execPath,
    [join(scriptDir, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/cli/hive.ts', ...args],
  ]
}

const defaultSpawnRunner = ({ args, jsonMode, label, script }) =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now()
    if (!jsonMode) console.log(`\n== ${label} ==`)
    const command =
      script === 'yive-cli'
        ? buildYiveCliCommand(args)
        : [process.execPath, [join(scriptDir, script), ...args]]
    const captureOutput = jsonMode || label === 'Relay doctor diagnostics'
    const child = spawn(command[0], command[1], {
      stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    })
    const stdout = []
    const stderr = []
    if (captureOutput) {
      child.stdout?.on('data', (chunk) => stdout.push(chunk.toString()))
      child.stderr?.on('data', (chunk) => stderr.push(chunk.toString()))
    }
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      const durationMs = Date.now() - startedAt
      if (!jsonMode && captureOutput) {
        const stdoutText = stdout.join('')
        const stderrText = stderr.join('')
        if (stdoutText) process.stdout.write(stdoutText)
        if (stderrText) process.stderr.write(stderrText)
      }
      if (code === 0) {
        resolve({
          args: redactSmokeRelayAllArgs(args),
          duration_ms: durationMs,
          label,
          script,
          status: 'passed',
          stderr: stderr.join(''),
          stdout: stdout.join(''),
        })
        return
      }
      const error = `${label} failed${signal ? ` with signal ${signal}` : ` with code ${code}`}`
      const result = {
        args: redactSmokeRelayAllArgs(args),
        duration_ms: durationMs,
        error,
        exit_code: code,
        label,
        next_action: getSmokeRelayAllFailureHint({
          error,
          label,
          stderr: stderr.join(''),
          stdout: stdout.join(''),
        }),
        script,
        signal,
        status: 'failed',
        stderr: stderr.join(''),
        stdout: stdout.join(''),
      }
      if (jsonMode) {
        resolve(result)
        return
      }
      resolve(result)
    })
  })

const normalizeSmokeRelayAllStepResult = ({ desktopId, result, serverUrl }) => {
  if (result.status !== 'passed' || result.label !== 'Relay doctor diagnostics') return result
  if (!result.stdout?.trim()) return result

  try {
    const payload = JSON.parse(result.stdout)
    if (!payload || typeof payload !== 'object' || payload.ok !== false) return result
    const failed = {
      ...result,
      error: 'Relay doctor reported ok=false',
      next_action: '先处理 relay doctor 输出中的失败项，然后重新运行完整公网验收。',
      status: 'failed',
    }
    if (!failed.repair_commands) {
      failed.repair_commands = buildSmokeRelayAllRepairCommands({
        desktopId,
        label: failed.label,
        serverUrl,
      })
    }
    return failed
  } catch {
    return result
  }
}

export const runSmokeRelayAll = async ({
  argv,
  env = process.env,
  now = () => new Date(),
  runner = defaultSpawnRunner,
} = {}) => {
  const config = buildSmokeRelayAllSteps(argv ?? process.argv.slice(2), env)
  const recommendedCommands = buildSmokeRelayAllRecommendedCommands({
    desktopId: config.desktopId,
    serverUrl: config.serverUrl,
  })
  const results = []

  for (const step of config.steps) {
    const result = normalizeSmokeRelayAllStepResult({
      desktopId: config.desktopId,
      result: await runner({ ...step, jsonMode: config.jsonMode }),
      serverUrl: config.serverUrl,
    })
    if (result.status === 'failed' && !result.repair_commands) {
      result.repair_commands = buildSmokeRelayAllRepairCommands({
        desktopId: config.desktopId,
        label: result.label,
        serverUrl: config.serverUrl,
      })
    }
    results.push(result)
    if (result.status === 'failed') {
      for (const skipped of config.steps.slice(results.length)) {
        results.push({
          args: redactSmokeRelayAllArgs(skipped.args),
          label: skipped.label,
          script: skipped.script,
          status: 'skipped',
        })
      }
      break
    }
  }

  const failed = results.find((result) => result.status === 'failed')
  return {
    desktop_id: config.desktopId,
    generated_at: now().toISOString(),
    next_commands: failed
      ? buildSmokeRelayAllRepairCommands({
          desktopId: config.desktopId,
          label: failed.label,
          serverUrl: config.serverUrl,
        })
      : [recommendedCommands.verify_terminal_output, recommendedCommands.verify_image_paste],
    ok: !failed,
    recommended_commands: recommendedCommands,
    server: config.serverUrl,
    steps: results,
  }
}

const main = async () => {
  const argv = process.argv.slice(2)
  if (argv.includes('--checklist')) {
    console.log(buildSmokeRelayAllChecklist(argv))
    return
  }
  const jsonMode = argv.includes('--json')
  const report = await runSmokeRelayAll({ argv })
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2))
  } else if (report.ok) {
    console.log('\nYive relay all smoke tests passed.')
  } else {
    const failed = report.steps.find((step) => step.status === 'failed')
    console.error('\nYive relay all smoke tests failed.')
    if (failed) {
      console.error(`- failed step: ${failed.label}`)
      if (failed.error) console.error(`- error: ${failed.error}`)
      if (failed.next_action) console.error(`- next action: ${failed.next_action}`)
      if (failed.repair_commands?.length) {
        console.error('- repair commands:')
        for (const command of failed.repair_commands) console.error(`  ${command}`)
      }
    }
  }
  if (!report.ok) process.exitCode = 1
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (isCliEntry) {
  main().catch((error) => {
    const jsonMode = process.argv.includes('--json')
    const message = error instanceof Error ? error.message : String(error)
    if (jsonMode) {
      console.log(
        JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            ok: false,
            steps: [],
            error: message,
          },
          null,
          2
        )
      )
    } else {
      console.error(message)
    }
    process.exit(1)
  })
}
