import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useFold } from '../pages/today/shared'

describe('useFold', () => {
  afterEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('keeps a folded section folded on the next visit, per section', () => {
    const first = renderHook(() => useFold('storage'))
    act(() => first.result.current.onToggle())
    first.unmount()
    // a new tab or a restarted app starts with an empty session
    sessionStorage.clear()

    expect(renderHook(() => useFold('storage')).result.current.open).toBe(false)
    expect(renderHook(() => useFold('agenda')).result.current.open).toBe(true)

    const again = renderHook(() => useFold('storage'))
    act(() => again.result.current.onToggle())
    again.unmount()
    expect(renderHook(() => useFold('storage')).result.current.open).toBe(true)
  })
})
