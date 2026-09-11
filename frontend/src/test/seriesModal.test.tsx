import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, Link } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SeriesModalProvider, useSeriesModal, type SeriesTarget } from '../components/SeriesModal'
import { api, type Media, type Watch } from '../api'

// keys instead of strings, with the name interpolated where a label carries one
vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.name ? `${k}:${o.name}` : k) }) as never,
}))

const media = { id: 7, title: { romaji: 'Frieren', english: 'Frieren' }, coverImage: { large: '/c.jpg' }, bannerImage: '', episodes: 28, seasonYear: 2023, format: 'TV', status: 'FINISHED', averageScore: 90, genres: ['Adventure'], description: 'Eine Elfe.' } as Media
const sequel = { id: 8, title: { romaji: 'Frieren 2' }, coverImage: { large: '/d.jpg' }, seasonYear: 2026 } as Media
const watch = (id: number): Watch =>
  ({ id, serverName: 'srv', remotePath: `/x/Frieren${id}`, localPath: '/media', mediaSource: 'anilist', media, localFiles: 10, active: 0, complete: false, lastResult: '', lastUploading: 0, lastQueued: 0, nextCheck: 0, lastCheck: '', langWaiting: 0, waiting: false }) as unknown as Watch

let target: SeriesTarget = { id: 7, media }
function Opener() {
  const { open } = useSeriesModal()
  return (
    <>
      <button onClick={() => open(target)}>öffnen</button>
      <Link to="/elsewhere">weg</Link>
    </>
  )
}

function app() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <SeriesModalProvider>
          <Routes>
            <Route path="/" element={<Opener />} />
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
    if (url.startsWith('/api/watches/') && url.endsWith('/episodes')) return { episodes: [] }
    throw new Error('unexpected ' + url)
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  target = { id: 7, media }
})

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

  it('shows the auto-sync tab only for a title that has watches, one block each', async () => {
    serve({ watches: [watch(1), watch(2), { ...watch(3), media: { ...media, id: 99 } }] })
    target = { id: 7, media, watchId: 2, tab: 'sync' }
    app()
    fireEvent.click(screen.getByText('öffnen'))
    const tab = await screen.findByRole('tab', { name: /series.tab.sync/ })
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(tab).toHaveTextContent('2')
    const blocks = await screen.findAllByRole('region')
    expect(blocks).toHaveLength(2)
    // the watch the caller came from leads
    expect(blocks[0]).toHaveTextContent('/x/Frieren2')
  })

  it('has no auto-sync tab without a watch and says so when the source is down', async () => {
    serve({ watches: [] })
    app()
    fireEvent.click(screen.getByText('öffnen'))
    expect(screen.queryByRole('tab', { name: /series.tab.sync/ })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'series.tab.cast' }))
    expect(await screen.findByRole('status')).toHaveTextContent('series.unavailable')
  })

  it('opens a related title inside the card and finds its way back', async () => {
    serve({ extras: { relations: [{ relationType: 'SEQUEL', node: sequel }], recommendations: [], characters: [], links: [], threads: [] } })
    app()
    fireEvent.click(screen.getByText('öffnen'))
    fireEvent.click(screen.getByRole('tab', { name: 'series.tab.similar' }))
    fireEvent.click(await screen.findByRole('button', { name: 'remote.detailsFor:Frieren 2' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Frieren 2')
    // the trimmed node is completed by a fetch of the record
    await waitFor(() => expect(dialog).toHaveTextContent('Teil zwei.'))
    fireEvent.click(screen.getByRole('button', { name: 'series.back' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Eine Elfe.')
  })

  it('moves between tabs with the arrow keys', async () => {
    serve({ extras: { relations: [], recommendations: [], characters: [{ name: 'Fern', voiceActor: 'Kana Ichinose' }], links: [], threads: [] } })
    app()
    fireEvent.click(screen.getByText('öffnen'))
    const overview = screen.getByRole('tab', { name: 'series.tab.overview' })
    overview.focus()
    fireEvent.keyDown(overview, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'series.tab.cast' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('Fern')).toBeInTheDocument()
  })
})
