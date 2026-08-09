import type { FitAddon as XtermFitAddon } from '@xterm/addon-fit'
import type { Terminal as XtermTerminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import { type MobileTerminalAttachment, sendMobileTerminalInput, uploadMobileFile } from '../api.js'
import { buildPendingImageArtifactPrompt } from '../image-attachment-prompt.js'
import { preloadTerminalAssets } from './preloadTerminalAssets.js'
import { resolveTerminalShortcut } from './shortcuts.js'
import { createTerminalClient, type TerminalOwnershipState } from './terminal-client.js'
import {
  attachAlternateScreenWheelFallback,
  createAlternateScreenWheelInputResolver,
  type TerminalWheelInputProfile,
  type TerminalWheelInputResolver,
} from './wheelFallback.js'

const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const IMAGE_FILE_PATTERN = /\.(jpeg|jpg|png|webp)$/iu
export type TerminalScrollFrameRatePreference = 'auto' | '60' | '90' | '120'

const TOUCH_SCROLL_INERTIA_BASE_FRAME_MS = 16
const TOUCH_SCROLL_INERTIA_MAX_MS = 600
const TOUCH_SCROLL_INERTIA_DECAY = 0.94
const TOUCH_SCROLL_INERTIA_MIN_VELOCITY = 0.08
const TOUCH_SCROLL_INERTIA_START_THRESHOLD = 0.3
const TOUCH_SCROLL_INERTIA_MAX_LINES_PER_TICK = 5
const TOUCH_SCROLL_INERTIA_MIN_SAMPLE_MS = 8
const TOUCH_SCROLL_INERTIA_MAX_SAMPLE_MS = 80
const TOUCH_SCROLL_INERTIA_FALLBACK_SAMPLE_MS = 16
const TOUCH_SCROLL_INERTIA_VELOCITY_BLEND = 0.6

const getTerminalScrollFrameRateMinimumInterval = (
  preference: TerminalScrollFrameRatePreference | undefined
): number => {
  if (!preference || preference === 'auto') return 0
  return 1000 / Number(preference)
}

const getAnimationFrameTime = (): number => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

const wrapTerminalPaste = (text: string): string =>
  `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`

const clampTouchScrollInertiaVelocity = (velocity: number): number =>
  Math.max(
    -TOUCH_SCROLL_INERTIA_MAX_LINES_PER_TICK,
    Math.min(TOUCH_SCROLL_INERTIA_MAX_LINES_PER_TICK, velocity)
  )

const blendTouchScrollInertiaVelocity = (previous: number, next: number): number => {
  if (previous === 0 || Math.sign(previous) !== Math.sign(next)) return next
  return (
    previous * TOUCH_SCROLL_INERTIA_VELOCITY_BLEND +
    next * (1 - TOUCH_SCROLL_INERTIA_VELOCITY_BLEND)
  )
}

const getImageFileFromPaste = (event: ClipboardEvent): File | null => {
  const files = Array.from(event.clipboardData?.files ?? [])
  return (
    files.find((file) => file.type.startsWith('image/') || IMAGE_FILE_PATTERN.test(file.name)) ??
    null
  )
}

const isPasteShortcut = (event: KeyboardEvent): boolean =>
  event.type === 'keydown' &&
  event.key.toLowerCase() === 'v' &&
  !event.altKey &&
  !event.shiftKey &&
  (event.ctrlKey || event.metaKey)

const shouldUseMobileTextareaInputWorkaround = (): boolean => {
  if (typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/iu.test(navigator.userAgent)) {
    return true
  }
  return (
    typeof window !== 'undefined' &&
    Boolean(window.visualViewport) &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  )
}

const getMobileBeforeInputChunk = (event: InputEvent): string | null => {
  if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
    return event.data ? null : '\r'
  }
  if (event.inputType === 'deleteContentBackward') return '\x7f'
  if (event.inputType === 'deleteContentForward') return '\x1b[3~'
  return null
}

const configureMobileInputElement = (textarea: HTMLTextAreaElement) => {
  textarea.autocapitalize = 'off'
  textarea.autocomplete = 'off'
  textarea.spellcheck = false
  textarea.inputMode = 'text'
  textarea.setAttribute('autocapitalize', 'off')
  textarea.setAttribute('autocomplete', 'off')
  textarea.setAttribute('autocorrect', 'off')
  textarea.setAttribute('enterkeyhint', 'enter')
  textarea.setAttribute('spellcheck', 'false')
}

const normalizeMinimumTerminalSize = (
  size: { cols: number; rows: number } | undefined
): { cols: number; rows: number } | undefined => {
  if (!size) return undefined
  const cols = Math.floor(size.cols)
  const rows = Math.floor(size.rows)
  if (cols <= 0 || rows <= 0) return undefined
  return { cols, rows }
}

const clampTerminalSize = (
  size: { cols: number; rows: number },
  minimumSize: { cols: number; rows: number } | undefined
): { cols: number; rows: number } => {
  if (!minimumSize) return size
  return {
    cols: Math.max(minimumSize.cols, size.cols),
    rows: Math.max(minimumSize.rows, size.rows),
  }
}

const readImageFileFromBrowserClipboard = async (): Promise<File | null> => {
  const read = navigator.clipboard?.read
  if (typeof read !== 'function') return null
  const items = await read.call(navigator.clipboard)
  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith('image/'))
    if (!imageType) continue
    const blob = await item.getType(imageType)
    const extension = imageType.split('/')[1] || 'png'
    return new File([blob], `clipboard-image.${extension}`, { type: imageType })
  }
  return null
}

const serializeTerminalConnectionParams = (
  params: Record<string, number | string | undefined> | undefined
): string => {
  if (!params) return ''
  return JSON.stringify(
    Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
  )
}

const useStableTerminalConnectionParams = (
  params: Record<string, number | string | undefined> | undefined
) => {
  const key = serializeTerminalConnectionParams(params)
  const stableRef = useRef<{
    key: string
    params: Record<string, number | string | undefined> | undefined
  }>({ key, params })
  if (stableRef.current.key !== key) {
    stableRef.current = { key, params }
  }
  return stableRef.current.params
}

const normalizeBinaryTerminalInput = (
  chunk: string,
  _inputProfile: TerminalWheelInputProfile
): { binary: boolean; chunk: string } => ({ binary: true, chunk })

export const useTerminalRun = (
  runId: string,
  inputProfile: TerminalWheelInputProfile = 'default',
  initialSizeOverride?: { cols: number; rows: number },
  options: {
    autoTakeover?: boolean | undefined
    connectionParams?: Record<string, number | string | undefined> | undefined
    fitToContainer?: boolean | undefined
    minimumSize?: { cols: number; rows: number } | undefined
    onError?: ((message: string) => void) | undefined
    onOwnershipChange?: ((state: TerminalOwnershipState) => void) | undefined
    propagateResize?: boolean | undefined
    scrollFrameRatePreference?: TerminalScrollFrameRatePreference | undefined
    touchScrollTarget?: HTMLElement | null | undefined
    viewerMode?: 'active' | 'passive' | 'takeover' | undefined
    workspaceId?: string | undefined
  } = {}
) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const clientRef = useRef<ReturnType<typeof createTerminalClient> | undefined>(undefined)
  const fitAddonRef = useRef<XtermFitAddon | undefined>(undefined)
  const onErrorRef = useRef(options.onError)
  const onOwnershipChangeRef = useRef(options.onOwnershipChange)
  const scrollFrameRatePreferenceRef = useRef(options.scrollFrameRatePreference)
  const terminalRef = useRef<XtermTerminal | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [ownership, setOwnership] = useState<TerminalOwnershipState>({
    mode: 'active',
    ownedByThisClient: false,
    ownerClientId: null,
  })
  const reconnectTimerRef = useRef<number | undefined>(undefined)
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const [status, setStatus] = useState<'connecting' | 'running' | 'stopped'>('connecting')
  const [syncStatus, setSyncStatus] = useState<'complete' | 'pending'>('pending')
  const initialCols = initialSizeOverride?.cols
  const initialRows = initialSizeOverride?.rows
  const minimumSize = normalizeMinimumTerminalSize(options.minimumSize)
  const minimumCols = minimumSize?.cols
  const minimumRows = minimumSize?.rows
  const stableConnectionParams = useStableTerminalConnectionParams(options.connectionParams)

  useEffect(() => {
    onErrorRef.current = options.onError
  }, [options.onError])

  useEffect(() => {
    onOwnershipChangeRef.current = options.onOwnershipChange
  }, [options.onOwnershipChange])

  useEffect(() => {
    scrollFrameRatePreferenceRef.current = options.scrollFrameRatePreference
  }, [options.scrollFrameRatePreference])

  useEffect(() => {
    if (!containerRef.current) return
    if (reconnectAttempt > 0) setError(null)
    const minimumTerminalSize =
      minimumCols !== undefined && minimumRows !== undefined
        ? { cols: minimumCols, rows: minimumRows }
        : undefined

    let disposed = false
    let onWindowResize: (() => void) | undefined
    let binaryInputSubscription: { dispose: () => void } | undefined
    let inputSubscription: { dispose: () => void } | undefined
    let client: ReturnType<typeof createTerminalClient> | undefined
    let terminal: XtermTerminal | undefined
    let fitAddon: XtermFitAddon | undefined
    let resizeObserver: ResizeObserver | undefined
    let resizeTimer: number | undefined
    let syncWatchdogTimer: number | undefined
    let touchScrollInertiaFrame: number | undefined
    let touchScrollInertiaFrameIsTimeout = false
    let wheelFallbackDispose: (() => void) | undefined
    let helperTextarea: HTMLTextAreaElement | null = null
    let inputProxyTextarea: HTMLTextAreaElement | null = null
    let onBeforeInput: ((event: Event) => void) | undefined
    let onProxyBeforeInput: ((event: Event) => void) | undefined
    let onProxyCompositionEnd: (() => void) | undefined
    let onProxyCompositionStart: (() => void) | undefined
    let onProxyInput: (() => void) | undefined
    let onCompositionStart: ((event: Event) => void) | undefined
    let onCompositionEnd: ((event: Event) => void) | undefined
    let onInput: ((event: Event) => void) | undefined
    let onPaste: ((event: ClipboardEvent) => void) | undefined
    let onClick: (() => void) | undefined
    let onTouchStart: ((event: TouchEvent) => void) | undefined
    let onTouchMove: ((event: TouchEvent) => void) | undefined
    let onTouchEnd: (() => void) | undefined
    let onTouchCancel: (() => void) | undefined
    const isComposingRef = { current: false }
    const isProxyComposingRef = { current: false }
    const compositionFallbackTimerRef: { current: number | undefined } = { current: undefined }

    void preloadTerminalAssets()
      .then(({ clipboardModule, fitModule, unicode11Module, xtermModule }) => {
        if (disposed || !containerRef.current) return

        // Read xterm background from CSS so it stays in sync if the palette
        // shifts. Falls back to bg-crust's literal value if computed style is
        // unavailable (jsdom). Without this, xterm's canvas sat at #0f0f11 and
        // the wrapping container at #1b1b1b, so unfilled rows showed a seam.
        const rootStyles =
          typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null
        const bgCrust = rootStyles?.getPropertyValue('--bg-crust').trim() || '#0e0e0e'
        const textPrimary = rootStyles?.getPropertyValue('--text-primary').trim() || '#ebebeb'
        const terminalOptions = {
          allowProposedApi: true,
          convertEol: false,
          fontFamily: "'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1,
          scrollback: 10_000,
          theme: {
            background: bgCrust,
            foreground: textPrimary,
          },
        }
        const configuredCols = initialCols ?? (options.fitToContainer === false ? 120 : undefined)
        const configuredRows = initialRows ?? (options.fitToContainer === false ? 40 : undefined)
        const initialTerminalSize =
          configuredCols && configuredRows
            ? clampTerminalSize({ cols: configuredCols, rows: configuredRows }, minimumTerminalSize)
            : undefined
        const nextTerminal = new xtermModule.Terminal({
          ...terminalOptions,
          ...(initialTerminalSize ? { cols: initialTerminalSize.cols } : {}),
          ...(initialTerminalSize ? { rows: initialTerminalSize.rows } : {}),
        })
        const nextFitAddon = new fitModule.FitAddon()
        nextTerminal.loadAddon(nextFitAddon)
        nextTerminal.loadAddon(new unicode11Module.Unicode11Addon())
        nextTerminal.unicode.activeVersion = '11'
        nextTerminal.loadAddon(new clipboardModule.ClipboardAddon())
        nextTerminal.open(containerRef.current)
        if (options.fitToContainer === false && !initialCols && !initialRows) {
          nextTerminal.resize(120, 40)
        }
        const fitTerminal = () => {
          nextFitAddon.fit()
          const nextSize = clampTerminalSize(
            { cols: nextTerminal.cols, rows: nextTerminal.rows },
            minimumTerminalSize
          )
          if (nextSize.cols !== nextTerminal.cols || nextSize.rows !== nextTerminal.rows) {
            nextTerminal.resize(nextSize.cols, nextSize.rows)
          }
        }
        if (options.fitToContainer !== false) fitTerminal()
        nextTerminal.scrollToBottom()
        terminal = nextTerminal
        terminalRef.current = nextTerminal
        fitAddon = nextFitAddon
        fitAddonRef.current = nextFitAddon
        wheelFallbackDispose = attachAlternateScreenWheelFallback({
          element: containerRef.current,
          profile: inputProfile,
          sendInput: (chunk) => client?.sendInput(chunk),
          terminal: nextTerminal,
        })

        void import('@xterm/addon-web-links')
          .then((webLinksModule) => {
            if (disposed || terminal !== nextTerminal) return
            nextTerminal.loadAddon(new webLinksModule.WebLinksAddon())
          })
          .catch(() => {
            // Keep the core terminal usable when optional addons fail to load.
          })

        // Mobile browsers need a textarea workaround for CJK commits and
        // editing keys. Desktop IMEs should stay on xterm's native
        // CompositionHelper path; guessing composition state here can leak
        // preedit pinyin into the PTY when a composition lasts longer than
        // the mobile stuck-state fallback.
        helperTextarea =
          containerRef.current.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
        if (helperTextarea) {
          const localTextarea = helperTextarea
          const useMobileTextareaInputWorkaround = shouldUseMobileTextareaInputWorkaround()
          if (useMobileTextareaInputWorkaround) {
            configureMobileInputElement(localTextarea)
            onBeforeInput = (event: Event) => {
              if (isComposingRef.current) return
              const inputEvent = event as InputEvent
              const chunk = getMobileBeforeInputChunk(inputEvent)
              if (chunk !== null) {
                event.preventDefault()
                event.stopPropagation()
                if (chunk) client?.sendInput(chunk)
                localTextarea.value = ''
                return
              }
              if (inputEvent.data) {
                event.preventDefault()
                event.stopPropagation()
                client?.sendInput(inputEvent.data)
                localTextarea.value = ''
              }
            }
            onInput = (event: Event) => {
              if (isComposingRef.current) {
                event.preventDefault()
                event.stopPropagation()
                return
              }
              window.setTimeout(() => {
                if (!isComposingRef.current) localTextarea.value = ''
              }, 0)
            }
            onCompositionStart = () => {
              isComposingRef.current = true
              if (compositionFallbackTimerRef.current !== undefined) {
                window.clearTimeout(compositionFallbackTimerRef.current)
              }
              compositionFallbackTimerRef.current = window.setTimeout(() => {
                isComposingRef.current = false
                compositionFallbackTimerRef.current = undefined
              }, 1500)
            }
            onCompositionEnd = () => {
              if (compositionFallbackTimerRef.current !== undefined) {
                window.clearTimeout(compositionFallbackTimerRef.current)
                compositionFallbackTimerRef.current = undefined
              }
              // Let xterm's CompositionHelper read the final textarea diff first.
              // Clearing synchronously here can eat Android English composition
              // commits before xterm's own setTimeout(0) handler sees them.
              window.setTimeout(() => {
                isComposingRef.current = false
              }, 0)
              window.setTimeout(() => {
                if (!isComposingRef.current) localTextarea.value = ''
              }, 30)
            }
            helperTextarea.addEventListener('beforeinput', onBeforeInput, { capture: true })
            helperTextarea.addEventListener('input', onInput, { capture: true })
            helperTextarea.addEventListener('compositionstart', onCompositionStart, {
              capture: true,
            })
            helperTextarea.addEventListener('compositionend', onCompositionEnd, { capture: true })
          }
        }

        const useMobileInputProxy = shouldUseMobileTextareaInputWorkaround()
        if (useMobileInputProxy && containerRef.current) {
          inputProxyTextarea = document.createElement('textarea')
          inputProxyTextarea.className = 'terminal-mobile-input-proxy'
          inputProxyTextarea.dataset.testid = `terminal-mobile-input-proxy-${runId}`
          inputProxyTextarea.setAttribute('aria-label', 'Mobile terminal input')
          configureMobileInputElement(inputProxyTextarea)
          const proxyStyles: Record<string, string> = {
            background: 'transparent',
            border: '0',
            'caret-color': 'transparent',
            color: 'transparent',
            display: 'block',
            height: '2px',
            left: '0',
            margin: '0',
            'max-height': '2px',
            'max-width': '2px',
            'min-height': '2px',
            'min-width': '2px',
            opacity: '0.01',
            outline: '0',
            overflow: 'hidden',
            padding: '0',
            position: 'absolute',
            resize: 'none',
            top: '0',
            'white-space': 'nowrap',
            width: '2px',
            'z-index': '5',
          }
          for (const [name, value] of Object.entries(proxyStyles)) {
            inputProxyTextarea.style.setProperty(name, value, 'important')
          }

          const clearProxyTextarea = () => {
            if (!inputProxyTextarea) return
            inputProxyTextarea.value = ''
          }
          const sendProxyText = (text: string) => {
            if (!text) return
            client?.sendInput(text)
            clearProxyTextarea()
          }

          onProxyBeforeInput = (event: Event) => {
            const inputEvent = event as InputEvent
            if (isProxyComposingRef.current) return
            const chunk = getMobileBeforeInputChunk(inputEvent)
            if (chunk !== null) {
              event.preventDefault()
              event.stopPropagation()
              if (chunk) client?.sendInput(chunk)
              clearProxyTextarea()
              return
            }
            if (inputEvent.data) {
              event.preventDefault()
              event.stopPropagation()
              sendProxyText(inputEvent.data)
              return
            }
            if (
              inputEvent.inputType === 'insertText' ||
              inputEvent.inputType === 'insertReplacementText'
            ) {
              const text = inputEvent.data ?? ''
              if (!text) return
              event.preventDefault()
              event.stopPropagation()
              sendProxyText(text)
            }
          }
          onProxyInput = () => {
            if (isProxyComposingRef.current || !inputProxyTextarea?.value) return
            sendProxyText(inputProxyTextarea.value)
          }
          onProxyCompositionStart = () => {
            isProxyComposingRef.current = true
          }
          onProxyCompositionEnd = () => {
            window.setTimeout(() => {
              isProxyComposingRef.current = false
              if (inputProxyTextarea?.value) sendProxyText(inputProxyTextarea.value)
            }, 0)
          }

          inputProxyTextarea.addEventListener('beforeinput', onProxyBeforeInput, { capture: true })
          inputProxyTextarea.addEventListener('input', onProxyInput)
          inputProxyTextarea.addEventListener('compositionstart', onProxyCompositionStart, {
            capture: true,
          })
          inputProxyTextarea.addEventListener('compositionend', onProxyCompositionEnd, {
            capture: true,
          })
          containerRef.current.appendChild(inputProxyTextarea)
        }

        const focusTerminalInput = () => {
          if (disposed) return
          nextTerminal.focus()
          if (inputProxyTextarea) {
            const focusProxy = () => {
              if (disposed || !inputProxyTextarea) return
              inputProxyTextarea.focus({ preventScroll: true })
            }
            focusProxy()
            window.requestAnimationFrame(focusProxy)
            window.setTimeout(focusProxy, 80)
            return
          }
          helperTextarea?.focus({ preventScroll: true })
        }

        const sendImageFile = (imageFile: File) =>
          uploadMobileFile(options.workspaceId as string, imageFile)
            .then((item) => {
              const placeholder = '[Image #1]'
              const attachments: MobileTerminalAttachment[] = [{ file_id: item.id, placeholder }]
              return sendMobileTerminalInput(
                options.workspaceId as string,
                runId,
                wrapTerminalPaste(buildPendingImageArtifactPrompt('Desktop', item.name)),
                attachments
              )
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : 'Failed to upload image'
              setError(message)
              onErrorRef.current?.(message)
            })

        onPaste = (event: ClipboardEvent) => {
          const imageFile = getImageFileFromPaste(event)
          if (!imageFile || !options.workspaceId) return
          event.preventDefault()
          event.stopPropagation()
          void sendImageFile(imageFile)
        }
        containerRef.current.addEventListener('paste', onPaste, { capture: true })

        if (typeof nextTerminal.attachCustomKeyEventHandler === 'function') {
          nextTerminal.attachCustomKeyEventHandler((event) => {
            if (isPasteShortcut(event) && options.workspaceId) {
              event.preventDefault()
              void readImageFileFromBrowserClipboard()
                .then((imageFile) => {
                  if (imageFile) return sendImageFile(imageFile)
                  client?.sendInput('\x16')
                })
                .catch(() => {
                  client?.sendInput('\x16')
                })
              return false
            }
            const action = resolveTerminalShortcut(event)
            switch (action.kind) {
              case 'send':
                event.preventDefault()
                client?.sendInput(action.bytes)
                return false
              case 'clear':
                event.preventDefault()
                nextTerminal.clear()
                return false
              case 'block':
                // Intentionally NOT calling preventDefault here. Shift+Enter
                // depends on keydown 鈫?keypress chaining; if we preventDefault
                // on keydown the browser cancels the corresponding keypress and
                // the 'send' branch never gets to emit \x1b[13;2u.
                return false
              case 'passthrough':
                return true
            }
          })
        }

        let lastTouchY: number | null = null
        let lastTouchTime: number | null = null
        let touchMoved = false
        let touchRemainder = 0
        let touchScrollInertiaElapsed = 0
        let touchScrollInertiaLastFrameTime: number | null = null
        let touchScrollInertiaRemainder = 0
        let touchScrollInertiaVelocity = 0
        const touchScrollInertiaMinimumFrameMs = () =>
          getTerminalScrollFrameRateMinimumInterval(scrollFrameRatePreferenceRef.current)
        const resolveTouchWheelInput: TerminalWheelInputResolver =
          createAlternateScreenWheelInputResolver(nextTerminal, inputProfile)
        const scrollLineHeight = () => {
          const terminalElement =
            containerRef.current?.querySelector<HTMLElement>('.xterm-rows div')
          const measured = terminalElement ? terminalElement.getBoundingClientRect().height : 0
          return measured > 0 ? measured : 18
        }
        const cancelTouchScrollInertia = () => {
          if (touchScrollInertiaFrame !== undefined) {
            if (
              touchScrollInertiaFrameIsTimeout ||
              typeof window.cancelAnimationFrame !== 'function'
            ) {
              window.clearTimeout(touchScrollInertiaFrame)
            } else {
              window.cancelAnimationFrame(touchScrollInertiaFrame)
            }
            touchScrollInertiaFrame = undefined
            touchScrollInertiaFrameIsTimeout = false
          }
          touchScrollInertiaElapsed = 0
          touchScrollInertiaLastFrameTime = null
          touchScrollInertiaRemainder = 0
          touchScrollInertiaVelocity = 0
        }
        const scheduleTouchScrollInertia = () => {
          if (touchScrollInertiaFrame !== undefined) {
            if (
              touchScrollInertiaFrameIsTimeout ||
              typeof window.cancelAnimationFrame !== 'function'
            ) {
              window.clearTimeout(touchScrollInertiaFrame)
            } else {
              window.cancelAnimationFrame(touchScrollInertiaFrame)
            }
          }
          const step = (frameTime: number) => {
            touchScrollInertiaFrame = undefined
            touchScrollInertiaFrameIsTimeout = false
            if (nextTerminal.buffer.active.type !== 'normal') {
              cancelTouchScrollInertia()
              return
            }
            const previousFrameTime = touchScrollInertiaLastFrameTime
            const rawElapsedMs =
              previousFrameTime === null || frameTime <= previousFrameTime
                ? TOUCH_SCROLL_INERTIA_BASE_FRAME_MS
                : frameTime - previousFrameTime
            if (
              previousFrameTime !== null &&
              touchScrollInertiaMinimumFrameMs() > 0 &&
              rawElapsedMs < touchScrollInertiaMinimumFrameMs()
            ) {
              scheduleTouchScrollInertia()
              return
            }
            touchScrollInertiaLastFrameTime = frameTime
            const elapsedMs = Math.min(TOUCH_SCROLL_INERTIA_MAX_MS, rawElapsedMs)
            const frameScale = elapsedMs / TOUCH_SCROLL_INERTIA_BASE_FRAME_MS
            touchScrollInertiaElapsed += elapsedMs
            touchScrollInertiaVelocity *= TOUCH_SCROLL_INERTIA_DECAY ** frameScale
            const nextVelocity = clampTouchScrollInertiaVelocity(touchScrollInertiaVelocity)
            touchScrollInertiaRemainder += nextVelocity * frameScale
            const lines = Math.trunc(touchScrollInertiaRemainder)
            if (lines !== 0) {
              touchScrollInertiaRemainder -= lines
              nextTerminal.scrollLines(lines)
            }
            if (
              touchScrollInertiaElapsed >= TOUCH_SCROLL_INERTIA_MAX_MS ||
              Math.abs(touchScrollInertiaVelocity) < TOUCH_SCROLL_INERTIA_MIN_VELOCITY
            ) {
              cancelTouchScrollInertia()
              return
            }
            scheduleTouchScrollInertia()
          }
          if (typeof window.requestAnimationFrame === 'function') {
            touchScrollInertiaFrame = window.requestAnimationFrame(step)
            touchScrollInertiaFrameIsTimeout = false
            return
          }
          touchScrollInertiaFrame = window.setTimeout(
            () => step(getAnimationFrameTime()),
            TOUCH_SCROLL_INERTIA_BASE_FRAME_MS
          )
          touchScrollInertiaFrameIsTimeout = true
        }
        const startTouchScrollInertia = () => {
          if (nextTerminal.buffer.active.type !== 'normal') return
          if (Math.abs(touchScrollInertiaVelocity) < TOUCH_SCROLL_INERTIA_START_THRESHOLD) return
          touchScrollInertiaElapsed = 0
          touchScrollInertiaLastFrameTime =
            touchScrollInertiaMinimumFrameMs() > 0 ? getAnimationFrameTime() : null
          touchScrollInertiaRemainder = 0
          scheduleTouchScrollInertia()
        }
        onTouchStart = (event: TouchEvent) => {
          cancelTouchScrollInertia()
          lastTouchY = event.touches[0]?.clientY ?? null
          lastTouchTime = event.timeStamp
          touchMoved = false
          touchRemainder = 0
        }
        onTouchMove = (event: TouchEvent) => {
          if (lastTouchY === null) return
          const nextY = event.touches[0]?.clientY
          if (nextY === undefined) return
          const deltaY = nextY - lastTouchY
          lastTouchY = nextY
          const nextTouchTime = event.timeStamp
          const elapsedMs =
            lastTouchTime === null || nextTouchTime <= lastTouchTime
              ? TOUCH_SCROLL_INERTIA_FALLBACK_SAMPLE_MS
              : Math.max(
                  TOUCH_SCROLL_INERTIA_MIN_SAMPLE_MS,
                  Math.min(TOUCH_SCROLL_INERTIA_MAX_SAMPLE_MS, nextTouchTime - lastTouchTime)
                )
          lastTouchTime = nextTouchTime
          if (Math.abs(deltaY) < 1) return
          if (Math.abs(deltaY) > 8) touchMoved = true

          const wheelLikeDeltaY = -deltaY
          const touchWheelResult = resolveTouchWheelInput({
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            deltaY: wheelLikeDeltaY,
            shiftKey: false,
          })
          if (touchWheelResult.handled) {
            touchScrollInertiaVelocity = 0
            event.preventDefault()
            event.stopPropagation()
            if (touchWheelResult.input) client?.sendInput(touchWheelResult.input)
            return
          }

          if (nextTerminal.buffer.active.type !== 'normal') {
            touchScrollInertiaVelocity = 0
            return
          }

          const lineHeight = scrollLineHeight()
          touchRemainder += deltaY
          const instantVelocity = clampTouchScrollInertiaVelocity(
            (-deltaY / lineHeight) * (TOUCH_SCROLL_INERTIA_BASE_FRAME_MS / elapsedMs)
          )
          touchScrollInertiaVelocity = blendTouchScrollInertiaVelocity(
            touchScrollInertiaVelocity,
            instantVelocity
          )
          const lines = Math.trunc(touchRemainder / lineHeight)
          if (lines === 0) return

          touchRemainder -= lines * lineHeight
          nextTerminal.scrollLines(-lines)
        }
        onTouchEnd = () => {
          if (!touchMoved) focusTerminalInput()
          else startTouchScrollInertia()
          lastTouchY = null
          lastTouchTime = null
          touchMoved = false
          touchRemainder = 0
        }
        onTouchCancel = () => {
          cancelTouchScrollInertia()
          lastTouchY = null
          lastTouchTime = null
          touchMoved = false
          touchRemainder = 0
        }
        onClick = focusTerminalInput
        const touchTarget = options.touchScrollTarget ?? containerRef.current
        touchTarget?.addEventListener('click', onClick, { capture: true })
        touchTarget?.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
        touchTarget?.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
        touchTarget?.addEventListener('touchend', onTouchEnd, { capture: true, passive: true })
        touchTarget?.addEventListener('touchcancel', onTouchCancel, {
          capture: true,
          passive: true,
        })

        const isContainerResizable = (): boolean => {
          const container = containerRef.current
          if (!container?.isConnected) return false
          if (container.clientWidth <= 0 || container.clientHeight <= 0) return false
          return !container.closest('[data-terminal-host-parked="true"]')
        }
        const isScrolledNearBottom = () => {
          if (!terminal) return true
          const buffer = terminal.buffer.active
          const baseY = buffer.baseY
          const viewportY = buffer.viewportY
          if (!Number.isFinite(baseY) || !Number.isFinite(viewportY)) return true
          return baseY - viewportY <= 1
        }
        const scrollToBottomIfSticky = (sticky: boolean) => {
          if (sticky) terminal?.scrollToBottom()
        }
        const getContainerPixels = (): { pixelHeight?: number; pixelWidth?: number } => {
          if (!containerRef.current) return {}
          const pixelWidth = containerRef.current.clientWidth
          const pixelHeight = containerRef.current.clientHeight
          const pixels: { pixelHeight?: number; pixelWidth?: number } = {}
          if (pixelHeight > 0) pixels.pixelHeight = pixelHeight
          if (pixelWidth > 0) pixels.pixelWidth = pixelWidth
          return pixels
        }
        const resize = () => {
          if (!containerRef.current || !isContainerResizable()) return
          const sticky = isScrolledNearBottom()
          if (options.fitToContainer !== false) fitTerminal()
          scrollToBottomIfSticky(sticky)
          const { pixelHeight, pixelWidth } = getContainerPixels()
          client?.resize(terminal?.cols ?? 80, terminal?.rows ?? 24, pixelWidth, pixelHeight)
        }
        const resizeAfterLayoutSettles = () => {
          resize()
          if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => {
              if (!disposed) resize()
            })
          }
          window.setTimeout(() => {
            if (!disposed) resize()
          }, 120)
        }
        const scheduleResize = () => {
          if (resizeTimer) window.clearTimeout(resizeTimer)
          resizeTimer = window.setTimeout(() => {
            resizeTimer = undefined
            resize()
          }, 50)
        }

        client = createTerminalClient({
          connectionParams: stableConnectionParams,
          initialSize: {
            cols: initialCols ?? nextTerminal.cols,
            rows: initialRows ?? nextTerminal.rows,
            ...getContainerPixels(),
          },
          onError(message) {
            setError(message)
            onErrorRef.current?.(message)
          },
          onDisconnect() {
            if (disposed || reconnectTimerRef.current !== undefined) return
            setStatus('connecting')
            reconnectTimerRef.current = window.setTimeout(() => {
              reconnectTimerRef.current = undefined
              if (!disposed) setReconnectAttempt((attempt) => attempt + 1)
            }, 250)
          },
          onExit() {
            setStatus('stopped')
          },
          onOwnershipChange(state) {
            setOwnership(state)
            onOwnershipChangeRef.current?.(state)
          },
          onRestoreProgress(nextSyncStatus) {
            setSyncStatus(nextSyncStatus)
            if (syncWatchdogTimer !== undefined) {
              window.clearTimeout(syncWatchdogTimer)
              syncWatchdogTimer = undefined
            }
            if (nextSyncStatus === 'pending') {
              syncWatchdogTimer = window.setTimeout(() => {
                syncWatchdogTimer = undefined
                if (!disposed) setReconnectAttempt((attempt) => attempt + 1)
              }, 2500)
            }
          },
          onTakeoverDenied(reason) {
            const message = `终端接管失败：${reason}`
            setError(message)
            onErrorRef.current?.(message)
          },
          onTakeoverGranted() {
            setError(null)
            resizeAfterLayoutSettles()
          },
          onOutput(chunk, acknowledge) {
            const sticky = isScrolledNearBottom()
            nextTerminal.write(chunk, () => {
              scrollToBottomIfSticky(sticky)
              acknowledge(new TextEncoder().encode(chunk).byteLength)
            })
          },
          onRestore(snapshot, meta, complete) {
            const size = meta.size
            const nextSize = size ? clampTerminalSize(size, minimumTerminalSize) : undefined
            if (
              nextSize &&
              (nextTerminal.cols !== nextSize.cols || nextTerminal.rows !== nextSize.rows)
            ) {
              nextTerminal.resize(nextSize.cols, nextSize.rows)
            }
            nextTerminal.reset()
            if (snapshot.length === 0) {
              nextTerminal.scrollToBottom()
              complete()
              resizeAfterLayoutSettles()
              return
            }
            nextTerminal.write(snapshot, () => {
              nextTerminal.scrollToBottom()
              complete()
              resizeAfterLayoutSettles()
            })
          },
          propagateResize: options.propagateResize,
          runId,
          viewerMode: options.viewerMode,
        })
        clientRef.current = client
        inputSubscription = nextTerminal.onData((chunk) => {
          if (isComposingRef.current) return
          client?.sendInput(chunk)
        })
        if (typeof nextTerminal.onBinary === 'function') {
          binaryInputSubscription = nextTerminal.onBinary((chunk) => {
            const normalized = normalizeBinaryTerminalInput(chunk, inputProfile)
            if (normalized.binary) client?.sendBinaryInput(normalized.chunk)
            else client?.sendInput(normalized.chunk)
          })
        }
        setStatus('running')
        setSyncStatus('pending')
        resizeAfterLayoutSettles()
        if (options.autoTakeover) {
          client.requestTakeover(nextTerminal.cols, nextTerminal.rows, { restoreOnRelease: true })
        }
        if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
          resizeObserver = new ResizeObserver(scheduleResize)
          resizeObserver.observe(containerRef.current)
        }
        onWindowResize = () => resize()
        window.addEventListener('resize', onWindowResize)
      })
      .catch((loadError: unknown) => {
        if (disposed) return
        const message =
          loadError instanceof Error ? loadError.message : 'Failed to load terminal assets'
        setError(message)
        setStatus('stopped')
        onErrorRef.current?.(message)
      })

    return () => {
      disposed = true
      if (reconnectTimerRef.current !== undefined) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = undefined
      }
      if (onWindowResize) window.removeEventListener('resize', onWindowResize)
      resizeObserver?.disconnect()
      if (resizeTimer) window.clearTimeout(resizeTimer)
      if (syncWatchdogTimer !== undefined) window.clearTimeout(syncWatchdogTimer)
      if (touchScrollInertiaFrame !== undefined) {
        if (touchScrollInertiaFrameIsTimeout || typeof window.cancelAnimationFrame !== 'function') {
          window.clearTimeout(touchScrollInertiaFrame)
        } else {
          window.cancelAnimationFrame(touchScrollInertiaFrame)
        }
      }
      wheelFallbackDispose?.()
      if (compositionFallbackTimerRef.current !== undefined) {
        window.clearTimeout(compositionFallbackTimerRef.current)
      }
      if (helperTextarea && onBeforeInput) {
        helperTextarea.removeEventListener('beforeinput', onBeforeInput, {
          capture: true,
        } as EventListenerOptions)
      }
      if (helperTextarea && onInput) {
        helperTextarea.removeEventListener('input', onInput, { capture: true })
      }
      if (helperTextarea && onCompositionStart) {
        helperTextarea.removeEventListener('compositionstart', onCompositionStart, {
          capture: true,
        } as EventListenerOptions)
      }
      if (helperTextarea && onCompositionEnd) {
        helperTextarea.removeEventListener('compositionend', onCompositionEnd, {
          capture: true,
        } as EventListenerOptions)
      }
      if (inputProxyTextarea && onProxyBeforeInput) {
        inputProxyTextarea.removeEventListener('beforeinput', onProxyBeforeInput, {
          capture: true,
        } as EventListenerOptions)
      }
      if (inputProxyTextarea && onProxyInput) {
        inputProxyTextarea.removeEventListener('input', onProxyInput)
      }
      if (inputProxyTextarea && onProxyCompositionStart) {
        inputProxyTextarea.removeEventListener('compositionstart', onProxyCompositionStart, {
          capture: true,
        } as EventListenerOptions)
      }
      if (inputProxyTextarea && onProxyCompositionEnd) {
        inputProxyTextarea.removeEventListener('compositionend', onProxyCompositionEnd, {
          capture: true,
        } as EventListenerOptions)
      }
      inputProxyTextarea?.remove()
      if (containerRef.current && onPaste) {
        containerRef.current.removeEventListener('paste', onPaste, { capture: true })
      }
      const touchTarget = options.touchScrollTarget ?? containerRef.current
      if (onClick) {
        touchTarget?.removeEventListener('click', onClick, { capture: true })
      }
      if (onTouchStart) {
        touchTarget?.removeEventListener('touchstart', onTouchStart, { capture: true })
      }
      if (onTouchMove) {
        touchTarget?.removeEventListener('touchmove', onTouchMove, { capture: true })
      }
      if (onTouchEnd) {
        touchTarget?.removeEventListener('touchend', onTouchEnd, { capture: true })
      }
      if (onTouchCancel) {
        touchTarget?.removeEventListener('touchcancel', onTouchCancel, { capture: true })
      }
      binaryInputSubscription?.dispose()
      inputSubscription?.dispose()
      client?.dispose()
      if (clientRef.current === client) clientRef.current = undefined
      if (fitAddonRef.current === fitAddon) fitAddonRef.current = undefined
      if (terminalRef.current === terminal) terminalRef.current = undefined
      terminal?.dispose()
      fitAddon?.dispose()
    }
  }, [
    runId,
    inputProfile,
    options.fitToContainer,
    options.autoTakeover,
    stableConnectionParams,
    initialCols,
    initialRows,
    minimumCols,
    minimumRows,
    options.propagateResize,
    options.touchScrollTarget,
    options.viewerMode,
    options.workspaceId,
    reconnectAttempt,
  ])

  const reclaimTakeover = () => {
    const terminal = terminalRef.current
    if (options.fitToContainer !== false) fitAddonRef.current?.fit()
    const cols = terminal?.cols ?? initialCols ?? 80
    const rows = terminal?.rows ?? initialRows ?? 24
    if (options.viewerMode === 'takeover') {
      clientRef.current?.requestTakeover(cols, rows, { restoreOnRelease: true })
      return
    }
    clientRef.current?.reclaimTakeover(cols, rows)
  }

  return { containerRef, error, ownership, reclaimTakeover, status, syncStatus }
}
