import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ArtifactReference } from '../shared/types.js'

const HIVE_DIR_NAME = '.hive'
const MOBILE_ATTACHMENTS_FILE_NAME = 'mobile-attachments.json'
export const MOBILE_ATTACHMENTS_RELATIVE_PATH = `${HIVE_DIR_NAME}/${MOBILE_ATTACHMENTS_FILE_NAME}`

export interface MobileAttachmentRecord {
  artifact?: ArtifactReference
  created_at: number
  file_id: string
  local_path: string
  mime_type: string
  name: string
  placeholder: string
  size: number
}

interface MobileAttachmentsFile {
  attachments: MobileAttachmentRecord[]
  updated_at: number
}

const isMobileAttachmentRecord = (value: unknown): value is MobileAttachmentRecord => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.created_at === 'number' &&
    Number.isFinite(record.created_at) &&
    (record.artifact === undefined || typeof record.artifact === 'string') &&
    typeof record.file_id === 'string' &&
    typeof record.local_path === 'string' &&
    typeof record.mime_type === 'string' &&
    typeof record.name === 'string' &&
    typeof record.placeholder === 'string' &&
    typeof record.size === 'number' &&
    Number.isFinite(record.size)
  )
}

export const getMobileAttachmentsFilePath = (workspacePath: string) =>
  join(workspacePath, HIVE_DIR_NAME, MOBILE_ATTACHMENTS_FILE_NAME)

const readMobileAttachmentsFile = (workspacePath: string): MobileAttachmentsFile => {
  const filePath = getMobileAttachmentsFilePath(workspacePath)
  if (!existsSync(filePath)) return { attachments: [], updated_at: 0 }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<MobileAttachmentsFile>
    if (!Array.isArray(parsed.attachments) || !parsed.attachments.every(isMobileAttachmentRecord)) {
      throw new Error('Invalid mobile attachment registry')
    }
    return {
      attachments: parsed.attachments,
      updated_at: typeof parsed.updated_at === 'number' ? parsed.updated_at : 0,
    }
  } catch (error) {
    throw new Error('Invalid mobile attachment registry', { cause: error })
  }
}

export const readMobileAttachments = (workspacePath: string): MobileAttachmentRecord[] =>
  readMobileAttachmentsFile(workspacePath).attachments

const writeMobileAttachmentsFile = (
  workspacePath: string,
  attachments: MobileAttachmentRecord[]
) => {
  const filePath = getMobileAttachmentsFilePath(workspacePath)
  mkdirSync(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(
      temporaryPath,
      JSON.stringify({ attachments, updated_at: Date.now() }, null, 2),
      'utf8'
    )
    renameSync(temporaryPath, filePath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

export const replaceMobileAttachments = (
  workspacePath: string,
  attachments: MobileAttachmentRecord[]
) => writeMobileAttachmentsFile(workspacePath, attachments)

export const appendMobileAttachments = (
  workspacePath: string,
  attachments: MobileAttachmentRecord[]
) => {
  if (attachments.length === 0) return
  const current = readMobileAttachmentsFile(workspacePath)
  const byPlaceholder = new Map<string, MobileAttachmentRecord>()
  for (const attachment of current.attachments) {
    byPlaceholder.set(attachment.placeholder, attachment)
  }
  for (const attachment of attachments) {
    byPlaceholder.set(attachment.placeholder, attachment)
  }
  writeMobileAttachmentsFile(workspacePath, Array.from(byPlaceholder.values()))
}

export const removeMobileAttachments = (
  workspacePath: string,
  shouldRemove: (attachment: MobileAttachmentRecord) => boolean
) => {
  const current = readMobileAttachmentsFile(workspacePath)
  const attachments = current.attachments.filter((attachment) => !shouldRemove(attachment))
  if (attachments.length === current.attachments.length) return
  writeMobileAttachmentsFile(workspacePath, attachments)
}
