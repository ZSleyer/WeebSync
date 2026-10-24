import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import MatchRouting from '../pages/settings/MatchRouting'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({ t: (k: string, o?: Record<string, string>) => (o ? `${k} ${Object.values(o).join(' ')}` : k) }) as never,
}))

afterEach(() => vi.restoreAllMocks())

const list = (...names: string[]) =>
  names.map((n) => ({ provider: n.replace('-', '') as 'anilist' | 'tvdb' | 'tmdb', enabled: !n.startsWith('-') }))

const routing = () => ({
  providers: { anilist: true, tvdb: true, tmdb: true },
  animeSeries: list('anilist', 'tvdb', 'tmdb'),
  animeMovie: list('anilist', 'tmdb', 'tvdb'),
  series: list('-anilist', 'tvdb', 'tmdb'),
  movie: list('-anilist', 'tmdb', 'tvdb'),
})

function setup(over: { tvdbApiKeySet?: boolean; tmdbApiKeySet?: boolean } = {}) {
  const state = { matchRouting: routing(), tvdbApiKeySet: true, tmdbApiKeySet: true, ...over }
  vi.spyOn(api, 'get').mockResolvedValue(state)
  const put = vi.spyOn(api, 'put').mockImplementation(async (_url, body) => ({ ...state, ...(body as object) }))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MatchRouting />
    </QueryClientProvider>,
  )
  return put
}

describe('MatchRouting', () => {
  it('shows the four lists in their order', async () => {
    setup()
    expect(await screen.findByText('settings.routing.list.animeSeries')).toBeTruthy()
    for (const k of ['animeSeries', 'animeMovie', 'series', 'movie']) {
      expect(screen.getByText(`settings.routing.list.${k}`)).toBeTruthy()
    }
    const rows = screen.getByRole('region', { name: 'settings.routing.list.animeMovie' }).querySelectorAll('li')
    expect([...rows].map((r) => r.textContent)).toEqual([
      'settings.routing.provider.anilist',
      'settings.routing.provider.tmdb',
      'settings.routing.provider.tvdb',
    ])
  })

  it('moves a provider down with its button and saves the order', async () => {
    const put = setup()
    await screen.findByText('settings.routing.list.animeSeries')
    // the first list's AniList moves one place down
    fireEvent.click(screen.getAllByLabelText('settings.routing.down settings.routing.provider.anilist')[0])
    await waitFor(() => expect(put).toHaveBeenCalled())
    const body = put.mock.calls[0][1] as { matchRouting: ReturnType<typeof routing> }
    expect(body.matchRouting.animeSeries.map((e) => e.provider)).toEqual(['tvdb', 'anilist', 'tmdb'])
    expect(body.matchRouting.animeMovie.map((e) => e.provider)).toEqual(['anilist', 'tmdb', 'tvdb'])
  })

  it('moves a provider with the arrow keys on its handle', async () => {
    const put = setup()
    await screen.findByText('settings.routing.list.animeSeries')
    // the TMDB handle of the first list: up one place
    fireEvent.keyDown(screen.getAllByLabelText(/^settings\.routing\.reorder settings\.routing\.provider\.tmdb/)[0], {
      key: 'ArrowUp',
    })
    await waitFor(() => expect(put).toHaveBeenCalled())
    const body = put.mock.calls[0][1] as { matchRouting: ReturnType<typeof routing> }
    expect(body.matchRouting.animeSeries.map((e) => e.provider)).toEqual(['anilist', 'tmdb', 'tvdb'])
  })

  it('switches one entry of a list off and saves', async () => {
    const put = setup()
    await screen.findByText('settings.routing.list.animeSeries')
    fireEvent.click(
      screen.getAllByRole('switch', { name: /^settings\.routing\.use settings\.routing\.provider\.tvdb/ })[0],
    )
    await waitFor(() => expect(put).toHaveBeenCalled())
    const body = put.mock.calls[0][1] as { matchRouting: ReturnType<typeof routing> }
    expect(body.matchRouting.animeSeries.find((e) => e.provider === 'tvdb')?.enabled).toBe(false)
    expect(body.matchRouting.series.find((e) => e.provider === 'tvdb')?.enabled).toBe(true)
  })

  it('turns a provider off for matching altogether', async () => {
    const put = setup()
    await screen.findByText('settings.routing.list.animeSeries')
    fireEvent.click(screen.getByRole('switch', { name: /^settings\.routing\.provider\.anilist/ }))
    await waitFor(() => expect(put).toHaveBeenCalled())
    const body = put.mock.calls[0][1] as { matchRouting: ReturnType<typeof routing> }
    expect(body.matchRouting.providers).toEqual({ anilist: false, tvdb: true, tmdb: true })
  })

  it('shows a provider without a key as off and cannot switch it on', async () => {
    setup({ tvdbApiKeySet: false })
    await screen.findByText('settings.routing.list.animeSeries')
    const sw = screen.getByRole('switch', { name: /^settings\.routing\.provider\.tvdb/ }) as HTMLInputElement
    expect(sw.checked).toBe(false)
    expect(sw.disabled).toBe(true)
    expect(screen.getByText('settings.routing.noKey', { exact: false })).toBeTruthy()
  })

  it('keeps every key press of a held arrow while the first save is in flight', async () => {
    const state = { matchRouting: routing(), tvdbApiKeySet: true, tmdbApiKeySet: true }
    vi.spyOn(api, 'get').mockImplementation(async () => structuredClone(state))
    const releases: (() => void)[] = []
    const put = vi.spyOn(api, 'put').mockImplementation(
      (_url, body) =>
        new Promise((res) =>
          releases.push(() => {
            Object.assign(state, body)
            res({ ...state })
          }),
        ),
    )
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MatchRouting />
      </QueryClientProvider>,
    )
    await screen.findByText('settings.routing.list.animeSeries')
    const grip = () => screen.getAllByLabelText(/^settings\.routing\.reorder settings\.routing\.provider\.anilist/)[0]
    const order = () =>
      [...screen.getByRole('region', { name: 'settings.routing.list.animeSeries' }).querySelectorAll('li')].map(
        (r) => r.textContent,
      )
    fireEvent.keyDown(grip(), { key: 'ArrowDown' })
    // the list moves at once, before the server has answered
    await waitFor(() => expect(order()[1]).toBe('settings.routing.provider.anilist'))
    fireEvent.keyDown(grip(), { key: 'ArrowDown' })
    await waitFor(() => expect(order()[2]).toBe('settings.routing.provider.anilist'))
    releases[0]()
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2))
    releases[1]()
    const last = put.mock.calls[1][1] as { matchRouting: ReturnType<typeof routing> }
    expect(last.matchRouting.animeSeries.map((e) => e.provider)).toEqual(['tvdb', 'tmdb', 'anilist'])
  })

  it('says so when nothing is left to match with', async () => {
    const state = {
      matchRouting: { ...routing(), providers: { anilist: false, tvdb: false, tmdb: false } },
      tvdbApiKeySet: true,
      tmdbApiKeySet: true,
    }
    vi.spyOn(api, 'get').mockResolvedValue(state)
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MatchRouting />
      </QueryClientProvider>,
    )
    expect(await screen.findByText('settings.routing.allOff')).toBeTruthy()
  })
})
