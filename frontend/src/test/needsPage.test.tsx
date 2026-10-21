import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { api, type Download, type Watch } from '../api'
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
// the rows read the clock themselves (useNow): pin it to the fixtures' day, or
// the failures age past the 7-day window and the tests break a week later
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})
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
const t = (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k)
const all = (downloads: Download[], watches: Watch[], detected: number, mediaChoose = false) =>
  buildNeeds(t, { downloads, watches, detected, now: NOW, mediaChoose })

describe('grouping the needs', () => {
  it('orders problems, then decisions, then auto-sync, each in its own order', () => {
    const list = all([fail(1), fail(2)], [watch(1), watch(2)], 23, true)
    expect(list.map((n) => n.kind)).toEqual(['plex', 'failed', 'failed', 'marks', 'watch', 'watch'])
    const groups = groupNeeds(list)
    expect(groups.map((g) => g.group)).toEqual(['problems', 'decisions', 'sync'])
    expect(groups[0].needs.map((n) => n.key)).toEqual(['media-choose', 'dl-1', 'dl-2'])
    // 23 detected folders are one calm row with their count, not 23 rows
    expect(groups[1].needs).toHaveLength(1)
    expect(groups[1].needs[0].title).toBe('today.needDetected:{"count":23}')
    expect(groups[1].needs[0].act).toBe('today.needDetectedAct')
  })

  it('has no row without a new detected folder', () => {
    expect(all([], [], 0)).toEqual([])
  })

  it('leaves empty groups out', () => {
    expect(groupNeeds(all([], [watch(1)], 0)).map((g) => g.group)).toEqual(['sync'])
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
      detected: 8,
    }
    view(<NeedsPage />)
    const groups = await screen.findAllByRole('region')
    expect(groups.map((g) => within(g).getByRole('heading').textContent)).toEqual([
      'needs.group.problems',
      'needs.group.decisions',
      'needs.group.sync',
    ])
    expect(within(groups[0]).getAllByRole('listitem')).toHaveLength(2)
    expect(within(groups[1]).getAllByRole('listitem')).toHaveLength(1)
    expect(within(groups[1]).getByText('today.needDetected:8')).toBeTruthy()
    expect(within(groups[2]).getAllByRole('listitem')).toHaveLength(2)
  })

  it('shows a calm empty state without any need', async () => {
    data = { ...base, downloads: [], watches: [], detected: 0 }
    view(<NeedsPage />)
    expect(await screen.findByText('needs.empty')).toBeTruthy()
    expect(screen.queryAllByRole('region')).toHaveLength(0)
  })
})

describe('Today', () => {
  const props = {
    downloads: [fail(1), fail(2), fail(3)],
    watches: [watch(1), watch(2), watch(3)],
    detected: 23,
  }

  it('shows the first rows by group order, the detected folders as one row, and links the rest', async () => {
    view(<Needs {...props} loading={false} />)
    const rows = await screen.findAllByRole('listitem')
    expect(rows).toHaveLength(NEEDS_MAX)
    // the three problems, the one decision, then the first auto-sync
    expect(rows.filter((r) => r.textContent?.includes('today.needDetected:23'))).toHaveLength(1)
    expect(rows.filter((r) => r.textContent?.includes('Watch'))).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'dash.attentionMore:2' }).getAttribute('href')).toBe('/needs')
    expect(screen.getByRole('link', { name: 'needs.all:7' }).getAttribute('href')).toBe('/needs')
  })

  it('keeps the row dismissed on the page dismissed here, until more folders are detected', async () => {
    data = { ...base, ...props }
    const page = view(<NeedsPage />)
    const row = (await screen.findAllByRole('listitem')).find((r) => r.textContent?.includes('today.needDetected'))!
    fireEvent.click(within(row).getByRole('button', { name: /today\.hide/ }))
    await waitFor(() => expect(hiddenNeeds().size).toBe(1))
    page.unmount()
    const today = view(<Needs {...props} loading={false} />)
    expect(await screen.findByRole('link', { name: 'needs.all:6' })).toBeTruthy()
    expect(screen.queryByText('today.needDetected:23')).toBeNull()
    today.unmount()
    // folders detected since: the row is back, with the new count
    view(<Needs {...props} detected={24} loading={false} />)
    expect(await screen.findByText('today.needDetected:24')).toBeTruthy()
  })
})
