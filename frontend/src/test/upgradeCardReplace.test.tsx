import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import UpgradeCard from '../components/UpgradeCard'
import { loses } from '../components/upgradeQuality'
import { api } from '../api'
import type { UpgradeSuggestion, UpgradeVariant } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

afterEach(() => vi.restoreAllMocks())

const variant = (folder: string, extra: Partial<UpgradeVariant> = {}): UpgradeVariant =>
  ({ serverId: 0, folder, resRank: 720, dub: [], sub: [], ...extra }) as unknown as UpgradeVariant

const from = variant('plex:1:s1', { resRank: 720, sub: ['de'] })
// the top copy keeps everything and adds 1080p: replacing is safe
const top = variant('/remote/Top', { resRank: 1080, sub: ['de', 'en'] })
// the other copy is sharper but drops the German subtitles: replacing would lose them
const dropsSub = variant('/remote/NoDe', { resRank: 1080, sub: ['en'] })
// the other copy keeps all and is sharper too: replacing is as safe as for the top
const alsoSafe = variant('/remote/Safe', { resRank: 2160, sub: ['de'] })

const u = {
  key: 'k1',
  title: 'Show',
  season: 1,
  from,
  to: top,
  options: [top, dropsSub, alsoSafe],
  sync: { subfolder: false, localPath: '/media/Show/Season 01', replace: true },
} as unknown as UpgradeSuggestion

describe('loses', () => {
  it('mirrors the backend rule: a lower tier or a dropped language loses', () => {
    expect(loses(from, top)).toBe(false)
    expect(loses(from, dropsSub)).toBe(true)
    expect(loses(from, variant('/x', { resRank: 480, sub: ['de'] }))).toBe(true)
    // a padded 1088 is the 1080 rung, not a loss against 1080
    expect(loses(variant('/a', { resRank: 1080 }), variant('/b', { resRank: 1088 }))).toBe(false)
    // an unreadable language on the local copy asks nothing of the new one
    expect(loses(variant('/a', { sub: ['Und'] }), variant('/b', { sub: [] }))).toBe(false)
  })
})

function Harness({ onLoad }: { onLoad: (replace: boolean) => void }) {
  const [chosen, setChosen] = useState(top)
  return (
    <>
      <button onClick={() => setChosen(dropsSub)}>pick-drops</button>
      <button onClick={() => setChosen(alsoSafe)}>pick-safe</button>
      <button onClick={() => setChosen(top)}>pick-top</button>
      <UpgradeCard
        u={u}
        dims={undefined}
        chosen={chosen}
        onChoose={setChosen}
        onSync={() => {}}
        onLoad={(_req, replace) => onLoad(replace)}
      />
    </>
  )
}

function setup() {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) =>
    url === '/api/auth/me' ? { email: 'a@b.c', isAdmin: true } : {},
  )
  const onLoad = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider
        router={createMemoryRouter([{ path: '*', element: <Harness onLoad={onLoad} /> }], { initialEntries: ['/'] })}
      />
    </QueryClientProvider>,
  )
  return onLoad
}

describe('UpgradeCard replace follows the chosen copy', () => {
  it('turns replacing off for a copy that drops a language, and back on for the top', async () => {
    const onLoad = setup()
    const box = await screen.findByRole('checkbox', { name: 'discover.replaceOld' })
    expect(box).toBeChecked()
    fireEvent.click(screen.getByText('pick-drops'))
    expect(screen.getByRole('checkbox', { name: 'discover.replaceOld' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'discover.upgradeLoad' }))
    await waitFor(() => expect(onLoad).toHaveBeenLastCalledWith(false))
    fireEvent.click(screen.getByText('pick-top'))
    expect(screen.getByRole('checkbox', { name: 'discover.replaceOld' })).toBeChecked()
  })

  it('keeps replacing on for another copy that loses nothing', async () => {
    const onLoad = setup()
    await screen.findByRole('checkbox', { name: 'discover.replaceOld' })
    fireEvent.click(screen.getByText('pick-safe'))
    expect(screen.getByRole('checkbox', { name: 'discover.replaceOld' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'discover.upgradeLoad' }))
    await waitFor(() => expect(onLoad).toHaveBeenLastCalledWith(true))
  })

  it('lets the user override the plan for the copy in view', async () => {
    const onLoad = setup()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'discover.replaceOld' }))
    expect(screen.getByRole('checkbox', { name: 'discover.replaceOld' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'discover.upgradeLoad' }))
    await waitFor(() => expect(onLoad).toHaveBeenLastCalledWith(false))
  })
})
