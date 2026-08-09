import { lazy, Suspense } from 'react'

import type { WorkspaceCreateInput } from './workspace/workspace-create-input.js'

const AddWorkspaceDialog = lazy(() =>
  import('./workspace/AddWorkspaceDialog.js').then((module) => ({
    default: module.AddWorkspaceDialog,
  }))
)
const FirstRunWizard = lazy(() =>
  import('./wizard/FirstRunWizard.js').then((module) => ({ default: module.FirstRunWizard }))
)

type AppOverlaysProps = {
  addDialogTrigger: number
  onAddWorkspace: () => void
  onCloseWizard: (shouldMarkSeen?: boolean) => void
  onCreateWorkspace: (input: WorkspaceCreateInput) => Promise<unknown> | undefined
  onTryDemo: () => void
  wizardOpen: boolean
}

export const AppOverlays = ({
  addDialogTrigger,
  onAddWorkspace,
  onCloseWizard,
  onCreateWorkspace,
  onTryDemo,
  wizardOpen,
}: AppOverlaysProps) => (
  <>
    {addDialogTrigger > 0 ? (
      <Suspense fallback={null}>
        <AddWorkspaceDialog
          onClose={() => {}}
          onCreate={onCreateWorkspace}
          trigger={addDialogTrigger}
        />
      </Suspense>
    ) : null}
    {wizardOpen ? (
      <Suspense fallback={null}>
        <FirstRunWizard
          open={wizardOpen}
          onClose={onCloseWizard}
          onAddWorkspace={onAddWorkspace}
          onTryDemo={onTryDemo}
        />
      </Suspense>
    ) : null}
  </>
)
