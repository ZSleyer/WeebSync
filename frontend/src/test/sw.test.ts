import source from '../../public/sw.js?raw'
import { describe, expect, it, vi } from 'vitest'

// Runs public/sw.js against fakes of its globals and drives its listeners.
type Handler = (e: unknown) => void
function load(fetchImpl: () => Promise<unknown>, cached: Map<string, unknown> = new Map()) {
  const handlers: Record<string, Handler> = {}
  const caches = {
    open: vi.fn().mockResolvedValue({ addAll: vi.fn().mockResolvedValue(undefined) }),
    match: vi.fn(async (u: string) => cached.get(u)),
    keys: vi.fn().mockResolvedValue(['weebsync-offline-v1', 'old']),
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
    expect(caches.delete).toHaveBeenCalledTimes(1)
    expect(caches.delete).toHaveBeenCalledWith('old')
    expect(self.clients.claim).toHaveBeenCalled()
  })
})
