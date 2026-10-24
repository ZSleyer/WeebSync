import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SeriesModalProvider } from '../components/SeriesModal'
import { BucketSection, DuplicatesSection, IgnoredSection, UpgradesSection } from '../pages/Suggestions'
import Watches from '../pages/Watches'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'de' } }) as never,
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}))

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

// every list endpoint fails; the session itself is fine
function failing() {
  return vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/auth/me') return { id: 1, email: 'demo@example.com' } as never
    if (url === '/api/anilist/me') return { configured: false, connected: false, allow: {} } as never
    if (url === '/api/suggestions' || url === '/api/suggestions/dismissed' || url === '/api/watches')
      throw new Error('boom')
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

const sections: [string, React.ReactNode, string][] = [
  ['suggestions bucket', <BucketSection key="b" bucket="recommended" />, 'suggestions.empty'],
  ['upgrades', <UpgradesSection key="u" />, 'suggestions.noUpgrades'],
  ['duplicates', <DuplicatesSection key="d" />, 'discover.empty.duplicates'],
  ['ignored', <IgnoredSection key="i" />, 'discover.empty.ignored'],
]

describe('a failed load is not an empty list', () => {
  it.each(sections)('%s shows the error with a retry, not the empty note', async (_n, ui, empty) => {
    const get = failing()
    renderIn(ui)
    expect(await screen.findByRole('alert')).toHaveTextContent('discover.loadFailed')
    expect(screen.queryByText(empty)).toBeNull()
    const calls = get.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'app.tryAgain' }))
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(calls))
  })

  it('the watches page shows the error with a retry, not the "no watches" text', async () => {
    const get = failing()
    renderIn(<Watches />)
    expect(await screen.findByText('watch.loadFailed')).toBeInTheDocument()
    expect(screen.queryByText('watch.empty')).toBeNull()
    const calls = get.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'app.tryAgain' }))
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(calls))
  })
})
