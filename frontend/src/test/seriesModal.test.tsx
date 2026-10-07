import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes, Link, useNavigate } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import {
  BackToCard,
  SeriesCardView,
  SeriesModalProvider,
  TITLE_PATH,
  useSeriesModal,
  type SeriesTarget,
} from '../components/SeriesModal'
import { api, type Media, type Watch } from '../api'

// keys instead of strings, with the name interpolated where a label carries one
vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.name ? `${k}:${o.name}` : k) }) as never,
}))

const media = {
  id: 7,
  title: { romaji: 'Frieren', english: 'Frieren' },
  coverImage: { large: '/c.jpg' },
  bannerImage: '',
  episodes: 28,
  seasonYear: 2023,
  format: 'TV',
  status: 'FINISHED',
  averageScore: 90,
  genres: ['Adventure'],
  description: 'Eine Elfe.',
} as Media
const sequel = { id: 8, title: { romaji: 'Frieren 2' }, coverImage: { large: '/d.jpg' }, seasonYear: 2026 } as Media
const watch = (id: number): Watch =>
  ({
    id,
    serverName: 'srv',
    remotePath: `/x/Frieren${id}`,
    localPath: '/media',
    mediaSource: 'anilist',
    media,
    localFiles: 10,
    active: 0,
    complete: false,
    lastResult: '',
    lastUploading: 0,
    lastQueued: 0,
    nextCheck: 0,
    lastCheck: '',
    langWaiting: 0,
    waiting: false,
  }) as unknown as Watch

let target: SeriesTarget = { id: 7, media }
// a page as the catalog is one: it owns a form and shows it inside the card
// when the card's action asks for it
let formClosed = 0
function Opener() {
  const { open } = useSeriesModal()
  const [form, setForm] = useState(false)
  const back = useNavigate()
  return (
    <>
      <button onClick={() => open(target)}>öffnen</button>
      <button
        onClick={() =>
          open({
            ...target,
            actions: [{ key: 'sync', label: 'Jetzt syncen', primary: true, onClick: () => setForm(true) }],
          })
        }
      >
        mit Formular
      </button>
      <Link to="/elsewhere">weg</Link>
      <button onClick={() => back(-1)}>zurück</button>
      {form && (
        <SeriesCardView
          onClose={() => {
            formClosed++
            setForm(false)
          }}
        >
          {(v) => (
            <div className={`dialog-body ${v.className}`}>
              <BackToCard onClick={v.onBack} />
              <h3>Sync-Formular</h3>
            </div>
          )}
        </SeriesCardView>
      )}
    </>
  )
}

function app(at = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[at]}>
        <SeriesModalProvider>
          <Routes>
            <Route path="/" element={<Opener />} />
            <Route path={TITLE_PATH} element={<Opener />} />
            <Route path="/elsewhere" element={<p>anderswo</p>} />
          </Routes>
        </SeriesModalProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// routes the card's requests: the watch list, the extras, the reviews, a
// related record
function serve({ watches = [] as Watch[], extras = undefined as unknown, reviews = { reviews: [] } } = {}) {
  return vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/watches') return watches
    if (url.startsWith('/api/media/extras')) {
      if (extras === undefined) throw new Error('502 down')
      return extras
    }
    if (url.startsWith('/api/media/reviews')) return reviews
    if (url === '/api/anilist/media/8') return { ...sequel, description: 'Teil zwei.' }
    if (url === '/api/anilist/media/7') return media
    if (url.startsWith('/api/watches/') && url.endsWith('/episodes')) return { episodes: [] }
    throw new Error('unexpected ' + url)
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  target = { id: 7, media }
})

// An IntersectionObserver the test drives: jsdom has none, and the card then
// loads everything at once - which is what the other tests rely on.
class FakeIO {
  static all: FakeIO[] = []
  els = new Set<Element>()
  cb: IntersectionObserverCallback
  opts: IntersectionObserverInit
  constructor(cb: IntersectionObserverCallback, opts: IntersectionObserverInit = {}) {
    this.cb = cb
    this.opts = opts
    FakeIO.all.push(this)
  }
  observe(el: Element) {
    this.els.add(el)
  }
  unobserve(el: Element) {
    this.els.delete(el)
  }
  disconnect() {
    this.els.clear()
  }
  fire(el: Element, isIntersecting: boolean) {
    act(() => this.cb([{ target: el, isIntersecting } as IntersectionObserverEntry], this as never))
  }
}
const observers = () => {
  const live = FakeIO.all.filter((o) => o.els.size > 0)
  return {
    spy: live.find((o) => !o.opts.rootMargin?.endsWith('100% 0px'))!,
    ahead: live.find((o) => o.opts.rootMargin?.endsWith('100% 0px'))!,
  }
}

describe('SeriesModalProvider', () => {
  it('opens the one title card with the record and the caller rows', () => {
    serve()
    target = { id: 7, media, extra: <p>Versionen: 2</p> }
    app()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByText('öffnen'))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Frieren')
    expect(dialog).toHaveTextContent('Eine Elfe.')
    expect(dialog).toHaveTextContent('Versionen: 2')
  })

  it('closes when the route changes', () => {
    serve()
    app()
    fireEvent.click(screen.getByText('öffnen'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByText('weg'))
    expect(screen.getByText('anderswo')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the auto-sync section only for a title that has watches, one block each', async () => {
    serve({ watches: [watch(1), watch(2), { ...watch(3), media: { ...media, id: 99 } }] })
    target = { id: 7, media, watchId: 2, tab: 'sync' }
    app()
    fireEvent.click(screen.getByText('öffnen'))
    const link = await screen.findByRole('link', { name: /series.tab.sync/ })
    // opened on the auto-sync section: the jump row says so
    await waitFor(() => expect(link).toHaveAttribute('aria-current', 'true'))
    expect(link).toHaveTextContent('2')
    const section = screen.getByRole('region', { name: 'series.tab.sync' })
    const blocks = within(section).getAllByRole('region')
    expect(blocks).toHaveLength(2)
    // the watch the caller came from leads
    expect(blocks[0]).toHaveTextContent('/x/Frieren2')
  })

  it('says what the user has of the title in one line under its name', async () => {
    serve({ watches: [{ ...watch(1), missing: [4, 5], nextAiringAt: 1_900_000_000, nextEpisode: 12 } as Watch] })
    app()
    fireEvent.click(screen.getByText('öffnen'))
    const heading = screen.getByRole('heading', { name: 'Frieren', level: 3 })
    const line = await within(heading.parentElement!).findByText(/series.state.local/)
    expect(line).toHaveTextContent('series.state.missing')
    expect(line).toHaveTextContent('series.state.next')
  })

  it('has no auto-sync section without a watch and says so when the source is down', async () => {
    serve({ watches: [] })
    app()
    fireEvent.click(screen.getByText('öffnen'))
    expect(screen.queryByRole('link', { name: /series.tab.sync/ })).toBeNull()
    // one page: cast, similar and community stand under the overview
    expect(screen.getByRole('region', { name: 'series.tab.cast' })).toBeInTheDocument()
    expect((await screen.findAllByRole('status'))[0]).toHaveTextContent('series.unavailable')
  })

  it('marks the section in view and jumps to a section from the row', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIO)
    const get = serve({
      extras: {
        relations: [],
        recommendations: [],
        characters: [{ name: 'Fern', voiceActor: 'Kana Ichinose' }],
        links: [],
        threads: [],
      },
    })
    app()
    fireEvent.click(screen.getByText('öffnen'))
    const link = (name: string) => screen.getByRole('link', { name })
    expect(link('series.tab.overview')).toHaveAttribute('aria-current', 'true')
    // the lazy sections wait until they come near
    const extrasAsked = () => get.mock.calls.some(([u]) => u.startsWith('/api/media/extras'))
    expect(extrasAsked()).toBe(false)
    const { spy, ahead } = observers()
    ahead.fire(screen.getByRole('region', { name: 'series.tab.cast' }), true)
    expect(await screen.findByText('Fern')).toBeInTheDocument()
    expect(extrasAsked()).toBe(true)

    // scrolled: the observer reports the cast section as the first in the band
    spy.fire(screen.getByRole('region', { name: 'series.tab.overview' }), false)
    spy.fire(screen.getByRole('region', { name: 'series.tab.cast' }), true)
    expect(link('series.tab.cast')).toHaveAttribute('aria-current', 'true')
    expect(link('series.tab.overview')).not.toHaveAttribute('aria-current')

    // a jump marks its target and takes the focus there
    fireEvent.click(link('series.tab.community'))
    expect(link('series.tab.community')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('region', { name: 'series.tab.community' })).toHaveFocus()
  })

  it('opens a related title inside the card and finds its way back', async () => {
    serve({
      extras: {
        relations: [{ relationType: 'SEQUEL', node: sequel }],
        recommendations: [],
        characters: [],
        links: [],
        threads: [],
      },
    })
    app()
    fireEvent.click(screen.getByText('öffnen'))
    fireEvent.click(await screen.findByRole('button', { name: 'remote.detailsFor:Frieren 2' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Frieren 2')
    // the trimmed node is completed by a fetch of the record
    await waitFor(() => expect(dialog).toHaveTextContent('Teil zwei.'))
    fireEvent.click(screen.getByRole('button', { name: 'series.back' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Eine Elfe.')
  })

  it('puts the caller actions in the bar, the rare ones behind the menu, and no close button', () => {
    serve()
    const sync = vi.fn()
    const files = vi.fn()
    target = {
      id: 7,
      media,
      actions: [
        { key: 'files', label: 'Dateien zeigen', more: true, onClick: files },
        { key: 'sync', label: 'Jetzt syncen', primary: true, onClick: sync },
        { key: 'watch', label: 'Auto-Sync', onClick: () => {} },
      ],
    }
    app()
    fireEvent.click(screen.getByText('öffnen'))
    const bar = screen.getByRole('dialog').querySelector('footer')!
    const buttons = within(bar).getAllByRole('button')
    // secondary first, the primary at the end, then the overflow
    expect(buttons.map((b) => b.textContent)).toEqual(['Auto-Sync', 'Jetzt syncen', ''])
    expect(within(bar).queryByRole('button', { name: 'common.close' })).toBeNull()
    fireEvent.click(within(bar).getByRole('button', { name: 'Jetzt syncen' }))
    expect(sync).toHaveBeenCalledTimes(1)
    fireEvent.click(within(bar).getByRole('button', { name: 'series.moreActions:Frieren' }))
    fireEvent.click(screen.getByRole('option', { name: 'Dateien zeigen' }))
    expect(files).toHaveBeenCalledTimes(1)
  })

  it('offers checking and editing a watch the card was opened from', async () => {
    serve({ watches: [{ ...watch(1), serverId: 1 } as Watch] })
    const post = vi.spyOn(api, 'post').mockResolvedValue({})
    target = { id: 7, media, watchId: 1 }
    app()
    fireEvent.click(screen.getByText('öffnen'))
    await screen.findByRole('region', { name: 'series.tab.sync' })
    const bar = screen.getByRole('dialog').querySelector('footer')!
    expect(within(bar).getByRole('button', { name: /servers.edit/ })).toBeInTheDocument()
    fireEvent.click(within(bar).getByRole('button', { name: /watch.checkNow/ }))
    expect(post).toHaveBeenCalledWith('/api/watches/1/check')
    // the header's X closes the card
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('slides a page form in inside the card and comes back to the card', async () => {
    serve()
    formClosed = 0
    app()
    fireEvent.click(screen.getByText('mit Formular'))
    // a click focuses the button in a browser; fireEvent does not
    screen.getByRole('button', { name: 'Jetzt syncen' }).focus()
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt syncen' }))
    // one dialog, now holding the form instead of the card
    expect(document.querySelectorAll('dialog')).toHaveLength(1)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Sync-Formular' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('navigation', { name: 'series.sectionsLabel' })).toBeNull()
    expect(screen.getByRole('button', { name: 'watch.backToCard' })).toHaveFocus()

    // back: the card again, focus on the action that asked
    fireEvent.click(screen.getByRole('button', { name: 'watch.backToCard' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Sync-Formular' })).toBeNull())
    expect(screen.getByRole('navigation', { name: 'series.sectionsLabel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Jetzt syncen' })).toHaveFocus()
    expect(formClosed).toBe(1)

    // the card closing under the form takes the form with it
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt syncen' }))
    // Escape on the native dialog surfaces as its cancel event
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(formClosed).toBe(2)
  })

  it('opens on a history entry of its own: back closes it, a related title is one more step', async () => {
    serve({
      extras: {
        relations: [{ relationType: 'SEQUEL', node: sequel }],
        recommendations: [],
        characters: [],
        links: [],
        threads: [],
      },
    })
    app()
    fireEvent.click(screen.getByText('öffnen'))
    fireEvent.click(await screen.findByRole('button', { name: 'remote.detailsFor:Frieren 2' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Teil zwei.'))
    // the browser's back: first the title before, then the page
    fireEvent.click(screen.getByText('zurück'))
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Eine Elfe.'))
    fireEvent.click(screen.getByText('zurück'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('opens from its own URL over the page and leaves to the dashboard', async () => {
    serve()
    app('/title/anilist/7')
    // nothing handed over: the record comes from the provider
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Eine Elfe.'))
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows its own URL in the address bar while the page stays the location', async () => {
    serve()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: (
            <SeriesModalProvider>
              <Opener />
            </SeriesModalProvider>
          ),
        },
      ],
      { initialEntries: ['/'] },
    )
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByText('öffnen'))
    await waitFor(() => expect(router.state.location.mask?.pathname).toBe('/title/anilist/7'))
    expect(router.state.location.pathname).toBe('/')
    expect(screen.getByRole('dialog')).toHaveTextContent('Frieren')
  })

  it('swaps the card for the watch editor in place and comes back to it', async () => {
    serve({ watches: [{ ...watch(1), serverId: 1, template: '', pattern: '' } as Watch] })
    target = { id: 7, media, tab: 'sync' }
    app()
    fireEvent.click(screen.getByText('öffnen'))
    const openEditor = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'watch.moreActions' }))
      fireEvent.click(screen.getByRole('option', { name: /servers.edit/ }))
    }
    await openEditor()

    // one dialog, now holding the editor instead of the card
    expect(document.querySelectorAll('dialog')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'watch.editTitle' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'series.sectionsLabel' })).toBeNull()
    expect(screen.getByRole('button', { name: 'watch.backToCard' })).toHaveFocus()

    // nothing changed: the back arrow goes straight to the card, focus on the
    // menu the edit came from
    fireEvent.click(screen.getByRole('button', { name: 'watch.backToCard' }))
    expect(await screen.findByRole('navigation', { name: 'series.sectionsLabel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'watch.moreActions' })).toHaveFocus()

    // unsaved changes: the guard asks, and a declined confirm keeps the editor
    await openEditor()
    fireEvent.change(screen.getByLabelText('watch.mediaId'), { target: { value: '42' } })
    fireEvent.click(screen.getByRole('button', { name: 'watch.backToCard' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByRole('heading', { name: 'watch.editTitle' })).toBeInTheDocument()
  })
})
