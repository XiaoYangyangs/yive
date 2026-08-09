import type { MobileEventsServerMessage, MobileSnapshot } from './types.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const parseMobileEventsServerMessage = (raw: string): MobileEventsServerMessage | null => {
  try {
    const value = JSON.parse(raw) as unknown
    if (!isRecord(value)) return null

    if (value.type === 'mobile-heartbeat' && typeof value.generated_at === 'number') {
      return { generated_at: value.generated_at, type: 'mobile-heartbeat' }
    }

    if (value.type === 'mobile-snapshot' && isRecord(value.snapshot)) {
      return { snapshot: value.snapshot as unknown as MobileSnapshot, type: 'mobile-snapshot' }
    }

    if (value.type === 'conversation-invalidated') {
      const allowedKeys = new Set([
        'activity_state',
        'agent_id',
        'conversation_id',
        'cursor',
        'type',
        'workspace_id',
      ])
      if (
        Object.keys(value).some((key) => !allowedKeys.has(key)) ||
        !['busy', 'idle', 'unknown'].includes(String(value.activity_state)) ||
        typeof value.agent_id !== 'string' ||
        typeof value.conversation_id !== 'string' ||
        !Number.isSafeInteger(value.cursor) ||
        typeof value.workspace_id !== 'string'
      ) {
        return null
      }
      return value as unknown as MobileEventsServerMessage
    }

    return null
  } catch {
    return null
  }
}
