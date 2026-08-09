import { describe, expect, test } from 'vitest'

import {
  parseAddArgs,
  parseCancelArgs,
  parseQueueArgs,
  parseReplaceArgs,
  parseReportArgs,
} from '../../src/cli/team.js'

describe('parseAddArgs', () => {
  test('omits Provider so the server can inherit from the Orchestrator', () => {
    expect(parseAddArgs(['VideoMaker'])).toEqual({
      autostart: false,
      name: 'VideoMaker',
      provider: undefined,
    })
  })

  test('accepts a managed Provider and start flag in any order', () => {
    expect(parseAddArgs(['--start', '--provider', 'codex', 'VideoMaker'])).toEqual({
      autostart: true,
      name: 'VideoMaker',
      provider: 'codex',
    })
  })

  test('rejects retired Role flags with add usage', () => {
    try {
      parseAddArgs(['VideoMaker', '--role', 'manager'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('Unknown argument: --role')
      expect(message).toContain('Usage: team add')
      return
    }
    throw new Error('expected parseAddArgs to throw')
  })

  test('rejects retired or unknown launch flags', () => {
    for (const args of [
      ['VideoMaker', '--preset', 'codex'],
      ['VideoMaker', '--startup-command', 'codex'],
      ['VideoMaker', '--autostart'],
      ['VideoMaker', '--bogus'],
    ]) {
      expect(() => parseAddArgs(args)).toThrow('Unknown argument')
    }
  })

  test('rejects unsupported or duplicate Providers', () => {
    expect(() => parseAddArgs(['VideoMaker', '--provider', 'gemini'])).toThrow(
      'Unsupported Provider: gemini'
    )
    expect(() =>
      parseAddArgs(['VideoMaker', '--provider', 'codex', '--provider', 'claude'])
    ).toThrow('Duplicate --provider')
  })
})

describe('parseReportArgs', () => {
  test('binds automatically and accepts only completed or failed outcomes', () => {
    expect(parseReportArgs(['done'])).toEqual({
      artifacts: [],
      outcome: 'completed',
      result: 'done',
      useStdin: false,
    })
    expect(parseReportArgs(['--failed', 'blocked permanently'])).toEqual({
      artifacts: [],
      outcome: 'failed',
      result: 'blocked permanently',
      useStdin: false,
    })
    expect(() => parseReportArgs(['done', '--dispatch', 'dispatch-1'])).toThrow(
      'team report binds automatically'
    )
  })

  test('accepts a positional result with Artifacts', () => {
    const parsed = parseReportArgs(['done', '--artifact', 'src/foo.ts'])
    expect(parsed).toEqual({
      result: 'done',
      outcome: 'completed',
      artifacts: ['src/foo.ts'],
      useStdin: false,
    })
  })

  test('accepts flags before the positional result', () => {
    const parsed = parseReportArgs(['--artifact', 'src/result.md', 'done'])
    expect(parsed).toEqual({
      result: 'done',
      outcome: 'completed',
      artifacts: ['src/result.md'],
      useStdin: false,
    })
  })

  test('accepts mixed flag and positional ordering', () => {
    const parsed = parseReportArgs(['--artifact', 'src/a.ts', 'done', '--artifact', 'src/b.ts'])
    expect(parsed).toEqual({
      result: 'done',
      outcome: 'completed',
      artifacts: ['src/a.ts', 'src/b.ts'],
      useStdin: false,
    })
  })

  test('accepts one explicit Report outcome and rejects ambiguous flags', () => {
    expect(parseReportArgs(['done', '--success'])).toEqual({
      result: 'done',
      outcome: 'completed',
      artifacts: [],
      useStdin: false,
    })
    expect(parseReportArgs(['done', '--failed'])).toEqual({
      result: 'done',
      outcome: 'failed',
      artifacts: [],
      useStdin: false,
    })
    expect(() => parseReportArgs(['done', '--success', '--failed'])).toThrow(
      'Choose only one Report outcome'
    )
  })

  test('--stdin marks the body as deferred to stdin and leaves result null', () => {
    const parsed = parseReportArgs(['--stdin'])
    expect(parsed).toEqual({
      result: null,
      outcome: 'completed',
      artifacts: [],
      useStdin: true,
    })
  })

  test('--stdin works regardless of where it appears in argv', () => {
    expect(parseReportArgs(['--failed', '--stdin']).useStdin).toBe(true)
    expect(parseReportArgs(['--artifact', 'a.ts', '--stdin']).useStdin).toBe(true)
  })

  test('--stdin combined with a positional is rejected', () => {
    try {
      parseReportArgs(['done', '--stdin'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('--stdin is mutually exclusive with a positional argument')
      expect(message).toContain('Usage:')
      return
    }
    throw new Error('expected parseReportArgs to throw')
  })

  test('--stdin works on the status command and reports against the status usage line', () => {
    expect(parseReportArgs(['--stdin'], 'status')).toEqual({
      result: null,
      artifacts: [],
      notify: false,
      useStdin: true,
    })
    try {
      parseReportArgs(['working', '--stdin'], 'status')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('--stdin is mutually exclusive with a positional argument')
      expect(message).toContain('Usage: team status')
      return
    }
    throw new Error('expected parseReportArgs to throw')
  })

  test('accepts --notify only for Status and rejects duplicate notification flags', () => {
    expect(parseReportArgs(['working', '--notify'], 'status')).toEqual({
      artifacts: [],
      notify: true,
      result: 'working',
      useStdin: false,
    })
    expect(() => parseReportArgs(['working', '--notify', '--notify'], 'status')).toThrow(
      '--notify may only be specified once'
    )
    expect(() => parseReportArgs(['done', '--notify'])).toThrow('Unknown argument: --notify')
  })

  describe('error messages embed the usage line', () => {
    test('--dispatch is rejected because responsibility binds automatically', () => {
      try {
        parseReportArgs(['done', '--dispatch'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('team report binds automatically')
        expect(message).toContain('Usage: team report')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('--artifact followed by another flag', () => {
      try {
        parseReportArgs(['done', '--artifact', '--failed'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('--artifact requires a value')
        expect(message).toContain('Usage:')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('unknown flag', () => {
      try {
        parseReportArgs(['done', '--unknown'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('Unknown argument: --unknown')
        expect(message).toContain('Usage:')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('missing positional result hints at --stdin', () => {
      try {
        parseReportArgs(['--artifact', 'result.md'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('Missing <result>')
        expect(message).toContain('--stdin to read it from stdin')
        expect(message).toContain('Usage: team report')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('multiple positional results are rejected', () => {
      try {
        parseReportArgs(['first', 'second'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('Expected exactly one result positional, got 2')
        expect(message).toContain('"first"')
        expect(message).toContain('"second"')
        expect(message).toContain('Usage:')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('--dispatch on a status command explains automatic binding', () => {
      try {
        parseReportArgs(['working', '--dispatch', 'abc'], 'status')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('team status binds automatically')
        expect(message).toContain('Usage: team status')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('status command missing positional uses status usage line', () => {
      try {
        parseReportArgs([], 'status')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('Missing <current status>')
        expect(message).toContain('Usage: team status')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })
  })
})

describe('parseCancelArgs', () => {
  test('requires a dispatch id and joins multi-word reasons', () => {
    expect(parseCancelArgs(['--dispatch', 'dispatch-1', 'Direction', 'changed'])).toEqual({
      dispatchId: 'dispatch-1',
      reason: 'Direction changed',
      requestId: undefined,
    })
    expect(
      parseCancelArgs([
        '--dispatch',
        'dispatch-1',
        '--request-id',
        'cancel-recovery-1',
        'Direction changed',
      ])
    ).toMatchObject({ requestId: 'cancel-recovery-1' })
  })

  test('rejects missing dispatch id with cancel usage', () => {
    try {
      parseCancelArgs(['Direction changed'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('Missing --dispatch <dispatch-id>')
      expect(message).toContain('Usage: team cancel')
      return
    }
    throw new Error('expected parseCancelArgs to throw')
  })
})

describe('parseReplaceArgs', () => {
  test('accepts replacement text, Artifacts, and an explicit interruption flag', () => {
    expect(
      parseReplaceArgs([
        '--dispatch',
        'dispatch-1',
        'Corrected',
        'task',
        '--artifact',
        'src/fix.ts',
        '--interrupt',
      ])
    ).toEqual({
      artifacts: ['src/fix.ts'],
      dispatchId: 'dispatch-1',
      interrupt: true,
      requestId: undefined,
      task: 'Corrected task',
    })
    expect(
      parseReplaceArgs([
        '--dispatch',
        'dispatch-1',
        '--request-id',
        'replace-recovery-1',
        'Corrected task',
      ])
    ).toMatchObject({ requestId: 'replace-recovery-1' })
  })

  test('rejects missing targets and duplicate interruption flags with replace usage', () => {
    expect(() => parseReplaceArgs(['Corrected task'])).toThrow('Usage: team replace')
    expect(() =>
      parseReplaceArgs(['--dispatch', 'dispatch-1', '--interrupt', '--interrupt', 'task'])
    ).toThrow('Duplicate --interrupt')
  })
})

describe('parseQueueArgs', () => {
  test('accepts only explicit Worker queue resume', () => {
    expect(parseQueueArgs(['resume', 'Alice'])).toEqual({
      action: 'resume',
      workerName: 'Alice',
    })
    expect(() => parseQueueArgs(['Alice'])).toThrow('Usage: team queue resume <worker-name>')
    expect(() => parseQueueArgs(['resume', 'Alice', 'Bob'])).toThrow(
      'Expected exactly one worker name'
    )
  })
})
