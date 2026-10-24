import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Data from '../pages/settings/Data'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({
      t: (k: string, o?: Record<string, string>) => (o ? `${k} ${Object.values(o).join(' ')}` : k),
      i18n: { language: 'en' },
    }) as never,
}))

afterEach(() => vi.restoreAllMocks())

const store = (name: string) => ({
  name,
  kind: 'cache',
  tables: [],
  rows: 1,
  bytes: 0,
  oldest: '',
  newest: '',
  ttlSec: 0,
  stale: 0,
  pruneSec: 0,
  prunable: 0,
  rebuild: '',
  needs: [],
  keptOnReset: false,
})

function setup() {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/admin/jobs')
      return {
        running: [],
        matchQueue: 0,
        plex: { configured: true, suggestionsAt: '', ttlSec: 0 },
        anilist: { accounts: 1 },
        index: { tickSec: 1, recheckSec: 1, servers: [] },
        watch: { intervalMin: 1, count: 0 },
        matches: [],
        logLevel: 'info',
        ttl: { anilistH: 24, tmdbH: 24, plexH: 6 },
      } as never
    if (url === '/api/admin/data')
      return { stores: [store('cache:anilist-media'), store('cache:tmdb-media'), store('cache:plex')] } as never
    return {} as never
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <Data />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

const field = async (id: string) => {
  await waitFor(() => expect(document.getElementById(id)).toBeTruthy())
  return document.getElementById(id) as HTMLInputElement
}
const type = (el: HTMLInputElement, v: string) => {
  fireEvent.change(el, { target: { value: v } })
  fireEvent.blur(el)
}

describe('TTL editor', () => {
  it('puts the stored value back when the server refuses the typed one', async () => {
    setup()
    vi.spyOn(api, 'put').mockRejectedValue(new Error('hours must be 0..720 (0 = default)'))
    const el = await field('ttl-anilist')
    expect(el.value).toBe('24')
    type(el, '721')
    await screen.findByText('hours must be 0..720 (0 = default)')
    await waitFor(() => expect((document.getElementById('ttl-anilist') as HTMLInputElement).value).toBe('24'))
  })

  it('shows the stored value when the refusal is followed by a failed refetch', async () => {
    setup()
    const get = vi.mocked(api.get)
    const el = await field('ttl-anilist')
    vi.spyOn(api, 'put').mockRejectedValue(new Error('hours must be 0..720 (0 = default)'))
    const real = get.getMockImplementation()!
    get.mockImplementation(async (url: string) => {
      if (url === '/api/admin/jobs') throw new Error('offline')
      return real(url)
    })
    type(el, '721')
    await screen.findByText('hours must be 0..720 (0 = default)')
    await waitFor(() => expect((document.getElementById('ttl-anilist') as HTMLInputElement).value).toBe('24'))
  })

  it('sends only the changed key and keeps both edits shown before the refetch', async () => {
    setup()
    const put = vi.spyOn(api, 'put').mockImplementation(() => new Promise(() => {}))
    type(await field('ttl-anilist'), '10')
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    type(await field('ttl-tmdb'), '11')
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2))
    expect(put.mock.calls[0][1]).toEqual({ anilistH: 10 })
    expect(put.mock.calls[1][1]).toEqual({ tmdbH: 11 })
    expect((document.getElementById('ttl-anilist') as HTMLInputElement).value).toBe('10')
    expect((document.getElementById('ttl-plex') as HTMLInputElement).value).toBe('6')
  })
})
