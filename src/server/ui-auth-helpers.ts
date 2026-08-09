import type { IncomingMessage } from 'node:http'

import { ForbiddenError } from './http-errors.js'
import type { RuntimeStore } from './runtime-store.js'

export interface MobileAccessContext {
  kind: 'mobile-token' | 'ui-cookie'
  relay?: {
    desktopId?: string
    mobileDeviceId?: string
  }
  workspaceScope: 'all' | 'selected'
  workspaceIds?: string[]
}

export const readCookie = (cookieHeader: string | undefined, name: string) => {
  if (!cookieHeader) {
    return undefined
  }

  for (const part of cookieHeader.split(';')) {
    const [key, value] = part.trim().split('=')
    if (key === name) {
      return value
    }
  }

  return undefined
}

const readSingleHeader = (request: IncomingMessage, name: string) => {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

const readSafeHeaderValue = (request: IncomingMessage, name: string) => {
  const value = readSingleHeader(request, name)?.trim()
  if (!value || value.length > 80) return undefined
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return undefined
  }
  return value
}

const readWorkspaceIdsHeader = (request: IncomingMessage) => {
  const value = readSingleHeader(request, 'x-yive-mobile-workspace-ids')
  if (!value) return undefined
  const workspaceIds = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 120)
  return workspaceIds.length > 0 ? Array.from(new Set(workspaceIds)) : undefined
}

export const readMobileRelayAccessContext = (
  request: IncomingMessage
): Pick<MobileAccessContext, 'relay' | 'workspaceIds' | 'workspaceScope'> => {
  const workspaceIds = readWorkspaceIdsHeader(request)
  const desktopId = readSafeHeaderValue(request, 'x-yive-relay-desktop-id')
  const mobileDeviceId = readSafeHeaderValue(request, 'x-yive-relay-mobile-device-id')

  return {
    ...(desktopId || mobileDeviceId
      ? {
          relay: {
            ...(desktopId ? { desktopId } : {}),
            ...(mobileDeviceId ? { mobileDeviceId } : {}),
          },
        }
      : {}),
    ...(workspaceIds ? { workspaceIds } : {}),
    workspaceScope: workspaceIds ? 'selected' : 'all',
  }
}

export const requireUiTokenFromRequest = (
  request: IncomingMessage,
  validateUiToken: RuntimeStore['validateUiToken']
) => {
  const cookieHeader = Array.isArray(request.headers.cookie)
    ? request.headers.cookie.join('; ')
    : request.headers.cookie
  const token = readCookie(cookieHeader, 'hive_ui_token')
  if (!validateUiToken(token)) {
    throw new ForbiddenError('UI endpoint requires valid UI token')
  }
}

export const requireMobileOrUiTokenFromRequest = (
  request: IncomingMessage,
  validators: Pick<RuntimeStore, 'validateMobileToken' | 'validateUiToken'>
): MobileAccessContext => {
  const cookieHeader = Array.isArray(request.headers.cookie)
    ? request.headers.cookie.join('; ')
    : request.headers.cookie
  const mobileToken = readCookie(cookieHeader, 'hive_mobile_token')
  if (validators.validateMobileToken(mobileToken)) {
    return { kind: 'mobile-token', ...readMobileRelayAccessContext(request) }
  }

  const uiToken = readCookie(cookieHeader, 'hive_ui_token')
  if (validators.validateUiToken(uiToken)) {
    return { kind: 'ui-cookie', ...readMobileRelayAccessContext(request) }
  }

  throw new ForbiddenError('Mobile endpoint requires valid mobile token')
}

export const assertMobileWorkspaceAccess = (
  access: MobileAccessContext,
  workspaceId: string
): void => {
  if (hasMobileWorkspaceAccess(access, workspaceId)) return
  throw new ForbiddenError('Mobile session is not allowed to access this workspace')
}

export const hasMobileWorkspaceAccess = (
  access: MobileAccessContext,
  workspaceId: string
): boolean => access.workspaceScope === 'all' || access.workspaceIds?.includes(workspaceId) === true
