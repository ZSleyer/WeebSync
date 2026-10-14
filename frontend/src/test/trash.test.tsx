import { useState, type ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import TrashPage, { TrashButton } from '../pages/Trash'
import { api, type TrashEntry } from '../api'
import { ShellFooter } from '../components/PageActions'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.name ? `${k}:${o.name}` : k) }) as never,
}))
let admin = true
vi.mock(import('../hooks'), async (importOriginal) => ({
  ...(await importOriginal()),
  useAuth: () => ({ data: { isAdmin: admin } }) as never,
}))
vi.mock('../components/confirm', () => ({ useConfirm: () => async () => true }))

const entries: TrashEntry[] = [
  {
    path: '/m/Show/S1/.weebsync-trash/ep1.mkv',
    name: 'ep1.mkv',
    dir: '/m/Show/S1',
    isDir: false,
    size: 1024,
    files: 2,
    trashedAt: 0,
    reason: 'upgrade',
    replacedBy: 'ep1 [1080p].mkv',
    expiresAt: Date.now() / 1000 + 3 * 86_400,
  },
  {
    path: '/m/Show/.weebsync-trash/old',
    name: 'old',
    dir: '/m/Show',
    isDir: true,
    size: 2048,
    files: 1,
    trashedAt: 0,
    reason: '',
    replacedBy: '',
    expiresAt: Date.now() / 1000 + 86_400,
  },
]

// the shell's footer row: jsdom matches no media query, so the page sees a
// phone and puts its primary action there
function Shell({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  return (
    <ShellFooter.Provider value={node}>
      <div ref={setNode} />
      {children}
    </ShellFooter.Provider>
  )
}

function app() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<TrashButton />} />
            <Route path="/files/trash" element={<TrashPage />} />
          </Routes>
        </Shell>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => vi.restoreAllMocks())

describe('TrashButton', () => {
  it('counts what waits and opens its page', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(entries)
    app()
    const button = await screen.findByRole('link', { name: 'trash.open' })
    await waitFor(() => expect(button.getAttribute('data-count')).toBe('2'))
    fireEvent.click(button)
    expect(await screen.findByText('ep1.mkv')).toBeInTheDocument()
    expect(screen.getByText('/m/Show/S1')).toBeInTheDocument()
    expect(screen.getByText('old')).toBeInTheDocument()
    expect(screen.getByText(/trash\.reasonUpgradeBy/)).toBeInTheDocument()
  })

  it('restores and deletes through the API, as an admin', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(entries)
    const post = vi.spyOn(api, 'post').mockResolvedValue({ status: 'ok' })
    const del = vi.spyOn(api, 'del').mockResolvedValue({ status: 'ok' })
    app()
    fireEvent.click(await screen.findByRole('link', { name: 'trash.open' }))
    fireEvent.click((await screen.findAllByRole('button', { name: 'trash.restore' }))[0])
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/trash/restore', { path: entries[0].path }))
    fireEvent.click(screen.getByRole('button', { name: 'trash.deleteItem:old' }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/trash', { path: entries[1].path }))
    fireEvent.click(screen.getByRole('button', { name: 'trash.empty' }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/trash'))
  })

  it('shows a plain list to everyone else', async () => {
    admin = false
    vi.spyOn(api, 'get').mockResolvedValue(entries)
    app()
    fireEvent.click(await screen.findByRole('link', { name: 'trash.open' }))
    await screen.findByText('ep1.mkv')
    expect(screen.queryByRole('button', { name: 'trash.restore' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'trash.empty' })).toBeNull()
    admin = true
  })
})
