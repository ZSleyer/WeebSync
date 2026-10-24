import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CheckButton } from '../components/CheckButton'
import type { Download, WatchCheck } from '../api'
import type { useWatchActions } from '../components/watchActions'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({
      t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${Object.values(o).join('/')}` : k),
    }) as never,
}))

afterEach(() => vi.useRealTimers())

const dl = (id: number, status: Download['status'], transferred = 0): Download =>
  ({ id, status, size: 100, transferred, remotePath: `/x/${id}.mkv` }) as Download

function setup(answer: WatchCheck) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(['downloads'], [dl(7, 'queued'), dl(8, 'queued')])
  const check = vi.fn(async () => answer)
  const actions = { check } as unknown as ReturnType<typeof useWatchActions>
  render(
    <QueryClientProvider client={qc}>
      <CheckButton watchId={1} act={actions} />
    </QueryClientProvider>,
  )
  return { qc, check }
}

describe('CheckButton', () => {
  it('follows the downloads its check started, episode by episode', async () => {
    const { qc, check } = setup({ status: 'checked', queued: [7, 8] })
    await act(async () => fireEvent.click(screen.getByRole('button')))
    expect(check).toHaveBeenCalledWith(1)
    expect(screen.getByRole('button').textContent).toContain('watch.checkLoading:1/2')
    await act(async () => qc.setQueryData(['downloads'], [dl(7, 'done', 100), dl(8, 'running', 50)]))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('watch.checkLoading:2/2'))
    await act(async () => qc.setQueryData(['downloads'], [dl(7, 'done', 100), dl(8, 'done', 100)]))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('watch.checkDone:2'))
  })

  it('says when a check found nothing new', async () => {
    setup({ status: 'checked' })
    await act(async () => fireEvent.click(screen.getByRole('button')))
    expect(screen.getByRole('button').textContent).toContain('watch.checkNothing')
  })
})

describe('CheckButton failures and vanishing rows', () => {
  it('does not call failed downloads downloaded', async () => {
    const { qc } = setup({ status: 'checked', queued: [7, 8] })
    await act(async () => fireEvent.click(screen.getByRole('button')))
    await act(async () => qc.setQueryData(['downloads'], [dl(7, 'done', 100), dl(8, 'error', 10)]))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('watch.checkFailedDl:1'))
    expect(screen.getByRole('button').textContent).not.toContain('watch.checkDone')
  })

  it('shows failure on the sync button instead of all here', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    qc.setQueryData(['downloads'], [dl(7, 'queued'), dl(8, 'queued')])
    const check = vi.fn(async () => ({ status: 'checked', queued: [7, 8] }) as WatchCheck)
    render(
      <QueryClientProvider client={qc}>
        <CheckButton watchId={1} act={{ check } as unknown as ReturnType<typeof useWatchActions>} variant="sync" />
      </QueryClientProvider>,
    )
    const b = screen.getByRole('button')
    await act(async () => fireEvent.click(b))
    await act(async () => qc.setQueryData(['downloads'], [dl(7, 'done', 100), dl(8, 'canceled', 0)]))
    await waitFor(() => expect(b).toHaveAttribute('data-state', 'error'))
    expect(b.textContent).not.toContain('series.sync.allHere')
    expect(b.textContent).toContain('watch.checkFailedDl:1')
  })

  it('becomes a button again when the followed rows are removed', async () => {
    const { qc, check } = setup({ status: 'checked', queued: [7, 8] })
    await act(async () => fireEvent.click(screen.getByRole('button')))
    await act(async () => qc.setQueryData(['downloads'], []))
    await waitFor(() => expect(screen.getByRole('button')).not.toHaveAttribute('aria-busy', 'true'))
    await act(async () => fireEvent.click(screen.getByRole('button')))
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('announces progress from a live region beside the button, not inside it', async () => {
    setup({ status: 'checked' })
    const b = screen.getByRole('button')
    expect(b.querySelector('[role="status"]')).toBeNull()
    await act(async () => fireEvent.click(b))
    expect(screen.getByRole('status').textContent).toBe('watch.checkNothing')
    expect(b.contains(screen.getByRole('status'))).toBe(false)
  })
})

describe('CheckButton as the sync button', () => {
  it('fills while the missing episodes load and settles on all here', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    qc.setQueryData(['downloads'], [dl(7, 'queued'), dl(8, 'queued')])
    const check = vi.fn(async () => ({ status: 'checked', queued: [7, 8] }) as WatchCheck)
    render(
      <QueryClientProvider client={qc}>
        <CheckButton
          watchId={1}
          act={{ check } as unknown as ReturnType<typeof useWatchActions>}
          variant="sync"
          label="2 laden"
        />
      </QueryClientProvider>,
    )
    const b = screen.getByRole('button')
    expect(b).toHaveClass('ws-syncbtn')
    expect(b).toHaveAttribute('data-state', 'idle')
    expect(b.textContent).toContain('2 laden')
    await act(async () => fireEvent.click(b))
    expect(b).toHaveAttribute('data-state', 'run')
    await act(async () => qc.setQueryData(['downloads'], [dl(7, 'done', 100), dl(8, 'running', 50)]))
    await waitFor(() => expect(b.style.getPropertyValue('--p')).toBe('0.75'))
    await act(async () => qc.setQueryData(['downloads'], [dl(7, 'done', 100), dl(8, 'done', 100)]))
    await waitFor(() => expect(b).toHaveAttribute('data-state', 'done'))
    expect(b.textContent).toContain('series.sync.allHere')
  })
})
