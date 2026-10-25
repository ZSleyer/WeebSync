import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { api, type Download, type DownloadMeta, type Watch } from '../api'
import { ToastProvider } from '../components/toast'
import { NewShelf } from '../pages/today/NewShelf'

const open = vi.fn()
vi.mock('../components/SeriesModal', () => ({ useSeriesModal: () => ({ open }) }))
vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({
      t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k),
      i18n: { language: 'en' },
    }) as never,
}))

const NOW = Date.parse('2026-10-14T12:00:00Z')
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  open.mockReset()
})

/** the providers the page has: a query client and the toasts a failed mutation lands in */
function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  )
}

const dl = (item: Record<string, unknown>): { d: Download; meta: DownloadMeta } => ({
  d: {
    id: 1,
    serverId: 1,
    remotePath: '/a/Show - 03.mkv',
    localPath: '/media/Show/Show - 03.mkv',
    status: 'done',
    finishedAt: '2026-10-13 10:00:00',
  } as Download,
  meta: { groups: { g1: { title: 'Frieren' } }, items: { '1': { g: 'g1', episode: 3, season: 1, ...item } } } as never,
})

describe('the "new here" tiles', () => {
  it.each([
    ['with chips', { res: 1080, dub: ['de'] }],
    ['without chips', {}],
  ])('name the series, episode and day for a screen reader (%s)', (_n, item) => {
    const { d, meta } = dl(item)
    render(wrap(<NewShelf downloads={[d]} meta={meta} watches={[]} loading={false} />))
    const name = screen.getByRole('button', { name: /Frieren/ }).getAttribute('aria-label')
    expect(name).toContain('Frieren')
    expect(name).toContain('today.epSeason')
    expect(name).toContain('dash.landed')
  })

  it('opens the series at its title, not at the episode that landed', () => {
    const { d, meta } = dl({})
    const media = { id: 154587, title: { romaji: 'Frieren' } }
    const watch = { id: 7, mediaSource: 'anilist', media } as unknown as Watch
    meta.groups.g1 = { ...meta.groups.g1, watchId: 7 } as never
    render(wrap(<NewShelf downloads={[d]} meta={meta} watches={[watch]} loading={false} />))
    fireEvent.click(screen.getByRole('button', { name: /Frieren/ }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0][0]).toEqual({ source: 'anilist', id: 154587, media, watchId: 7, title: undefined })
  })
})

describe('the "new here" menu', () => {
  const media = { id: 154587, title: { romaji: 'Frieren' } }
  const watch = { id: 7, mediaSource: 'anilist', media } as unknown as Watch
  const target = { source: 'anilist', id: 154587, media, watchId: 7, title: undefined }

  /**
   * The shelf as the page feeds it: the downloads come from the ['downloads']
   * query, so a removal only shows if the menu invalidates that very key.
   */
  function Page({ list, meta }: { list: Download[]; meta: DownloadMeta }) {
    const { data } = useQuery({ queryKey: ['downloads'], queryFn: () => Promise.resolve([...list]) })
    return <NewShelf downloads={data ?? []} meta={meta} watches={[watch]} loading={!data} />
  }
  const mount = () => {
    const { d, meta } = dl({})
    meta.groups.g1 = { ...meta.groups.g1, watchId: 7 } as never
    const list = [d]
    render(wrap(<Page list={list} meta={meta} />))
    return { d, list }
  }
  const menu = () => screen.getByRole('dialog', { name: 'Frieren, today.epSeason:{"s":1,"e":3}' })

  it('opens on a right click or the keyboard menu key, named after the episode', async () => {
    mount()
    const tile = await screen.findByRole('button', { name: /Frieren/ })
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => {
      tile.dispatchEvent(ev)
    })
    // the browser's own menu gives way to the tile's
    expect(ev.defaultPrevented).toBe(true)
    const sheet = menu()
    expect(within(sheet).getByRole('button', { name: 'dash.openSeries' })).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'dash.removeSelected' })).toBeInTheDocument()
    expect(open).not.toHaveBeenCalled()
  })

  it('opens on a long press, and the press does not also open the series', async () => {
    mount()
    const tile = await screen.findByRole('button', { name: /Frieren/ })
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    fireEvent.pointerDown(tile, { pointerType: 'touch', clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(450))
    fireEvent.pointerUp(tile)
    fireEvent.click(tile)
    vi.useFakeTimers({ toFake: ['Date'] })
    expect(within(menu()).getByRole('button', { name: 'dash.removeSelected' })).toBeInTheDocument()
    expect(open).not.toHaveBeenCalled()
  })

  it('opens the series from the menu and hands focus back to the tile', async () => {
    mount()
    const tile = await screen.findByRole('button', { name: /Frieren/ })
    fireEvent.contextMenu(tile)
    fireEvent.click(within(menu()).getByRole('button', { name: 'dash.openSeries' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(open.mock.calls[0][0]).toEqual(target)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(tile).toHaveFocus()
  })

  it('removes the download the way the queue does, and the tile leaves the shelf', async () => {
    const { d, list } = mount()
    const del = vi.spyOn(api, 'del').mockImplementation(() => {
      list.length = 0
      return Promise.resolve(undefined as never)
    })
    fireEvent.contextMenu(await screen.findByRole('button', { name: /Frieren/ }))
    fireEvent.click(within(menu()).getByRole('button', { name: 'dash.removeSelected' }))
    await waitFor(() => expect(del).toHaveBeenCalledWith(`/api/downloads/${d.id}`))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Frieren/ })).toBeNull())
  })

  it('moves the focus on to the next tile once a removed one leaves the shelf', async () => {
    const { d, meta } = dl({})
    meta.groups.g1 = { ...meta.groups.g1, watchId: 7 } as never
    meta.groups.g2 = { title: 'Dandadan' } as never
    meta.items['2'] = { g: 'g2', episode: 5 } as never
    const other = { ...d, id: 2, localPath: '/media/Dan/Dan - 05.mkv', finishedAt: '2026-10-12 10:00:00' } as Download
    const list = [d, other]
    vi.spyOn(api, 'del').mockImplementation(() => {
      list.splice(0, 1)
      return Promise.resolve(undefined as never)
    })
    render(wrap(<Page list={list} meta={meta} />))
    fireEvent.contextMenu(await screen.findByRole('button', { name: /Frieren/ }))
    fireEvent.click(within(menu()).getByRole('button', { name: 'dash.removeSelected' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Frieren/ })).toBeNull())
    expect(screen.getByRole('button', { name: /Dandadan/ })).toHaveFocus()
  })

  it('says so when the removal fails, and the tile stays', async () => {
    mount()
    const del = vi.spyOn(api, 'del').mockRejectedValue(new Error('nope'))
    fireEvent.contextMenu(await screen.findByRole('button', { name: /Frieren/ }))
    fireEvent.click(within(menu()).getByRole('button', { name: 'dash.removeSelected' }))
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1))
    const alert = await screen.findByText(/common\.actionFailed.*nope/)
    expect(alert.closest('[role=alert]')).not.toBeNull()
    expect(screen.getByRole('button', { name: /Frieren/ })).toBeInTheDocument()
  })

  it('still opens the series on a plain click', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Frieren/ }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0][0]).toEqual(target)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
