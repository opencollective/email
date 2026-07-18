/* collective.email service worker: precache the shell, then network-first for
 * pages (so content is always fresh) with cache fallback for offline use. */
const VERSION = 'v14'
const STATIC_CACHE = `static-${VERSION}`
const PAGE_CACHE = `pages-${VERSION}`
const PRECACHE = [
  '/static/style.css?v=14',
  '/static/icon-192.png',
  '/static/icon-512.png',
  '/manifest.webmanifest',
  '/offline',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return
  if (url.pathname.startsWith('/webhooks') || url.pathname.startsWith('/cron')) return

  // static assets: cache-first
  if (url.pathname.startsWith('/static/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone()
        caches.open(STATIC_CACHE).then((c) => c.put(req, copy))
        return res
      })),
    )
    return
  }

  // pages: network-first, fall back to the last cached copy, then /offline
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && req.mode === 'navigate') {
          const copy = res.clone()
          caches.open(PAGE_CACHE).then((c) => c.put(req, copy))
        }
        return res
      })
      .catch(async () => (await caches.match(req)) || (await caches.match('/offline'))),
  )
})
