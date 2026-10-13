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
