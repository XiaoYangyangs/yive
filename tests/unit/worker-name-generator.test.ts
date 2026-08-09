import { describe, expect, test } from 'vitest'

import { generateWorkerName } from '../../web/src/worker/randomWorkerName.js'

describe('worker name generator', () => {
  test('draws from one flat English pool', () => {
    expect(generateWorkerName({ language: 'en', nextUint32: () => 0 })).toBe('ada-lovelace')
    expect(generateWorkerName({ language: 'en', nextUint32: () => 51 })).toBe('adam-smith')
  })

  test('keeps English names safe for team send invocations', () => {
    const name = generateWorkerName({ language: 'en', nextUint32: () => 8 })
    expect(name).toMatch(/^[a-z]+(?:-[a-z]+)*$/)
    expect(name).not.toContain(' ')
  })

  test('switches to one flat Chinese historical-figure pool', () => {
    const name = generateWorkerName({ language: 'zh', nextUint32: () => 0 })
    expect(name).toBe('八大山人')
    expect(name).not.toContain(' ')
  })

  test('skips names already used in the workspace', () => {
    const name = generateWorkerName({
      language: 'en',
      usedNames: new Set(['ada-lovelace']),
      nextUint32: () => 0,
    })
    expect(name).toBe('archimedes')
  })

  test('different workspaces stay independent through caller-scoped used names', () => {
    const name = generateWorkerName({
      language: 'en',
      usedNames: new Set(['tesla', 'turing']),
      nextUint32: () => 0,
    })
    expect(name).toBe('ada-lovelace')
  })
})
