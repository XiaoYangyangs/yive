export type RelayPeerKind = 'desktop' | 'mobile'

export interface RelayEnvelope<TPayload = unknown> {
  type: string
  request_id?: string
  from: string
  to: string
  channel: string
  relay_context?: {
    workspace_ids?: string[]
  }
  payload: TPayload
}

export interface RelayErrorPayload {
  code: string
  desktop_id?: string
  message: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readNonEmptyString = (value: unknown, field: string) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid relay envelope: ${field} is required`)
  }
  return value
}

export const parseRelayEnvelope = (raw: Buffer | string): RelayEnvelope => {
  const parsed = JSON.parse(raw.toString()) as unknown
  if (!isRecord(parsed)) {
    throw new Error('Invalid relay envelope: expected object')
  }
  if (!Object.hasOwn(parsed, 'payload')) {
    throw new Error('Invalid relay envelope: payload is required')
  }

  const envelope: RelayEnvelope = {
    channel: readNonEmptyString(parsed.channel, 'channel'),
    from: readNonEmptyString(parsed.from, 'from'),
    payload: parsed.payload,
    to: readNonEmptyString(parsed.to, 'to'),
    type: readNonEmptyString(parsed.type, 'type'),
  }
  if (typeof parsed.request_id === 'string' && parsed.request_id.trim().length > 0) {
    envelope.request_id = parsed.request_id
  }
  if (isRecord(parsed.relay_context)) {
    const workspaceIds = Array.isArray(parsed.relay_context.workspace_ids)
      ? parsed.relay_context.workspace_ids.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0
        )
      : undefined
    if (workspaceIds && workspaceIds.length > 0) {
      envelope.relay_context = { workspace_ids: workspaceIds }
    }
  }
  return envelope
}

export const serializeRelayError = (input: {
  channel?: string | undefined
  code: string
  desktopId?: string | undefined
  message: string
  requestId?: string | undefined
  to: string
}): string => {
  const payload: RelayErrorPayload = {
    code: input.code,
    message: input.message,
  }
  if (input.desktopId) payload.desktop_id = input.desktopId

  const envelope: RelayEnvelope = {
    channel: input.channel ?? 'relay',
    from: 'relay',
    payload,
    to: input.to,
    type: 'relay_error',
  }
  if (input.requestId) envelope.request_id = input.requestId
  return JSON.stringify(envelope)
}
