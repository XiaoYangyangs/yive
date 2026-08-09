import {
  normalizeResolvedArtifactReferences,
  parseArtifactReferences,
} from './artifact-reference.js'
import { BadRequestError, PayloadTooLargeError } from './http-errors.js'

const MAX_NOTE_TEXT_LENGTH = 50_000
const MAX_NOTE_ID_LENGTH = 200
const hasControlCharacter = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })

export const parseDispatchNoteArtifacts = (value: unknown): string[] =>
  parseArtifactReferences(value)

export const normalizeDispatchArtifactReferences = (input: {
  artifacts: string[]
  workspacePath: string
}) =>
  normalizeResolvedArtifactReferences({
    references: input.artifacts,
    workspacePath: input.workspacePath,
  })

export const validateDispatchNoteFields = (input: { id: string; text: string }) => {
  if (input.id.trim().length === 0) throw new BadRequestError('Dispatch Note id is required')
  if (input.text.trim().length === 0) throw new BadRequestError('Dispatch Note text is required')
  if (input.text.length > MAX_NOTE_TEXT_LENGTH) {
    throw new PayloadTooLargeError('Dispatch Note text is too large')
  }
  if (input.id.length > MAX_NOTE_ID_LENGTH || hasControlCharacter(input.id)) {
    throw new BadRequestError('Invalid Dispatch Note id')
  }
}

export const validateDispatchNoteInput = (input: {
  artifacts: string[]
  id: string
  text: string
  workspacePath: string
}) => {
  validateDispatchNoteFields(input)
  return normalizeDispatchArtifactReferences(input)
}
