import { describe, expect, test } from 'vitest'

import {
  buildOrchestratorReportPayload,
  buildOrchestratorStatusPayload,
  buildOrchestratorUserInputPayload,
  buildWorkerDispatchPayload,
} from '../../src/server/agent-stdin-dispatcher.js'

describe('buildOrchestratorReportPayload', () => {
  test('keeps report metadata, body, and artifacts without a generic reminder', () => {
    const payload = buildOrchestratorReportPayload('coder-1', 'fix shipped', ['a.md', 'b.png'])

    expect(payload.split('\n')[0]).toContain('@coder-1')
    expect(payload).toContain('fix shipped')
    expect(payload.split('\n')).toContain('artifact: a.md')
    expect(payload.split('\n')).toContain('artifact: b.png')
    expect(payload).not.toContain('<hive-system-reminder>')
    expect(payload).not.toContain('team send')
    expect(payload).not.toContain('team cancel')
  })

  test('ends with a trailing newline so xterm bracketed paste submits the message', () => {
    expect(buildOrchestratorReportPayload('coder-1', 'done', []).endsWith('\n')).toBe(true)
  })
})

describe('buildOrchestratorStatusPayload', () => {
  test('keeps status metadata and body without a generic reminder', () => {
    const payload = buildOrchestratorStatusPayload('coder-1', 'waiting on tests', [])

    expect(payload.split('\n')[0]).toContain('@coder-1')
    expect(payload).toContain('waiting on tests')
    expect(payload).not.toContain('<hive-system-reminder>')
    expect(payload).not.toContain('team send')
  })
})

describe('buildOrchestratorUserInputPayload', () => {
  test('delivers user text byte-for-byte unchanged', () => {
    const input = 'please draft the migration'
    expect(buildOrchestratorUserInputPayload(input)).toBe(input)
  })

  test('preserves whitespace and multi-line user input exactly', () => {
    const input = '  line one\r\nline two\n\n'
    expect(buildOrchestratorUserInputPayload(input)).toBe(input)
  })
})

describe('buildWorkerDispatchPayload', () => {
  test('keeps only Dispatch metadata and task body', () => {
    const payload = buildWorkerDispatchPayload(
      'orchestrator-1',
      'disp-42',
      'add error handling to login.ts'
    )

    expect(payload.split('\n')[0]).toContain('@orchestrator-1')
    expect(payload).toContain('dispatch_id: disp-42')
    expect(payload).toContain('add error handling to login.ts')
    expect(payload).not.toContain('<hive-system-reminder>')
    expect(payload).not.toContain('team report')
    expect(payload).not.toContain('Task')
    expect(payload).not.toContain('Explore')
  })
})
