import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'

import { ForbiddenError } from './http-errors.js'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])
const LOCAL_REMOTE_ADDRESSES = new Set(['127.0.0.1', '::1'])

const firstHeader = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value

const normalizeHostname = (hostname: string) => hostname.replace(/^\[|\]$/g, '').toLowerCase()

const isLocalHostname = (hostname: string) => LOCAL_HOSTNAMES.has(normalizeHostname(hostname))

const normalizeRemoteAddress = (address: string) =>
  normalizeHostname(address).replace(/^::ffff:/, '')

const isLocalRemoteAddress = (address: string) =>
  LOCAL_REMOTE_ADDRESSES.has(normalizeRemoteAddress(address))

const isDevLanEnabled = () => process.env.HIVE_DEV_LAN === '1'

const isPrivateIpv4 = (hostname: string) => {
  const parts = hostname.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false
  }
  const first = parts[0]
  const second = parts[1]
  if (first === undefined || second === undefined) return false
  if (first === 10) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  if (first === 169 && second === 254) return true
  return false
}

const isAllowedDevLanHostname = (hostname: string) => {
  const normalized = normalizeHostname(hostname)
  if (isLocalHostname(normalized)) return true
  return isIP(normalized) === 4 && isPrivateIpv4(normalized)
}

const isAllowedDevLanRemoteAddress = (address: string) => {
  const normalized = normalizeRemoteAddress(address)
  if (isLocalRemoteAddress(normalized)) return true
  return isIP(normalized) === 4 && isPrivateIpv4(normalized)
}

const isLocalAuthority = (authority: string) => {
  try {
    return isLocalHostname(new URL(`http://${authority}`).hostname)
  } catch {
    return false
  }
}

const isLocalOrigin = (origin: string) => {
  try {
    return isLocalHostname(new URL(origin).hostname)
  } catch {
    return false
  }
}

const isAllowedDevLanAuthority = (authority: string) => {
  try {
    return isAllowedDevLanHostname(new URL(`http://${authority}`).hostname)
  } catch {
    return false
  }
}

const isAllowedDevLanOrigin = (origin: string) => {
  try {
    return isAllowedDevLanHostname(new URL(origin).hostname)
  } catch {
    return false
  }
}

export const getLocalRequestRejection = (request: IncomingMessage): string | null => {
  const lanDev = isDevLanEnabled()
  const remoteAddress = request.socket.remoteAddress
  if (remoteAddress) {
    const allowedRemote = lanDev
      ? isAllowedDevLanRemoteAddress(remoteAddress)
      : isLocalRemoteAddress(remoteAddress)
    if (!allowedRemote) return 'non-local remote address'
  }

  const host = firstHeader(request.headers.host)
  if (host) {
    const allowedHost = lanDev ? isAllowedDevLanAuthority(host) : isLocalAuthority(host)
    if (!allowedHost) return 'non-local Host header'
  }

  const origin = firstHeader(request.headers.origin)
  if (origin) {
    const allowedOrigin = lanDev ? isAllowedDevLanOrigin(origin) : isLocalOrigin(origin)
    if (!allowedOrigin) return 'non-local Origin header'
  }

  return null
}

export const assertLocalRequest = (request: IncomingMessage) => {
  const reason = getLocalRequestRejection(request)
  if (reason) throw new ForbiddenError(`Local runtime rejected ${reason}`)
}
