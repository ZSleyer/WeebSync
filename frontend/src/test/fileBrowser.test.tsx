import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FileBrowser, openKind } from '../components/FileBrowser'
import { api, type Entry } from '../api'

const entries: Entry[] = [
  { name: 'Season 01', path: '/m/Show/Season 01', isDir: true, size: 0, modTime: '2026-09-01T00:00:00Z' },
  { name: 'ep01.mkv', path: '/m/Show/ep01.mkv', isDir: false, size: 1024, modTime: '2026-09-02T00:00:00Z' },
]

function list(props: Partial<Parameters<typeof FileBrowser>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.spyOn(api, 'get').mockResolvedValue(entries)
  return render(
    <QueryClientProvider client={qc}>
      <FileBrowser queryKey={['local']} fetchPath={(p) => p} path="m/Show" onNavigate={() => {}} sortable {...props} />
    </QueryClientProvider>,
  )
}

afterEach(() => vi.restoreAllMocks())

describe('openKind', () => {
  it('tells playing, listening and reading apart', () => {
    expect(openKind('a.mkv')).toBe('play')
    expect(openKind('a.flac')).toBe('listen')
    expect(openKind('a.cbz')).toBe('read')
    expect(openKind('a.xyz')).toBeNull()
  })
})

describe('FileBrowser rows', () => {
  it('opens a file from its own button, not the row', async () => {
    const onPlay = vi.fn()
    const onSelect = vi.fn()
    list({ onPlay, onSelect })
    fireEvent.click(await screen.findByRole('button', { name: 'player.playItem' }))
    expect(onPlay).toHaveBeenCalledWith(entries[1])
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('starts a selection from a check and toggles rows by tap while selecting', async () => {
    const onToggle = vi.fn()
    const onNavigate = vi.fn()
    const { rerender } = list({ onToggle, checked: new Set() })
    const checks = await screen.findAllByRole('checkbox')
    expect(checks).toHaveLength(2)
    fireEvent.click(checks[1])
    expect(onToggle).toHaveBeenCalledWith(entries[1])

    const qc = new QueryClient()
    qc.setQueryData(['local', 'm/Show'], entries)
    rerender(
      <QueryClientProvider client={qc}>
        <FileBrowser
          queryKey={['local']}
          fetchPath={(p) => p}
          path="m/Show"
          onNavigate={onNavigate}
          sortable
          onToggle={onToggle}
          checked={new Set([entries[1].path])}
        />
      </QueryClientProvider>,
    )
    // a folder row toggles instead of opening while anything is checked
    fireEvent.click(await screen.findByText('Season 01'))
    expect(onToggle).toHaveBeenLastCalledWith(entries[0])
    expect(onNavigate).not.toHaveBeenCalled()
    expect((await screen.findAllByRole('checkbox'))[1].getAttribute('aria-checked')).toBe('true')
  })
})
