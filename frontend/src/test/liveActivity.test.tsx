import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { LiveActivity } from '../components/LiveActivity'
import { LiveProvider } from '../components/liveState'
import type { SeriesTarget } from '../components/SeriesModal'
import { api } from '../api'
import { TransfersCtx, type Transfers } from '../components/transfers'
import type { Download } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string, o?: { count?: number }) => (o?.count ? `${k}:${o.count}` : k) }) as never,
}))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const dl = (id: number, status: Download['status'], size: number, transferred: number, bytesPerSec = 0): Download =>
  ({
    id,
    status,
    size,
    transferred,
    bytesPerSec,
    remotePath: `/x/${id}.mkv`,
    localPath: '',
    createdAt: '',
    queuePos: id,
    rateLimit: 0,
    serverId: 1,
    userId: 1,
  }) as Download

// the opener the pill reaches; each test sets its own
const transfers: Transfers = { open: () => {}, shown: false }

function setup(
  downloads: Download[],
  open: (from?: HTMLElement | null) => void = () => {},
  openSeries?: (t: SeriesTarget) => void,
) {
  // nothing reaches the network: what a test needs it puts in the cache
  vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => {}))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(['downloads'], downloads)
  transfers.open = open
  const tree = (pill: boolean) => (
    <QueryClientProvider client={qc}>
      <TransfersCtx.Provider value={transfers}>
        <MemoryRouter initialEntries={['/watches']}>
          <LiveProvider openSeries={openSeries}>
            <main>{pill && <LiveActivity variant="pill" />}</main>
          </LiveProvider>
        </MemoryRouter>
      </TransfersCtx.Provider>
    </QueryClientProvider>
  )
  const view = render(tree(true))
  return { qc, ...view, show: (pill: boolean) => view.rerender(tree(pill)) }
}

describe('LiveActivity', () => {
  it('opens the transfers, growing out of the pill', () => {
    const open = vi.fn()
    setup([dl(1, 'running', 100, 50, 10)], open)
    const pill = screen.getByRole('button')
    fireEvent.click(pill)
    expect(open).toHaveBeenCalledWith(pill)
  })

  it('fills the ring with the bytes of the whole queue and counts it', () => {
    const { container } = setup([dl(1, 'running', 100, 50, 10), dl(2, 'queued', 100, 0)])
    expect(screen.getByText('live.loading:2')).toBeTruthy()
    const ring = container.querySelectorAll('circle')[1]
    const c = 2 * Math.PI * 16
    // 50 of 200 bytes: three quarters of the ring still open
    expect(parseFloat(ring.getAttribute('stroke-dashoffset')!)).toBeCloseTo(c * 0.75, 1)
  })

  it('is not there while nothing transfers', () => {
    const { container } = setup([dl(1, 'done', 100, 100)])
    expect(container.textContent).toBe('')
  })

  it('closes into a check when the queue runs dry, then leaves', () => {
    vi.useFakeTimers()
    const { qc, container } = setup([dl(1, 'running', 100, 90, 10)])
    act(() => {
      qc.setQueryData(['downloads'], [dl(1, 'done', 100, 100)])
      // the query hands its update to observers on a timer
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByText('live.done:1')).toBeTruthy()
    act(() => vi.advanceTimersByTime(4100))
    expect(container.textContent).toBe('')
  })

  it('counts only what landed, and leaves without a check when all was canceled', () => {
    vi.useFakeTimers()
    const { qc, container } = setup([dl(1, 'running', 100, 90, 10), dl(2, 'queued', 100, 0), dl(3, 'queued', 100, 0)])
    act(() => {
      qc.setQueryData(['downloads'], [dl(1, 'done', 100, 100), dl(2, 'canceled', 100, 0), dl(3, 'done', 100, 100)])
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByText('live.done:2')).toBeTruthy()
    // the list keeps refreshing during the moment; that must not keep it up
    act(() => {
      qc.setQueryData(['downloads'], [dl(1, 'done', 100, 100), dl(2, 'canceled', 100, 0), dl(3, 'done', 100, 100)])
      vi.advanceTimersByTime(2000)
    })
    act(() => vi.advanceTimersByTime(2100))
    expect(container.textContent).toBe('')
    act(() => {
      qc.setQueryData(['downloads'], [dl(4, 'queued', 100, 0)])
      vi.advanceTimersByTime(1)
    })
    act(() => {
      qc.setQueryData(['downloads'], [dl(4, 'canceled', 100, 0)])
      vi.advanceTimersByTime(1)
    })
    expect(container.textContent).toBe('')
  })

  it('resumes a queue that is all paused, instead of opening the transfers', async () => {
    const open = vi.fn()
    const post = vi.spyOn(api, 'post').mockResolvedValue({})
    setup([dl(1, 'paused', 100, 10), dl(2, 'paused', 100, 0)], open)
    expect(screen.getByText('live.pausedAll')).toBeTruthy()
    expect(screen.getByText('live.tapToResume')).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(post).toHaveBeenCalledWith('/api/downloads/bulk', { action: 'resume', ids: [] })
    expect(open).not.toHaveBeenCalled()
  })

  it('names the episode that landed and opens its series', () => {
    vi.useFakeTimers()
    const openSeries = vi.fn()
    const { qc } = setup([dl(1, 'running', 100, 90, 10)], () => {}, openSeries)
    qc.setQueryData(['downloads', 'meta'], {
      groups: { g: { title: 'Frieren', folder: 'Frieren', serverId: 1, links: {}, watchId: 7 } },
      items: { '1': { g: 'g', episode: 7, season: 1 } },
    })
    qc.setQueryData(['watches'], [{ id: 7, mediaSource: 'anilist', media: { id: 154587 } }])
    act(() => {
      qc.setQueryData(['downloads'], [dl(1, 'done', 100, 100)])
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByText('live.landed')).toBeTruthy()
    expect(screen.getByText('live.tapToWatch')).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(openSeries).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'anilist', id: 154587, watchId: 7, episode: 7, season: 1 }),
    )
  })

  it('keeps the finished moment across a change of page', () => {
    vi.useFakeTimers()
    const { qc, show } = setup([dl(1, 'running', 100, 90, 10)])
    act(() => {
      qc.setQueryData(['downloads'], [dl(1, 'done', 100, 100)])
      vi.advanceTimersByTime(1)
    })
    // the page (and the pill in it) remounts, the shell's state stays
    show(false)
    show(true)
    expect(screen.getByText('live.done:1')).toBeTruthy()
  })

  it('folds to its ring while the page scrolls down and comes back on the way up', () => {
    const { container } = setup([dl(1, 'running', 100, 50, 10)])
    const main = container.querySelector('main')!
    const pill = screen.getByRole('button')
    const scroll = (y: number) => {
      main.scrollTop = y
      fireEvent.scroll(main)
    }
    scroll(10)
    expect(pill).not.toHaveAttribute('data-small')
    scroll(80)
    expect(pill).toHaveAttribute('data-small')
    scroll(40)
    expect(pill).not.toHaveAttribute('data-small')
  })
})
