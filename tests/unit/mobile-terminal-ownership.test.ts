import { describe, expect, test } from 'vitest'

import { getMobileTerminalOwnershipPresentation } from '../../web/src/mobile/mobile-terminal-ownership.js'

describe('mobile terminal ownership presentation', () => {
  test('allows input while the phone is a passive mirror', () => {
    expect(
      getMobileTerminalOwnershipPresentation({
        connectionTone: 'ok',
        inputSending: false,
        runActive: true,
        runIsStale: false,
        terminalOwnership: {
          mode: 'passive',
          ownedByThisClient: true,
          ownerClientId: 'phone-client',
        },
      })
    ).toMatchObject({
      disabledMessage: null,
      inputDisabled: false,
      inputPausedByOwnership: false,
      phoneOwnsTerminal: true,
      retryDisabled: false,
    })
  })

  test('pauses input when another viewer owns a takeover', () => {
    expect(
      getMobileTerminalOwnershipPresentation({
        connectionTone: 'ok',
        inputSending: false,
        runActive: true,
        runIsStale: false,
        terminalOwnership: {
          mode: 'takeover',
          ownedByThisClient: false,
          ownerClientId: 'desktop-client',
        },
      })
    ).toMatchObject({
      disabledMessage: '电脑端正在接管终端，手机端暂不发送输入、快捷键或图片。',
      inputDisabled: true,
      inputPausedByOwnership: true,
      phoneOwnsTerminal: false,
      retryDisabled: true,
    })
  })

  test('connection errors override ownership state', () => {
    expect(
      getMobileTerminalOwnershipPresentation({
        connectionTone: 'error',
        inputSending: false,
        runActive: true,
        runIsStale: false,
        terminalOwnership: {
          mode: 'passive',
          ownedByThisClient: true,
          ownerClientId: 'phone-client',
        },
      })
    ).toMatchObject({
      disabledMessage: '连接恢复前不会发送终端输入、快捷键或图片。',
      inputDisabled: true,
      phoneOwnsTerminal: true,
      retryDisabled: true,
    })
  })
})
