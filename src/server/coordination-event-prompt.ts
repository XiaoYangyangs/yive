import type { CoordinationEventRecord } from './coordination-event-store.js'

const COORDINATION_EVENT_MARKER = '[Hive Team coordination events JSON]'

interface CoordinationEventEnvelopeItem {
  artifacts: string[]
  dispatchId: string | null
  id: string
  kind: CoordinationEventRecord['kind']
  outcome: CoordinationEventRecord['outcome']
  text: string
  workerId: string
}

const toEnvelopeItem = (event: CoordinationEventRecord): CoordinationEventEnvelopeItem => ({
  artifacts: event.artifacts,
  dispatchId: event.dispatchId,
  id: event.id,
  kind: event.kind,
  outcome: event.outcome,
  text: event.text,
  workerId: event.workerId,
})

export const serializeCoordinationEvents = (events: CoordinationEventRecord[]) =>
  [
    COORDINATION_EVENT_MARKER,
    JSON.stringify({
      events: events.map((event) => ({
        artifacts: event.artifacts,
        dispatch_id: event.dispatchId,
        id: event.id,
        kind: event.kind,
        outcome: event.outcome,
        text: event.text,
        worker_id: event.workerId,
      })),
    }),
  ].join('\n')

const parseEnvelopeItem = (value: unknown): CoordinationEventEnvelopeItem | null => {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (
    typeof item.id !== 'string' ||
    typeof item.worker_id !== 'string' ||
    (item.dispatch_id !== null && typeof item.dispatch_id !== 'string') ||
    !['crash', 'report', 'status'].includes(String(item.kind)) ||
    (item.outcome !== null && item.outcome !== 'completed' && item.outcome !== 'failed') ||
    typeof item.text !== 'string' ||
    !Array.isArray(item.artifacts) ||
    item.artifacts.some((artifact) => typeof artifact !== 'string')
  ) {
    return null
  }
  return {
    artifacts: item.artifacts as string[],
    dispatchId: item.dispatch_id as string | null,
    id: item.id,
    kind: item.kind as CoordinationEventRecord['kind'],
    outcome: item.outcome as CoordinationEventRecord['outcome'],
    text: item.text,
    workerId: item.worker_id,
  }
}

const parseCoordinationEventEnvelope = (text: string): CoordinationEventEnvelopeItem[] => {
  const lines = text.split(/\r?\n/u)
  const markerIndex = lines.findIndex((line) => line.includes(COORDINATION_EVENT_MARKER))
  if (markerIndex < 0) return []
  const serializedLine = lines.slice(markerIndex + 1).find((line) => line.includes('{'))
  if (!serializedLine) return []
  const start = serializedLine.indexOf('{')
  const end = serializedLine.lastIndexOf('}')
  if (start < 0 || end < start) return []
  try {
    const value = JSON.parse(serializedLine.slice(start, end + 1)) as unknown
    if (!value || typeof value !== 'object') return []
    const events = (value as Record<string, unknown>).events
    if (!Array.isArray(events)) return []
    const parsed = events.map(parseEnvelopeItem)
    return parsed.some((event) => event === null) ? [] : (parsed as CoordinationEventEnvelopeItem[])
  } catch {
    return []
  }
}

const sameEvent = (observed: CoordinationEventEnvelopeItem, event: CoordinationEventRecord) => {
  const expected = toEnvelopeItem(event)
  return (
    observed.id === expected.id &&
    observed.workerId === expected.workerId &&
    observed.dispatchId === expected.dispatchId &&
    observed.kind === expected.kind &&
    observed.outcome === expected.outcome &&
    observed.text === expected.text &&
    observed.artifacts.length === expected.artifacts.length &&
    observed.artifacts.every((artifact, index) => artifact === expected.artifacts[index])
  )
}

export const findObservedCoordinationEventIds = (
  turns: Array<{ role: 'assistant' | 'user'; text: string }>,
  pending: CoordinationEventRecord[]
) => {
  const observed = turns
    .filter((turn) => turn.role === 'user')
    .flatMap((turn) => parseCoordinationEventEnvelope(turn.text))
  return pending
    .filter((event) => observed.some((candidate) => sameEvent(candidate, event)))
    .map((event) => event.id)
}
