import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNow } from '../hooks'

describe('useNow', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('turns over on the full step, not a step after mounting', () => {
    vi.setSystemTime(new Date('2026-09-10T20:00:40Z'))
    const { result } = renderHook(() => useNow(60_000))
    const first = result.current
    act(() => vi.advanceTimersByTime(19_000))
    expect(result.current).toBe(first)
    act(() => vi.advanceTimersByTime(1_000))
    expect(result.current).toBe(Date.parse('2026-09-10T20:01:00Z'))
    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current).toBe(Date.parse('2026-09-10T20:02:00Z'))
  })

  it('stops with the component', () => {
    vi.setSystemTime(new Date('2026-09-10T20:00:00Z'))
    const { unmount } = renderHook(() => useNow(1000))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
