import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// hls.js as a counted fake: every instance and every destroy is seen
const hls = vi.hoisted(() => ({ made: 0, destroyed: 0, sources: [] as string[] }))
vi.mock('hls.js', () => {
  class Hls {
    static isSupported = () => true
    static Events = { ERROR: 'hlsError' }
    constructor() {
      hls.made++
    }
    on() {}
    loadSource(url: string) {
      hls.sources.push(url)
    }
    attachMedia() {}
    destroy() {
      hls.destroyed++
    }
  }
  return { default: Hls }
})
vi.mock('jassub', () => ({ default: function () {} }))
vi.mock('../pages/jassubWorker?worker&url', () => ({ default: 'worker.js' }))
vi.mock('../components/toast', () => ({ useToast: () => () => {} }))
vi.mock('../api', async (orig) => {
  const real = await orig<typeof import('../api')>()
  return {
    ...real,
    api: {
      ...real.api,
      get: vi.fn(async (url: string) => {
        if (url.startsWith('/api/play/info')) {
          return {
            duration: 1400,
            container: 'mkv',
            video: { codec: 'h264', width: 1920, height: 1080 },
            audio: [{ index: 1, codec: 'aac', lang: 'jpn', default: true }],
            subs: [],
            chapters: [],
          }
        }
        if (url.startsWith('/api/browse/local')) {
          return ['ep1.mkv', 'ep2.mkv'].map((name) => ({ name, path: `/a/${name}`, isDir: false }))
        }
        return []
      }),
    },
  }
})

import Player from '../pages/Player'
import { AudioProvider } from '../components/AudioPlayer'
import { SeriesModalProvider } from '../components/SeriesModal'
import { VideoMini, VideoProvider } from '../components/VideoPlayer'

let wide = false
// a stand-in for the shell: both mini players where the app has them, the page between
function Shell() {
  return (
    <SeriesModalProvider>
      <AudioProvider>
        <VideoProvider>
          <aside>
            <VideoMini variant="rail" />
          </aside>
          <main>
            <Outlet />
          </main>
          <VideoMini variant="pill" />
        </VideoProvider>
      </AudioProvider>
    </SeriesModalProvider>
  )
}

function mount() {
  const router = createMemoryRouter(
    [
      {
        element: <Shell />,
        children: [
          { path: '/play', element: <Player /> },
          { path: '/watches', element: <h1>Watches</h1> },
          { path: '/settings', element: <h1>Settings</h1> },
        ],
      },
    ],
    { initialEntries: ['/play?server=0&path=%2Fa%2Fep1.mkv'] },
  )
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { ...view, router }
}

const go = (router: ReturnType<typeof mount>['router'], to: string) => act(() => router.navigate(to))
const playing = (v: HTMLMediaElement, on: boolean) =>
  act(() => {
    Object.defineProperty(v, 'paused', { value: !on, configurable: true })
    v.dispatchEvent(new Event(on ? 'play' : 'pause'))
  })
const mini = () => screen.queryByRole('region', { name: 'Video playing' })
// the player's video once its controller has it
const ready = () =>
  waitFor(() => {
    const v = document.querySelector('media-controller video')
    expect(v).toBeTruthy()
    return v as HTMLVideoElement
  })

const pauses: HTMLMediaElement[] = []
beforeEach(() => {
  hls.made = hls.destroyed = 0
  hls.sources.length = 0
  pauses.length = 0
  wide = false
  localStorage.clear()
  document.documentElement.className = ''
  vi.stubGlobal('ResizeObserver', function () {
    return { observe() {}, disconnect() {}, unobserve() {} }
  })
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('64rem') ? wide : false,
    addEventListener() {},
    removeEventListener() {},
  }))
  Object.defineProperty(HTMLMediaElement.prototype, 'load', { value: () => {}, configurable: true })
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { value: () => Promise.resolve(), configurable: true })
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    value(this: HTMLMediaElement) {
      pauses.push(this)
    },
    configurable: true,
  })
  Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true })
  Object.defineProperty(document, 'pictureInPictureElement', { value: null, configurable: true })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the app-wide video player', () => {
  it('keeps one element and one stream across the pages, in the mini player off the player page', async () => {
    const { router } = mount()
    const video = await ready()
    await waitFor(() => expect(hls.made).toBe(1))
    playing(video, true)
    for (const page of ['/watches', '/settings', '/watches']) {
      await go(router, page)
      const region = mini()
      expect(region).toBeTruthy()
      // the very element that played on the page, still in the document
      expect(region!.contains(video)).toBe(true)
      expect(video.isConnected).toBe(true)
      await go(router, '/play?server=0&path=%2Fa%2Fep1.mkv')
      expect(mini()).toBeNull()
      expect(document.querySelector('main media-controller video')).toBe(video)
    }
    // nothing was loaded again, nothing torn down
    expect(hls.made).toBe(1)
    expect(hls.destroyed).toBe(0)
  })

  it('names the mini player and its buttons, and goes back to the player without reloading', async () => {
    const { router } = mount()
    const video = await ready()
    await waitFor(() => expect(hls.made).toBe(1))
    playing(video, true)
    await go(router, '/watches')
    // the player's own controls are out of reach in there (and hidden by its CSS)
    expect(document.querySelector('.t-player-page')!.hasAttribute('inert')).toBe(true)
    expect(mini()!.querySelector('.ws-vmini-pic')).toHaveAttribute('aria-hidden', 'true')
    const region = within(mini()!.querySelector<HTMLElement>('.ws-vmini-row')!)
    expect(region.getByRole('button', { name: 'Pause' })).toBeTruthy()
    expect(region.getByRole('button', { name: 'Picture in picture' })).toBeTruthy()
    expect(region.getByRole('button', { name: 'Close the video' })).toBeTruthy()
    fireEvent.click(region.getByRole('button', { name: /^Back to the player: / }))
    expect(router.state.location.pathname).toBe('/play')
    expect(router.state.location.search).toContain('ep1.mkv')
    expect(mini()).toBeNull()
    expect(hls.made).toBe(1)
  })

  it('stands in the sidebar on a desktop and above the tabs on a phone, never in both', async () => {
    wide = true
    const { router } = mount()
    const video = await ready()
    playing(video, true)
    await go(router, '/watches')
    expect(screen.getAllByRole('region', { name: 'Video playing' })).toHaveLength(1)
    expect(document.querySelector('aside')!.contains(video)).toBe(true)
  })

  it('stops on leaving the page paused, and saves where it was', async () => {
    const { router } = mount()
    const video = await ready()
    await waitFor(() => expect(hls.made).toBe(1))
    video.currentTime = 300
    playing(video, false)
    await go(router, '/watches')
    expect(mini()).toBeNull()
    expect(hls.destroyed).toBe(1)
    expect(localStorage.getItem('weebsync.player.pos')).toContain('/a/ep1.mkv')
  })

  it('closes from the mini player: stopped, saved, the stream let go exactly once', async () => {
    const { router } = mount()
    const video = await ready()
    await waitFor(() => expect(hls.made).toBe(1))
    playing(video, true)
    await go(router, '/watches')
    video.currentTime = 420
    fireEvent.click(within(mini()!).getByRole('button', { name: 'Close the video' }))
    expect(pauses).toContain(video)
    expect(mini()).toBeNull()
    expect(hls.destroyed).toBe(1)
    expect(localStorage.getItem('weebsync.player.pos')).toContain('/a/ep1.mkv')
    await go(router, '/settings')
    expect(hls.destroyed).toBe(1)
  })

  it('switches episodes on the same element, on the page and in the mini player', async () => {
    const { router } = mount()
    const video = await ready()
    await waitFor(() => expect(hls.made).toBe(1))
    await waitFor(async () => {
      await act(async () => {
        fireEvent.keyDown(video, { key: 'N', shiftKey: true })
      })
      expect(router.state.location.search).toContain('ep2.mkv')
    })
    await waitFor(() => expect(hls.made).toBe(2))
    expect(hls.destroyed).toBe(1)
    expect(await ready()).toBe(video)
    expect(hls.sources.at(-1)).toContain('ep2.mkv')

    // in the mini player the next episode starts where it is, the page stays
    await go(router, '/play?server=0&path=%2Fa%2Fep1.mkv')
    await waitFor(() => expect(hls.made).toBe(3))
    playing(video, true)
    await go(router, '/watches')
    await waitFor(async () => {
      await act(async () => {
        video.dispatchEvent(new Event('ended'))
      })
      // the count's own card, out of sight in the mini player; its end calls the same
      fireEvent.click(screen.getByRole('button', { name: 'Now', hidden: true }))
    })
    await waitFor(() => expect(hls.sources.at(-1)).toContain('ep2.mkv'))
    expect(router.state.location.pathname).toBe('/watches')
    expect(mini()!.contains(video)).toBe(true)
  })

  it('plays one thing at a time: a video pauses the track, a track the video', async () => {
    mount()
    const video = await ready()
    const audio = document.querySelector('audio')!
    // a track plays: the video, playing too, stops
    playing(video, true)
    pauses.length = 0
    playing(audio, true)
    expect(pauses).toEqual([video])
    // the video plays again: the track stops
    pauses.length = 0
    playing(video, true)
    expect(pauses).toEqual([audio])
  })

  describe('the lock screen', () => {
    const handlers = new Map<string, unknown>()
    const session = {
      metadata: null as unknown,
      setActionHandler: (a: string, fn: unknown) => void handlers.set(a, fn),
      setPositionState: () => {},
    }
    beforeEach(() => {
      handlers.clear()
      session.metadata = null
      Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true })
      vi.stubGlobal('MediaMetadata', function (this: object, m: object) {
        Object.assign(this, m)
      })
    })
    afterEach(() => {
      delete (navigator as { mediaSession?: unknown }).mediaSession
    })

    it('keeps the video while it plays in the mini player, and lets go on close', async () => {
      const { router } = mount()
      const video = await ready()
      await waitFor(() => expect(handlers.get('play')).toBeTypeOf('function'))
      const ours = session.metadata
      playing(video, true)
      await go(router, '/watches')
      expect(handlers.get('play')).toBeTypeOf('function')
      expect(session.metadata).toBe(ours)
      fireEvent.click(
        within(mini()!.querySelector<HTMLElement>('.ws-vmini-row')!).getByRole('button', { name: 'Close the video' }),
      )
      expect(handlers.get('play')).toBeNull()
      expect(session.metadata).toBeNull()
    })

    it('takes the session back from a track as the video plays again', async () => {
      mount()
      const video = await ready()
      await waitFor(() => expect(handlers.get('play')).toBeTypeOf('function'))
      const ours = session.metadata
      session.metadata = { title: 'a song' }
      handlers.set('play', 'theirs')
      playing(video, true)
      expect(session.metadata).toBe(ours)
      expect(handlers.get('play')).toBeTypeOf('function')
    })
  })
})
