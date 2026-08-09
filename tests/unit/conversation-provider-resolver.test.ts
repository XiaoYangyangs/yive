import { describe, expect, test } from 'vitest'

import { resolveConversationProvider } from '../../src/server/conversation-provider-resolver.js'

describe('resolveConversationProvider', () => {
  test('resolves an explicit managed Provider', () => {
    expect(
      resolveConversationProvider({
        provider: 'codex',
        sessionIdCapture: { pattern: 'claude.jsonl', source: 'claude_project_jsonl_dir' },
      })
    ).toBe('codex')
  })

  test('does not infer Codex from a generic launch config', () => {
    expect(
      resolveConversationProvider({
        provider: null,
        sessionIdCapture: {
          pattern: '~/.codex/sessions/**/*.jsonl',
          source: 'codex_session_jsonl_dir',
        },
      })
    ).toBeNull()
  })

  test('does not infer Claude from a generic launch config', () => {
    expect(
      resolveConversationProvider({
        provider: null,
        sessionIdCapture: {
          pattern: '~/.claude/projects/**/*.jsonl',
          source: 'claude_project_jsonl_dir',
        },
      })
    ).toBeNull()
  })

  test('does not infer a provider from an arbitrary command or unsupported capture', () => {
    expect(resolveConversationProvider({ provider: null, sessionIdCapture: null })).toBeNull()
    expect(
      resolveConversationProvider({
        provider: null,
        sessionIdCapture: { pattern: 'stdout', source: 'stdout_regex' },
      })
    ).toBeNull()
  })
})
