import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { api } from '../api'
import History from '../pages/History'
import Dashboard from '../pages/Dashboard'

vi.mock('../components/SeriesModal', () => ({ useSeriesModal: () => ({ open: () => {} }) }))
vi.mock('../components/transfers', () => ({ useTransfers: () => ({ open: () => {} }) }))
vi.mock('../pages/today/HeroBanner', () => ({
  HeroBanner: ({ status }: { status: unknown[] }) => <p data-testid="status">{status.join('|')}</p>,
}))
vi.mock('../pages/today/NewShelf', () => ({ NewShelf: () => null }))
vi.mock('../pages/today/Agenda', () => ({ Agenda: () => null }))
vi.mock('../pages/today/shared', async (orig) => ({ ...(await orig<object>()), useAfterFirstPaint: () => true }))
vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({
      t: (k: string, o?: Record<string, unknown>) => (o?.count !== undefined ? `${k}:${o.count}` : k),
      i18n: { language: 'en' },
    }) as never,
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function view(ui: React.ReactNode, get: (url: string) => Promise<unknown>) {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.spyOn(api, 'get').mockImplementation(((url: string) => get(url)) as never)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

const down = (url: string) =>
  url === '/api/downloads'
    ? Promise.reject(new Error('503'))
    : Promise.resolve(
        url === '/api/downloads/meta' ? { items: {}, groups: {} } : url.startsWith('/api/catalog') ? {} : [],
      )

describe('when /api/downloads fails', () => {
  it('History shows an error with a retry, not "no entries"', async () => {
    view(<History />, down)
    expect(await screen.findByText('today.loadFailed')).toBeTruthy()
    expect(screen.queryByText('history.none')).toBeNull()
    const calls = vi.mocked(api.get).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'today.loadRetry' }))
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.length).toBeGreaterThan(calls))
  })

  it('announces the failure, a failing retry and the recovery, and keeps focus off the body', async () => {
    let up = false
    let fails = 0
    const flaky = (url: string) => {
      if (url !== '/api/downloads') return down(url)
      if (up) return Promise.resolve([])
      fails++
      return Promise.reject(new Error('503'))
    }
    view(<History />, flaky)
    // the live region exists, and the failure lands in it
    const region = screen.getByRole('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(await within(region).findByText('today.loadFailed')).toBeTruthy()
    // a second failure is announced anew: the region changes while it runs
    const seen: string[] = []
    new MutationObserver(() => seen.push(region.textContent ?? '')).observe(region, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    const link = () => within(region).getByRole('button', { name: 'today.loadRetry' })
    link().focus()
    fireEvent.click(link())
    // the link stays mounted and focused while it runs and after it failed
    expect(document.activeElement).toBe(link())
    await waitFor(() => expect(fails).toBe(2))
    await waitFor(() => expect(region.textContent).toContain('today.loadFailed'))
    expect(seen.some((s) => s.includes('today.loadRetrying'))).toBe(true)
    expect(document.activeElement).toBe(link())
    // a retry that works: announced, never the failure in between, focus not on the body
    up = true
    seen.length = 0
    fireEvent.click(link())
    await waitFor(() => expect(region.textContent).toContain('today.loadRecovered'))
    await new Promise((r) => setTimeout(r, 20))
    expect(region.textContent).toContain('today.loadRecovered')
    expect(seen.some((s) => s.includes('today.loadFailed'))).toBe(false)
    expect(document.activeElement).toBe(region)
  })

  it('Today does not call the failure quiet or nothing open', async () => {
    view(<Dashboard />, down)
    // the needs and the transfers both say so
    await waitFor(() => expect(screen.getAllByText('today.loadFailed')).toHaveLength(2))
    expect(screen.queryByText('today.nothingOpen')).toBeNull()
    expect(screen.getByTestId('status').textContent).not.toContain('today.quiet')
  })
})
