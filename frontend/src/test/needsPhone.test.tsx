import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { api, type ScopeHint } from '../api'
import { Needs } from '../pages/today/Needs'

// the toast runs its held-back action at once; the real one waits for the line to run out
vi.mock('../components/toast', () => ({
  useToast: () => (o: { commit?: () => void }) => o.commit?.(),
}))
vi.mock('../components/SeriesModal', () => ({
  useSeriesModal: () => ({ open: () => {} }),
}))
vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({
      t: (k: string, o?: Record<string, unknown>) => (o?.kind ? `${k}:${o.kind}` : k),
    }) as never,
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const hint = (extra: Partial<ScopeHint> = {}): ScopeHint => ({
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

function phone(h: ScopeHint) {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.spyOn(api, 'get').mockResolvedValue([] as never)
  const put = vi.spyOn(api, 'put').mockResolvedValue({} as never)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Needs downloads={[]} watches={[]} hints={[h]} loading={false} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return put
}

describe('Needs on a phone', () => {
  it('shows the action as an icon with its label and runs it', async () => {
    const put = phone(hint())
    const btn = screen.getByRole('button', { name: /today\.needMarkAs/ })
    expect(btn.textContent).toBe('')
    expect(btn.getAttribute('title')).toBe('today.needMarkAs:remote.scopeAuto')
    fireEvent.click(btn)
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/servers/1/catalog/scope', expect.objectContaining({ kind: 'auto' })),
    )
  })

  it('opens the row in full and runs an action from the sheet', async () => {
    const put = phone(hint({ altKind: 'anime' }))
    fireEvent.click(screen.getByText('today.needFolder').closest('button')!)
    const dialog = await screen.findByRole('dialog', { hidden: true })
    expect(dialog.textContent).toContain('dash.folderHintCollection')
    expect(dialog.textContent).toContain('today.hide')
    const anime = Array.from(dialog.querySelectorAll('button')).find((b) => /scopeAnime/.test(b.textContent ?? ''))
    fireEvent.click(anime!)
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/servers/1/catalog/scope', expect.objectContaining({ kind: 'anime' })),
    )
  })
})
