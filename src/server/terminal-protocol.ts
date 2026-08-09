type TerminalControlClientMessage =
  | { type: 'output_ack'; bytes: number }
  | { type: 'resize'; cols: number; rows: number; pixelWidth?: number; pixelHeight?: number }
  | { type: 'restore_request'; cols: number; requestId: string; rows: number; scrollback: number }
  | { type: 'restore_complete' }
  | { type: 'stop' }
  | { type: 'takeover_heartbeat' }
  | { type: 'takeover_reclaim'; cols: number; rows: number }
  | { type: 'takeover_release' }
  | { type: 'takeover_request'; cols: number; rows: number; restoreOnRelease: boolean }

type TerminalViewerMode = 'active' | 'passive' | 'takeover'

type TerminalSizeOwner = null | {
  acquiredAt: number
  clientId: string
  expiresAt?: number
  mode: 'desktop' | 'mobile_takeover'
  previousSize?: { cols: number; rows: number }
  restoreOnRelease: boolean
}

type TerminalControlServerMessage =
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number | null }
  | {
      type: 'restore'
      cols?: number
      outputBytes?: number
      requestId?: string
      restoredAt?: number
      rows?: number
      sizeOwner?: TerminalSizeOwner
      snapshot: string
    }
  | {
      type: 'size_owner_changed'
      cols?: number
      mode: TerminalViewerMode
      ownerClientId: string | null
      rows?: number
    }
  | {
      type: 'takeover_denied'
      reason: string
    }
  | {
      type: 'takeover_granted'
      cols: number
      previousSize?: { cols: number; rows: number }
      rows: number
    }

const asInteger = (value: unknown): number | undefined => {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

export const parseTerminalControlMessage = (raw: Buffer | string): TerminalControlClientMessage => {
  const parsed = JSON.parse(raw.toString()) as { [key: string]: unknown; type?: unknown }
  const {
    bytes,
    cols,
    restore_on_release: restoreOnRelease,
    request_id: requestId,
    rows,
    scrollback,
    pixelHeight,
    pixelWidth,
  } = parsed
  if (parsed.type === 'stop') return { type: 'stop' }
  if (parsed.type === 'restore_complete') return { type: 'restore_complete' }
  if (parsed.type === 'takeover_heartbeat') return { type: 'takeover_heartbeat' }
  if (parsed.type === 'takeover_release') return { type: 'takeover_release' }
  const ackBytes = asInteger(bytes)
  if (parsed.type === 'output_ack' && ackBytes !== undefined && ackBytes >= 0) {
    return { type: 'output_ack', bytes: ackBytes }
  }
  const resizeCols = asInteger(cols)
  const resizeRows = asInteger(rows)
  const restoreScrollback = asInteger(scrollback)
  if (
    parsed.type === 'restore_request' &&
    resizeCols !== undefined &&
    resizeRows !== undefined &&
    resizeCols > 0 &&
    resizeRows > 0 &&
    typeof requestId === 'string' &&
    requestId.trim() &&
    restoreScrollback !== undefined &&
    restoreScrollback >= 0 &&
    restoreScrollback <= 100
  ) {
    return {
      type: 'restore_request',
      cols: resizeCols,
      requestId: requestId.trim(),
      rows: resizeRows,
      scrollback: restoreScrollback,
    }
  }
  if (
    parsed.type === 'takeover_request' &&
    resizeCols !== undefined &&
    resizeRows !== undefined &&
    resizeCols > 0 &&
    resizeRows > 0
  ) {
    return {
      type: 'takeover_request',
      cols: resizeCols,
      restoreOnRelease: restoreOnRelease !== false,
      rows: resizeRows,
    }
  }
  if (
    parsed.type === 'takeover_reclaim' &&
    resizeCols !== undefined &&
    resizeRows !== undefined &&
    resizeCols > 0 &&
    resizeRows > 0
  ) {
    return {
      type: 'takeover_reclaim',
      cols: resizeCols,
      rows: resizeRows,
    }
  }
  if (
    parsed.type === 'resize' &&
    resizeCols !== undefined &&
    resizeRows !== undefined &&
    resizeCols > 0 &&
    resizeRows > 0
  ) {
    const message: TerminalControlClientMessage = {
      type: 'resize',
      cols: resizeCols,
      rows: resizeRows,
    }
    const parsedPixelWidth = asInteger(pixelWidth)
    const parsedPixelHeight = asInteger(pixelHeight)
    if (parsedPixelWidth !== undefined) message.pixelWidth = parsedPixelWidth
    if (parsedPixelHeight !== undefined) message.pixelHeight = parsedPixelHeight
    return message
  }

  throw new Error('Invalid terminal control message')
}

export const serializeTerminalError = (message: string): string => {
  return JSON.stringify({ type: 'error', message } satisfies TerminalControlServerMessage)
}

export const serializeTerminalExit = (code: number | null): string => {
  return JSON.stringify({ type: 'exit', code } satisfies TerminalControlServerMessage)
}

export const serializeTerminalRestore = (
  snapshot: string,
  size?: { cols: number; rows: number },
  sizeOwner?: TerminalSizeOwner,
  meta: { outputBytes?: number; requestId?: string; restoredAt?: number } = {}
): string => {
  return JSON.stringify({
    type: 'restore',
    snapshot,
    ...size,
    ...(meta.outputBytes !== undefined ? { outputBytes: meta.outputBytes } : {}),
    ...(meta.requestId ? { request_id: meta.requestId } : {}),
    ...(meta.restoredAt !== undefined ? { restoredAt: meta.restoredAt } : {}),
    ...(sizeOwner ? { sizeOwner } : {}),
  } satisfies TerminalControlServerMessage)
}

export const serializeTerminalTakeoverGranted = (
  cols: number,
  rows: number,
  previousSize?: { cols: number; rows: number }
): string => {
  return JSON.stringify({
    type: 'takeover_granted',
    cols,
    ...(previousSize ? { previousSize } : {}),
    rows,
  } satisfies TerminalControlServerMessage)
}

export const serializeTerminalTakeoverDenied = (reason: string): string => {
  return JSON.stringify({
    type: 'takeover_denied',
    reason,
  } satisfies TerminalControlServerMessage)
}

export const serializeTerminalSizeOwnerChanged = (
  mode: TerminalViewerMode,
  ownerClientId: string | null,
  size?: { cols: number; rows: number }
): string => {
  return JSON.stringify({
    type: 'size_owner_changed',
    mode,
    ownerClientId,
    ...size,
  } satisfies TerminalControlServerMessage)
}

export type {
  TerminalControlClientMessage,
  TerminalControlServerMessage,
  TerminalSizeOwner,
  TerminalViewerMode,
}
