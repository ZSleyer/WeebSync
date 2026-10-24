import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
vi.mock(import('../hooks'), async (importOriginal) => ({
  ...(await importOriginal()),
  useAuth: () => ({ data: { isAdmin: true } }) as never,
}))
vi.mock('../components/confirm', () => ({ useConfirm: () => async () => true }))

const dir = (name: string, path: string): Entry => ({
  name,
  path,
  isDir: true,
  size: 0,
  modTime: '2026-09-01T00:00:00Z',
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Files action errors', () => {
  it('drops a failed delete message once the user moves to another folder', async () => {
    // a wide screen: the selection bar renders in place
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: !/max-width|pointer: coarse|hover: none/.test(q),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }))
    vi.spyOn(api, 'get').mockImplementation(async (u: string) => {
      if (u === '/api/servers') return [{ id: 1, name: 'srv' }]
      if (u.startsWith('/api/browse/local')) {
        const p = new URLSearchParams(u.split('?')[1] ?? '').get('path') ?? ''
        return p === '' ? [dir('A', 'A'), dir('B', 'B')] : []
      }
      return []
    })
    vi.spyOn(api, 'del').mockRejectedValue(new Error('permission denied'))
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
      { initialEntries: ['/files?source=local'] },
    )
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
    fireEvent.click((await screen.findAllByRole('checkbox', { name: 'files.checkItem' }))[0])
    fireEvent.click(await screen.findByRole('button', { name: /local\.delete/ }))
    expect((await screen.findByRole('alert')).textContent).toBe('permission denied')
    // the folder changes: the message belonged to the old one
    fireEvent.click(await screen.findByText('B'))
    await waitFor(() => expect(router.state.location.search).toContain('path=B'))
    expect(screen.queryByText('permission denied')).toBeNull()
  })
})
