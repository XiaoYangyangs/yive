let fallbackIdCounter = 0

export const createBrowserId = (prefix: string): string => {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID === 'function') return `${prefix}-${randomUUID.call(globalThis.crypto)}`

  fallbackIdCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`
}
