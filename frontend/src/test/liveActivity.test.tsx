import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { LiveActivity } from '../components/LiveActivity'
import { TransfersCtx, type Transfers } from '../components/transfers'
import type { Download } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string, o?: { count?: number }) => (o?.count ? `${k}:${o.count}` : k) }) as never,
}))

afterEach(() => vi.useRealTimers())

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
const transfers: Transfers = { open: () => {} }

function setup(downloads: Download[], open: (from?: HTMLElement | null) => void = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(['downloads'], downloads)
  transfers.open = open
  const view = render(
    <QueryClientProvider client={qc}>
      <TransfersCtx.Provider value={transfers}>
        <MemoryRouter initialEntries={['/watches']}>
          <LiveActivity variant="pill" />
        </MemoryRouter>
      </TransfersCtx.Provider>
    </QueryClientProvider>,
  )
  return { qc, ...view }
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
    const c = 2 * Math.PI * 15
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
})
