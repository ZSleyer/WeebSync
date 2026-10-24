import { useState, type ReactNode } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router'
import SyncDefaults from '../pages/settings/SyncDefaults'
import { api, type WatchDefaults } from '../api'
import { ShellFooter } from '../components/PageActions'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))
vi.mock(import('../hooks'), async (importOriginal) => ({
  ...(await importOriginal()),
  useAuth: () => ({ data: { isAdmin: false } }) as never,
  useProviders: () => ({}) as never,
}))

// the shell's footer row: jsdom matches no media query, so the save bar sits there
function Shell({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  return (
    <ShellFooter.Provider value={node}>
      <div ref={setNode} />
      {children}
    </ShellFooter.Provider>
  )
}

const common: WatchDefaults['common'] = {
  renameProvider: '',
  renameOrdering: '',
  renameTitleLang: '',
  airedMapping: false,
  wantDub: '',
  wantSub: '',
  dubLagDays: 0,
  plexAudioLang: '',
  plexSubLang: '',
}

// a server that stores what it is sent, as the defaults endpoint does
function serve() {
  let stored: WatchDefaults = { kinds: {}, common }
  vi.spyOn(api, 'get').mockImplementation(async (url: string) =>
    url === '/api/auth/watch-defaults' ? structuredClone(stored) : [],
  )
  const put = vi.spyOn(api, 'put').mockImplementation(async (_url: string, body?: unknown) => {
    stored = structuredClone(body as WatchDefaults)
    return { status: 'ok' }
  })
  return put
}

function app() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // a data router: the page's unsaved-changes guard blocks navigation
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <Shell>
          <SyncDefaults />
        </Shell>
      ),
    },
  ])
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

afterEach(() => vi.restoreAllMocks())

describe('SyncDefaults', () => {
  it('keeps a subfolder choice saved without a folder or template', async () => {
    const put = serve()
    app()
    const kinds = await screen.findByRole('group', { name: 'settings.sync.kind' })
    fireEvent.click(within(kinds).getByRole('button', { name: 'watch.cat.series' }))
    fireEvent.click(screen.getByRole('button', { name: 'watch.subfolderTitle' }))
    fireEvent.click(screen.getByRole('combobox', { name: 'watch.subfolderSeparator' }))
    fireEvent.click(screen.getByRole('option', { name: 'rename.sepUnderscore', hidden: true }))
    fireEvent.click(screen.getByRole('button', { name: 'settings.save' }))
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    const sent = put.mock.calls[0][1] as WatchDefaults
    expect(sent.kinds.series).toMatchObject({ localPath: '', subfolderSource: 'title', subfolderSeparator: '_' })
    // after the refetch the choice is still what the form shows
    await screen.findByText('settings.saved')
    fireEvent.click(within(kinds).getByRole('button', { name: 'watch.cat.series' }))
    expect(screen.getByRole('button', { name: 'watch.subfolderTitle' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('combobox', { name: 'watch.subfolderSeparator' })).toHaveTextContent('rename.sepUnderscore')
  })

  it('sends no entry for a kind left with nothing chosen, like the server stores it', async () => {
    const put = serve()
    app()
    const kinds = await screen.findByRole('group', { name: 'settings.sync.kind' })
    // touched, then put back: nothing is chosen for movies
    fireEvent.click(within(kinds).getByRole('button', { name: 'watch.cat.movie' }))
    fireEvent.click(screen.getByRole('button', { name: 'watch.subfolderTitle' }))
    fireEvent.click(screen.getByRole('button', { name: 'watch.subfolderNone' }))
    // a real choice for series
    fireEvent.click(within(kinds).getByRole('button', { name: 'watch.cat.series' }))
    fireEvent.click(screen.getByRole('button', { name: 'watch.subfolderRemote' }))
    fireEvent.click(screen.getByRole('button', { name: 'settings.save' }))
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    const sent = put.mock.calls[0][1] as WatchDefaults
    expect(Object.keys(sent.kinds)).toEqual(['series'])
    expect(sent.kinds.series).toMatchObject({ subfolderSource: 'remote', subfolder: true })
  })
})
