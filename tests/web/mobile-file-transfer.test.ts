import { describe, expect, test } from 'vitest'

import {
  getMobileFileExchangeActionPresentation,
  removeMobileFileItem,
  shouldSkipMobileFileExchangeAction,
  upsertMobileFileItem,
  validateMobileExchangeFile,
  validateMobileImageReferenceFile,
  validateWorkspaceFileExchangePath,
} from '../../web/src/mobile/mobile-file-transfer.js'

describe('mobile file transfer helpers', () => {
  test('describes file exchange action states for PWA and native app clients', () => {
    expect(getMobileFileExchangeActionPresentation('upload')).toEqual({
      busyLabel: '正在上传文件...',
      disabledMessage: '当前连接不可用，文件上传已暂停',
      pendingMessage: '正在上传文件...',
    })
    expect(getMobileFileExchangeActionPresentation('send_workspace_file')).toMatchObject({
      disabledMessage: '当前连接不可用，暂不能发送工作区文件',
    })
    expect(getMobileFileExchangeActionPresentation('review')).toMatchObject({
      busyLabel: '正在回传审核结果...',
    })
  })

  test('skips duplicate file exchange actions while one is busy', () => {
    expect(shouldSkipMobileFileExchangeAction({ busyLabel: null })).toBe(false)
    expect(shouldSkipMobileFileExchangeAction({ busyLabel: '正在下载文件...' })).toBe(true)
  })

  test('validates mobile upload and image reference files', () => {
    expect(validateMobileExchangeFile({ name: 'demo.mp4', size: 100 })).toEqual({ ok: true })
    expect(validateMobileExchangeFile({ name: 'script.exe', size: 100 })).toMatchObject({
      ok: false,
    })
    expect(validateMobileImageReferenceFile({ name: 'shot.png', size: 100 })).toEqual({ ok: true })
    expect(validateMobileImageReferenceFile({ name: 'notes.md', size: 100 })).toMatchObject({
      ok: false,
    })
  })

  test('validates workspace file paths before sending them to the phone', () => {
    expect(validateWorkspaceFileExchangePath('docs/notes.md')).toEqual({ ok: true })
    expect(validateWorkspaceFileExchangePath('../secret.md')).toMatchObject({ ok: false })
    expect(validateWorkspaceFileExchangePath('C:\\secret.md')).toMatchObject({ ok: false })
  })

  test('updates local exchange list state without duplicating file ids', () => {
    const first = {
      created_at: 1,
      id: 'file-1',
      mime_type: 'text/markdown',
      name: 'old.md',
      size: 1,
    }
    const updated = { ...first, name: 'new.md' }

    expect(upsertMobileFileItem([first], updated)).toEqual([updated])
    expect(removeMobileFileItem([updated], 'file-1')).toEqual([])
  })
})
