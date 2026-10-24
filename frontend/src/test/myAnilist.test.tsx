import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MyAnilist } from '../components/MyAnilist'
import { api } from '../api'

const entry = (progress: number) => ({
  linked: true,
  canEdit: true,
  scoreFormat: 'POINT_10',
  episodes: 12,
  entry: { id: 1, status: 'CURRENT', progress, scoreRaw: 0, repeat: 0, updatedAt: 0 },
})

afterEach(() => vi.restoreAllMocks())

describe('MyAnilist progress stepper', () => {
  it('sends quick changes one after the other and ends on the last one, even if an earlier one failed', async () => {
    let server = 3
    vi.spyOn(api, 'get').mockImplementation(async () => entry(server))
    const pending: { n: number; ok: (v: unknown) => void; no: (e: unknown) => void }[] = []
    const put = vi.spyOn(api, 'put').mockImplementation(
      (_url: string, body: unknown) =>
        new Promise((ok, no) => {
          pending.push({ n: (body as { progress: number }).progress, ok, no })
        }),
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <MyAnilist mediaId={5} title="Demo" />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const field = async () => (await screen.findByRole('textbox', { name: 'myAnilist.progress' })) as HTMLInputElement
    await field()
    for (const n of ['4', '5', '6']) {
      fireEvent.click(await screen.findByRole('button', { name: 'myAnilist.more' }))
      await waitFor(async () => expect((await field()).value).toBe(n))
    }

    // only the first goes out; the others wait for it
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    expect(pending.map((p) => p.n)).toEqual([4])
    pending[0].no(new Error('429'))
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2))
    server = 5
    pending[1].ok(entry(5))
    await waitFor(() => expect(put).toHaveBeenCalledTimes(3))
    server = 6
    pending[2].ok(entry(6))
    await waitFor(async () => expect((await field()).value).toBe('6'))
    expect(pending.map((p) => p.n)).toEqual([4, 5, 6])
  })
})
