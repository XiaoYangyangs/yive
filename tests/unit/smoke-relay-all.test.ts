import { describe, expect, test } from 'vitest'

import {
  buildSmokeRelayAllChecklist,
  buildSmokeRelayAllRecommendedCommands,
  buildSmokeRelayAllRepairCommands,
  buildSmokeRelayAllSteps,
  getSmokeRelayAllFailureHint,
  redactSmokeRelayAllArgs,
  runSmokeRelayAll,
} from '../../deploy/smoke-relay-all.mjs'

describe('smoke-relay-all report builder', () => {
  test('builds the full remote-control smoke sequence', () => {
    const config = buildSmokeRelayAllSteps([
      '--server',
      'https://relay.example.com',
      '--token',
      'secret-token',
      '--desktop-id',
      'desktop-windows',
      '--workspace-id',
      'workspace-1',
      '--workspace-file',
      'README.md',
      '--run-id',
      'run-1',
      '--terminal-input',
      'pwd',
      '--expect-output',
      '/home',
      '--timeout-ms',
      '20000',
      '--settle-ms',
      '1500',
      '--max-stale-ms',
      '30000',
      '--require-live-update',
      '--json',
    ])

    expect(config.jsonMode).toBe(true)
    expect(config.serverUrl).toBe('https://relay.example.com')
    expect(config.desktopId).toBe('desktop-windows')
    expect(config.steps.map((step) => step.label)).toEqual([
      'Relay doctor diagnostics',
      'Relay HTTP/PWA smoke',
      'Relay mobile events smoke',
      'Relay file exchange smoke',
      'Relay terminal takeover smoke',
      'Relay terminal IO open-only smoke',
    ])
    expect(config.steps[0]?.args).toEqual([
      'relay',
      'doctor',
      '--server',
      'https://relay.example.com',
      '--token',
      'secret-token',
      '--json',
    ])
    expect(config.steps[3]?.args).toEqual([
      '--server',
      'https://relay.example.com',
      '--token',
      'secret-token',
      '--desktop-id',
      'desktop-windows',
      '--workspace-id',
      'workspace-1',
      '--workspace-file',
      'README.md',
      '--timeout-ms',
      '20000',
    ])
    expect(config.steps[4]?.args).toEqual([
      '--server',
      'https://relay.example.com',
      '--token',
      'secret-token',
      '--desktop-id',
      'desktop-windows',
      '--workspace-id',
      'workspace-1',
      '--run-id',
      'run-1',
      '--terminal-input',
      'pwd',
      '--expect-output',
      '/home',
      '--timeout-ms',
      '20000',
      '--settle-ms',
      '1500',
    ])
    expect(config.steps[2]?.args).toContain('--require-live-update')
    expect(config.steps[2]?.args).toContain('--max-stale-ms')
    expect(config.steps[2]?.args).toContain('30000')
    expect(config.steps[5]?.args).toContain('--open-only')
    expect(config.steps[5]?.args).toContain('io')
  })

  test('passes through raw terminal input mode when requested', () => {
    const config = buildSmokeRelayAllSteps([
      '--server',
      'https://relay.example.com',
      '--token',
      'secret-token',
      '--desktop-id',
      'desktop-windows',
      '--terminal-input',
      'typed-only',
      '--no-terminal-enter',
    ])

    expect(config.steps[4]?.args).toEqual([
      '--server',
      'https://relay.example.com',
      '--token',
      'secret-token',
      '--desktop-id',
      'desktop-windows',
      '--terminal-input',
      'typed-only',
      '--no-terminal-enter',
    ])
  })

  test('passes through expected terminal output matching when requested', () => {
    const config = buildSmokeRelayAllSteps([
      '--server',
      'https://relay.example.com',
      '--token',
      'secret-token',
      '--desktop-id',
      'desktop-windows',
      '--terminal-input',
      'node -e "console.log(\'YIVE_RELAY_OK\')"',
      '--expect-output',
      'YIVE_RELAY_OK',
    ])

    expect(config.steps[4]?.args).toContain('--expect-output')
    expect(config.steps[4]?.args).toContain('YIVE_RELAY_OK')
  })

  test('passes through one-flag terminal output verification when requested', () => {
    const config = buildSmokeRelayAllSteps([
      '--server',
      'https://relay.example.com',
      '--token',
      'secret-token',
      '--desktop-id',
      'desktop-windows',
      '--verify-terminal-output',
    ])

    expect(config.steps[4]?.args).toContain('--verify-terminal-output')
  })

  test('passes through takeover terminal size when requested', () => {
    const config = buildSmokeRelayAllSteps([
      '--server',
      'https://relay.example.com',
      '--token',
      'secret-token',
      '--desktop-id',
      'desktop-windows',
      '--takeover-cols',
      '52',
      '--takeover-rows',
      '18',
    ])

    expect(config.steps[4]?.args).toContain('--takeover-cols')
    expect(config.steps[4]?.args).toContain('52')
    expect(config.steps[4]?.args).toContain('--takeover-rows')
    expect(config.steps[4]?.args).toContain('18')
    expect(config.steps[5]?.args).not.toContain('--takeover-cols')
    expect(config.steps[5]?.args).not.toContain('--takeover-rows')
  })

  test('passes through relay image paste verification to file exchange smoke', () => {
    const config = buildSmokeRelayAllSteps([
      '--server',
      'https://relay.example.com',
      '--token',
      'secret-token',
      '--desktop-id',
      'desktop-windows',
      '--workspace-id',
      'workspace-1',
      '--run-id',
      'run-1',
      '--verify-image-paste',
    ])

    expect(config.steps[3]?.args).toEqual([
      '--server',
      'https://relay.example.com',
      '--token',
      'secret-token',
      '--desktop-id',
      'desktop-windows',
      '--workspace-id',
      'workspace-1',
      '--run-id',
      'run-1',
      '--verify-image-paste',
    ])
    expect(config.steps[4]?.args).toContain('--workspace-id')
    expect(config.steps[4]?.args).toContain('workspace-1')
    expect(config.steps[4]?.args).toContain('--run-id')
    expect(config.steps[4]?.args).toContain('run-1')
  })

  test('passes through temporary public HTTP allowance only to HTTP/PWA smoke', () => {
    const config = buildSmokeRelayAllSteps([
      '--server',
      'http://203.0.113.10',
      '--token',
      'secret-token',
      '--desktop-id',
      'desktop-windows',
      '--allow-http-only',
    ])

    expect(config.steps[1]?.args).toContain('--allow-http-only')
    expect(config.steps[2]?.args).not.toContain('--allow-http-only')
  })

  test('passes through Android app link verification only to HTTP/PWA smoke', () => {
    const config = buildSmokeRelayAllSteps([
      '--server',
      'https://relay.example.com',
      '--token',
      'secret-token',
      '--desktop-id',
      'desktop-windows',
      '--android-package',
      'com.example.yive',
      '--android-sha256',
      'AA:BB:CC',
    ])

    expect(config.steps[1]?.args).toContain('--android-package')
    expect(config.steps[1]?.args).toContain('com.example.yive')
    expect(config.steps[1]?.args).toContain('--android-sha256')
    expect(config.steps[1]?.args).toContain('AA:BB:CC')
    expect(config.steps[2]?.args).not.toContain('--android-package')
    expect(config.steps[3]?.args).not.toContain('--android-package')
  })

  test('redacts admin tokens from structured results', () => {
    expect(redactSmokeRelayAllArgs(['--server', 'https://relay', '--token', 'secret'])).toEqual([
      '--server',
      'https://relay',
      '--token',
      '[redacted]',
    ])
  })

  test('builds token-safe recommended commands for diagnostics and phones', () => {
    const commands = buildSmokeRelayAllRecommendedCommands({
      desktopId: 'desktop windows',
      serverUrl: 'https://relay.example/yive',
    })

    expect(commands.doctor).toBe(
      'yive relay doctor --server https://relay.example/yive --token <admin-token> --json'
    )
    expect(commands.connect_status).toBe(
      'yive connect status --server https://relay.example/yive --token <admin-or-device-token> --device-id "desktop windows"'
    )
    expect(commands.pair_phone).toBe(
      'yive relay pair --server https://relay.example/yive --token <admin-token> --desktop-id "desktop windows"'
    )
    expect(commands.verify_terminal_output).toBe(
      'pnpm smoke:relay-all -- --server https://relay.example/yive --token <admin-token> --desktop-id "desktop windows" --max-stale-ms 30000 --verify-terminal-output'
    )
    expect(commands.verify_image_paste).toBe(
      'pnpm smoke:relay-all -- --server https://relay.example/yive --token <admin-token> --desktop-id "desktop windows" --max-stale-ms 30000 --workspace-id <workspace-id> --run-id <run-id> --verify-image-paste'
    )
    expect(JSON.stringify(commands)).not.toContain('secret-token')
  })

  test('builds a token-safe public deployment checklist', () => {
    const checklist = buildSmokeRelayAllChecklist(
      [
        '--server',
        'https://relay.example.com',
        '--token',
        'secret-token',
        '--desktop-id',
        'desktop-windows',
        '--workspace-id',
        'workspace-1',
        '--run-id',
        'run-1',
        '--workspace-file',
        'README.md',
        '--allow-http-only',
      ],
      { YIVE_RELAY_ADMIN_TOKEN: 'secret-token' }
    )

    expect(checklist).toContain('# Yive 公网部署验收清单')
    expect(checklist).toContain('Relay：https://relay.example.com')
    expect(checklist).toContain('电脑设备：desktop-windows')
    expect(checklist).toContain('已带入 workspace/run：workspace-1 / run-1')
    expect(checklist).toContain('已带入 workspace 文件：README.md')
    expect(checklist).toContain('已检测到环境变量 YIVE_RELAY_ADMIN_TOKEN。')
    expect(checklist).toContain(
      'yive relay doctor --server https://relay.example.com --token <admin-token> --json'
    )
    expect(checklist).toContain(
      'yive connect status --server https://relay.example.com --token <admin-or-device-token> --device-id desktop-windows'
    )
    expect(checklist).toContain(
      'yive relay pair --server https://relay.example.com --token <admin-token> --desktop-id desktop-windows'
    )
    expect(checklist).toContain(
      'pnpm smoke:relay-all -- --server https://relay.example.com --token <admin-token> --desktop-id desktop-windows --allow-http-only --timeout-ms 60000 --max-stale-ms 30000'
    )
    expect(checklist).toContain(
      'pnpm smoke:relay-all -- --server https://relay.example.com --token <admin-token> --desktop-id desktop-windows --max-stale-ms 30000 --workspace-id workspace-1 --run-id run-1 --verify-terminal-output'
    )
    expect(checklist).toContain(
      'pnpm smoke:relay-all -- --server https://relay.example.com --token <admin-token> --desktop-id desktop-windows --max-stale-ms 30000 --workspace-id workspace-1 --workspace-file README.md'
    )
    expect(checklist).toContain(
      'pnpm smoke:relay-all -- --server https://relay.example.com --token <admin-token> --desktop-id desktop-windows --max-stale-ms 30000 --workspace-id workspace-1 --run-id run-1 --verify-image-paste'
    )
    expect(checklist).not.toContain('secret-token')
    expect(checklist).not.toContain('鍏')
    expect(checklist).not.toContain('锛')
  })

  test('adds Android TWA checks to the public deployment checklist when package details are supplied', () => {
    const checklist = buildSmokeRelayAllChecklist([
      '--server',
      'https://relay.example.com/mobile?relay=1',
      '--desktop-id',
      'desktop-windows',
      '--android-package',
      'com.example.yive',
      '--android-sha256',
      'AA:BB:CC',
      '--checklist',
    ])

    expect(checklist).toContain('8. 准备并离线验证 Android/TWA 外壳材料：')
    expect(checklist).toContain('pnpm build')
    expect(checklist).toContain(
      'pnpm mobile:android:assetlinks -- --out-dir web/dist --android-package com.example.yive --android-sha256 AA:BB:CC'
    )
    expect(checklist).toContain(
      'pnpm mobile:android:twa -- --domain https://relay.example.com --static-dir web/dist --out-dir android-twa --android-package com.example.yive --android-sha256 AA:BB:CC'
    )
    expect(checklist).toContain(
      'pnpm mobile:android:verify -- --domain https://relay.example.com --static-dir web/dist --twa-dir android-twa --android-package com.example.yive --android-sha256 AA:BB:CC'
    )
    expect(checklist).toContain(
      'pnpm smoke:relay-domain -- --domain relay.example.com --android-package com.example.yive --android-sha256 AA:BB:CC'
    )
    expect(checklist).toContain('9. 手工检查：手机能打开 /mobile 或 Android/TWA 外壳')
  })

  test('requires Android package and signing fingerprint together in the public deployment checklist', () => {
    expect(() =>
      buildSmokeRelayAllChecklist([
        '--server',
        'https://relay.example.com',
        '--desktop-id',
        'desktop-windows',
        '--android-package',
        'com.example.yive',
        '--checklist',
      ])
    ).toThrow('--android-package and --android-sha256 must be provided together')
  })

  test('builds step-specific token-safe repair commands', () => {
    const commands = buildSmokeRelayAllRepairCommands({
      desktopId: 'desktop windows',
      label: 'Relay terminal takeover smoke',
      serverUrl: 'https://relay.example/yive',
    })

    expect(commands).toEqual([
      'yive relay doctor --server https://relay.example/yive --token <admin-token> --json',
      'yive connect status --server https://relay.example/yive --token <admin-or-device-token> --device-id "desktop windows"',
      'pnpm smoke:relay-all -- --server https://relay.example/yive --token <admin-token> --desktop-id "desktop windows" --max-stale-ms 30000 --verify-terminal-output',
    ])
    expect(JSON.stringify(commands)).not.toContain('secret-token')
  })

  test('builds doctor-only repair commands when diagnostics fail', () => {
    const commands = buildSmokeRelayAllRepairCommands({
      desktopId: 'desktop windows',
      label: 'Relay doctor diagnostics',
      serverUrl: 'https://relay.example/yive',
    })

    expect(commands).toEqual([
      'yive relay doctor --server https://relay.example/yive --token <admin-token> --json',
    ])
    expect(JSON.stringify(commands)).not.toContain('secret-token')
  })

  test('returns a JSON-ready report and skips later checks after a failure', async () => {
    const seenLabels: string[] = []
    const report = await runSmokeRelayAll({
      argv: [
        '--server',
        'https://relay.example',
        '--token',
        'secret-token',
        '--desktop-id',
        'desktop-1',
        '--json',
      ],
      now: () => new Date('2026-06-11T12:00:00.000Z'),
      runner: async ({ args, label, script }) => {
        seenLabels.push(label)
        if (label === 'Relay terminal takeover smoke') {
          return {
            args: redactSmokeRelayAllArgs(args),
            duration_ms: 12,
            error: 'terminal failed',
            label,
            next_action: getSmokeRelayAllFailureHint({ error: 'terminal failed', label }),
            script,
            status: 'failed',
          }
        }
        return {
          args: redactSmokeRelayAllArgs(args),
          duration_ms: 10,
          label,
          script,
          status: 'passed',
          stderr: '',
          stdout: `${label} ok`,
        }
      },
    })

    expect(report).toMatchObject({
      desktop_id: 'desktop-1',
      generated_at: '2026-06-11T12:00:00.000Z',
      next_commands: [
        'yive relay doctor --server https://relay.example --token <admin-token> --json',
        'yive connect status --server https://relay.example --token <admin-or-device-token> --device-id desktop-1',
        'pnpm smoke:relay-all -- --server https://relay.example --token <admin-token> --desktop-id desktop-1 --max-stale-ms 30000 --verify-terminal-output',
      ],
      ok: false,
      recommended_commands: {
        connect_status:
          'yive connect status --server https://relay.example --token <admin-or-device-token> --device-id desktop-1',
        doctor: 'yive relay doctor --server https://relay.example --token <admin-token> --json',
        pair_phone:
          'yive relay pair --server https://relay.example --token <admin-token> --desktop-id desktop-1',
        verify_terminal_output:
          'pnpm smoke:relay-all -- --server https://relay.example --token <admin-token> --desktop-id desktop-1 --max-stale-ms 30000 --verify-terminal-output',
        verify_image_paste:
          'pnpm smoke:relay-all -- --server https://relay.example --token <admin-token> --desktop-id desktop-1 --max-stale-ms 30000 --workspace-id <workspace-id> --run-id <run-id> --verify-image-paste',
      },
      server: 'https://relay.example',
    })
    expect(seenLabels).toEqual([
      'Relay doctor diagnostics',
      'Relay HTTP/PWA smoke',
      'Relay mobile events smoke',
      'Relay file exchange smoke',
      'Relay terminal takeover smoke',
    ])
    expect(report.steps.map((step) => step.status)).toEqual([
      'passed',
      'passed',
      'passed',
      'passed',
      'failed',
      'skipped',
    ])
    expect(report.steps[4]?.next_action).toContain('先修终端接管链路')
    expect(report.steps[4]?.repair_commands).toEqual([
      'yive relay doctor --server https://relay.example --token <admin-token> --json',
      'yive connect status --server https://relay.example --token <admin-or-device-token> --device-id desktop-1',
      'pnpm smoke:relay-all -- --server https://relay.example --token <admin-token> --desktop-id desktop-1 --max-stale-ms 30000 --verify-terminal-output',
    ])
    expect(JSON.stringify(report)).not.toContain('secret-token')
  })

  test('stops the full smoke sequence when relay doctor diagnostics fail', async () => {
    const seenLabels: string[] = []
    const report = await runSmokeRelayAll({
      argv: [
        '--server',
        'https://relay.example',
        '--token',
        'secret-token',
        '--desktop-id',
        'desktop-1',
        '--json',
      ],
      runner: async ({ args, label, script }) => {
        seenLabels.push(label)
        return {
          args: redactSmokeRelayAllArgs(args),
          duration_ms: 10,
          error: 'doctor failed',
          label,
          next_action: getSmokeRelayAllFailureHint({ error: 'doctor failed', label }),
          script,
          status: 'failed',
        }
      },
    })

    expect(seenLabels).toEqual(['Relay doctor diagnostics'])
    expect(report.ok).toBe(false)
    expect(report.steps.map((step) => step.status)).toEqual([
      'failed',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ])
    expect(report.next_commands).toEqual([
      'yive relay doctor --server https://relay.example --token <admin-token> --json',
    ])
    expect(report.steps[0]?.repair_commands).toEqual([
      'yive relay doctor --server https://relay.example --token <admin-token> --json',
    ])
    expect(JSON.stringify(report)).not.toContain('secret-token')
  })

  test('treats relay doctor ok=false JSON as a full smoke failure', async () => {
    const seenLabels: string[] = []
    const report = await runSmokeRelayAll({
      argv: [
        '--server',
        'https://relay.example',
        '--token',
        'secret-token',
        '--desktop-id',
        'desktop-1',
        '--json',
      ],
      runner: async ({ args, label, script }) => {
        seenLabels.push(label)
        return {
          args: redactSmokeRelayAllArgs(args),
          duration_ms: 10,
          label,
          script,
          status: 'passed',
          stderr: '',
          stdout:
            label === 'Relay doctor diagnostics'
              ? JSON.stringify({
                  lines: ['[warn] Desktop features: desktop-old is missing mobile events.'],
                  ok: false,
                })
              : `${label} ok`,
        }
      },
    })

    expect(seenLabels).toEqual(['Relay doctor diagnostics'])
    expect(report.ok).toBe(false)
    expect(report.steps.map((step) => step.status)).toEqual([
      'failed',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ])
    expect(report.steps[0]).toMatchObject({
      error: 'Relay doctor reported ok=false',
      next_action: '先处理 relay doctor 输出中的失败项，然后重新运行完整公网验收。',
    })
    expect(report.steps[0]?.repair_commands).toEqual([
      'yive relay doctor --server https://relay.example --token <admin-token> --json',
    ])
    expect(JSON.stringify(report)).not.toContain('secret-token')
  })

  test('explains the next repair action for common public relay failures', () => {
    expect(
      getSmokeRelayAllFailureHint({
        error: "Desktop 'desktop-1' is not connected to Relay.",
        label: 'Relay mobile events smoke',
      })
    ).toContain('本地电脑没有连上 Relay')

    expect(
      getSmokeRelayAllFailureHint({
        stderr: 'Desktop is connected to Relay, but its local Yive runtime is offline',
        label: 'Relay mobile events smoke',
      })
    ).toContain('本地 Yive runtime 不在线')

    expect(
      getSmokeRelayAllFailureHint({
        stderr: 'Workspace has no terminal run to verify',
        label: 'Relay terminal takeover smoke',
      })
    ).toContain('没有可验收的终端 run')

    expect(
      getSmokeRelayAllFailureHint({
        stderr: 'Expected terminal output was not visible in mobile transcript: YIVE_RELAY_OK',
        label: 'Relay terminal takeover smoke',
      })
    ).toContain('没有在手机 transcript 里看到期望输出')

    expect(
      getSmokeRelayAllFailureHint({
        stderr: 'Terminal relay socket closed before opening',
        label: 'Relay terminal takeover smoke',
      })
    ).toContain('WebSocket 或终端代理链路异常')

    expect(
      getSmokeRelayAllFailureHint({
        stderr: 'native image paste result did not include attachment metadata',
        label: 'Relay file exchange smoke',
      })
    ).toContain('手机图片链路异常')
  })
})
