import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router'
import Files from '../pages/Files'
import { SeriesModalProvider } from '../components/SeriesModal'
import { api, type Entry } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }) as never,
}))

const dir = (name: string, path: string): Entry => ({
  name,
  path,
  isDir: true,
  size: 0,
  modTime: '2026-09-01T00:00:00Z',
})
const tree: Record<string, Entry[]> = {
  '': [dir('Show', '/Show')],
  '/Show': [dir('Season 01', '/Show/Season 01')],
  '/Show/Season 01': [],
}

function mount(url: string) {
  vi.spyOn(api, 'get').mockImplementation(async (u: string) => {
    if (u === '/api/servers') return [{ id: 1, name: 'srv' }]
    if (u.startsWith('/api/servers/1/browse')) {
      const p = new URLSearchParams(u.split('?')[1] ?? '').get('path') ?? ''
      return tree[p] ?? []
    }
    return []
  })
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
    {
      initialEntries: ['/start', url],
      initialIndex: 1,
    },
  )
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

afterEach(() => vi.restoreAllMocks())

describe('Files folder history', () => {
  it('starts at the folder of the link and keeps the link as it is', async () => {
    const router = mount('/files?server=1&path=Show')
    await screen.findByText('Season 01')
    expect(router.state.location.search).toBe('?server=1&path=Show')
  })

  it('pushes an entry per folder entered, so back steps up one folder', async () => {
    const router = mount('/files?server=1')
    fireEvent.click(await screen.findByText('Show'))
    await waitFor(() => expect(router.state.location.search).toBe('?server=1&path=Show'))
    fireEvent.click(await screen.findByText('Season 01'))
    await waitFor(() => expect(router.state.location.search).toBe('?server=1&path=Show%2FSeason+01'))

    await act(() => router.navigate(-1))
    expect(router.state.location.search).toBe('?server=1&path=Show')
    await screen.findByText('Season 01')
    await act(() => router.navigate(-1))
    expect(router.state.location.search).toBe('?server=1')
    // one more back leaves the page
    await act(() => router.navigate(-1))
    expect(router.state.location.pathname).toBe('/start')
  })

  it('writes the missing source into the entry without adding one', async () => {
    const router = mount('/files')
    await waitFor(() => expect(router.state.location.search).toBe('?server=1'))
    await act(() => router.navigate(-1))
    expect(router.state.location.pathname).toBe('/start')
  })
})
