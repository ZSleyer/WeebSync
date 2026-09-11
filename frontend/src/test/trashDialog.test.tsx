import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TrashButton } from '../components/TrashDialog'
import { api, type TrashEntry } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.name ? `${k}:${o.name}` : k) }) as never,
}))
let admin = true
vi.mock(import('../hooks'), async (importOriginal) => ({ ...(await importOriginal()), useAuth: () => ({ data: { isAdmin: admin } }) as never }))
vi.mock('../components/confirm', () => ({ useConfirm: () => async () => true }))

const entries: TrashEntry[] = [
  { path: '/m/Show/S1/.weebsync-trash/ep1.mkv', name: 'ep1.mkv', dir: '/m/Show/S1', isDir: false, size: 1024, files: 2, trashedAt: 0, expiresAt: Date.now() / 1000 + 3 * 86_400 },
  { path: '/m/Show/.weebsync-trash/old', name: 'old', dir: '/m/Show', isDir: true, size: 2048, files: 1, trashedAt: 0, expiresAt: Date.now() / 1000 + 86_400 },
]

function app() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TrashButton />
    </QueryClientProvider>,
  )
}

afterEach(() => vi.restoreAllMocks())

describe('TrashButton', () => {
  it('counts what waits and opens the list', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(entries)
    app()
    expect(await screen.findByText('2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'trash.open' }))
    expect(await screen.findByText('ep1.mkv')).toBeInTheDocument()
    expect(screen.getByText('/m/Show/S1')).toBeInTheDocument()
    expect(screen.getByText('old')).toBeInTheDocument()
  })

  it('restores and deletes through the API, as an admin', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(entries)
    const post = vi.spyOn(api, 'post').mockResolvedValue({ status: 'ok' })
    const del = vi.spyOn(api, 'del').mockResolvedValue({ status: 'ok' })
    app()
    fireEvent.click(await screen.findByRole('button', { name: 'trash.open' }))
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
    fireEvent.click(await screen.findByRole('button', { name: 'trash.open' }))
    await screen.findByText('ep1.mkv')
    expect(screen.queryByRole('button', { name: 'trash.restore' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'trash.empty' })).toBeNull()
    admin = true
  })
})
