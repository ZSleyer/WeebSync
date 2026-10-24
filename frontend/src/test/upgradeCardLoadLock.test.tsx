import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import UpgradeCard from '../components/UpgradeCard'
import { api } from '../api'
import type { UpgradeSuggestion, UpgradeVariant } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

afterEach(() => vi.restoreAllMocks())

const variant = (folder: string): UpgradeVariant =>
  ({ serverId: 0, folder, resRank: 720, dub: [], sub: [] }) as unknown as UpgradeVariant

const u = {
  key: 'k1',
  title: 'Show',
  season: 1,
  from: variant('plex:1:s1'),
  to: variant('/remote/Show'),
  options: [],
  sync: { subfolder: false, localPath: '/media/Show/Season 01' },
} as unknown as UpgradeSuggestion

describe('UpgradeCard load', () => {
  it('sends one load for a double click and stays locked until it is done', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (url: string) =>
      url === '/api/auth/me' ? { email: 'a@b.c', isAdmin: true } : {},
    )
    let finish: () => void = () => {}
    const onLoad = vi.fn(() => new Promise<void>((r) => (finish = r)))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider
          router={createMemoryRouter(
            [
              {
                path: '*',
                element: (
                  <UpgradeCard
                    u={u}
                    dims={undefined}
                    chosen={u.to}
                    onChoose={() => {}}
                    onSync={() => {}}
                    onLoad={onLoad}
                  />
                ),
              },
            ],
            { initialEntries: ['/'] },
          )}
        />
      </QueryClientProvider>,
    )
    const button = screen.getByRole('button', { name: 'discover.upgradeLoad' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onLoad).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(button).toBeDisabled())
    expect(button).toHaveAttribute('aria-busy', 'true')
    await act(async () => finish())
    await waitFor(() => expect(button).toBeEnabled())
  })
})
