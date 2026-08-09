import { describe, expect, test } from 'vitest'

import {
  MAX_EXCHANGE_FILE_BYTES,
  MAX_IMAGE_FILE_BYTES,
  removeMobileFileItem,
  upsertMobileFileItem,
  validateMobileExchangeFile,
  validateMobileImageReferenceFile,
  validateWorkspaceFileExchangePath,
} from '../../web/src/mobile/mobile-file-transfer.js'

describe('mobile file transfer state helpers', () => {
  test('validates mobile exchange file names and size limits', () => {
    expect(validateMobileExchangeFile({ name: 'notes.md', size: MAX_EXCHANGE_FILE_BYTES })).toEqual(
      { ok: true }
    )
    expect(
      validateMobileExchangeFile({ name: 'clip.mp4', size: MAX_EXCHANGE_FILE_BYTES + 1 })
    ).toEqual({
      message: '文件超过 100MB 限制',
      ok: false,
    })
    expect(
      validateMobileExchangeFile({ name: 'shot.png', size: MAX_IMAGE_FILE_BYTES + 1 })
    ).toEqual({
      message: '图片超过 10MB 限制',
      ok: false,
    })
    expect(validateMobileExchangeFile({ name: 'script.exe', size: 1 })).toEqual({
      message: '仅支持 .md、.mp4、.pdf、.zip、.log、.png、.jpg、.jpeg、.webp 文件',
      ok: false,
    })
  })

  test('validates terminal image reference files independently from exchange files', () => {
    expect(
      validateMobileImageReferenceFile({ name: 'photo.webp', size: MAX_IMAGE_FILE_BYTES })
    ).toEqual({
      ok: true,
    })
    expect(validateMobileImageReferenceFile({ name: 'notes.md', size: 1 })).toEqual({
      message: '请选择 png、jpg、jpeg 或 webp 图片',
      ok: false,
    })
  })

  test('validates workspace file paths without allowing absolute paths or traversal', () => {
    expect(validateWorkspaceFileExchangePath('dist/video.mp4')).toEqual({ ok: true })
    expect(validateWorkspaceFileExchangePath('')).toEqual({
      message: '请输入工作区内的相对路径',
      ok: false,
    })
    expect(validateWorkspaceFileExchangePath('../secret.md')).toEqual({
      message: '只能填写工作区内的相对路径',
      ok: false,
    })
    expect(validateWorkspaceFileExchangePath('C:\\Users\\dev\\secret.md')).toEqual({
      message: '只能填写工作区内的相对路径',
      ok: false,
    })
    expect(validateWorkspaceFileExchangePath('dist/app.exe')).toEqual({
      message: '仅支持 .md、.mp4、.pdf、.zip、.log、.png、.jpg、.jpeg、.webp 文件',
      ok: false,
    })
  })

  test('upserts and removes exchange items without duplicating existing files', () => {
    const first = { created_at: 1, id: 'file-1', mime_type: 'text/plain', name: 'old.log', size: 1 }
    const updated = {
      created_at: 2,
      id: 'file-1',
      mime_type: 'text/plain',
      name: 'new.log',
      size: 2,
    }
    const second = {
      created_at: 3,
      id: 'file-2',
      mime_type: 'text/markdown',
      name: 'notes.md',
      size: 3,
    }

    expect(upsertMobileFileItem([first, second], updated)).toEqual([second, updated])
    expect(removeMobileFileItem([first, second], 'file-1')).toEqual([second])
  })
})
