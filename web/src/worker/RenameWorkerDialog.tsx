import type { TeamListItem } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'
import { RenameAgentDialog } from './RenameAgentDialog.js'

type RenameWorkerDialogProps = {
  worker: TeamListItem | null
  busy?: boolean
  onClose: () => void
  onSubmit: (worker: TeamListItem, name: string) => void
}

export const RenameWorkerDialog = ({
  worker,
  busy = false,
  onClose,
  onSubmit,
}: RenameWorkerDialogProps) => {
  const { t } = useI18n()
  return (
    <RenameAgentDialog
      agent={worker}
      busy={busy}
      description={t('worker.renameDesc')}
      inputTestId="rename-worker-input"
      onClose={onClose}
      onSubmit={onSubmit}
      saveTestId="rename-worker-save"
      title={t('worker.renameTitle')}
    />
  )
}
