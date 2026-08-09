import type { DispatchNoteRecord } from './dispatch-note-store.js'

export const serializeDispatchNote = (note: DispatchNoteRecord) => ({
  actor_id: note.actorId,
  actor_type: note.actorType,
  artifacts: note.artifacts,
  created_at: note.createdAt,
  delivered_at: note.deliveredAt,
  delivery_error: note.deliveryError,
  delivery_state: note.deliveryState,
  dispatch_id: note.dispatchId,
  id: note.id,
  sequence: note.sequence,
  text: note.text,
  workspace_id: note.workspaceId,
})
