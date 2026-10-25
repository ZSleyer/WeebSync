import { act, render, waitFor } from '@testing-library/react'
import { useEffect, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('hls.js', () => ({ default: { isSupported: () => false } }))
// each libass instance made, and a way to make the next ones by hand
const libass = vi.hoisted(() => ({
  made: [] as object[],
  make: null as null | (() => object),
}))
vi.mock('jassub', () => ({
  default: function () {
    const r = libass.make?.() ?? {
      ready: Promise.resolve(),
      manualRender: () => {},
      destroy: () => {},
      resize: () => {},
    }
    libass.made.push(r)
    return r
  },
}))
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
            subs: [{ index: 2, codec: 'ass', lang: 'eng', default: true, forced: false, image: false }],
            fonts: [],
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

const UA = {
  chromeLinux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  safariIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 15; Mobile; rv:158.0) Gecko/158.0 Firefox/158.0',
}

const ASS = [
  '[Script Info]',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello',
  '',
].join('\n')

// the subtitle effect has run its course once libass is set up
async function withSubs(ua: string) {
  const view = await mount(ua)
  await act(async () => view.video.dispatchEvent(new Event('playing')))
  await waitFor(() => expect(fetch).toHaveBeenCalled())
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50))
  })
  return view
}

describe('the subtitles as a text track for the browser window', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, ok: true, text: async () => ASS })),
    )
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:cues', configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true })
    const tracks = new WeakMap<object, { mode: string }>()
    Object.defineProperty(HTMLTrackElement.prototype, 'track', {
      get() {
        if (!tracks.has(this)) tracks.set(this, { mode: 'disabled' })
        return tracks.get(this)
      },
      configurable: true,
    })
  })

  // only where the browser's own window draws them (Player.tsx, PIP_CUES):
  // Chrome's window shows the bare picture, so a track there only doubled
  // the subtitles on the page while the video floated
  it.each([
    ['Chrome on the desktop', UA.chromeLinux],
    ['Chrome on Android', UA.chromeAndroid],
    ['Firefox on Android', UA.firefoxAndroid],
  ])('adds none in %s', async (_, ua) => {
    const { video } = await withSubs(ua)
    expect(video.querySelector('track[kind="subtitles"]')).toBeNull()
  })

  it.each([
    ['Safari on an iPhone', UA.safariIos],
    ['Chrome on an iPhone (WebKit)', UA.chromeIos],
    ['Safari on a Mac', UA.safariMac],
    ['Firefox on the desktop', UA.firefoxLinux],
  ])('adds one in %s, hidden on the page', async (_, ua) => {
    const { video } = await withSubs(ua)
    const el = video.querySelector<HTMLTrackElement>('track[kind="subtitles"]')
    expect(el).toBeTruthy()
    expect(el!.track.mode).toBe('hidden')
  })
})

// Document Picture-in-Picture opened by the media session as the tab is
// left: the hidden page runs no rendering steps, so libass's ResizeObserver
// (of the page's window) never gives the canvas in the window a size
describe('libass in the Document Picture-in-Picture window', () => {
  const pipWin = new EventTarget()
  const dpip = {
    window: null as null | { document: Document; close: () => void },
    requestWindow: vi.fn(async () => {
      const doc = document.implementation.createHTMLDocument('')
      Object.defineProperty(doc, 'defaultView', { value: pipWin, configurable: true })
      const win = Object.assign(pipWin, {
        document: doc,
        close: () => {
          dpip.window = null
          pipWin.dispatchEvent(new Event('pagehide'))
        },
      })
      dpip.window = win
      return win
    }),
  }
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, ok: true, text: async () => ASS })),
    )
    Object.defineProperty(window, 'documentPictureInPicture', { value: dpip, configurable: true })
    libass.made.length = 0
  })
  afterEach(() => {
    dpip.window?.close()
    delete (window as { documentPictureInPicture?: unknown }).documentPictureInPicture
    libass.make = null
  })

  it('sizes the canvas once libass is ready, and not before', async () => {
    const { video, getByRole } = await withSubs(UA.chromeLinux)
    let ready = () => {}
    const resize = vi.fn(async () => {})
    libass.make = () => ({
      ready: new Promise<void>((ok) => (ready = ok)),
      manualRender: () => {},
      destroy: () => {},
      resize,
    })
    await act(async () => getByRole('button', { name: 'Picture in picture' }).click())
    expect(dpip.window!.document.contains(video)).toBe(true)
    await waitFor(() => expect(libass.made.length).toBe(2))
    // a resize of the window before libass is up asks nothing of it
    pipWin.dispatchEvent(new Event('resize'))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(resize).not.toHaveBeenCalled()
    await act(async () => {
      ready()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(resize).toHaveBeenCalledTimes(1)
    pipWin.dispatchEvent(new Event('resize'))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(resize).toHaveBeenCalledTimes(2)
  })
})
