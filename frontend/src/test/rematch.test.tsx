import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api, type CatalogItem } from '../api'
import { RematchForm } from '../components/Rematch'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

afterEach(() => vi.restoreAllMocks())

const item = (extra: Partial<CatalogItem> = {}) =>
  ({
    entry: { name: 'Example Show', path: '/Area/Example Show', isDir: true },
    source: 'anilist',
    ...extra,
  }) as CatalogItem

const media = (id: number, title: string) => ({ id, title: { romaji: title }, coverImage: {} })

// every GET answers; the calls are what the test looks at
function setup(
  it: CatalogItem,
  keys = { tvdbApiKeySet: true, tmdbApiKeySet: true },
  wrap: (children: ReactNode) => ReactNode = (c) => c,
) {
  const get = vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/auth/me') return { id: 1, email: 'u@example.test', ...keys }
    if (url.includes('/search')) return [media(42, 'Hit')]
    return media(42, 'Hit')
  })
  const put = vi.spyOn(api, 'put').mockResolvedValue({})
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      {wrap(<RematchForm serverId={3} item={it} onClose={vi.fn()} onPicked={vi.fn()} />)}
    </QueryClientProvider>,
  )
  const searched = () => get.mock.calls.map((c) => String(c[0])).filter((u) => u !== '/api/auth/me')
  return { searched, put }
}

describe('Rematch provider picker', () => {
  it('searches the provider of the folder first', async () => {
    const { searched } = setup(item({ source: 'tvdb:movie' }))
    await waitFor(() => expect(searched()).toContain('/api/tvdb/search?kind=movie&q=Example%20Show'))
  })

  it('switches the provider, searches its endpoint and files the pick under its source', async () => {
    const { searched, put } = setup(item())
    await waitFor(() => expect(searched()).toContain('/api/anilist/search?q=Example%20Show'))
    fireEvent.click(await screen.findByRole('button', { name: 'TMDB' }))
    await waitFor(() => expect(searched()).toContain('/api/tmdb/search?kind=tv&q=Example%20Show'))
    fireEvent.click(await screen.findByRole('button', { name: 'remote.kindFilm' }))
    await waitFor(() => expect(searched()).toContain('/api/tmdb/search?kind=movie&q=Example%20Show'))
    fireEvent.click(await screen.findByText('Hit'))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/servers/3/catalog/match', {
        folder: '/Area/Example Show',
        mediaId: 42,
        source: 'tmdb:movie',
      }),
    )
  })

  it('files a TVDB series pick under tvdb', async () => {
    const { put } = setup(item())
    const tvdb = await screen.findByRole('button', { name: 'TVDB' })
    await waitFor(() => expect(tvdb).toBeEnabled()) // the keys arrive with the user
    fireEvent.click(tvdb)
    fireEvent.click(await screen.findByText('Hit'))
    await waitFor(() => expect(put).toHaveBeenCalled())
    expect(put.mock.calls[0][1]).toMatchObject({ mediaId: 42, source: 'tvdb' })
  })

  it('sends no source when the folder keeps its own provider', async () => {
    const { put } = setup(item())
    fireEvent.click(await screen.findByText('Hit'))
    await waitFor(() => expect(put).toHaveBeenCalled())
    expect(put.mock.calls[0][1]).toEqual({ folder: '/Area/Example Show', mediaId: 42 })
  })

  it('disables a provider without a key and starts on AniList instead', async () => {
    const { searched } = setup(item({ source: 'tmdb:tv' }), { tvdbApiKeySet: true, tmdbApiKeySet: false })
    expect(await screen.findByRole('button', { name: 'TMDB' })).toBeDisabled()
    expect(screen.getByText('remote.providerNeedsKey')).toBeInTheDocument()
    await waitFor(() => expect(searched()).toContain('/api/anilist/search?q=Example%20Show'))
  })

  it('keeps the pasted link working: a link from another provider brings its own source', async () => {
    const { put, searched } = setup(item())
    fireEvent.change(await screen.findByRole('searchbox'), {
      target: { value: 'https://www.themoviedb.org/movie/603' },
    })
    await waitFor(() => expect(searched()).toContain('/api/tmdb/media?kind=movie&id=603'))
    fireEvent.click(await screen.findByText('Hit'))
    await waitFor(() => expect(put).toHaveBeenCalled())
    expect(put.mock.calls[0][1]).toMatchObject({ source: 'tmdb:movie' })
  })
})

// the match dialog sits inside the watch form's <form> (no portal)
describe('Rematch inside a surrounding form', () => {
  const inForm = (onSubmit: () => void) => (c: ReactNode) => (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      {c}
    </form>
  )

  it('picking a hit does not submit the surrounding form', async () => {
    const submit = vi.fn()
    const { put } = setup(item(), undefined, inForm(submit))
    fireEvent.click(await screen.findByText('Hit'))
    await waitFor(() => expect(put).toHaveBeenCalled())
    expect(submit).not.toHaveBeenCalled()
  })

  it('Enter in the search field searches without submitting the surrounding form', async () => {
    const { searched } = setup(item(), undefined, inForm(vi.fn()))
    await waitFor(() => expect(searched()).toHaveLength(1))
    const field = await screen.findByRole('searchbox')
    // fireEvent returns false when the default action (implicit submission) was prevented
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(false)
    await waitFor(() => expect(searched()).toHaveLength(2))
  })
})
