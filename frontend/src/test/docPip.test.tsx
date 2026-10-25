import { act, render, waitFor } from '@testing-library/react'
import { useEffect, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('hls.js', () => ({ default: { isSupported: () => false } }))
vi.mock('jassub', () => ({ default: function () {} }))
vi.mock('../pages/jassubWorker?worker&url', () => ({ default: 'worker.js' }))
vi.mock('../components/useImmersive', () => ({ useImmersive: () => {} }))
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
            container: 'mp4',
            video: { codec: 'h264', width: 1920, height: 1080 },
            audio: [{ index: 1, codec: 'aac', lang: 'jpn', default: true }],
            subs: [],
            chapters: [],
          }
        }
        if (url.startsWith('/api/browse/local')) {
          return ['ep1.mp4', 'ep2.mp4'].map((name) => ({ name, path: `/a/${name}`, isDir: false }))
        }
        return []
      }),
    },
  }
})

const realUA = navigator.userAgent

// The Player reads the user agent once, when its module is evaluated: each
// case loads it afresh under the agent it names.
// the player page goes (the user moves on to another page) while the
// provider and its session stay
const pageGate = { leave: () => {} }
function Page({ children }: { children: ReactNode }) {
  const [on, setOn] = useState(true)
  useEffect(() => {
    pageGate.leave = () => setOn(false)
  }, [])
  return on ? children : null
}

async function mount(ua = realUA) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })
  vi.resetModules()
  const [
    { default: Player },
    { SeriesModalProvider },
    { QueryClient, QueryClientProvider },
    { MemoryRouter },
    { AudioProvider },
    { VideoProvider },
  ] = await Promise.all([
    import('../pages/Player'),
    import('../components/SeriesModal'),
    import('@tanstack/react-query'),
    import('react-router'),
    import('../components/AudioPlayer'),
    import('../components/VideoPlayer'),
  ])
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/play?server=0&path=%2Fa%2Fep1.mp4']}>
        <SeriesModalProvider>
          <AudioProvider>
            <VideoProvider>
              <Page>
                <Player />
              </Page>
            </VideoProvider>
          </AudioProvider>
        </SeriesModalProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await waitFor(() => expect(view.container.querySelector<HTMLVideoElement>('media-controller video')).toBeTruthy())
  return { ...view, video: view.container.querySelector<HTMLVideoElement>('media-controller video')! }
}

let pipElement: Element | null = null
const float = (v: HTMLVideoElement) => {
  pipElement = v
  v.dispatchEvent(new Event('enterpictureinpicture'))
}
const request = vi.fn(async function (this: HTMLVideoElement) {
  if (this.disablePictureInPicture) throw new DOMException('disabled', 'InvalidStateError')
  float(this)
  return {} as PictureInPictureWindow
})

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', function () {
    return { observe() {}, disconnect() {}, unobserve() {} }
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  pipElement = null
  request.mockClear()
  Object.defineProperty(HTMLMediaElement.prototype, 'load', { value: () => {}, configurable: true })
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { value: () => Promise.resolve(), configurable: true })
  // jsdom's track lists are no event targets, media-chrome listens on them
  for (const name of ['textTracks', 'audioTracks', 'videoTracks']) {
    const lists = new WeakMap<object, EventTarget>()
    Object.defineProperty(HTMLMediaElement.prototype, name, {
      get() {
        if (!lists.has(this)) lists.set(this, Object.assign(new EventTarget(), { length: 0, *[Symbol.iterator]() {} }))
        return lists.get(this)
      },
      configurable: true,
    })
  }
  // nor has jsdom Element.part, which a media-chrome item marks as checked
  if (!('part' in HTMLElement.prototype)) {
    const parts = new WeakMap<object, DOMTokenList>()
    Object.defineProperty(HTMLElement.prototype, 'part', {
      get() {
        if (!parts.has(this)) parts.set(this, document.createElement('i').classList)
        return parts.get(this)
      },
      configurable: true,
    })
  }
  // jsdom knows no picture in picture: the API as Chrome has it
  Object.defineProperty(HTMLVideoElement.prototype, 'disablePictureInPicture', {
    get() {
      return this.hasAttribute('disablepictureinpicture')
    },
    set(v: boolean) {
      this.toggleAttribute('disablepictureinpicture', !!v)
    },
    configurable: true,
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', { value: request, configurable: true })
  Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true })
  Object.defineProperty(document, 'pictureInPictureElement', { get: () => pipElement, configurable: true })
  Object.defineProperty(document, 'exitPictureInPicture', {
    value: async () => {
      const v = pipElement
      pipElement = null
      v?.dispatchEvent(new Event('leavepictureinpicture'))
    },
    configurable: true,
  })
})

afterEach(() => {
  Object.defineProperty(navigator, 'userAgent', { value: realUA, configurable: true })
})

// Document Picture-in-Picture as Chrome has it: a window with a document of
// its own, which fires pagehide as it closes (by the page or by its user)
const CHROME_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
type FakeWin = EventTarget & { document: Document; close: () => void }
const dpip = {
  window: null as FakeWin | null,
  requestWindow: vi.fn(async (): Promise<FakeWin> => {
    const win: FakeWin = Object.assign(new EventTarget(), {
      document: document.implementation.createHTMLDocument(''),
      close: () => {
        if (dpip.window !== win) return
        dpip.window = null
        win.dispatchEvent(new Event('pagehide'))
      },
    })
    dpip.window = win
    return win
  }),
}
const pipDoc = () => dpip.window!.document

describe('Document Picture-in-Picture', () => {
  beforeEach(() => {
    dpip.window = null
    dpip.requestWindow.mockClear()
    vi.stubGlobal('documentPictureInPicture', dpip)
    document.documentElement.dataset.theme = 'dark'
  })
  afterEach(() => {
    dpip.window?.close()
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.theme
  })

  const open = async (getByRole: (r: string, o: object) => HTMLElement) => {
    await act(async () => getByRole('button', { name: 'Picture in picture' }).click())
    expect(dpip.requestWindow).toHaveBeenCalled()
  }

  it('moves the video into a window of its own instead of the bare video window', async () => {
    const { video, getByRole } = await mount(CHROME_LINUX)
    await open(getByRole)
    expect(request).not.toHaveBeenCalled()
    expect(pipDoc().contains(video)).toBe(true)
    expect(getByRole('button', { name: 'Picture in picture' }).getAttribute('aria-pressed')).toBe('true')
    // what stands in the picture's place on the page
    expect(document.body.textContent).toContain('Playing in the picture-in-picture window')
  })

  it("copies the page's style sheets and the root's look into the window", async () => {
    const style = document.createElement('style')
    style.textContent = '.probe-rule { color: red; }'
    document.head.appendChild(style)
    try {
      const { getByRole } = await mount(CHROME_LINUX)
      await open(getByRole)
      expect(pipDoc().head.textContent).toContain('.probe-rule')
      expect(pipDoc().documentElement.dataset.theme).toBe('dark')
    } finally {
      style.remove()
    }
  })

  it('holds play or pause and the way back to the tab, each with a name', async () => {
    const { video, getByRole } = await mount(CHROME_LINUX)
    await open(getByRole)
    const bar = pipDoc().querySelector('.ws-dpip-bar')!
    const buttons = [...bar.querySelectorAll('button')]
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Play', 'Back to the tab'])
    const pause = vi.spyOn(video, 'pause')
    const play = vi.spyOn(video, 'play')
    await act(async () => buttons[0].click())
    expect(play).toHaveBeenCalled()
    Object.defineProperty(video, 'paused', { value: false, configurable: true })
    await act(async () => buttons[0].click())
    expect(pause).toHaveBeenCalled()
  })

  it('gives the video back to the player as the user closes the window', async () => {
    const { video, container, getByRole } = await mount(CHROME_LINUX)
    await open(getByRole)
    await act(async () => dpip.window!.close())
    expect(container.querySelector('media-controller')!.firstElementChild).toBe(video)
    expect(getByRole('button', { name: 'Picture in picture' }).getAttribute('aria-pressed')).toBe('false')
    expect(document.body.textContent).not.toContain('Playing in the picture-in-picture window')
  })

  it('closes the window from its own button, and from ours a second time', async () => {
    const { video, container, getByRole } = await mount(CHROME_LINUX)
    await open(getByRole)
    const back = pipDoc().querySelector<HTMLButtonElement>('button[aria-label="Back to the tab"]')!
    await act(async () => back.click())
    expect(dpip.window).toBeNull()
    expect(container.querySelector('media-controller video')).toBe(video)
    await open(getByRole)
    await act(async () => getByRole('button', { name: 'Picture in picture' }).click())
    expect(dpip.window).toBeNull()
    expect(container.querySelector('media-controller video')).toBe(video)
  })

  it('brings the focus back to the button that opened the window', async () => {
    const { getByRole } = await mount(CHROME_LINUX)
    const button = getByRole('button', { name: 'Picture in picture' })
    button.focus()
    await open(getByRole)
    ;(document.activeElement as HTMLElement | null)?.blur()
    await act(async () => dpip.window!.close())
    expect(document.activeElement).toBe(button)
  })

  it('keeps the video in the window through an episode change, the next player takes it after', async () => {
    const { video, container, getByRole } = await mount(CHROME_LINUX)
    await open(getByRole)
    const first = container.querySelector('media-controller')!
    // Shift+N, the next episode in the folder (once the folder is read)
    await waitFor(async () => {
      await act(async () =>
        first.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', shiftKey: true, bubbles: true })),
      )
      expect(container.querySelector('media-controller')).not.toBe(first)
    })
    await waitFor(() => expect(container.querySelector('media-controller')).toBeTruthy())
    expect(pipDoc().contains(video)).toBe(true)
    await act(async () => dpip.window!.close())
    expect(container.querySelector('media-controller')!.firstElementChild).toBe(video)
  })

  it('keeps a paused video floating in the window as the page is left', async () => {
    const { video, getByRole } = await mount(CHROME_LINUX)
    await open(getByRole)
    expect(video.paused).toBe(true)
    await act(async () => pageGate.leave())
    expect(dpip.window).not.toBeNull()
    expect(pipDoc().contains(video)).toBe(true)
    expect(document.querySelector('media-controller')).toBeTruthy()
  })

  it('falls back to the video window where the browser has no Document Picture-in-Picture', async () => {
    vi.stubGlobal('documentPictureInPicture', undefined)
    const { video, getByRole } = await mount(CHROME_LINUX)
    await act(async () => getByRole('button', { name: 'Picture in picture' }).click())
    expect(dpip.requestWindow).not.toHaveBeenCalled()
    expect(document.pictureInPictureElement).toBe(video)
  })

  describe('when the tab is left', () => {
    const handlers = new Map<string, ((d: object) => void) | null>()
    beforeEach(() => {
      handlers.clear()
      Object.defineProperty(navigator, 'mediaSession', {
        value: {
          metadata: null,
          setActionHandler: (a: string, fn: ((d: object) => void) | null) => void handlers.set(a, fn),
          setPositionState: () => {},
        },
        configurable: true,
      })
      vi.stubGlobal('MediaMetadata', function (this: object, m: object) {
        Object.assign(this, m)
      })
    })
    afterEach(() => {
      delete (navigator as { mediaSession?: unknown }).mediaSession
    })

    it('opens the window for the browser, once', async () => {
      const { video } = await mount(CHROME_LINUX)
      await waitFor(() => expect(handlers.get('enterpictureinpicture')).toBeTypeOf('function'))
      Object.defineProperty(video, 'paused', { value: false, configurable: true })
      await act(async () => handlers.get('enterpictureinpicture')!({ action: 'enterpictureinpicture' }))
      expect(pipDoc().contains(video)).toBe(true)
      await act(async () => handlers.get('enterpictureinpicture')!({ action: 'enterpictureinpicture' }))
      expect(dpip.requestWindow).toHaveBeenCalledTimes(1)
      expect(request).not.toHaveBeenCalled()
    })
  })
})
