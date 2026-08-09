import { normalizeRelayServerUrlForInstall } from './mobile-install.js'

export const RELAY_PAIRING_STORAGE_KEY = 'yive.mobile.relay.pairing'

export interface MobileRelayPairingStorage {
  getItem: (key: string) => null | string
  removeItem: (key: string) => void
  setItem: (key: string, value: string) => void
}

export interface StoredRelayPairing {
  desktopId?: string
  deviceId?: string
  serverUrl?: string
  token: string
}

const normalizeRelayServerUrl = normalizeRelayServerUrlForInstall

export const readStoredRelayPairing = (
  storage: MobileRelayPairingStorage | null | undefined
): StoredRelayPairing | null => {
  if (!storage) return null
  try {
    const raw = storage.getItem(RELAY_PAIRING_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredRelayPairing>
    if (typeof parsed.token !== 'string' || parsed.token.trim().length === 0) return null
    const serverUrl = normalizeRelayServerUrl(parsed.serverUrl)
    return {
      ...(typeof parsed.desktopId === 'string' && parsed.desktopId.trim()
        ? { desktopId: parsed.desktopId.trim() }
        : {}),
      ...(typeof parsed.deviceId === 'string' && parsed.deviceId.trim()
        ? { deviceId: parsed.deviceId.trim() }
        : {}),
      ...(serverUrl ? { serverUrl } : {}),
      token: parsed.token.trim(),
    }
  } catch {
    return null
  }
}

export const saveRelayPairing = (
  storage: MobileRelayPairingStorage | null | undefined,
  pairing: StoredRelayPairing
): boolean => {
  if (!storage) return false
  try {
    storage.setItem(RELAY_PAIRING_STORAGE_KEY, JSON.stringify(pairing))
    return true
  } catch {
    return false
  }
}

export const clearRelayPairing = (storage: MobileRelayPairingStorage | null | undefined): void => {
  if (!storage) return
  try {
    storage.removeItem(RELAY_PAIRING_STORAGE_KEY)
  } catch {
    // Storage may be unavailable in private browsing, locked-down WebViews, or native adapters.
  }
}

export const clearStoredRelayDesktopSelection = (
  storage: MobileRelayPairingStorage | null | undefined
): StoredRelayPairing | null => {
  const storedPairing = readStoredRelayPairing(storage)
  if (!storedPairing) return null
  const nextPairing: StoredRelayPairing = {
    ...(storedPairing.deviceId ? { deviceId: storedPairing.deviceId } : {}),
    ...(storedPairing.serverUrl ? { serverUrl: storedPairing.serverUrl } : {}),
    token: storedPairing.token,
  }
  saveRelayPairing(storage, nextPairing)
  return nextPairing
}
