import type { TerminalOwnershipState } from './terminal-client.js'

export interface TerminalOwnershipPresentationInput {
  ownership: TerminalOwnershipState
  viewerMode: 'active' | 'passive' | 'takeover' | undefined
}

export interface TerminalOwnershipPresentation {
  showTakeoverNotice: boolean
  reclaimActionLabel: string
  takeoverDescription: string
  takeoverTitle: string
  terminalHiddenByOtherOwner: boolean
}

export const getTerminalOwnershipPresentation = ({
  ownership,
  viewerMode,
}: TerminalOwnershipPresentationInput): TerminalOwnershipPresentation => {
  const hiddenByMobileTakeover =
    ownership.mode === 'takeover' && !ownership.ownedByThisClient && viewerMode !== 'takeover'
  const hiddenByDesktopTakeover =
    viewerMode === 'takeover' &&
    ownership.ownerClientId !== null &&
    !ownership.ownedByThisClient &&
    ownership.mode !== 'takeover'
  const showTakeoverNotice = hiddenByMobileTakeover || hiddenByDesktopTakeover

  return {
    showTakeoverNotice,
    reclaimActionLabel: hiddenByDesktopTakeover ? '手机重新接管' : '电脑重新接管',
    takeoverDescription: hiddenByDesktopTakeover
      ? '当前 PTY 由电脑端控制尺寸。重新接管后才能发送输入、快捷键或图片。'
      : '当前 PTY 已按手机端尺寸重排。重新接管后会切回电脑端尺寸。',
    takeoverTitle: hiddenByDesktopTakeover ? '电脑正在接管终端' : '手机正在接管终端',
    terminalHiddenByOtherOwner: showTakeoverNotice,
  }
}
