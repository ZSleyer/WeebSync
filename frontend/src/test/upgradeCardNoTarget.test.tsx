import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import UpgradeCard from '../components/UpgradeCard'
import { api } from '../api'
import type { UpgradeSuggestion, UpgradeVariant } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string, o?: { path?: string }) => (o?.path ? `${k} ${o.path}` : k) }) as never,
}))

afterEach(() => vi.restoreAllMocks())

const variant = (folder: string): UpgradeVariant =>
  ({ serverId: 0, folder, resRank: 720, dub: [], sub: [] }) as unknown as UpgradeVariant

const upgrade = (sync: Record<string, unknown>): UpgradeSuggestion =>
  ({
    key: 'k1',
    title: 'Show',
    season: 1,
    from: variant('plex:1:s1'),
    to: variant('/remote/Show'),
    options: [],
    sync: { subfolder: false, localPath: '', ...sync },
  }) as unknown as UpgradeSuggestion

function show(u: UpgradeSuggestion, isAdmin: boolean) {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/auth/me') return { email: 'a@b.c', isAdmin }
    if (url === '/api/plex/account') return { server: 'jellyfin' }
    return {}
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider
        router={createMemoryRouter(
          [
            {
              path: '*',
              element: <UpgradeCard u={u} dims={undefined} chosen={u.to} onChoose={() => {}} onSync={() => {}} />,
            },
          ],
          { initialEntries: ['/'] },
        )}
      />
    </QueryClientProvider>,
  )
}

describe('UpgradeCard without a target', () => {
  it('keeps the button, disabled, and says why with a link to the mapping', async () => {
    show(upgrade({ missing: 'unmapped', serverPath: '/data/anime/Show' }), true)
    const button = screen.getByRole('button', { name: 'discover.upgradeLoad' })
    expect(button).toBeDisabled()
    expect(screen.getByText(/discover\.noTarget\.unmappedPath \/data\/anime\/Show/)).toBeInTheDocument()
    expect(button).toHaveAccessibleDescription(/unmappedPath/)
    const link = await screen.findByRole('link', { name: 'discover.noTarget.fix' })
    await vi.waitFor(() => expect(link).toHaveAttribute('href', '/settings/integrations#jellyfin'))
  })

  it('sends non-admins to an admin instead of a link', () => {
    show(upgrade({ missing: 'unmapped' }), false)
    expect(screen.getByRole('button', { name: 'discover.upgradeLoad' })).toBeDisabled()
    expect(screen.getByText(/discover\.noTarget\.unmapped/)).toBeInTheDocument()
    expect(screen.getByText(/discover\.noTarget\.ask/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'discover.noTarget.fix' })).toBeNull()
  })

  it('explains a missing folder without offering a mapping', () => {
    show(upgrade({ missing: 'no_folder' }), true)
    expect(screen.getByText(/discover\.noTarget\.no_folder/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'discover.noTarget.fix' })).toBeNull()
  })

  it('enables the button once the plan has a target', () => {
    show(upgrade({ localPath: '/media/Show/Season 01' }), true)
    expect(screen.getByRole('button', { name: 'discover.upgradeLoad' })).toBeEnabled()
    expect(screen.queryByText(/discover\.noTarget/)).toBeNull()
  })
})
