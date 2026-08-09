import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  assertArtifactContentMatchesName,
  assertArtifactNameAndSize,
  getArtifactExtension,
  getArtifactMimeType,
  isArtifactImage,
  MAX_ARTIFACT_BYTES,
  readArtifactReferenceSnapshot,
} from './artifact-reference.js'
import { BadRequestError, InternalServerError } from './http-errors.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import type { RuntimeStore } from './runtime-store.js'
import {
  assertMobileWorkspaceAccess,
  hasMobileWorkspaceAccess,
  type MobileAccessContext,
  requireMobileOrUiTokenFromRequest,
} from './ui-auth-helpers.js'

const MAX_FILE_BYTES = MAX_ARTIFACT_BYTES
const FILE_EXCHANGE_TTL_MS = 24 * 60 * 60 * 1000

interface FileExchangeUploadBody {
  content_base64?: unknown
  name?: unknown
  workspace_id?: unknown
}

interface FileExchangeWorkspaceBody {
  path?: unknown
  workspace_id?: unknown
}

interface FileExchangeItem {
  content: Buffer
  createdAt: number
  expiresAt: number
  id: string
  localPath: string
  mimeType: string
  name: string
  size: number
  source: 'uploaded' | 'workspace'
  workspaceId?: string
  workspacePath?: string
}

const items = new Map<string, FileExchangeItem>()
const tempRoot = join(tmpdir(), 'hive-mobile-files')

export const getMobileFileExchangeItem = (fileId: string) => {
  pruneExpiredItems()
  const item = items.get(fileId)
  return item
    ? {
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
        id: item.id,
        localPath: item.localPath,
        mimeType: item.mimeType,
        name: item.name,
        size: item.size,
        source: item.source,
        ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
        ...(item.workspacePath ? { workspacePath: item.workspacePath } : {}),
      }
    : null
}

const sanitizeFileName = (name: string): string => {
  const baseName = basename(name.replace(/\\/gu, '/')).trim()
  const cleaned = Array.from(baseName, (char) => {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return '_'
    if ('"<>:|?*'.includes(char)) return '_'
    return char
  }).join('')
  return cleaned.replace(/\s+/gu, ' ').replace(/^\.+$/u, '_')
}

const encodeDownloadFileName = (name: string): string => {
  const asciiName = sanitizeFileName(name)
    .replace(/[^\x20-\x7e]/gu, '_')
    .replace(/["\\]/gu, '_')
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

const serializeItem = (item: FileExchangeItem) => ({
  created_at: item.createdAt,
  expires_at: item.expiresAt,
  id: item.id,
  mime_type: item.mimeType,
  name: item.name,
  size: item.size,
  source: item.source,
  ...(item.workspacePath ? { workspace_path: item.workspacePath } : {}),
})

const canAccessItem = (access: MobileAccessContext, item: FileExchangeItem) =>
  !item.workspaceId || hasMobileWorkspaceAccess(access, item.workspaceId)

const assertItemAccess = (access: MobileAccessContext, item: FileExchangeItem) => {
  if (item.workspaceId) assertMobileWorkspaceAccess(access, item.workspaceId)
}

export const serializeMobileFileExchangeItem = serializeItem

const persistTempFile = (id: string, extension: string, content: Buffer): string => {
  try {
    mkdirSync(tempRoot, { recursive: true })
    const localPath = join(tempRoot, `${id}${extension}`)
    writeFileSync(localPath, content)
    return localPath
  } catch (error) {
    throw new InternalServerError(
      'File exchange storage is unavailable',
      'file_exchange_storage_unavailable',
      error
    )
  }
}

const deleteItem = (fileId: string) => {
  const item = items.get(fileId)
  if (item) {
    try {
      rmSync(item.localPath, { force: true })
    } catch (error) {
      throw new InternalServerError(
        'File exchange cleanup failed',
        'file_exchange_cleanup_failed',
        error
      )
    }
  }
  items.delete(fileId)
}

const pruneExpiredItems = (now = Date.now()) => {
  for (const item of items.values()) {
    if (item.expiresAt <= now) deleteItem(item.id)
  }
}

const getBase64DecodedSize = (value: string): number => {
  const normalized = value.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new BadRequestError('content_base64 must be valid base64')
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.floor((normalized.length * 3) / 4) - padding
}

const assertBase64WithinSizeLimit = (name: string, value: unknown) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestError('content_base64 is required')
  }
  assertArtifactNameAndSize(name, getBase64DecodedSize(value))
}

const createExchangeItem = (
  name: string,
  content: Buffer,
  metadata: {
    source?: 'uploaded' | 'workspace'
    workspaceId?: string
    workspacePath?: string
  } = {}
): FileExchangeItem => {
  const extension = getArtifactExtension(name)
  assertArtifactContentMatchesName(name, content)

  const id = randomUUID()
  const createdAt = Date.now()
  const item: FileExchangeItem = {
    content,
    createdAt,
    expiresAt: createdAt + FILE_EXCHANGE_TTL_MS,
    id,
    localPath: persistTempFile(id, extension, content),
    mimeType: getArtifactMimeType(name),
    name,
    size: content.byteLength,
    source: metadata.source ?? 'uploaded',
    ...(metadata.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
    ...(metadata.workspacePath ? { workspacePath: metadata.workspacePath } : {}),
  }
  items.set(item.id, item)
  return item
}

const readWorkspaceFileBody = async (
  request: Parameters<RouteDefinition['handler']>[0]['request']
) => readJsonBody<FileExchangeWorkspaceBody>(request, { limitBytes: 16 * 1024 })

const readUploadBody = async (request: Parameters<RouteDefinition['handler']>[0]['request']) =>
  readJsonBody<FileExchangeUploadBody>(request, {
    // Base64 expands payloads by roughly 4/3, so allow room for the encoded 100MB file.
    limitBytes: Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4096,
  })

const decodeBase64 = (value: unknown): Buffer => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestError('content_base64 is required')
  }
  const normalized = value.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new BadRequestError('content_base64 must be valid base64')
  }
  return Buffer.from(normalized, 'base64')
}

export const createMobileFileExchangeItemFromWorkspacePath = ({
  imageOnly = false,
  store,
  workspaceId,
  workspacePath,
}: {
  imageOnly?: boolean
  store: RuntimeStore
  workspaceId: string
  workspacePath: string
}): FileExchangeItem => {
  pruneExpiredItems()
  const workspace = store.listWorkspaces().find((item) => item.id === workspaceId)
  if (!workspace) {
    throw new BadRequestError(`Workspace not found: ${workspaceId}`)
  }

  const artifact = readArtifactReferenceSnapshot({
    reference: workspacePath,
    workspacePath: workspace.path,
  })
  if (imageOnly && !isArtifactImage(artifact.name)) {
    throw new BadRequestError('image_path must point to an image file')
  }

  return createExchangeItem(artifact.name, artifact.content, {
    source: 'workspace',
    workspaceId,
    workspacePath: artifact.reference,
  })
}

export const fileExchangeRoutes: RouteDefinition[] = [
  route('GET', '/api/mobile/files', ({ request, response, store }) => {
    const access = requireMobileOrUiTokenFromRequest(request, store)
    pruneExpiredItems()
    sendJson(
      response,
      200,
      Array.from(items.values())
        .filter((item) => canAccessItem(access, item))
        .map(serializeItem)
    )
  }),
  route('POST', '/api/mobile/files', async ({ request, response, store }) => {
    const access = requireMobileOrUiTokenFromRequest(request, store)
    pruneExpiredItems()
    const body = await readUploadBody(request)
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      throw new BadRequestError('name is required')
    }

    const name = sanitizeFileName(body.name)
    if (!name) {
      throw new BadRequestError('name is required')
    }
    assertBase64WithinSizeLimit(name, body.content_base64)

    let workspaceId: string | undefined
    if (body.workspace_id !== undefined) {
      if (typeof body.workspace_id !== 'string' || body.workspace_id.trim().length === 0) {
        throw new BadRequestError('workspace_id must be a non-empty string')
      }
      workspaceId = body.workspace_id.trim()
      assertMobileWorkspaceAccess(access, workspaceId)
    } else if (access.workspaceScope === 'selected') {
      if (access.workspaceIds?.length !== 1) {
        throw new BadRequestError('workspace_id is required when multiple Workspaces are selected')
      }
      workspaceId = access.workspaceIds[0]
    }
    if (workspaceId && !store.listWorkspaces().some((workspace) => workspace.id === workspaceId)) {
      throw new BadRequestError(`Workspace not found: ${workspaceId}`)
    }

    const content = decodeBase64(body.content_base64)
    const item = createExchangeItem(name, content, workspaceId ? { workspaceId } : {})
    sendJson(response, 201, serializeItem(item))
  }),
  route('POST', '/api/mobile/files/from-workspace', async ({ request, response, store }) => {
    const access = requireMobileOrUiTokenFromRequest(request, store)
    pruneExpiredItems()
    const body = await readWorkspaceFileBody(request)
    if (typeof body.workspace_id !== 'string' || body.workspace_id.trim().length === 0) {
      throw new BadRequestError('workspace_id is required')
    }
    if (typeof body.path !== 'string' || body.path.trim().length === 0) {
      throw new BadRequestError('path is required')
    }

    const workspaceId = body.workspace_id.trim()
    assertMobileWorkspaceAccess(access, workspaceId)
    const item = createMobileFileExchangeItemFromWorkspacePath({
      store,
      workspaceId,
      workspacePath: body.path.trim(),
    })
    sendJson(response, 201, serializeItem(item))
  }),
  route('GET', '/api/mobile/files/:fileId', ({ params, request, response, store }) => {
    const access = requireMobileOrUiTokenFromRequest(request, store)
    pruneExpiredItems()
    const fileId = getRequiredParam(response, params, 'fileId', 'File id is required')
    if (!fileId) return
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const workspaceId = url.searchParams.get('workspace_id')?.trim()
    const submissionId = url.searchParams.get('submission_id')?.trim()
    if (workspaceId || submissionId) {
      if (!workspaceId || !submissionId) {
        throw new BadRequestError('workspace_id and submission_id are required together')
      }
      assertMobileWorkspaceAccess(access, workspaceId)
      const attachment = store.getChatAttachment(workspaceId, submissionId, fileId)
      response.statusCode = 200
      response.setHeader('content-type', attachment.mimeType)
      response.setHeader('content-length', String(attachment.size))
      response.setHeader('content-disposition', encodeDownloadFileName(attachment.name))
      try {
        response.end(attachment.content)
      } catch (error) {
        throw new InternalServerError(
          'Chat attachment is unavailable',
          'chat_attachment_unavailable',
          error
        )
      }
      return
    }
    const item = items.get(fileId)
    if (!item) {
      sendJson(response, 404, { error: 'File not found' })
      return
    }
    assertItemAccess(access, item)

    response.statusCode = 200
    response.setHeader('content-type', item.mimeType)
    response.setHeader('content-length', String(item.size))
    response.setHeader('content-disposition', encodeDownloadFileName(item.name))
    response.end(item.content)
  }),
  route('DELETE', '/api/mobile/files/:fileId', ({ params, request, response, store }) => {
    const access = requireMobileOrUiTokenFromRequest(request, store)
    const fileId = getRequiredParam(response, params, 'fileId', 'File id is required')
    if (!fileId) return
    const item = items.get(fileId)
    if (item) assertItemAccess(access, item)
    deleteItem(fileId)
    response.statusCode = 204
    response.end()
  }),
  route('DELETE', '/api/mobile/files', ({ request, response, store }) => {
    const access = requireMobileOrUiTokenFromRequest(request, store)
    for (const item of Array.from(items.values())) {
      if (!canAccessItem(access, item)) continue
      deleteItem(item.id)
    }
    response.statusCode = 204
    response.end()
  }),
]
