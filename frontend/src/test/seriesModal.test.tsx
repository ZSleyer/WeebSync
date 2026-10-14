import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes, Link, useNavigate } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import {
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
          title="Sync-Formular"
          onClose={() => {
            formClosed++
            setForm(false)
          }}
        >
          {(v) => (
            <div className={`dialog-body ${v.className}`}>
              <p>Formularinhalt</p>
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
function serve({
  watches = [] as Watch[],
  extras = undefined as unknown,
  reviews = { reviews: [] },
  episodes = [] as unknown[],
  files = [] as unknown[],
  probe = undefined as unknown,
} = {}) {
  return vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url.startsWith('/api/watches/') && url.endsWith('/episodes')) return { episodes }
    if (url.startsWith('/api/browse/local')) return url.includes('Season') ? [] : files
    if (url.startsWith('/api/play/info') && probe) return probe
    if (url === '/api/watches') return watches
    if (url.startsWith('/api/media/extras')) {
      if (extras === undefined) throw new Error('502 down')
      return extras
    }
    if (url.startsWith('/api/media/reviews')) return reviews
    if (url === '/api/anilist/media/8') return { ...sequel, description: 'Teil zwei.' }
    if (url === '/api/anilist/media/7') return media
    if (url.startsWith('/api/watches/') && url.endsWith('/episodes')) return { episodes: [] }
    if (url.startsWith('/api/browse/local')) return []
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
    spy: live.find((o) => o.opts.rootMargin?.includes('-55%'))!,
    ahead: live.find((o) => o.opts.rootMargin?.endsWith('100% 0px'))!,
  }
}

// the series page's section by its jump link: the section ids come from useId
const sectionOf = (name: string) =>
  document.getElementById(screen.getByRole('link', { name }).getAttribute('href')!.slice(1))!

describe('SeriesModalProvider', () => {
  it('opens the one series page with the record and the caller rows', async () => {
    serve()
    target = { id: 7, media, extra: <p>Versionen: 2</p> }
    app()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByText('öffnen'))
    const page = screen.getByRole('dialog', { name: 'Frieren' })
    expect(page).toHaveTextContent('Frieren')
    // the first frame is the head alone (what a morph snapshots), the overview follows
    expect(page).not.toHaveTextContent('Eine Elfe.')
    await waitFor(() => expect(page).toHaveTextContent('Eine Elfe.'))
    expect(page).toHaveTextContent('Versionen: 2')
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

  it('covers the content column, non-modal, hides the page under it and gives focus back', async () => {
    serve()
    app()
    const opener = screen.getByText('öffnen')
    opener.focus()
    fireEvent.click(opener)
    const page = screen.getByRole('dialog', { name: 'Frieren' })
    // no modal: no <dialog>, no scrim; the sidebar and tab bar stay usable
    expect(document.querySelector('dialog')).toBeNull()
    expect(page).toHaveAttribute('aria-modal', 'false')
    // a frame after the commit, not inside the morph's snapshot frame
    await waitFor(() => expect(page).toHaveFocus())
    // the shell hides <main> while this is set
    expect(document.documentElement.dataset.overlay).toBe('series')

    // the next cover swaps what the page holds
    target = { id: 8, media: { ...sequel, description: 'Teil zwei.' } }
    opener.focus()
    fireEvent.click(opener)
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Teil zwei.'))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    // Escape from inside goes back, out of the page, and focus returns
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.documentElement.dataset.overlay).toBeUndefined()
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('lists the episodes of every watch, the lead first, the others in the aside', async () => {
    serve({ watches: [watch(1), watch(2), { ...watch(3), media: { ...media, id: 99 } }] })
    target = { id: 7, media, watchId: 2, tab: 'episodes' }
    app()
    fireEvent.click(screen.getByText('öffnen'))
    const link = await screen.findByRole('link', { name: /series.tab.episodes/ })
    await waitFor(() => expect(link).toHaveAttribute('aria-current', 'true'))
    const section = sectionOf('series.tab.episodes')
    // the watch the caller came from leads
    await waitFor(() =>
      expect(
        within(section)
          .getAllByRole('heading', { level: 2 })
          .map((h) => h.textContent),
      ).toEqual(['Frieren2', 'Frieren1']),
    )
    expect(screen.getByRole('region', { name: 'series.moreWatches' })).toHaveTextContent('/x/Frieren1')
  })

  it('says where the auto-sync stands in one sentence and offers the missing episodes', async () => {
    serve({
      watches: [
        {
          ...watch(1),
          missing: [
            { s: 1, e: 4 },
            { s: 1, e: 5 },
          ],
          nextAiringAt: 1_900_000_000,
          nextEpisode: 12,
        } as Watch,
      ],
    })
    app()
    fireEvent.click(screen.getByText('öffnen'))
    const sync = await screen.findByRole('region', { name: 'series.sync.label' })
    expect(within(sync).getByText('series.sync.gaps')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'series.sync.load' })).toHaveClass('ws-syncbtn')
  })

  it('has no episodes section without a watch or files and says so when the source is down', async () => {
    serve({ watches: [] })
    app()
    fireEvent.click(screen.getByText('öffnen'))
    expect(screen.queryByRole('link', { name: /series.tab.episodes/ })).toBeNull()
    // one page: cast, similar and community stand under the overview
    const cast = sectionOf('series.tab.cast')
    await waitFor(() => expect(within(cast).getByRole('status')).toHaveTextContent('series.unavailable'))
    expect(within(cast).queryByText('app.loading')).toBeNull()
  })

  it('marks the section in view and jumps to a section from the row', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIO)
    const get = serve({
      extras: {
        relations: [],
        recommendations: [],
        characters: [{ name: 'Fern', voiceActor: 'Kana Ichinose', role: 'MAIN' }],
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
    // the observers read sizes, so they are set up a frame after the commit
    await waitFor(() => expect(observers().ahead).toBeDefined())
    const { spy, ahead } = observers()
    ahead.fire(sectionOf('series.tab.cast'), true)
    expect(await screen.findByText('Fern')).toBeInTheDocument()
    expect(screen.getByText('series.role.MAIN')).toBeInTheDocument()
    expect(extrasAsked()).toBe(true)

    vi.spyOn(Element.prototype, 'scrollTop', 'get').mockReturnValue(400)
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(5000)
    spy.fire(sectionOf('series.tab.overview'), false)
    spy.fire(sectionOf('series.tab.cast'), true)
    expect(link('series.tab.cast')).toHaveAttribute('aria-current', 'true')
    expect(link('series.tab.overview')).not.toHaveAttribute('aria-current')

    // a jump marks its target and takes the focus there
    fireEvent.click(link('series.tab.community'))
    expect(link('series.tab.community')).toHaveAttribute('aria-current', 'true')
    expect(sectionOf('series.tab.community')).toHaveFocus()
  })

  it('opens a related title on top, says where it came from and finds its way back', async () => {
    serve({
      extras: {
        relations: [{ relationType: 'SEQUEL', node: sequel }],
        recommendations: [{ ...sequel, id: 9, title: { romaji: 'Dungeon Meshi' }, rating: 412 }],
        characters: [],
        links: [],
        threads: [],
      },
    })
    app()
    fireEvent.click(screen.getByText('öffnen'))
    // the vote count of a recommendation
    expect(await screen.findByText(/\+412/)).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /Frieren 2/ }))
    const page = screen.getByRole('dialog')
    expect(page).toHaveTextContent('Frieren 2')
    expect(page).toHaveTextContent('series.from')
    // the trimmed node is completed by a fetch of the record
    await waitFor(() => expect(page).toHaveTextContent('Teil zwei.'))
    fireEvent.click(screen.getByRole('button', { name: 'series.backLabel' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Eine Elfe.'))
  })

  it('puts the caller actions in the hero, the rare ones behind the menu, and no close button', () => {
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
    const acts = screen.getByRole('dialog').querySelector<HTMLElement>('.ws-d-acts')!
    const buttons = within(acts).getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['Jetzt syncen', 'Auto-Sync', ''])
    expect(screen.queryByRole('button', { name: 'common.close' })).toBeNull()
    fireEvent.click(within(acts).getByRole('button', { name: 'Jetzt syncen' }))
    expect(sync).toHaveBeenCalledTimes(1)
    fireEvent.click(within(acts).getByRole('button', { name: 'series.moreActions:Frieren' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Dateien zeigen' }))
    expect(files).toHaveBeenCalledTimes(1)
  })

  it('offers checking and editing a watch of the title, back leaves', async () => {
    serve({ watches: [{ ...watch(1), serverId: 1 } as Watch] })
    const post = vi.spyOn(api, 'post').mockResolvedValue({})
    target = { id: 7, media, watchId: 1 }
    app()
    fireEvent.click(screen.getByText('öffnen'))
    const acts = await waitFor(() => {
      const a = screen.getByRole('dialog').querySelector<HTMLElement>('.ws-d-acts')!
      expect(within(a).getByRole('button', { name: /servers.edit/ })).toBeInTheDocument()
      return a
    })
    fireEvent.click(within(acts).getByRole('button', { name: /watch.checkNow/ }))
    expect(post).toHaveBeenCalledWith('/api/watches/1/check?wait=1')
    fireEvent.click(screen.getByRole('button', { name: 'series.backLabel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('slides a page form in inside the page and comes back to it', async () => {
    serve()
    formClosed = 0
    app()
    fireEvent.click(screen.getByText('mit Formular'))
    screen.getByRole('button', { name: 'Jetzt syncen' }).focus()
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt syncen' }))
    // one page, now holding the form instead of the sections
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    const page = screen.getByRole('dialog')
    expect(within(page).getByRole('heading', { name: 'Sync-Formular' })).toBeInTheDocument()
    expect(within(page).queryByRole('navigation', { name: 'series.sectionsLabel' })).toBeNull()
    expect(screen.getByRole('button', { name: 'watch.backToCard' })).toHaveFocus()

    // back: the page again, focus on the action that asked
    fireEvent.click(screen.getByRole('button', { name: 'watch.backToCard' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Sync-Formular' })).toBeNull())
    expect(screen.getByRole('navigation', { name: 'series.sectionsLabel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Jetzt syncen' })).toHaveFocus()
    expect(formClosed).toBe(1)

    // Escape leaves the form first, then the page
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt syncen' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(formClosed).toBe(2))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
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
    fireEvent.click(await screen.findByRole('button', { name: /Frieren 2/ }))
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
    fireEvent.click(screen.getByRole('button', { name: 'series.backLabel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lands on an episode: scrolled to, its facts open, marked once', async () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    serve({
      watches: [{ ...watch(1), serverId: 1 } as Watch],
      episodes: [
        { season: 1, episode: 2, have: true, title: 'Zwei' },
        { season: 1, episode: 3, have: true, title: 'Drei' },
      ],
      files: [
        { name: 'Frieren S01E02.mkv', path: '/media/Frieren S01E02.mkv', isDir: false, size: 1e9, modTime: '' },
        { name: 'Frieren S01E03.mkv', path: '/media/Frieren S01E03.mkv', isDir: false, size: 2e9, modTime: '' },
      ],
      probe: { video: { height: 1080, width: 1920, codec: 'hevc' }, audio: [{ lang: 'ja' }], subs: [{ lang: 'de' }] },
    })
    app('/title/anilist/7?ep=3')
    const toggle = await screen.findByRole('button', { name: 'series.ep.facts:Drei' })
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'))
    expect(toggle.closest('li')).toHaveAttribute('data-hit')
    expect(scrolled).toHaveBeenCalled()
    // the facts: the file and, from the probe, the picture
    const facts = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(facts).toHaveTextContent('Frieren S01E03.mkv')
    await waitFor(() => expect(facts).toHaveTextContent('1080p'))
    // the other episode stays closed; play stays a button of its own
    expect(screen.getByRole('button', { name: 'series.ep.facts:Zwei' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'series.ep.play:Drei' })).toBeInTheDocument()
  })

  it('opens straight into the watch editor when asked and comes back to the page', async () => {
    serve({ watches: [{ ...watch(1), serverId: 1, template: '', pattern: '' } as Watch] })
    target = { id: 7, media, edit: true }
    app()
    fireEvent.click(screen.getByText('öffnen'))
    expect(await screen.findByRole('heading', { name: 'watch.editTitle' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'series.sectionsLabel' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'watch.backToCard' }))
    expect(await screen.findByRole('navigation', { name: 'series.sectionsLabel' })).toBeInTheDocument()
  })

  it('swaps the page for the watch editor in place and comes back to it', async () => {
    serve({ watches: [{ ...watch(1), serverId: 1, template: '', pattern: '' } as Watch] })
    target = { id: 7, media, tab: 'episodes' }
    app()
    fireEvent.click(screen.getByText('öffnen'))
    const openEditor = async () => {
      const edit = await screen.findByRole('button', { name: /servers.edit/ })
      edit.focus()
      fireEvent.click(edit)
    }
    await openEditor()

    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    // one header: the page's bar names the editor and leads back, the form
    // repeats neither
    expect(screen.getAllByRole('heading', { name: 'watch.editTitle' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'watch.backToCard' })).toHaveLength(1)
    expect(screen.getAllByText('watch.editTitle')).toHaveLength(1)
    expect(screen.queryByRole('navigation', { name: 'series.sectionsLabel' })).toBeNull()
    expect(screen.getByRole('button', { name: 'watch.backToCard' })).toHaveFocus()

    // nothing changed: the back arrow goes straight to the page, focus on edit
    fireEvent.click(screen.getByRole('button', { name: 'watch.backToCard' }))
    expect(await screen.findByRole('navigation', { name: 'series.sectionsLabel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /servers.edit/ })).toHaveFocus()

    // unsaved changes: the guard asks, and a declined confirm keeps the editor
    await openEditor()
    fireEvent.change(screen.getByLabelText('watch.mediaId'), { target: { value: '42' } })
    fireEvent.click(screen.getByRole('button', { name: 'watch.backToCard' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByRole('heading', { name: 'watch.editTitle' })).toBeInTheDocument()
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
})
