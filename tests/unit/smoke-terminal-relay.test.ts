import { describe, expect, test } from 'vitest'

import {
  assertTakeoverGrantedForSmoke,
  assertTakeoverReleasedForSmoke,
  normalizeTerminalInputForSmoke,
  TERMINAL_OUTPUT_SMOKE_COMMAND,
  TERMINAL_OUTPUT_SMOKE_SENTINEL,
  transcriptContainsOutput,
} from '../../deploy/smoke-terminal-relay.mjs'

describe('smoke-terminal-relay terminal input', () => {
  test('appends Enter by default so command smoke tests execute the input', () => {
    expect(normalizeTerminalInputForSmoke('pwd', { appendEnter: true })).toBe('pwd\r')
  })

  test('does not append duplicate Enter when input already includes a line ending', () => {
    expect(normalizeTerminalInputForSmoke('pwd\r', { appendEnter: true })).toBe('pwd\r')
    expect(normalizeTerminalInputForSmoke('pwd\n', { appendEnter: true })).toBe('pwd\n')
  })

  test('can preserve raw input for low-level forwarding checks', () => {
    expect(normalizeTerminalInputForSmoke('pwd', { appendEnter: false })).toBe('pwd')
  })

  test('uses a cross-platform sentinel command for output verification', () => {
    expect(TERMINAL_OUTPUT_SMOKE_SENTINEL).toBe('YIVE_RELAY_OK')
    expect(TERMINAL_OUTPUT_SMOKE_COMMAND).toContain(TERMINAL_OUTPUT_SMOKE_SENTINEL)
    expect(TERMINAL_OUTPUT_SMOKE_COMMAND).toContain('node -e')
  })

  test('matches expected output from terminal transcript events only', () => {
    expect(
      transcriptContainsOutput(
        {
          events: [
            { text: 'YIVE_RELAY_OK', type: 'mobile_action_echo' },
            { text: 'command result: YIVE_RELAY_OK', type: 'terminal_output' },
          ],
        },
        'YIVE_RELAY_OK'
      )
    ).toBe(true)
    expect(
      transcriptContainsOutput(
        {
          events: [{ text: 'YIVE_RELAY_OK', type: 'mobile_action_echo' }],
        },
        'YIVE_RELAY_OK'
      )
    ).toBe(false)
  })

  test('validates takeover grant size and previous desktop size', () => {
    expect(() =>
      assertTakeoverGrantedForSmoke(
        {
          cols: 48,
          previousSize: { cols: 120, rows: 40 },
          rows: 16,
          type: 'takeover_granted',
        },
        { cols: 48, rows: 16 }
      )
    ).not.toThrow()

    expect(() =>
      assertTakeoverGrantedForSmoke(
        {
          cols: 40,
          rows: 16,
          type: 'takeover_granted',
        },
        { cols: 48, rows: 16 }
      )
    ).toThrow('Terminal takeover size mismatch')

    expect(() =>
      assertTakeoverGrantedForSmoke(
        {
          cols: 48,
          previousSize: { cols: 0, rows: 40 },
          rows: 16,
          type: 'takeover_granted',
        },
        { cols: 48, rows: 16 }
      )
    ).toThrow('Terminal takeover previousSize was invalid')
  })

  test('validates takeover release returns to a non-takeover owner state', () => {
    expect(() =>
      assertTakeoverReleasedForSmoke({
        cols: 120,
        mode: 'active',
        ownerClientId: null,
        rows: 40,
        type: 'size_owner_changed',
      })
    ).not.toThrow()

    expect(() =>
      assertTakeoverReleasedForSmoke({
        cols: 48,
        mode: 'takeover',
        ownerClientId: 'mobile',
        rows: 16,
        type: 'size_owner_changed',
      })
    ).toThrow('Terminal takeover release left the terminal in takeover mode')
  })
})
