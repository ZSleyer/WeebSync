import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { api, type ScopeHint } from '../api'
import { buildNeeds } from '../pages/today/needs'
import { Needs } from '../pages/today/Needs'

// the toast runs its held-back action at once; the real one waits for the line to run out
vi.mock('../components/toast', () => ({ useToast: () => (o: { commit?: () => void }) => o.commit?.() }))
vi.mock('../components/SeriesModal', () => ({ useSeriesModal: () => ({ open: () => {} }) }))
vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.kind ? `${k}:${o.kind}` : k) }) as never,
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const collection = (extra: Partial<ScopeHint> = {}): ScopeHint => ({
  serverId: 1,
  serverName: 'seedbox',
  path: '/Server/Some Category',
  name: 'Some Category',
  kind: 'auto',
  sibling: '',
  reason: 'collection',
  titles: 23,
  total: 25,
  altKind: '',
  ...extra,
})

describe('a collection suggestion', () => {
  it('says how many subfolders are titles and offers the automatic mark', () => {
    const t = (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k)
    const rows = buildNeeds(t, { downloads: [], watches: [], hints: [collection()], now: 0 })
    expect(rows).toHaveLength(1)
    expect(rows[0].sub).toBe('dash.folderHintCollection:{"server":"seedbox","titles":23,"total":25}')
    expect(rows[0].act).toBe('today.needMarkAs:{"kind":"remote.scopeAuto"}')
  })

  function setup(hint: ScopeHint) {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    vi.spyOn(api, 'get').mockResolvedValue([] as never)
    const put = vi.spyOn(api, 'put').mockResolvedValue({} as never)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Needs downloads={[]} watches={[]} hints={[hint]} loading={false} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    return put
  }

  it('marks the folder as automatic with one action', async () => {
    const put = setup(collection())
    fireEvent.click(screen.getByRole('button', { name: /today\.needMarkAs/ }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/servers/1/catalog/scope', { path: '/Server/Some Category', kind: 'auto' }),
    )
  })

  it('stores a dismissal on the server when hidden', async () => {
    const put = setup(collection())
    fireEvent.click(screen.getByRole('button', { name: /today\.hide/ }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/servers/1/catalog/scope', { path: '/Server/Some Category', kind: 'none' }),
    )
  })

  it('offers anime from the menu when the titles carry anime tags', async () => {
    const put = setup(collection({ altKind: 'anime' }))
    fireEvent.click(screen.getByRole('button', { name: /dash\.moreActions/ }))
    fireEvent.click(await screen.findByText('today.needMarkAs:remote.scopeAnime'))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/servers/1/catalog/scope', {
        path: '/Server/Some Category',
        kind: 'anime',
      }),
    )
  })
})
