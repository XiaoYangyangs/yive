import { describe, expect, test, vi } from 'vitest'

import {
  clearRelayPairing,
  clearStoredRelayDesktopSelection,
  type MobileRelayPairingStorage,
  RELAY_PAIRING_STORAGE_KEY,
  readStoredRelayPairing,
  saveRelayPairing,
} from '../../web/src/mobile/mobile-relay-pairing-storage.js'

const createMemoryStorage = (): MobileRelayPairingStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
    values,
  }
}

describe('mobile relay pairing storage', () => {
  test('reads and normalizes saved relay pairing state', () => {
    const storage = createMemoryStorage()
    storage.setItem(
      RELAY_PAIRING_STORAGE_KEY,
      JSON.stringify({
        desktopId: ' desktop-1 ',
        deviceId: ' phone-1 ',
        serverUrl: 'relay.example.com',
        token: ' pair-token ',
      })
    )

    expect(readStoredRelayPairing(storage)).toEqual({
      desktopId: 'desktop-1',
      deviceId: 'phone-1',
      serverUrl: 'https://relay.example.com',
      token: 'pair-token',
    })
  })

  test('ignores invalid or unavailable storage', () => {
    const storage = createMemoryStorage()
    storage.setItem(RELAY_PAIRING_STORAGE_KEY, JSON.stringify({ token: '   ' }))

    expect(readStoredRelayPairing(storage)).toBeNull()
    expect(readStoredRelayPairing(null)).toBeNull()
    expect(readStoredRelayPairing({ ...storage, getItem: () => '{not json' })).toBeNull()
  })

  test('saves, clears, and reports storage failures', () => {
    const storage = createMemoryStorage()

    expect(saveRelayPairing(storage, { desktopId: 'desktop-1', token: 'pair-token' })).toBe(true)
    expect(JSON.parse(storage.values.get(RELAY_PAIRING_STORAGE_KEY) ?? '{}')).toEqual({
      desktopId: 'desktop-1',
      token: 'pair-token',
    })

    clearRelayPairing(storage)
    expect(storage.values.has(RELAY_PAIRING_STORAGE_KEY)).toBe(false)

    expect(saveRelayPairing(null, { token: 'pair-token' })).toBe(false)
    expect(
      saveRelayPairing(
        {
          getItem: vi.fn(),
          removeItem: vi.fn(),
          setItem: () => {
            throw new Error('blocked')
          },
        },
        { token: 'pair-token' }
      )
    ).toBe(false)
  })

  test('clears only the selected desktop while preserving the reusable device token', () => {
    const storage = createMemoryStorage()
    saveRelayPairing(storage, {
      desktopId: 'desktop-1',
      deviceId: 'phone-1',
      serverUrl: 'https://relay.test',
      token: 'pair-token',
    })

    expect(clearStoredRelayDesktopSelection(storage)).toEqual({
      deviceId: 'phone-1',
      serverUrl: 'https://relay.test',
      token: 'pair-token',
    })
    expect(readStoredRelayPairing(storage)).toEqual({
      deviceId: 'phone-1',
      serverUrl: 'https://relay.test',
      token: 'pair-token',
    })
  })
})
