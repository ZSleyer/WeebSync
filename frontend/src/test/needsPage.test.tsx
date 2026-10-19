import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { api, type Download, type ScopeHint, type Watch } from '../api'
import NeedsPage from '../pages/NeedsPage'
import { Needs, NEEDS_MAX } from '../pages/today/Needs'
import { buildNeeds, groupNeeds, hiddenNeeds } from '../pages/today/needs'

vi.mock('../components/toast', () => ({ useToast: () => (o: { commit?: () => void }) => o.commit?.() }))
vi.mock('../components/SeriesModal', () => ({ useSeriesModal: () => ({ open: () => {} }) }))
vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({
      t: (k: string, o?: Record<string, unknown>) => (o?.count !== undefined ? `${k}:${o.count}` : k),
    }) as never,
}))

let data: Record<string, unknown> = {}
vi.mock('../pages/today/useNeedsData', () => ({ useNeedsData: () => data }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
})

const NOW = Date.parse('2026-10-14T12:00:00Z')
const fail = (id: number): Download =>
  ({
    id,
    serverId: 1,
    remotePath: `/a/Show ${id}.mkv`,
    localPath: `/media/Show/Show ${id}.mkv`,
    status: 'error',
    finishedAt: '2026-10-14 10:00:00',
    error: `boom ${id}`,
    errorCode: `code${id}`,
  }) as Download
const watch = (id: number): Watch =>
  ({ id, remotePath: `/w/Watch ${id}`, titleOverride: `Watch ${id}`, attention: ['unsorted'], unsorted: 2 }) as Watch
const hint = (n: number): ScopeHint =>
  ({
    serverId: 1,
    serverName: 'seedbox',
    path: `/S/Folder ${n}`,
    name: `Folder ${n}`,
    kind: 'anime',
    sibling: 'Other',
    reason: 'sibling',
    titles: 0,
    total: 0,
    altKind: '',
  }) as ScopeHint

const t = (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k)
const all = (downloads: Download[], watches: Watch[], hints: ScopeHint[], mediaChoose = false) =>
  buildNeeds(t, { downloads, watches, hints, now: NOW, mediaChoose })

describe('grouping the needs', () => {
  it('orders problems, then decisions, then auto-sync, each in its own order', () => {
    const list = all([fail(1), fail(2)], [watch(1), watch(2)], [hint(1), hint(2)], true)
    expect(list.map((n) => n.kind)).toEqual(['plex', 'failed', 'failed', 'hint', 'hint', 'watch', 'watch'])
    const groups = groupNeeds(list)
    expect(groups.map((g) => g.group)).toEqual(['problems', 'decisions', 'sync'])
    expect(groups[0].needs.map((n) => n.key)).toEqual(['media-choose', 'dl-1', 'dl-2'])
    expect(groups[1].needs.map((n) => n.key)).toEqual(['h-1-/S/Folder 1', 'h-1-/S/Folder 2'])
  })

  it('leaves empty groups out', () => {
    expect(groupNeeds(all([], [watch(1)], [])).map((g) => g.group)).toEqual(['sync'])
    expect(groupNeeds([])).toEqual([])
  })
})

function view(ui: React.ReactNode) {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.spyOn(api, 'get').mockResolvedValue([] as never)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const base = {
  isLoading: false,
  watchesLoading: false,
  meta: undefined,
  plexToken: false,
  mediaChoose: false,
  now: NOW,
}

describe('the needs page', () => {
  it('lists every need under its group heading', async () => {
    data = {
      ...base,
      downloads: [fail(1), fail(2)],
      watches: [watch(1), watch(2)],
      hints: Array.from({ length: 8 }, (_, i) => hint(i + 1)),
    }
    view(<NeedsPage />)
    const groups = await screen.findAllByRole('region')
    expect(groups.map((g) => within(g).getByRole('heading').textContent)).toEqual([
      'needs.group.problems',
      'needs.group.decisions',
      'needs.group.sync',
    ])
    expect(within(groups[0]).getAllByRole('listitem')).toHaveLength(2)
    expect(within(groups[1]).getAllByRole('listitem')).toHaveLength(8)
    expect(within(groups[2]).getAllByRole('listitem')).toHaveLength(2)
  })

  it('shows a calm empty state without any need', async () => {
    data = { ...base, downloads: [], watches: [], hints: [] }
    view(<NeedsPage />)
    expect(await screen.findByText('needs.empty')).toBeTruthy()
    expect(screen.queryAllByRole('region')).toHaveLength(0)
  })
})

describe('Today', () => {
  const props = { downloads: [fail(1)], watches: [watch(1), watch(2)], hints: [hint(1), hint(2), hint(3), hint(4)] }

  it('shows the first rows by group order and links the rest to the page', async () => {
    view(<Needs {...props} loading={false} />)
    const rows = await screen.findAllByRole('listitem')
    expect(rows).toHaveLength(NEEDS_MAX)
    // the problem, then four decisions; both auto-syncs wait behind
    expect(rows.some((r) => r.textContent?.includes('Watch'))).toBe(false)
    expect(rows.filter((r) => r.textContent?.includes('today.needFolder'))).toHaveLength(4)
    expect(screen.getByRole('link', { name: 'dash.attentionMore:2' }).getAttribute('href')).toBe('/needs')
    expect(screen.getByRole('link', { name: 'needs.all:7' }).getAttribute('href')).toBe('/needs')
  })

  it('keeps a row hidden on the page hidden here', async () => {
    data = { ...base, ...props }
    const page = view(<NeedsPage />)
    const folder = (await screen.findAllByRole('listitem')).find((r) => r.textContent?.includes('today.needFolder'))!
    fireEvent.click(within(folder).getByRole('button', { name: /today\.hide/ }))
    await waitFor(() => expect(hiddenNeeds().size).toBe(1))
    page.unmount()
    view(<Needs {...props} loading={false} />)
    expect(await screen.findByRole('link', { name: 'needs.all:6' })).toBeTruthy()
    expect(screen.getAllByRole('listitem').filter((r) => r.textContent?.includes('today.needFolder'))).toHaveLength(3)
  })
})
