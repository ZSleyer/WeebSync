import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { api, type DetectedMarks as Data } from '../api'
import { DetectedMarks } from '../pages/settings/DetectedMarks'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.kind ? `${k}:${o.kind}` : k) }) as never,
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const mark = (name: string, extra = {}) => ({
  serverId: 1,
  serverName: 'seedbox',
  path: `/Server/${name}`,
  name,
  kind: 'auto' as const,
  detectedAt: 1000,
  titles: { total: 0, matched: { anilist: 0, tvdb: 0, tmdb: 0 }, noMatch: 0, pending: 0 },
  unseen: true,
  ...extra,
})

function setup(initial: Data) {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  let data = initial
  const get = vi
    .spyOn(api, 'get')
    .mockImplementation(async (p: string) => (p.includes('detected-marks') ? data : {}) as never)
  const post = vi.spyOn(api, 'post').mockImplementation(async () => {
    // the server stops counting them as new once it is told
    data = { ...data, unseen: 0, items: data.items.map((m) => ({ ...m, unseen: false })) }
    return {} as never
  })
  const put = vi.spyOn(api, 'put').mockResolvedValue({} as never)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DetectedMarks />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { get, post, put }
}

describe('the list of automatic marks', () => {
  it('shows nothing while nothing was detected', async () => {
    const { get } = setup({ items: [], unseen: 0 })
    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(screen.queryByText('servers.detected')).toBeNull()
  })

  it('lists the marks, flags the new ones and tells the server it was looked at', async () => {
    const { post } = setup({
      items: [mark('Some Category'), mark('Older', { unseen: false, kind: 'anime' })],
      unseen: 1,
    })
    expect(await screen.findByText('Some Category')).toBeTruthy()
    expect(screen.getByText('Older')).toBeTruthy()
    // only the new one carries the flag, and it stays after the server stopped counting
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/catalog/detected-marks/seen'))
    expect(screen.getAllByText('servers.detectedNew')).toHaveLength(1)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('stores the user decision: another kind or no mark', async () => {
    const { put } = setup({ items: [mark('Some Category')], unseen: 0 })
    fireEvent.click(await screen.findByRole('button', { name: /servers\.detectedActions/ }))
    fireEvent.click(await screen.findByText('servers.detectedAs:remote.scopeAnime'))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/servers/1/catalog/scope', {
        path: '/Server/Some Category',
        kind: 'anime',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /servers\.detectedActions/ }))
    fireEvent.click(await screen.findByText('servers.detectedNone'))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/servers/1/catalog/scope', { path: '/Server/Some Category', kind: 'none' }),
    )
  })
})
