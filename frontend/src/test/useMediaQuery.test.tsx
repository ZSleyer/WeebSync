import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SHEET_MQ, useMediaQuery } from '@weebsync/design-system'

// jsdom's matchMedia always reports `matches: false` and never fires; the stub
// below keeps the listeners so a test can flip the query.
type Listener = () => void
const stub = (matches: boolean) => {
  const listeners = new Set<Listener>()
  const real = window.matchMedia
  let current = matches
  window.matchMedia = ((q: string) => ({
    get matches() {
      return current
    },
    media: q,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  })) as unknown as typeof window.matchMedia
  return {
    flip(next: boolean) {
      current = next
      listeners.forEach((l) => l())
    },
    listeners,
    restore() {
      window.matchMedia = real
    },
  }
}

const Probe = ({ query }: { query: string }) => <p>{useMediaQuery(query) ? 'narrow' : 'wide'}</p>

describe('useMediaQuery', () => {
  let restore = () => {}
  afterEach(() => restore())

  it('reads the query synchronously on the first render', () => {
    const s = stub(true)
    restore = s.restore
    render(<Probe query={SHEET_MQ} />)
    expect(screen.getByText('narrow')).toBeInTheDocument()
  })

  it('re-renders when the query flips and unsubscribes on unmount', () => {
    const s = stub(false)
    restore = s.restore
    const { unmount } = render(<Probe query={SHEET_MQ} />)
    expect(screen.getByText('wide')).toBeInTheDocument()
    act(() => s.flip(true))
    expect(screen.getByText('narrow')).toBeInTheDocument()
    expect(s.listeners.size).toBe(1)
    unmount()
    expect(s.listeners.size).toBe(0)
  })
})
