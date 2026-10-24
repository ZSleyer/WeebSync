import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '../api'
import { useThreadWrites } from '../components/threadWrites'

vi.mock('../components/toast', () => ({ useToast: () => vi.fn(), useFailToast: () => vi.fn() }))
vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }) as never,
}))

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['anilist-me'], { connected: true, allow: { social: true }, name: 'me' })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const link = document.body.appendChild(document.createElement('button'))
  const field = document.body.appendChild(document.createElement('textarea'))
  return { link, field, hook: renderHook(() => useThreadWrites(9), { wrapper }) }
}

describe('reply composer focus', () => {
  it('goes back to the "Reply" link on cancel', () => {
    const { link, field, hook } = setup()
    link.focus()
    act(() => hook.result.current.open({ parent: 0, top: 0, name: 'op' }))
    field.focus()
    act(() => hook.result.current.cancel())
    expect(document.activeElement).toBe(link)
  })

  it('goes back to the "Reply" link on send', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ id: 5 } as never)
    const { link, field, hook } = setup()
    link.focus()
    act(() => hook.result.current.open({ parent: 0, top: 0, name: 'op' }))
    act(() => hook.result.current.setDraft('hi'))
    field.focus()
    act(() => hook.result.current.send())
    await waitFor(() => expect(document.activeElement).toBe(link))
  })
})
