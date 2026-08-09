import '@xterm/xterm/css/xterm.css'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TranslationKey } from '../i18n.js'
import { useI18n } from '../i18n.js'
import type { TerminalOwnershipState } from './terminal-client.js'
import { getTerminalOwnershipPresentation } from './terminal-ownership-presentation.js'
import { type TerminalScrollFrameRatePreference, useTerminalRun } from './useTerminalRun.js'
import type { TerminalWheelInputProfile } from './wheelFallback.js'

const STATUS_KEYS: Record<string, TranslationKey> = {
  connecting: 'terminal.statusConnecting',
  running: 'terminal.statusRunning',
  stopped: 'common.stopped',
}

interface TerminalViewProps {
  autoTakeover?: boolean | undefined
  connectionParams?: Record<string, number | string | undefined> | undefined
  fitToContainer?: boolean | undefined
  initialSize?:
    | {
        cols: number
        rows: number
      }
    | undefined
  minimumSize?:
    | {
        cols: number
        rows: number
      }
    | undefined
  inputProfile?: TerminalWheelInputProfile
  onError?: ((message: string) => void) | undefined
  onOwnershipChange?: ((state: TerminalOwnershipState) => void) | undefined
  onSyncStatusChange?: ((state: 'complete' | 'pending') => void) | undefined
  portalId?: string | undefined
  propagateResize?: boolean | undefined
  runId: string
  scrollFrameRatePreference?: TerminalScrollFrameRatePreference | undefined
  title: string
  touchScrollTarget?: HTMLElement | null | undefined
  viewerMode?: 'active' | 'passive' | 'takeover' | undefined
  workspaceId?: string | undefined
}

const TERMINAL_PARKING_LOT_ID = 'hive-terminal-parking-lot'
const PARKED_TERMINAL_DISPOSE_DELAY_MS = 500

const candidateIds = (runId: string, explicitPortalId?: string): string[] => [
  ...(explicitPortalId ? [explicitPortalId] : []),
  `worker-pty-${runId}`,
  `orch-pty-${runId}`,
  `shell-pty-${runId}`,
]

const getLastElementById = (id: string): HTMLElement | null => {
  const matches = Array.from(document.querySelectorAll<HTMLElement>('[id]')).filter(
    (node) => node.id === id
  )
  return matches[matches.length - 1] ?? null
}

const getTerminalParkingLot = (): HTMLElement => {
  let node = document.getElementById(TERMINAL_PARKING_LOT_ID)
  if (!node) {
    node = document.createElement('div')
    node.id = TERMINAL_PARKING_LOT_ID
    node.hidden = true
    node.style.display = 'none'
    const parent = document.body ?? document.documentElement
    parent.appendChild(node)
  }
  return node
}

const cleanupTerminalParkingLot = (): void => {
  const node = document.getElementById(TERMINAL_PARKING_LOT_ID)
  if (node && node.childElementCount === 0) node.remove()
}

const portalTargetSubscribers = new Set<() => void>()
let portalTargetObserver: MutationObserver | undefined
let portalTargetPollTimer: number | undefined

const notifyPortalTargetSubscribers = (): void => {
  for (const subscriber of portalTargetSubscribers) subscriber()
}

const stopPortalTargetWatcher = (): void => {
  portalTargetObserver?.disconnect()
  portalTargetObserver = undefined
  if (portalTargetPollTimer !== undefined) {
    window.clearInterval(portalTargetPollTimer)
    portalTargetPollTimer = undefined
  }
}

const ensurePortalTargetWatcher = (): void => {
  if (portalTargetObserver || portalTargetPollTimer !== undefined) return
  const root = document.body ?? document.documentElement
  if (typeof MutationObserver !== 'undefined' && root) {
    portalTargetObserver = new MutationObserver(notifyPortalTargetSubscribers)
    portalTargetObserver.observe(root, {
      attributeFilter: ['id'],
      attributes: true,
      childList: true,
      subtree: true,
    })
    return
  }
  portalTargetPollTimer = window.setInterval(notifyPortalTargetSubscribers, 100)
}

const subscribePortalTargetChanges = (subscriber: () => void): (() => void) => {
  portalTargetSubscribers.add(subscriber)
  ensurePortalTargetWatcher()
  return () => {
    portalTargetSubscribers.delete(subscriber)
    if (portalTargetSubscribers.size === 0) stopPortalTargetWatcher()
  }
}

const scheduleVisibleTerminalResize = (): void => {
  const dispatch = () => window.dispatchEvent(new Event('resize'))
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(dispatch)
    return
  }
  window.setTimeout(dispatch, 0)
}

const usePortalTarget = (runId: string, explicitPortalId?: string): HTMLElement | null => {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const ids = candidateIds(runId, explicitPortalId)
    const resolve = () => {
      for (const id of ids) {
        const node = getLastElementById(id)
        if (node) return node
      }
      return null
    }
    const refreshTarget = () => {
      const node = resolve()
      setTarget((current) => (current === node ? current : node))
    }
    refreshTarget()
    return subscribePortalTargetChanges(refreshTarget)
  }, [explicitPortalId, runId])
  return target
}

const useStablePortalHost = (runId: string, target: HTMLElement | null): HTMLElement | null => {
  const [activated, setActivated] = useState(false)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const disposeTimerRef = useRef<number | undefined>(undefined)
  const hostRef = useRef<HTMLElement | null>(null)

  const clearDisposeTimer = useCallback(() => {
    if (disposeTimerRef.current === undefined) return
    window.clearTimeout(disposeTimerRef.current)
    disposeTimerRef.current = undefined
  }, [])

  useLayoutEffect(() => {
    const node = document.createElement('div')
    node.dataset.terminalHostRunId = runId
    node.dataset.terminalHostParked = 'false'
    node.className = 'h-full min-h-0 w-full min-w-0'
    hostRef.current = node
    setHost(node)
    return () => {
      clearDisposeTimer()
      node.remove()
      hostRef.current = null
      cleanupTerminalParkingLot()
    }
  }, [clearDisposeTimer, runId])

  useLayoutEffect(() => {
    if (target) {
      clearDisposeTimer()
      setActivated(true)
      return
    }
    if (!activated || disposeTimerRef.current !== undefined) return

    disposeTimerRef.current = window.setTimeout(() => {
      disposeTimerRef.current = undefined
      setActivated(false)
    }, PARKED_TERMINAL_DISPOSE_DELAY_MS)
    return clearDisposeTimer
  }, [activated, clearDisposeTimer, target])

  useLayoutEffect(() => {
    const node = hostRef.current
    if (!node) return
    if (!activated) {
      node.remove()
      node.dataset.terminalHostParked = 'false'
      cleanupTerminalParkingLot()
      return
    }

    const parent = target ?? getTerminalParkingLot()
    if (node.parentElement === parent) return

    const hadParent = node.parentElement !== null
    const activeElement = document.activeElement
    if (!target && activeElement instanceof HTMLElement && node.contains(activeElement)) {
      activeElement.blur()
    }
    node.dataset.terminalHostParked = target ? 'false' : 'true'
    parent.appendChild(node)
    cleanupTerminalParkingLot()

    if (target && hadParent) scheduleVisibleTerminalResize()
  }, [activated, target])

  return activated ? host : null
}

export const TerminalView = ({
  autoTakeover,
  connectionParams,
  fitToContainer = true,
  initialSize,
  minimumSize,
  inputProfile = 'default',
  onError,
  onOwnershipChange,
  onSyncStatusChange,
  portalId,
  propagateResize = true,
  runId,
  scrollFrameRatePreference,
  title,
  touchScrollTarget,
  viewerMode,
  workspaceId,
}: TerminalViewProps) => {
  const portalTarget = usePortalTarget(runId, portalId)
  const host = useStablePortalHost(runId, portalTarget)

  if (!host) return null
  return createPortal(
    <TerminalPtyView
      fitToContainer={fitToContainer}
      connectionParams={connectionParams}
      initialSize={initialSize}
      minimumSize={minimumSize}
      inputProfile={inputProfile}
      autoTakeover={autoTakeover}
      onError={onError}
      onOwnershipChange={onOwnershipChange}
      onSyncStatusChange={onSyncStatusChange}
      propagateResize={propagateResize}
      runId={runId}
      scrollFrameRatePreference={scrollFrameRatePreference}
      title={title}
      touchScrollTarget={touchScrollTarget}
      viewerMode={viewerMode}
      workspaceId={workspaceId}
    />,
    host
  )
}

const TerminalPtyView = ({
  autoTakeover,
  connectionParams,
  fitToContainer,
  initialSize,
  minimumSize,
  inputProfile,
  onError,
  onOwnershipChange,
  onSyncStatusChange,
  propagateResize,
  runId,
  scrollFrameRatePreference,
  title: _title,
  touchScrollTarget,
  viewerMode,
  workspaceId,
}: TerminalViewProps) => {
  const { t } = useI18n()
  const { containerRef, error, ownership, reclaimTakeover, status, syncStatus } = useTerminalRun(
    runId,
    inputProfile,
    initialSize,
    {
      autoTakeover,
      connectionParams,
      fitToContainer,
      minimumSize,
      onError,
      onOwnershipChange,
      propagateResize,
      scrollFrameRatePreference,
      touchScrollTarget,
      viewerMode,
      workspaceId,
    }
  )
  useEffect(() => {
    onSyncStatusChange?.(syncStatus)
  }, [onSyncStatusChange, syncStatus])
  const statusKey = STATUS_KEYS[status]
  const ownershipPresentation = getTerminalOwnershipPresentation({ ownership, viewerMode })
  const hiddenByOtherOwner = ownershipPresentation.terminalHiddenByOtherOwner
  const showTakeoverNotice = ownershipPresentation.showTakeoverNotice
  const showConnectionStatus =
    (status === 'connecting' || (status === 'running' && syncStatus !== 'complete')) &&
    !hiddenByOtherOwner
  const connectionStatusLabel =
    status === 'running' && syncStatus !== 'complete'
      ? '正在同步最新终端...'
      : statusKey
        ? t(statusKey)
        : status
  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <p className="sr-only">{connectionStatusLabel}</p>
      {error ? (
        <p
          role="alert"
          className="mono shrink-0 break-words px-3 py-2 text-xs"
          style={{
            background: 'color-mix(in oklab, var(--status-red) 12%, transparent)',
            borderBottom: '1px solid color-mix(in oklab, var(--status-red) 30%, transparent)',
            color: 'var(--status-red)',
          }}
        >
          {error}
        </p>
      ) : null}
      {showConnectionStatus ? (
        <p
          aria-live="polite"
          className="absolute right-3 top-3 z-10 rounded-full border border-[var(--border-bright)] bg-[var(--bg-1)] px-3 py-1 text-xs font-semibold text-sec shadow-lg"
          data-testid={`terminal-connection-status-${runId}`}
        >
          {connectionStatusLabel}
        </p>
      ) : null}
      <div
        data-testid={`terminal-${runId}`}
        ref={containerRef}
        className="bg-crust h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden"
        style={hiddenByOtherOwner ? { visibility: 'hidden' } : undefined}
      />
      {showTakeoverNotice ? (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--bg-crust)] px-6"
          data-testid={`terminal-mobile-takeover-${runId}`}
        >
          <div className="flex max-w-sm flex-col items-center gap-4 text-center">
            <div className="space-y-2">
              <strong className="text-base text-pri">{ownershipPresentation.takeoverTitle}</strong>
              <p className="text-sm leading-6 text-ter">
                {ownershipPresentation.takeoverDescription}
              </p>
            </div>
            <button type="button" className="icon-btn icon-btn--primary" onClick={reclaimTakeover}>
              {ownershipPresentation.reclaimActionLabel}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
