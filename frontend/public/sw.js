// WeebSync service worker: makes the app installable, shows push
// notifications and answers a failed page load with an offline page.
//
// Two things are cached: that page and what it needs (OFFLINE_FILES), and the
// public cover/banner images of the metadata providers (IMAGE_HOSTS). The
// app's code, /api/ and every authenticated response always come from the
// network, so a cached copy can never serve stale or another user's data.
// Raise CACHE when the offline files change; activate drops every cache but
// this one and IMAGE_CACHE.
const CACHE = 'weebsync-offline-v1'
const OFFLINE = '/offline.html'
const OFFLINE_FILES = [OFFLINE, '/offline.js', '/favicon.svg']

// Provider pictures are public and content-addressed (a changed picture gets a
// new URL), so a stored copy never needs revalidating. Nothing else is cached.
const IMAGE_CACHE = 'weebsync-img-v1'
const IMAGE_HOSTS = ['s4.anilist.co', 'image.tmdb.org', 'artworks.thetvdb.com']
// ~150 KB a picture on average, so the cap is about 90 MB
const IMAGE_MAX = 600
// trim once per this many stores: keys() walks the whole cache
const TRIM_EVERY = 25
let stored = TRIM_EVERY

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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== IMAGE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
)

// a provider picture worth keeping: GET over https from a known host; TMDB's
// original size is 1.3 MB each and never shown at that size
function cacheableImage(req) {
  if (req.method !== 'GET' || req.destination !== 'image') return false
  const u = new URL(req.url)
  return u.protocol === 'https:' && IMAGE_HOSTS.includes(u.hostname) && !u.pathname.startsWith('/t/p/original/')
}

// Cache first. A page's <img> is a no-cors request, which the worker would only
// see as an opaque response (status 0, padded in the storage quota), so a miss
// is fetched again with CORS and stored when it is a readable image; a host that
// refuses CORS is simply passed through, uncached.
async function image(req) {
  try {
    const cache = await caches.open(IMAGE_CACHE)
    const hit = await cache.match(req.url)
    if (hit) return hit
    let res
    try {
      res = await fetch(req.url, { mode: 'cors', credentials: 'omit' })
    } catch {
      return fetch(req)
    }
    if (res.ok && (res.headers.get('content-type') || '').startsWith('image/')) {
      await cache.put(req.url, res.clone())
      if (++stored >= TRIM_EVERY) {
        stored = 0
        await trim(cache)
      }
    }
    return res
  } catch {
    return fetch(req)
  }
}

// keys() lists oldest first: drop the surplus from the front
async function trim(cache) {
  const keys = await cache.keys()
  await Promise.all(keys.slice(0, Math.max(0, keys.length - IMAGE_MAX)).map((k) => cache.delete(k)))
}

// Network first for page loads; when the server cannot be reached (or the
// proxy in front answers 502/503/504 for it) the offline page stands in.
// Provider images are served from their own cache. Everything else is not touched, so the browser handles it as without a worker.
self.addEventListener('fetch', (event) => {
  const req = event.request
  if (cacheableImage(req)) return event.respondWith(image(req))
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
  const opts = {
    body: data.body,
    icon: data.icon || '/icon-192.png',
    // Android draws the badge as a silhouette from its alpha: a one-colour mark
    badge: '/badge-96.png',
    // same tag replaces the earlier notification instead of stacking a
    // folder sync's worth of them; renotify still alerts on the replacement
    tag: data.tag,
    renotify: !!data.tag,
    // per-action targets travel with the notification: url (a click), play
    // (a link) and retry (an API path to POST)
    data: { ...data.data, url: (data.data && data.data.url) || data.url || '/' },
  }
  if (data.timestamp) opts.timestamp = data.timestamp
  if (Array.isArray(data.actions) && data.actions.length) opts.actions = data.actions.slice(0, 2)
  event.waitUntil(self.registration.showNotification(data.title, opts))
})

// open a link in the app: focus a window and navigate it, else open one
function openApp(url) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if ('focus' in c) return 'navigate' in c ? c.navigate(url).then((n) => n.focus()) : c.focus()
    }
    return self.clients.openWindow(url)
  })
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const d = event.notification.data || {}
  const url = d.url || '/'
  if (event.action === 'play' && d.play) {
    event.waitUntil(openApp(d.play))
  } else if (event.action === 'retry' && d.retry) {
    // same origin, so the session cookie rides along; the route takes no body,
    // so no content-type is needed. A failed retry lands on the history instead.
    event.waitUntil(
      fetch(d.retry, { method: 'POST', credentials: 'same-origin' })
        .then((r) => (r.ok ? undefined : openApp(url)))
        .catch(() => openApp(url)),
    )
  } else {
    event.waitUntil(openApp(url))
  }
})
