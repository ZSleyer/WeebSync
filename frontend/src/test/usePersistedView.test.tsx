import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { usePersistedView } from '../hooks/usePersistedView'

const VIEWS = ['list', 'grid', 'calendar'] as const
const wrap = (url = '/watches') => ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>

afterEach(() => localStorage.clear())

describe('usePersistedView', () => {
  it('starts from the default, then from what was saved', () => {
    const { result } = renderHook(() => usePersistedView('t.view', VIEWS, 'list'), { wrapper: wrap() })
    expect(result.current[0]).toBe('list')
    act(() => result.current[1]('grid'))
    expect(result.current[0]).toBe('grid')
    expect(localStorage.getItem('t.view')).toBe('grid')
    const again = renderHook(() => usePersistedView('t.view', VIEWS, 'list'), { wrapper: wrap() })
    expect(again.result.current[0]).toBe('grid')
  })

  it('lets the URL win over what was saved and ignores a value it does not know', () => {
    localStorage.setItem('t.view', 'grid')
    const { result } = renderHook(() => usePersistedView('t.view', VIEWS, 'list'), { wrapper: wrap('/watches?view=calendar') })
    expect(result.current[0]).toBe('calendar')
    const bad = renderHook(() => usePersistedView('t.view', VIEWS, 'list'), { wrapper: wrap('/watches?view=nope') })
    expect(bad.result.current[0]).toBe('grid')
  })
})
