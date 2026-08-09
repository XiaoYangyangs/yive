import type { ArtifactReference } from '../shared/types.js'
import type { DispatchNotePromptItem } from './agent-runtime-contract.js'
import type { DispatchNoteRecord } from './dispatch-note-store.js'

const DISPATCH_NOTE_MARKERS = [
  '[Hive system message: supplemental Dispatch Notes]',
  '[Hive supplemental Dispatch Notes JSON]',
] as const

interface DispatchNoteEnvelope {
  dispatchId: string
  notes: DispatchNotePromptItem[]
}

export const toDispatchNotePromptItem = (note: DispatchNoteRecord): DispatchNotePromptItem => ({
  actorId: note.actorId,
  actorType: note.actorType,
  artifacts: note.artifacts,
  noteId: note.id,
  text: note.text,
})

const parsePromptItem = (value: unknown): DispatchNotePromptItem | null => {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const actor = item.actor
  if (!actor || typeof actor !== 'object') return null
  const actorRecord = actor as Record<string, unknown>
  if (
    typeof item.id !== 'string' ||
    typeof item.text !== 'string' ||
    !Array.isArray(item.artifacts) ||
    item.artifacts.some((artifact) => typeof artifact !== 'string') ||
    typeof actorRecord.id !== 'string' ||
    (actorRecord.type !== 'agent' && actorRecord.type !== 'user')
  ) {
    return null
  }
  return {
    actorId: actorRecord.id,
    actorType: actorRecord.type,
    artifacts: item.artifacts as ArtifactReference[],
    noteId: item.id,
    text: item.text,
  }
}

export const serializeDispatchNotes = (dispatchId: string, notes: DispatchNotePromptItem[]) =>
  JSON.stringify({
    dispatch_id: dispatchId,
    notes: notes.map((note) => ({
      actor: { id: note.actorId, type: note.actorType },
      artifacts: note.artifacts,
      id: note.noteId,
      text: note.text,
    })),
  })

export const parseDispatchNoteEnvelope = (text: string): DispatchNoteEnvelope | null => {
  const lines = text.split(/\r?\n/u)
  const markerIndex = lines.findIndex((line) =>
    DISPATCH_NOTE_MARKERS.some((marker) => line.includes(marker))
  )
  if (markerIndex < 0) return null
  const serializedLine = lines.slice(markerIndex + 1).find((line) => line.includes('{'))
  const start = serializedLine?.indexOf('{') ?? -1
  const end = serializedLine?.lastIndexOf('}') ?? -1
  if (!serializedLine || start < 0 || end < start) return null
  try {
    const value = JSON.parse(serializedLine.slice(start, end + 1)) as unknown
    if (!value || typeof value !== 'object') return null
    const envelope = value as Record<string, unknown>
    if (typeof envelope.dispatch_id !== 'string' || !Array.isArray(envelope.notes)) return null
    const notes = envelope.notes.map(parsePromptItem)
    if (notes.some((note) => note === null)) return null
    return {
      dispatchId: envelope.dispatch_id,
      notes: notes as DispatchNotePromptItem[],
    }
  } catch {
    return null
  }
}

export const findObservedDispatchNoteIds = (
  turns: Array<{ role: 'assistant' | 'user'; text: string }>,
  dispatchId: string,
  pending: DispatchNoteRecord[]
) => {
  const observedNotes = turns
    .filter((turn) => turn.role === 'user')
    .flatMap((turn) => {
      const envelope = parseDispatchNoteEnvelope(turn.text)
      return envelope?.dispatchId === dispatchId ? envelope.notes : []
    })
  return pending
    .filter((note) =>
      observedNotes.some(
        (observed) =>
          observed.noteId === note.id &&
          observed.actorId === note.actorId &&
          observed.actorType === note.actorType &&
          observed.text === note.text &&
          observed.artifacts.length === note.artifacts.length &&
          observed.artifacts.every((artifact, index) => artifact === note.artifacts[index])
      )
    )
    .map((note) => note.id)
}
