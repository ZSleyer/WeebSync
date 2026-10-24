import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { MatchesPage } from '../pages/settings/Matching'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

afterEach(() => vi.restoreAllMocks())

const stat = { serverId: 1, name: 'srv', source: 'tmdb:tv', total: 1, matched: 0, unmatched: 1, manual: 0 }
const entry = { folder: '/Show', mediaId: 0, manual: 0, source: 'tmdb:tv', title: '' }

describe('match correction search', () => {
  it('shows why a search failed instead of an empty result list', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url.startsWith('/api/tmdb/search')) throw new Error('TMDB key missing')
      if (url.startsWith('/api/admin/matches')) return { total: 1, entries: [entry] }
      return { matches: [stat] }
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/m/1/tmdb:tv']}>
          <Routes>
            <Route path="/m/:server/:source" element={<MatchesPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'settings.jobs.correct: Show' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('TMDB key missing')
    // a search that works again clears it
    vi.spyOn(api, 'get').mockResolvedValue([])
    fireEvent.click(screen.getByRole('button', { name: 'remote.search' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})
