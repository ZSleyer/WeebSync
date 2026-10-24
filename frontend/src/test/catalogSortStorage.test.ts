import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CATALOG_SORTS, useCatalogSort, useCatalogStatus } from '../components/catalogSort'

// blocked site storage: every access throws a SecurityError
const blocked = () => {
  throw new DOMException('blocked', 'SecurityError')
}

afterEach(() => vi.unstubAllGlobals())

describe('catalog sort and status with blocked storage', () => {
  it('opens on the defaults and still changes for the visit', () => {
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked })
    const sort = renderHook(() => useCatalogSort())
    expect(sort.result.current[0]).toBe('popularity')
    const other = CATALOG_SORTS.find((s) => s !== 'popularity')!
    act(() => sort.result.current[1](other))
    expect(sort.result.current[0]).toBe(other)

    const status = renderHook(() => useCatalogStatus())
    expect(status.result.current[0]).toBe('')
    act(() => status.result.current[1]('RELEASING'))
    expect(status.result.current[0]).toBe('RELEASING')
    act(() => status.result.current[1](''))
    expect(status.result.current[0]).toBe('')
  })
})
