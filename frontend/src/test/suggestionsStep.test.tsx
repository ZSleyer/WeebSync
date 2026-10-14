import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SeriesModalProvider } from '../components/SeriesModal'
import { BucketSection } from '../pages/Suggestions'
import { api, type SuggestionItem } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'de' } }) as never,
}))

const item = {
  refKey: 'a:9',
  title: 'Demo Show',
  category: 'watching',
  status: 'CURRENT',
  progress: 3,
  candidates: [],
  links: {},
  media: { id: 9, title: { romaji: 'Demo Show' }, episodes: 12 },
} as unknown as SuggestionItem

function renderWatchlist(allowList: boolean) {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/anilist/me')
      return { configured: false, clientId: '1', connected: true, allow: { list: allowList, social: false } } as never
    if (url === '/api/suggestions')
      return { watchlist: [item], recommended: [], trending: [], incomplete: [], building: false } as never
    if (url === '/api/auth/me') return { id: 1, email: 'demo@example.com' } as never
    return [] as never
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <SeriesModalProvider>
          <BucketSection bucket="watchlist" />
        </SeriesModalProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('the +1 on the suggestions page', () => {
  it('is not offered while list changes are off, a line says where to allow them', async () => {
    renderWatchlist(false)
    const link = await screen.findByRole('link', { name: 'suggestions.plusOneAllow' })
    expect(link.getAttribute('href')).toBe('/settings/integrations#anilist')
    // +1 was the row's only action here, so the menu is gone with it
    expect(screen.queryByRole('button', { name: 'discover.more' })).toBeNull()
    expect(screen.queryByText('suggestions.plusOne')).toBeNull()
  })

  it('is offered once they are allowed', async () => {
    renderWatchlist(true)
    fireEvent.click(await screen.findByRole('button', { name: 'discover.more' }))
    expect(await screen.findByText('suggestions.plusOne')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'suggestions.plusOneAllow' })).toBeNull()
    expect(within(document.body).queryByText('suggestions.plusOneOff')).toBeNull()
  })
})
