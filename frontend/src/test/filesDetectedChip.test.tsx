import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router'
import Files from '../pages/Files'
import { SeriesModalProvider } from '../components/SeriesModal'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }) as never,
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount(detected: boolean) {
  // a wide screen: the source chip opens a menu, not a sheet
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: !/max-width|pointer: coarse|hover: none/.test(q),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.spyOn(api, 'get').mockImplementation(async (u: string) => {
    if (u === '/api/servers') return [{ id: 1, name: 'srv' }]
    if (u.startsWith('/api/servers/1/catalog/scope'))
      return { scope: 'auto', ruleShape: '', ruleId: 0, ruleKind: '', detected }
    if (u.startsWith('/api/servers/1/catalog')) return { scope: 'auto', items: [] }
    if (u.startsWith('/api/servers/1/browse')) return []
    return []
  })
  const put = vi.spyOn(api, 'put').mockResolvedValue({} as never)
  const router = createMemoryRouter(
    [
      {
        path: '/files',
        element: (
          <SeriesModalProvider>
            <Files />
          </SeriesModalProvider>
        ),
      },
    ],
    { initialEntries: ['/files?server=1&path=Some%20Category&view=catalog'] },
  )
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return put
}

describe('a folder WeebSync marked itself', () => {
  it('shows the auto-detected chip beside its mark, and the user can pick another kind', async () => {
    const put = mount(true)
    expect(await screen.findByText('remote.detected')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /remote\.scopeAs/ }))
    fireEvent.click(await screen.findByText('remote.scopeAnime'))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/servers/1/catalog/scope', { path: '/Some Category', kind: 'anime' }),
    )
  })

  it('has no chip on a mark the user set', async () => {
    mount(false)
    await screen.findByRole('button', { name: /remote\.scopeAs/ })
    expect(screen.queryByText('remote.detected')).toBeNull()
  })
})
