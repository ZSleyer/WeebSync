import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import Integrations from '../pages/settings/Integrations'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({ t: (k: string, o?: Record<string, string>) => (o ? `${k} ${Object.values(o).join(' ')}` : k) }) as never,
}))
vi.mock('../components/PageActions', () => ({ PageFooter: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('../hooks/useUnsavedGuard', () => ({ UnsavedGuard: () => null }))
const fail = vi.fn()
vi.mock('../components/toast', () => ({ useFailToast: () => fail, useToast: () => vi.fn() }))

afterEach(() => {
  vi.restoreAllMocks()
  fail.mockClear()
})

const settings = {
  envLocked: [],
  plexUrl: 'https://plex.example.com',
  plexTokenSet: true,
  arrKeySet: true,
  arrCompleteDir: '/done',
  arrRoots: '',
  plexRoots: '',
  plexSections: '',
  plexSectionSources: '',
  plexSectionAnime: '',
  anilistClientId: 'abc',
  anilistRedirectUrl: '',
  jellyfinUrl: '',
}

interface Opts {
  kind?: 'plex' | 'jellyfin'
  linked?: boolean
}

function setup({ kind = 'plex', linked = false }: Opts = {}) {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/settings') return { ...settings } as never
    if (url === '/api/plex/me') return { configured: true, connected: true, kind } as never
    if (url === '/api/plex/account') return (linked ? { linked: true, user: 'maki' } : { linked: false }) as never
    if (url === '/api/plex/sections') return [] as never
    if (url === '/api/settings/arr-key') return { token: 'k-123' } as never
    return {} as never
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <Integrations />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('unlinking the watchlist account', () => {
  for (const kind of ['plex', 'jellyfin'] as const) {
    it(`reports a failed unlink (${kind})`, async () => {
      setup({ kind, linked: true })
      vi.spyOn(api, 'del').mockRejectedValue(new Error('offline'))
      fireEvent.click(await screen.findByRole('button', { name: 'settings.plexWatchlistUnlink' }))
      await waitFor(() => expect(fail).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' })))
      expect(screen.getByRole('button', { name: 'settings.plexWatchlistUnlink' })).toBeInTheDocument()
    })
  }
})

describe('plex.tv watchlist link', () => {
  const start = (url = 'https://plex.tv/link#123') => {
    let release!: () => void
    vi.spyOn(api, 'post').mockImplementation(
      () => new Promise((res) => (release = () => res({ id: 7, code: 'ABCD', url }) as never)),
    )
    return () => release()
  }
  const fakeTab = () => ({ location: { href: '' }, close: vi.fn(), opener: {} as unknown })

  it('opens the tab inside the click and points it at plex.tv afterwards', async () => {
    setup()
    const release = start()
    const tab = fakeTab()
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as never)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.plexWatchlistLink' }))
    // before the server answered: the popup is already allowed
    expect(open).toHaveBeenCalledTimes(1)
    release()
    await screen.findByText(/settings.plexWatchlistPending/)
    expect(tab.location.href).toBe('https://plex.tv/link#123')
    expect(tab.opener).toBeNull()
  })

  it('closes the blank tab when starting fails', async () => {
    setup()
    const tab = fakeTab()
    vi.spyOn(window, 'open').mockReturnValue(tab as never)
    vi.spyOn(api, 'post').mockRejectedValue(new Error('down'))
    fireEvent.click(await screen.findByRole('button', { name: 'settings.plexWatchlistLink' }))
    await waitFor(() => expect(fail).toHaveBeenCalled())
    expect(tab.close).toHaveBeenCalled()
  })

  it('offers the link and a cancel while waiting, e.g. after a blocked popup', async () => {
    setup()
    const release = start()
    vi.spyOn(window, 'open').mockReturnValue(null)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.plexWatchlistLink' }))
    release()
    const link = await screen.findByRole('link', { name: 'settings.plexWatchlistOpen' })
    expect(link).toHaveAttribute('href', 'https://plex.tv/link#123')
    expect(link).toHaveAttribute('target', '_blank')
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(await screen.findByRole('button', { name: 'settings.plexWatchlistLink' })).toBeInTheDocument()
  })
})
