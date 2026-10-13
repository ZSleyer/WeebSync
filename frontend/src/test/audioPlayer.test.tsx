import { useEffect } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { AudioProvider, MiniPlayer, useAudio } from '../components/AudioPlayer'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () =>
    ({
      t: (k: string, o?: Record<string, unknown>) => (o?.mode ? `${k}:${String(o.mode)}` : k),
      i18n: { language: 'de' },
    }) as never,
}))

const track = (name: string) => ({ name, path: `/music/Album/${name}`, isDir: false, size: 0, modTime: '' })

function Start() {
  const a = useAudio()
  useEffect(() => {
    a.start({ server: 0, tracks: [track('01 Opening.mp3'), track('02 Ending.mp3')], at: 0, album: 'Album' })
    // once, on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

function app() {
  return render(
    <MemoryRouter initialEntries={['/files']}>
      <AudioProvider>
        <Start />
        <MiniPlayer variant="pill" />
      </AudioProvider>
    </MemoryRouter>,
  )
}

describe('MiniPlayer', () => {
  it('shows the track and its folder, and marks the root while audio is loaded', () => {
    const { unmount } = app()
    expect(screen.getByText('01 Opening')).toBeInTheDocument()
    expect(screen.getByText('Album')).toBeInTheDocument()
    expect(document.documentElement.classList.contains('has-audio')).toBe(true)
    // no stop button on the card: stopping lives in the playback panel
    expect(screen.queryByRole('button', { name: 'viewer.stop' })).toBeNull()
    unmount()
    expect(document.documentElement.classList.contains('has-audio')).toBe(false)
  })

  it('opens the playback panel with the folder, repeat cycling through its three states', () => {
    app()
    fireEvent.click(screen.getByRole('button', { name: 'audio.open' }))
    expect(screen.getByRole('heading', { name: 'audio.title' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'audio.inFolder' })).toBeInTheDocument()
    const repeat = screen.getByRole('button', { name: 'audio.repeat:audio.repeat_off' })
    fireEvent.click(repeat)
    expect(screen.getByRole('button', { name: 'audio.repeat:audio.repeat_all' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'audio.repeat:audio.repeat_all' }))
    expect(screen.getByRole('button', { name: 'audio.repeat:audio.repeat_one' })).toBeInTheDocument()
    // stop from the panel ends the queue: the card goes
    fireEvent.click(screen.getByRole('button', { name: 'viewer.stop' }))
    expect(screen.queryByRole('region', { name: 'viewer.nowPlaying' })).toBeNull()
    localStorage.removeItem('viewer.repeat')
  })
})
