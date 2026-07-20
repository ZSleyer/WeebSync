// WeebSync service worker: makes the app installable and shows push
// notifications. No offline caching - the app is useless without its API.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

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
