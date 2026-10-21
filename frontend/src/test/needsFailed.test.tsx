import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { api, type Download } from '../api'
import { buildNeeds, moreLink } from '../pages/today/needs'
import { Needs } from '../pages/today/Needs'

// the toast runs its held-back action at once; the real one waits for the line to run out
vi.mock('../components/toast', () => ({ useToast: () => (o: { commit?: () => void }) => o.commit?.() }))
vi.mock('../components/SeriesModal', () => ({ useSeriesModal: () => ({ open: () => {} }) }))
vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string, o?: { count?: number }) => (o?.count ? `${k}:${o.count}` : k) }) as never,
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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
const AUTH = 'ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password]'

const fail = (id: number, extra: Partial<Download> = {}): Download =>
  ({
    id,
    userId: 1,
    serverId: 1,
    remotePath: `/a/Show ${id}.mkv`,
    localPath: `/media/Show/Show ${id}.mkv`,
    size: 1000,
    transferred: 0,
    status: 'error',
    rateLimit: 0,
    queuePos: 0,
    createdAt: '',
    finishedAt: '2026-10-14 10:00:00',
    error: AUTH,
    errorCode: 'auth_failed',
    ...extra,
  }) as Download

const t = (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k)
const needs = (downloads: Download[]) =>
  buildNeeds(t, { downloads, watches: [], detected: 0, now: NOW, serverNames: { 1: 'seedbox', 2: 'nas' } })

describe('grouping failed downloads', () => {
  it('folds one cause on one server into a row', () => {
    const rows = needs(Array.from({ length: 15 }, (_, i) => fail(i + 1)))
    expect(rows).toHaveLength(1)
    expect(rows[0].group).toHaveLength(15)
    expect(rows[0].title).toBe('today.needFailedMany:{"count":15}')
    expect(rows[0].sub).toBe('seedbox: today.needAuth')
    expect(rows[0].auth).toBe(true)
    expect(rows[0].act).toBe('today.checkServer')
  })

  it('keeps a single failure a single row', () => {
    const rows = needs([fail(1)])
    expect(rows.map((n) => n.key)).toEqual(['dl-1'])
    expect(rows[0].download?.id).toBe(1)
    expect(rows[0].group).toBeUndefined()
  })

  it('splits by server and by cause', () => {
    const rows = needs([
      fail(1),
      fail(2),
      fail(3, { serverId: 2 }),
      fail(4, { serverId: 2 }),
      fail(5, { errorCode: '', error: 'sftp: connection lost' }),
    ])
    expect(rows.map((n) => n.group?.length ?? 1)).toEqual([2, 2, 1])
  })

  it('groups unclassified failures by their text without the numbers in it', () => {
    const rows = needs([
      fail(1, { errorCode: '', error: 'read tcp 10.0.0.2:5000->10.0.0.9:22: i/o timeout' }),
      fail(2, { errorCode: '', error: 'read tcp 10.0.0.2:5001->10.0.0.9:22: i/o timeout' }),
      fail(3, { errorCode: '', error: 'incomplete transfer: 10 of 20 bytes' }),
      fail(4, { errorCode: '', error: 'incomplete transfer: 12 of 20 bytes' }),
    ])
    expect(rows.map((n) => n.group?.length)).toEqual([2, 2])
  })

  it('keeps the raw text as the detail line, not as the text', () => {
    const [row] = needs([fail(1, { errorCode: '', error: AUTH })])
    expect(row.sub).not.toContain('unable to authenticate')
    expect(row.raw).toBe(AUTH)
  })
})

describe('the "more" link', () => {
  it('always leads to the page with every need', () => {
    expect(moreLink()).toBe('/needs')
  })
})

function Where() {
  const l = useLocation()
  return <output data-testid="where">{l.pathname + l.search}</output>
}

function setup(downloads: Download[]) {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  const get = vi.spyOn(api, 'get').mockResolvedValue([{ id: 1, name: 'seedbox' }] as never)
  const post = vi.spyOn(api, 'post').mockResolvedValue({} as never)
  const del = vi.spyOn(api, 'del').mockResolvedValue({} as never)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['downloads'], downloads)
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="*" element={<Needs downloads={downloads} watches={[]} detected={0} loading={false} />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { get, post, del, ...view }
}

describe('dismissing a failed row', () => {
  it('removes a single failed download with DELETE from its menu', async () => {
    const { del, post } = setup([fail(7, { errorCode: '', error: 'boom' })])
    fireEvent.click(screen.getByRole('button', { name: /dash\.moreActions/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /today\.removeFailed/ }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/downloads/7'))
    expect(post).not.toHaveBeenCalled()
  })

  it('removes a group in one bulk call', async () => {
    const { del, post } = setup([fail(1), fail(2), fail(3)])
    fireEvent.click(screen.getByRole('button', { name: /dash\.moreActions/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'today.removeFailedAll' }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/downloads/bulk', { action: 'delete', ids: [1, 2, 3] }))
    expect(del).not.toHaveBeenCalled()
  })

  it('sends a rejected login to the server settings, not to a retry', async () => {
    const { post } = setup([fail(1), fail(2)])
    fireEvent.click(screen.getByRole('button', { name: /^today\.checkServer/ }))
    expect(screen.getByTestId('where').textContent).toBe('/settings/servers')
    expect(post).not.toHaveBeenCalled()
  })

  it('retries a group with one bulk resume', async () => {
    const { post } = setup([
      fail(1, { errorCode: '', error: 'sftp: connection lost' }),
      fail(2, { errorCode: '', error: 'sftp: connection lost' }),
    ])
    fireEvent.click(screen.getByRole('button', { name: /^today\.retryAll/ }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/downloads/bulk', { action: 'resume', ids: [1, 2] }))
  })
})
