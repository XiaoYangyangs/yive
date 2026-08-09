import {
  constants,
  copyFileSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, posix, relative } from 'node:path'

import type { MobileChatAttachment } from '../shared/types.js'
import {
  ensureArtifactDirectory,
  findExistingArtifactDirectory,
  normalizeArtifactReference,
  readArtifactReferenceSnapshot,
  resolveArtifactReference,
} from './artifact-reference.js'
import { normalizeVerifiedConversationText } from './conversation-content.js'
import { BadRequestError, HttpError, InternalServerError } from './http-errors.js'
import {
  appendMobileAttachments,
  type MobileAttachmentRecord,
  readMobileAttachments,
  removeMobileAttachments,
} from './mobile-attachments.js'
import { getMobileFileExchangeItem } from './routes-file-exchange.js'

const CHAT_IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

const SAFE_ATTACHMENT_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u

const requireSafeAttachmentPathSegment = (value: string, field: string) => {
  if (!SAFE_ATTACHMENT_PATH_SEGMENT.test(value)) {
    throw new BadRequestError(`Invalid ${field}`)
  }
  return value
}

const getPinnedFileName = (fileId: string, mimeType: string) => {
  const extension = CHAT_IMAGE_EXTENSIONS[mimeType]
  if (!extension) throw new BadRequestError(`Unsupported Chat image type: ${mimeType}`)
  return `${fileId}${extension}`
}

export const getChatAttachmentReference = (
  submissionId: string,
  fileId: string,
  mimeType: string
) => {
  const safeSubmissionId = requireSafeAttachmentPathSegment(submissionId, 'attachment binding id')
  const safeFileId = requireSafeAttachmentPathSegment(fileId, 'attachment file id')
  return normalizeArtifactReference(
    `.hive/chat-attachments/${safeSubmissionId}/${getPinnedFileName(safeFileId, mimeType)}`
  )
}

const getChatAttachmentDirectoryReference = (bindingId: string) => {
  const probeReference = getChatAttachmentReference(bindingId, 'attachment', 'image/png')
  return posix.dirname(probeReference)
}

const getChatAttachmentStagingDirectoryReference = (bindingId: string) => {
  const safeBindingId = requireSafeAttachmentPathSegment(bindingId, 'attachment binding id')
  return `.hive/chat-attachment-staging/${safeBindingId}`
}

const getChatAttachmentDirectory = (workspacePath: string, bindingId: string) => {
  const directoryReference = getChatAttachmentDirectoryReference(bindingId)
  return join(workspacePath, ...directoryReference.split('/'))
}

const cleanupStagedMobileChatAttachments = (workspacePath: string, bindingId: string) => {
  const stagingDirectory = findExistingArtifactDirectory({
    directoryReference: getChatAttachmentStagingDirectoryReference(bindingId),
    workspacePath,
  })
  if (stagingDirectory) rmSync(stagingDirectory, { force: true, recursive: true })
}

const commitStagedMobileChatAttachments = (workspacePath: string, bindingId: string) => {
  const stagingDirectory = findExistingArtifactDirectory({
    directoryReference: getChatAttachmentStagingDirectoryReference(bindingId),
    workspacePath,
  })
  if (!stagingDirectory) return
  const targetReference = getChatAttachmentDirectoryReference(bindingId)
  const targetDirectory = getChatAttachmentDirectory(workspacePath, bindingId)
  const existingTarget = findExistingArtifactDirectory({
    directoryReference: targetReference,
    workspacePath,
  })
  if (existingTarget) {
    cleanupStagedMobileChatAttachments(workspacePath, bindingId)
    return
  }
  ensureArtifactDirectory({ directoryReference: posix.dirname(targetReference), workspacePath })
  renameSync(stagingDirectory, targetDirectory)
}

export const cleanupOrphanedMobileChatAttachmentStaging = (
  workspacePath: string,
  validBindingIds: ReadonlySet<string>
) => {
  const stagingRoot = findExistingArtifactDirectory({
    directoryReference: '.hive/chat-attachment-staging',
    workspacePath,
  })
  if (!stagingRoot) return
  for (const entry of readdirSync(stagingRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_ATTACHMENT_PATH_SEGMENT.test(entry.name)) continue
    if (validBindingIds.has(entry.name)) continue
    rmSync(join(stagingRoot, entry.name), { force: true, recursive: true })
  }
}

export const cleanupBoundMobileChatAttachments = (workspacePath: string, submissionId: string) => {
  const directoryReference = getChatAttachmentDirectoryReference(submissionId)
  const attachmentDirectory = findExistingArtifactDirectory({
    directoryReference,
    workspacePath,
  })
  let cleanupError: unknown
  try {
    removeMobileAttachments(workspacePath, (attachment) => {
      if (attachment.artifact?.startsWith(`${directoryReference}/`)) return true
      if (!attachmentDirectory) return false
      const pathFromDirectory = relative(attachmentDirectory, attachment.local_path)
      return pathFromDirectory !== '' && !pathFromDirectory.startsWith('..')
    })
  } catch (error) {
    cleanupError = error
  }
  if (attachmentDirectory) {
    try {
      rmSync(attachmentDirectory, { force: true, recursive: true })
    } catch (error) {
      cleanupError ??= error
    }
  }
  if (cleanupError) {
    throw new InternalServerError(
      'Chat attachment cleanup failed',
      'chat_attachment_cleanup_failed',
      cleanupError
    )
  }
}

export const cleanupBoundMobileChatAttachmentDirectories = (
  workspacePath: string,
  submissionIds: string[]
) => {
  const errors: unknown[] = []
  for (const submissionId of submissionIds) {
    try {
      cleanupBoundMobileChatAttachments(workspacePath, submissionId)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new InternalServerError(
      'Chat attachment cleanup failed',
      'chat_attachment_cleanup_failed',
      new AggregateError(errors, 'Failed to clean one or more Chat attachment bindings')
    )
  }
}

const rethrowAfterAttachmentCleanup = ({
  cleanup,
  code,
  error,
  message,
}: {
  cleanup: () => void
  code: string
  error: unknown
  message: string
}): never => {
  try {
    cleanup()
  } catch (cleanupError) {
    throw new InternalServerError(
      message,
      code,
      new AggregateError([error, cleanupError], `${message} and cleanup both failed`)
    )
  }
  if (error instanceof HttpError) throw error
  throw new InternalServerError(message, code, error)
}

export const resolveBoundMobileChatAttachment = (
  workspacePath: string,
  submissionId: string,
  attachment: MobileChatAttachment
) => {
  const expectedReference = getChatAttachmentReference(
    submissionId,
    attachment.file_id,
    attachment.mime_type
  )
  if (attachment.artifact !== expectedReference) {
    throw new BadRequestError(`Invalid Chat attachment reference: ${attachment.file_id}`)
  }
  const resolved = readArtifactReferenceSnapshot({
    reference: attachment.artifact,
    workspacePath,
  })
  if (resolved.mimeType !== attachment.mime_type || resolved.size !== attachment.size) {
    throw new BadRequestError(`Chat attachment changed after binding: ${attachment.file_id}`)
  }
  return {
    artifact: resolved.reference,
    content: resolved.content,
    localPath: resolved.absolutePath,
    mimeType: attachment.mime_type,
    name: attachment.name,
    size: attachment.size,
  }
}

export const prepareMobileChatAttachments = (
  workspacePath: string,
  workspaceId: string,
  submissionId: string,
  fileIds: string[]
): {
  attachments: MobileChatAttachment[]
  bind: () => void
  cleanup: () => void
  register: () => void
} => {
  if (fileIds.length === 0) {
    return {
      attachments: [],
      bind: () => undefined,
      cleanup: () => undefined,
      register: () => undefined,
    }
  }
  const attachmentDirectory = getChatAttachmentDirectory(workspacePath, submissionId)
  const records = fileIds.map((fileId, index): MobileAttachmentRecord => {
    const item = getMobileFileExchangeItem(fileId)
    if (!item) throw new BadRequestError(`Mobile attachment not found: ${fileId}`)
    if (item.workspaceId && item.workspaceId !== workspaceId) {
      throw new BadRequestError(`Mobile attachment belongs to another Workspace: ${fileId}`)
    }
    if (!CHAT_IMAGE_EXTENSIONS[item.mimeType]) {
      throw new BadRequestError(`Mobile attachment is not an image: ${fileId}`)
    }
    const pinnedPath = join(attachmentDirectory, getPinnedFileName(item.id, item.mimeType))
    return {
      artifact: getChatAttachmentReference(submissionId, item.id, item.mimeType),
      created_at: item.createdAt,
      file_id: item.id,
      local_path: pinnedPath,
      mime_type: item.mimeType,
      name: item.name,
      placeholder: `[Image ${submissionId.slice(0, 8)} #${index + 1}]`,
      size: item.size,
    }
  })
  const attachments = records.map(({ file_id, mime_type, name, placeholder, size }) => ({
    artifact: getChatAttachmentReference(submissionId, file_id, mime_type),
    file_id,
    mime_type,
    name: normalizeVerifiedConversationText(name),
    placeholder,
    size,
  }))
  return {
    attachments,
    bind: () => {
      cleanupBoundMobileChatAttachments(workspacePath, submissionId)
      cleanupStagedMobileChatAttachments(workspacePath, submissionId)
      const safeStagingDirectory = ensureArtifactDirectory({
        directoryReference: getChatAttachmentStagingDirectoryReference(submissionId),
        workspacePath,
      })
      try {
        for (const [index, record] of records.entries()) {
          const source = getMobileFileExchangeItem(fileIds[index] ?? '')
          if (!source || !existsSync(source.localPath)) {
            throw new BadRequestError(`Mobile attachment not found: ${record.file_id}`)
          }
          const stagedPath = join(
            safeStagingDirectory,
            getPinnedFileName(record.file_id, record.mime_type)
          )
          copyFileSync(source.localPath, stagedPath, constants.COPYFILE_EXCL)
        }
      } catch (error) {
        rethrowAfterAttachmentCleanup({
          cleanup: () => cleanupStagedMobileChatAttachments(workspacePath, submissionId),
          code: 'chat_attachment_binding_failed',
          error,
          message: 'Chat attachment binding failed',
        })
      }
    },
    cleanup: () => {
      cleanupStagedMobileChatAttachments(workspacePath, submissionId)
      cleanupBoundMobileChatAttachments(workspacePath, submissionId)
    },
    register: () => {
      commitStagedMobileChatAttachments(workspacePath, submissionId)
      validateBoundMobileChatAttachments(workspacePath, submissionId, attachments)
    },
  }
}

export const bindMobileArtifactFiles = (
  workspacePath: string,
  workspaceId: string,
  bindingId: string,
  inputs: Array<{ fileId: string; placeholder: string }>
) => {
  if (inputs.length === 0) return []
  const directoryReference = getChatAttachmentDirectoryReference(bindingId)
  const attachmentDirectory = ensureArtifactDirectory({ directoryReference, workspacePath })
  try {
    const records = inputs.map(({ fileId, placeholder }): MobileAttachmentRecord => {
      const item = getMobileFileExchangeItem(fileId)
      if (!item) throw new BadRequestError(`Mobile attachment not found: ${fileId}`)
      if (item.workspaceId && item.workspaceId !== workspaceId) {
        throw new BadRequestError(`Mobile attachment belongs to another Workspace: ${fileId}`)
      }
      if (!CHAT_IMAGE_EXTENSIONS[item.mimeType]) {
        throw new BadRequestError(`Mobile attachment is not an image: ${fileId}`)
      }
      const artifact = getChatAttachmentReference(bindingId, item.id, item.mimeType)
      const localPath = join(attachmentDirectory, getPinnedFileName(item.id, item.mimeType))
      copyFileSync(item.localPath, localPath, constants.COPYFILE_EXCL)
      const resolved = resolveArtifactReference({ reference: artifact, workspacePath })
      return {
        artifact: resolved.reference,
        created_at: item.createdAt,
        file_id: item.id,
        local_path: resolved.absolutePath,
        mime_type: item.mimeType,
        name: normalizeVerifiedConversationText(item.name),
        placeholder,
        size: item.size,
      }
    })
    appendMobileAttachments(workspacePath, records)
    return records
  } catch (error) {
    return rethrowAfterAttachmentCleanup({
      cleanup: () => cleanupBoundMobileChatAttachments(workspacePath, bindingId),
      code: 'mobile_attachment_binding_failed',
      error,
      message: 'Mobile attachment binding failed',
    })
  }
}

export const validateBoundMobileChatAttachments = (
  workspacePath: string,
  submissionId: string,
  attachments: MobileChatAttachment[]
) => {
  const records = attachments.map((attachment): MobileAttachmentRecord => {
    const { localPath } = resolveBoundMobileChatAttachment(workspacePath, submissionId, attachment)
    return {
      artifact: attachment.artifact,
      created_at: Date.now(),
      file_id: attachment.file_id,
      local_path: localPath,
      mime_type: attachment.mime_type,
      name: attachment.name,
      placeholder: attachment.placeholder,
      size: attachment.size,
    }
  })
  appendMobileAttachments(workspacePath, records)
}

export const reconcileBoundMobileChatAttachments = (
  workspacePath: string,
  submissionId: string,
  attachments: MobileChatAttachment[]
) => {
  commitStagedMobileChatAttachments(workspacePath, submissionId)
  const registered = readMobileAttachments(workspacePath)
  const isComplete = attachments.every((attachment) =>
    registered.some(
      (record) =>
        record.file_id === attachment.file_id &&
        record.artifact === attachment.artifact &&
        record.placeholder === attachment.placeholder
    )
  )
  if (!isComplete) validateBoundMobileChatAttachments(workspacePath, submissionId, attachments)
}

export const prepareMigratedMobileChatAttachments = (
  workspacePath: string,
  sourceSubmissionId: string,
  targetSubmissionId: string,
  attachments: MobileChatAttachment[]
): {
  attachments: MobileChatAttachment[]
  bind: () => void
  cleanup: () => void
  register: () => void
} => {
  if (attachments.length === 0) {
    return {
      attachments: [],
      bind: () => undefined,
      cleanup: () => undefined,
      register: () => undefined,
    }
  }
  const targetDirectory = getChatAttachmentDirectory(workspacePath, targetSubmissionId)
  const migrated = attachments.map((attachment, index) => ({
    ...attachment,
    artifact: getChatAttachmentReference(
      targetSubmissionId,
      attachment.file_id,
      attachment.mime_type
    ),
    placeholder: `[Image ${targetSubmissionId.slice(0, 8)} #${index + 1}]`,
  }))
  const records = migrated.map((attachment, index) => {
    const sourceAttachment = attachments[index]
    if (!sourceAttachment) throw new BadRequestError('Chat attachment migration source is missing')
    const fileName = getPinnedFileName(attachment.file_id, attachment.mime_type)
    const source = resolveBoundMobileChatAttachment(
      workspacePath,
      sourceSubmissionId,
      sourceAttachment
    )
    return {
      artifact: attachment.artifact,
      created_at: Date.now(),
      file_id: attachment.file_id,
      local_path: join(targetDirectory, fileName),
      mime_type: attachment.mime_type,
      name: attachment.name,
      placeholder: attachment.placeholder,
      size: attachment.size,
      sourceContent: source.content,
    }
  })
  return {
    attachments: migrated,
    bind: () => {
      cleanupBoundMobileChatAttachments(workspacePath, targetSubmissionId)
      cleanupStagedMobileChatAttachments(workspacePath, targetSubmissionId)
      const safeStagingDirectory = ensureArtifactDirectory({
        directoryReference: getChatAttachmentStagingDirectoryReference(targetSubmissionId),
        workspacePath,
      })
      try {
        for (const record of records) {
          const stagedPath = join(
            safeStagingDirectory,
            getPinnedFileName(record.file_id, record.mime_type)
          )
          writeFileSync(stagedPath, record.sourceContent, { flag: 'wx' })
        }
      } catch (error) {
        rethrowAfterAttachmentCleanup({
          cleanup: () => cleanupStagedMobileChatAttachments(workspacePath, targetSubmissionId),
          code: 'chat_attachment_migration_failed',
          error,
          message: 'Chat attachment migration failed',
        })
      }
    },
    cleanup: () => {
      cleanupStagedMobileChatAttachments(workspacePath, targetSubmissionId)
      cleanupBoundMobileChatAttachments(workspacePath, targetSubmissionId)
    },
    register: () => {
      commitStagedMobileChatAttachments(workspacePath, targetSubmissionId)
      validateBoundMobileChatAttachments(workspacePath, targetSubmissionId, migrated)
    },
  }
}
