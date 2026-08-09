import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  createDevelopmentPairingStore,
  MAX_RELAY_DEVICE_ID_LENGTH,
  normalizeRelayDeviceId,
} from '../../src/relay/pairing-store.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('relay pairing store', () => {
  test('normalizes relay device ids before storing or validating tokens', () => {
    expect(normalizeRelayDeviceId(' phone-1 ')).toBe('phone-1')
    expect(normalizeRelayDeviceId('')).toBeNull()
    expect(normalizeRelayDeviceId(`phone\n1`)).toBeNull()
    expect(normalizeRelayDeviceId('x'.repeat(MAX_RELAY_DEVICE_ID_LENGTH + 1))).toBeNull()
  })

  test('validates the development admin token for backward compatibility', () => {
    const store = createDevelopmentPairingStore({ token: 'admin-token' })

    expect(store.validateAdminToken('admin-token')).toBe(true)
    expect(store.validateToken('admin-token')).toBe(true)
    expect(store.validateTokenForDevice({ deviceId: 'any-device', token: 'admin-token' })).toBe(
      true
    )
    expect(
      store.validateConnectionTokenForDevice({ deviceId: 'any-device', token: 'admin-token' })
    ).toBe(true)
    expect(store.validateToken('wrong-token')).toBe(false)
    expect(store.diagnostics().admin_token_default).toBe(false)
    expect(createDevelopmentPairingStore().diagnostics().admin_token_default).toBe(true)
  })

  test('issued pairing tokens expire after their ttl', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const store = createDevelopmentPairingStore({ token: 'admin-token', tokenTtlMs: 500 })

    const pairing = store.createPairingToken()

    expect(pairing.expires_at).toBe(1_500)
    expect(pairing.ttl_ms).toBe(500)
    expect(store.validateToken(pairing.token)).toBe(true)
    expect(
      store.validateConnectionTokenForDevice({ deviceId: 'phone-1', token: pairing.token })
    ).toBe(false)

    vi.spyOn(Date, 'now').mockReturnValue(1_501)

    expect(store.validateToken(pairing.token)).toBe(false)
  })

  test('claims a pairing token into a reusable device token', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const store = createDevelopmentPairingStore({ token: 'admin-token', tokenTtlMs: 500 })
    const pairing = store.createPairingToken()

    const claimed = store.claimPairingToken({ deviceId: 'phone-1', token: pairing.token })

    expect(claimed?.device_id).toBe('phone-1')
    expect(claimed?.token).not.toBe(pairing.token)
    expect(claimed?.token).not.toBe('admin-token')
    expect(store.validateToken(pairing.token)).toBe(false)
    expect(store.validateToken(claimed?.token ?? null)).toBe(true)
    expect(
      store.validateTokenForDevice({ deviceId: 'phone-1', token: claimed?.token ?? null })
    ).toBe(true)
    expect(
      store.validateConnectionTokenForDevice({
        deviceId: 'phone-1',
        token: claimed?.token ?? null,
      })
    ).toBe(true)
    expect(
      store.validateTokenForDevice({ deviceId: 'phone-2', token: claimed?.token ?? null })
    ).toBe(false)
    expect(
      store.validateConnectionTokenForDevice({
        deviceId: 'phone-2',
        token: claimed?.token ?? null,
      })
    ).toBe(false)
    expect(store.claimPairingToken({ deviceId: 'phone-1', token: pairing.token })).toBeNull()
  })

  test('can require reusable device tokens to be bound to a desktop', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const store = createDevelopmentPairingStore({ token: 'admin-token', tokenTtlMs: 500 })
    const unboundPairing = store.createPairingToken()
    const unbound = store.claimPairingToken({ deviceId: 'phone-1', token: unboundPairing.token })
    const boundPairing = store.createPairingToken()
    const bound = store.claimPairingToken({
      desktopId: 'desktop-1',
      deviceId: 'phone-2',
      token: boundPairing.token,
    })

    expect(
      store.validateTokenForDevice({
        desktopId: 'desktop-1',
        deviceId: 'phone-1',
        requireDesktopBinding: true,
        token: unbound?.token ?? null,
      })
    ).toBe(false)
    expect(
      store.validateConnectionTokenForDevice({
        desktopId: 'desktop-1',
        deviceId: 'phone-1',
        requireDesktopBinding: true,
        token: unbound?.token ?? null,
      })
    ).toBe(false)
    expect(
      store.validateConnectionTokenForDevice({
        desktopId: 'desktop-1',
        deviceId: 'phone-2',
        requireDesktopBinding: true,
        token: bound?.token ?? null,
      })
    ).toBe(true)
    expect(
      store.validateConnectionTokenForDevice({
        desktopId: 'desktop-2',
        deviceId: 'phone-2',
        requireDesktopBinding: true,
        token: bound?.token ?? null,
      })
    ).toBe(false)
  })

  test('can bind claimed device tokens to a target desktop id', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const store = createDevelopmentPairingStore({ token: 'admin-token', tokenTtlMs: 500 })
    const pairing = store.createPairingToken()

    const claimed = store.claimPairingToken({
      desktopId: 'desktop-1',
      deviceId: 'phone-1',
      token: pairing.token,
    })

    expect(claimed).toEqual({
      desktop_id: 'desktop-1',
      device_id: 'phone-1',
      token: expect.any(String),
    })
    expect(
      store.validateTokenForDevice({
        desktopId: 'desktop-1',
        deviceId: 'phone-1',
        token: claimed?.token ?? null,
      })
    ).toBe(true)
    expect(
      store.validateConnectionTokenForDevice({
        desktopId: 'desktop-1',
        deviceId: 'phone-1',
        token: claimed?.token ?? null,
      })
    ).toBe(true)
    expect(
      store.validateTokenForDevice({
        desktopId: 'desktop-2',
        deviceId: 'phone-1',
        token: claimed?.token ?? null,
      })
    ).toBe(false)
    expect(
      store.validateConnectionTokenForDevice({
        desktopId: 'desktop-2',
        deviceId: 'phone-1',
        token: claimed?.token ?? null,
      })
    ).toBe(false)
    expect(
      store.validateTokenForDevice({ deviceId: 'phone-1', token: claimed?.token ?? null })
    ).toBe(false)
    expect(store.listDeviceTokens()).toEqual([
      {
        desktop_id: 'desktop-1',
        device_id: 'phone-1',
        token_hint: expect.any(String),
      },
    ])
    expect(store.getDeviceToken(claimed?.token ?? null)).toEqual({
      desktop_id: 'desktop-1',
      device_id: 'phone-1',
      token_hint: expect.any(String),
    })
    expect(store.getDeviceToken('admin-token')).toBeNull()
  })

  test('persists selected workspace scope on claimed device tokens', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const store = createDevelopmentPairingStore({ token: 'admin-token', tokenTtlMs: 500 })
    const pairing = store.createPairingToken()

    const claimed = store.claimPairingToken({
      desktopId: 'desktop-1',
      deviceKind: 'mobile',
      deviceId: 'phone-1',
      token: pairing.token,
      workspaceIds: ['workspace-alpha', 'workspace-beta', 'workspace-alpha'],
    })

    expect(claimed).toEqual({
      desktop_id: 'desktop-1',
      device_id: 'phone-1',
      device_kind: 'mobile',
      token: expect.any(String),
      workspace_ids: ['workspace-alpha', 'workspace-beta'],
    })
    expect(store.getDeviceToken(claimed?.token ?? null)).toEqual({
      desktop_id: 'desktop-1',
      device_id: 'phone-1',
      device_kind: 'mobile',
      token_hint: expect.any(String),
      workspace_ids: ['workspace-alpha', 'workspace-beta'],
    })
    expect(store.listDeviceTokens()).toEqual([
      {
        desktop_id: 'desktop-1',
        device_id: 'phone-1',
        device_kind: 'mobile',
        token_hint: expect.any(String),
        workspace_ids: ['workspace-alpha', 'workspace-beta'],
      },
    ])
  })

  test('rejects invalid workspace ids without consuming the pairing token', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const store = createDevelopmentPairingStore({ token: 'admin-token', tokenTtlMs: 500 })
    const pairing = store.createPairingToken()

    expect(
      store.claimPairingToken({
        deviceId: 'phone-1',
        token: pairing.token,
        workspaceIds: ['workspace\nalpha'],
      })
    ).toBeNull()
    expect(store.validateToken(pairing.token)).toBe(true)
  })

  test('rejects invalid device ids when claiming pairing tokens', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const store = createDevelopmentPairingStore({ token: 'admin-token', tokenTtlMs: 500 })
    const pairing = store.createPairingToken()

    expect(
      store.claimPairingToken({
        deviceId: 'x'.repeat(MAX_RELAY_DEVICE_ID_LENGTH + 1),
        token: pairing.token,
      })
    ).toBeNull()
    expect(store.claimPairingToken({ deviceId: 'phone\n1', token: pairing.token })).toBeNull()
    expect(store.validateToken(pairing.token)).toBe(true)
  })

  test('rejects invalid desktop ids when claiming pairing tokens', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const store = createDevelopmentPairingStore({ token: 'admin-token', tokenTtlMs: 500 })
    const pairing = store.createPairingToken()

    expect(
      store.claimPairingToken({
        desktopId: 'desktop\n1',
        deviceId: 'phone-1',
        token: pairing.token,
      })
    ).toBeNull()
    expect(store.validateToken(pairing.token)).toBe(true)
  })

  test('persists claimed device tokens across store instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yive-relay-pairing-store-'))
    try {
      vi.spyOn(Date, 'now').mockReturnValue(1_000)
      const storagePath = join(dir, 'pairings.json')
      const firstStore = createDevelopmentPairingStore({
        storagePath,
        token: 'admin-token',
        tokenTtlMs: 500,
      })
      const pairing = firstStore.createPairingToken()
      const claimed = firstStore.claimPairingToken({
        deviceKind: 'mobile',
        deviceId: 'phone-1',
        token: pairing.token,
        workspaceIds: ['workspace-alpha'],
      })

      const secondStore = createDevelopmentPairingStore({
        storagePath,
        token: 'admin-token',
        tokenTtlMs: 500,
      })

      expect(secondStore.validateToken(claimed?.token ?? null)).toBe(true)
      expect(secondStore.validateToken(pairing.token)).toBe(false)
      expect(secondStore.getDeviceToken(claimed?.token ?? null)).toMatchObject({
        device_id: 'phone-1',
        device_kind: 'mobile',
        workspace_ids: ['workspace-alpha'],
      })
      const stored = readFileSync(storagePath, 'utf8')
      expect(stored).not.toContain(claimed?.token ?? 'missing-token')
      expect(stored).toContain('"device_kind": "mobile"')
      expect(stored).toContain('"token_hash": "sha256:')
      expect(stored).toContain('"workspace_ids"')
      expect(stored).toContain('"version": 2')
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test('reads legacy plaintext device token stores and migrates them on write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yive-relay-legacy-pairing-store-'))
    try {
      vi.spyOn(Date, 'now').mockReturnValue(1_000)
      const storagePath = join(dir, 'pairings.json')
      writeFileSync(
        storagePath,
        `${JSON.stringify(
          {
            device_tokens: [['legacy-device-token', 'phone-1']],
            issued_tokens: [],
            version: 1,
          },
          null,
          2
        )}\n`
      )
      const store = createDevelopmentPairingStore({
        storagePath,
        token: 'admin-token',
        tokenTtlMs: 500,
      })

      expect(store.validateToken('legacy-device-token')).toBe(true)
      expect(
        store.validateTokenForDevice({ deviceId: 'phone-1', token: 'legacy-device-token' })
      ).toBe(true)

      const pairing = store.createPairingToken()

      expect(pairing.token).toBeTruthy()
      const stored = readFileSync(storagePath, 'utf8')
      expect(stored).not.toContain('legacy-device-token')
      expect(stored).toContain('"token_hash": "sha256:')
      expect(stored).toContain('"version": 2')
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test('lists token hints and revokes all tokens for a device id', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const store = createDevelopmentPairingStore({ token: 'admin-token', tokenTtlMs: 500 })
    const firstPairing = store.createPairingToken()
    const firstClaim = store.claimPairingToken({ deviceId: 'phone-1', token: firstPairing.token })
    const secondPairing = store.createPairingToken()
    const secondClaim = store.claimPairingToken({ deviceId: 'phone-1', token: secondPairing.token })
    const otherPairing = store.createPairingToken()
    const otherClaim = store.claimPairingToken({ deviceId: 'phone-2', token: otherPairing.token })

    const devices = store.listDeviceTokens()

    expect(devices).toHaveLength(3)
    expect(devices.filter((device) => device.device_id === 'phone-1')).toHaveLength(2)
    expect(devices.some((device) => device.token_hint === firstClaim?.token)).toBe(false)

    expect(store.revokeDeviceTokens({ deviceId: 'phone-1' })).toBe(true)

    expect(store.validateToken(firstClaim?.token ?? null)).toBe(false)
    expect(store.validateToken(secondClaim?.token ?? null)).toBe(false)
    expect(store.validateToken(otherClaim?.token ?? null)).toBe(true)
    expect(store.revokeDeviceTokens({ deviceId: 'phone-1' })).toBe(false)
  })
})
