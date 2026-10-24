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

describe('a refused value is marked at its field', () => {
  const fields: [string, string][] = [
    ['plexUrl', 'settings.plexUrl'],
    ['plexToken', 'settings.plexToken'],
    ['plexRoots', 'settings.plexRoots'],
    ['arrCompleteDir', 'settings.arrCompleteDir'],
    ['arrRoots', 'settings.arrRoots'],
    ['anilistClientId', 'settings.anilistClientId'],
    ['anilistClientSecret', 'settings.anilistClientSecret'],
    ['anilistRedirectUrl', 'settings.anilistRedirectUrl'],
    ['tmdbApiKey', 'settings.tmdbApiKey'],
    ['tvdbApiKey', 'settings.tvdbApiKey'],
    ['animescheduleToken', 'settings.animescheduleToken'],
    ['jellyfinToken', 'settings.jellyfinToken'],
    ['aiApiKey', 'settings.aiApiKey'],
    ['aiModel', 'settings.aiModel'],
  ]
  for (const [key, label] of fields) {
    it(`${key}`, async () => {
      setup()
      vi.spyOn(api, 'put').mockRejectedValue(new Error(`${key}: not acceptable`))
      await screen.findByLabelText(label)
      // looked up again each time: the model field turns from input to list
      const field = () => screen.getByLabelText(label)
      fireEvent.change(field(), { target: { value: 'x' } })
      fireEvent.click(screen.getByText('settings.save'))
      await waitFor(() => expect(field()).toHaveAttribute('aria-invalid', 'true'))
      expect(field().getAttribute('aria-describedby') ?? '').not.toBe('')
      // correcting the field takes the refusal away (the model list is a picker)
      if (key === 'aiModel') return
      fireEvent.change(field(), { target: { value: 'y' } })
      expect(field()).not.toHaveAttribute('aria-invalid')
    })
  }
})

describe('Sonarr / Radarr copy buttons', () => {
  it('name the value they copy', async () => {
    setup()
    await screen.findByDisplayValue('k-123')
    const names = screen.getAllByRole('button', { name: /settings.apiTokenCopy/ }).map((b) => b.getAttribute('aria-label'))
    expect(names).toHaveLength(5)
    expect(new Set(names).size).toBe(5)
    expect(names).toContain('settings.apiTokenCopy: settings.arrIndexerUrl')
    expect(names).toContain('settings.apiTokenCopy: settings.arrKeyShowOnce')
  })
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

  it('does not poll when the panel is gone before the server answered', async () => {
    const view = setup()
    const release = start()
    const tab = fakeTab()
    vi.spyOn(window, 'open').mockReturnValue(tab as never)
    const timer = vi.spyOn(globalThis, 'setInterval')
    fireEvent.click(await screen.findByRole('button', { name: 'settings.plexWatchlistLink' }))
    view.unmount()
    release()
    await waitFor(() => expect(tab.close).toHaveBeenCalled())
    // (waitFor runs its own timer; the poll is the 2 s one)
    expect(timer.mock.calls.filter((c) => c[1] === 2000)).toHaveLength(0)
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
