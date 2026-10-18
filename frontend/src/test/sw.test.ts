import source from '../../public/sw.js?raw'
import { describe, expect, it, vi } from 'vitest'

// Runs public/sw.js against fakes of its globals and drives its listeners.
type Handler = (e: unknown) => void
function load(fetchImpl: (...a: unknown[]) => Promise<unknown>, cached: Map<string, unknown> = new Map()) {
  const handlers: Record<string, Handler> = {}
  const caches = {
    open: vi.fn().mockResolvedValue({ addAll: vi.fn().mockResolvedValue(undefined) }),
    match: vi.fn(async (u: string) => cached.get(u)),
    keys: vi.fn().mockResolvedValue(['weebsync-offline-v1', 'weebsync-img-v1', 'old']),
    delete: vi.fn().mockResolvedValue(true),
  }
  const self = {
    addEventListener: (n: string, h: Handler) => (handlers[n] = h),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  }
  class Req {
    url: string
    constructor(url: string) {
      this.url = url
    }
  }
  const Resp = { error: () => 'error' }
  // the worker is a classic script: the only way to run it with fake globals
  // oxlint-disable-next-line no-new-func
  new Function('self', 'caches', 'fetch', 'Request', 'Response', 'URL', source)(self, caches, fetchImpl, Req, Resp, URL)
  return { handlers, caches, self }
}

const nav = (path: string, over: object = {}) => {
  let answer: Promise<unknown> | undefined
  const event = {
    request: { mode: 'navigate', method: 'GET', url: `https://app.test${path}`, ...over },
    respondWith: (p: Promise<unknown>) => (answer = p),
  }
  return { event, answer: () => answer }
}

describe('service worker', () => {
  const offlinePage = { page: 'offline' }
  const cached = new Map([['/offline.html', offlinePage]])

  it('serves the offline page when a navigation cannot reach the server', async () => {
    const { handlers } = load(() => Promise.reject(new TypeError('network')), cached)
    const n = nav('/files')
    handlers.fetch(n.event)
    expect(await n.answer()).toBe(offlinePage)
  })
  it('serves it for a proxy error status, not for other statuses', async () => {
    const bad = { status: 502 }
    const ok = { status: 404 }
    let res: unknown = bad
    const { handlers } = load(() => Promise.resolve(res), cached)
    const a = nav('/')
    handlers.fetch(a.event)
    expect(await a.answer()).toBe(offlinePage)
    res = ok
    const b = nav('/')
    handlers.fetch(b.event)
    expect(await b.answer()).toBe(ok)
  })
  it('leaves API calls, other requests and non-navigations alone', () => {
    const { handlers } = load(() => Promise.reject(new Error('x')), cached)
    for (const n of [nav('/api/me'), nav('/assets/a.js', { mode: 'no-cors' }), nav('/x', { method: 'POST' })]) {
      handlers.fetch(n.event)
      expect(n.answer()).toBeUndefined()
    }
  })
  it('installs even if the precache fails, and drops old caches on activate', async () => {
    const { handlers, caches, self } = load(() => Promise.resolve(), cached)
    caches.open.mockRejectedValueOnce(new Error('404'))
    const waits: Promise<unknown>[] = []
    handlers.install({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
    expect(self.skipWaiting).toHaveBeenCalled()
    waits.length = 0
    handlers.activate({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
    // the offline cache and the image cache stay
    expect(caches.delete).toHaveBeenCalledTimes(1)
    expect(caches.delete).toHaveBeenCalledWith('old')
    expect(self.clients.claim).toHaveBeenCalled()
  })

  describe('provider images', () => {
    const img = (url: string, over: object = {}) => {
      let answer: Promise<unknown> | undefined
      const event = {
        request: { mode: 'no-cors', method: 'GET', destination: 'image', url, ...over },
        respondWith: (p: Promise<unknown>) => (answer = p),
      }
      return { event, answer: () => answer }
    }
    const pic = (type = 'image/jpeg', ok = true) => ({
      ok,
      headers: { get: () => type },
      clone() {
        return this
      },
    })
    // an in-memory image cache that keeps insertion order like CacheStorage
    const store = new Map<string, unknown>()
    const imgCache = {
      match: async (u: string) => store.get(u),
      put: async (u: string, r: unknown) => void store.set(u, r),
      keys: async () => [...store.keys()],
      delete: async (u: string) => store.delete(u),
    }
    const loadImg = (fetchImpl: (...a: unknown[]) => Promise<unknown>) => {
      store.clear()
      const w = load(fetchImpl, cached)
      w.caches.open.mockResolvedValue(imgCache)
      return w
    }
    const A = 'https://s4.anilist.co/file/a.jpg'

    it('leaves other hosts, sizes, methods, destinations and plain http alone', () => {
      const { handlers } = loadImg(() => Promise.reject(new Error('x')))
      for (const u of [
        'https://app.test/cover.png',
        'https://s4.anilist.co.evil.test/a.jpg',
        'https://evil.test/s4.anilist.co/a.jpg',
        'http://s4.anilist.co/a.jpg',
        'https://image.tmdb.org/t/p/original/a.jpg',
        'https://app.test/api/x',
      ]) {
        const n = img(u)
        handlers.fetch(n.event)
        expect(n.answer()).toBeUndefined()
      }
      for (const over of [{ method: 'POST' }, { destination: 'script' }, { destination: '' }]) {
        const n = img(A, over)
        handlers.fetch(n.event)
        expect(n.answer()).toBeUndefined()
      }
    })
    it('fetches a miss with CORS, stores it and answers from the cache after', async () => {
      const res = pic()
      const fetchImpl = vi.fn().mockResolvedValue(res)
      const { handlers } = loadImg(fetchImpl)
      const a = img('https://artworks.thetvdb.com/x.jpg')
      handlers.fetch(a.event)
      expect(await a.answer()).toBe(res)
      expect(fetchImpl).toHaveBeenCalledWith('https://artworks.thetvdb.com/x.jpg', {
        mode: 'cors',
        credentials: 'omit',
      })
      const b = img('https://artworks.thetvdb.com/x.jpg')
      handlers.fetch(b.event)
      expect(await b.answer()).toBe(res)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })
    it('does not store errors or non-images', async () => {
      for (const res of [pic('image/jpeg', false), pic('text/html')]) {
        const { handlers } = loadImg(() => Promise.resolve(res))
        const n = img(A)
        handlers.fetch(n.event)
        expect(await n.answer()).toBe(res)
        expect(store.size).toBe(0)
      }
    })
    it('passes the original request through when CORS fails', async () => {
      const passed = pic()
      const fetchImpl = vi.fn((a: unknown) =>
        typeof a === 'string' ? Promise.reject(new TypeError('cors')) : Promise.resolve(passed),
      )
      const { handlers } = loadImg(fetchImpl)
      const n = img(A)
      handlers.fetch(n.event)
      expect(await n.answer()).toBe(passed)
      expect(store.size).toBe(0)
    })
    it('falls back to the network when the cache itself fails', async () => {
      const passed = pic()
      const { handlers, caches } = loadImg(() => Promise.resolve(passed))
      caches.open.mockRejectedValue(new Error('quota'))
      const n = img(A)
      handlers.fetch(n.event)
      expect(await n.answer()).toBe(passed)
    })
    it('evicts the oldest pictures beyond the cap', async () => {
      const { handlers } = loadImg(() => Promise.resolve(pic()))
      // the first store trims, then one trim per 25 stores
      for (let i = 0; i < 700; i++) {
        const n = img(`https://s4.anilist.co/${i}.jpg`)
        handlers.fetch(n.event)
        await n.answer()
      }
      expect(store.size).toBeGreaterThanOrEqual(600)
      expect(store.size).toBeLessThan(625)
      expect(store.has('https://s4.anilist.co/0.jpg')).toBe(false)
      expect(store.has('https://s4.anilist.co/699.jpg')).toBe(true)
    })
  })
})
