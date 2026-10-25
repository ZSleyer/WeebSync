import { useEffect } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { AudioProvider, useAudio } from '../components/AudioPlayer'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'de' } }) as never,
}))

const track = (name: string) => ({ name, path: `/music/Album/${name}`, isDir: false, size: 0, modTime: '' })

// a queue started once, and a way to stop it
function Start() {
  const a = useAudio()
  useEffect(() => {
    a.start({ server: 0, tracks: [track('01 Opening.mp3')], at: 0, album: 'Album' })
    // once, on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <button type="button" onClick={a.stop}>
      stop
    </button>
  )
}

const session = { metadata: null as unknown, setActionHandler: vi.fn() }
const video = { title: 'an episode' }

beforeEach(() => {
  session.metadata = null
  Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true })
  vi.stubGlobal('MediaMetadata', function (this: object, m: object) {
    Object.assign(this, m)
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { value: () => {}, configurable: true })
})
afterEach(() => {
  delete (navigator as { mediaSession?: unknown }).mediaSession
  vi.unstubAllGlobals()
})

function app() {
  return render(
    <MemoryRouter>
      <AudioProvider>
        <Start />
      </AudioProvider>
    </MemoryRouter>,
  )
}

// the video player shares the Media Session with the audio player
describe('the audio player and the shared Media Session', () => {
  it('takes the session back when the track plays again after a video had it', () => {
    app()
    expect((session.metadata as { title?: string })?.title).toBe('01 Opening')
    session.metadata = video
    act(() => {
      document.querySelector('audio')!.dispatchEvent(new Event('play'))
    })
    expect((session.metadata as { title?: string })?.title).toBe('01 Opening')
  })

  it("leaves the video's session alone as its queue ends", () => {
    app()
    session.metadata = video
    fireEvent.click(screen.getByRole('button', { name: 'stop' }))
    expect(session.metadata).toBe(video)
  })

  it('clears its own session as its queue ends', () => {
    app()
    fireEvent.click(screen.getByRole('button', { name: 'stop' }))
    expect(session.metadata).toBeNull()
  })
})
