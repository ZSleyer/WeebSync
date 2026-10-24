import { QueryCache, QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newImageUrls, REFRESH_CAP_MS, smoothRefresh } from '../smoothRefresh'

const doc = document as unknown as { startViewTransition?: unknown }

function watched(qc: QueryClient, fn: () => Promise<string>) {
  const obs = new QueryObserver(qc, { queryKey: ['k'], queryFn: fn, staleTime: Infinity })
  const off = obs.subscribe(() => {})
  return off
}

describe('smoothRefresh', () => {
  afterEach(() => {
    delete doc.startViewTransition
  })

  it('sets the done mark first, then writes the answers, with no view transition', async () => {
    const qc = new QueryClient()
    let n = 0
    const off = watched(qc, async () => `v${++n}`)
    await vi.waitFor(() => expect(qc.getQueryData(['k'])).toBe('v1'))
    // a view transition froze the page in a still picture: it must not run
    const transition = vi.fn()
    doc.startViewTransition = transition
    let atMark: unknown = 'not run'
    await smoothRefresh(qc, () => {
      atMark = qc.getQueryData(['k'])
    })
    expect(atMark).toBe('v1')
    expect(qc.getQueryData(['k'])).toBe('v2')
    expect(transition).not.toHaveBeenCalled()
    off()
  })

  it('lands what is in by the deadline and a slow answer later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const qc = new QueryClient()
    let n = 0
    let slow: (v: string) => void = () => {}
    const off = watched(qc, () => (++n === 1 ? Promise.resolve('v1') : new Promise<string>((r) => (slow = r))))
    await vi.waitFor(() => expect(qc.getQueryData(['k'])).toBe('v1'))
    let marked = false
    const run = smoothRefresh(qc, () => {
      marked = true
    })
    await vi.advanceTimersByTimeAsync(REFRESH_CAP_MS)
    await vi.waitFor(() => expect(marked).toBe(true))
    expect(qc.getQueryData(['k'])).toBe('v1')
    slow('v2')
    await vi.waitFor(() => expect(qc.getQueryData(['k'])).toBe('v2'))
    vi.useRealTimers()
    await run
    off()
  })

  it('lists only the pictures an answer brings new', () => {
    const prev = { banners: [{ url: 'https://img.example.com/a.jpg' }] }
    const next = {
      banners: [{ url: 'https://img.example.com/a.jpg' }, { url: 'https://img.example.com/b.webp?x=1' }],
      name: 'c.jpg',
    }
    expect(newImageUrls(prev, next)).toEqual(['https://img.example.com/b.webp?x=1'])
  })

  it('does not overwrite data that a newer write (the event stream) put in meanwhile', async () => {
    const qc = new QueryClient()
    let release: (v: string) => void = () => {}
    let n = 0
    const off = watched(qc, () => (++n === 1 ? Promise.resolve('v1') : new Promise<string>((r) => (release = r))))
    await vi.waitFor(() => expect(qc.getQueryData(['k'])).toBe('v1'))
    const run = smoothRefresh(qc)
    await vi.waitFor(() => expect(n).toBe(2))
    await new Promise((r) => setTimeout(r, 5))
    qc.setQueryData(['k'], 'pushed')
    release('stale')
    await run
    expect(qc.getQueryData(['k'])).toBe('pushed')
    off()
  })

  it('reports a total failure and hands a 401 to the cache error handler', async () => {
    const onError = vi.fn()
    const qc = new QueryClient({ queryCache: new QueryCache({ onError }) })
    const obs = new QueryObserver(qc, { queryKey: ['k'], queryFn: async () => 'v1', staleTime: Infinity })
    const off = obs.subscribe(() => {})
    await vi.waitFor(() => expect(qc.getQueryData(['k'])).toBe('v1'))
    obs.setOptions({
      queryKey: ['k'],
      queryFn: () => Promise.reject(new Error('offline')),
      staleTime: Infinity,
    })
    const r = await smoothRefresh(qc)
    expect(r).toEqual({ total: 1, failed: 1 })
    expect(onError).toHaveBeenCalledOnce()
    expect(qc.getQueryData(['k'])).toBe('v1')
    off()
  })
})
