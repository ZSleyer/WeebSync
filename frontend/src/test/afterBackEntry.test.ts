import { afterEach, describe, expect, it, vi } from 'vitest'
import { afterBackEntry } from 'fluid-lycoris'

afterEach(() => {
  vi.useRealTimers()
  history.replaceState(null, '')
})

describe('afterBackEntry', () => {
  it('runs at once without a layer entry', () => {
    const fn = vi.fn()
    afterBackEntry(fn)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('waits for the popstate while a layer entry is on top', () => {
    vi.useFakeTimers()
    history.replaceState({ wsDialog: 'x', idx: 1 }, '')
    const fn = vi.fn()
    afterBackEntry(fn)
    vi.advanceTimersByTime(100)
    expect(fn).not.toHaveBeenCalled()
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('falls back to a timer when no popstate arrives', () => {
    vi.useFakeTimers()
    history.replaceState({ wsDialog: 'x', idx: 1 }, '')
    const fn = vi.fn()
    afterBackEntry(fn)
    vi.advanceTimersByTime(399)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledOnce()
    window.dispatchEvent(new PopStateEvent('popstate'))
    vi.advanceTimersByTime(10)
    expect(fn).toHaveBeenCalledOnce()
  })
})
