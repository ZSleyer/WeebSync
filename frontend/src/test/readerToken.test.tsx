import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import Viewer from '../pages/Viewer'
import { api } from '../api'
import { AudioProvider } from '../components/AudioPlayer'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({
      t: (k: string, o?: Record<string, unknown>) =>
        o && 'page' in o ? `${k}:${String(o.page)}/${String(o.count)}` : k,
      i18n: { language: 'de' },
    }) as never,
}))

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('stale read-open token', () => {
  it('asks for the token again when a page fails to load, once', async () => {
    localStorage.setItem('viewer.hinted', '1')
    const bases = ['/api/read/b/old/', '/api/read/b/new/']
    const get = vi.spyOn(api, 'get').mockImplementation((url: string) => {
      if (url.startsWith('/api/read/open'))
        return Promise.resolve({ kind: 'comic', base: bases[Math.min(opens++, 1)], pages: ['1.jpg', '2.jpg'] }) as never
      return Promise.resolve([]) as never
    })
    let opens = 0
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/view?server=0&path=${encodeURIComponent('/b/vol.cbz')}`]}>
          <AudioProvider>
            <Viewer />
          </AudioProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const img = await screen.findByRole('img', { name: 'viewer.pageOf:1/2' })
    expect(img.getAttribute('src')).toContain('/old/1.jpg')
    // the server forgot the book: the page 404s
    fireEvent.error(img)
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'viewer.pageOf:1/2' }).getAttribute('src')).toContain('/new/1.jpg'),
    )
    // a second failure with nothing loaded in between does not loop
    fireEvent.error(screen.getByRole('img', { name: 'viewer.pageOf:1/2' }))
    await new Promise((r) => setTimeout(r, 50))
    expect(get.mock.calls.filter(([u]) => String(u).startsWith('/api/read/open'))).toHaveLength(2)
  })
})
