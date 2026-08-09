// Hive PWA service worker.
//
// The single occurrence of the build-time version placeholder lives in the
// VERSION constant directly below. `web/src/pwa/build-sw.ts` rewrites it at
// `vite build` time so each Hive release writes to its own cache bucket. Old
// caches are kept intentionally — a tab still controlled by a previous SW
// generation must be able to resolve its lazy-loaded hashed chunks, and
// storage growth is bounded by Hive's release cadence.

const VERSION = '__HIVE_VERSION__'
const SHELL_CACHE = `hive-cache-v${VERSION}-shell`
const ASSETS_CACHE = `hive-cache-v${VERSION}-assets`
const STATIC_CACHE = `hive-cache-v${VERSION}-static`

const SHELL_PRECACHE = ['/', '/mobile?relay=1']
const STATIC_PRECACHE = [
  '/logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon-180.png',
  '/icons/icon-32.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_PRECACHE)),
      caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_PRECACHE)),
      caches.open(ASSETS_CACHE),
    ])
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  const currentCaches = new Set([SHELL_CACHE, ASSETS_CACHE, STATIC_CACHE])
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('hive-cache-v') && !currentCaches.has(key))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

const isHashedAsset = (pathname) => pathname.startsWith('/assets/')
const isStaticAsset = (pathname) =>
  pathname.startsWith('/icons/') ||
  pathname.startsWith('/screenshots/') ||
  pathname.startsWith('/cli-icons/') ||
  pathname.startsWith('/sounds/') ||
  pathname === '/logo.png'
const isShell = (url) =>
  url.pathname === '/' ||
  url.pathname === '/index.html' ||
  (url.pathname === '/mobile' && url.searchParams.get('relay') === '1')
const shellCacheKey = (url) => {
  if (url.pathname === '/mobile' && url.searchParams.get('relay') === '1') return '/mobile?relay=1'
  return '/'
}

const cacheFirst = async (request, cacheName) => {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) cache.put(request, response.clone())
  return response
}

const networkFirst = async (request, cacheName) => {
  const cache = await caches.open(cacheName)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone())
    return response
  } catch (error) {
    const cached = await cache.match(request)
    if (cached) return cached
    throw error
  }
}

const networkFirstShell = async (request, url) => {
  const cache = await caches.open(SHELL_CACHE)
  const cacheKey = shellCacheKey(url)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(cacheKey, response.clone())
    return response
  } catch (error) {
    const cached = await cache.match(cacheKey)
    if (cached) return cached
    throw error
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  if (event.request.method !== 'GET') return
  if (url.pathname.startsWith('/api/')) return
  if (url.pathname.startsWith('/ws/')) return
  if (url.pathname === '/sw.js' || url.pathname === '/manifest.webmanifest') return
  if (isShell(url)) {
    event.respondWith(networkFirstShell(event.request, url))
    return
  }
  if (isHashedAsset(url.pathname)) {
    event.respondWith(cacheFirst(event.request, ASSETS_CACHE))
    return
  }
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(event.request, STATIC_CACHE))
    return
  }
  event.respondWith(networkFirst(event.request, SHELL_CACHE))
})
