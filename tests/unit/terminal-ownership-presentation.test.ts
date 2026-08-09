import { describe, expect, test } from 'vitest'

import { getTerminalOwnershipPresentation } from '../../web/src/terminal/terminal-ownership-presentation.js'

describe('terminal ownership presentation', () => {
  test('hides the desktop terminal while a phone owns takeover', () => {
    expect(
      getTerminalOwnershipPresentation({
        ownership: {
          mode: 'takeover',
          ownedByThisClient: false,
          ownerClientId: 'phone-client',
        },
        viewerMode: 'active',
      })
    ).toEqual({
      reclaimActionLabel: '电脑重新接管',
      showTakeoverNotice: true,
      takeoverDescription: '当前 PTY 已按手机端尺寸重排。重新接管后会切回电脑端尺寸。',
      takeoverTitle: '手机正在接管终端',
      terminalHiddenByOtherOwner: true,
    })
  })

  test('hides the phone takeover terminal while the desktop owns the PTY', () => {
    expect(
      getTerminalOwnershipPresentation({
        ownership: {
          mode: 'active',
          ownedByThisClient: false,
          ownerClientId: 'desktop-client',
        },
        viewerMode: 'takeover',
      })
    ).toEqual({
      reclaimActionLabel: '手机重新接管',
      showTakeoverNotice: true,
      takeoverDescription: '当前 PTY 由电脑端控制尺寸。重新接管后才能发送输入、快捷键或图片。',
      takeoverTitle: '电脑正在接管终端',
      terminalHiddenByOtherOwner: true,
    })
  })

  test('keeps the terminal visible when this viewer owns the current terminal size', () => {
    expect(
      getTerminalOwnershipPresentation({
        ownership: {
          mode: 'takeover',
          ownedByThisClient: true,
          ownerClientId: 'phone-client',
        },
        viewerMode: 'takeover',
      })
    ).toEqual(
      expect.objectContaining({
        showTakeoverNotice: false,
        terminalHiddenByOtherOwner: false,
      })
    )
  })
})
