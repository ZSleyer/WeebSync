import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SeriesModalProvider } from '../components/SeriesModal'
import Watches from '../pages/Watches'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'de' } }) as never,
  Trans: (({ i18nKey }: { i18nKey: string }) => i18nKey) as never,
}))

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

const watch = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  serverId: 1,
  remotePath: `/Area/Unmatched ${id}`,
  localPath: `/media/Unmatched ${id}`,
  template: '',
  mode: 'template',
  ...extra,
})

function renderWatches(list: unknown[]) {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/watches') return list as never
    if (url.endsWith('/plex-show')) throw new Error('no plex')
    if (url.endsWith('/languages')) return { dub: [], sub: [] } as never
    if (url === '/api/auth/me') return { id: 1, email: 'demo@example.com', isAdmin: true } as never
    return [] as never
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <SeriesModalProvider>
          <Watches />
        </SeriesModalProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('deleting a watch without a series record', () => {
  it('is possible from its edit dialog, by mouse and keyboard alike', async () => {
    renderWatches([watch(7)])
    fireEvent.click(await screen.findByRole('button', { name: /Unmatched 7/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'servers.delete' }))
    // gone from the list and the dialog closed (the undo line holds the request back)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'servers.delete' })).toBeNull())
    expect(screen.queryByRole('button', { name: /Unmatched 7/ })).toBeNull()
  })

  it("is reachable for a manga watch without a record, from the tile's actions button", async () => {
    renderWatches([watch(8, { category: 'manga' })])
    // a click on the tile itself opens the reader, so the delete has its own way in
    const more = await screen.findByRole('button', { name: 'watch.moreFor' })
    more.focus()
    expect(more).toHaveFocus()
    fireEvent.click(more)
    fireEvent.click(await screen.findByRole('button', { name: /servers.delete/ }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Unmatched 8/ })).toBeNull())
  })
})
