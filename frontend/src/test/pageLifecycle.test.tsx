import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEvents } from '../hooks'

// The live stream and the back/forward cache: a page with an open stream is
// not kept by every browser, and one that is kept has missed what happened
// while it was away.
class FakeSource {
  static all: FakeSource[] = []
  closed = false
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) {
    this.url = url
    FakeSource.all.push(this)
  }
  close() {
    this.closed = true
  }
}

const setup = () => {
  FakeSource.all = []
  vi.stubGlobal('EventSource', FakeSource)
  const qc = new QueryClient()
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const hook = renderHook(() => useEvents(true), { wrapper })
  return { qc, invalidate, ...hook }
}
const pageshow = (persisted: boolean) => {
  const e = new Event('pageshow') as Event & { persisted: boolean }
  Object.defineProperty(e, 'persisted', { value: persisted })
  window.dispatchEvent(e)
}

afterEach(() => vi.unstubAllGlobals())

describe('useEvents and the back/forward cache', () => {
  it('opens one stream and closes it when the page is put away', () => {
    setup()
    expect(FakeSource.all).toHaveLength(1)
    window.dispatchEvent(new Event('pagehide'))
    expect(FakeSource.all[0].closed).toBe(true)
  })

  it('opens a fresh stream and refetches when the page comes back from the cache', () => {
    const { invalidate } = setup()
    window.dispatchEvent(new Event('pagehide'))
    invalidate.mockClear()
    pageshow(true)
    expect(FakeSource.all).toHaveLength(2)
    expect(FakeSource.all[1].closed).toBe(false)
    expect(invalidate).toHaveBeenCalledWith()
  })

  it('does nothing on an ordinary load', () => {
    const { invalidate } = setup()
    invalidate.mockClear()
    pageshow(false)
    expect(FakeSource.all).toHaveLength(1)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('does not open a second stream while one is open', () => {
    setup()
    pageshow(true)
    expect(FakeSource.all).toHaveLength(1)
  })

  it('closes and stops listening when it unmounts', () => {
    const { unmount } = setup()
    unmount()
    expect(FakeSource.all[0].closed).toBe(true)
    pageshow(true)
    expect(FakeSource.all).toHaveLength(1)
  })
})
