import type { TerminalOwnershipState } from '../terminal/terminal-client.js'

export interface MobileTerminalOwnershipInput {
  connectionTone: 'error' | 'ok' | 'warn'
  inputSending: boolean
  runActive: boolean
  runIsStale: boolean
  terminalOwnership: TerminalOwnershipState | null
}

export interface MobileTerminalOwnershipPresentation {
  disabledMessage: string | null
  inputDisabled: boolean
  inputPausedByOwnership: boolean
  phoneOwnsTerminal: boolean
  retryDisabled: boolean
}

export const getMobileTerminalOwnershipPresentation = ({
  connectionTone,
  inputSending,
  runActive,
  runIsStale,
  terminalOwnership,
}: MobileTerminalOwnershipInput): MobileTerminalOwnershipPresentation => {
  const phoneOwnsTerminal = terminalOwnership?.ownedByThisClient === true
  const inputPausedByOwnership =
    runActive &&
    !runIsStale &&
    terminalOwnership?.mode === 'takeover' &&
    !terminalOwnership.ownedByThisClient &&
    connectionTone !== 'error'
  const inputDisabled = inputSending || connectionTone === 'error' || inputPausedByOwnership
  const disabledMessage =
    connectionTone === 'error'
      ? '连接恢复前不会发送终端输入、快捷键或图片。'
      : inputPausedByOwnership
        ? '电脑端正在接管终端，手机端暂不发送输入、快捷键或图片。'
        : null

  return {
    disabledMessage,
    inputDisabled,
    inputPausedByOwnership,
    phoneOwnsTerminal,
    retryDisabled: inputDisabled,
  }
}
