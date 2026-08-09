import { useEffect, useRef } from 'react'

import type { TeamListItem, WorkspaceSummary } from '../../../src/shared/types.js'
import type { TerminalRunSummary } from '../api.js'
import { useI18n } from '../i18n.js'
import { useNotifications } from './NotificationProvider.js'

type WorkerSnapshot = Pick<
  TeamListItem,
  'id' | 'kind' | 'name' | 'processState' | 'queuedDispatchCount'
>

interface Snapshot {
  workers: Map<string, WorkerSnapshot>
  workspaceId: string
}

interface WorkspaceNotificationsProps {
  terminalRuns: TerminalRunSummary[]
  workers: TeamListItem[]
  workspace: WorkspaceSummary | undefined
}

const toWorkerMap = (workers: TeamListItem[]): Map<string, WorkerSnapshot> =>
  new Map(
    workers.map((worker) => [
      worker.id,
      {
        id: worker.id,
        kind: worker.kind,
        name: worker.name,
        processState: worker.processState,
        queuedDispatchCount: worker.queuedDispatchCount,
      },
    ])
  )

export const WorkspaceNotifications = ({
  terminalRuns: _terminalRuns,
  workers,
  workspace,
}: WorkspaceNotificationsProps) => {
  const { notify } = useNotifications()
  const { t } = useI18n()
  const previous = useRef<Snapshot | null>(null)

  useEffect(() => {
    if (!workspace) {
      previous.current = null
      return
    }

    const currentWorkers = toWorkerMap(workers)
    const prior = previous.current
    previous.current = { workers: currentWorkers, workspaceId: workspace.id }

    if (!prior || prior.workspaceId !== workspace.id) return

    for (const worker of currentWorkers.values()) {
      const before = prior.workers.get(worker.id)
      if (!before) continue

      if (before.processState !== 'crashed' && worker.processState === 'crashed') {
        notify({
          brief: t('notifications.workerCrashed.brief', { name: worker.name }),
          detail: t('notifications.workerCrashed.detail', {
            name: worker.name,
            workspace: workspace.name,
            count: worker.queuedDispatchCount,
          }),
          kind: 'error',
          title: t('notifications.workerCrashed.title'),
        })
        continue
      }

      if (before.processState !== 'running' && worker.processState === 'running') {
        notify({
          brief: t('notifications.workerStarted.brief', { name: worker.name }),
          detail: t('notifications.workerStarted.detail', {
            name: worker.name,
            workspace: workspace.name,
          }),
          kind: 'success',
          title: t('notifications.workerStarted.title'),
        })
      }
    }
  }, [notify, t, workers, workspace])

  return null
}
