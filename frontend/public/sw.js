// WeebSync service worker: makes the app installable, shows push
// notifications and answers a failed page load with an offline page.
//
// The only thing cached is that page and what it needs (OFFLINE_FILES). The
// app's code, /api/ and every authenticated response always come from the
// network, so a cached copy can never serve stale or another user's data.
// Raise CACHE when those files change; activate drops every other cache.
const CACHE = 'weebsync-offline-v1'
const OFFLINE = '/offline.html'
const OFFLINE_FILES = [OFFLINE, '/offline.js', '/favicon.svg']

// skipWaiting/claim are safe here: this worker never serves the app's code
// (it passes every request but a failed navigation through), so replacing it
// under an open tab changes nothing the tab runs; at most a later failed
// navigation shows the newer offline page.
self.addEventListener('install', (e) =>
  e.waitUntil(
    caches
      .open(CACHE)
      // 'reload': never take the offline files from the HTTP cache of a proxy
      .then((c) => c.addAll(OFFLINE_FILES.map((u) => new Request(u, { cache: 'reload' }))))
      // a failed precache must not cost the worker its push notifications
      .catch(() => {})
      .then(() => self.skipWaiting()),
  ),
)
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
)

// Network first for page loads; when the server cannot be reached (or the
// proxy in front answers 502/503/504 for it) the offline page stands in.
// Everything else is not touched, so the browser handles it as without a worker.
self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.mode !== 'navigate' || req.method !== 'GET') return
  if (new URL(req.url).pathname.startsWith('/api/')) return
  event.respondWith(
    fetch(req).then(
      (res) => (res.status === 502 || res.status === 503 || res.status === 504 ? offline(res) : res),
      () => offline(),
    ),
  )
})

async function offline(res) {
  const page = await caches.match(OFFLINE)
  return page || res || Response.error()
}

self.addEventListener('push', (event) => {
  let data = { title: 'WeebSync', body: '' }
  try {
    data = { ...data, ...event.data.json() }
  } catch {
    /* keep defaults */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // same tag replaces the earlier notification instead of stacking a
      // folder sync's worth of them; renotify still alerts on the replacement
      tag: data.tag,
      renotify: !!data.tag,
      data: { url: data.url || '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return 'navigate' in c ? c.navigate(url).then((n) => n.focus()) : c.focus()
      }
      return self.clients.openWindow(url)
    }),
  )
})
