import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  createPostStartInputWriter,
  createPostStartInputWriterAsync,
  hasBracketedPasteAcknowledgement,
  hasInteractivePromptReady,
  isInteractiveAgentCommand,
} from '../../src/server/post-start-input-writer.js'

describe('post-start input writer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('recognizes interactive TUI prompts', () => {
    expect(hasInteractivePromptReady('booting\n❯ ')).toBe(true)
    expect(hasInteractivePromptReady('booting\n› ')).toBe(true)
    expect(hasInteractivePromptReady('booting only')).toBe(false)
  })

  test('recognizes a redrawn Provider prompt after an ANSI cursor-position boundary', () => {
    expect(hasInteractivePromptReady('previous turn\u001b[4;1H\u276f \u001b[?25h', 'codex')).toBe(
      true
    )
  })

  test('recognizes Windows executable wrappers as interactive commands', () => {
    expect(isInteractiveAgentCommand('/tmp/codex.cmd')).toBe(true)
    expect(isInteractiveAgentCommand('/tmp/claude.exe')).toBe(true)
  })

  test('recognizes Claude bracketed-paste acknowledgements after the baseline output', () => {
    const baseline = 'Welcome back\n❯ '
    expect(
      hasBracketedPasteAcknowledgement(`${baseline}[Pasted text #1 +25 lines]`, baseline.length)
    ).toBe(true)
    const oldOutput = `${baseline}old [Pasted text #1]`
    expect(hasBracketedPasteAcknowledgement(oldOutput, oldOutput.length)).toBe(false)
  })

  test('defers Claude input until prompt and paste acknowledgement are ready, then submits Enter', () => {
    vi.useFakeTimers()
    let output = 'Welcome back\n'
    const manager = {
      getRun: vi.fn(() => ({ output })),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, 'claude')
    write('run-1', 'payload')

    expect(manager.writeInput).not.toHaveBeenCalled()
    output = 'Welcome back\n❯ '
    vi.advanceTimersByTime(50)

    expect(manager.writeInput).toHaveBeenCalledTimes(1)
    expect(manager.writeInput).toHaveBeenNthCalledWith(1, 'run-1', '\u001b[200~payload\u001b[201~')

    vi.advanceTimersByTime(600)
    expect(manager.writeInput).toHaveBeenCalledTimes(1)

    output += '[Pasted text #1 +1 lines]\n'
    vi.advanceTimersByTime(149)
    expect(manager.writeInput).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1)
    expect(manager.writeInput).toHaveBeenCalledTimes(2)
    expect(manager.writeInput).toHaveBeenNthCalledWith(2, 'run-1', '\r')
  })

  test('waits longer before submitting large pasted prompts after acknowledgement', () => {
    vi.useFakeTimers()
    let output = 'Welcome back\n❯ '
    const manager = {
      getRun: vi.fn(() => ({ output })),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, 'claude')
    write('run-1', 'payload\n'.repeat(600))

    expect(manager.writeInput).toHaveBeenCalledTimes(1)
    output += '[Pasted text #1 +600 lines]\n'
    vi.advanceTimersByTime(200)
    expect(manager.writeInput).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1300)
    expect(manager.writeInput).toHaveBeenCalledTimes(2)
    expect(manager.writeInput).toHaveBeenNthCalledWith(2, 'run-1', '\r')
  })

  test('submits Claude pasted input after timeout when no paste acknowledgement is emitted', () => {
    vi.useFakeTimers()
    const manager = {
      getRun: vi.fn(() => ({ output: 'Welcome back\n❯ ' })),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, 'claude')
    write('run-1', 'payload')

    vi.advanceTimersByTime(2999)
    expect(manager.writeInput).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1)
    expect(manager.writeInput).toHaveBeenCalledTimes(2)
    expect(manager.writeInput).toHaveBeenNthCalledWith(2, 'run-1', '\r')
  })

  test('waits for Codex pasted-content acknowledgement before submitting Enter', () => {
    vi.useFakeTimers()
    let output = 'Codex ready\n› '
    const manager = {
      getRun: vi.fn(() => ({ output, status: 'running' })),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, 'codex')
    write('run-1', 'team send video "draft the next outline"')

    expect(manager.writeInput).toHaveBeenCalledTimes(1)
    expect(manager.writeInput).toHaveBeenNthCalledWith(
      1,
      'run-1',
      '\u001b[200~team send video "draft the next outline"\u001b[201~'
    )

    vi.advanceTimersByTime(2500)
    expect(manager.writeInput).toHaveBeenCalledTimes(1)

    output += '[Pasted Content 1639 chars]\n'
    vi.advanceTimersByTime(149)
    expect(manager.writeInput).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1)
    expect(manager.writeInput).toHaveBeenCalledTimes(2)
    expect(manager.writeInput).toHaveBeenNthCalledWith(2, 'run-1', '\r')
  })

  test.each([
    'claude',
    'codex',
  ])('normalizes one %s Chat message with Ctrl+U without interrupting the agent', async (provider) => {
    vi.useFakeTimers()
    let output = 'Codex ready\n› '
    const manager = {
      getRun: vi.fn(() => ({ output, status: 'running' })),
      writeInput: vi.fn(),
    }
    const onSubmitted = vi.fn()
    const delivery = createPostStartInputWriterAsync(manager as never, provider, {
      beforePaste: '\x15',
      onSubmitted,
    })('run-1', 'first line\nsecond line')

    expect(manager.writeInput.mock.calls).toEqual([
      ['run-1', '\x15'],
      ['run-1', '\u001b[200~first line\nsecond line\u001b[201~'],
    ])
    expect(onSubmitted).not.toHaveBeenCalled()
    expect(JSON.stringify(manager.writeInput.mock.calls)).not.toContain('\\u0003')
    output += '[Pasted Content 22 chars]\n'
    await vi.advanceTimersByTimeAsync(700)

    await expect(delivery).resolves.toBe(true)
    expect(manager.writeInput).toHaveBeenNthCalledWith(3, 'run-1', '\r')
    expect(onSubmitted).toHaveBeenCalledTimes(1)
  })

  test('prepares the latest Chat body only when the first PTY write is ready', async () => {
    vi.useFakeTimers()
    let output = 'Codex booting\n'
    let body = 'original'
    const manager = {
      getRun: vi.fn(() => ({ output, status: 'running' })),
      writeInput: vi.fn(),
    }
    const prepareText = vi.fn(() => body)

    const delivery = createPostStartInputWriterAsync(manager as never, 'codex', {
      beforePaste: '\x15',
      prepareText,
    })('run-1', '')

    expect(prepareText).not.toHaveBeenCalled()
    body = 'edited while waiting'
    await vi.advanceTimersByTimeAsync(3000)
    expect(prepareText).not.toHaveBeenCalled()

    output += '\n\u276f '
    await vi.advanceTimersByTimeAsync(50)

    expect(prepareText).toHaveBeenCalledTimes(1)
    expect(manager.writeInput.mock.calls.slice(0, 2)).toEqual([
      ['run-1', '\x15'],
      ['run-1', '\u001b[200~edited while waiting\u001b[201~'],
    ])
    output += '[Pasted Content 20 chars]\n'
    await vi.advanceTimersByTimeAsync(700)
    await expect(delivery).resolves.toBe(true)
  })

  test('does not write Chat input when preparation is cancelled at delivery time', async () => {
    vi.useFakeTimers()
    let output = 'Codex booting\n'
    const manager = {
      getRun: vi.fn(() => ({ output, status: 'running' })),
      writeInput: vi.fn(),
    }
    const delivery = createPostStartInputWriterAsync(manager as never, 'codex', {
      beforePaste: '\x15',
      prepareText: () => null,
    })('run-1', '')

    output += '\n\u276f '
    await vi.advanceTimersByTimeAsync(50)

    await expect(delivery).resolves.toBe(false)
    expect(manager.writeInput).not.toHaveBeenCalled()
  })

  test('rejects when delayed Chat preparation detects a queue conflict', async () => {
    vi.useFakeTimers()
    let output = 'Codex booting\n'
    const manager = {
      getRun: vi.fn(() => ({ output, status: 'running' })),
      writeInput: vi.fn(),
    }
    const delivery = createPostStartInputWriterAsync(manager as never, 'codex', {
      beforePaste: '\x15',
      prepareText: () => {
        throw new Error('queue changed')
      },
    })('run-1', '')
    const rejected = expect(delivery).rejects.toThrow('queue changed')

    output += '\n\u276f '
    await vi.advanceTimersByTimeAsync(50)

    await rejected
    expect(manager.writeInput).not.toHaveBeenCalled()
  })

  test('does not touch the PTY when the durable prewrite commit fails', async () => {
    const manager = {
      getRun: vi.fn(() => ({ output: 'Codex ready\n\u276f ', status: 'running' })),
      writeInput: vi.fn(),
    }
    const beforeWrite = vi.fn(() => {
      throw new Error('sqlite delivery commit failed')
    })

    const delivery = createPostStartInputWriterAsync(manager as never, 'codex', {
      beforeWrite,
    })('run-1', 'coordination event')

    await expect(delivery).rejects.toThrow('sqlite delivery commit failed')
    expect(beforeWrite).toHaveBeenCalledOnce()
    expect(manager.writeInput).not.toHaveBeenCalled()
  })

  test('rolls back a durable prewrite commit when the PTY write fails', async () => {
    const manager = {
      getRun: vi.fn(() => ({ output: 'Codex ready\n\u276f ', status: 'running' })),
      writeInput: vi.fn(() => {
        throw new Error('pty closed')
      }),
    }
    const beforeWrite = vi.fn()
    const onWriteFailed = vi.fn()

    const delivery = createPostStartInputWriterAsync(manager as never, 'codex', {
      beforeWrite,
      onWriteFailed,
    })('run-1', 'coordination event')

    await expect(delivery).rejects.toThrow('pty closed')
    expect(beforeWrite).toHaveBeenCalledOnce()
    expect(onWriteFailed).toHaveBeenCalledOnce()
  })

  test('does not submit delayed Enter after the PTY exits', () => {
    vi.useFakeTimers()
    let output = 'Welcome back\n❯ '
    let status = 'running'
    const manager = {
      getRun: vi.fn(() => ({ output, status })),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, 'claude')
    write('run-1', 'payload')

    expect(manager.writeInput).toHaveBeenCalledTimes(1)
    status = 'exited'
    output += '[Pasted text #1 +1 lines]\n'
    vi.advanceTimersByTime(3000)

    expect(manager.writeInput).toHaveBeenCalledTimes(1)
  })

  test('does not write delayed interactive input after the PTY exits before prompt readiness', () => {
    vi.useFakeTimers()
    let output = 'Welcome back\n'
    let status = 'running'
    const manager = {
      getRun: vi.fn(() => ({ output, status })),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, 'claude')
    write('run-1', 'payload')

    status = 'exited'
    output = 'Welcome back\n❯ '
    vi.advanceTimersByTime(50)

    expect(manager.writeInput).not.toHaveBeenCalled()
  })

  test('writes non-interactive commands immediately', () => {
    const manager = {
      getRun: vi.fn(() => ({ output: '', status: 'running' })),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, process.execPath)
    write('run-1', 'payload')

    expect(manager.getRun).toHaveBeenCalledWith('run-1')
    expect(manager.writeInput).toHaveBeenCalledWith('run-1', 'payload\n')
  })

  test('skips non-interactive post-start input after the run exits', () => {
    const manager = {
      getRun: vi.fn(() => ({ output: '', status: 'exited' })),
      writeInput: vi.fn(),
    }

    const write = createPostStartInputWriter(manager as never, process.execPath)
    write('run-1', 'payload')

    expect(manager.writeInput).not.toHaveBeenCalled()
  })
})
