import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeVerifiedConversationText } from '../shared/conversation-content.js'
import { type PickFolderResponse, pickFolder } from './fs-pick-folder.js'
import { HttpError } from './http-errors.js'
import { assertLocalRequest } from './local-request-guard.js'
import { openWorkspace } from './open-target-commands.js'
import type { OpenWorkspaceService } from './route-types.js'
import { matchRoute } from './routes.js'
import type { RuntimeStore } from './runtime-store.js'
import { createTerminalWebSocketServer } from './terminal-ws-server.js'
import { createVersionService, type VersionService } from './version-service.js'

interface CreateAppOptions {
  store: RuntimeStore
  pickFolderService?: () => Promise<PickFolderResponse>
  openWorkspaceService?: OpenWorkspaceService
  versionService?: VersionService
}

const getDefaultStaticDir = () => {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  if (moduleDir.includes(`${sep}dist${sep}src${sep}`)) {
    return resolve(moduleDir, '../../../web/dist')
  }
  return resolve(moduleDir, '../../web/dist')
}

const isReservedPath = (pathname: string) => /^\/(api|ws)(\/|$)/.test(pathname)

const describeServerErrorForLog = (error: unknown, seen = new Set<object>(), depth = 0): string => {
  if (depth >= 4) return '[cause chain truncated]'
  if (typeof error === 'object' && error !== null) {
    if (seen.has(error)) return '[circular error cause]'
    seen.add(error)
  }
  const source =
    error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)
  const safeSource = normalizeVerifiedConversationText(source) || '[error details redacted]'
  const cause =
    typeof error === 'object' && error !== null && 'cause' in error
      ? (error as { cause?: unknown }).cause
      : undefined
  return cause === undefined
    ? safeSource
    : `${safeSource}\nCaused by: ${describeServerErrorForLog(cause, seen, depth + 1)}`
}

const logServerError = (error: unknown) => {
  console.error('[yive] HTTP request failed', describeServerErrorForLog(error))
}

const canServeStatic = async (staticDir: string) => {
  try {
    await access(join(staticDir, 'index.html'), constants.F_OK)
    return true
  } catch {
    return false
  }
}

const getStaticAssetPath = (staticDir: string, pathname: string) => {
  const staticRoot = resolve(staticDir)
  if (pathname === '/' || extname(pathname) === '') return join(staticRoot, 'index.html')
  const candidate = resolve(staticRoot, `.${pathname}`)
  if (candidate === staticRoot || candidate.startsWith(`${staticRoot}${sep}`)) return candidate
  return undefined
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

// PWA boot files must bypass HTTP caching: `sw.js` because the browser does its
// own byte-diff update check, and the manifest because Chrome consults it on
// every install/uninstall transition. Without these, SW updates can stall on a
// stale cached copy and the install prompt won't reflect a renamed app.
const PWA_BOOT_CACHE_CONTROL: Record<string, string> = {
  '/': 'no-store',
  '/index.html': 'no-store',
  '/mobile': 'no-store',
  '/manifest.webmanifest': 'max-age=0, must-revalidate',
  '/sw.js': 'no-store',
}

const sendStatic = async (
  response: ServerResponse,
  staticDir: string,
  pathname: string,
  request: IncomingMessage
) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const filePath = getStaticAssetPath(staticDir, pathname)
  if (!filePath) return false
  try {
    const content = await readFile(filePath)
    response.setHeader(
      'content-type',
      CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream'
    )
    const cacheControl =
      PWA_BOOT_CACHE_CONTROL[pathname] ?? (extname(filePath) === '.html' ? 'no-store' : undefined)
    if (cacheControl !== undefined) response.setHeader('cache-control', cacheControl)
    response.statusCode = 200
    response.end(request.method === 'HEAD' ? undefined : content)
    return true
  } catch {
    return false
  }
}

const sendJson = (response: ServerResponse, statusCode: number, body: unknown) => {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

export const createApp = ({
  store,
  pickFolderService = pickFolder,
  openWorkspaceService = (input) => openWorkspace(input),
  versionService = createVersionService(),
}: CreateAppOptions) => {
  const staticDir = process.env.HIVE_STATIC_DIR ?? getDefaultStaticDir()
  const staticAvailablePromise = canServeStatic(staticDir)
  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')

    try {
      assertLocalRequest(request)

      const match = matchRoute(method, url.pathname)
      if (match) {
        await match.handler({
          request,
          response,
          store,
          pickFolderService,
          openWorkspaceService,
          versionService,
          params: match.params,
        })
        return
      }

      if (isReservedPath(url.pathname)) {
        sendJson(response, 404, { error: 'Not found' })
        return
      }

      if (await staticAvailablePromise) {
        const served = await sendStatic(response, staticDir, url.pathname, request)
        if (served) return
      }

      sendJson(response, 404, { error: 'Not found' })
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.statusCode >= 500) logServerError(error)
        sendJson(response, error.statusCode, {
          ...(error.code ? { code: error.code } : {}),
          error: error.message,
        })
        return
      }
      logServerError(error)
      sendJson(response, 500, { error: 'Internal server error' })
    }
  })
  const terminalWebSocketServer = createTerminalWebSocketServer(server, store)

  return { close: terminalWebSocketServer.close, server, store }
}

export type { CreateAppOptions }
