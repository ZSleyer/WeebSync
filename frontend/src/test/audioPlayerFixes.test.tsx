import { useEffect } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { AudioProvider, useAudio, type Queue } from '../components/AudioPlayer'

const toast = vi.fn()
vi.mock('../components/toast', () => ({ useToast: () => toast, useFailToast: () => vi.fn() }))
vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }) as never,
}))

const track = (name: string) => ({ name, path: `/books/${name}`, isDir: false, size: 0, modTime: '' })
const queueOf = (...names: string[]): Queue => ({ server: 0, tracks: names.map(track), at: 0, album: 'Books' })

let api: ReturnType<typeof useAudio>
function Probe({ q }: { q: Queue }) {
  const a = useAudio()
  api = a
  useEffect(() => {
    a.start(q)
    // once, on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

const mount = (q: Queue) =>
  render(
    <MemoryRouter>
      <AudioProvider>
        <Probe q={q} />
      </AudioProvider>
    </MemoryRouter>,
  )
const audioEl = () => document.querySelector('audio') as HTMLAudioElement

let play: ReturnType<typeof vi.fn>
beforeEach(() => {
  toast.mockClear()
  play = vi.fn(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('audiobook position', () => {
  it('keeps the saved position while the new track has no duration yet', () => {
    localStorage.setItem('viewer.pos:0:/books/b.mka', '1800')
    mount(queueOf('b.mka'))
    // loading: duration is NaN, currentTime was reset to 0
    expect(Number.isNaN(audioEl().duration)).toBe(true)
    fireEvent.timeUpdate(audioEl())
    expect(localStorage.getItem('viewer.pos:0:/books/b.mka')).toBe('1800')
  })
})

describe('repeat all with a single track', () => {
  it('plays the track again', () => {
    localStorage.setItem('viewer.repeat', 'all')
    mount(queueOf('only.mp3'))
    const a = audioEl()
    a.currentTime = 42
    fireEvent.ended(a)
    expect(a.currentTime).toBe(0)
    expect(play).toHaveBeenCalled()
  })
})

describe('load errors', () => {
  it('says so and moves on to the next track', () => {
    mount(queueOf('bad.opus', 'good.mp3'))
    fireEvent.error(audioEl())
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: 'audio.error', error: true }))
    expect(api.queue?.at).toBe(1)
  })
  it('says so and stays on the last track', () => {
    mount(queueOf('bad.opus'))
    act(() => fireEvent.error(audioEl()))
    expect(toast).toHaveBeenCalledTimes(1)
    expect(api.queue?.at).toBe(0)
  })
})
