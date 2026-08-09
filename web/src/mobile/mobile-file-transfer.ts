import type { MobileFileExchangeItem } from '../api.js'

export const MAX_EXCHANGE_FILE_BYTES = 100 * 1024 * 1024
export const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024
export const IMAGE_FILE_PATTERN = /\.(jpeg|jpg|png|webp)$/iu
export const EXCHANGE_FILE_PATTERN = /\.(jpeg|jpg|log|md|mp4|pdf|png|webp|zip)$/iu
export const EXCHANGE_FILE_LABEL = '.md、.mp4、.pdf、.zip、.log、.png、.jpg、.jpeg、.webp'

export type MobileFileValidationResult = { ok: true } | { message: string; ok: false }

export type MobileFileExchangeAction =
  | 'clear'
  | 'delete'
  | 'download'
  | 'review'
  | 'send_workspace_file'
  | 'upload'

export interface MobileFileExchangeActionPresentation {
  busyLabel: string
  disabledMessage: string
  pendingMessage: string
}

const FILE_EXCHANGE_ACTION_PRESENTATION: Record<
  MobileFileExchangeAction,
  MobileFileExchangeActionPresentation
> = {
  clear: {
    busyLabel: '正在清空文件...',
    disabledMessage: '当前连接不可用，暂不能清空文件',
    pendingMessage: '正在清空文件...',
  },
  delete: {
    busyLabel: '正在删除文件...',
    disabledMessage: '当前连接不可用，暂不能删除文件',
    pendingMessage: '正在删除文件...',
  },
  download: {
    busyLabel: '正在下载文件...',
    disabledMessage: '当前连接不可用，暂不能下载文件',
    pendingMessage: '正在下载文件...',
  },
  review: {
    busyLabel: '正在回传审核结果...',
    disabledMessage: '当前连接不可用，暂不能回传审核结果',
    pendingMessage: '正在回传审核结果...',
  },
  send_workspace_file: {
    busyLabel: '正在发送工作区文件...',
    disabledMessage: '当前连接不可用，暂不能发送工作区文件',
    pendingMessage: '正在发送工作区文件...',
  },
  upload: {
    busyLabel: '正在上传文件...',
    disabledMessage: '当前连接不可用，文件上传已暂停',
    pendingMessage: '正在上传文件...',
  },
}

export const getMobileFileExchangeActionPresentation = (
  action: MobileFileExchangeAction
): MobileFileExchangeActionPresentation => FILE_EXCHANGE_ACTION_PRESENTATION[action]

export const shouldSkipMobileFileExchangeAction = ({
  busyLabel,
}: {
  busyLabel: null | string
}): boolean => Boolean(busyLabel)

export const validateMobileExchangeFile = (
  file: Pick<File, 'name' | 'size'>
): MobileFileValidationResult => {
  if (!EXCHANGE_FILE_PATTERN.test(file.name)) {
    return { message: `仅支持 ${EXCHANGE_FILE_LABEL} 文件`, ok: false }
  }
  if (IMAGE_FILE_PATTERN.test(file.name) && file.size > MAX_IMAGE_FILE_BYTES) {
    return { message: '图片超过 10MB 限制', ok: false }
  }
  if (file.size > MAX_EXCHANGE_FILE_BYTES) {
    return { message: '文件超过 100MB 限制', ok: false }
  }
  return { ok: true }
}

export const validateMobileImageReferenceFile = (
  file: Pick<File, 'name' | 'size'>
): MobileFileValidationResult => {
  if (!IMAGE_FILE_PATTERN.test(file.name)) {
    return { message: '请选择 png、jpg、jpeg 或 webp 图片', ok: false }
  }
  if (file.size > MAX_IMAGE_FILE_BYTES) {
    return { message: '图片超过 10MB 限制', ok: false }
  }
  return { ok: true }
}

export const validateWorkspaceFileExchangePath = (path: string): MobileFileValidationResult => {
  const trimmed = path.trim()
  if (!trimmed) return { message: '请输入工作区内的相对路径', ok: false }
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/u.test(trimmed) || trimmed.split(/[\\/]+/u).includes('..')) {
    return { message: '只能填写工作区内的相对路径', ok: false }
  }
  if (!EXCHANGE_FILE_PATTERN.test(trimmed)) {
    return { message: `仅支持 ${EXCHANGE_FILE_LABEL} 文件`, ok: false }
  }
  return { ok: true }
}

export const upsertMobileFileItem = (
  items: MobileFileExchangeItem[],
  item: MobileFileExchangeItem
): MobileFileExchangeItem[] => [...items.filter((current) => current.id !== item.id), item]

export const removeMobileFileItem = (
  items: MobileFileExchangeItem[],
  fileId: string
): MobileFileExchangeItem[] => items.filter((item) => item.id !== fileId)
