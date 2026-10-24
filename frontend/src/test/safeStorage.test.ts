import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeGet } from '../hooks/useStored'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  sessionStorage.clear()
})

describe('safeGet', () => {
  it('reads a stored value from either store', () => {
    localStorage.setItem('k', 'a')
    sessionStorage.setItem('k', 'b')
    expect(safeGet('local', 'k')).toBe('a')
    expect(safeGet('session', 'k')).toBe('b')
  })

  it('returns null for a missing key', () => {
    expect(safeGet('local', 'nope')).toBeNull()
  })

  it('returns null instead of throwing when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(safeGet('local', 'k')).toBeNull()
    expect(safeGet('session', 'k')).toBeNull()
  })
})
