import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import Viewer from '../pages/Viewer'
import { api } from '../api'
import { AudioProvider } from '../components/AudioPlayer'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'de' } }) as never,
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('stale read-open token in an EPUB', () => {
  it('asks for the token again when the chapter is gone', async () => {
    localStorage.setItem('viewer.hinted', '1')
    const container = `<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>`
    const opf = `<package><metadata/><manifest><item id="a" href="a.xhtml"/></manifest><spine><itemref idref="a"/></spine></package>`
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        // the frame's chapter is gone with the unpacked book
        if (init?.method === 'HEAD') return Promise.resolve(new Response(null, { status: 404 }))
        return Promise.resolve(new Response(url.endsWith('container.xml') ? container : opf))
      }),
    )
    let opens = 0
    vi.spyOn(api, 'get').mockImplementation((url: string) => {
      if (url.startsWith('/api/read/open'))
        return Promise.resolve({ kind: 'epub', base: `/api/read/b/t${++opens}/` }) as never
      return Promise.resolve([]) as never
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/view?server=0&path=${encodeURIComponent('/b/book.epub')}`]}>
          <AudioProvider>
            <Viewer />
          </AudioProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(opens).toBe(2))
    // asked once, not on every render
    await new Promise((r) => setTimeout(r, 100))
    expect(opens).toBe(2)
  })
})
