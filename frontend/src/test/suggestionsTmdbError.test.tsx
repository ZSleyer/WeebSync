import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SeriesModalProvider } from '../components/SeriesModal'
import { BucketSection } from '../pages/Suggestions'
import { api, type SuggestionsResponse } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'de' } }) as never,
  Trans: (({ i18nKey }: { i18nKey: string }) => i18nKey) as never,
}))

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

const blob = (extra: Partial<SuggestionsResponse>): SuggestionsResponse => ({
  watchlist: [],
  recommended: [],
  trending: [],
  upgrades: [],
  incomplete: [],
  duplicates: [],
  building: false,
  builtAt: 1,
  ...extra,
})

function serve(resp: SuggestionsResponse) {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/auth/me') return { id: 1, email: 'demo@example.com' } as never
    if (url === '/api/anilist/me') return { configured: false, connected: false, allow: {} } as never
    if (url === '/api/suggestions') return resp as never
    return [] as never
  })
}

function renderIn(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <SeriesModalProvider>{ui}</SeriesModalProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

// A revoked TMDB link used to leave the watchlist quietly empty: the page
// now says why, and where to link TMDB again.
describe('TMDB errors on the suggestion lists', () => {
  it('a revoked link says so on the watchlist, with the way to link again', async () => {
    serve(blob({ watchlistError: 'unauthorized' }))
    renderIn(<BucketSection bucket="watchlist" />)
    expect(await screen.findByText('suggestions.tmdbUnauthorized', { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'suggestions.tmdbRelink' })).toHaveAttribute(
      'href',
      '/settings/integrations#tmdb',
    )
  })

  it('an unreadable watchlist is named, without a relink', async () => {
    serve(blob({ watchlistError: 'unavailable' }))
    renderIn(<BucketSection bucket="watchlist" />)
    expect(await screen.findByText('suggestions.tmdbWatchlistUnavailable')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'suggestions.tmdbRelink' })).toBeNull()
  })

  it('an unreadable trending list is named on trending only', async () => {
    serve(blob({ trendingError: 'unavailable', watchlistError: 'unauthorized' }))
    renderIn(<BucketSection bucket="trending" />)
    expect(await screen.findByText('suggestions.tmdbTrendingUnavailable')).toBeInTheDocument()
    expect(screen.queryByText('suggestions.tmdbUnauthorized', { exact: false })).toBeNull()
  })

  it('no note without an error', async () => {
    serve(blob({}))
    renderIn(<BucketSection bucket="watchlist" />)
    expect(await screen.findByText('suggestions.empty')).toBeInTheDocument()
    expect(screen.queryByText(/suggestions\.tmdb/)).toBeNull()
  })
})
