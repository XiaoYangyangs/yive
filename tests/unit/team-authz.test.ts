import { describe, expect, test } from 'vitest'

import { commandAllowedForKind } from '../../src/server/team-authz.js'

describe('team command authorization', () => {
  test('only orchestrators can add workers through team commands', () => {
    expect(commandAllowedForKind('orchestrator', 'add')).toBe(true)
    expect(commandAllowedForKind('worker', 'add')).toBe(false)
  })
})
