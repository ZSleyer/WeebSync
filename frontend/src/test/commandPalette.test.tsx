import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CalendarDays, LayoutDashboard } from 'lucide-react'
import CommandPalette from '../components/CommandPalette'
import { SeriesModalProvider } from '../components/SeriesModal'
import { api } from '../api'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

const PAGES = [
  { to: '/', key: 'nav.dashboard', icon: LayoutDashboard },
  { to: '/calendar', key: 'nav.calendar', icon: CalendarDays },
]

function FilesProbe() {
  const { search } = useLocation()
  return <p>files {search}</p>
}

function Harness() {
  const [open, setOpen] = useState(false)
  return <CommandPalette pages={PAGES} open={open} onOpenChange={setOpen} />
}

const app = (isAdmin = false) => {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/auth/me') return { email: 'a@b.c', isAdmin }
    if (url === '/api/watches') return []
    if (url === '/api/servers') return [{ id: 3, name: 'seedbox', color: 'violet' }]
    if (url.startsWith('/api/search?q=frieren'))
      return {
        results: [
          { serverId: 3, serverName: 'seedbox', path: '/anime/Frieren/ep1.mkv', name: 'ep1.mkv', isDir: false },
          { serverId: 0, path: '/media/Frieren', name: 'Frieren', isDir: true },
        ],
      }
    return {}
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <SeriesModalProvider>
          <Harness />
          <Routes>
            <Route path="/" element={<p>home</p>} />
            <Route path="/calendar" element={<p>calendar page</p>} />
            <Route path="/settings/*" element={<p>settings page</p>} />
            <Route path="/files" element={<FilesProbe />} />
          </Routes>
        </SeriesModalProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('CommandPalette', () => {
  it('opens on Ctrl+K and goes where Enter points', async () => {
    app()
    expect(screen.queryByRole('combobox')).toBeNull()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const field = await screen.findByRole('combobox')
    fireEvent.change(field, { target: { value: 'calendar' } })
    expect(screen.getByRole('option', { name: /nav\.calendar/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(await screen.findByText('calendar page')).toBeInTheDocument()
    // and remembers it for the empty field next time
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('combobox')
    expect(screen.getByRole('option', { name: /nav\.calendar/ })).toBeInTheDocument()
  })

  it('lists a settings panel only for whoever may open its section', async () => {
    app(false)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'settings.plex' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole('option', { name: /settings\.plex/ })).toBeNull()
  })

  it('lists the panel for an admin', async () => {
    app(true)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'settings.plex' } })
    expect(await screen.findByRole('option', { name: /settings\.plex/ })).toBeInTheDocument()
  })

  it('finds files in the server indexes and the local library, and opens their folder', async () => {
    app()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'frieren' } })
    // a file opens the folder it lies in, on its own server
    fireEvent.click(await screen.findByRole('option', { name: /ep1\.mkv.*seedbox/ }))
    expect(await screen.findByText('files ?server=3&path=anime%2FFrieren')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'frieren' } })
    fireEvent.click(await screen.findByRole('option', { name: /Frieren.*palette\.local/ }))
    expect(await screen.findByText('files ?source=local&path=media%2FFrieren')).toBeInTheDocument()
  })

  it('offers what there is to discover on an empty field', async () => {
    app()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('combobox')
    expect(screen.getByText('palette.discover')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: /suggestions\.tabWatchlist/ }))
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('forgets a recent entry, by its button or by Delete', async () => {
    app()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'calendar' } })
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    await screen.findByText('calendar page')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('combobox')
    fireEvent.click(screen.getByRole('button', { name: 'palette.forget' }))
    expect(screen.queryByText('palette.recent')).toBeNull()
    expect(JSON.parse(localStorage.getItem('weebsync.palette.recent') ?? '[]')).toEqual([])
  })
})
