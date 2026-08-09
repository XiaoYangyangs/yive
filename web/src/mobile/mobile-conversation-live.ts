import type { MobileConversationPage } from '../../../src/shared/types.js'

const mergeByProviderEventId = <T extends { provider_event_id: string }>(
  current: T[],
  updates: T[]
) => {
  const merged = new Map(current.map((item) => [item.provider_event_id, item] as const))
  for (const item of updates) merged.set(item.provider_event_id, item)
  return Array.from(merged.values())
}

export const mergeMobileConversationUpdate = (
  current: MobileConversationPage | null,
  update: MobileConversationPage
): MobileConversationPage => {
  if (!current || current.id !== update.id) return update
  const updateIsStale =
    current.cursor !== undefined && update.cursor !== undefined && update.cursor < current.cursor
  if (updateIsStale) return current
  return {
    ...current,
    ...update,
    submissions: update.submissions,
    tool_activity: mergeByProviderEventId(
      current.tool_activity ?? [],
      update.tool_activity ?? []
    ).sort((left, right) => left.sequence - right.sequence),
    turns: mergeByProviderEventId(current.turns, update.turns).sort(
      (left, right) => left.sequence - right.sequence
    ),
  }
}
