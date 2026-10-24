import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '../api'
import { useWatchActions } from '../components/watchActions'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))
const toast = vi.hoisted(() => vi.fn())
vi.mock('../components/toast', () => ({ useUndoableRemove: () => vi.fn(), useToast: () => toast }))

afterEach(() => {
  vi.restoreAllMocks()
  toast.mockClear()
})

describe('useWatchActions notice', () => {
  it('reports every Plex apply, also the second with the same text', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({})
    const qc = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useWatchActions(), { wrapper })
    await act(() => result.current.applyPlexStreams(1))
    await act(() => result.current.applyPlexStreams(2))
    expect(toast.mock.calls).toEqual([[{ message: 'watch.plexApplyQueued' }], [{ message: 'watch.plexApplyQueued' }]])
  })
})
