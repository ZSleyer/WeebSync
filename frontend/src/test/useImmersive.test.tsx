import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useImmersive } from '../components/useImmersive'

describe('useImmersive', () => {
  it('marks the root while mounted and clears it after', () => {
    const { unmount } = renderHook(() => useImmersive('playing'))
    expect(document.documentElement.classList.contains('playing')).toBe(true)
    unmount()
    expect(document.documentElement.classList.contains('playing')).toBe(false)
  })

  it('leaves the root alone while off', () => {
    const { rerender, unmount } = renderHook(({ on }) => useImmersive('reading', on), { initialProps: { on: false } })
    expect(document.documentElement.classList.contains('reading')).toBe(false)
    rerender({ on: true })
    expect(document.documentElement.classList.contains('reading')).toBe(true)
    unmount()
    expect(document.documentElement.classList.contains('reading')).toBe(false)
  })
})
