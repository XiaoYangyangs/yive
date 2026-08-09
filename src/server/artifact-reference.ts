import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { basename, extname, isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path'

import type { ArtifactReference } from '../shared/types.js'
import { BadRequestError, InternalServerError, PayloadTooLargeError } from './http-errors.js'

export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024
export const MAX_ARTIFACT_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_ARTIFACT_REFERENCES = 32
export const MAX_ARTIFACT_REFERENCE_LENGTH = 1_000

const IMAGE_EXTENSIONS = new Set(['.jpeg', '.jpg', '.png', '.webp'])
const BINARY_EXTENSIONS = new Set(['.jpeg', '.jpg', '.mp4', '.pdf', '.png', '.webp', '.zip'])
const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.conf',
  '.cpp',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.log',
  '.md',
  '.mjs',
  '.py',
  '.rs',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
])
const EXTENSIONLESS_TEXT_FILES = new Set(['dockerfile', 'license', 'makefile', 'notice', 'readme'])
const SENSITIVE_FILE_NAMES = new Set([
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.yarnrc',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
])
const SENSITIVE_EXTENSIONS = new Set(['.key', '.p12', '.pfx', '.pem'])

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
}

export interface ResolvedArtifactReference {
  absolutePath: string
  mimeType: string
  name: string
  reference: ArtifactReference
  size: number
}

export interface ArtifactReferenceSnapshot extends ResolvedArtifactReference {
  content: Buffer
}

export const haveSameArtifactFileIdentity = (
  opened: { dev: bigint; ino: bigint },
  resolved: { dev: bigint; ino: bigint }
) => opened.dev === resolved.dev && opened.ino === resolved.ino

const toSafeArtifactSize = (size: bigint): number =>
  size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(size)

const hasControlCharacter = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })

const isAbsolutePath = (value: string) =>
  isAbsolute(value) || posix.isAbsolute(value) || win32.isAbsolute(value)

const hasFileSystemCode = (error: unknown, codes: readonly string[]) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof (error as { code?: unknown }).code === 'string' &&
  codes.includes((error as { code: string }).code)

const isInsideDirectory = (root: string, candidate: string) => {
  const relation = relative(root, candidate)
  return (
    relation !== '' &&
    relation !== '..' &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation) &&
    !win32.isAbsolute(relation)
  )
}

const getArtifactWorkspaceRoot = (workspacePath: string) => {
  try {
    return realpathSync(resolve(workspacePath))
  } catch (error) {
    throw new InternalServerError(
      'Artifact Workspace is unavailable',
      'artifact_workspace_unavailable',
      error
    )
  }
}

const normalizeArtifactPathReference = ({
  invalidMessage,
  reference,
  rejectCurrentSegments,
}: {
  invalidMessage: string
  reference: string
  rejectCurrentSegments: boolean
}) => {
  const trimmed = reference.trim()
  if (!trimmed || trimmed.length > MAX_ARTIFACT_REFERENCE_LENGTH || hasControlCharacter(trimmed)) {
    throw new BadRequestError(invalidMessage)
  }
  if (isAbsolutePath(trimmed)) {
    throw new BadRequestError('Artifact references must be Workspace-relative')
  }
  const slashSeparated = trimmed.replaceAll('\\', '/')
  if (
    slashSeparated
      .split('/')
      .some((segment) => segment === '..' || (rejectCurrentSegments && segment === '.'))
  ) {
    throw new BadRequestError('Artifact references must stay inside the Workspace')
  }
  const normalized = posix.normalize(slashSeparated)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new BadRequestError('Artifact references must stay inside the Workspace')
  }
  const segments = normalized.split('/').map((segment) => segment.toLowerCase())
  if (segments.includes('.git') || segments.includes('.ssh')) {
    throw new BadRequestError('Artifact references cannot expose credential directories')
  }
  return normalized
}

const normalizeArtifactDirectoryReference = (reference: string) =>
  normalizeArtifactPathReference({
    invalidMessage: 'Invalid Artifact directory reference',
    reference,
    rejectCurrentSegments: true,
  })

const resolveArtifactDirectory = ({
  create,
  directoryReference,
  workspacePath,
}: {
  create: boolean
  directoryReference: string
  workspacePath: string
}): string | null => {
  const normalized = normalizeArtifactDirectoryReference(directoryReference)
  const workspaceRoot = getArtifactWorkspaceRoot(workspacePath)
  let current = workspaceRoot

  for (const segment of normalized.split('/')) {
    const candidate = resolve(current, segment)
    if (!isInsideDirectory(workspaceRoot, candidate)) {
      throw new BadRequestError('Artifact references must stay inside the Workspace')
    }
    try {
      let stat: ReturnType<typeof lstatSync>
      try {
        stat = lstatSync(candidate)
      } catch (error) {
        if (!hasFileSystemCode(error, ['ENOENT', 'ENOTDIR'])) throw error
        if (!create) return null
        mkdirSync(candidate)
        stat = lstatSync(candidate)
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new BadRequestError('Artifact directory must not use symbolic links')
      }
      const realCandidate = realpathSync(candidate)
      if (!isInsideDirectory(workspaceRoot, realCandidate)) {
        throw new BadRequestError('Artifact references must stay inside the Workspace')
      }
      current = realCandidate
    } catch (error) {
      if (error instanceof BadRequestError) throw error
      throw new InternalServerError(
        'Artifact directory is unavailable',
        'artifact_directory_unavailable',
        error
      )
    }
  }
  return current
}

export const ensureArtifactDirectory = (input: {
  directoryReference: string
  workspacePath: string
}) => resolveArtifactDirectory({ ...input, create: true }) as string

export const findExistingArtifactDirectory = (input: {
  directoryReference: string
  workspacePath: string
}) => resolveArtifactDirectory({ ...input, create: false })

export const getArtifactExtension = (name: string) => extname(name).toLowerCase()

const assertAllowedArtifactName = (name: string) => {
  const normalizedName = name.toLowerCase()
  const extension = getArtifactExtension(normalizedName)
  if (
    normalizedName === '.env' ||
    normalizedName.startsWith('.env.') ||
    SENSITIVE_FILE_NAMES.has(normalizedName) ||
    SENSITIVE_EXTENSIONS.has(extension)
  ) {
    throw new BadRequestError('Artifact credentials and private keys are not allowed')
  }
  if (
    !TEXT_EXTENSIONS.has(extension) &&
    !BINARY_EXTENSIONS.has(extension) &&
    !(extension === '' && EXTENSIONLESS_TEXT_FILES.has(normalizedName))
  ) {
    throw new BadRequestError(`Unsupported Artifact type: ${extension || '(no extension)'}`)
  }
}

const assertWithinSizeLimit = (extension: string, size: number) => {
  const limit = IMAGE_EXTENSIONS.has(extension) ? MAX_ARTIFACT_IMAGE_BYTES : MAX_ARTIFACT_BYTES
  if (size > limit) {
    throw new PayloadTooLargeError(
      IMAGE_EXTENSIONS.has(extension)
        ? 'Artifact image exceeds 10MB limit'
        : 'Artifact exceeds 100MB limit'
    )
  }
}

export const assertArtifactNameAndSize = (name: string, size: number) => {
  assertAllowedArtifactName(name)
  assertWithinSizeLimit(getArtifactExtension(name), size)
}

export const getArtifactMimeType = (name: string) =>
  MIME_TYPES[getArtifactExtension(name)] ?? 'text/plain; charset=utf-8'

export const isArtifactImage = (name: string) => IMAGE_EXTENSIONS.has(getArtifactExtension(name))

const isTextArtifactExtension = (extension: string) => !BINARY_EXTENSIONS.has(extension)

const isMp4Content = (content: Buffer) =>
  content.length >= 12 && content.subarray(4, 8).toString('ascii') === 'ftyp'

export const assertArtifactContentMatchesName = (
  name: string,
  content: Buffer,
  size = content.length
) => {
  assertAllowedArtifactName(name)
  const extension = getArtifactExtension(name)
  assertWithinSizeLimit(extension, size)

  const mismatch = (label: string): never => {
    throw new BadRequestError(`Artifact content does not match ${label} extension`)
  }
  if (
    extension === '.png' &&
    !content.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  )
    mismatch('.png')
  if (
    (extension === '.jpg' || extension === '.jpeg') &&
    (content.length < 3 || content[0] !== 0xff || content[1] !== 0xd8 || content[2] !== 0xff)
  )
    mismatch('.jpg')
  if (
    extension === '.webp' &&
    !(
      content.subarray(0, 4).toString('ascii') === 'RIFF' &&
      content.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  )
    mismatch('.webp')
  if (extension === '.pdf' && content.subarray(0, 5).toString('ascii') !== '%PDF-') {
    mismatch('.pdf')
  }
  if (extension === '.zip' && !content.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))) {
    mismatch('.zip')
  }
  if (extension === '.mp4' && !isMp4Content(content)) mismatch('.mp4')
  if (isTextArtifactExtension(extension) && content.includes(0)) {
    throw new BadRequestError('Artifact text file contains binary content')
  }
}

export const parseArtifactReferences = (value: unknown, field = 'artifacts'): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new BadRequestError(`${field} must be an array`)
  return value.map((artifact, index) => {
    if (typeof artifact !== 'string' || artifact.trim().length === 0) {
      throw new BadRequestError(`${field}[${index}] is required`)
    }
    return artifact.trim()
  })
}

export const normalizeArtifactReference = (reference: string): ArtifactReference => {
  const normalized = normalizeArtifactPathReference({
    invalidMessage: 'Invalid Artifact reference',
    reference,
    rejectCurrentSegments: false,
  })
  assertAllowedArtifactName(posix.basename(normalized))
  return normalized as ArtifactReference
}

export const resolveArtifactReference = ({
  reference,
  workspacePath,
}: {
  reference: string
  workspacePath: string
}): ResolvedArtifactReference => {
  const normalized = normalizeArtifactReference(reference)
  const workspaceRoot = getArtifactWorkspaceRoot(workspacePath)
  const candidate = resolve(workspaceRoot, normalized)
  let descriptor: number
  try {
    descriptor = openSync(candidate, 'r')
  } catch (error) {
    if (hasFileSystemCode(error, ['ENOENT', 'ENOTDIR'])) {
      throw new BadRequestError(`Artifact not found: ${normalized}`)
    }
    throw new InternalServerError(
      'Artifact content is unavailable',
      'artifact_content_unavailable',
      error
    )
  }
  let operationError: unknown
  let result: ResolvedArtifactReference | undefined
  try {
    const descriptorStat = fstatSync(descriptor, { bigint: true })
    if (!descriptorStat.isFile())
      throw new BadRequestError('Artifact reference must identify a file')
    const realCandidate = realpathSync(candidate)
    if (!isInsideDirectory(workspaceRoot, realCandidate)) {
      throw new BadRequestError('Artifact references must stay inside the Workspace')
    }
    const pathStat = statSync(realCandidate, { bigint: true })
    if (!pathStat.isFile() || !haveSameArtifactFileIdentity(descriptorStat, pathStat)) {
      throw new BadRequestError('Artifact changed while it was being opened')
    }
    const name = basename(realCandidate)
    const extension = getArtifactExtension(name)
    const descriptorSize = toSafeArtifactSize(descriptorStat.size)
    assertAllowedArtifactName(name)
    assertWithinSizeLimit(extension, descriptorSize)
    const contentPrefix = Buffer.alloc(Math.min(descriptorSize, 8 * 1024))
    readSync(descriptor, contentPrefix, 0, contentPrefix.length, 0)
    if (isTextArtifactExtension(extension)) {
      const contentChunk = Buffer.alloc(64 * 1024)
      let position = contentPrefix.length
      while (position < descriptorSize) {
        const bytesRead = readSync(
          descriptor,
          contentChunk,
          0,
          Math.min(contentChunk.length, descriptorSize - position),
          position
        )
        if (bytesRead === 0) break
        if (contentChunk.subarray(0, bytesRead).includes(0)) {
          throw new BadRequestError('Artifact text file contains binary content')
        }
        position += bytesRead
      }
    }
    assertArtifactContentMatchesName(name, contentPrefix, descriptorSize)
    result = {
      absolutePath: realCandidate,
      mimeType: getArtifactMimeType(name),
      name,
      reference: relative(workspaceRoot, realCandidate).split(sep).join('/') as ArtifactReference,
      size: descriptorSize,
    }
  } catch (error) {
    operationError = error
  }
  try {
    closeSync(descriptor)
  } catch (error) {
    if (!operationError) {
      operationError = new InternalServerError(
        'Artifact content is unavailable',
        'artifact_content_unavailable',
        error
      )
    }
  }
  if (operationError) {
    if (
      operationError instanceof BadRequestError ||
      operationError instanceof InternalServerError ||
      operationError instanceof PayloadTooLargeError
    ) {
      throw operationError
    }
    throw new InternalServerError(
      'Artifact content is unavailable',
      'artifact_content_unavailable',
      operationError
    )
  }
  if (!result) {
    throw new InternalServerError(
      'Artifact content is unavailable',
      'artifact_content_unavailable',
      new Error('Artifact validation did not produce a result')
    )
  }
  return result
}

export const readArtifactReferenceSnapshot = ({
  reference,
  workspacePath,
}: {
  reference: string
  workspacePath: string
}): ArtifactReferenceSnapshot => {
  const normalized = normalizeArtifactReference(reference)
  const workspaceRoot = getArtifactWorkspaceRoot(workspacePath)
  const candidate = resolve(workspaceRoot, normalized)
  let descriptor: number
  try {
    descriptor = openSync(candidate, 'r')
  } catch (error) {
    if (hasFileSystemCode(error, ['ENOENT', 'ENOTDIR'])) {
      throw new BadRequestError(`Artifact not found: ${normalized}`)
    }
    throw new InternalServerError(
      'Artifact content is unavailable',
      'artifact_content_unavailable',
      error
    )
  }

  let result: ArtifactReferenceSnapshot | undefined
  let operationError: unknown
  try {
    const descriptorStat = fstatSync(descriptor, { bigint: true })
    if (!descriptorStat.isFile())
      throw new BadRequestError('Artifact reference must identify a file')
    const realCandidate = realpathSync(candidate)
    if (!isInsideDirectory(workspaceRoot, realCandidate)) {
      throw new BadRequestError('Artifact references must stay inside the Workspace')
    }
    const pathStat = statSync(realCandidate, { bigint: true })
    if (!pathStat.isFile() || !haveSameArtifactFileIdentity(descriptorStat, pathStat)) {
      throw new BadRequestError('Artifact changed while it was being opened')
    }

    const name = basename(realCandidate)
    const extension = getArtifactExtension(name)
    const descriptorSize = toSafeArtifactSize(descriptorStat.size)
    assertAllowedArtifactName(name)
    assertWithinSizeLimit(extension, descriptorSize)
    const maximumBytes = isArtifactImage(name) ? MAX_ARTIFACT_IMAGE_BYTES : MAX_ARTIFACT_BYTES
    const chunks: Buffer[] = []
    let totalBytes = 0
    while (totalBytes <= maximumBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maximumBytes + 1 - totalBytes))
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      totalBytes += bytesRead
    }
    assertWithinSizeLimit(extension, totalBytes)
    const content = Buffer.concat(chunks, totalBytes)
    assertArtifactContentMatchesName(name, content)
    result = {
      absolutePath: realCandidate,
      content,
      mimeType: getArtifactMimeType(name),
      name,
      reference: relative(workspaceRoot, realCandidate).split(sep).join('/') as ArtifactReference,
      size: totalBytes,
    }
  } catch (error) {
    operationError = error
  }
  try {
    closeSync(descriptor)
  } catch (error) {
    operationError ??= new InternalServerError(
      'Artifact content is unavailable',
      'artifact_content_unavailable',
      error
    )
  }
  if (operationError) {
    if (
      operationError instanceof BadRequestError ||
      operationError instanceof InternalServerError ||
      operationError instanceof PayloadTooLargeError
    ) {
      throw operationError
    }
    throw new InternalServerError(
      'Artifact content is unavailable',
      'artifact_content_unavailable',
      operationError
    )
  }
  if (!result) {
    throw new InternalServerError(
      'Artifact content is unavailable',
      'artifact_content_unavailable',
      new Error('Artifact snapshot did not produce a result')
    )
  }
  return result
}

export const resolveArtifactReferences = ({
  references,
  workspacePath,
}: {
  references: string[]
  workspacePath: string
}): ResolvedArtifactReference[] => {
  if (references.length > MAX_ARTIFACT_REFERENCES) {
    throw new BadRequestError(`At most ${MAX_ARTIFACT_REFERENCES} Artifact references are allowed`)
  }
  return references.map((reference) => resolveArtifactReference({ reference, workspacePath }))
}

export const normalizeArtifactReferences = (references: string[]): ArtifactReference[] => {
  if (references.length > MAX_ARTIFACT_REFERENCES) {
    throw new BadRequestError(`At most ${MAX_ARTIFACT_REFERENCES} Artifact references are allowed`)
  }
  return references.map(normalizeArtifactReference)
}

export const normalizeResolvedArtifactReferences = (input: {
  references: string[]
  workspacePath: string
}): ArtifactReference[] => resolveArtifactReferences(input).map((artifact) => artifact.reference)
