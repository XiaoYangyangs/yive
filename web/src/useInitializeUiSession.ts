import { useEffect, useRef } from 'react'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import {
  getActiveWorkspaceId,
  initializeUiSession,
  listWorkspaces,
  saveActiveWorkspaceId,
} from './api.js'

const WORKSPACE_REFRESH_INTERVAL_MS = 5_000

const resolveActiveWorkspaceId = (workspaces: WorkspaceSummary[], persistedId: string | null) => {
  if (persistedId && workspaces.some((workspace) => workspace.id === persistedId)) {
    return persistedId
  }
  return workspaces[0]?.id ?? null
}

const mergeWorkspaces = (
  current: WorkspaceSummary[] | null,
  incoming: WorkspaceSummary[]
): WorkspaceSummary[] => {
  if (current === null) return incoming
  const merged = new Map(current.map((workspace) => [workspace.id, workspace]))
  for (const workspace of incoming) {
    merged.set(workspace.id, workspace)
  }
  return Array.from(merged.values())
}

export const useInitializeUiSession = (
  setWorkspaces: (
    value:
      | WorkspaceSummary[]
      | null
      | ((current: WorkspaceSummary[] | null) => WorkspaceSummary[] | null)
  ) => void,
  setActiveWorkspaceId: (value: string | null) => void,
  onError?: (message: string) => void
) => {
  const workspacesRef = useRef<WorkspaceSummary[] | null>(null)

  useEffect(() => {
    let cancelled = false
    let refreshTimer: number | undefined
    let refreshing = false

    const applyWorkspaceSnapshot = (
      items: WorkspaceSummary[],
      persistedId: string | null,
      mergeWithCurrent: boolean
    ) => {
      if (cancelled) return
      setWorkspaces((current) => {
        const next = mergeWithCurrent ? mergeWorkspaces(current, items) : items
        const nextActiveWorkspaceId = resolveActiveWorkspaceId(next, persistedId)
        setActiveWorkspaceId(nextActiveWorkspaceId)
        if (persistedId !== nextActiveWorkspaceId) {
          saveActiveWorkspaceId(nextActiveWorkspaceId).catch((error: unknown) => {
            console.error('[hive] swallowed:initSession.save', error)
          })
        }
        workspacesRef.current = next
        return next
      })
    }

    const fetchWorkspaceSnapshot = async () => {
      const [items, persistedId] = await Promise.all([
        listWorkspaces(),
        getActiveWorkspaceId().catch(() => null),
      ])
      return { items, persistedId }
    }

    const shouldConfirmShrinkingSnapshot = (items: WorkspaceSummary[]) => {
      const current = workspacesRef.current
      if (current === null) return false
      if (items.length >= current.length) return false
      const incomingIds = new Set(items.map((workspace) => workspace.id))
      return current.some((workspace) => !incomingIds.has(workspace.id))
    }

    const refreshWorkspaceSnapshot = (reason: string) => {
      if (refreshing) return
      refreshing = true
      void fetchWorkspaceSnapshot()
        .then(({ items, persistedId }) => {
          if (shouldConfirmShrinkingSnapshot(items)) {
            return fetchWorkspaceSnapshot().then((confirmed) => {
              applyWorkspaceSnapshot(confirmed.items, confirmed.persistedId, false)
            })
          }
          applyWorkspaceSnapshot(items, persistedId, false)
        })
        .catch((error: unknown) => {
          console.error(`[hive] swallowed:initSession.${reason}`, error)
        })
        .finally(() => {
          refreshing = false
        })
    }

    const startRefresh = () => {
      refreshTimer = window.setInterval(() => {
        refreshWorkspaceSnapshot('refresh')
      }, WORKSPACE_REFRESH_INTERVAL_MS)
    }

    const refreshWhenForeground = () => {
      refreshWorkspaceSnapshot('foreground')
    }

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshWorkspaceSnapshot('visible')
    }

    void initializeUiSession()
      .then(fetchWorkspaceSnapshot)
      .then(({ items, persistedId }) => {
        applyWorkspaceSnapshot(items, persistedId, true)
        startRefresh()
        window.addEventListener('focus', refreshWhenForeground)
        document.addEventListener('visibilitychange', refreshWhenVisible)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          // Keep workspaces=null on bootstrap failure so the UI does NOT fall
          // into the empty-workspaces branch (which would render WelcomePane,
          // making "runtime down" indistinguishable from "no workspaces yet").
          setActiveWorkspaceId(null)
          if (onError) {
            onError('Could not reach Yive runtime. Refresh once the runtime is back up.')
          }
        }
        console.error('[hive] swallowed:initSession.bootstrap', error)
      })

    return () => {
      cancelled = true
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer)
      window.removeEventListener('focus', refreshWhenForeground)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [setActiveWorkspaceId, setWorkspaces, onError])
}
